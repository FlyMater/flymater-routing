import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import generate as gen


class RoutingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.work = Path(temp.name)
        self.item = {"tag": "fixture", "url": "https://example.org/test.srs",
                     "policy": "proxy", "exclude": []}
        self.cfg = {"catalogs": [], "sets": [self.item]}

    def build(self, config=None):
        issues = []
        out = gen.assemble(ROOT, self.cfg if config is None else config, self.work, issues)
        return out, issues

    def source(self, rules):
        source = self.work / "fixture.json"
        out = self.work / "fixture.srs"
        source.write_bytes(gen.document({"version": 3, "rules": rules}))
        gen.codec("rule-set", "compile", str(source), "-o", str(out))
        return out.read_bytes()

    def decode(self, data):
        binary = self.work / "verify.srs"
        target = self.work / "verify.json"
        binary.write_bytes(data)
        gen.codec("rule-set", "decompile", str(binary), "-o", str(target))
        return json.loads(target.read_text())["rules"]

    def test_empty_reproduces_existing_subscriptions(self):
        out, issues = self.build({"catalogs": [], "sets": []})
        self.assertFalse(issues)
        for path in ["awg/proxy.txt", "shadowrocket/flymater.conf", "throne/flymater.json"]:
            self.assertEqual(out[path], (ROOT / path).read_bytes())

    def test_failed_rebuild_preserves_published_snapshot(self):
        shutil.copytree(ROOT / "source", self.work / "source")
        config = self.work / "source/routing.json"
        with patch.object(gen, "ROOT", self.work), patch.object(sys, "argv", ["generate.py"]):
            gen.main()
            published = self.work / "docs/published-routes.json"
            prior = published.read_bytes()
            self.assertEqual(json.loads(prior), {"config": json.loads(config.read_text()), "manual": gen.manual(self.work)})
            config.write_bytes(gen.document(self.cfg))
            with patch.object(gen, "fetch", side_effect=OSError("нет источника")), self.assertRaises(ValueError):
                gen.main()
            self.assertEqual(published.read_bytes(), prior)

    def test_add_update_move(self):
        rules = [{"domain_suffix": ["route.example"], "ip_cidr": ["198.51.100.0/24"]}]
        with patch.object(gen, "fetch", return_value=self.source(rules)) as fetch:
            out, issues = self.build()
            self.assertFalse(issues)
            self.assertEqual(json.loads(out["docs/published-routes.json"])["config"], self.cfg)
            fetch.assert_called_once()
            self.assertIn(b"198.51.100.0/24", out["awg/proxy.txt"])
            self.assertIn(b"DOMAIN-SUFFIX,route.example,PROXY", out["shadowrocket/flymater.conf"])
            self.assertIn("route.example", str(self.decode(out["singbox/proxy.srs"])))
            rules[0]["domain_suffix"] = ["updated.example"]
            fetch.return_value = self.source(rules)
            self.item["policy"] = "direct"
            out, issues = self.build()
            self.assertFalse(issues)
            self.assertNotIn(b"198.51.100", out["awg/proxy.txt"])
            self.assertNotIn("updated.example", str(self.decode(out["singbox/proxy.srs"])))
            self.assertIn("updated.example", str(self.decode(out["singbox/direct.srs"])))
            self.assertIn(b"DOMAIN-SUFFIX,updated.example,DIRECT", out["shadowrocket/flymater.conf"])
            self.assertNotIn(b"route.example", out["throne/flymater.json"])
            rule = next(r for r in json.loads(out["throne/flymater.json"])["rules"] if "updated.example" in r.get("domain_suffix", []))
            self.assertEqual(rule["outbound"], "direct")

    def test_exact_only_skips_ndms(self):
        with patch.object(gen, "fetch", return_value=self.source([{"domain": "exact.example"}])):
            coverage, issues = [], []
            out = gen.assemble(ROOT, self.cfg, self.work, issues, coverage)
            ndms = next(row for row in coverage if row["client"] == "ndms")
            self.assertEqual(ndms["status"], "не вошёл в подписку")
            self.assertNotIn(b"exact.example", out["awg/proxy.txt"])
            self.assertFalse(issues)
            self.assertIn(b"DOMAIN,exact.example,PROXY", out["shadowrocket/flymater.conf"])

    def test_partial_coverage_preserves_constraints(self):
        rules = [{"domain_suffix": ["site.example"], "domain_regex": ["^foo[0-9]+$"]},
                 {"domain": ["limited.example"], "port": [443]}]
        coverage, issues = [], []
        with patch.object(gen, "fetch", return_value=self.source(rules)):
            outputs = gen.assemble(ROOT, self.cfg, self.work, issues, coverage)
        self.assertFalse(issues)
        shadow = outputs["shadowrocket/flymater.conf"]
        self.assertIn(b"DOMAIN-SUFFIX,site.example,PROXY", shadow)
        self.assertNotIn(b"limited.example", shadow)
        report = next(r for r in coverage if r["client"] == "shadowrocket")
        self.assertEqual(report["status"], "частично")
        self.assertEqual(set(report["skipped"]), {"domain_regex", "port"})
        throne = json.loads(outputs["throne/flymater.json"])["rules"]
        self.assertTrue(any(r.get("domain_regex") == ["^foo[0-9]+$"] for r in throne))
        self.assertTrue(any("limited.example" in r.get("domain", []) and r.get("port") in (443, [443]) for r in throne))

    def test_unavailable_and_missing(self):
        with patch.object(gen, "fetch", side_effect=OSError("нет источника")), self.assertRaisesRegex(ValueError, "нет источника"):
            self.build()
        self.item["catalog"] = "https://example.org/index.json"
        self.cfg["catalogs"].append({"url": self.item["catalog"]})
        with patch.object(gen, "catalog", return_value={}), self.assertRaisesRegex(ValueError, "исчез"):
            self.build()

    def test_conflict(self):
        self.cfg["sets"].append(dict(self.item, policy="reject"))
        with patch.object(gen, "fetch", return_value=self.source([{"domain_suffix": "same.example"}])) as fetch:
            outputs, issues = self.build()
            self.assertFalse(outputs)
            self.assertIn("same.example", str(issues))
            fetch.assert_called_once()

    def test_nested_network_and_suffix_conflicts(self):
        for entries in [
            {("domain", "www.example.org"): "proxy", ("domain_suffix", "example.org"): "direct"},
            {("ip_cidr", "198.51.100.0/24"): "reject", ("ip_cidr", "198.51.100.64/26"): "proxy"},
        ]:
            with self.subTest(entries=entries), self.assertRaisesRegex(ValueError, "пересекается"):
                gen.overlaps(entries)

    def test_sagernet_v1_json(self):
        self.item["url"] = "https://example.org/old.json"
        with patch.object(gen, "fetch", return_value=gen.document({"version": 1, "rules": [{"domain_suffix": "v1.example"}]})):
            out, issues = self.build()
            self.assertFalse(issues)
            self.assertIn(b"v1.example", out["awg/proxy.txt"])

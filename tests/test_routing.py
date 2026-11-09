import ipaddress
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

    def test_published_telegram_first_match(self):
        lines = (ROOT / "shadowrocket/flymater-rounting.conf").read_text().split("[Rule]")[1].splitlines()

        def first_match(host):
            tag = ""
            for line in lines:
                if line.startswith("#"):
                    tag = line
                    continue
                parts = line.split(",")
                if parts[0] == "FINAL":
                    return "", parts[1]
                if parts[0] in ("IP-CIDR", "IP-CIDR6") and host != "telegram.org":
                    if ipaddress.ip_address(host) in ipaddress.ip_network(parts[1]):
                        return tag, parts[2]
                if parts[0] in ("DOMAIN", "DOMAIN-SUFFIX") and host == parts[1]:
                    return tag, parts[2]
                if parts[0] == "DOMAIN-KEYWORD" and parts[1] in host:
                    return tag, parts[2]

        for host in ("149.154.167.41", "149.154.167.50", "149.154.167.51", "149.154.162.123",
                     "2001:b28:f23d::1", "telegram.org"):
            with self.subTest(host=host):
                self.assertEqual(first_match(host), ("#Telegramm", "PROXY"))
        self.assertEqual(first_match("192.0.2.1"), ("", "DIRECT"))

    def test_named_blocks(self):
        texts = dict(local="", proxy="#Telegramm\n149.154.160.0/20", direct="#Telegramm\nother.example", reject="")
        sets = [dict(self.item, tag="geosite-" + name, url=f"https://example.org/{name}.json",
                     exclude=["shadowrocket"] if name == "excluded" else [])
                for name in ("telegram", "discord", "pinterest", "excluded")]
        def read(url, work):
            return [{"domain_suffix": [Path(url).stem + ".org"]}]
        with patch.object(gen, "read_set", side_effect=read):
            out = gen.assemble(ROOT, {"catalogs": [], "sets": sets}, self.work, [], manual_text=texts)
        shadow = out["shadowrocket/flymater-rounting.conf"].decode()
        self.assertEqual(shadow.count("#Telegramm\n"), 2)
        self.assertIn("DOMAIN-SUFFIX,telegram.org,PROXY", shadow.split("#Telegramm")[1].split("#Discord")[0])
        self.assertIn("#Discord\n", shadow)
        self.assertIn("#Pinterest\n", shadow)
        self.assertNotIn("#Excluded", shadow)
        tags = json.loads(out["docs/published-routes.json"])["tags"]
        self.assertEqual(tags["ndms"]["proxy"], ["Telegramm", "Discord", "Pinterest", "Excluded"])
        texts["proxy"] += "\n192.0.2.0/65"
        with self.assertRaisesRegex(ValueError, "proxy.txt, строка 3"):
            gen.parse_manual(texts)

    def test_failed_rebuild_preserves_published_snapshot(self):
        shutil.copytree(ROOT / "source", self.work / "source")
        config = self.work / "source/routing.json"
        config.write_bytes(gen.document({"catalogs": [], "sets": []}))
        with patch.object(gen, "ROOT", self.work), patch.object(sys, "argv", ["generate.py"]):
            gen.main()
            published = self.work / "docs/published-routes.json"
            prior = published.read_bytes()
            snapshot = json.loads(prior)
            self.assertEqual(snapshot["config"], json.loads(config.read_text()))
            self.assertEqual(snapshot["manualText"], gen.manual_sources(self.work))
            self.assertIn("Telegramm", snapshot["tags"]["singbox"]["proxy"])
            config.write_bytes(gen.document(self.cfg))
            with patch.object(gen, "fetch", side_effect=OSError("нет источника")), self.assertRaises(ValueError):
                gen.main()
            self.assertEqual(published.read_bytes(), prior)

    def test_manual_move_add_and_clear(self):
        texts = dict(local="", proxy="move.example", direct="", reject="")
        cfg = {"sets": [], "catalogs": []}
        def routes():
            return gen.assemble(ROOT, cfg, self.work, [], manual_text=texts)
        self.assertIn(b"move.example", routes()["awg/proxy.txt"])
        texts.update(proxy="", direct="# оставить комментарий\nmove.example\nnew.example\n")
        outputs = routes()
        self.assertFalse(outputs["awg/proxy.txt"].strip())
        for domain in ("move.example", "new.example"):
            self.assertIn(f"DOMAIN-SUFFIX,{domain},DIRECT".encode(), outputs["shadowrocket/flymater-rounting.conf"])
        self.assertEqual(json.loads(outputs["docs/published-routes.json"])["manualText"], texts)

    def test_preview_manual_and_legacy_request(self):
        shutil.copytree(ROOT / "source", self.work / "source")
        preview = self.work / "preview"
        preview.mkdir()
        req = {"id": "test", "config": {"sets": [], "catalogs": []}}
        with patch.object(gen, "ROOT", self.work), patch.object(sys, "argv", ["generate.py", "--preview"]):
            def check():
                (preview / "request.json").write_bytes(gen.document(req))
                gen.main()
                return json.loads((preview / "result.json").read_text())["issues"]
            self.assertEqual(check(), [])
            req["manual"] = dict(local="", proxy="move.example", direct="MOVE.example", reject="")
            self.assertRegex(check()[0], r"direct\.txt.*move\.example")
            req["manual"]["direct"] = "https://bad.example"
            self.assertRegex(check()[0], r"direct\.txt.*https://bad\.example")

    def test_add_update_move(self):
        rules = [{"domain_suffix": ["route.example"], "ip_cidr": ["198.51.100.0/24"]}]
        with patch.object(gen, "fetch", return_value=self.source(rules)) as fetch:
            out, issues = self.build()
            self.assertFalse(issues)
            self.assertEqual(json.loads(out["docs/published-routes.json"])["config"], self.cfg)
            fetch.assert_called_once()
            self.assertIn(b"198.51.100.0/24", out["awg/proxy.txt"])
            self.assertIn(b"DOMAIN-SUFFIX,route.example,PROXY", out["shadowrocket/flymater-rounting.conf"])
            self.assertIn("route.example", str(self.decode(out["singbox/proxy.srs"])))
            rules[0]["domain_suffix"] = ["updated.example"]
            fetch.return_value = self.source(rules)
            self.item["policy"] = "direct"
            out, issues = self.build()
            self.assertFalse(issues)
            self.assertNotIn(b"198.51.100", out["awg/proxy.txt"])
            self.assertNotIn("updated.example", str(self.decode(out["singbox/proxy.srs"])))
            self.assertIn("updated.example", str(self.decode(out["singbox/direct.srs"])))
            self.assertIn(b"DOMAIN-SUFFIX,updated.example,DIRECT", out["shadowrocket/flymater-rounting.conf"])
            self.assertNotIn(b"route.example", out["throne/flymater-rounting.json"])
            rule = next(r for r in json.loads(out["throne/flymater-rounting.json"])["rules"] if "updated.example" in r.get("domain_suffix", []))
            self.assertEqual(rule["outbound"], "direct")

    def test_exact_only_skips_ndms(self):
        with patch.object(gen, "fetch", return_value=self.source([{"domain": "exact.example"}])):
            coverage, issues = [], []
            out = gen.assemble(ROOT, self.cfg, self.work, issues, coverage)
            ndms = next(row for row in coverage if row["client"] == "ndms")
            self.assertEqual(ndms["status"], "не вошёл в подписку")
            self.assertNotIn(b"exact.example", out["awg/proxy.txt"])
            self.assertFalse(issues)
            self.assertIn(b"DOMAIN,exact.example,PROXY", out["shadowrocket/flymater-rounting.conf"])

    def test_partial_coverage_preserves_constraints(self):
        rules = [{"domain_suffix": ["site.example"], "domain_regex": ["^foo[0-9]+$"]},
                 {"domain": ["limited.example"], "port": [443]}]
        coverage, issues = [], []
        with patch.object(gen, "fetch", return_value=self.source(rules)):
            outputs = gen.assemble(ROOT, self.cfg, self.work, issues, coverage)
        self.assertFalse(issues)
        shadow = outputs["shadowrocket/flymater-rounting.conf"]
        self.assertIn(b"DOMAIN-SUFFIX,site.example,PROXY", shadow)
        self.assertNotIn(b"limited.example", shadow)
        report = next(r for r in coverage if r["client"] == "shadowrocket")
        self.assertEqual(report["status"], "частично")
        self.assertEqual(set(report["skipped"]), {"domain_regex", "port"})
        throne = json.loads(outputs["throne/flymater-rounting.json"])["rules"]
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

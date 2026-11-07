"""Обновить примеры доменов панели из снимка ветки SagerNet rule-set."""
import argparse
import json
import tempfile
from pathlib import Path

from generate import codec


def examples(rules, service):
    domains = set()
    for rule in rules:
        for field in ("domain", "domain_suffix"):
            values = rule.get(field, [])
            domains.update([values] if isinstance(values, str) else values)

    def priority(domain):
        return (domain.split(".")[0] != service, service not in domain,
                domain.count("."), len(domain), domain)

    return sorted(domains, key=priority)[:3]


def generate(source, output):
    files = sorted(source.glob("geosite-*.srs"))
    if not files:
        raise ValueError("В каталоге нет наборов Geosite")
    rows = {}
    with tempfile.TemporaryDirectory() as tmp:
        decoded = Path(tmp) / "rules.json"
        for path in files:
            key = path.stem.removeprefix("geosite-")
            codec("rule-set", "decompile", str(path), "-o", str(decoded))
            rules = json.loads(decoded.read_text())["rules"]
            rows[key] = examples(rules, key.partition("@")[0])
    output.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    generate(args.source, args.output)

"""Сборка подписок и предварительная проверка конфигурации."""
import argparse
import ipaddress
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from catalogs import catalog, fetch, https

ROOT = Path(__file__).resolve().parents[1]
POLICIES = ("proxy", "direct", "reject")
CLIENTS = ("singbox", "ndms", "shadowrocket", "throne")
HOST = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", re.I)
PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "fc00::/7", "fe80::/10"]


def codec(*args):
    exe = os.environ.get("SING_BOX", "sing-box")
    result = subprocess.run([exe, *args], capture_output=True, text=True)
    if result.returncode:
        raise ValueError(result.stderr.strip() or f"sing-box завершился с кодом {result.returncode}")


def document(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def manual(root):
    lists = {}
    seen = {}
    for name in ("local", *POLICIES):
        values = {}
        for line in (root / "source" / f"{name}.txt").read_text().splitlines():
            value = line.strip().lower()
            if not value or value.startswith("#"):
                continue
            if not HOST.fullmatch(value) or seen.setdefault(value, name) != name:
                raise ValueError(f"{name}.txt: конфликт или неверный домен {value}")
            values[value] = True
        lists[name] = list(values)
    return lists


def normalize(key, value):
    if key == "ip_cidr":
        return str(ipaddress.ip_network(value, strict=False))
    value = value.lower()
    if not HOST.fullmatch(value):
        raise ValueError(f"{key}: {value}")
    return value


def portable(rules, client):
    result = []
    for rule in rules:
        for key, values in rule.items():
            if key not in ("domain", "domain_suffix", "ip_cidr") or (key == "domain" and client == "ndms"):
                raise ValueError(f"{client}: условие {key}")
            if isinstance(values, str):
                values = [values]
            if not isinstance(values, list) or not values:
                raise ValueError(f"Пустое условие {key}")
            result.extend((key, normalize(key, v)) for v in values)
        if not rule:
            raise ValueError("Пустое правило")
    return result


def read_set(url, work):
    data = fetch(https(url))
    if urlsplit(url).path.lower().endswith(".srs"):
        src = work / "input.srs"
        dest = work / "input.json"
        src.write_bytes(data)
        codec("rule-set", "decompile", str(src), "-o", str(dest))
        data = dest.read_bytes()
    obj = json.loads(data)
    if obj.get("version") not in (1, 2, 3) or not isinstance(obj.get("rules"), list):
        raise ValueError("Неподдерживаемая версия или структура rule-set")
    if obj["version"] < 3:
        path = work / "upgrade.json"
        path.write_bytes(data)
        codec("rule-set", "upgrade", "-w", str(path))
        obj = json.loads(path.read_bytes())
    return obj["rules"]


def overlaps(assignments):
    """Find conflicts between suffixes and hosts, and between nested CIDRs."""
    networks = []
    for (key, value), policy in assignments.items():
        if key == "ip_cidr":
            networks.append((ipaddress.ip_network(value), policy))
        elif key in ("domain", "domain_suffix"):
            labels = value.split(".")
            for offset in range(len(labels)):
                suffix = ".".join(labels[offset:])
                other = assignments.get(("domain_suffix", suffix))
                if other and other != policy:
                    raise ValueError(f"{value} ({policy}) пересекается с {suffix} ({other})")
    networks.sort(key=lambda pair: (pair[0].version, int(pair[0].network_address), pair[0].prefixlen))
    active = []
    for network, policy in networks:
        while active and (active[-1][0].version != network.version or not network.subnet_of(active[-1][0])):
            active.pop()
        if active and active[-1][1] != policy:
            raise ValueError(f"{network} ({policy}) пересекается с {active[-1][0]} ({active[-1][1]})")
        active.append((network, policy))


def assemble(root, cfg, work, issues):
    lists = manual(root)
    paths = [https(item["url"]) for item in cfg["catalogs"]]
    if len(set(paths)) != len(paths):
        raise ValueError("Каталог указан дважды")
    indexes, sources = {}, {}
    groups = {c: {p: [] for p in POLICIES} for c in CLIENTS}
    assignments = {c: {} for c in CLIENTS}
    for name, domains in lists.items():
        policy = "direct" if name == "local" else name
        for client in CLIENTS:
            assignments[client].update({("domain_suffix", d): policy for d in domains})
        if domains:
            groups["singbox"][policy].append({"domain_suffix": domains})
    for item in cfg["sets"]:
        policy, tag, url = item["policy"], item["tag"], https(item["url"])
        if policy not in POLICIES or not tag.strip() or any(c not in CLIENTS for c in item["exclude"]):
            raise ValueError(f"Неверное назначение {tag}")
        origin = item.get("catalog")
        if origin:
            if origin not in paths:
                raise ValueError(f"{tag}: каталог удалён")
            if origin not in indexes:
                indexes[origin] = catalog(origin)
            if indexes[origin].get(tag) != url:
                raise ValueError(f"{tag}: набор исчез или сменил URL")
        if url not in sources:
            try:
                sources[url] = read_set(url, work)
            except (OSError, ValueError) as exc:
                raise ValueError(f"{tag}: {exc}") from exc
        rules = sources[url]
        for client in CLIENTS:
            if client in item["exclude"] or (client == "ndms" and policy != "proxy"):
                continue
            try:
                if client == "singbox":
                    groups[client][policy].extend(rules)
                    entries = []
                    for rule in rules:
                        try:
                            entries.extend(portable([rule], client))
                        except ValueError:
                            # Complex rules are preserved and checked for identical assignments.
                            entries.append(("native", json.dumps(rule, sort_keys=True)))
                else:
                    entries = portable(rules, client)
                for key in entries:
                    previous = assignments[client].setdefault(key, policy)
                    if previous != policy:
                        raise ValueError(f"{key[1]} назначен в {previous} и {policy}")
                    if client != "singbox":
                        groups[client][policy].append(key)
            except ValueError as exc:
                issues.append(f"{tag} · {client}: {exc}")
    for client, entries in assignments.items():
        try:
            overlaps(entries)
        except ValueError as exc:
            issues.append(f"{client}: {exc}")
    if issues:
        return {}
    outputs = {}
    for policy, rules in groups["singbox"].items():
        source, out = work / "output.json", work / "output.srs"
        source.write_bytes(document({"version": 3, "rules": rules}))
        codec("rule-set", "compile", str(source), "-o", str(out))
        outputs[f"singbox/{policy}.srs"] = out.read_bytes()
    ndms = dict.fromkeys(lists["proxy"] + [v for _, v in groups["ndms"]["proxy"]])
    outputs["awg/proxy.txt"] = ("\n".join(ndms) + "\n").encode()
    sh = ["# FlyMater Routing — generated, do not edit", "[General]", "bypass-system = true", "", "[Rule]"]
    throne = []
    for family, networks in [(4, PRIVATE[:5]), (6, PRIVATE[5:])]:
        throne.append({"name": f"LOCAL: private IPv{family}", "type": "custom", "action": "route", "outbound": "direct", "ip_cidr": networks})
        sh.extend(f"IP-CIDR{'6' if family == 6 else ''},{v},DIRECT,no-resolve" for v in networks)
    for name, domains in lists.items():
        policy = "direct" if name == "local" else name
        base = [("domain_suffix", d) for d in domains]
        for client in ("shadowrocket", "throne"):
            extra = [] if name == "local" else groups[client][policy]
            fields = {}
            for key, value in dict.fromkeys(base + extra):
                fields.setdefault(key, []).append(value)
                if client == "shadowrocket":
                    kind = {"domain": "DOMAIN", "domain_suffix": "DOMAIN-SUFFIX", "ip_cidr": "IP-CIDR6" if ":" in value else "IP-CIDR"}[key]
                    sh.append(f"{kind},{value},{policy.upper()}" + (",no-resolve" if key == "ip_cidr" else ""))
            if client == "throne" and fields:
                throne.append({"name": f"FlyMater {name.upper()}", "type": "custom", "action": "route", "outbound": "block" if policy == "reject" else policy, **fields})
    outputs["shadowrocket/flymater.conf"] = ("\n".join(sh + ["FINAL,DIRECT"]) + "\n").encode()
    outputs["throne/flymater.json"] = document({"kind": "throne-route-profile", "v": 1, "name": "FlyMater Routing", "default_outbound": "direct", "rules": throne})
    return outputs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    req = json.loads((ROOT / ("preview/request.json" if args.preview else "source/routing.json")).read_text())
    issues = []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            outputs = assemble(ROOT, req["config"] if args.preview else req, Path(tmp), issues)
        if issues:
            raise ValueError("\n".join(issues))
        if not args.preview:
            for path, data in outputs.items():
                dest = ROOT / path
                dest.parent.mkdir(exist_ok=True)
                dest.write_bytes(data)
    except Exception as exc:
        if not args.preview:
            raise
        if not issues:
            issues.append(str(exc))
    if args.preview:
        (ROOT / "preview/result.json").write_bytes(document({"id": req["id"], "issues": issues}))


if __name__ == "__main__":
    main()

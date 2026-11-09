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


def manual_sources(root):
    return {name: (root / "source" / f"{name}.txt").read_text() for name in ("local", *POLICIES)}


def parse_manual(texts, locations=None):
    lists = {}
    seen = {}
    for name in ("local", *POLICIES):
        blocks = {}
        tag = ""
        if not isinstance(texts, dict) or not isinstance(texts.get(name), str):
            raise ValueError(f"{name}.txt: отсутствует текст списка")
        for number, line in enumerate(texts[name].splitlines(), 1):
            value = line.strip()
            if value.startswith("#"):
                if len(value) > 1 and not value[1].isspace():
                    tag = value[1:]
                continue
            if not value:
                continue
            key = "ip_cidr" if "/" in value else "domain_suffix"
            try:
                entry = (key, normalize(key, value))
            except ValueError as exc:
                raise ValueError(f"{name}.txt, строка {number}: неверное значение {value}") from exc
            if entry in seen:
                if seen[entry] != name:
                    raise ValueError(f"{name}.txt, строка {number}: конфликт {entry[1]} с {seen[entry]}.txt")
                continue
            if locations is not None:
                locations[entry] = f"{name}.txt, строка {number}"
            seen[entry] = name
            blocks.setdefault(tag, []).append(entry)
        lists[name] = blocks
    return lists


def flat_manual(lists):
    return {name: [value for entries in blocks.values() for _, value in entries]
            for name, blocks in lists.items()}


def display_tag(tag):
    name = re.sub(r"^(?:geosite|geoip)-", "", tag)
    if name.lower() == "telegram":
        return "Telegramm"
    return name[:1].upper() + name[1:]


def normalize(key, value):
    if key == "ip_cidr":
        return str(ipaddress.ip_network(value, strict=False))
    value = value.lower()
    if not HOST.fullmatch(value):
        raise ValueError(f"{key}: {value}")
    return value


# Destination matchers in a default rule are alternatives. Other fields can
# constrain the entire rule (port, source, inversion, etc.).
DESTINATIONS = {"domain", "domain_suffix", "domain_keyword", "domain_regex", "ip_cidr"}
THRONE_FILTERS = {"port", "port_range", "source_port", "source_port_range", "source_ip_cidr",
                  "process_name", "process_path", "process_path_regex", "package_name",
                  "network", "wifi_ssid", "wifi_bssid", "invert"}


def project(rule, client, skipped):
    if rule.get("type") == "logical" and rule.get("mode") == "or" and not rule.get("invert"):
        return [entry for child in rule["rules"] for entry in project(child, client, skipped)]
    fields = {k: v for k, v in rule.items() if not (k == "type" and v == "default")}
    constraints = fields.keys() - DESTINATIONS
    if constraints:
        if client == "throne" and constraints <= THRONE_FILTERS:
            # Throne has a single network selector. Preserve multi-network
            # rules as independent alternatives.
            networks = fields.get("network")
            if isinstance(networks, list) and fields.get("invert"):
                skipped.update(("network", "invert"))
                return []
            variants = [dict(fields, network=n) for n in networks] if isinstance(networks, list) else [fields]
            return [("compound", json.dumps(v, sort_keys=True)) for v in variants]
        skipped.update(constraints)
        return []
    result = []
    for key, values in fields.items():
        if isinstance(values, str):
            values = [values]
        if not isinstance(values, list) or not values:
            raise ValueError(f"Пустое условие {key}")
        if ((key == "domain_regex" and client not in ("singbox", "throne"))
                or (client == "ndms" and key in ("domain", "domain_keyword"))):
            skipped.add(key)
            continue
        for value in values:
            if key in ("domain_keyword", "domain_regex"):
                if client == "shadowrocket" and any(c in value for c in ",\r\n"):
                    skipped.add(key)
                    continue
            elif key == "domain_suffix" and value.startswith(".") and client in ("throne", "singbox"):
                pass  # Both use sing-box suffix semantics.
            else:
                try:
                    value = normalize(key, value)
                except ValueError:
                    if key == "ip_cidr":
                        raise
                    skipped.add(f"{key} ({value})")
                    continue
            result.append((key, value))
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


def overlaps(assignments, locations=None):
    """Find conflicts between suffixes and hosts, and between nested CIDRs."""
    def location(*keys):
        for key in keys:
            if locations and key in locations:
                return locations[key] + ": "
        return ""

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
                    prefix = location((key, value), ("domain_suffix", suffix))
                    raise ValueError(f"{prefix}{value} ({policy}) пересекается с {suffix} ({other})")
    networks.sort(key=lambda pair: (pair[0].version, int(pair[0].network_address), pair[0].prefixlen))
    active = []
    for network, policy in networks:
        while active and (active[-1][0].version != network.version or not network.subnet_of(active[-1][0])):
            active.pop()
        if active and active[-1][1] != policy:
            prefix = location(("ip_cidr", str(network)), ("ip_cidr", str(active[-1][0])))
            raise ValueError(f"{prefix}{network} ({policy}) пересекается с {active[-1][0]} ({active[-1][1]})")
        active.append((network, policy))


def assemble(root, cfg, work, issues, coverage=None, manual_text=None):
    texts = manual_sources(root) if manual_text is None else manual_text
    locations = {}
    lists = parse_manual(texts, locations)
    paths = [https(item["url"]) for item in cfg["catalogs"]]
    if len(set(paths)) != len(paths):
        raise ValueError("Каталог указан дважды")
    indexes, sources = {}, {}
    groups = {client: {name: {} for name in lists} for client in CLIENTS}
    assignments = {c: {} for c in CLIENTS}
    native = {policy: [] for policy in POLICIES}
    for name, blocks in lists.items():
        policy = "direct" if name == "local" else name
        for tag, entries in blocks.items():
            fields = {}
            for key, value in entries:
                fields.setdefault(key, []).append(value)
            native[policy].append(fields)
            for client in CLIENTS:
                if client == "ndms" and policy != "proxy":
                    continue
                assignments[client].update(dict.fromkeys(entries, policy))
                groups[client][name][tag] = entries.copy()
    for item in cfg["sets"]:
        policy, tag, url = item["policy"], item["tag"], https(item["url"])
        if policy not in POLICIES or not tag.strip() or tag.splitlines() != [tag] or any(c not in CLIENTS for c in item["exclude"]):
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
                skipped = set()
                entries = [entry for rule in rules for entry in project(rule, client, skipped)]
                if client == "singbox":
                    native[policy].extend(rules)
                    entries.extend(("native", json.dumps(r, sort_keys=True)) for r in rules)
                    skipped.clear()
                if coverage is not None:
                    status = "полностью" if entries else "не вошёл в подписку"
                    if entries and skipped:
                        status = "частично"
                    coverage.append({"tag": tag, "client": client, "status": status, "skipped": sorted(skipped)})
                label = display_tag(tag)
                if client == "singbox" and rules:
                    groups[client][policy].setdefault(label, [])
                for key in entries:
                    known = key in assignments[client]
                    previous = assignments[client].setdefault(key, policy)
                    if previous != policy:
                        where = locations[key] + ": " if key in locations else ""
                        raise ValueError(f"{where}{key[1]} назначен в {previous} и {policy}")
                    if client != "singbox" and not known:
                        groups[client][policy].setdefault(label, []).append(key)
            except ValueError as exc:
                issues.append(f"{tag} · {client}: {exc}")
    for client, entries in assignments.items():
        try:
            overlaps(entries, locations)
        except ValueError as exc:
            issues.append(f"{client}: {exc}")
    if issues:
        return {}
    outputs = {}
    for policy, rules in native.items():
        source, out = work / "output.json", work / "output.srs"
        source.write_bytes(document({"version": 3, "rules": rules}))
        codec("rule-set", "compile", str(source), "-o", str(out))
        outputs[f"singbox/{policy}.srs"] = out.read_bytes()
    ndms = dict.fromkeys(v for entries in groups["ndms"]["proxy"].values() for _, v in entries)
    outputs["awg/proxy.txt"] = ("\n".join(ndms) + "\n").encode()
    sh = ["# FlyMater Routing — generated, do not edit", "[General]", "bypass-system = true", "", "[Rule]"]
    throne = []
    for family, networks in [(4, PRIVATE[:5]), (6, PRIVATE[5:])]:
        throne.append({"name": f"LOCAL: private IPv{family}", "type": "custom", "action": "route", "outbound": "direct", "ip_cidr": networks})
        sh.extend(f"IP-CIDR{'6' if family == 6 else ''},{v},DIRECT,no-resolve" for v in networks)
    for name in lists:
        policy = "direct" if name == "local" else name
        for tag, entries in groups["shadowrocket"][name].items():
            sh.extend(["", "#" + (tag or name.upper())])
            for key, value in entries:
                kind = {"domain": "DOMAIN", "domain_keyword": "DOMAIN-KEYWORD", "domain_suffix": "DOMAIN-SUFFIX",
                        "ip_cidr": "IP-CIDR6" if ":" in value else "IP-CIDR"}[key]
                sh.append(f"{kind},{value},{policy.upper()}" + (",no-resolve" if key == "ip_cidr" else ""))
        for tag, entries in groups["throne"][name].items():
            route = {"name": "#" + (tag or name.upper()), "type": "custom", "action": "route",
                     "outbound": "block" if policy == "reject" else policy}
            fields = {}
            for key, value in entries:
                if key == "compound":
                    throne.append({**route, **json.loads(value)})
                else:
                    fields.setdefault(key, []).append(value)
            if fields:
                throne.append({**route, **fields})
    outputs["shadowrocket/flymater-rounting.conf"] = ("\n".join(sh + ["FINAL,DIRECT"]) + "\n").encode()
    outputs["throne/flymater-rounting.json"] = document({"kind": "throne-route-profile", "v": 1, "name": "FlyMater Routing", "default_outbound": "direct", "rules": throne})
    outputs["docs/published-routes.json"] = document({
        "config": cfg, "manual": flat_manual(lists), "manualText": texts,
        "tags": {client: {name: [tag or name.upper() for tag in blocks] for name, blocks in grouped.items() if blocks}
                 for client, grouped in groups.items()},
    })
    return outputs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    req = json.loads((ROOT / ("preview/request.json" if args.preview else "source/routing.json")).read_text())
    issues = []
    coverage = []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            outputs = assemble(ROOT, req["config"] if args.preview else req, Path(tmp), issues, coverage,
                               req.get("manual") if args.preview else None)
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
        (ROOT / "preview/result.json").write_bytes(document({"id": req["id"], "issues": issues, "coverage": coverage}))


if __name__ == "__main__":
    main()

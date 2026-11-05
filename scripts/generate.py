#!/usr/bin/env python3
"""FlyMater Routing: один набор доменов -> AWG, Shadowrocket, Throne."""
from pathlib import Path
import ipaddress
import json
import re

ROOT = Path(__file__).resolve().parent.parent
HOST = re.compile(r'^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$', re.I)

def load(name):
    out = []
    for i, raw in enumerate((ROOT / 'source' / f'{name}.txt').read_text(encoding='utf-8').splitlines(), 1):
        s = raw.strip().lower()
        if not s or s.startswith('#'):
            continue
        if '#' in s or ' ' in s or '/' in s or '*' in s or not HOST.fullmatch(s):
            raise ValueError(f'{name}.txt:{i}: неверный домен: {raw}')
        if s not in out:
            out.append(s)
    return out

lists = {name: load(name) for name in ('local', 'proxy', 'direct', 'reject')}
for name in lists:
    if name == 'local': continue
    duplicates = set(lists[name]) & set(lists['local'])
    if duplicates:
        raise ValueError(f'Конфликт между {name} и local: {sorted(duplicates)}')
for a, b in [('proxy','direct'),('proxy','reject'),('direct','reject')]:
    overlap = set(lists[a]) & set(lists[b])
    if overlap:
        raise ValueError(f'Домены присутствуют одновременно в {a} и {b}: {sorted(overlap)}')

# AWG Manager NDMS: RAW по одной записи на строку.
# Здесь нужен список только для целевого VPN-маршрута.
(ROOT / 'awg').mkdir(exist_ok=True)
(ROOT / 'awg' / 'proxy.txt').write_text('\n'.join(lists['proxy']) + '\n', encoding='utf-8')

# Shadowrocket: отдельный готовый конфигурационный файл правил.
# PROXY — стандартная политика Shadowrocket, выбираем активный узел в приложении.
sh = ['# FlyMater Routing — generated, do not edit', '[General]', 'bypass-system = true', '', '[Rule]']
sh += ['IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
       'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve', 'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
       'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve', 'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
       'IP-CIDR6,fe80::/10,DIRECT,no-resolve']
for name, policy in [('local','DIRECT'),('proxy','PROXY'),('direct','DIRECT'),('reject','REJECT')]:
    sh += [f'DOMAIN-SUFFIX,{domain},{policy}' for domain in lists[name]]
sh.append('FINAL,DIRECT')
(ROOT / 'shadowrocket').mkdir(exist_ok=True)
(ROOT / 'shadowrocket' / 'flymater.conf').write_text('\n'.join(sh) + '\n', encoding='utf-8')

# Throne 1.3.2: structured remotely updatable routing profile (not a raw route).
# Поля rule соответствуют формату JSON структурированного правила Throne.
rules = [
    {'name':'LOCAL: private IPv4', 'type':'custom','action':'route','outbound':'direct',
     'ip_cidr':['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','127.0.0.0/8','169.254.0.0/16']},
    {'name':'LOCAL: private IPv6', 'type':'custom','action':'route','outbound':'direct',
     'ip_cidr':['fc00::/7','fe80::/10']}
]
for name, outbound in [('local','direct'),('proxy','proxy'),('direct','direct'),('reject','block')]:
    if lists[name]:
        rules.append({'name': f'FlyMater {name.upper()}', 'type':'custom', 'action':'route',
                      'outbound':outbound, 'domain_suffix':lists[name]})
profile = {'kind':'throne-route-profile','v':1,'name':'FlyMater Routing',
           'default_outbound':'direct','rules':rules}
(ROOT / 'throne').mkdir(exist_ok=True)
(ROOT / 'throne' / 'flymater.json').write_text(json.dumps(profile, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print('Generated:', {n:len(v) for n,v in lists.items()})

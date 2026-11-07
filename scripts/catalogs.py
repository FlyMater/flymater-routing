"""Источники наборов. Сетевые запросы выполняются без учётных данных."""
import json
import re
import urllib.request
from pathlib import PurePosixPath
from urllib.parse import quote, unquote, urlsplit


def https(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ValueError(f"Нужна общедоступная HTTPS-ссылка: {url}")
    return url


def fetch(url):
    request = urllib.request.Request(https(url), headers={"User-Agent": "FlyMater-Routing"})
    with urllib.request.urlopen(request, timeout=60) as response:
        https(response.geturl())
        data = response.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("Источник превышает 64 МиБ")
    return data


def catalog(url):
    parts = urlsplit(https(url))
    if parts.hostname == "github.com":
        match = re.fullmatch(r"/([\w.-]+)/([\w.-]+)/tree/([^/]+)(?:/(.*))?", parts.path.rstrip("/"))
        if not match:
            raise ValueError("Укажите ссылку GitHub на папку в ветке")
        owner, repo, ref, folder = match.groups()
        tree = json.loads(fetch(f"https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1"))
        if tree.get("truncated"):
            raise ValueError("GitHub вернул неполный каталог")
        prefix = unquote(folder or "").strip("/")
        rows = []
        for entry in tree["tree"]:
            path = PurePosixPath(entry["path"])
            if entry["type"] == "blob" and (not prefix or path.is_relative_to(prefix)) and path.suffix in (".srs", ".json"):
                rows.append({"tag": str(path.relative_to(prefix).with_suffix("")), "url":
                             f"https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{quote(str(path), safe="/!~*'()")}"})
    else:
        rows = json.loads(fetch(url))["sets"]
    result = {}
    for row in rows:
        tag = row["tag"]
        if not isinstance(tag, str) or not tag.strip() or tag in result:
            raise ValueError(f"Некорректный или повторный тег {tag}")
        result[tag] = https(row["url"])
    return result

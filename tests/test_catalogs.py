import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import catalogs


class CatalogFetchTests(unittest.TestCase):
    url = "https://example.org/sets"

    def fetch_request(self, url):
        response = MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = url
        response.read.return_value = b"catalog"
        with patch.object(catalogs.urllib.request, "urlopen", return_value=response) as request:
            self.assertEqual(catalogs.fetch(url), b"catalog")
        return request.call_args.args[0]

    def test_github_api_authorization(self):
        with patch.dict(catalogs.os.environ, {"GITHUB_TOKEN": "test-token"}):
            for url in ("https://api.github.com/repos/test/sets", "https://api.github.com:443/repos/test/sets"):
                with self.subTest(url=url):
                    request = self.fetch_request(url)
                    self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

    def test_github_api_without_token(self):
        for env in ({}, {"GITHUB_TOKEN": ""}):
            with self.subTest(env=env), patch.dict(catalogs.os.environ, env, clear=True):
                request = self.fetch_request("https://api.github.com/repos/test/sets")
                self.assertFalse(request.has_header("Authorization"))

    def test_other_sources_do_not_receive_token(self):
        with patch.dict(catalogs.os.environ, {"GITHUB_TOKEN": "test-token"}):
            for url in (self.url, "https://raw.githubusercontent.com/test/sets/main/data.json",
                        "https://api.github.com.example.org/sets", "https://api.github.com:8443/sets"):
                with self.subTest(url=url):
                    self.assertFalse(self.fetch_request(url).has_header("Authorization"))

    def test_redirect_does_not_receive_token(self):
        with patch.dict(catalogs.os.environ, {"GITHUB_TOKEN": "test-token"}):
            request = self.fetch_request("https://api.github.com/repos/test/sets")
        handler = catalogs.urllib.request.HTTPRedirectHandler()
        for url in (self.url, "https://api.github.com/repos/renamed/sets"):
            with self.subTest(url=url):
                redirected = handler.redirect_request(request, None, 302, "Found", {}, url)
                self.assertFalse(redirected.has_header("Authorization"))
                self.assertEqual(redirected.get_header("User-agent"), "FlyMater-Routing")

    def error(self, status):
        return HTTPError(self.url, status, "failure", {}, None)

    def test_recovers_after_503(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = self.url
        response.read.return_value = b"catalog"
        with patch.object(catalogs.urllib.request, "urlopen", side_effect=[self.error(503), response]), \
             patch.object(catalogs.time, "sleep") as sleep:
            self.assertEqual(catalogs.fetch(self.url), b"catalog")
            sleep.assert_called_once_with(1)

    def test_retry_limit_and_permanent_failure(self):
        for status, attempts in [(503, 4), (403, 1), (404, 1)]:
            with self.subTest(status=status), \
                 patch.object(catalogs.urllib.request, "urlopen", side_effect=self.error(status)) as request, \
                 patch.object(catalogs.time, "sleep") as sleep, self.assertRaises(HTTPError):
                try:
                    catalogs.fetch(self.url)
                finally:
                    self.assertEqual(request.call_count, attempts)
                    self.assertEqual(sleep.call_count, attempts - 1)

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import catalogs


class CatalogFetchTests(unittest.TestCase):
    url = "https://example.org/sets"

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
        for status, attempts in [(503, 4), (404, 1)]:
            with self.subTest(status=status), \
                 patch.object(catalogs.urllib.request, "urlopen", side_effect=self.error(status)) as request, \
                 patch.object(catalogs.time, "sleep") as sleep, self.assertRaises(HTTPError):
                try:
                    catalogs.fetch(self.url)
                finally:
                    self.assertEqual(request.call_count, attempts)
                    self.assertEqual(sleep.call_count, attempts - 1)

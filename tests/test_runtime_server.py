import http.client
import http.server
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from runtime import server


class RuntimeServerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.page = root / 'runtime' / 'index.html'
        self.page.parent.mkdir()
        self.page.write_bytes(b'old runtime')
        root_patch = patch.object(server, 'ROOT', root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        log_patch = patch.object(server.Handler, 'log_message')
        log_patch.start()
        self.addCleanup(log_patch.stop)
        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.httpd.shutdown)

    def request(self, method, path, headers=None):
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=5)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_success_head_and_error_responses_disallow_storage(self):
        for method, path, expected in [('GET', '/', 200),
                                       ('HEAD', '/runtime/index.html', 200),
                                       ('GET', '/missing', 404)]:
            with self.subTest(method=method, path=path):
                status, headers, _ = self.request(method, path)
                self.assertEqual(status, expected)
                self.assertEqual(headers.get('Cache-Control'), 'no-store')

    def test_reload_delivers_synced_bytes_despite_matching_modified_time(self):
        status, headers, body = self.request('GET', '/')
        self.assertEqual((status, body), (200, b'old runtime'))
        original = self.page.stat()
        self.page.write_bytes(b'new runtime')
        os.utime(self.page, ns=(original.st_atime_ns, original.st_mtime_ns))

        status, headers, body = self.request('GET', '/', {
            'If-Modified-Since': headers['Last-Modified'],
        })
        self.assertEqual(status, 200)
        self.assertEqual(body, b'new runtime')
        self.assertEqual(headers.get('Cache-Control'), 'no-store')


if __name__ == '__main__':
    unittest.main()

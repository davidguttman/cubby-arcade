import http.client
import hashlib
import json
import zipfile
import http.server
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from runtime import server, packages


class RuntimeServerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.root = root
        self.games = root / 'games'
        games_patch = patch.object(server, 'GAMES', self.games)
        games_patch.start()
        self.addCleanup(games_patch.stop)
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

    def test_shared_core_is_served_without_exposing_other_runtime_files(self):
        core = self.root / 'runtime/core'
        core.mkdir()
        (core / 'input.js').write_bytes(b'shared input')
        self.assertEqual(self.request('GET', '/runtime/core/input.js')[2], b'shared input')
        for path in ['/runtime/server.py', '/runtime/core/unknown.js',
                     '/runtime/core/%2e%2e/server.py']:
            self.assertEqual(self.request('GET', path)[0], 404)

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

    def test_media_ranges_support_seek_suffix_and_head(self):
        for value, body in [('bytes=0-2', b'old'), ('bytes=4-', b'runtime'), ('bytes=-3', b'ime')]:
            status, headers, actual = self.request('GET', '/', {'Range': value})
            self.assertEqual(status, 206)
            self.assertEqual(actual, body)
            self.assertEqual(int(headers['Content-Length']), len(body))
            self.assertEqual(headers['Accept-Ranges'], 'bytes')
        status, headers, body = self.request('HEAD', '/', {'Range': 'bytes=0-2'})
        self.assertEqual((status, headers['Content-Range'], body), (206, 'bytes 0-2/11', b''))
        for value in ['bytes=99-', 'bytes=3-1', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=' + '9' * 100 + '-', 'nonsense']:
            status, headers, _ = self.request('GET', '/', {'Range': value})
            self.assertEqual(status, 416)
            self.assertEqual(headers['Content-Range'], 'bytes */11')
        self.assertEqual(self.request('GET', '/missing', {'Range': 'bytes=0-1'})[0], 404)

    def test_library_and_only_manifest_assets_are_served_offline(self):
        payload = b'game'
        package = self.root / 'game.zip'
        manifest = dict(schema_version=1, id='test-game', version='1', runtime='web',
                        entrypoint='index.html', artwork='art.svg',
                        files={p: hashlib.sha256(payload).hexdigest() for p in ['index.html','art.svg']})
        with zipfile.ZipFile(package, 'w') as z:
            z.writestr('manifest.json', json.dumps(manifest))
            for p in manifest['files']:
                z.writestr(p, payload)
        packages.install(package, self.games)
        status, _, body = self.request('GET', '/library')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)[0]['entrypoint'], '/games/test-game/index.html')
        self.assertEqual(self.request('GET', '/games/test-game/index.html')[2], payload)
        for path in ['/games/test-game/manifest.json', '/games/test-game/%2e%2e/manifest.json', '/guest/bootstrap.sh']:
            self.assertEqual(self.request('GET', path)[0], 404)


if __name__ == '__main__':
    unittest.main()

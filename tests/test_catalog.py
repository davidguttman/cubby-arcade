import hashlib
import http.server
import json
from pathlib import Path
import tempfile
import threading
import unittest
import zipfile
from runtime import catalog, packages


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.games = self.root / 'games'

    def archive(self, version='1', game_id='test-game', game=b'game'):
        content = {'index.html': game, 'art.svg': b'art'}
        manifest = dict(schema_version=1, id=game_id, version=version, runtime='web',
                        entrypoint='index.html', artwork='art.svg',
                        files={k: hashlib.sha256(v).hexdigest() for k, v in content.items()})
        archive = self.root / (version + '.game.zip')
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('manifest.json', json.dumps(manifest))
            for name, body in content.items():
                output.writestr(name, body)
        return archive

    def entry(self, version='1'):
        archive = self.archive(version)
        return dict(id='test-game', version=version, title='Test', url=archive.as_uri(),
                    size=archive.stat().st_size, sha256=hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_catalog_requires_explicit_developer_transport_and_valid_metadata(self):
        entry = self.entry()
        with self.assertRaises(ValueError):
            catalog.validate({'schema_version': 1, 'games': [entry]})
        self.assertEqual(catalog.validate({'schema_version': 1, 'games': [entry]}, True)[0]['id'], 'test-game')
        for bad in [dict(entry, id='../escape'), dict(entry, size=0), dict(entry, size=packages.MAX_BYTES + 1),
                    dict(entry, sha256='x'), dict(entry, url='http://example.com/game.zip'),
                    dict(entry, url='https://user:secret@example.com/game.zip')]:
            with self.assertRaises(ValueError):
                catalog.validate({'schema_version': 1, 'games': [bad]}, True)
        with self.assertRaises(ValueError):
            catalog.validate({'schema_version': 1, 'games': [entry, entry]}, True)

    def test_verified_install_update_remove_preserves_saves(self):
        save = self.root / 'saves/test-game/run.json'
        save.parent.mkdir(parents=True)
        save.write_text('{"level":3}')
        catalog.install_entry(self.entry(), self.games, developer=True)
        original = (self.games / 'test-game/current').resolve()
        catalog.install_entry(self.entry('2'), self.games, developer=True, update=True)
        self.assertEqual(packages.library(self.games)[0]['version'], '2')
        self.assertTrue(original.exists())
        catalog.remove('test-game', self.games)
        self.assertEqual(packages.library(self.games), [])
        self.assertTrue(self.games.exists())
        self.assertEqual(save.read_text(), '{"level":3}')
        with self.assertRaises(ValueError):
            catalog.remove('../saves', self.games)

    def test_failed_download_or_wrong_identity_never_changes_active(self):
        catalog.install_entry(self.entry(), self.games, developer=True)
        before = (self.games / 'test-game/current').resolve()
        for entry in [dict(self.entry('2'), sha256='0' * 64), dict(self.entry('2'), size=1),
                      dict(self.entry('2'), id='other-game')]:
            with self.assertRaises(ValueError):
                catalog.install_entry(entry, self.games, developer=True)
            self.assertEqual((self.games / 'test-game/current').resolve(), before)
        self.assertFalse((self.games / 'other-game').exists())
        with self.assertRaises(ValueError):
            catalog.install_entry(self.entry('2'), self.root / 'empty', developer=True, update=True)

    def test_create_and_load_local_catalog(self):
        output = self.root / 'catalog/catalog.json'
        catalog.create([self.archive()], output)
        entries = catalog.load(output.as_uri(), developer=True)
        self.assertEqual(entries[0]['id'], 'test-game')
        catalog.install_entry(entries[0], self.games, developer=True)
        self.assertEqual(packages.library(self.games)[0]['version'], '1')

    def test_failed_creation_preserves_published_catalog_and_immutable_archives(self):
        output = self.root / 'catalog/catalog.json'
        catalog.create([self.archive()], output)
        published = output.parent / 'test-game-1.game.zip'
        original_catalog, original_archive = output.read_bytes(), published.read_bytes()
        changed = self.archive(game=b'changed game')
        for archives in ([changed, self.archive('2')], [changed]):
            with self.assertRaises(ValueError):
                catalog.create(archives, output)
            self.assertEqual(output.read_bytes(), original_catalog)
            self.assertEqual(published.read_bytes(), original_archive)
            self.assertFalse((output.parent / 'test-game-2.game.zip').exists())
        # Re-publication of the same bytes remains supported.
        catalog.create([published], output)
        self.assertEqual(published.read_bytes(), original_archive)

    def test_http_stream_bounds_and_redirect_scheme_are_enforced(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', 'file:///etc/passwd')
                    self.end_headers()
                elif self.path == '/loop':
                    self.send_response(302)
                    self.send_header('Location', '/loop')
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'x' * 100)

            def log_message(self, *args):
                pass

        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:' + str(server.server_port)
            try:
                for route in ('/large', '/redirect', '/loop'):
                    with self.assertRaises((ValueError, OSError)):
                        catalog.download(base + route, self.root / 'download', 10, developer=True)
            finally:
                server.shutdown()
                thread.join()

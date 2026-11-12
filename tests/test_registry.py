"""The registry is discovery; stable manifests resolve immutable releases."""
import hashlib
import http.server
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.parse
import zipfile
from runtime import catalog, packages, publishing
import web


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.site = self.root / 'site'
        self.site.mkdir()
        (self.site / '.handheld-web-export').write_text('generated\n')
        self.games = self.root / 'installed'

    def archive(self, version='1', game_id='demo', body=b'<canvas/>'):
        files = {'index.html': body, 'art.svg': b'<svg/>', 'trailer.webm': b'trailer'}
        manifest = dict(schema_version=1, id=game_id, version=version, runtime='web',
                        entrypoint='index.html', artwork='art.svg', attract='trailer.webm',
                        screenshots=['art.svg'], files={name: hashlib.sha256(data).hexdigest() for name, data in files.items()})
        archive = self.root / f'{game_id}-{version}.zip'
        with zipfile.ZipFile(archive, 'w') as target:
            target.writestr('manifest.json', json.dumps(manifest))
            for name, data in files.items():
                target.writestr(name, data)
        return archive

    def publish(self, archive):
        return publishing.publish(archive, self.site, self.site.as_uri(), developer=True)

    def test_registry_is_discoverable_without_install_and_resolves_manifest_on_install(self):
        entry = self.publish(self.archive())
        self.assertEqual(packages.library(self.games), [])
        registry = catalog.load((self.site / 'catalog').as_uri(), developer=True)
        self.assertEqual(registry, [entry])
        for name in ('manifest_url', 'artwork', 'attract'):
            self.assertTrue(Path(urllib.parse.urlsplit(entry[name]).path).is_file())
        self.assertEqual(len(entry['screenshots']), 1)
        catalog.install_entry(entry, self.games, developer=True)
        self.assertEqual(packages.library(self.games)[0]['version'], '1')

    def test_update_keeps_registry_and_manifest_url_and_prior_releases(self):
        entry = self.publish(self.archive())
        before = (self.site / 'catalog').read_bytes()
        catalog.install_entry(entry, self.games, developer=True)
        old = (self.games / 'demo/current').resolve()
        newer = self.publish(self.archive('2'))
        self.assertEqual(entry, newer)
        self.assertEqual((self.site / 'catalog').read_bytes(), before)
        catalog.install_entry(entry, self.games, developer=True, update=True)
        self.assertEqual(packages.library(self.games)[0]['version'], '2')
        self.assertTrue(old.is_dir())
        self.assertTrue((self.site / 'store/demo/1/demo-1.game.zip').is_file())

    def test_redirected_release_resolves_downloads_from_final_manifest_url(self):
        archive = self.archive().read_bytes()
        files = {'index.html': b'<canvas/>', 'art.svg': b'<svg/>'}
        documents = {
            1: dict(schema_version=1, id='demo', version='1', runtime='web', entrypoint='index.html',
                    package=dict(url='files/demo.zip', size=len(archive), sha256=hashlib.sha256(archive).hexdigest())),
            2: dict(schema_version=2, id='demo', version='1', runtime='web', entrypoint='index.html', artwork='art.svg',
                    files={name: dict(url='files/' + name, size=len(body), sha256=hashlib.sha256(body).hexdigest())
                           for name, body in files.items()}),
        }
        bodies = {'/releases/1/files/demo.zip': archive,
                  **{'/releases/2/files/' + name: body for name, body in files.items()}}
        for schema, document in documents.items():
            bodies[f'/releases/{schema}/manifest.json'] = json.dumps(document).encode()
        redirects = {f'/stable/{schema}.json': f'/releases/{schema}/manifest.json' for schema in documents}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path in redirects:
                    self.send_response(302)
                    self.send_header('Location', redirects[self.path])
                    self.end_headers()
                elif self.path in bodies:
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(bodies[self.path])))
                    self.end_headers()
                    self.wfile.write(bodies[self.path])
                else:
                    self.send_error(404)

            def log_message(self, *args):
                pass

        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:' + str(server.server_port)
            try:
                for schema in documents:
                    with self.subTest(schema=schema):
                        entry = dict(id='demo', title='Demo', manifest_url=f'{base}/stable/{schema}.json',
                                     artwork=base + '/art.svg')
                        resolved = catalog.resolve_entry(entry, developer=True)
                        url = resolved['url'] if schema == 1 else resolved['files']['index.html']['url']
                        payload = 'demo.zip' if schema == 1 else 'index.html'
                        self.assertEqual(url, f'{base}/releases/{schema}/files/{payload}')
                        games = self.games / str(schema)
                        catalog.install_entry(entry, games, developer=True)
                        self.assertEqual((games / 'demo/current/index.html').read_bytes(), files['index.html'])
            finally:
                server.shutdown()
                thread.join()

    def test_invalid_release_or_payload_preserves_installed_release(self):
        entry = self.publish(self.archive())
        catalog.install_entry(entry, self.games, developer=True)
        before = (self.games / 'demo/current').resolve()
        self.publish(self.archive('2'))
        manifest_file = self.site / 'store/demo/manifest.json'
        good = json.loads(manifest_file.read_text())
        for bad in [dict(good, id='other'), dict(good, runtime='native'), dict(good, entrypoint='../escape'),
                    dict(good, package=dict(good['package'], sha256='0' * 64)),
                    dict(good, package=dict(good['package'], size=1)),
                    dict(good, entrypoint='missing.html')]:
            manifest_file.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                catalog.install_entry(entry, self.games, developer=True, update=True)
            self.assertEqual((self.games / 'demo/current').resolve(), before)
        manifest_file.write_text('x' * (catalog.MAX_RELEASE + 1))
        with self.assertRaises(ValueError):
            catalog.install_entry(entry, self.games, developer=True)

    def test_bad_registry_is_rejected_and_manifest_is_not_fetched_to_browse(self):
        entry = self.publish(self.archive())
        with patch.object(catalog, 'download', side_effect=AssertionError('manifest fetched')):
            self.assertEqual(catalog.validate_registry([entry], developer=True), [entry])
            # A game's grown-ups page, shown in Cubby's at /parents/<id>/.
            self.assertEqual(catalog.validate_registry([dict(entry, parents='https://example.com/parent/')], developer=True)[0]['parents'], 'https://example.com/parent/')
        for bad in [dict(entry, manifest_url='http://example.com/manifest.json'),
                    dict(entry, artwork='javascript:alert(1)'), dict(entry, id='../escape'),
                    dict(entry, screenshots=['https://u:p@host/image.png']),
                    dict(entry, parents='javascript:alert(1)')]:
            with self.assertRaises(ValueError):
                catalog.validate_registry([bad], developer=True)
        with self.assertRaises(ValueError):
            catalog.validate_registry([entry, entry], developer=True)
        with self.assertRaises(ValueError):
            catalog.validate_registry([entry])

    def test_publication_is_immutable_and_preserves_other_games_and_shell_hash(self):
        first = self.publish(self.archive())
        self.publish(self.archive(game_id='other'))
        cloud = {'schema_version': 1, 'bridge_version': 1, 'files': {'/catalog': {}}}
        (self.site / 'hub-manifest.json').write_text(json.dumps(cloud))
        self.publish(self.archive('2'))
        inventory = json.loads((self.site / 'hub-manifest.json').read_text())['files']['/catalog']
        content = (self.site / 'catalog').read_bytes()
        self.assertEqual(inventory, {'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
        snapshot = {str(p.relative_to(self.site)): p.read_bytes() for p in self.site.rglob('*') if p.is_file()}
        with self.assertRaises(ValueError):
            self.publish(self.archive(body=b'different'))
        self.assertEqual(snapshot, {str(p.relative_to(self.site)): p.read_bytes() for p in self.site.rglob('*') if p.is_file()})
        self.assertEqual(len(catalog.load((self.site / 'catalog').as_uri(), developer=True)), 2)
        self.assertEqual(first['manifest_url'], (self.site / 'store/demo/manifest.json').as_uri())

    def test_publication_rejects_reserved_version_and_symlink_without_collateral(self):
        with self.assertRaises(ValueError):
            self.publish(self.archive('manifest.json'))
        self.assertFalse((self.site / 'store').exists())
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        (self.site / 'store').symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.publish(self.archive())
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertFalse((self.site / 'catalog').exists())

    def test_web_export_hosts_every_advertised_byte(self):
        site = self.root / 'web'
        origin = 'https://games.example'
        archive = self.archive()
        web.build(site, [archive], base_url=origin)
        entry = json.loads((site / 'catalog').read_text())[0]
        def local(url):
            self.assertEqual(urllib.parse.urlsplit(url).netloc, 'games.example')
            return site / urllib.parse.urlsplit(url).path.lstrip('/')
        manifest = json.loads(local(entry['manifest_url']).read_text())
        payload = local(manifest['package']['url']).read_bytes()
        self.assertEqual(payload, archive.read_bytes())
        self.assertEqual(hashlib.sha256(payload).hexdigest(), manifest['package']['sha256'])
        self.assertEqual(len(payload), manifest['package']['size'])
        for url in [entry['artwork'], entry['attract'], *entry['screenshots']]:
            self.assertTrue(local(url).is_file())
        self.assertEqual(manifest['entrypoint'], 'index.html')


if __name__ == '__main__':
    unittest.main()

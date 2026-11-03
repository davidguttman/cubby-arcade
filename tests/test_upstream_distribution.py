import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

import vm
import web
from hosting import serve
from runtime import catalog


def package(path, game='line-cutter', version='0.3.0'):
    files = {'play.html': b'<canvas></canvas>', 'cover.png': b'cover'}
    manifest = dict(schema_version=1, id=game, version=version, runtime='web',
                    entrypoint='play.html', artwork='cover.png',
                    files={k: hashlib.sha256(v).hexdigest() for k, v in files.items()})
    with zipfile.ZipFile(path, 'w') as archive:
        for name, data in files.items():
            archive.writestr(name, data)
        archive.writestr('manifest.json', json.dumps(manifest))
    return path


class UpstreamDistribution(unittest.TestCase):
    def test_pinned_complete_package_is_offline_exact_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = package(root / 'source.zip')
            data = archive.read_bytes()
            asset = dict(path='releases/0.3.0/line-cutter-0.3.0.game.zip',
                         url='https://game.example/release.game.zip', size=len(data),
                         sha256=hashlib.sha256(data).hexdigest(), version='0.3.0')
            lock = root / 'lock.json'
            lock.write_text(json.dumps(dict(schema_version=1, game='line-cutter',
                repository='owner/game', commit='a' * 40, package=asset,
                manifest_url='https://game.example/store/line-cutter/manifest.json')))
            with patch.object(vm, 'GAME_LOCK', lock), patch.object(vm, 'GAME_CACHE', root / 'cache'), patch.object(vm, 'STATE', root / 'state'):
                with self.assertRaisesRegex(SystemExit, 'fetch-games'):
                    vm.build_example()
                def download(url, destination, *args, **kwargs):
                    self.assertEqual(url, asset['url'])
                    self.assertEqual(kwargs['timeout'], 90)
                    Path(destination).write_bytes(data)
                with patch.object(vm.catalog, 'download', side_effect=download) as network:
                    vm.fetch_games()
                    self.assertEqual(network.call_count, 1)
                with patch.object(vm.catalog, 'download', side_effect=AssertionError('unexpected network')):
                    vm.fetch_games()
                    self.assertEqual(vm.build_example().read_bytes(), data)
                cached = vm.GAME_CACHE / asset['path']
                cached.write_bytes(b'tampered')
                with self.assertRaisesRegex(SystemExit, 'checksum'):
                    vm.build_example()
                cached.write_bytes(data)
                asset['version'] = '9.0.0'
                lock.write_text(json.dumps(dict(schema_version=1, game='line-cutter',
                    repository='owner/game', commit='a' * 40, package=asset,
                    manifest_url='https://game.example/store/line-cutter/manifest.json')))
                with self.assertRaisesRegex(SystemExit, 'identity'):
                    vm.build_example()

    def test_external_manifest_override_is_in_coherent_export(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = package(root / 'game.zip')
            output = web.build(root / 'site', [archive],
                manifest_urls={'line-cutter': 'https://game.example/latest.json'})
            entry = json.loads((output / 'catalog').read_text())[0]
            self.assertEqual(entry['manifest_url'], 'https://game.example/latest.json')
            cloud = json.loads((output / 'hub-manifest.json').read_text())
            data = (output / 'catalog').read_bytes()
            self.assertEqual(cloud['files']['/catalog'], dict(size=len(data), sha256=hashlib.sha256(data).hexdigest()))

    def test_host_preserves_routes_legacy_back_and_immutable_archives(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = root / 'store/line-cutter/0.2.1/game.game.zip'
            old.parent.mkdir(parents=True)
            old.write_bytes(b'old immutable bytes')
            (root / 'site').mkdir()
            (root / 'site/index.html').write_bytes(b'landing')
            (root / 'index.html').write_bytes(b'wordless native hub')
            (root / 'docs').mkdir()
            (root / 'docs/game-authoring.html').write_bytes(b'author guide')
            (root / 'tools').mkdir()
            (root / 'tools/cubby_manifest.py').write_bytes(b'generator')
            host = serve.server(('127.0.0.1', 0), root)
            worker = threading.Thread(target=host.serve_forever, daemon=True)
            worker.start()
            try:
                def request(path, method='GET', headers=None):
                    connection = http.client.HTTPConnection(*host.server_address, timeout=5)
                    connection.request(method, path, headers=headers or {})
                    response = connection.getresponse()
                    result = response.status, dict(response.getheaders()), response.read()
                    connection.close()
                    return result
                for path in ['/', '/index.html']:
                    self.assertEqual(request(path)[2], b'landing')
                    self.assertEqual(request(path)[1]['Vary'], 'Referer')
                    same = f'http://127.0.0.1:{host.server_port}/games/line-cutter/play.html'
                    status, headers, _ = request(path, headers={'Referer': same})
                    self.assertEqual(status, 302)
                    self.assertEqual(headers['Location'], '/play')
                    self.assertEqual(request(path, headers={'Referer': 'https://foreign.example/games/test/'})[2], b'landing')
                for path in ['/play', '/play/', '/native/index.html']:
                    self.assertEqual(request(path)[2], b'wordless native hub')
                self.assertEqual(request('/docs/game-authoring.html')[2], b'author guide')
                self.assertEqual(request('/tools/cubby_manifest.py')[2], b'generator')
                self.assertEqual(request('/play/missing.js')[0], 404)
                status, headers, body = request('/store/line-cutter/0.2.1/game.game.zip')
                self.assertEqual((status, body), (200, b'old immutable bytes'))
                self.assertIn('immutable', headers['Cache-Control'])
                self.assertEqual(request('/store/line-cutter/0.2.1/game.game.zip', headers={'Range':'bytes=0-2'})[2], b'old')
                self.assertEqual(request('/.manifest-proxies.json')[0], 404)
            finally:
                host.shutdown()
                host.server_close()

    def test_live_metadata_proxy_supports_current_file_installer_and_updates_without_rebuild(self):
        state = {'body': b'', 'status': 200, 'delay': 0, 'truncate': False, 'length_override': None, 'requests': []}
        payloads = {}
        class Publisher(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                state['requests'].append(self.path)
                if self.path == '/latest.json':
                    time.sleep(state['delay'])
                    data, status = state['body'], state['status']
                else:
                    data = payloads.get(self.path, b'')
                    status = 200 if self.path in payloads else 404
                self.send_response(status)
                length = state['length_override'] if state['length_override'] is not None else len(data) + int(state['truncate'])
                self.send_header('Content-Length', str(length))
                if status == 302:
                    self.send_header('Location', '/unexpected.json')
                self.end_headers()
                try:
                    self.wfile.write(data)
                except BrokenPipeError:
                    pass
        publisher = ThreadingHTTPServer(('127.0.0.1', 0), Publisher)
        threading.Thread(target=publisher.serve_forever, daemon=True).start()
        upstream = f'http://127.0.0.1:{publisher.server_port}'
        def release(version):
            files = {'play.html': ('game ' + version).encode(), 'cover.png': b'cover'}
            inventory = {}
            for name, body in files.items():
                path = f'/releases/{version}/{name}'
                payloads[path] = body
                inventory[name] = dict(url=upstream + path, size=len(body), sha256=hashlib.sha256(body).hexdigest())
            state['body'] = json.dumps(dict(schema_version=2, id='line-cutter', version=version,
                runtime='web', entrypoint='play.html', artwork='cover.png', files=inventory)).encode()
        try:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                (root / '.manifest-proxies.json').write_text(json.dumps({
                    '/store/line-cutter/manifest.json': upstream + '/latest.json'}))
                host = serve.server(('127.0.0.1', 0), root, developer_local=True)
                threading.Thread(target=host.serve_forever, daemon=True).start()
                try:
                    url = f'http://127.0.0.1:{host.server_port}/store/line-cutter/manifest.json'
                    entry = dict(id='line-cutter', title='Line Cutter', artwork=upstream + '/cover.png', manifest_url=url)
                    games = root / 'installed'
                    release('1.0.0')
                    first = catalog.install_entry(entry, games, developer=True)
                    self.assertEqual(first['version'], '1.0.0')
                    for method in ['GET', 'HEAD']:
                        connection = http.client.HTTPConnection(*host.server_address, timeout=5)
                        connection.request(method, '/store/line-cutter/manifest.json')
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertIsNone(response.getheader('Location'))
                        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), '*')
                        self.assertIn('must-revalidate', response.getheader('Cache-Control'))
                        self.assertEqual(response.read(), state['body'] if method == 'GET' else b'')
                        connection.close()
                    release('1.1.0')
                    updated = catalog.install_entry(entry, games, developer=True, update=True)
                    self.assertEqual(updated['version'], '1.1.0')
                    self.assertTrue((games / 'line-cutter/releases/1.0.0').is_dir())
                    active = (games / 'line-cutter/current').resolve()
                    valid_manifest = state['body']
                    failures = [(valid_manifest, 200, 0, True, None),
                                (valid_manifest, 200, 0, False, '-1'),
                                (valid_manifest, 200, 0, False, 'invalid'),
                                (b'bad JSON', 200, 0, False, None),
                                (b'x' * (catalog.MAX_RELEASE + 1), 200, 0, False, None),
                                (b'', 302, 0, False, None),
                                (valid_manifest, 200, .15, False, None)]
                    for body, status, delay, truncate, length_override in failures:
                        state.update(body=body, status=status, delay=delay, truncate=truncate, length_override=length_override)
                        host.metadata_timeout = .05
                        connection = http.client.HTTPConnection(*host.server_address, timeout=5)
                        connection.request('GET', '/store/line-cutter/manifest.json')
                        response = connection.getresponse()
                        self.assertEqual(response.status, 502)
                        response.read()
                        connection.close()
                        with self.assertRaises(OSError):
                            catalog.install_entry(entry, games, developer=True, update=True)
                        self.assertEqual((games / 'line-cutter/current').resolve(), active)
                    self.assertNotIn('/unexpected.json', state['requests'])
                finally:
                    host.shutdown()
                    host.server_close()
        finally:
            publisher.shutdown()
            publisher.server_close()

import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

import vm
import web
from hosting import serve


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

    def test_host_redirects_only_stable_metadata_and_preserves_archives(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = root / 'store/line-cutter/0.2.1/game.game.zip'
            old.parent.mkdir(parents=True)
            old.write_bytes(b'old immutable bytes')
            (root / '.manifest-redirects.json').write_text(json.dumps({
                '/store/line-cutter/manifest.json': 'https://game.example/latest.json'}))
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
                for method in ['GET', 'HEAD']:
                    status, headers, body = request('/store/line-cutter/manifest.json', method)
                    self.assertEqual(status, 302)
                    self.assertEqual(headers['Location'], 'https://game.example/latest.json')
                    self.assertNotIn('immutable', headers['Cache-Control'])
                    self.assertEqual(body, b'')
                status, headers, body = request('/store/line-cutter/0.2.1/game.game.zip')
                self.assertEqual((status, body), (200, b'old immutable bytes'))
                self.assertIn('immutable', headers['Cache-Control'])
                self.assertEqual(request('/store/line-cutter/0.2.1/game.game.zip', headers={'Range':'bytes=0-2'})[2], b'old')
                self.assertEqual(request('/.manifest-redirects.json')[0], 404)
            finally:
                host.shutdown()
                host.server_close()

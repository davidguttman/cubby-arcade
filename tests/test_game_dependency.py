import hashlib
import json
from pathlib import Path
import tarfile
import zipfile
import tempfile
import unittest
from unittest.mock import patch
import vm


class GameDependencyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / 'cache'
        self.state = self.root / 'state'
        self.state.mkdir()
        self.payload = b'unchanged upstream game'
        self.asset = {'path': 'public/line-cutter/line-cutter.js',
                      'sha256': hashlib.sha256(self.payload).hexdigest()}
        self.manifest = {'schema_version': 1, 'game': 'line-cutter',
                         'repository': 'owner/game', 'commit': 'a' * 40,
                         'assets': [self.asset]}
        self.lock = self.root / 'games.lock.json'
        self.lock.write_text(json.dumps(self.manifest))
        for name, value in [('GAME_CACHE', self.cache), ('GAME_LOCK', self.lock), ('STATE', self.state)]:
            active = patch.object(vm, name, value, create=True)
            active.start()
            self.addCleanup(active.stop)

    def cached_asset(self, content):
        path = self.cache / self.asset['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def test_missing_dependency_fails_without_network_or_partial_bundle(self):
        with patch.object(vm, 'run', side_effect=AssertionError('unexpected network')):
            with self.assertRaisesRegex(SystemExit, 'fetch-games'):
                vm.build_example()
        self.assertFalse((self.state / 'line-cutter-0.1.8.game.zip').exists())

    def test_bundle_checks_cached_asset_integrity(self):
        self.cached_asset(b'tampered')
        with self.assertRaisesRegex(SystemExit, 'checksum'):
            vm.build_example()

    def test_fetch_uses_exact_commit_and_reuses_verified_cache(self):
        def download_asset(args, **kwargs):
            kwargs['stdout'].write(self.payload)
        with patch.object(vm, 'run', side_effect=download_asset) as download:
            vm.fetch_games()
        self.assertEqual(download.call_args.args[0], ['gh', 'api',
                         'repos/owner/game/contents/' + self.asset['path'] + '?ref=' + 'a' * 40,
                         '-H', 'Accept: application/vnd.github.raw'])
        self.assertEqual((self.cache / self.asset['path']).read_bytes(), self.payload)
        with patch.object(vm, 'run', side_effect=AssertionError('unexpected network')):
            vm.fetch_games()

    def test_external_trailer_fetch_and_offline_inventory(self):
        trailer = b'real recorded gameplay'
        asset = {'path': 'media/trailer.mp4', 'url': 'https://media.publit.io/file/trailer.mp4',
                 'sha256': hashlib.sha256(trailer).hexdigest()}
        self.manifest['assets'].append(asset)
        self.lock.write_text(json.dumps(self.manifest))
        self.cached_asset(self.payload)
        def download_asset(args, **kwargs):
            self.assertEqual(args, ['curl', '--fail', '--location', '--silent', '--show-error',
                                  '--proto', '=https', '--proto-redir', '=https', asset['url']])
            kwargs['stdout'].write(trailer)
        with patch.object(vm, 'run', side_effect=download_asset):
            vm.fetch_games()
        with patch.object(vm, 'run', side_effect=AssertionError('unexpected network')):
            package = vm.build_example()
            self.assertEqual(vm.build_example().read_bytes(), package.read_bytes())
        with zipfile.ZipFile(package) as archive:
            self.assertEqual(archive.read('trailer.mp4'), trailer)
            metadata = json.loads(archive.read('manifest.json'))
            self.assertEqual(metadata['version'], '0.1.14')
            self.assertEqual(metadata['files']['trailer.mp4'], asset['sha256'])
            self.assertEqual(metadata['attract'], 'trailer.mp4')
            self.assertIn(b'trailer-handheld.webm', archive.read('index.html'))

    def test_locked_rendition_build_is_offline_and_rejects_tampering(self):
        self.cached_asset(self.payload)
        output = b'silent handheld video'
        self.asset['rendition'] = {'path': 'media/handheld.webm',
            'sha256': hashlib.sha256(output).hexdigest(),
            'ffmpeg_version': 'n9.0.2', 'recipe': 'silent-vp8-480x300-30fps-v1'}
        self.lock.write_text(json.dumps(self.manifest))
        def convert(args, **kwargs):
            self.assertEqual(args[0], 'ffmpeg')
            self.assertIn('-an', args)
            Path(args[-1]).write_bytes(output)
        with patch.object(vm, 'run', side_effect=convert):
            vm.fetch_games()
        with patch.object(vm, 'run', side_effect=AssertionError('unexpected subprocess')):
            vm.fetch_games()
            package = vm.build_example()
        with zipfile.ZipFile(package) as archive:
            self.assertEqual(archive.read('handheld.webm'), output)
        (self.cache / self.asset['rendition']['path']).write_bytes(b'tampered')
        with self.assertRaisesRegex(SystemExit, 'rendition'):
            vm.build_example()

    def test_corrupt_download_is_not_installed(self):
        def download_corrupt(args, **kwargs):
            kwargs['stdout'].write(b'corrupt')
        with patch.object(vm, 'run', side_effect=download_corrupt):
            with self.assertRaisesRegex(SystemExit, 'checksum'):
                vm.fetch_games()
        self.assertFalse((self.cache / self.asset['path']).exists())
        self.assertEqual(list(self.cache.rglob('*.part')), [])

    def test_offline_package_contains_exact_game_and_os_bundle_has_no_game(self):
        self.cached_asset(self.payload)
        with patch.object(vm, 'run', side_effect=AssertionError('unexpected network')):
            package = vm.build_example()
            first = package.read_bytes()
            self.assertEqual(vm.build_example().read_bytes(), first)
            bundle = vm.bundle()
        with zipfile.ZipFile(package) as archive:
            self.assertEqual(archive.read('line-cutter.js'), self.payload)
            self.assertIn('index.html', archive.namelist())
            self.assertIn('cover.png', archive.namelist())
            self.assertEqual(json.loads(archive.read('manifest.json'))['entrypoint'], 'play.html')
            metadata = json.loads(archive.read('manifest.json'))
            for source in (vm.HERE / 'runtime/core').glob('*.js'):
                name = 'core/' + source.name
                self.assertEqual(archive.read(name), source.read_bytes())
                self.assertEqual(metadata['files'][name], hashlib.sha256(source.read_bytes()).hexdigest())
        with tarfile.open(bundle) as archive:
            self.assertIn('runtime/index.html', archive.getnames())
            self.assertFalse(any(name.startswith('public/') or 'examples/' in name for name in archive.getnames()))


if __name__ == '__main__':
    unittest.main()

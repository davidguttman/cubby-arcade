import hashlib
import json
from pathlib import Path
import tarfile
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
                vm.bundle()
        self.assertFalse((self.state / 'bundle.tar.gz').exists())

    def test_bundle_checks_cached_asset_integrity(self):
        self.cached_asset(b'tampered')
        with self.assertRaisesRegex(SystemExit, 'checksum'):
            vm.bundle()

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

    def test_corrupt_download_is_not_installed(self):
        def download_corrupt(args, **kwargs):
            kwargs['stdout'].write(b'corrupt')
        with patch.object(vm, 'run', side_effect=download_corrupt):
            with self.assertRaisesRegex(SystemExit, 'checksum'):
                vm.fetch_games()
        self.assertFalse((self.cache / self.asset['path']).exists())
        self.assertEqual(list(self.cache.rglob('*.part')), [])

    def test_offline_bundle_contains_exact_game_at_runtime_path(self):
        self.cached_asset(self.payload)
        with patch.object(vm, 'run', side_effect=AssertionError('unexpected network')):
            bundle = vm.bundle()
        with tarfile.open(bundle) as archive:
            self.assertEqual(archive.extractfile(self.asset['path']).read(), self.payload)
            self.assertIn('runtime/index.html', archive.getnames())
            self.assertIn('guest/bootstrap.sh', archive.getnames())
            self.assertFalse(any('.git' in name or '__pycache__' in name for name in archive.getnames()))


if __name__ == '__main__':
    unittest.main()

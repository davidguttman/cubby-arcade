import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from runtime import packages


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.games = self.root / 'games'

    def package(self, version='1', content=b'game', path='index.html', digest=None):
        manifest = dict(schema_version=1, id='test-game', version=version,
                        entrypoint='index.html', artwork='art.svg', runtime='web',
                        files={path: digest or hashlib.sha256(content).hexdigest(),
                               'art.svg': hashlib.sha256(b'art').hexdigest()})
        target = self.root / (version + '.zip')
        with zipfile.ZipFile(target, 'w') as z:
            z.writestr('manifest.json', json.dumps(manifest))
            z.writestr(path, content)
            z.writestr('art.svg', b'art')
        return target

    def test_install_discover_and_failed_update_preserves_active(self):
        packages.install(self.package(), self.games)
        self.assertEqual(packages.library(self.games)[0]['id'], 'test-game')
        before = (self.games / 'test-game/current').resolve()
        with self.assertRaises(ValueError):
            packages.install(self.package('2', digest='0' * 64), self.games)
        self.assertEqual((self.games / 'test-game/current').resolve(), before)
        packages.install(self.package('2', b'new'), self.games)
        self.assertEqual((self.games / 'test-game/current/index.html').read_bytes(), b'new')
        self.assertTrue(before.is_dir())

    def test_traversal_rejected_without_writing_outside_root(self):
        with self.assertRaises(ValueError):
            packages.install(self.package(path='../escape'), self.games)
        self.assertFalse((self.root / 'escape').exists())

    def test_same_version_cannot_replace_different_bytes(self):
        packages.install(self.package(), self.games)
        with self.assertRaises(ValueError):
            packages.install(self.package(content=b'different'), self.games)
        self.assertEqual((self.games / 'test-game/current/index.html').read_bytes(), b'game')

    def test_empty_library_needs_no_network(self):
        self.assertEqual(packages.library(self.games), [])

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import web

class WebHostTests(unittest.TestCase):
    def test_browser_play_alias_resolves_preview_launcher_not_site_landing(self):
        handler = object.__new__(web.PreviewHandler)
        handler.directory = '/tmp/cubby-preview'
        self.assertEqual(handler.translate_path('/play?demo=1'), '/tmp/cubby-preview/index.html')

    def test_export_validates_package_and_adds_host_shell_and_shared_launcher(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package = root / 'demo.game.zip'
            payload = {'index.html': b'<canvas></canvas>', 'cover.svg': b'<svg/>'}
            manifest = dict(schema_version=1, id='demo', version='1.0.0', runtime='web',
                            entrypoint='index.html', artwork='cover.svg', files={k:hashlib.sha256(v).hexdigest() for k,v in payload.items()})
            with zipfile.ZipFile(package, 'w') as archive:
                for name, value in payload.items(): archive.writestr(name, value)
                archive.writestr('manifest.json', json.dumps(manifest))
            output = root / 'output'
            web.build(output, [package])
            self.assertEqual((output / 'index.html').read_bytes(), (web.HERE / 'runtime/index.html').read_bytes())
            self.assertFalse((output / 'games').exists())
            self.assertEqual(json.loads((output / 'library').read_text()), [])
            registry = json.loads((output / 'catalog').read_text())
            self.assertEqual(registry[0]['id'], 'demo')
            self.assertEqual(registry[0]['manifest_url'], 'https://cubby.david.app/store/demo/manifest.json')
            release = json.loads((output / 'store/demo/manifest.json').read_text())
            self.assertEqual(release['package']['url'], 'https://cubby.david.app/store/demo/1.0.0/demo-1.0.0.game.zip')
            self.assertTrue((output / 'store/demo/manifest.json').is_file())
            self.assertNotIn('entrypoint', registry[0])
            self.assertEqual((output / 'runtime/core/hub.js').read_bytes(), (web.HERE / 'runtime/core/hub.js').read_bytes())
            cloud = json.loads((output / 'hub-manifest.json').read_text())
            self.assertEqual(cloud['bridge_version'], 1)
            self.assertIn('/index.html', cloud['files'])
            self.assertIn('/catalog', cloud['files'])
            self.assertTrue(all(not name.startswith('/games/') for name in cloud['files']))
            for name, metadata in cloud['files'].items():
                content = (output / name.lstrip('/')).read_bytes()
                self.assertEqual(metadata, {'size':len(content), 'sha256':hashlib.sha256(content).hexdigest()})
            self.assertIn('Little games.<br>Big discoveries.', (output / 'site/index.html').read_text())
            self.assertIn('/docs/game-authoring.html', (output / 'site/index.html').read_text())
            self.assertIn('schema_version', (output / 'docs/game-release-manifest.html').read_text())
            self.assertEqual((output / 'docs/game-release-manifest.md').read_bytes(), (web.HERE / 'docs/game-release-manifest.md').read_bytes())
            self.assertEqual((output / 'tools/cubby_manifest.py').read_bytes(), (web.HERE / 'runtime/file_manifest.py').read_bytes())
            self.assertEqual((output / 'native/index.html').read_bytes(), (output / 'index.html').read_bytes())
            self.assertTrue(all(not name.startswith(('/site/', '/docs/', '/tools/')) for name in cloud['files']))
            self.assertFalse((output / 'vm.py').exists())
            self.assertEqual((output / 'runtime/core/input.js').read_bytes(), (web.HERE / 'runtime/core/input.js').read_bytes())
            self.assertEqual((output / 'runtime/core/screen.css').read_bytes(), (web.HERE / 'runtime/core/screen.css').read_bytes())
            self.assertEqual((output / 'runtime/core/preferences.js').read_bytes(), (web.HERE / 'runtime/core/preferences.js').read_bytes())
            # An invalid replacement must leave the previous export intact.
            previous_catalog = (output / 'catalog').read_bytes()
            with zipfile.ZipFile(package, 'a') as archive: archive.writestr('bad.txt', 'extra')
            with self.assertRaises(ValueError): web.build(output, [package])
            self.assertEqual((output / 'catalog').read_bytes(), previous_catalog)
            self.assertTrue((output / 'store/demo/manifest.json').is_file())
            self.assertFalse((output / 'games').exists())
            unrelated = root / 'unrelated'
            unrelated.mkdir()
            with self.assertRaises(ValueError): web.build(unrelated, [])

if __name__ == '__main__': unittest.main()

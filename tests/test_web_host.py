import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
from unittest.mock import patch
from pathlib import PureWindowsPath
import unittest
import zipfile
import web

class WebHostTests(unittest.TestCase):
    def test_companion_install_shell_is_exported_outside_native_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = web.build(Path(tmp) / 'site', registry=[])
            for path in (web.HERE / 'parents').rglob('*'):
                if path.is_file():
                    self.assertEqual((output / 'parents' / path.relative_to(web.HERE / 'parents')).read_bytes(), path.read_bytes())
            inventory = json.loads((output / 'hub-manifest.json').read_text())['files']
            self.assertFalse(any(path.startswith('/parents/') for path in inventory))

    def test_beta_catalog_is_separate_and_cached_by_browser_without_breaking_native_inventory(self):
        beta = [{'id': 'early', 'title': 'Early Game',
                 'manifest_url': 'https://early.example/beta/manifest.json',
                 'artwork': 'https://early.example/cover.png'}]
        original_read = Path.read_text
        def read_with_beta(path, *args, **kwargs):
            if path == web.HERE / 'hosting/beta-catalog.yaml':
                return json.dumps(beta)
            return original_read(path, *args, **kwargs)
        with tempfile.TemporaryDirectory() as tmp:
            output = web.build(Path(tmp) / 'site')
            self.assertEqual(json.loads((output / 'beta/catalog').read_text()), web.default_beta_registry())   # whatever the checked-in beta list holds
            old_worker = (output / 'cubby-worker.js').read_text()
            with patch.object(Path, 'read_text', read_with_beta):
                web.build(output, registry=[], manifest_urls={'early': 'https://stable.example/manifest.json'})
            self.assertEqual(json.loads((output / 'catalog').read_text()), [])
            content = (output / 'beta/catalog').read_bytes()
            self.assertEqual(json.loads(content), beta)
            worker = (output / 'cubby-worker.js').read_text()
            self.assertNotEqual(worker, old_worker)
            settings = json.loads(worker.split('attachWorker(self,', 1)[1].removesuffix(');\n'))
            self.assertIn('/beta/catalog', settings['shellPaths'])
            inventory = json.loads((output / 'hub-manifest.json').read_text())['files']
            # Existing native clients reject unknown shell paths; their feed
            # manager maintains the independent last-good catalog cache.
            self.assertNotIn('/beta/catalog', inventory)

    def test_invalid_beta_catalog_preserves_previous_export(self):
        original_read = Path.read_text
        with tempfile.TemporaryDirectory() as tmp:
            output = web.build(Path(tmp) / 'site')
            previous = (output / 'hub-manifest.json').read_bytes()
            for invalid in ('[broken', '{}', '[{"id":"early","title":"Early","manifest_url":"http://unsafe.example/manifest","artwork":"https://early.example/cover.png"}]'):
                def read_with_invalid(path, *args, **kwargs):
                    return invalid if path == web.HERE / 'hosting/beta-catalog.yaml' else original_read(path, *args, **kwargs)
                with self.subTest(invalid=invalid), patch.object(Path, 'read_text', read_with_invalid):
                    with self.assertRaises(ValueError):
                        web.build(output)
                self.assertEqual((output / 'hub-manifest.json').read_bytes(), previous)

    def test_cli_default_build_exports_beta_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'site'
            result = subprocess.run([sys.executable, 'web.py', 'build', '--output', str(output)],
                                    cwd=web.HERE, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads((output / 'beta/catalog').read_text()), web.default_beta_registry())   # whatever the checked-in beta list holds

    def test_shell_only_build_does_not_require_posix_publisher_lock(self):
        script = '''
import builtins, json, tempfile
from pathlib import Path
original_import = builtins.__import__
def without_fcntl(name, *args, **kwargs):
    if name == 'fcntl':
        raise ModuleNotFoundError('fcntl unavailable')
    return original_import(name, *args, **kwargs)
builtins.__import__ = without_fcntl
import web
with tempfile.TemporaryDirectory() as tmp:
    output = web.build(Path(tmp) / 'site')
    assert json.loads((output / 'library').read_text()) == []
    assert (output / 'hub-manifest.json').is_file()
'''
        result = subprocess.run([sys.executable, '-c', script], cwd=web.HERE,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_shell_urls_use_posix_separators_even_for_windows_relative_paths(self):
        original = type(web.HERE).relative_to
        def windows_relative(path, *args, **kwargs):
            return PureWindowsPath(*original(path, *args, **kwargs).parts)
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(type(web.HERE), 'relative_to', windows_relative):
                output = web.build(Path(tmp) / 'site')
            inventory = json.loads((output / 'hub-manifest.json').read_text())['files']
            self.assertIn('/runtime/core/hub.js', inventory)
            self.assertTrue(all('\\' not in name for name in inventory))
            worker = (output / 'cubby-worker.js').read_text()
            settings = json.loads(worker.split('attachWorker(self,', 1)[1].removesuffix(');\n'))
            self.assertIn('/runtime/core/hub.js', settings['shellPaths'])
            self.assertTrue(all('\\' not in name for name in settings['shellPaths']))

    def test_browser_play_alias_resolves_cubby_buddy_page_not_site_landing(self):
        # /play is the Cubby Buddy page; it frames the hub at /native/index.html.
        handler = object.__new__(web.PreviewHandler)
        handler.directory = '/tmp/cubby-preview'
        self.assertEqual(handler.translate_path('/play?demo=1'), '/tmp/cubby-preview/site/play.html')
        page = (web.HERE / 'website/play.html').read_text()
        self.assertIn("'/native/index.html?embed=handheld&parentOrigin='", page)

    def test_browser_worker_has_explicit_offline_hub_without_native_inventory_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = web.build(Path(tmp) / 'site')
            worker = (output / 'cubby-worker.js').read_text()
            self.assertIn("importScripts('/runtime/core/link.js','/runtime/core/browser-store.js')", worker)
            settings = json.loads(worker.split('attachWorker(self,', 1)[1].removesuffix(');\n'))
            self.assertTrue({'/play', '/play/', '/native/index.html', '/catalog'}.issubset(settings['shellPaths']))
            self.assertNotIn('/', settings['shellPaths'])
            self.assertNotIn('/index.html', settings['shellPaths'])
            self.assertIn('/runtime/core/browser-bootstrap.js', settings['shellPaths'])
            self.assertEqual(len(settings['shellVersion']), 64)
            inventory = json.loads((output / 'hub-manifest.json').read_text())['files']
            self.assertNotIn('/cubby-worker.js', inventory)
            self.assertIn('/runtime/core/browser-bootstrap.js', inventory)

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
            self.assertEqual(json.loads((output / 'beta/catalog').read_text()), web.default_beta_registry())   # whatever the checked-in beta list holds
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
            self.assertIn('Cubby<br>Buddy.', (output / 'site/index.html').read_text())   # the waitlist landing page
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

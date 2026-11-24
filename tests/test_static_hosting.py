"""The production artifact needs no request-time process or repository Blueprint."""
import hashlib
import json
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import web
from test_store_distribution import archive
from hosting import build as hosting_build


class StaticHosting(unittest.TestCase):
    def test_marketing_export_excludes_interactive_and_technical_content(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(hosting_build.vm, 'fetch_games') as fetch:
            root = hosting_build.build(Path(tmp) / 'marketing', surface='marketing')
            fetch.assert_not_called()
            self.assertEqual(set(p.name for p in root.iterdir()),
                             {'.handheld-web-export', 'index.html', 'favicon.ico', 'site', 'cubby-worker.js', 'parents'})
            retirement = (root / 'cubby-worker.js').read_text()
            self.assertEqual(set(p.name for p in (root / 'parents').iterdir()), {'worker.js'})
            self.assertEqual((root / 'parents/worker.js').read_text(), retirement)
            self.assertIn('registration.unregister()', retirement)
            self.assertIn('clients.claim()', retirement)
            self.assertIn('client.navigate(client.url)', retirement)
            for forbidden in ('importScripts', 'caches.delete', 'indexedDB.deleteDatabase', 'localStorage.clear'):
                self.assertNotIn(forbidden, retirement)
            self.assertFalse((root / 'site/play.html').exists())
            landing = (root / 'index.html').read_text()
            self.assertIn('href="https://play.cubbyarcade.com/"', landing)
            self.assertIn('https://play.cubbyarcade.com/docs/game-authoring.md', landing)
            self.assertIn('href="https://play.cubbyarcade.com/docs/game-authoring.html"', landing)
            for source in (root / 'index.html', root / 'site/style.css'):
                for path in re.findall(r"(?:src=|href=|url\()[\"']?(/[^\"'\s)>]+)", source.read_text()):
                    self.assertTrue((root / ('index.html' if path == '/' else path.lstrip('/'))).is_file(), path)


    def test_play_export_has_wrapper_root_docs_and_verified_native_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            temporary = Path(tmp)
            game = archive(temporary, 'line-cutter')
            with patch.object(hosting_build, 'retained_archives', return_value=[]), \
                 patch.object(hosting_build.vm, 'fetch_games'), \
                 patch.object(hosting_build.vm, 'build_example', return_value=game), \
                 patch.object(hosting_build, 'legacy_manifests', return_value={}):
                root = hosting_build.build(temporary / 'play', surface='play')
            self.assertEqual((root / 'index.html').read_bytes(), (root / 'site/play.html').read_bytes())
            # The play page installs as its own app on phones: its manifest and every icon ship.
            page = (root / 'index.html').read_text()
            self.assertIn('<link rel="manifest" href="/site/manifest.webmanifest">', page)
            app = json.loads((root / 'site/manifest.webmanifest').read_text())
            self.assertEqual((app['id'], app['start_url'], app['scope']), ('/', '/', '/'))
            self.assertEqual({icon['purpose'] for icon in app['icons']}, {'any', 'maskable'})
            for icon in app['icons']:
                self.assertTrue((root / icon['src'].lstrip('/')).is_file(), icon['src'])
            self.assertFalse((root / 'site/index.html').exists())
            self.assertFalse((root / 'site/waitlist.js').exists())
            self.assertTrue((root / 'parents/worker.js').is_file())
            self.assertTrue((root / 'tools/cubby_manifest.py').is_file())
            for path in ('docs/game-authoring.html', 'docs/game-release-manifest.html'):
                self.assertNotIn('superstruct-marketing.onrender.com/sdk.js', (root / path).read_text())
            worker = (root / 'cubby-worker.js').read_text()
            self.assertIn('"/"', worker)
            self.assertIn('"/index.html"', worker)
            settings = json.loads(worker.split('attachWorker(self,', 1)[1].removesuffix(');\n'))
            aliases = {'/': 'index.html', '/play': 'site/play.html', '/play/': 'site/play.html'}
            for path in settings['shellPaths']:
                self.assertTrue((root / aliases.get(path, path.lstrip('/'))).is_file(), path)
            self.assertEqual((root / 'site/boot.png').read_bytes(),
                             (web.HERE / 'rocknix/splash/preview.png').read_bytes())
            self.assertEqual((root / 'site/boot.webp').read_bytes(),
                             (web.HERE / 'website/boot.webp').read_bytes())
            native = (root / 'native/index.html').read_bytes()
            manifest = json.loads((root / 'hub-manifest.json').read_text())
            self.assertEqual(manifest['files']['/index.html']['sha256'], hashlib.sha256(native).hexdigest())

    def test_render_settings_are_not_managed_by_a_repository_blueprint(self):
        self.assertFalse((web.HERE / 'render.yaml').exists())

    def test_static_export_landing_does_not_replace_native_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.check_export(Path(tmp))

    def check_export(self, temporary):
        game = archive(temporary, 'line-cutter')
        historical = archive(temporary, 'little-camp')
        with \
             patch.object(hosting_build, 'retained_archives', return_value=[historical]), \
             patch.object(hosting_build.vm, 'fetch_games'), \
             patch.object(hosting_build.vm, 'build_example', return_value=game), \
             patch.object(hosting_build, 'legacy_manifests', return_value={}):
            root = hosting_build.build(temporary / 'site')
            self.assertEqual((root / 'index.html').read_bytes(), (root / 'site/index.html').read_bytes())
            self.assertEqual((root / 'parents/manifest.webmanifest').read_bytes(), (web.HERE / 'parents/manifest.webmanifest').read_bytes())
            self.assertTrue((root / 'parents/worker.js').is_file())
            self.assertTrue((root / 'parents/icons/maskable-512.png').is_file())
            native = (root / 'native/index.html').read_bytes()
            self.assertNotEqual((root / 'index.html').read_bytes(), native)
            manifest = json.loads((root / 'hub-manifest.json').read_bytes())
            self.assertEqual(manifest['files']['/index.html'],
                             dict(size=len(native), sha256=hashlib.sha256(native).hexdigest()))
            self.assertEqual(json.loads((root / 'library').read_text()), [])
            self.assertFalse((root / '.manifest-proxies.json').exists())
            self.assertFalse((root / 'games').exists())
            legacy = json.loads((root / 'store/little-camp/manifest.json').read_text())
            self.assertEqual(legacy['package']['url'],
                             'https://play.cubbyarcade.com/store/little-camp/1/little-camp-1.game.zip')
            self.assertEqual((root / 'store/little-camp/1/little-camp-1.game.zip').read_bytes(),
                             historical.read_bytes())

    def test_legacy_snapshot_resolves_at_publisher_final_url_and_fails_closed(self):
        body = dict(schema_version=2, id='line-cutter', version='1.0.0', runtime='web',
                    entrypoint='index.html', artwork='cover.png', files={
                        'index.html': dict(url='../releases/1.0.0/index.html', size=1, sha256='a'*64),
                        'cover.png': dict(url='../releases/1.0.0/cover.png', size=1, sha256='b'*64)})
        def download(url, target, *args, **kwargs):
            Path(target).write_text(json.dumps(body))
            return 'https://publisher.example/prefix/arcade/manifest.json'
        with patch.object(hosting_build.catalog, 'download', side_effect=download):
            snapshots = hosting_build.legacy_manifests({'line-cutter': 'https://publisher.example/latest.json'})
        release = snapshots['line-cutter']
        self.assertEqual(release['files']['index.html']['url'],
                         'https://publisher.example/prefix/releases/1.0.0/index.html')
        body['id'] = 'different-game'
        with patch.object(hosting_build.catalog, 'download', side_effect=download):
            with self.assertRaises(ValueError):
                hosting_build.legacy_manifests({'line-cutter': 'https://publisher.example/latest.json'})

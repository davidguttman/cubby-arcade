"""The production artifact needs no request-time process or repository Blueprint."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import web
from test_store_distribution import archive
from hosting import build as hosting_build


class StaticHosting(unittest.TestCase):
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
                             'https://cubby.david.app/store/little-camp/1/little-camp-1.game.zip')
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

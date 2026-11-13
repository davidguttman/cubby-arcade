"""Store discovery never implies a bundled/installed game."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import web
from hosting import build as hosting_build


def archive(root, game):
    target = root / (game + '.zip')
    payload = {'play.html': b'<canvas/>', 'cover.png': b'art'}
    manifest = dict(schema_version=1, id=game, version='1', runtime='web',
                    entrypoint='play.html', artwork='cover.png',
                    files={k: hashlib.sha256(v).hexdigest() for k, v in payload.items()})
    with zipfile.ZipFile(target, 'w') as output:
        for name, data in payload.items(): output.writestr(name, data)
        output.writestr('manifest.json', json.dumps(manifest))
    return target


class StoreDistribution(unittest.TestCase):
    def test_yaml_catalog_is_safely_parsed_and_registry_validated(self):
        documents = [
            'not-a-registry',
            '- id: missing-metadata\n',
            '- [unterminated\n',
            '!!python/object/apply:builtins.str [unsafe]\n',
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'hosting').mkdir()
            source = root / 'hosting/catalog.yaml'
            for document in documents:
                source.write_text(document)
                with self.subTest(document=document), patch.object(web, 'HERE', root):
                    with self.assertRaises(ValueError):
                        web.default_registry()

    def test_default_fallback_has_six_offers_but_no_payloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = web.build(Path(tmp) / 'site', registry=web.default_registry())
            self.assertEqual(json.loads((site / 'library').read_text()), [])
            self.assertEqual([e['id'] for e in json.loads((site / 'catalog').read_text())],
                             ['trail-mix', 'fox-barrister', 'small-change', 'owl-the-way-home', 'good-bribes-only', 'spell-castle'])
            beta = json.loads((site / 'beta/catalog').read_text())
            self.assertEqual([e['id'] for e in beta], ['line-cutter'])
            self.assertEqual(beta[0], {
                'id': 'line-cutter', 'title': 'Line Cutter',
                'manifest_url': 'https://linecutter.david.app/store/line-cutter/manifest.json',
                'artwork': 'https://linecutter.david.app/store/line-cutter/0.4.0/files/cover.png',
                'attract': 'https://linecutter.david.app/store/line-cutter/0.4.0/files/trailer-handheld.webm',
            })
            trail = next(e for e in json.loads((site / 'catalog').read_text()) if e['id'] == 'trail-mix')
            self.assertEqual(trail['manifest_url'], 'https://trailmix.david.app/arcade/manifest.json')
            self.assertEqual(trail['artwork'], 'https://trailmix.david.app/discovery/cover.png')
            self.assertEqual(trail['attract'], 'https://trailmix.david.app/discovery/trailer.webm')
            fox = next(e for e in json.loads((site / 'catalog').read_text()) if e['id'] == 'fox-barrister')
            self.assertEqual(fox['title'], 'Fox Barrister')
            self.assertEqual(fox['manifest_url'], 'https://foxbarrister.david.app/arcade/manifest.json')
            self.assertEqual(fox['artwork'], 'https://foxbarrister.david.app/discovery/cover.png')
            self.assertEqual(fox['attract'], 'https://foxbarrister.david.app/discovery/trailer.webm')
            self.assertFalse((site / 'games').exists())
            self.assertFalse((site / 'store').exists())

    def test_host_retains_historical_archives_without_listing_or_preinstalling_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = archive(root, 'little-camp')
            line = archive(root, 'line-cutter')
            with patch.object(hosting_build, 'retained_archives', return_value=[old]), \
                 patch.object(hosting_build.vm, 'fetch_games'), \
                 patch.object(hosting_build.vm, 'build_example', return_value=line), \
                 patch.object(hosting_build, 'legacy_manifests', return_value={}):
                site = hosting_build.build(root / 'site')
            self.assertEqual(json.loads((site / 'library').read_text()), [])
            self.assertFalse((site / 'games').exists())
            self.assertEqual([e['id'] for e in json.loads((site / 'catalog').read_text())],
                             ['trail-mix', 'fox-barrister', 'small-change', 'owl-the-way-home', 'good-bribes-only', 'spell-castle'])
            self.assertEqual([e['id'] for e in json.loads((site / 'beta/catalog').read_text())],
                             ['line-cutter'])
            self.assertEqual((site / 'store/little-camp/1/little-camp-1.game.zip').read_bytes(), old.read_bytes())
            self.assertFalse((site / 'store/trail-mix').exists())
            self.assertTrue((site / 'store/line-cutter/1/line-cutter-1.game.zip').is_file())
            cloud = json.loads((site / 'hub-manifest.json').read_text())
            data = (site / 'catalog').read_bytes()
            self.assertEqual(cloud['files']['/catalog']['sha256'], hashlib.sha256(data).hexdigest())

    def test_only_published_historical_archives_are_retained(self):
        retained = hosting_build.retained_archives()
        self.assertEqual({p.name for p in retained}, {
            'line-cutter-0.2.0.game.zip', 'line-cutter-0.2.1.game.zip',
            'little-camp-0.1.0.game.zip',
        })
        self.assertFalse((hosting_build.ROOT / 'hosting/releases/trail-mix').exists())

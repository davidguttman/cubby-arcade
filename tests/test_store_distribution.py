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
from runtime import packages


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

    def test_default_fallback_has_two_offers_but_no_payloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = web.build(Path(tmp) / 'site', registry=web.default_registry())
            self.assertEqual(json.loads((site / 'library').read_text()), [])
            self.assertEqual([e['id'] for e in json.loads((site / 'catalog').read_text())],
                             ['line-cutter', 'trail-mix'])
            self.assertFalse((site / 'games').exists())
            self.assertFalse((site / 'store').exists())

    def test_host_retains_historical_archives_without_listing_or_preinstalling_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = archive(root, 'little-camp')
            trail = archive(root, 'trail-mix')
            line = archive(root, 'line-cutter')
            with patch.object(hosting_build, 'retained_archives', return_value=[old, trail]), \
                 patch.object(hosting_build.vm, 'fetch_games'), \
                 patch.object(hosting_build.vm, 'build_example', return_value=line):
                site = hosting_build.build(root / 'site')
            self.assertEqual(json.loads((site / 'library').read_text()), [])
            self.assertFalse((site / 'games').exists())
            self.assertEqual([e['id'] for e in json.loads((site / 'catalog').read_text())],
                             ['line-cutter', 'trail-mix'])
            self.assertEqual((site / 'store/little-camp/1/little-camp-1.game.zip').read_bytes(), old.read_bytes())
            self.assertEqual(json.loads((site / 'store/trail-mix/manifest.json').read_text())['id'], 'trail-mix')
            cloud = json.loads((site / 'hub-manifest.json').read_text())
            data = (site / 'catalog').read_bytes()
            self.assertEqual(cloud['files']['/catalog']['sha256'], hashlib.sha256(data).hexdigest())

    def test_trail_mix_handoff_is_integrity_checked_and_installable(self):
        retained = hosting_build.retained_archives()
        trail = next(p for p in retained if p.name == 'trail-mix-0.1.0.game.zip')
        with tempfile.TemporaryDirectory() as tmp:
            manifest = packages.install(trail, Path(tmp))
            self.assertEqual(manifest['id'], 'trail-mix')
            self.assertEqual(manifest['version'], '0.1.0')
            records = json.loads((hosting_build.ROOT / 'hosting/releases.json').read_text())
            provenance = next(r for r in records if r['path'].endswith(trail.name))
            self.assertEqual(manifest['files'], provenance['payload_sha256'])

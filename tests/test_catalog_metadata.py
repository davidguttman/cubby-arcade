"""Adult marketing discovery metadata stays optional and survives static export."""
import copy
import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from runtime import catalog
import web


class CatalogMetadataTests(unittest.TestCase):
    def entry(self):
        return {'id': 'counting', 'title': 'Counting',
                'manifest_url': 'https://example.com/arcade/manifest.json',
                'artwork': 'https://example.com/cover.png'}

    def metadata(self):
        return {'tagline': 'Count the dots to move your penguins.',
                'teaches': 'counting', 'ages': '3–5',
                'web_url': 'https://example.com/', 'kind': 'game',
                'added': '2026-11-18'}

    def test_fields_are_optional_and_do_not_acquire_defaults(self):
        entry = self.entry()
        self.assertEqual(catalog.validate_registry([entry]), [self.entry()])
        for key, value in self.metadata().items():
            with self.subTest(field=key):
                record = dict(entry, **{key: value})
                self.assertEqual(catalog.validate_registry([record]), [record])
        catalog.validate_registry([dict(entry, kind='app', ages='3-5')])

    def test_catalog_yaml_is_utf8_even_with_a_windows_default_encoding(self):
        import yaml
        record = dict(self.entry(), **self.metadata())
        original_open = Path.open

        def windows_open(path, *args, **kwargs):
            if path.suffix == '.yaml' and kwargs.get('encoding') in (None, 'locale'):
                kwargs['encoding'] = 'cp1252'
            return original_open(path, *args, **kwargs)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'hosting').mkdir()
            for name in ('catalog.yaml', 'beta-catalog.yaml'):
                (root / 'hosting' / name).write_text(
                    yaml.safe_dump([record], allow_unicode=True), encoding='utf-8')
            with patch.object(web, 'HERE', root), patch.object(Path, 'open', windows_open):
                self.assertEqual(web.default_registry(), [record])
                self.assertEqual(web.default_beta_registry(), [record])

    def test_invalid_metadata_is_rejected(self):
        bad_values = {
            'tagline': [None, 3, '', ' ', 'line\nbreak', 'x' * 161],
            'teaches': [None, [], '', 'counting\tletters', 'x' * 121],
            'ages': [None, 5, '5', '5–3', 'three to five', '3–5\n'],
            'web_url': [None, 'http://example.com', 'javascript:alert(1)',
                        'https://user:secret@example.com', '/play'],
            'kind': [None, True, 'games', 'APP', ''],
            'added': [None, datetime.date(2026, 11, 18), '2026-2-3',
                      '2026-02-30', '2026-11-18T00:00:00Z', 'today'],
        }
        for field, values in bad_values.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    catalog.validate_registry([dict(self.entry(), **{field: value})])

    def test_metadata_round_trips_stable_and_beta_without_altering_app_discovery(self):
        stable = [dict(self.entry(), **self.metadata())]
        beta = [dict(self.entry(), id='early-app', **dict(self.metadata(), kind='app'))]
        original = copy.deepcopy(stable)
        with tempfile.TemporaryDirectory() as temporary, patch.object(web, 'default_beta_registry', return_value=beta):
            output = web.build(Path(temporary) / 'site', registry=stable, manifest_urls={})
            self.assertEqual(json.loads((output / 'catalog').read_text()), original)
            self.assertEqual(json.loads((output / 'beta/catalog').read_text()), beta)
        self.assertEqual(stable, original)

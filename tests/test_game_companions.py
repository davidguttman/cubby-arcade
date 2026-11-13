import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from runtime import catalog, file_manifest, packages


class GameCompanionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.build = self.root / 'build'
        self.build.mkdir()
        (self.build / 'play.html').write_text('game')
        (self.build / 'cover.svg').write_text('<svg/>')
        self.stable = 'https://publisher.example/arcade/manifest.json'

    def document(self):
        return file_manifest.generate(self.build, 'demo', '1', 'play.html', 'cover.svg')

    def native(self, document):
        result = subprocess.run(['node', '-e',
            "const m=JSON.parse(process.argv[1]),u=process.argv[2]; console.log(JSON.stringify([require('./desktop/installer.cjs').validateRelease(m,'demo',u),require('./runtime/core/browser-store.js').validateRelease(m,'demo',u)]))",
            json.dumps(document), self.stable], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_optional_game_owned_companion_resolves_and_survives_all_host_inventories(self):
        document = self.document()
        document['companion'] = dict(url='../companion/', title='Demo for grown-ups', artwork='../companion/icon.png')
        resolved = catalog.validate_release(document, 'demo', manifest_url=self.stable)
        expected = dict(url='https://publisher.example/companion/', title='Demo for grown-ups', artwork='https://publisher.example/companion/icon.png')
        self.assertEqual(resolved['companion'], expected)
        self.assertEqual(document['companion']['url'], '../companion/')
        for native in self.native(document):
            self.assertEqual(native['companion'], expected)
        inventory = file_manifest.inventory(resolved)
        self.assertEqual(inventory['companion'], expected)
        release = self.root / 'games/demo/releases/1'
        release.mkdir(parents=True)
        (release / 'manifest.json').write_text(json.dumps(inventory))
        (release.parent.parent / 'current').symlink_to('releases/1')
        self.assertEqual(packages.library(self.root / 'games')[0]['companion'], expected)
        changed = copy.deepcopy(inventory)
        changed['companion']['url'] = 'https://publisher.example/new-companion/'
        self.assertNotEqual(catalog.comparable_inventory(inventory), catalog.comparable_inventory(changed))

    def test_generator_cli_declares_companion_without_changing_catalog(self):
        output = self.root / 'manifest.json'
        subprocess.run(['uv', 'run', 'python', 'runtime/file_manifest.py', str(self.build), '--id', 'demo',
                        '--version', '1', '--entrypoint', 'play.html', '--artwork', 'cover.svg',
                        '--companion', '../companion/', '--companion-title', 'Demo controls',
                        '--companion-artwork', '../companion/icon.png', '--output', str(output)], check=True)
        companion = json.loads(output.read_text())['companion']
        self.assertEqual(companion, dict(url='../companion/', title='Demo controls', artwork='../companion/icon.png'))

    def test_invalid_companions_are_rejected_consistently(self):
        invalid = [None, '', [], {}, {'url': 'javascript:alert(1)'}, {'url': 'http://example.com/'},
                   {'url': '//example.com/'}, {'url': 'https://u:p@example.com/'}, {'url': 'https://@example.com/'}, {'url': 'https://example.com/#secret'},
                   {'url': 'https:///missing'}, {'url': '?query'}, {'url': 'x%0ay'}, {'url': 'https://example.com/', 'title': ''},
                   {'url': 'https://example.com/', 'title': 3}, {'url': 'https://example.com/', 'artwork': 'data:image/png,x'}]
        for value in invalid:
            document = self.document()
            document['companion'] = value
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    catalog.validate_release(document, 'demo', manifest_url=self.stable)
                result = subprocess.run(['node', '-e',
                    "const m=JSON.parse(process.argv[1]),u=process.argv[2];for(const p of ['./desktop/installer.cjs','./runtime/core/browser-store.js']){try{require(p).validateRelease(m,'demo',u);process.exit(1)}catch{}}",
                    json.dumps(document), self.stable], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_absent_companion_is_backward_compatible(self):
        document = self.document()
        resolved = catalog.validate_release(document, 'demo', manifest_url=self.stable)
        self.assertNotIn('companion', resolved)
        self.assertNotIn('companion', file_manifest.inventory(resolved))
        for native in self.native(document):
            self.assertNotIn('companion', native)

    def test_companion_only_file_updates_are_immutable_and_can_add_and_remove(self):
        document = self.document()
        for name, item in document['files'].items():
            item['url'] = (self.build / name).as_uri()
        games = self.root / 'games'
        catalog.install_files(document, games, developer=True)
        document['companion'] = dict(url='https://publisher.example/phone/')
        with self.assertRaisesRegex(ValueError, 'Immutable release conflict'):
            catalog.install_files(document, games, developer=True)
        self.assertNotIn('companion', packages.library(games)[0])
        document['version'] = '2'
        catalog.install_files(document, games, developer=True)
        self.assertEqual(packages.library(games)[0]['companion'], document['companion'])
        document['version'] = '3'
        del document['companion']
        catalog.install_files(document, games, developer=True)
        self.assertNotIn('companion', packages.library(games)[0])


if __name__ == '__main__':
    unittest.main()

import hashlib
import importlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from runtime import catalog, packages

class FileManifestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.build = self.root / 'build'
        self.build.mkdir()
        (self.build / 'index.html').write_text('hello')
        (self.build / 'cover.svg').write_text('<svg/>')

    def generate(self, version='1'):
        module = importlib.import_module('runtime.file_manifest')
        return module.generate(self.build, 'demo', version, 'index.html', 'cover.svg', 'https://game.example/releases/' + version + '/')

    def test_generator_native_parity_and_standalone_cli(self):
        manifest = self.generate()
        self.assertEqual(manifest['files']['index.html']['sha256'], hashlib.sha256(b'hello').hexdigest())
        self.assertEqual(catalog.validate_release(manifest, 'demo'), manifest)
        subprocess.run(['node', '-e', "require('./desktop/installer.cjs').validateRelease(JSON.parse(process.argv[1]),'demo')", json.dumps(manifest)], check=True)
        output = self.root / 'manifest.json'
        subprocess.run(['uv', 'run', 'python', 'runtime/file_manifest.py', str(self.build), '--id', 'demo', '--version', '1', '--entrypoint', 'index.html', '--artwork', 'cover.svg', '--base-url', 'https://game.example/releases/1/', '--output', str(output)], check=True)
        self.assertEqual(json.loads(output.read_text()), manifest)

    def test_generator_rejects_symlinks_reserved_output_and_bounds(self):
        self.generate()
        (self.build / 'link').symlink_to(self.build / 'index.html')
        with self.assertRaises(ValueError): self.generate()
        (self.build / 'link').unlink()
        (self.build / 'manifest.json').write_text('{}')
        with self.assertRaises(ValueError): self.generate()

    def test_file_install_reuse_failure_and_immutable_version(self):
        manifest = self.generate()
        registry = {'id':'demo', 'title':'Demo', 'manifest_url':'https://game.example/manifest.json', 'artwork':'https://game.example/cover.svg'}
        requests = []
        def fetch(url, destination, limit, developer=False, expected_size=None, digest=None, **kwargs):
            requests.append(url)
            if url.endswith('/manifest.json'):
                Path(destination).write_text(json.dumps(manifest))
            else:
                data = (self.build / url.rsplit('/', 1)[-1]).read_bytes()
                if len(data) != expected_size or hashlib.sha256(data).hexdigest() != digest: raise ValueError('bad bytes')
                Path(destination).write_bytes(data)
        installed = self.root / 'games'
        with patch.object(catalog, 'download', side_effect=fetch):
            catalog.install_entry(registry, installed)
            first = (installed / 'demo/current').resolve()
            manifest = self.generate('2')
            requests.clear()
            catalog.install_entry(registry, installed, update=True)
            self.assertEqual(requests, [registry['manifest_url']])
            second = (installed / 'demo/current').resolve()
            self.assertNotEqual((first/'index.html').stat().st_ino, (second/'index.html').stat().st_ino)
            (self.build/'index.html').write_text('changed')
            manifest = self.generate('2')
            with self.assertRaises(ValueError): catalog.install_entry(registry, installed)
            self.assertEqual((second/'index.html').read_text(), 'hello')
            manifest = self.generate('3')
            manifest['files']['index.html']['sha256'] = '0'*64
            with self.assertRaises(ValueError): catalog.install_entry(registry, installed)
            self.assertEqual((installed/'demo/current').resolve(), second)
            self.assertEqual(packages.library(installed)[0]['version'], '2')

    def test_real_local_transport_empty_files_and_symlink_confinement(self):
        (self.build / 'empty.txt').write_bytes(b'')
        manifest = self.generate()
        for name, item in manifest['files'].items():
            item['url'] = (self.build / name).as_uri()
        stable = self.root / 'release.json'
        stable.write_text(json.dumps(manifest))
        entry = dict(id='demo', title='Demo', manifest_url=stable.as_uri(), artwork=(self.build/'cover.svg').as_uri())
        games = self.root / 'games'
        catalog.install_entry(entry, games, developer=True)
        self.assertEqual((games/'demo/current/empty.txt').read_bytes(), b'')
        outside = self.root / 'outside'
        outside.mkdir()
        (games/'intruder').symlink_to(outside, target_is_directory=True)
        manifest['id'] = 'intruder'
        stable.write_text(json.dumps(manifest))
        entry['id'] = 'intruder'
        with self.assertRaises(ValueError): catalog.install_entry(entry, games, developer=True)
        self.assertEqual(list(outside.iterdir()), [])

    def test_zip_migration_and_corrupt_reuse_downloads(self):
        import zipfile
        module = importlib.import_module('runtime.file_manifest')
        manifest = self.generate()
        archive = self.root/'legacy.zip'
        with zipfile.ZipFile(archive, 'w') as zipped:
            zipped.writestr('manifest.json', json.dumps(module.inventory(manifest)))
            for name in manifest['files']:
                zipped.write(self.build/name, name)
        games = self.root/'games'
        packages.install(archive, games)
        with patch.object(catalog, 'download', side_effect=AssertionError('unchanged payload fetched')):
            catalog.install_files(manifest, games)
        old_file = games/'demo/releases/1/index.html'
        old_file.unlink()
        outside = self.root/'private'
        outside.write_text('not game content')
        old_file.symlink_to(outside)
        manifest = self.generate('2')
        for name, item in manifest['files'].items():
            item['url'] = (self.build/name).as_uri()
        catalog.install_files(manifest, games, developer=True)
        self.assertEqual((games/'demo/current/index.html').read_text(), 'hello')
        self.assertEqual(outside.read_text(), 'not game content')

    def test_generator_bounds_and_output_not_payload(self):
        module = importlib.import_module('runtime.file_manifest')
        with patch.object(module, 'MAX_BYTES', 1):
            with self.assertRaises(ValueError): self.generate()
        with patch.object(module, 'MAX_MANIFEST', 10):
            with self.assertRaises(ValueError): self.generate()
        result = subprocess.run(['uv', 'run', 'python', 'runtime/file_manifest.py', str(self.build), '--id', 'demo', '--version', '1', '--entrypoint', 'index.html', '--artwork', 'cover.svg', '--base-url', 'https://game.example/releases/1/', '--output', str(self.build/'manifest.json')], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.build/'manifest.json').exists())
        with self.assertRaises(ValueError):
            catalog.Redirects(False, allow_redirects=False).redirect_request(None, None, 302, '', {}, 'https://game.example/elsewhere')

    def test_generator_rejects_paths_the_native_host_cannot_serve(self):
        for name in ['play.html ', 'play#1.html', 'play?1.html', 'play%231.html', 'play\t1.html', 'play\n1.html', 'play\x7f1.html']:
            with self.subTest(name=name):
                file = self.build / name
                file.write_text('game')
                try:
                    with self.assertRaises(ValueError): self.generate()
                finally:
                    file.unlink()
        (self.build / 'snow 雪.html').write_text('game')
        manifest = self.generate()
        self.assertIn('snow 雪.html', manifest['files'])
        self.assertTrue(manifest['files']['snow 雪.html']['url'].endswith('snow%20%E9%9B%AA.html'))

    def test_validation_rejects_bad_metadata(self):
        module = importlib.import_module('runtime.file_manifest')
        for name in ['../x', 'a//b', 'a\x00b', 'manifest.json', 'manifest.json/x']:
            document = self.generate()
            document['files'][name] = document['files']['index.html']
            with self.assertRaises(ValueError): module.validate(document, 'demo')
        document = self.generate()
        document['files']['index.html']['size'] = True
        with self.assertRaises(ValueError): catalog.validate_release(document, 'demo')
        document = self.generate()
        document['package'] = {}
        with self.assertRaises(ValueError): catalog.validate_release(document, 'demo')

    def test_relative_generator_and_resolution_use_manifest_not_catalog_origin(self):
        from runtime import file_manifest
        document = file_manifest.generate(self.build, 'demo', '1', 'index.html', 'cover.svg', '../releases/1/')
        self.assertEqual(document['files']['index.html']['url'], '../releases/1/index.html')
        stable = 'https://publisher.example/store/demo/manifest.json'
        resolved = catalog.validate_release(document, 'demo', manifest_url=stable)
        self.assertEqual(resolved['files']['index.html']['url'], 'https://publisher.example/store/releases/1/index.html')
        self.assertEqual(document['files']['index.html']['url'], '../releases/1/index.html')
        with self.assertRaises(ValueError): catalog.install_files(document, self.root/'games')

    def test_generator_defaults_domain_free_and_cli_accepts_relative_base(self):
        from runtime import file_manifest
        document = file_manifest.generate(self.build, 'demo', '1', 'index.html', 'cover.svg')
        self.assertEqual(document['files']['index.html']['url'], './index.html')
        for base in [None, '/store/demo/1/files/']:
            output = self.root/'manifest.json'
            command = ['uv', 'run', 'python', 'runtime/file_manifest.py', str(self.build), '--id', 'demo',
                       '--version', '1', '--entrypoint', 'index.html', '--artwork', 'cover.svg', '--output', str(output)]
            if base is not None: command += ['--base-url', base]
            subprocess.run(command, check=True)
            actual = json.loads(output.read_text())['files']['index.html']['url']
            self.assertEqual(actual, (base or './') + 'index.html')

    def test_relative_zip_package_resolves_without_changing_metadata(self):
        document = dict(schema_version=1, id='demo', version='1', runtime='web', entrypoint='index.html',
                        package=dict(url='../releases/demo.zip', size=123, sha256='0'*64))
        resolved = catalog.validate_release(document, 'demo', manifest_url='https://game.example/store/demo/manifest.json')
        self.assertEqual(resolved['package']['url'], 'https://game.example/store/releases/demo.zip')
        self.assertEqual(document['package']['url'], '../releases/demo.zip')
        with self.assertRaises(ValueError): catalog.validate_release(document, 'demo')

    def test_relative_query_colons_have_native_resolution_parity(self):
        stable = 'https://game.example/store/demo/manifest.json'
        query = '?date=2026-11-02T12:00:00Z&next=https://cdn.example/a'
        for schema in (1, 2):
            for prefix in ('', './', '../', '/'):
                with self.subTest(schema=schema, prefix=prefix):
                    if schema == 1:
                        document = dict(schema_version=1, id='demo', version='1', runtime='web', entrypoint='index.html',
                                        package=dict(url=prefix + 'demo.zip' + query, size=123, sha256='0'*64))
                    else:
                        document = self.generate()
                        document['files']['index.html']['url'] = prefix + 'index.html' + query
                    resolved = catalog.validate_release(document, 'demo', manifest_url=stable)
                    native = subprocess.run(['node', '-e',
                        "console.log(JSON.stringify(require('./desktop/installer.cjs').validateRelease(JSON.parse(process.argv[1]),'demo',process.argv[2])))",
                        json.dumps(document), stable], capture_output=True, text=True)
                    self.assertEqual(native.returncode, 0, native.stderr)
                    self.assertEqual(json.loads(native.stdout), resolved)

    def test_relative_fresh_install_and_update_preserve_saves_and_previous_release(self):
        from runtime import file_manifest
        manifest = file_manifest.generate(self.build, 'demo', '1', 'index.html', 'cover.svg', '1/files/')
        stable = 'https://publisher.example/store/demo/manifest.json'
        registry = dict(id='demo', title='Demo', manifest_url=stable, artwork='https://publisher.example/cover.svg')
        requests = []
        def fetch(url, destination, limit, developer=False, expected_size=None, digest=None, **kwargs):
            requests.append(url)
            if url == stable:
                Path(destination).write_text(json.dumps(manifest))
            else:
                self.assertIn(url, ['https://publisher.example/store/demo/1/files/index.html',
                                    'https://cdn.example/cover.svg',
                                    'https://publisher.example/store/demo/2/files/index.html'])
                content = (self.build/url.rsplit('/', 1)[-1]).read_bytes()
                self.assertEqual(len(content), expected_size)
                self.assertEqual(hashlib.sha256(content).hexdigest(), digest)
                Path(destination).write_bytes(content)
        manifest['files']['cover.svg']['url'] = 'https://cdn.example/cover.svg'
        games = self.root/'games'
        with patch.object(catalog, 'download', side_effect=fetch):
            catalog.install_entry(registry, games)
            save = games/'demo/save.json'
            save.write_text('keep')
            (self.build/'index.html').write_text('new')
            manifest = file_manifest.generate(self.build, 'demo', '2', 'index.html', 'cover.svg', '2/files/')
            catalog.install_entry(registry, games, update=True)
        self.assertEqual((games/'demo/current/index.html').read_text(), 'new')
        self.assertEqual((games/'demo/releases/1/index.html').read_text(), 'hello')
        self.assertEqual(save.read_text(), 'keep')

    def test_relative_url_safety_and_root_resolution(self):
        for value in ['//evil.example/a', '\\evil', 'x\\y', 'x\n/y', '', '?query', '#fragment',
                      'http://evil.example/a', 'javascript:alert(1)', 'https://u:p@a.example/x', 'https://@a.example/x',
                      'https://a.example/x#f', 'https:relative', 'https:///missing', 'bad%xx', 'x%0ay']:
            document = self.generate()
            document['files']['index.html']['url'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                catalog.validate_release(document, 'demo', manifest_url='https://publisher.example/store/manifest.json')
        document = self.generate()
        document['files']['index.html']['url'] = '/releases/1/index.html'
        resolved = catalog.validate_release(document, 'demo', manifest_url='https://publisher.example/store/manifest.json')
        self.assertEqual(resolved['files']['index.html']['url'], 'https://publisher.example/releases/1/index.html')

    def test_relative_developer_file_transport_is_explicit(self):
        document = self.generate()
        for name, item in document['files'].items(): item['url'] = 'build/' + name
        stable = self.root/'manifest.json'
        stable.write_text(json.dumps(document))
        registry = dict(id='demo', title='Demo', manifest_url=stable.as_uri(), artwork=(self.build/'cover.svg').as_uri())
        with self.assertRaises(ValueError): catalog.install_entry(registry, self.root/'games')
        catalog.install_entry(registry, self.root/'games', developer=True)
        self.assertEqual((self.root/'games/demo/current/index.html').read_text(), 'hello')

if __name__ == '__main__': unittest.main()

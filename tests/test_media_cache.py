import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from rocknix.server import State, make_server
from runtime import catalog

ROOT = Path(__file__).resolve().parents[1]


def descriptor(body=b'small', source=b'original', name='cover.jpg'):
    return dict(url='https://media.example/' + name, size=len(body),
                sha256=hashlib.sha256(body).hexdigest(), source_sha256=hashlib.sha256(source).hexdigest())


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = State(ROOT, self.temp.name)
        self.media = descriptor()
        self.offer = dict(id='demo', title='Demo', artwork='https://games.example/cover.png',
                          manifest_url='https://games.example/manifest.json', media={'thumbnail': self.media})
        self.state.catalog = [self.offer]

    def test_registry_bounds_and_validates_optional_variants(self):
        self.assertEqual(catalog.validate_registry([self.offer]), [self.offer])
        for media in [[], {'surprise': self.media}, {'thumbnail': dict(self.media, size=True)},
                      {'thumbnail': dict(self.media, size=1024 * 1024)},
                      {'thumbnail': dict(self.media, url='http://example/a.jpg')},
                      {'thumbnail': dict(self.media, sha256='bad')},
                      {'thumbnail': dict(self.media, source_sha256='bad')}]:
            with self.subTest(media=media), self.assertRaises(ValueError):
                catalog.validate_registry([dict(self.offer, media=media)])

    def install(self, artwork=b'original'):
        folder = self.state.games / 'demo/releases/1'
        folder.mkdir(parents=True)
        (folder / 'cover.png').write_bytes(artwork)
        (folder / 'index.html').write_bytes(b'game')
        manifest = dict(schema_version=1, id='demo', version='1', runtime='web', entrypoint='index.html', artwork='cover.png',
                        files={'cover.png': hashlib.sha256(artwork).hexdigest(), 'index.html': hashlib.sha256(b'game').hexdigest()})
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        (folder.parent.parent / 'current').symlink_to('releases/1')
        return folder

    def test_library_only_attaches_matching_derivatives_without_downloading(self):
        folder = self.install()
        before = {p.name: p.read_bytes() for p in folder.iterdir()}
        with patch.object(catalog, 'download', side_effect=AssertionError('library must not download')):
            game = self.state.library()[0]
        self.assertEqual(game['media']['thumbnail']['url'], '/media/' + self.media['sha256'])
        self.assertEqual(before, {p.name: p.read_bytes() for p in folder.iterdir()})
        self.offer['media']['thumbnail']['source_sha256'] = '0' * 64
        self.assertNotIn('media', self.state.library()[0])

    def test_cache_downloads_once_and_survives_offline_and_process_restart(self):
        def download(url, target, limit, **options):
            Path(target).write_bytes(b'small')
        with patch.object(catalog, 'download', side_effect=download) as fetch:
            path = self.state.media_file(self.media['sha256'])
            self.assertEqual(path.read_bytes(), b'small')
            self.assertEqual(self.state.media_file(self.media['sha256']), path)
            self.assertEqual(fetch.call_count, 1)
        restarted = State(ROOT, self.temp.name)
        restarted.catalog = [self.offer]
        with patch.object(catalog, 'download', side_effect=OSError('offline')):
            self.assertEqual(restarted.media_file(self.media['sha256']).read_bytes(), b'small')

    def test_cache_rejects_unoffered_and_corrupt_bytes(self):
        with self.assertRaises(ValueError):
            self.state.media_file('0' * 64)
        with patch.object(catalog, 'download', side_effect=lambda url, target, limit, **kw: Path(target).write_bytes(b'wrong')):
            with self.assertRaises(ValueError):
                self.state.media_file(self.media['sha256'])
        self.assertFalse(any((self.state.data / 'media').glob('*')))

    def test_stalled_download_does_not_block_another_digest(self):
        first = self.media
        second = descriptor(b'other')
        self.offer['media']['artwork'] = second
        started, release = threading.Event(), threading.Event()
        errors = []
        def download(url, target, limit, **options):
            if options['digest'] == first['sha256']:
                started.set()
                if not release.wait(2):
                    raise TimeoutError('test stuck')
                Path(target).write_bytes(b'small')
            else:
                Path(target).write_bytes(b'other')
        def background():
            try:
                self.state.media_file(first['sha256'])
            except Exception as error:
                errors.append(error)
        with patch.object(catalog, 'download', side_effect=download):
            thread = threading.Thread(target=background)
            thread.start()
            try:
                self.assertTrue(started.wait(1))
                active = set(self.state.media_temporaries)
                self.assertEqual(len(active), 1)
                orphan = self.state.data / 'media' / ('b' * 64 + '-1234abcd.tmp')
                with orphan.open('wb') as output:
                    output.truncate(65 * 1024 * 1024)
                self.assertEqual(self.state.media_file(second['sha256']).read_bytes(), b'other')
                self.assertEqual(self.state.media_file(second['sha256']).read_bytes(), b'other')
                self.assertFalse(orphan.exists())
                self.assertTrue(all(path.exists() for path in active))
            finally:
                release.set()
                thread.join(3)
        self.assertFalse(errors)

    def test_cache_rejects_symlink_directory_and_entries(self):
        folder = self.state.data / 'media'
        elsewhere = self.state.data / 'elsewhere'
        elsewhere.mkdir()
        folder.symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.state.media_file(self.media['sha256'])
        folder.unlink()
        folder.mkdir()
        victim = elsewhere / 'victim'
        victim.write_bytes(b'small')
        (folder / self.media['sha256']).symlink_to(victim)
        with self.assertRaises(ValueError):
            self.state.media_file(self.media['sha256'])
        self.assertEqual(victim.read_bytes(), b'small')

    def test_cache_serves_range_and_rejects_unknown_endpoint(self):
        server = make_server(self.state, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with patch.object(catalog, 'download', side_effect=lambda url, target, limit, **kw: Path(target).write_bytes(b'small')):
            connection = http.client.HTTPConnection(*server.server_address)
            connection.request('GET', '/media/' + self.media['sha256'], headers={'Range': 'bytes=1-3'})
            response = connection.getresponse()
            self.assertEqual(response.status, 206)
            self.assertEqual(response.getheader('Content-Type'), 'image/jpeg')
            self.assertEqual(response.getheader('Content-Range'), 'bytes 1-3/5')
            self.assertEqual(response.read(), b'mal')
            connection.close()
            connection = http.client.HTTPConnection(*server.server_address)
            connection.request('GET', '/media/' + '0' * 64)
            self.assertEqual(connection.getresponse().status, 404)
            connection.close()

    def test_failed_media_get_attempts_download_only_once(self):
        server = make_server(self.state, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with patch.object(catalog, 'download', side_effect=OSError('offline')) as download:
            connection = http.client.HTTPConnection(*server.server_address)
            connection.request('GET', '/media/' + self.media['sha256'])
            response = connection.getresponse()
            self.assertEqual(response.status, 404)
            response.read()
            connection.close()
            self.assertEqual(download.call_count, 1)

    def test_webm_derivative_has_video_mime_and_seekable_range(self):
        self.media = descriptor(b'webm-data', name='trailer.webm')
        self.offer['media'] = {'attract': self.media}
        server = make_server(self.state, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with patch.object(catalog, 'download', side_effect=lambda url, target, limit, **kw: Path(target).write_bytes(b'webm-data')):
            connection = http.client.HTTPConnection(*server.server_address)
            connection.request('GET', '/media/' + self.media['sha256'], headers={'Range': 'bytes=5-'})
            response = connection.getresponse()
            self.assertEqual(response.status, 206)
            self.assertEqual(response.getheader('Content-Type'), 'video/webm')
            self.assertEqual(response.getheader('Content-Range'), 'bytes 5-8/9')
            self.assertEqual(response.read(), b'data')
            connection.close()

    def test_orphan_temporary_bytes_count_toward_cache_budget(self):
        folder = self.state.data / 'media'
        folder.mkdir()
        orphan = folder / ('a' * 64 + '-1234abcd.tmp')
        with orphan.open('wb') as output:
            output.truncate(65 * 1024 * 1024)
        unknown = folder / 'do-not-delete.tmp'
        unknown.write_bytes(b'not a cache object')
        restarted = State(ROOT, self.temp.name)
        restarted.catalog = [self.offer]
        with patch.object(catalog, 'download', side_effect=lambda url, target, limit, **kw: Path(target).write_bytes(b'small')):
            self.assertEqual(restarted.media_file(self.media['sha256']).read_bytes(), b'small')
        self.assertFalse(orphan.exists())
        self.assertEqual(unknown.read_bytes(), b'not a cache object')


if __name__ == '__main__':
    unittest.main()

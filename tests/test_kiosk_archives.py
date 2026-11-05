import hashlib
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import http.server
import threading
import time
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from rocknix import apt_archives as archives


class ArchiveTests(unittest.TestCase):
    url = 'http://snapshot.debian.org/archive/debian/20261027T000000Z/pool/main/a/abc/abc_1.0_arm64.deb'

    def test_only_pinned_official_archive_mapping(self):
        self.assertEqual(archives.urls(self.url)[1], 'https://deb.debian.org/debian/pool/main/a/abc/abc_1.0_arm64.deb')
        security = self.url.replace('/debian/', '/debian-security/')
        self.assertEqual(archives.urls(security)[1], 'https://deb.debian.org/debian-security/pool/main/a/abc/abc_1.0_arm64.deb')
        for bad in [self.url.replace('snapshot.debian.org', 'evil.invalid'), self.url.replace('20261027', '20261028'), self.url.replace('/pool/main/', '/pool/../'), self.url.replace('abc_1.0', '%2e%2e/abc_1.0')]:
            with self.assertRaises(ValueError): archives.urls(bad)

    @contextmanager
    def http_fixture(self, bodies):
        requests = []
        class Packages(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                requests.append(self.path)
                body = bodies[self.path]
                self.send_response(503 if body is None else 200)
                self.end_headers()
                if body is not None: self.wfile.write(body)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Packages)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f'http://127.0.0.1:{server.server_port}', requests
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_fetch_fallback_hash_and_atomic_cache(self):
        content = b'actual package'
        item = archives.Archive(self.url, 'abc_1.0_arm64.deb', len(content), hashlib.sha256(content).hexdigest())
        with self.http_fixture({'/snapshot': None, '/mirror': content}) as (origin, calls):
            with tempfile.TemporaryDirectory() as directory, patch.object(archives, 'urls', return_value=[origin+'/snapshot', origin+'/mirror']):
                path = archives.fetch(item, Path(directory))
                self.assertEqual(path.read_bytes(), content)
                self.assertEqual(calls, ['/snapshot', '/mirror'])
                self.assertEqual(list(Path(directory).iterdir()), [path])
                with patch.object(archives.subprocess, 'Popen', side_effect=AssertionError('verified cache fetched')):
                    archives.fetch(item, Path(directory))

    def test_truncated_corrupt_and_oversized_never_publish(self):
        item = archives.Archive(self.url, 'abc_1.0_arm64.deb', 4, hashlib.sha256(b'good').hexdigest())
        for data in [b'bad', b'evil', b'good trailing']:
            with self.http_fixture({'/package': data}) as (origin, _calls):
                with tempfile.TemporaryDirectory() as directory, patch.object(archives, 'urls', return_value=[origin+'/package']):
                    with self.assertRaises(RuntimeError):
                        archives.fetch(item, Path(directory))
                    self.assertFalse(list(Path(directory).iterdir()))

    def test_plan_requires_metadata_sha256_not_uri_md5(self):
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            if argv[0] == 'apt-get':
                self.assertTrue(any(arg.startswith('Dir::Cache::archives=') for arg in argv))
                return subprocess.CompletedProcess(argv, 0, f"'{self.url}' abc_1.0_arm64.deb 4 MD5Sum:nottrusted\n", '')
            return subprocess.CompletedProcess(argv, 0, 'Package: abc\nVersion: 1.0\nArchitecture: arm64\nFilename: pool/main/a/abc/abc_1.0_arm64.deb\nSize: 4\nSHA256: '+hashlib.sha256(b'good').hexdigest()+'\n\n', '')
        result = archives.plan(['abc'], runner=run)
        self.assertEqual(result[0].sha256, hashlib.sha256(b'good').hexdigest())
        self.assertEqual(calls[1], ['apt-cache', 'show', 'abc:arm64=1.0'])
        with self.assertRaises(ValueError): archives.plan(['--allow-unauthenticated'], runner=run)

    def test_recipe_both_phases_use_no_download_helper(self):
        recipe = (Path(__file__).parents[1]/'rocknix/build-kiosk-rootfs.sh').read_text()
        self.assertEqual(recipe.count('python3 /tmp/cubby-apt-archives.py install '), 2)

    def test_missing_sha256_and_metadata_size_disagreement_fail_closed(self):
        def runner(argv, **kwargs):
            if argv[0] == 'apt-get':
                return subprocess.CompletedProcess(argv, 0, f"'{self.url}' abc_1.0_arm64.deb 4 MD5Sum:legacy\n", '')
            return subprocess.CompletedProcess(argv, 0, metadata, '')
        for metadata in ['Filename: pool/main/a/abc/abc_1.0_arm64.deb\nSize: 4\n',
                         'Filename: pool/main/a/abc/abc_1.0_arm64.deb\nSize: 5\nSHA256: '+hashlib.sha256(b'good').hexdigest()+'\n']:
            with self.assertRaises(ValueError): archives.plan(['abc'], runner=runner)

    def test_epoch_in_cache_name_but_not_pool_url(self):
        def runner(argv, **kwargs):
            if argv[0] == 'apt-get':
                return subprocess.CompletedProcess(argv, 0, f"'{self.url}' abc_4%3a1.0_arm64.deb 4 MD5Sum:legacy\n", '')
            self.assertEqual(argv[-1], 'abc:arm64=4:1.0')
            return subprocess.CompletedProcess(argv, 0, 'Filename: pool/main/a/abc/abc_1.0_arm64.deb\nSize: 4\nSHA256: '+hashlib.sha256(b'good').hexdigest()+'\n', '')
        planned = archives.plan(['abc'], runner=runner)
        self.assertEqual(planned[0].name, 'abc_4%3a1.0_arm64.deb')

    def test_uri_without_legacy_md5_still_requires_authenticated_sha256(self):
        def runner(argv, **kwargs):
            text = (f"'{self.url}' abc_1.0_arm64.deb 4 \n" if argv[0] == 'apt-get' else
                    'Filename: pool/main/a/abc/abc_1.0_arm64.deb\nSize: 4\nSHA256: '+hashlib.sha256(b'good').hexdigest()+'\n')
            return subprocess.CompletedProcess(argv, 0, text, '')
        self.assertEqual(archives.plan(['abc'], runner=runner)[0].sha256, hashlib.sha256(b'good').hexdigest())

    def test_install_never_lets_apt_download_after_verified_fetch(self):
        item = archives.Archive(self.url, 'abc_1.0_arm64.deb', 4, hashlib.sha256(b'good').hexdigest())
        with patch.object(archives, 'plan', return_value=[item]), patch.object(archives, 'fetch') as fetched, patch.object(archives.subprocess, 'run') as run:
            archives.install(['abc'])
            fetched.assert_called_once()
            self.assertIn('--no-download', run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs['timeout'], 600)

    def test_inflight_trickling_read_cannot_overrun_total_deadline(self):
        class Trickle(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', '100')
                self.end_headers()
                try:
                    for _ in range(100):
                        self.wfile.write(b'x'); self.wfile.flush()
                        time.sleep(.02)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Trickle)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        local_url = f'http://127.0.0.1:{server.server_port}/package'
        item = archives.Archive(self.url, 'abc_1.0_arm64.deb', 100, hashlib.sha256(b'x'*100).hexdigest())
        try:
            for threaded in (False, True):
                with self.subTest(threaded=threaded), tempfile.TemporaryDirectory() as directory, patch.object(archives, 'urls', return_value=[local_url]):
                    workers = []
                    popen = subprocess.Popen
                    def recording_popen(*args, **kwargs):
                        worker = popen(*args, **kwargs); workers.append(worker)
                        return worker
                    def download():
                        started = time.monotonic()
                        with self.assertRaises(TimeoutError):
                            archives.fetch(item, Path(directory), deadline=started+.15)
                        self.assertLess(time.monotonic()-started, .7)
                        self.assertFalse(list(Path(directory).iterdir()))
                    with patch.object(archives.subprocess, 'Popen', side_effect=recording_popen):
                        if threaded:
                            with ThreadPoolExecutor(max_workers=1) as pool:
                                pool.submit(download).result(timeout=2)
                        else:
                            download()
                    self.assertEqual(len(workers), 1)
                    self.assertIsNotNone(workers[0].poll())
                    self.assertTrue(workers[0].stdout.closed)
                    self.assertTrue(workers[0].stderr.closed)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_inflight_header_wait_obeys_deadline_without_trying_mirror(self):
        release = threading.Event()
        requests = []
        class Headers(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                requests.append(self.path)
                release.wait(2)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Headers)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f'http://127.0.0.1:{server.server_port}'
        item = archives.Archive(self.url, 'abc_1.0_arm64.deb', 4, hashlib.sha256(b'good').hexdigest())
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(archives, 'urls', return_value=[origin+'/snapshot', origin+'/mirror']):
                started = time.monotonic()
                with self.assertRaises(TimeoutError):
                    archives.fetch(item, Path(directory), deadline=started+.15)
                self.assertLess(time.monotonic()-started, .7)
                self.assertEqual(requests, ['/snapshot'])
                self.assertFalse(list(Path(directory).iterdir()))
        finally:
            release.set(); server.shutdown(); server.server_close(); thread.join()

    def test_expired_download_budget_does_not_open_network(self):
        item = archives.Archive(self.url, 'abc_1.0_arm64.deb', 4, hashlib.sha256(b'good').hexdigest())
        with tempfile.TemporaryDirectory() as directory, patch.object(archives.subprocess, 'Popen', side_effect=AssertionError('network opened')):
            with self.assertRaises(TimeoutError):
                archives.fetch(item, Path(directory), deadline=0)


if __name__ == '__main__': unittest.main()

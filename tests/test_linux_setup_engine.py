"""Linux setup: trusted upstream, our-only payload and packaged worker contract."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from rocknix import image
from rocknix.setup import engine


class Response(io.BytesIO):
    def __init__(self, content, final_url='https://release-assets.githubusercontent.com/asset', length=None):
        super().__init__(content)
        self.headers = {} if length is None else {'Content-Length': str(length)}
        self.final_url = final_url

    def geturl(self):
        return self.final_url


class DownloadTests(unittest.TestCase):
    def test_official_pin_and_cache_are_verified(self):
        content = b'official pinned image'
        expected = hashlib.sha256(content).hexdigest()
        events = []
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(image, 'ROCKNIX_SHA256', expected), mock.patch.object(engine, 'urlopen', return_value=Response(content)) as request:
            result = engine.fetch_rocknix(Path(folder), events.append)
            self.assertEqual(result.read_bytes(), content)
            self.assertEqual(request.call_args.args[0].full_url, 'https://github.com/ROCKNIX/distribution/releases/download/20261101/ROCKNIX-RK3566.aarch64-20261101-Generic.img.gz')
            request.reset_mock()
            self.assertEqual(engine.fetch_rocknix(Path(folder)), result)
            request.assert_not_called()
            self.assertTrue(events)

    def test_bad_cache_redownloads_and_interrupted_download_is_not_cached(self):
        content = b'correct image'
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(image, 'ROCKNIX_SHA256', hashlib.sha256(content).hexdigest()):
            cache = Path(folder)
            target = cache / engine.ROCKNIX_FILENAME
            target.write_bytes(b'bad cache')
            with mock.patch.object(engine, 'urlopen', return_value=Response(b'wrong image')):
                with self.assertRaisesRegex(ValueError, 'checksum'):
                    engine.fetch_rocknix(cache)
            self.assertFalse(target.exists())
            self.assertFalse(list(cache.glob('*.part')))
            with mock.patch.object(engine, 'urlopen', return_value=Response(content)):
                self.assertEqual(engine.fetch_rocknix(cache).read_bytes(), content)

    def test_bounds_truncation_and_transport_failure_clean_temporary_files(self):
        for response in (Response(b'abc', length=20), Response(b'123456', length=6), Response(b'123456'), Response(b'abc', final_url='http://insecure.invalid/image')):
            with self.subTest(response=response), tempfile.TemporaryDirectory() as folder, mock.patch.object(engine, 'MAX_ROCKNIX_BYTES', 5), mock.patch.object(engine, 'urlopen', return_value=response):
                with self.assertRaises(ValueError):
                    engine.fetch_rocknix(Path(folder))
                self.assertEqual(list(Path(folder).iterdir()), [])
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(engine, 'urlopen', side_effect=TimeoutError('disconnected')):
            with self.assertRaises(TimeoutError):
                engine.fetch_rocknix(Path(folder))
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_cache_symlink_is_rejected_without_touching_target(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            other = cache / 'untouched'
            other.write_bytes(b'important')
            (cache / engine.ROCKNIX_FILENAME).symlink_to(other)
            with self.assertRaises(ValueError):
                engine.fetch_rocknix(cache)
            self.assertEqual(other.read_bytes(), b'important')


class PayloadTests(unittest.TestCase):
    def make(self, folder):
        root = folder / 'source'
        for name in ('runtime', 'rocknix/device', 'hosting'):
            (root / name).mkdir(parents=True)
        (root / 'runtime/server.py').write_text('runtime')
        (root / 'rocknix/session.sh').write_text('session')
        launch = root / 'rocknix/device/launch.sh'
        launch.write_text('#!/bin/sh\n')
        launch.chmod(0o755)
        (root / 'hosting/catalog.yaml').write_text('catalog')
        (root / 'rocknix/__pycache__').mkdir()
        (root / 'rocknix/__pycache__/junk.pyc').write_text('not shipped')
        (root / '.cache').mkdir()
        (root / '.cache/ROCKNIX.img').write_text('not ours')
        rootfs = folder / 'rootfs.tar.xz'
        rootfs.write_bytes(b'rootfs')
        with mock.patch.object(image, 'ROOTFS_SHA256', hashlib.sha256(b'rootfs').hexdigest()):
            payload = engine.make_payload(rootfs, folder / 'payload', root)
            engine.validate_payload(payload)
        return payload, root

    def test_payload_is_our_only_self_contained_and_preserves_executable(self):
        with tempfile.TemporaryDirectory() as folder:
            payload, root = self.make(Path(folder))
            files = [p.relative_to(payload).as_posix() for p in payload.rglob('*') if p.is_file()]
            self.assertIn('app/runtime/server.py', files)
            self.assertIn('rootfs.tar.xz', files)
            self.assertFalse(any('.cache' in name or '.pyc' in name or 'ROCKNIX' in name for name in files))
            self.assertEqual((payload / 'app/rocknix/device/launch.sh').stat().st_mode & 0o777, 0o755)
            self.assertEqual(json.loads((payload / 'payload.json').read_text())['schema_version'], 1)
            self.assertEqual(image.source_provenance(root)['source_commit'], None)

    def test_tampering_unlisted_files_modes_and_symlinks_rejected(self):
        for change in ('contents', 'extra', 'mode', 'symlink', 'traversal'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as folder:
                payload, _ = self.make(Path(folder))
                target = payload / 'app/runtime/server.py'
                if change == 'contents':
                    target.write_text('tampered')
                elif change == 'extra':
                    (payload / 'combined.img').write_text('not ours')
                elif change == 'mode':
                    target.chmod(0o777)
                elif change == 'symlink':
                    target.unlink()
                    target.symlink_to('/etc/passwd')
                else:
                    manifest = json.loads((payload / 'payload.json').read_text())
                    manifest['files']['../escape'] = next(iter(manifest['files'].values()))
                    (payload / 'payload.json').write_text(json.dumps(manifest))
                with mock.patch.object(image, 'ROOTFS_SHA256', hashlib.sha256(b'rootfs').hexdigest()), self.assertRaises(ValueError):
                    engine.validate_payload(payload)

    def test_packaged_build_metadata_does_not_require_git(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            info = {'source_commit': 'abc123' * 6 + 'abcd', 'source_dirty': False}
            with mock.patch.object(image.subprocess, 'run', side_effect=FileNotFoundError):
                self.assertEqual(image.source_provenance(root, info), info)
                self.assertEqual(image.source_provenance(root), {'source_commit': None, 'source_dirty': None})

    def test_malformed_source_provenance_is_rejected(self):
        for field, value in [('source_commit', 123), ('source_commit', 'abc123'),
                             ('source_commit', 'g' * 40), ('source_commit', ''),
                             ('source_dirty', 1), ('source_dirty', 'false'),
                             ('source_dirty', []), ('source_dirty', {})]:
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as folder:
                payload, _ = self.make(Path(folder))
                manifest_path = payload / 'payload.json'
                manifest = json.loads(manifest_path.read_text())
                manifest['source'][field] = value
                manifest_path.write_text(json.dumps(manifest))
                with mock.patch.object(image, 'ROOTFS_SHA256', hashlib.sha256(b'rootfs').hexdigest()), self.assertRaisesRegex(ValueError, 'provenance'):
                    engine.validate_payload(payload)

    def test_source_provenance_accepts_full_git_hashes_and_nullable_fields(self):
        for commit in (None, 'abcdef0123' * 4, 'ABCDEF01' * 8):
            for dirty in (None, False, True):
                info = {'source_commit': commit, 'source_dirty': dirty}
                self.assertEqual(image.source_provenance(Path('/not-a-checkout'), info), info)

    def test_compose_rejects_dangling_output_and_checksum_symlinks_before_download(self):
        for checksum in (False, True):
            with self.subTest(checksum=checksum), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                payload, _ = self.make(root)
                output = root / 'output.img.gz'
                occupied = output.with_name(output.name + '.sha256') if checksum else output
                target = root / 'must-not-create'
                occupied.symlink_to(target)
                with mock.patch.object(image, 'ROOTFS_SHA256', hashlib.sha256(b'rootfs').hexdigest()), mock.patch.object(engine, 'fetch_rocknix', side_effect=AssertionError('must reject before download')), self.assertRaisesRegex(ValueError, 'existing composed image'):
                    engine.compose(payload, root / 'cache', output)
                self.assertTrue(occupied.is_symlink())
                self.assertFalse(target.exists())

    def test_worker_uses_payload_source_and_verified_rootfs(self):
        with tempfile.TemporaryDirectory() as folder:
            payload, _ = self.make(Path(folder))
            upstream = Path(folder) / 'official.img.gz'
            output = Path(folder) / 'output.img.gz'
            with mock.patch.object(image, 'ROOTFS_SHA256', hashlib.sha256(b'rootfs').hexdigest()), mock.patch.object(image, 'build', return_value=output) as build:
                self.assertEqual(engine.compose_image(upstream, payload, output, 4), output)
                self.assertEqual(build.call_args.kwargs['source_root'], payload / 'app')
                self.assertIn('source_info', build.call_args.kwargs)

    def test_compose_invokes_explicit_worker_inside_user_namespace(self):
        with tempfile.TemporaryDirectory() as folder:
            payload, _ = self.make(Path(folder))
            output = Path(folder) / 'output.img.gz'
            upstream = Path(folder) / 'official.img.gz'
            def create_output(command, progress):
                output.write_bytes(b'composed')
                output.with_name(output.name + '.sha256').write_text(hashlib.sha256(b'composed').hexdigest() + '  ' + output.name + '\n')
            with mock.patch.object(image, 'ROOTFS_SHA256', hashlib.sha256(b'rootfs').hexdigest()), mock.patch.object(engine, 'fetch_rocknix', return_value=upstream), mock.patch.object(engine.os, 'geteuid', return_value=1000), mock.patch.object(engine, '_run_worker') as run:
                run.side_effect = create_output
                engine.compose(payload, Path(folder) / 'cache', output, worker_command=['/app/CubbySetup', '--setup-engine'])
                command = run.call_args.args[0]
                self.assertEqual(command[:5], ['unshare', '--map-auto', '--map-root-user', '/app/CubbySetup', '--setup-engine'])
                self.assertIn('worker', command)
                self.assertIn(str(payload.resolve()), command)

    def test_successful_worker_without_output_is_not_success(self):
        with tempfile.TemporaryDirectory() as folder:
            payload, _ = self.make(Path(folder))
            with mock.patch.object(image, 'ROOTFS_SHA256', hashlib.sha256(b'rootfs').hexdigest()), mock.patch.object(engine, 'fetch_rocknix', return_value=Path(folder) / 'upstream'), mock.patch.object(engine.os, 'geteuid', return_value=1000), mock.patch.object(engine, '_run_worker'):
                with self.assertRaisesRegex(ValueError, 'verified output'):
                    engine.compose(payload, Path(folder) / 'cache', Path(folder) / 'output.img.gz')


if __name__ == '__main__':
    unittest.main()

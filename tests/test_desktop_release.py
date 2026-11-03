import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import tarfile
import unittest

from desktop.release import publish, GitHubError


class FakeGitHub:
    def __init__(self, fail_upload=False, existing=None, lookup_error=None):
        self.release = existing
        self.fail_upload = fail_upload
        self.lookup_error = lookup_error
        self.list_error = None
        self.calls = []

    def __call__(self, args, document=None):
        self.calls.append((args, document))
        if args[0] == 'release':
            if self.fail_upload:
                raise GitHubError('Upload failed')
            file = Path(args[3])
            self.release['assets'].append(dict(name=file.name, size=file.stat().st_size,
                digest='sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()))
            return None
        endpoint = args[-1]
        if '/git/ref/tags/' in endpoint:
            return {'ref': 'refs/tags/v1.2.3'}
        if '/releases/tags/' in endpoint:
            if self.lookup_error:
                raise GitHubError('Lookup failed', self.lookup_error)
            # GitHub's by-tag endpoint does not discover drafts.
            if self.release is None or self.release['draft']:
                raise GitHubError('Not found', 404)
            return self.release
        if endpoint.endswith('/releases?per_page=100'):
            self.assert_paginated(args)
            if self.list_error:
                raise GitHubError('List failed', self.list_error)
            return [[{'id': 3, 'tag_name': 'v0.0.1', 'draft': True}],
                    [self.release] if self.release else []]
        if args[1:3] == ['--method', 'POST']:
            self.release = dict(id=7, tag_name=document['tag_name'], draft=True,
                                prerelease=False, assets=[])
            return self.release
        if args[1:3] == ['--method', 'PATCH']:
            self.release['draft'] = document['draft']
            return self.release
        if self.release and endpoint.endswith('/releases/' + str(self.release['id'])):
            return self.release
        raise AssertionError(args)

    @staticmethod
    def assert_paginated(args):
        if '--paginate' not in args or '--slurp' not in args:
            raise AssertionError('Draft discovery must inspect every release page')


class DesktopReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / 'package.json'
        self.package.write_text(json.dumps({'version': '1.2.3'}))
        for name in ('CubbyArcade-win32-x64.zip', 'CubbyArcade-linux-x64.tar.gz'):
            file = self.root / name
            file.write_bytes(name.encode())
            (self.root / (name + '.sha256')).write_text(
                hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + name + '\n')

    def run_publish(self, gh, tag='v1.2.3'):
        return publish(tag, 'owner/repo', self.root, self.package, gh)

    def test_complete_assets_are_verified_before_release_becomes_latest(self):
        gh = FakeGitHub()
        self.run_publish(gh)
        self.assertFalse(gh.release['draft'])
        self.assertEqual(len(gh.release['assets']), 4)
        self.assertEqual(gh.calls[-1][1], {'draft': False, 'make_latest': 'true'})

    def test_missing_bad_checksums_or_wrong_tag_never_contact_github(self):
        for change in ('missing', 'checksum', 'version'):
            with self.subTest(change=change):
                gh = FakeGitHub()
                file = self.root / 'CubbyArcade-win32-x64.zip'
                original = file.read_bytes()
                if change == 'missing':
                    file.unlink()
                elif change == 'checksum':
                    file.write_bytes(b'corrupt')
                with self.assertRaises(ValueError):
                    self.run_publish(gh, 'v9.0.0' if change == 'version' else 'v1.2.3')
                self.assertEqual(gh.calls, [])
                file.write_bytes(original)

    def test_failed_upload_leaves_draft_and_api_errors_are_not_missing_releases(self):
        gh = FakeGitHub(fail_upload=True)
        with self.assertRaises(GitHubError):
            self.run_publish(gh)
        self.assertTrue(gh.release['draft'])
        self.assertFalse(any(call[0][1:3] == ['--method', 'PATCH'] for call in gh.calls))
        gh = FakeGitHub(lookup_error=403)
        with self.assertRaises(GitHubError):
            self.run_publish(gh)
        self.assertIsNone(gh.release)
        gh = FakeGitHub()
        gh.list_error = 403
        with self.assertRaises(GitHubError):
            self.run_publish(gh)
        self.assertIsNone(gh.release)

    def test_matching_draft_retry_is_discovered_by_listing_without_duplicate_creation(self):
        gh = FakeGitHub(fail_upload=True)
        with self.assertRaises(GitHubError):
            self.run_publish(gh)
        owned_draft = gh.release
        gh.fail_upload = False
        gh(['release', 'upload', 'v1.2.3', str(self.root / 'CubbyArcade-win32-x64.zip')])
        gh.calls.clear()
        self.run_publish(gh)
        self.assertIs(gh.release, owned_draft)
        self.assertFalse(gh.release['draft'])
        self.assertEqual(len(gh.release['assets']), 4)
        self.assertEqual(sum(args[0] == 'release' for args, _ in gh.calls), 3)
        self.assertFalse(any(args[1:3] == ['--method', 'POST'] for args, _ in gh.calls))
        self.assertTrue(any('/releases?per_page=100' in args[-1] for args, _ in gh.calls))

    def test_published_release_is_immutable_and_matching_rerun_is_read_only(self):
        gh = FakeGitHub()
        self.run_publish(gh)
        gh.calls.clear()
        self.run_publish(gh)
        self.assertTrue(all(call[0][0] == 'api' for call in gh.calls))
        gh.release['assets'][0]['digest'] = 'sha256:' + '0' * 64
        gh.calls.clear()
        with self.assertRaises(ValueError):
            self.run_publish(gh)
        self.assertFalse(any(call[0][0] == 'release' for call in gh.calls))

    def test_incomplete_or_mismatching_remote_upload_cannot_become_latest(self):
        class LostUpload(FakeGitHub):
            def __call__(self, args, document=None):
                if args[0] == 'release':
                    self.calls.append((args, document))
                    return None
                return super().__call__(args, document)
        gh = LostUpload()
        with self.assertRaises(ValueError):
            self.run_publish(gh)
        self.assertTrue(gh.release['draft'])
        self.assertFalse(any(call[0][1:3] == ['--method', 'PATCH'] for call in gh.calls))

    def test_linux_archive_preserves_executable_and_symlink_with_stable_names(self):
        if sys.platform == 'win32':
            self.skipTest('Linux distribution metadata')
        folder = self.root / 'CubbyArcade-linux-x64'
        folder.mkdir()
        executable = folder / 'CubbyArcade'
        executable.write_bytes(b'executable')
        executable.chmod(0o755)
        (folder / 'runtime-link').symlink_to('CubbyArcade')
        script = Path(__file__).resolve().parents[1] / 'desktop/archive.py'
        subprocess.run([sys.executable, str(script), str(folder), 'tar.gz'], check=True, capture_output=True)
        archive = self.root / 'CubbyArcade-linux-x64.tar.gz'
        with tarfile.open(archive) as stream:
            self.assertEqual(stream.getmember(folder.name + '/CubbyArcade').mode & 0o777, 0o755)
            link = stream.getmember(folder.name + '/runtime-link')
            self.assertTrue(link.issym())
            self.assertEqual(link.linkname, 'CubbyArcade')
        checksum = self.root / (archive.name + '.sha256')
        self.assertEqual(checksum.read_text(), hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')

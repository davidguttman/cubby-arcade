import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from rocknix import update_release, update_publish


class FakeGitHub:
    def __init__(self):
        self.releases = {}
        self.uploads = []
        self.fail_feed_once = False
    def assets(self, tag):
        return self.releases.get(tag)
    def create(self, tag, target):
        if tag in self.releases:
            raise ValueError('already exists')
        self.releases[tag] = {}
    def upload(self, tag, files, clobber=False):
        self.uploads.append((tag, [p.name for p in files], clobber))
        for p in files:
            if self.fail_feed_once and tag == update_publish.CHANNEL and p.name.endswith('.sig'):
                self.fail_feed_once = False
                raise RuntimeError('disconnected after manifest upload')
            if p.name in self.releases[tag] and not clobber:
                raise ValueError('asset exists')
            self.releases[tag][p.name] = p.read_bytes()
    def download(self, tag, name):
        return self.releases[tag][name]


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root/'source'
        for name in ['runtime/index.html','rocknix/server.py','rocknix/session.sh']:
            p = self.source/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('fixture')
        self.key = self.root/'private.pem'; self.public = self.root/'public.pem'
        subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(self.key)],check=True,capture_output=True)
        subprocess.run(['openssl','pkey','-in',str(self.key),'-pubout','-out',str(self.public)],check=True,capture_output=True)
        self.gh = FakeGitHub()
    def release(self, sequence=1, version='0.1.0'):
        output = self.root/str(sequence)
        update_release.build(self.source, output, version, sequence,
                             update_publish.archive_url(version), self.key)
        return output
    def publish(self, output):
        return update_publish.publish(output, self.public, 'a'*40, self.gh)
    def test_publishes_verified_immutable_before_channel(self):
        output = self.release(); self.publish(output)
        self.assertEqual(self.gh.download(update_publish.CHANNEL,'manifest.json'),(output/'manifest.json').read_bytes())
        self.assertEqual(self.gh.uploads[0][0], 'cubby-device-v0.1.0')
        self.assertEqual(self.gh.uploads[-1][0], update_publish.CHANNEL)
    def test_retry_same_bytes_is_idempotent(self):
        output = self.release(); self.publish(output); uploads = len(self.gh.uploads)
        self.publish(output)
        self.assertEqual(len(self.gh.uploads), uploads)
    def test_replay_cannot_replace_newer_feed(self):
        old = self.release(); self.publish(old)
        new = self.release(2,'0.1.1'); self.publish(new)
        before = list(self.gh.uploads)
        with self.assertRaises(ValueError): self.publish(old)
        self.assertEqual(self.gh.uploads,before)
    def test_immutable_conflict_fails_before_feed_change(self):
        output = self.release(); self.gh.releases['cubby-device-v0.1.0']={'app.zip':b'conflict'}
        with self.assertRaises(ValueError): self.publish(output)
        self.assertNotIn(update_publish.CHANNEL,self.gh.releases)
    def test_retry_completes_partial_immutable_release_without_overwriting(self):
        output=self.release()
        self.gh.releases['cubby-device-v0.1.0']={'app.zip':(output/'app.zip').read_bytes()}
        self.publish(output)
        first=self.gh.uploads[0]
        self.assertNotIn('app.zip',first[1])
        self.assertFalse(first[2])

    def test_tampered_archive_never_uploaded(self):
        output = self.release(); (output/'app.zip').write_bytes(b'changed')
        with self.assertRaises(ValueError): self.publish(output)
        self.assertEqual(self.gh.uploads,[])
    def test_wrong_key_never_uploaded(self):
        output = self.release(); (output/'manifest.json.sig').write_bytes(b'x'*64)
        with self.assertRaises(ValueError): self.publish(output)
        self.assertEqual(self.gh.uploads,[])
    def test_signed_url_must_be_exact_immutable_asset(self):
        output=self.root/'wrong'
        update_release.build(self.source,output,'0.1.0',1,'https://example.com/app.zip',self.key)
        with self.assertRaises(ValueError):self.publish(output)
        self.assertEqual(self.gh.uploads,[])
    def test_failed_feed_pair_restores_previous_verified_bytes(self):
        old = self.release(); self.publish(old)
        new = self.release(2,'0.1.1'); self.gh.fail_feed_once=True
        with self.assertRaises(RuntimeError): self.publish(new)
        for name in ['manifest.json','manifest.json.sig']:
            self.assertEqual(self.gh.download(update_publish.CHANNEL,name),(old/name).read_bytes())
    def test_existing_unsigned_feed_fails_closed(self):
        output=self.release(); self.gh.releases[update_publish.CHANNEL]={'manifest.json':b'{}'}
        with self.assertRaises(ValueError):self.publish(output)
        self.assertEqual(self.gh.uploads,[])
    def test_downloaded_immutable_corruption_blocks_channel(self):
        output=self.release()
        original=self.gh.download
        def corrupt(tag,name):
            body=original(tag,name)
            return body+b'x' if name=='app.zip' else body
        self.gh.download=corrupt
        with self.assertRaises(ValueError):self.publish(output)
        self.assertNotIn(update_publish.CHANNEL,self.gh.releases)

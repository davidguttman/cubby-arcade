import json
from pathlib import Path
import tempfile
import unittest
from desktop.release import GitHubError
from release_automation import sequence, plan

class ReleasePlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.package=Path(self.tmp.name)/'package.json'; self.package.write_text('{"version":"0.11.1"}')
    def fake(self, tag=None, release=None):
        def gh(args, document=None):
            endpoint=args[-1]
            if '/git/ref/' in endpoint:
                if tag is None: raise GitHubError('missing',404)
                return {'object':{'type':'commit','sha':tag}}
            if '/releases/tags/' in endpoint:
                if release is None: raise GitHubError('missing',404)
                return release
            if '/releases?' in endpoint:return [[]]
            raise AssertionError(args)
        return gh
    def test_single_version_and_monotonic_sequence(self):
        self.assertGreater(sequence('0.11.1'),4)
        self.assertLess(sequence('0.11.9999'),sequence('0.12.0'))
        for value in ['v0.1.0','1.2','01.2.3','1.2.3-beta','1.10000.0']:
            with self.assertRaises(ValueError):sequence(value)
    def test_main_new_version_releases_but_unchanged_version_skips(self):
        result=plan(self.package,'a'*40,'refs/heads/main',self.fake())
        self.assertEqual(result['tag'],'v0.11.1');self.assertEqual(result['release'],'true')
        self.assertEqual(plan(self.package,'b'*40,'refs/heads/main',self.fake('a'*40,{'draft':False}))['release'],'false')
    def test_tag_source_mismatch_and_other_branches_fail_closed(self):
        with self.assertRaises(ValueError):plan(self.package,'b'*40,'refs/tags/v0.11.1',self.fake('a'*40))
        self.assertEqual(plan(self.package,'a'*40,'refs/heads/windows-desktop',self.fake())['release'],'false')
    def test_same_commit_retry_is_allowed_and_draft_conflict_rejected(self):
        self.assertEqual(plan(self.package,'a'*40,'refs/heads/main',self.fake('a'*40,{'draft':False}))['release'],'true')
        with self.assertRaises(ValueError):plan(self.package,'b'*40,'refs/heads/main',self.fake('a'*40,{'draft':True}))

from unittest import mock
import hashlib
import subprocess
from tests.test_update_publish import FakeGitHub as FeedGitHub
from tests.test_desktop_release import FakeGitHub as ReleaseGitHub
from release_automation import prepare_device, verify_device, advance_feed, publish_all
from rocknix import update_release, update_publish

class UnifiedPublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.source=self.root/'source';self.output=self.root/'output'
        for name in ['runtime/index.html','rocknix/server.py','rocknix/session.sh']:
            p=self.source/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('fixture')
        (self.source/'package.json').write_text('{"version":"0.11.1"}')
        for name in update_release.DEVICE_REQUIRED:
            p=self.source/'rocknix/device'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('#!/bin/sh\n');p.chmod(0o755)
        self.private=self.root/'private.pem';self.public=self.source/'rocknix/device/release-key.pem'
        subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(self.private)],check=True,capture_output=True)
        subprocess.run(['openssl','pkey','-in',str(self.private),'-pubout','-out',str(self.public)],check=True,capture_output=True)
        prepare_device(self.source,self.output,self.private)
        for name in ['CubbyArcade-win32-x64.zip','CubbyArcade-linux-x64.tar.gz']:
            p=self.output/name;p.write_bytes(name.encode())
            (self.output/(name+'.sha256')).write_text(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+name+'\n')
    def feed(self):
        gh=FeedGitHub();gh.releases['v0.11.1']={n:(self.output/n).read_bytes() for n in ('app.zip','manifest.json','manifest.json.sig','platform.zip','update.json','update.json.sig')}
        return gh
    def test_signed_artifact_uses_package_version_unified_url_and_legacy_sequence_upgrade(self):
        manifest=verify_device(self.output,self.public,'0.11.1')
        self.assertEqual(manifest['sequence'],110002)
        self.assertIn('/v0.11.1/platform.zip',manifest['archive']['url'])
        self.assertIn('/v0.11.1/app.zip',json.loads((self.output/'manifest.json').read_bytes())['archive']['url'])
        gh=self.feed();old=self.root/'old'
        update_release.build(self.source,old,'0.2.0',4,update_publish.archive_url('0.2.0'),self.private)
        gh.releases[update_publish.CHANNEL]={name:(old/name).read_bytes() for name in update_publish.PAIR}
        advance_feed(self.output,self.public,'a'*40,gh)
        self.assertEqual(json.loads(gh.download(update_publish.CHANNEL,'manifest.json'))['version'],'0.11.1')
        uploads=len(gh.uploads);advance_feed(self.output,self.public,'a'*40,gh)
        self.assertEqual(uploads,len(gh.uploads))
    def test_device_archive_carries_a_signed_version_stamp(self):
        import zipfile
        manifest=verify_device(self.output,self.public,'0.11.1')
        body=zipfile.ZipFile(self.output/'app.zip').read('runtime/version.json')
        self.assertEqual(json.loads(body),{'version':'0.11.1'})
        self.assertEqual(manifest['files']['runtime/version.json']['sha256'],hashlib.sha256(body).hexdigest())
    def test_absent_or_corrupt_unified_artifacts_never_advance_feed(self):
        for change in ['missing','corrupt','signature']:
            gh=self.feed()
            if change=='missing':del gh.releases['v0.11.1']
            elif change=='corrupt':gh.releases['v0.11.1']['app.zip']=b'wrong'
            else:gh.releases['v0.11.1']['manifest.json.sig']=b'x'*64
            with self.subTest(change=change),self.assertRaises(ValueError):advance_feed(self.output,self.public,'a'*40,gh)
            self.assertEqual(gh.uploads,[])
    def test_feed_write_failure_restores_verified_previous(self):
        gh=self.feed();old=self.root/'old'
        update_release.build(self.source,old,'0.2.0',4,update_publish.archive_url('0.2.0'),self.private)
        previous={n:(old/n).read_bytes() for n in update_publish.PAIR}
        gh.releases[update_publish.CHANNEL]=previous.copy();gh.fail_feed_once=True
        with self.assertRaises(RuntimeError):advance_feed(self.output,self.public,'a'*40,gh)
        self.assertEqual(gh.releases[update_publish.CHANNEL],previous)
    def test_complete_shared_release_published_before_feed(self):
        gh=ReleaseGitHub()
        # Fake existing immutable tag resolution.
        def api(args,document=None):
            if '/git/ref/' in args[-1]:return {'object':{'type':'commit','sha':'a'*40}}
            return gh(args,document)
        def feed(*args):
            self.assertFalse(gh.release['draft'])
            self.assertEqual(len(gh.release['assets']),10)
        with mock.patch('release_automation.advance_feed',side_effect=feed) as call:
            publish_all(self.source,self.output,'a'*40,api)
            call.assert_called_once()
    def test_failed_upload_or_signature_never_advances_feed(self):
        gh=ReleaseGitHub(fail_upload=True)
        def api(args,document=None):
            if '/git/ref/' in args[-1]:return {'object':{'type':'commit','sha':'a'*40}}
            return gh(args,document)
        with mock.patch('release_automation.advance_feed') as feed:
            with self.assertRaises(GitHubError):publish_all(self.source,self.output,'a'*40,api)
            feed.assert_not_called()
        (self.output/'manifest.json.sig').write_bytes(b'x'*64)
        gh.calls.clear()
        with mock.patch('release_automation.advance_feed') as feed:
            with self.assertRaises(ValueError):publish_all(self.source,self.output,'a'*40,api)
            self.assertEqual(gh.calls,[]);feed.assert_not_called()
    def test_tag_source_mismatch_never_publishes(self):
        def api(args,document=None):return {'object':{'type':'commit','sha':'b'*40}}
        with mock.patch('release_automation.publish_release') as publish:
            with self.assertRaises(ValueError):publish_all(self.source,self.output,'a'*40,api)
            publish.assert_not_called()

class WorkflowContractTests(unittest.TestCase):
    def test_main_pipeline_signs_only_release_and_publishes_after_both_verified_platforms(self):
        import yaml
        root=Path(__file__).resolve().parents[1]
        workflow=yaml.load((root/'.github/workflows/windows-desktop.yml').read_text(),Loader=yaml.BaseLoader)
        self.assertIn('main',workflow['on']['push']['branches'])
        self.assertEqual(workflow['concurrency']['cancel-in-progress'],'false')
        jobs=workflow['jobs']
        self.assertEqual(jobs['publish']['needs'],['validate','windows','linux'])
        self.assertEqual(jobs['publish']['permissions']['contents'],'write')
        self.assertNotIn('permissions',jobs['linux'])
        plan=next(step for step in jobs['validate']['steps'] if step.get('id')=='plan')
        self.assertEqual(plan['run'],'python3 release_automation.py plan')
        signing=next(step for step in jobs['linux']['steps'] if 'CUBBY_DEVICE_SIGNING_KEY' in step.get('env',{}))
        self.assertEqual(signing['if'],"needs.validate.outputs.release == 'true'")
        self.assertIn('test -n "$CUBBY_DEVICE_SIGNING_KEY"',signing['run'])
        self.assertIn('cmp "$keydir/public.pem" rocknix/device/release-key.pem',signing['run'])
        self.assertIn('unset CUBBY_DEVICE_SIGNING_KEY',signing['run'])
        self.assertIn('trap ',signing['run'])
        subprocess.run(['bash','-n'],input=signing['run'],text=True,check=True,capture_output=True)
        publish=jobs['publish']['steps'][-1]
        self.assertEqual(publish['run'],'python3 release_automation.py publish')

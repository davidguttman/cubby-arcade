"""The composed release, not sequence zero, is the updater's starting point."""
import json
import subprocess
from unittest import TestCase

from rocknix import image, updates
from release_automation import sequence
import test_rocknix_updates as update_fixtures


class ImageUpdateFloorTests(TestCase):
    def setUp(self):
        self.fixture = update_fixtures.UpdateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def signed(self, version):
        fixture = self.fixture
        manifest = dict(fixture.manifest, version=version, sequence=sequence(version))
        raw = json.dumps(manifest).encode()
        source = fixture.base/'to-sign.json'; source.write_bytes(raw)
        signature = subprocess.check_output(['openssl','pkeyutl','-sign','-rawin',
                                            '-inkey',str(fixture.key),'-in',str(source)])
        return raw, signature

    def seed(self):
        fixture = self.fixture
        image.provision_image_identity(fixture.base, fixture.base/'current',
                                       {'version':'0.35.0','source_commit':'a'*40})

    def feed(self, version):
        raw, signature = self.signed(version)
        self.fixture.responses.update({'https://updates.example/manifest.json':raw,
                                       'https://updates.example/manifest.json.sig':signature})

    def test_fresh_image_status_same_older_newer_and_trial_rollback(self):
        fixture = self.fixture
        with fixture.prepare_stage():
            self.seed()
            manager = updates.Manager(fixture.base, openssl=['openssl'])
            fixture.manager = manager
            self.assertEqual(manager.status()['installed'], '0.35.0')
            self.assertEqual(manager.status()['sequence'], sequence('0.35.0'))
            self.assertFalse((fixture.base/'current/release.json').exists())
            self.feed('0.34.0')
            with self.assertRaisesRegex(ValueError, 'Replayed'): manager.check()
            self.feed('0.35.0')
            self.assertEqual(manager.check()['phase'], 'idle')
            self.assertFalse((manager.dir/'platform-candidate.json').exists())
            # A signed response is still mandatory for the installed image.
            raw, signature = self.signed('0.35.0')
            with self.assertRaisesRegex(ValueError, 'signature'):
                manager.verify(raw, b'0'*64, allow_installed=True)
            self.feed('0.36.0')
            self.assertEqual(manager.check()['phase'], 'available')
            manager.stage(); manager.apply(); manager.recover(force=True)
            self.assertEqual(manager.status()['installed'], '0.35.0')
            self.assertEqual(manager.status()['sequence'], sequence('0.35.0'))
            self.assertEqual((fixture.base/'current').resolve(), fixture.base/'releases/old')
            self.feed('0.37.0')
            manager.check(); manager.stage(); manager.apply()
            token = updates.read_json(manager.dir/'pending.json')['token']
            manager.confirm(token)
            self.assertEqual(manager.status()['installed'], '0.37.0')
            self.assertEqual((fixture.base/'state/save').read_bytes(), b'keep')

    def test_installed_allowance_requires_matching_image_identity(self):
        fixture = self.fixture
        with fixture.prepare_stage():
            self.seed()
            raw, signature = self.signed('0.35.0')
            identity = updates.read_json(fixture.base/'current/image.json')
            for changed in ({'version':'0.34.0'}, {'runtime_sha256':'0'*64},
                            {'source_commit':None}, {'kind':'app'}):
                updates.atomic(fixture.base/'current/image.json', dict(identity, **changed))
                with self.assertRaisesRegex(ValueError, 'Replayed'):
                    fixture.manager.verify(raw, signature, allow_installed=True)

    def test_nonproduction_image_does_not_gain_an_invented_floor(self):
        self.assertIsNone(image.image_update_identity(None))

"""A production image must be current, inspectable, and recoverable without Cubby."""
from pathlib import Path
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

try:
    from pyfatfs.PyFatFS import PyFatFS
except ImportError:
    PyFatFS = None

class ProductionImageTests(unittest.TestCase):
    def module(self):
        from rocknix import production_image
        return production_image

    def test_source_plan_refuses_dirty_or_missing_commit_and_stale_version(self):
        module = self.module()
        for provenance in [{'source_commit': None, 'source_dirty': False},
                           {'source_commit': 'a'*40, 'source_dirty': True}]:
            with patch.object(module.image, 'source_provenance', return_value=provenance):
                with self.assertRaisesRegex(ValueError, 'clean committed'):
                    module.source_plan(ROOT)
        with patch.object(module.image, 'source_provenance', return_value={'source_commit':'a'*40,'source_dirty':False}):
            with self.assertRaisesRegex(ValueError, 'version'):
                module.source_plan(ROOT, expected_version='0.0.1')

    def test_plan_identifies_version_commit_and_every_required_asset(self):
        module = self.module()
        with patch.object(module.image, 'source_provenance', return_value={'source_commit':'a'*40,'source_dirty':False}):
            plan = module.source_plan(ROOT)
        self.assertEqual(plan['version'], json.loads((ROOT/'package.json').read_text())['version'])
        self.assertEqual(plan['source_commit'], 'a'*40)
        self.assertFalse(plan['hardware_validated'])
        self.assertIn('cubby-splash/load.sh', plan['flash_files'])
        self.assertIn('rocknix/updates.py', plan['app_files'])
        self.assertIn('runtime/native/rg353v/boot-screen/boot-screen.py', plan['app_files'])
        self.assertIn(plan['version'], module.image_name(plan))

    def test_recovery_works_without_current_release_and_does_not_initialize_usb(self):
        spec = importlib.util.spec_from_file_location('image_management', ROOT/'rocknix/device/management.py')
        management = importlib.util.module_from_spec(spec); spec.loader.exec_module(management)
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)/'storage/cubby'
            worker=management.RecoveryManagement(base, flash=Path(directory)/'flash')
            self.assertTrue(worker.confirmed())
            self.assertTrue(worker.restore_usb())
            self.assertNotIn('state', worker.private.parts)
            self.assertEqual(worker.port, 2223)
            self.assertNotEqual(worker.private, base/'management/private')

    def test_provisioned_key_rejects_private_material(self):
        module=self.module()
        with tempfile.TemporaryDirectory() as directory:
            key=Path(directory)/'key'; key.write_text('-----BEGIN OPENSSH PRIVATE KEY-----\n')
            with self.assertRaisesRegex(ValueError, 'public key'):
                module.public_keys(key)

    def test_exact_old_updater_client_is_rejected_before_build(self):
        module=self.module()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'rocknix').mkdir()
            source=(ROOT/'rocknix/updates.py').read_text()
            self.assertIn("result.get('error') is not None",source)
            (root/'rocknix/updates.py').write_text(source.replace("result.get('error') is not None", "'error' in result"))
            with self.assertRaises(Exception) as error:
                module.validate_updater(root)
            self.assertEqual(type(error.exception).__name__,'Rejected')

    def test_independent_recovery_prepares_unique_identity_without_a_release(self):
        spec=importlib.util.spec_from_file_location('recovery_management',ROOT/'rocknix/device/management.py')
        management=importlib.util.module_from_spec(spec); spec.loader.exec_module(management)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); base=root/'storage/cubby'; flash=root/'flash'
            key=root/'client'
            subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True)
            (flash/'cubby-setup').mkdir(parents=True)
            (flash/'cubby-setup/authorized_keys').write_bytes(key.with_suffix('.pub').read_bytes())
            worker=management.RecoveryManagement(base,flash=flash)
            try:
                worker.prepare(key.with_suffix('.pub').read_text())
                self.assertIn('Port 2223',worker.config.read_text())
                self.assertIn('AuthenticationMethods publickey',worker.config.read_text())
                self.assertFalse((base/'current').exists())
                host=worker.host_key.read_bytes(); worker.prepare(key.with_suffix('.pub').read_text())
                self.assertEqual(host,worker.host_key.read_bytes())
            finally:
                worker.close()

    @unittest.skipUnless(PyFatFS and all(shutil.which(tool) for tool in ('mkfs.vfat', 'mkfs.ext4', 'debugfs')),
                         'requires pyfatfs, dosfstools and e2fsprogs')
    def test_filesystem_audit_detects_actual_packaged_corruption(self):
        module=self.module()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); fat=root/'flash.fat'; storage=root/'storage.ext4'
            with fat.open('wb') as stream:stream.truncate(16*1024**2)
            subprocess.run(['mkfs.vfat',str(fat)],check=True,capture_output=True)
            with PyFatFS(str(fat)) as filesystem:filesystem.writebytes('/post-sysroot.sh',b'good hook')
            seed=root/'seed'; app=seed/'cubby/releases/image-test/app/runtime'; app.mkdir(parents=True)
            (app/'version.json').write_bytes(b'{"version":"1.0.0"}')
            with storage.open('wb') as stream:stream.truncate(16*1024**2)
            subprocess.run(['mkfs.ext4','-q','-F','-d',str(seed),str(storage)],check=True,capture_output=True)
            plan={'flash_files':{'post-sysroot.sh':module.digest(b'good hook')},
                  'app_files':{'runtime/version.json':module.digest(b'{"version":"1.0.0"}')}}
            module.audit_partitions(fat,storage,'image-test',plan)
            with PyFatFS(str(fat)) as filesystem:
                filesystem.makedir('/cubby-setup')
                filesystem.writebytes('/cubby-setup/authorized_keys',b'unlisted key')
            with self.assertRaisesRegex(ValueError,'provisioned'):
                module.audit_partitions(fat,storage,'image-test',plan,public=True)
            with PyFatFS(str(fat)) as filesystem:
                filesystem.remove('/cubby-setup/authorized_keys')
            with PyFatFS(str(fat)) as filesystem:filesystem.writebytes('/post-sysroot.sh',b'bad! hook')
            with self.assertRaisesRegex(ValueError,'post-sysroot'):
                module.audit_partitions(fat,storage,'image-test',plan)
            plan['flash_files']={}
            plan['app_files']['runtime/version.json']=module.digest(b'wrong')
            with self.assertRaisesRegex(ValueError,'runtime/version.json'):
                module.audit_partitions(fat,storage,'image-test',plan)

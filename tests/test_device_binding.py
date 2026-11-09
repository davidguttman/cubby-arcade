"""Provisioning identities are specific to one physical eMMC, not a fleet clone."""
import json
from pathlib import Path
import tempfile
import shutil
import subprocess
import unittest
import uuid
from rocknix import production_image as production, provision, image
try:
    from pyfatfs.PyFatFS import PyFatFS
except ImportError:
    PyFatFS = None

CID = 'a' * 32

class DeviceBindingTests(unittest.TestCase):
    def plan(self):
        return {'version':'0.35.0', 'source_commit':'b'*40, 'storage_files':{}}

    def test_binding_requires_valid_cid_and_public_management_key(self):
        for cid, keys in [('BAD', b'public'), (CID, None), ('A'*32, b'public')]:
            with self.subTest(cid=cid, keys=keys), self.assertRaises(ValueError):
                production.bind_plan(self.plan(), cid, keys)
        plan = production.bind_plan(self.plan(), CID, b'public')
        self.assertEqual(plan['device_cid'], CID)
        self.assertIn('cubby/image-provenance/device.json', plan['storage_files'])
        self.assertIn(CID[:12], production.image_name(plan))

    def test_two_device_builds_get_distinct_media_identities(self):
        first = production.bind_plan(self.plan(), CID, b'public')
        second = production.bind_plan(self.plan(), 'c'*32, b'public')
        for field in ('disk_guid','fat_serial','storage_uuid','boot_label','storage_label'):
            self.assertNotEqual(first['media_identities'][field], second['media_identities'][field])
        self.assertNotEqual(first['media_identities']['partition_guids'], second['media_identities']['partition_guids'])

    def test_installer_refuses_unbound_and_wrong_unit_before_writing(self):
        for bound in (None, 'b'*32):
            with self.subTest(bound=bound), self.assertRaises(provision.Blocked):
                provision.validate_device_binding({'device_cid':bound}, {'cid':CID})
        provision.validate_device_binding({'device_cid':CID}, {'cid':CID})

    def test_generic_plan_remains_public_but_bound_plan_cannot_be_public(self):
        generic = production.bind_plan(self.plan(), None, None)
        production.validate_binding(generic, public=True)
        self.assertNotIn('device_cid',generic)
        bound = production.bind_plan(self.plan(), CID, b'public')
        with self.assertRaisesRegex(ValueError, 'Public'):
            production.validate_binding(bound, public=True)

    def test_gpt_identity_audit_rejects_valid_geometry_with_wrong_guid(self):
        plan = production.bind_plan(self.plan(), CID, b'public')
        ids = plan['media_identities']; header = bytearray(512); entries = bytearray(256)
        header[56:72] = uuid.UUID(ids['disk_guid']).bytes_le
        for i, guid in enumerate(ids['partition_guids']):
            entries[i*128+16:i*128+32] = uuid.UUID(guid).bytes_le
        production.audit_gpt_identities((None,header,entries,None), plan)
        for buffer, start in ((header,56),(entries,16),(entries,144)):
            original = buffer[start:start+16]
            buffer[start:start+16] = uuid.uuid4().bytes_le
            with self.assertRaisesRegex(ValueError,'GPT'):
                production.audit_gpt_identities((None,header,entries,None), plan)
            buffer[start:start+16] = original

    def test_missing_or_stale_actual_record_inventory_is_rejected(self):
        plan = production.bind_plan(self.plan(), CID, b'public')
        plan['storage_files'].clear()
        with self.assertRaisesRegex(ValueError,'identity record'):
            production.validate_binding(plan)
        with self.assertRaisesRegex(ValueError,'media identities'):
            production.validate_binding({'device_cid':CID})

    def test_provisioned_identity_file_contains_only_machine_binding(self):
        plan = production.bind_plan(self.plan(), CID, b'public')
        with tempfile.TemporaryDirectory() as d:
            cubby = Path(d)/'cubby'; cubby.mkdir()
            image.provision_media_identity(cubby,plan)
            record = json.loads((cubby/'image-provenance/device.json').read_text())
            self.assertEqual(record, {'device_cid':CID,'media_identities':plan['media_identities']})
            self.assertEqual(production.digest((cubby/'image-provenance/device.json').read_bytes()),
                             plan['storage_files']['cubby/image-provenance/device.json'])

    @unittest.skipUnless(PyFatFS and all(shutil.which(t) for t in
                         ('mkfs.vfat','mkfs.ext4','fatlabel','debugfs','tune2fs')),
                         'requires pyfatfs, dosfstools and e2fsprogs')
    def test_actual_fs_identity_and_bound_record_corruption_rejected(self):
        plan = production.bind_plan(self.plan(), CID, b'public')
        plan.update(flash_files={},app_files={})
        ids = plan['media_identities']
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); fat=root/'fat'; storage=root/'ext4'; seed=root/'seed'
            (seed/'cubby').mkdir(parents=True)
            image.provision_media_identity(seed/'cubby',plan)
            (seed/'cubby/image-provenance/build.json').write_text(json.dumps({
                'media_identities':ids,'product_version':plan['version'],'source_commit':plan['source_commit']}))
            with fat.open('wb') as f: f.truncate(16*1024**2)
            subprocess.run(['mkfs.vfat','-n',ids['boot_label'],'-i',ids['fat_serial'],str(fat)],check=True,capture_output=True)
            with PyFatFS(str(fat)) as fs:
                fs.makedir('/EXTLINUX')
                fs.writetext('/EXTLINUX/extlinux.conf',
                    'APPEND boot=LABEL='+ids['boot_label']+' disk=LABEL='+ids['storage_label']+' quiet\n')
            with storage.open('wb') as f: f.truncate(16*1024**2)
            subprocess.run(['mkfs.ext4','-q','-F','-U',ids['storage_uuid'],'-L',ids['storage_label'],
                            '-d',str(seed),str(storage)],check=True,capture_output=True)
            production.audit_partitions(fat,storage,'image-test',plan)
            # Volume serial, boot references, ext4 UUID, and bound actual record
            # are independently checked, not inferred from a directory inventory.
            subprocess.run(['fatlabel','--volume-id',str(fat),'12345678'],check=True,capture_output=True)
            with self.assertRaisesRegex(ValueError,'Filesystem'):
                production.audit_partitions(fat,storage,'image-test',plan)
            subprocess.run(['fatlabel','--volume-id',str(fat),ids['fat_serial']],check=True,capture_output=True)
            with PyFatFS(str(fat)) as fs:
                image.replace_fat_file(fs,'/EXTLINUX/extlinux.conf',b'APPEND boot=LABEL=WRONG disk=LABEL=WRONG\n')
            with self.assertRaisesRegex(ValueError,'Boot filesystem'):
                production.audit_partitions(fat,storage,'image-test',plan)
            with PyFatFS(str(fat)) as fs:
                image.replace_fat_file(fs,'/EXTLINUX/extlinux.conf',
                    ('APPEND boot=LABEL='+ids['boot_label']+' disk=LABEL='+ids['storage_label']+'\n').encode())
            subprocess.run(['tune2fs','-U',str(uuid.uuid4()),str(storage)],check=True,capture_output=True)
            with self.assertRaisesRegex(ValueError,'Filesystem'):
                production.audit_partitions(fat,storage,'image-test',plan)
            subprocess.run(['tune2fs','-U',ids['storage_uuid'],str(storage)],check=True,capture_output=True)
            build_record=root/'build'
            build_original=(seed/'cubby/image-provenance/build.json').read_bytes()
            build_record.write_text(json.dumps({'media_identities':{},'product_version':plan['version'],
                                                'source_commit':plan['source_commit']}))
            def replace_record(name, source):
                subprocess.run(['debugfs','-w','-R','rm /cubby/image-provenance/'+name,str(storage)],check=True,capture_output=True)
                subprocess.run(['debugfs','-w','-R','write '+str(source)+' /cubby/image-provenance/'+name,str(storage)],check=True,capture_output=True)
            replace_record('build.json',build_record)
            with self.assertRaisesRegex(ValueError,'build provenance'):
                production.audit_partitions(fat,storage,'image-test',plan)
            build_record.write_bytes(build_original);replace_record('build.json',build_record)
            wrong=root/'wrong'; wrong.write_text('{"device_cid":"'+('c'*32)+'"}')
            subprocess.run(['debugfs','-w','-R','rm /cubby/image-provenance/device.json',str(storage)],check=True,capture_output=True)
            subprocess.run(['debugfs','-w','-R','write '+str(wrong)+' /cubby/image-provenance/device.json',str(storage)],check=True,capture_output=True)
            with self.assertRaisesRegex(ValueError,'device.json'):
                production.audit_partitions(fat,storage,'image-test',plan)

if __name__=='__main__': unittest.main()

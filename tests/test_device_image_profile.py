"""Production runtime and removable/internal media integration regressions."""
import hashlib
import io
from pathlib import Path
import struct
import subprocess
import shutil
import tempfile
import unittest
import zlib

from rocknix import image
import test_rocknix_image as base_image_tests

ROOT = Path(__file__).resolve().parents[1]


class DeviceImageProfileTests(unittest.TestCase):
    def test_distinct_media_identities_and_boot_references(self):
        first, second = image.media_identities(), image.media_identities()
        self.assertNotEqual(first, second)
        config = 'APPEND boot=LABEL=ROCKNIX disk=LABEL=STORAGE quiet\n  APPEND boot=LABEL=ROCKNIX disk=LABEL=STORAGE splash\n'
        changed = image.rewrite_boot_labels(config, first)
        self.assertEqual(changed.count('boot=LABEL='+first['boot_label']), 2)
        self.assertEqual(changed.count('disk=LABEL='+first['storage_label']), 2)
        self.assertNotIn('UUID=', changed)
        with self.assertRaises(ValueError):
            image.rewrite_boot_labels('APPEND disk=LABEL=OTHER\n', first)

    def test_gpt_identity_changes_keep_types_bootloader_and_mirrors(self):
        original = base_image_tests.ImageTests().gpt()
        ids = image.media_identities()
        with tempfile.TemporaryFile() as target:
            target.write(original)
            target.seek(32768*512-16); target.write(b'unchanged-loader')
            image.grow_gpt(target, image.gpt_layout(io.BytesIO(original)), 4*1024**3//512, identities=ids)
            target.seek(512); primary=bytearray(target.read(512))
            expected=struct.unpack_from('<I',primary,16)[0]
            struct.pack_into('<I',primary,16,0)
            self.assertEqual(zlib.crc32(primary[:92]),expected)
            self.assertNotEqual(primary[56:72],original[568:584])
            target.seek(1024); entries=target.read(16384)
            for index in (0,1):
                offset=index*128
                self.assertEqual(entries[offset:offset+16],original[1024+offset:1040+offset])
                self.assertNotEqual(entries[offset+16:offset+32],original[1040+offset:1056+offset])
            backup=struct.unpack_from('<Q',primary,32)[0]
            target.seek((backup-32)*512); self.assertEqual(target.read(16384),entries)
            target.seek(32768*512-16); self.assertEqual(target.read(16),b'unchanged-loader')

    def test_pinned_dt_profile_changes_only_expected_properties(self):
        # Use an actual pinned upstream tree if available; never touch devices.
        path=ROOT/'.cache/wifi-dtb-validation/rk3566-anbernic-rg353v.original.dtb'
        if not path.exists(): self.skipTest('cached pinned DTB unavailable')
        original=path.read_bytes()
        patched=image.rg353v_wifi_profile(original)
        before=image.fdt_properties(original)
        after=image.fdt_properties(patched)
        changed={key for key in before.keys()|after.keys() if before.get(key)!=after.get(key)}
        self.assertEqual(changed,{('/mmc@fe000000','sd-uhs-sdr50'),('/mmc@fe000000','max-frequency')})
        self.assertEqual(after[('/mmc@fe000000','max-frequency')],struct.pack('>I',25000000))
        self.assertEqual(original,path.read_bytes())
        with self.assertRaises(ValueError): image.rg353v_wifi_profile(patched)

    def test_bubblewrap_wrapper_preserves_arguments_and_only_adds_dma_heap(self):
        wrapper=ROOT/'rocknix/device/bwrap-dma-heap.py'
        self.assertTrue(wrapper.is_file())
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'capture'
            path.write_text('#!/usr/bin/python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n')
            path.chmod(0o755)
            source=wrapper.read_text().replace('/usr/bin/bwrap.cubby-original',str(path))
            test=Path(directory)/'wrapper'; test.write_text(source)
            import json
            for original in [['--args','45','--','/usr/bin/xdg-dbus-proxy','--args=41','space argument'], ['--args','45']]:
                result=subprocess.run(['python3',str(test),*original],capture_output=True,text=True,check=True)
                args=json.loads(result.stdout)
                self.assertEqual(args[:2],original[:2])
                self.assertEqual(args[2:5],['--dev-bind-try','/dev/dma_heap/system','/dev/dma_heap/system'])
                self.assertEqual(args[5:],original[2:])

    def test_runtime_identity_shared_by_builder_and_updater(self):
        from rocknix import updates
        self.assertEqual(image.ROOTFS_SHA256,updates.RUNTIME)
        self.assertEqual(image.ROOTFS_SHA256,'e1859403acf7593e5b2ad9b932092258302f415a093959de24fd402b7475ee92')

    @unittest.skipUnless(shutil.which('mkfs.vfat') and shutil.which('fatlabel'), 'requires dosfstools')
    def test_real_fat_label_and_serial_are_unique(self):
        with tempfile.TemporaryDirectory() as directory:
            fat=Path(directory)/'boot.fat'
            with fat.open('wb') as stream: stream.truncate(64*1024**2)
            subprocess.run(['mkfs.vfat','-F','32','-n','ROCKNIX',str(fat)],check=True,capture_output=True)
            ids=image.media_identities()
            subprocess.run(['fatlabel',str(fat),ids['boot_label']],check=True)
            subprocess.run(['fatlabel','--volume-id',str(fat),ids['fat_serial']],check=True)
            self.assertEqual(subprocess.check_output(['fatlabel',str(fat)],text=True).strip(),ids['boot_label'])
            self.assertEqual(subprocess.check_output(['fatlabel','--volume-id',str(fat)],text=True).strip().upper(),ids['fat_serial'])

    def test_kiosk_builder_rejects_wrong_baseline_before_network_or_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); baseline=root/'wrong.tar.xz'; baseline.write_bytes(b'wrong')
            output=root/'output'
            result=subprocess.run(['bash',str(ROOT/'rocknix/build-kiosk-rootfs.sh'),str(baseline),str(output),str(root/'cache')],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse(output.exists())
            self.assertFalse((root/'cache').exists())


if __name__=='__main__': unittest.main()

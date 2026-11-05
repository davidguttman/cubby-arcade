"""Exercise existing, multi-cluster boot-file replacement on a real FAT32 image."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from rocknix import image

try:
    from pyfatfs.PyFatFS import PyFatFS
except ImportError:
    PyFatFS = None


@unittest.skipUnless(PyFatFS and shutil.which('mkfs.vfat') and shutil.which('fsck.fat'),
                     'requires pyfatfs and dosfstools')
class FatReplacementTests(unittest.TestCase):
    def test_existing_multicluster_dtb_and_extlinux_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'boot image.fat'
            with path.open('wb') as stream:
                stream.truncate(64 * 1024 ** 2)
            subprocess.run(['mkfs.vfat', '-F', '32', str(path)], check=True, capture_output=True)
            original = bytes(range(256)) * 254
            expected = b'patched!' + original[8:]
            config = b'APPEND boot=LABEL=ROCKNIX disk=LABEL=STORAGE quiet\n' * 20
            rewritten = image.rewrite_boot_labels(config.decode(), image.media_identities()).encode()
            unchanged = {'/KERNEL': b'kernel' * 2000, '/SYSTEM': b'system' * 3000}
            with PyFatFS(str(path)) as flash:
                flash.makedir('/device_trees')
                flash.makedir('/EXTLINUX')
                flash.writebytes('/device_trees/test.dtb', original)
                entry = flash._get_dir_entry('/device_trees/test.dtb')
                entry.attr |= 3  # Preserve read-only/hidden flags as well as archive.
                original_flags = entry.attr
                flash.fs.update_directory_entry(entry.get_parent_dir())
                flash.writebytes('/EXTLINUX/extlinux.conf', config)
                for name, data in unchanged.items():
                    flash.writebytes(name, data)
            with PyFatFS(str(path)) as flash:
                flash.makedir('/cubby-recovery')
                flash.writebytes('/cubby-recovery/test.original.dtb', flash.readbytes('/device_trees/test.dtb'))
                image.replace_fat_file(flash, '/device_trees/test.dtb', expected)
                image.replace_fat_file(flash, '/EXTLINUX/extlinux.conf', rewritten)
            image.finalize_fat(path)
            checked = subprocess.run(['fsck.fat', '-n', str(path)], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            with PyFatFS(str(path)) as flash:
                self.assertEqual(flash.readbytes('/device_trees/test.dtb'), expected)
                self.assertEqual(flash._get_dir_entry('/device_trees/test.dtb').attr, original_flags)
                self.assertEqual(flash.readbytes('/cubby-recovery/test.original.dtb'), original)
                self.assertEqual(flash.readbytes('/EXTLINUX/extlinux.conf'), rewritten)
                for name, data in unchanged.items():
                    self.assertEqual(hashlib.sha256(flash.readbytes(name)).digest(), hashlib.sha256(data).digest())

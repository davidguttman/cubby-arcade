"""Image packaging guards: disk preservation and first-boot activation contract."""
import importlib.util
from pathlib import Path
import struct
import io
import os
import zlib
import tempfile
import subprocess
import shutil
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('rocknix_image', Path(__file__).resolve().parents[1] / 'rocknix/image.py')
image = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(image)


class ImageTests(unittest.TestCase):
    def test_customer_seed_is_empty_and_old_game_installer_is_not_available(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory)
            (storage/'cubby/state').mkdir(parents=True)
            (storage/'cubby/updates').mkdir()
            (storage/'cubby/updates/record.json').write_text('{"version":"0.35.0"}')
            image.validate_customer_seed(storage)
            (storage/'cubby/state/games').mkdir()
            with self.assertRaisesRegex(ValueError, 'customer state'):
                image.validate_customer_seed(storage)
        self.assertFalse(hasattr(image, 'seed_game'))

    def test_build_rejects_dangling_output_and_checksum_symlinks_upfront(self):
        for checksum in (False, True):
            with self.subTest(checksum=checksum), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output = root / 'composed.img.gz'
                occupied = output.with_name(output.name + '.sha256') if checksum else output
                target = root / 'must-not-create'
                occupied.symlink_to(target)
                with mock.patch.object(image.os, 'geteuid', return_value=0), mock.patch.object(image, 'verify'), self.assertRaisesRegex(ValueError, 'existing output'):
                    image.build(root / 'upstream', root / 'rootfs', output)
                self.assertTrue(occupied.is_symlink())
                self.assertFalse(target.exists())

    def test_checksum_publication_does_not_clobber_a_racing_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            compressed = root / 'staged.img.gz'
            compressed.write_bytes(b'image')
            output = root / 'composed.img.gz'
            sidecar = output.with_name(output.name + '.sha256')
            target = root / 'important'
            target.write_text('untouched')
            link = image.os.link
            def racing_link(source, destination):
                if Path(destination) == sidecar:
                    sidecar.symlink_to(target)
                return link(source, destination)
            with mock.patch.object(image.os, 'link', side_effect=racing_link), self.assertRaises(FileExistsError):
                image.publish_image(compressed, output, 'a' * 64)
            self.assertEqual(target.read_text(), 'untouched')
            self.assertTrue(sidecar.is_symlink())

    def test_checksum_publication_is_complete_and_refuses_existing_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            compressed = root / 'staged.img.gz'
            compressed.write_bytes(b'image')
            output = root / 'composed.img.gz'
            image.publish_image(compressed, output, 'a' * 64)
            self.assertEqual(output.read_bytes(), b'image')
            sidecar = output.with_name(output.name + '.sha256')
            self.assertEqual(sidecar.read_text(), 'a' * 64 + '  composed.img.gz\n')
            with self.assertRaises((ValueError, FileExistsError)):
                image.publish_image(compressed, output, 'b' * 64)
            self.assertEqual(sidecar.read_text(), 'a' * 64 + '  composed.img.gz\n')

    @unittest.skipUnless(shutil.which('debugfs') and shutil.which('mkfs.ext4'), 'requires e2fsprogs')
    def test_real_debugfs_extracts_storage_into_a_space_and_quote_path(self):
        with tempfile.TemporaryDirectory(prefix='cubby space ') as directory:
            root = Path(directory)
            seed = root / 'seed'
            seed.mkdir()
            (seed / '.please_resize_me').touch()
            (seed / 'stock-file').write_text('stock data')
            filesystem = root / 'storage.ext4'
            with filesystem.open('wb') as stream:
                stream.truncate(8 * 1024 ** 2)
            subprocess.run(['mkfs.ext4', '-q', '-F', '-E', f'root_owner={os.getuid()}:{os.getgid()}',
                            '-d', str(seed), str(filesystem)], check=True, capture_output=True)
            # Keep this regular-file fixture runnable without a root namespace:
            # mkfs creates lost+found owned by root regardless of root_owner.
            subprocess.run(['debugfs', '-w', '-R', 'rmdir /lost+found', str(filesystem)],
                           check=True, capture_output=True)
            storage = root / 'output "quoted" \\ storage'
            storage.mkdir()
            image.extract_storage(filesystem, storage)
            self.assertEqual((storage / 'stock-file').read_text(), 'stock data')
            image.validate_storage_seed(storage)
            # debugfs reports a failed rdump on stderr but still exits zero.
            with self.assertRaisesRegex(ValueError, 'extraction'):
                image.extract_storage(filesystem, root / 'missing' / 'destination')

    def gpt(self):
        mbr = bytearray(b'B' * 512)
        mbr[446:510] = bytes(64)
        mbr[450] = 0xee
        struct.pack_into('<II', mbr, 454, 1, 4294655)
        mbr[510:] = b'\x55\xaa'
        header = bytearray(512)
        header[:8] = b'EFI PART'
        struct.pack_into('<II', header, 8, 0x10000, 92)
        struct.pack_into('<QQQQ', header, 24, 1, 4294655, 34, 4294622)
        header[56:72] = b'G' * 16
        struct.pack_into('<QII', header, 72, 2, 128, 128)
        entries = bytearray(16384)
        for index, start, count in [(0, 32768, 4194304), (1, 4227072, 65536)]:
            offset = index * 128
            entries[offset:offset + 32] = bytes([index + 1]) * 32
            struct.pack_into('<QQ', entries, offset + 32, start, start + count - 1)
        struct.pack_into('<I', header, 88, zlib.crc32(entries))
        struct.pack_into('<I', header, 16, zlib.crc32(header[:92]))
        return bytes(mbr + header + entries)

    def test_generated_layout_accepts_expansion_but_checks_backup_and_stock_stays_strict(self):
        original = self.gpt()
        with tempfile.TemporaryFile() as target:
            image.grow_gpt(target, image.gpt_layout(io.BytesIO(original)), 6 * 1024 ** 3 // 512)
            with self.assertRaises(ValueError): image.gpt_layout(target)
            self.assertEqual(image.generated_gpt_layout(target)[3][1][1], 6 * 1024 ** 3 // 512)
            target.seek(-512, 2); target.write(b'BROKEN!!')
            with self.assertRaises(ValueError): image.generated_gpt_layout(target)

    def test_grow_assigns_unique_ids_and_relocates_backup(self):
        original = self.gpt()
        layout = image.gpt_layout(io.BytesIO(original))
        with tempfile.TemporaryFile() as target:
            target.write(original)
            target.seek(32768 * 512 - 32)
            target.write(b'BOOTLOADER IS PRESERVED'.ljust(32, b'!'))
            image.grow_gpt(target, layout, 4 * 1024 ** 3 // 512)
            target.seek(512)
            primary = target.read(512)
            header = bytearray(primary)
            checksum = struct.unpack_from('<I', header, 16)[0]
            struct.pack_into('<I', header, 16, 0)
            self.assertEqual(checksum, zlib.crc32(header[:92]))
            self.assertNotEqual(primary[56:72], original[568:584])
            target.seek(1024)
            entries = target.read(16384)
            self.assertEqual(entries[:16], original[1024:1040])
            self.assertNotEqual(entries[16:32], original[1040:1056])
            self.assertEqual(entries[32:128], original[1056:1152])
            self.assertEqual(entries[128:144], original[1152:1168])
            self.assertNotEqual(entries[144:160], original[1168:1184])
            self.assertEqual(entries[160:168], original[1184:1192])
            self.assertEqual(entries[176:], original[1200:])
            backup_lba = struct.unpack_from('<Q', primary, 32)[0]
            target.seek(backup_lba * 512)
            backup = bytearray(target.read(512))
            checksum = struct.unpack_from('<I', backup, 16)[0]
            struct.pack_into('<I', backup, 16, 0)
            self.assertEqual(checksum, zlib.crc32(backup[:92]))
            self.assertEqual(struct.unpack_from('<QQ', backup, 24), (backup_lba, 1))
            target.seek(32768 * 512 - 32)
            self.assertEqual(target.read(32), b'BOOTLOADER IS PRESERVED'.ljust(32, b'!'))

    def test_refuse_corrupt_gpt(self):
        for offset in (510, 512, 568, 1152):
            bad = bytearray(self.gpt())
            bad[offset] ^= 1
            with self.assertRaises(ValueError):
                image.gpt_layout(io.BytesIO(bad))
        with tempfile.TemporaryFile() as target:
            with self.assertRaises(ValueError):
                image.grow_gpt(target, image.gpt_layout(io.BytesIO(self.gpt())), 4)

    def test_checksum_rejection_before_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'upstream.gz'
            target.write_bytes(b'not the pinned release')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                image.verify(target, image.ROCKNIX_SHA256)

    def test_hook_uses_runtime_override_and_card_readable_recovery(self):
        hook = '\n'.join(line for line in image.BOOT_HOOK.splitlines() if not line.startswith('#'))
        self.assertIn('/flash/CUBBY-DISABLED', hook)
        self.assertIn('/run/systemd/system/essway.service.d', hook)
        self.assertIn('/storage/cubby/current/device/launch.sh', hook)
        self.assertIn('Anbernic RG353V', hook)
        self.assertNotIn('/storage/.config', hook)
        self.assertNotIn('rm ', hook)
        self.assertNotIn('mount ', hook)

    def test_boot_hook_runs_on_supported_model_and_respects_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'flash/cubby-usb-diagnostics').mkdir(parents=True)
            (root / 'flash/cubby-usb-diagnostics/service').write_text(
                (image.ROOT / 'rocknix/device/cubby-usb-diagnostics.service').read_text())
            (root / 'flash/cubby-wifi-recovery').mkdir()
            (root / 'flash/cubby-wifi-recovery/service').write_text(
                (image.ROOT / 'rocknix/device/cubby-wifi-recovery.service').read_text())
            model = root / 'model'
            hook = image.BOOT_HOOK.replace('/proc/device-tree/model', str(model)).replace('/run/systemd/system', str(root / 'run')).replace('/flash/', str(root / 'flash') + '/')
            override = root / 'run/essway.service.d/90-cubby.conf'
            model.write_bytes(b'Anbernic RG353VS\0')
            subprocess.run(['sh', '-c', hook], check=True)
            self.assertFalse(override.exists())
            model.write_bytes(b'Anbernic RG353V\0')
            disabled = root / 'flash/CUBBY-DISABLED'
            disabled.touch()
            subprocess.run(['sh', '-c', hook], check=True)
            self.assertFalse(override.exists())
            self.assertTrue((root / 'run/rocknix.target.wants/cubby-usb-diagnostics.service').is_symlink())
            self.assertFalse((root / 'run/multi-user.target.wants/cubby-usb-diagnostics.service').exists())
            self.assertTrue((root / 'run/multi-user.target.wants/cubby-wifi-recovery.service').is_symlink())
            dependencies = (root / 'run/essway.service.d/10-cubby-wifi.conf').read_text()
            self.assertIn('Wants=cubby-wifi-recovery.service', dependencies)
            self.assertIn('After=cubby-wifi-recovery.service', dependencies)
            self.assertNotIn('Requires=', dependencies)
            disabled.unlink()
            subprocess.run(['sh', '-c', hook], check=True)
            self.assertIn('ExecStart=/storage/cubby/current/device/launch.sh', override.read_text())

    def test_no_preseeded_config_that_blocks_stock_resize(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory)
            (storage / '.please_resize_me').touch()
            image.validate_storage_seed(storage)
            (storage / '.config').mkdir()
            with self.assertRaisesRegex(ValueError, 'resize'):
                image.validate_storage_seed(storage)

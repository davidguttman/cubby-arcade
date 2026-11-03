"""Image packaging guards: disk preservation and first-boot activation contract."""
import importlib.util
from pathlib import Path
import struct
import io
import zlib
import tempfile
import subprocess
import unittest

SPEC = importlib.util.spec_from_file_location('rocknix_image', Path(__file__).resolve().parents[1] / 'rocknix/image.py')
image = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(image)


class ImageTests(unittest.TestCase):
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

    def test_grow_preserves_boot_ids_and_relocates_backup(self):
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
            self.assertEqual(primary[56:72], original[568:584])
            target.seek(1024)
            entries = target.read(16384)
            self.assertEqual(entries[:128], original[1024:1152])
            self.assertEqual(entries[128:168], original[1152:1192])
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
            (root / 'flash').mkdir()
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

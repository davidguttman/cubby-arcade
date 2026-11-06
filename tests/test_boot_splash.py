"""Early framebuffer guards and reversible, offline boot-file installation."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
from rocknix import boot_splash

ROOT = Path(__file__).resolve().parents[1]


class SplashTests(unittest.TestCase):
    def test_rgb_packing_uses_linux_little_endian_channels(self):
        rgb = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255])
        self.assertEqual(boot_splash.pack(rgb, 32), bytes.fromhex('0000ff0000ff0000ff000000'))
        self.assertEqual(boot_splash.pack(rgb, 16), bytes.fromhex('00f8e0071f00'))
        with self.assertRaises(ValueError):
            boot_splash.pack(b'bad!', 32)

    def fixture(self, root):
        from rocknix import image
        (root / 'post-sysroot.sh').write_text(image.BASE_BOOT_HOOK)
        (root / 'KERNEL').write_bytes(b'kernel')
        (root / 'SYSTEM').write_bytes(b'system')
        (root / 'EXTLINUX').mkdir()
        (root / 'EXTLINUX/extlinux.conf').write_text('stock')

    def test_install_restore_and_unmanaged_hook_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            original = (root / 'post-sysroot.sh').read_bytes()
            boot_splash.install(root)
            self.assertNotEqual((root / 'post-sysroot.sh').read_bytes(), original)
            boot_splash.install(root)  # exact owned repeat is harmless
            boot_splash.remove(root)
            self.assertEqual((root / 'post-sysroot.sh').read_bytes(), original)
            self.assertFalse((root / 'cubby-splash').exists())
            (root / 'post-sysroot.sh').write_text('unknown hook')
            with self.assertRaisesRegex(ValueError, 'unmanaged'):
                boot_splash.install(root)
            self.assertEqual((root / 'post-sysroot.sh').read_text(), 'unknown hook')

    def test_interrupted_activation_preserves_hook_and_retry_activates(self):
        from rocknix import image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            def fail_replace(source, destination):
                self.assertEqual(Path(source).read_text(), image.BOOT_HOOK)
                self.assertEqual(destination, root / 'post-sysroot.sh')
                raise OSError('interrupted after temporary file was written')
            with mock.patch.object(boot_splash.os, 'replace', side_effect=fail_replace):
                with self.assertRaises(OSError):
                    boot_splash.install(root)
            self.assertEqual((root / 'post-sysroot.sh').read_text(), image.BASE_BOOT_HOOK)
            self.assertTrue((root / 'cubby-splash/installed.json').is_file())
            self.assertEqual(list(root.glob('*.cubby-tmp*')), [])
            boot_splash.install(root)
            self.assertEqual((root / 'post-sysroot.sh').read_text(), image.BOOT_HOOK)
            boot_splash.remove(root)
            self.assertEqual((root / 'post-sysroot.sh').read_text(), image.BASE_BOOT_HOOK)

    def test_modified_owned_files_are_never_removed_or_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            boot_splash.install(root)
            (root / 'cubby-splash/user-file').write_text('preserve')
            with self.assertRaises(ValueError):
                boot_splash.remove(root)
            self.assertTrue((root / 'cubby-splash/user-file').exists())

    def test_legacy_hook_install_retry_and_restore(self):
        legacy = '''#!/bin/sh
# Managed by Cubby Arcade RG353V image builder.
# Sourced by ROCKNIX initramfs before /run is moved into the real root.
# Do not populate /storage/.config: stock first-boot resize must run first.
if [ "$(tr -d '\\000' < /proc/device-tree/model)" = 'Anbernic RG353V' ] &&
   [ ! -e /flash/CUBBY-DISABLED ]; then
  mkdir -p /run/systemd/system/essway.service.d
  cat > /run/systemd/system/essway.service.d/90-cubby.conf <<'UNIT'
# Managed by Cubby Arcade RG353V image builder
[Service]
ExecStart=
ExecStart=/storage/cubby/current/device/launch.sh
UNIT
fi
'''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            hook = root / 'post-sysroot.sh'
            hook.write_text(legacy)
            with mock.patch.object(boot_splash.os, 'replace', side_effect=OSError('interrupted')):
                with self.assertRaises(OSError):
                    boot_splash.install(root)
            self.assertEqual(hook.read_text(), legacy)
            boot_splash.install(root)
            self.assertEqual(hook.read_text(), legacy + boot_splash.SPLASH_HOOK)
            self.assertNotIn('cubby-usb-diagnostics', hook.read_text())
            boot_splash.install(root)
            boot_splash.remove(root)
            self.assertEqual(hook.read_text(), legacy)

    def test_lowercase_extlinux_directory_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / 'EXTLINUX').rename(root / 'extlinux')
            boot_splash.install(root)
            boot_splash.remove(root)
            (root / 'extlinux').rename(root / 'other')
            (root / 'extlinux').symlink_to(root / 'other', target_is_directory=True)
            with self.assertRaises(ValueError):
                boot_splash.install(root)

    def test_rotation_guard_with_only_initramfs_applets(self):
        import os
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dt = root / 'dt'
            panel = dt / 'display' / 'panel'
            panel.mkdir(parents=True)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            # Rotation scanning must work without find, od, or hexdump.
            (bin_dir / 'sha256sum').symlink_to(shutil.which('sha256sum'))
            env = dict(os.environ, PATH=str(bin_dir))
            script = (ROOT / 'rocknix/device/boot-splash.sh').read_text()
            def run():
                return subprocess.run(['/bin/sh', '-c', script + '\ncubby_rotation_clear "$1" 0',
                                       'splash', str(dt)], env=env, capture_output=True)
            self.assertEqual(run().returncode, 0)
            rotation = panel / 'rotation'
            rotation.write_bytes(bytes(4))
            self.assertEqual(run().returncode, 0)
            for bad in (bytes([0, 0, 1, 14]), b'', bytes(3), bytes(5)):
                rotation.write_bytes(bad)
                self.assertNotEqual(run().returncode, 0)
            rotation.unlink()
            rotation.symlink_to(panel / 'missing')
            self.assertNotEqual(run().returncode, 0)
            rotation.unlink()
            rotation.mkdir()
            self.assertNotEqual(run().returncode, 0)
            shutil.rmtree(dt)
            self.assertNotEqual(run().returncode, 0)

    def test_render_guards_preserve_framebuffer_and_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            flash = root / 'flash'
            flash.mkdir()
            self.fixture(flash)
            boot_splash.install(flash)
            fb = root / 'fb'
            fb.mkdir()
            values = {'virtual_size': '640,480', 'bits_per_pixel': '32',
                      'stride': '2560', 'pan': '0,0', 'rotate': '0'}
            for name, value in values.items():
                (fb / name).write_text(value + '\n')
            model = root / 'model'
            model.write_bytes(b'Anbernic RG353V\0')
            device = root / 'framebuffer'
            device.write_bytes(b'unchanged')
            dt = root / 'dt'
            dt.mkdir()
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            fbset = bin_dir / 'fbset'
            fbset.write_text('#!/bin/sh\necho "geometry 640 480 640 480 32"\necho "rgba 8/16,8/8,8/0,0/0"\n')
            fbset.chmod(0o755)
            script = (ROOT / 'rocknix/device/boot-splash.sh').read_text()
            script = script.replace('/flash', str(flash)).replace('/proc/device-tree/model', str(model)).replace('/proc/device-tree', str(dt)).replace('/sys/class/graphics/fb0', str(fb)).replace('/dev/fb0', str(device))
            consoles = root / 'vtconsole'
            for name, label in (('vtcon0', '(S) dummy device'), ('vtcon1', '(M) frame buffer device')):
                (consoles / name).mkdir(parents=True)
                (consoles / name / 'name').write_text(label + '\n')
                (consoles / name / 'bind').write_text('1\n')
            self.assertIn('/sys/class/vtconsole', script)
            script = script.replace('/sys/class/vtconsole', str(consoles))
            status = root / 'splash.status'
            script = script.replace('/run/cubby-splash.status', str(status))
            import os
            import shutil
            # Only applets enabled in pinned busybox-init.conf are in PATH.
            for applet in ('cat', 'tr', 'sha256sum', 'grep', 'dd'):
                (bin_dir / applet).symlink_to(shutil.which(applet))
            env = dict(os.environ, PATH=str(bin_dir))
            def run():
                return subprocess.run(['/bin/sh', '-c', script + '\ncubby_show_splash'], env=env, capture_output=True)
            self.assertEqual(run().returncode, 0)
            expected = (flash / 'cubby-splash/splash-32.raw').read_bytes()
            self.assertEqual(device.read_bytes(), expected)
            self.assertEqual(status.read_text(), 'rendered 640x480 32\n')
            # The text console would clear the art as systemd starts.
            self.assertEqual((consoles / 'vtcon1/bind').read_text(), '0\n')
            self.assertEqual((consoles / 'vtcon0/bind').read_text(), '1\n')
            (fb / 'bits_per_pixel').write_text('16')
            (fb / 'stride').write_text('1280')
            fbset.write_text('#!/bin/sh\necho "geometry 640 480 640 480 16"\necho "rgba 5/11,6/5,5/0,0/0"\n')
            self.assertEqual(run().returncode, 0)
            self.assertEqual(device.read_bytes(), (flash / 'cubby-splash/splash-16.raw').read_bytes())
            self.assertEqual(status.read_text(), 'rendered 640x480 16\n')
            (fb / 'bits_per_pixel').write_text('32')
            (fb / 'stride').write_text('2560')
            fbset.write_text('#!/bin/sh\necho "geometry 640 480 640 480 32"\necho "rgba 8/16,8/8,8/0,0/0"\n')
            model.write_bytes(b'Anbernic RG353VS\0')
            device.write_bytes(b'unchanged')
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual(device.read_bytes(), b'unchanged')
            model.write_bytes(b'Anbernic RG353V\0')
            for name, bad in [('stride', '3000'), ('pan', '0,480'), ('virtual_size', '480,640'), ('rotate', '1')]:
                (fb / name).write_text(bad)
                device.write_bytes(b'unchanged')
                self.assertNotEqual(run().returncode, 0)
                self.assertEqual(device.read_bytes(), b'unchanged')
                (fb / name).write_text(values[name])
            (dt / 'rotation').write_bytes(bytes([0, 0, 1, 14]))  # 270 degrees
            self.assertNotEqual(run().returncode, 0)
            (dt / 'rotation').unlink()
            status.unlink()
            (bin_dir / 'dd').unlink()
            (bin_dir / 'dd').write_text('#!/bin/sh\nexit 1\n')
            (bin_dir / 'dd').chmod(0o755)
            self.assertNotEqual(run().returncode, 0)
            self.assertFalse(status.exists())
            (flash / 'CUBBY-DISABLED').touch()
            self.assertNotEqual(run().returncode, 0)
            (flash / 'CUBBY-DISABLED').unlink()
            (flash / 'cubby-splash/splash-32.raw').write_bytes(b'truncated')
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual(device.read_bytes(), b'unchanged')

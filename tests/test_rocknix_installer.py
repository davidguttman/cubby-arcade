"""Host installer validation must complete before any device mutation."""
import hashlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('rocknix_install', Path(__file__).parents[1] / 'rocknix/install.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def bundle(self, directory, extra=None):
        target = Path(directory) / 'bundle.tar.gz'
        with tarfile.open(target, 'w:gz') as archive:
            for name in sorted(installer.REQUIRED | set(extra or [])):
                info = tarfile.TarInfo(name)
                info.size = 1
                archive.addfile(info, io.BytesIO(b'x'))
        return target, hashlib.sha256(target.read_bytes()).hexdigest()

    def test_bad_hash_never_connects(self):
        with tempfile.TemporaryDirectory() as directory:
            target, _ = self.bundle(directory)
            with patch.object(installer.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'mismatch'):
                    installer.install('192.168.1.9', 22, target, '0' * 64)
                run.assert_not_called()

    def test_traversal_never_connects(self):
        with tempfile.TemporaryDirectory() as directory:
            target, digest = self.bundle(directory, ['../outside'])
            with patch.object(installer.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'Unsafe'):
                    installer.install('192.168.1.9', 22, target, digest)
                run.assert_not_called()

    def test_failed_preflight_never_uploads(self):
        with tempfile.TemporaryDirectory() as directory:
            target, digest = self.bundle(directory)
            with patch.object(installer.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'ssh')) as run:
                with self.assertRaises(subprocess.CalledProcessError):
                    installer.install('192.168.1.9', 22, target, digest)
                self.assertEqual(run.call_count, 2)
                self.assertEqual(run.call_args.args[0][-2:], ['-O', 'exit'])

    def test_ordered_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            target, digest = self.bundle(directory)
            with patch.object(installer.subprocess, 'run') as run:
                installer.install('192.168.1.9', 22, target, digest)
                calls = [call.args[0] for call in run.call_args_list]
                self.assertEqual(len(calls), 4)
                self.assertEqual(calls[0][-3:], ['bash', '-s', '--'])
                self.assertIn('cat > /storage/cubby-upload-', calls[1][-1])
                self.assertEqual(calls[2][-1], digest)
                self.assertEqual(calls[3][-2:], ['-O', 'exit'])

    def test_rejects_target_option_injection(self):
        for host in ['-oProxyCommand=oops', 'root@host', 'host;id', 'host\nwhoami']:
            with self.assertRaises(ValueError):
                installer.connection(host, 22)

    def test_scripts_parse(self):
        for script in (installer.HERE / 'device').glob('*.sh'):
            subprocess.run(['bash', '-n', str(script)], check=True)


class DeviceBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.storage = self.root / 'storage'
        self.base = self.storage / 'cubby'
        self.base.mkdir(parents=True)
        (self.root / 'run').mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.write_executable(self.bin / 'sleep', '#!/bin/sh\nexit 0\n')
        self.stock = self.bin / 'stock-es'
        self.write_executable(self.stock, '#!/bin/sh\necho STOCK\n')
        import os
        self.env = dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'])

    def write_executable(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o755)

    def run_script(self, name, *args, check=True):
        source = (installer.HERE / 'device' / name).read_text()
        source = source.replace('/storage', str(self.storage))
        source = source.replace('/run/cubby-launch-failures', str(self.root / 'run/failures'))
        source = source.replace('/usr/bin/start_es.sh', str(self.stock))
        path = self.root / name
        path.write_text(source)
        return subprocess.run(['bash', str(path), *args], env=self.env,
                              capture_output=True, text=True, check=check)

    def prepare_launch(self):
        release = self.base / 'releases/test'
        self.write_executable(release / 'rootfs/usr/bin/cog', '#!/bin/sh\nexit 0\n')
        (release / 'app/rocknix').mkdir(parents=True)
        (release / 'app/rocknix/session.sh').touch()
        calls = self.root / 'launch-calls'
        self.write_executable(release / 'device/chroot-run.sh',
                              '#!/bin/sh\necho launch >> ' + str(calls) + '\nexit 1\n')
        (self.base / 'current').symlink_to('releases/test')
        return calls

    def test_missing_current_falls_back_to_stock(self):
        result = self.run_script('launch.sh')
        self.assertEqual(result.stdout.strip(), 'STOCK')

    def test_escape_file_skips_cubby(self):
        calls = self.prepare_launch()
        (self.base / 'DISABLED').touch()
        result = self.run_script('launch.sh')
        self.assertEqual(result.stdout.strip(), 'STOCK')
        self.assertFalse(calls.exists())

    def test_failure_budget_is_bounded_and_persists_for_boot(self):
        calls = self.prepare_launch()
        self.assertEqual(self.run_script('launch.sh').stdout.strip(), 'STOCK')
        self.assertEqual(len(calls.read_text().splitlines()), 3)
        self.assertEqual(self.run_script('launch.sh').stdout.strip(), 'STOCK')
        self.assertEqual(len(calls.read_text().splitlines()), 3)

    def setup_existing_release(self):
        payload = b'fixture upload'
        digest = hashlib.sha256(payload).hexdigest()
        (self.storage / ('cubby-upload-' + digest + '.tar.gz')).write_bytes(payload)
        release = self.base / 'releases' / digest
        self.write_executable(release / 'rootfs/usr/bin/cog', '#!/bin/sh\nexit 0\n')
        self.write_executable(release / 'rootfs/usr/bin/python3', '#!/bin/sh\nexit 0\n')
        self.write_executable(release / 'device/launch.sh', '#!/bin/sh\nexit 0\n')
        (release / 'app/rocknix').mkdir(parents=True)
        (release / 'app/rocknix/session.sh').touch()
        self.write_executable(self.bin / 'chroot', '#!/bin/sh\nexit 0\n')
        drop = self.storage / '.config/system.d/essway.service.d/90-cubby.conf'
        drop.parent.mkdir(parents=True)
        drop.write_text('# Managed by Cubby Arcade RG353V installer\nOLD CONTENT\n')
        (self.base / 'current').symlink_to('releases/old-release')
        return digest, drop

    def test_failed_activation_restores_previous_startup_and_disabled(self):
        digest, drop = self.setup_existing_release()
        before = drop.read_text()
        (self.base / 'DISABLED').touch()
        once = self.root / 'failed-once'
        self.write_executable(self.bin / 'systemctl',
            '#!/bin/sh\nif [ "$1" = restart ] && [ ! -e ' + str(once) + ' ]; then touch ' + str(once) + '; exit 1; fi\nexit 0\n')
        result = self.run_script('install.sh', digest, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.base / 'current').readlink(), Path('releases/old-release'))
        self.assertEqual(drop.read_text(), before)
        self.assertTrue((self.base / 'DISABLED').exists())
        self.assertEqual(list((self.base / 'releases').glob('.stage-*')), [])

    def test_same_bundle_reinstall_and_uninstall_keep_state(self):
        digest, drop = self.setup_existing_release()
        self.write_executable(self.bin / 'systemctl', '#!/bin/sh\nexit 0\n')
        save = self.base / 'state/save.json'
        save.parent.mkdir()
        save.write_text('{"level":4}')
        self.run_script('install.sh', digest)
        self.assertEqual((self.base / 'current').readlink(), Path('releases/' + digest))
        self.run_script('uninstall.sh')
        self.assertFalse(drop.exists())
        self.assertTrue((self.base / 'DISABLED').exists())
        self.assertEqual(save.read_text(), '{"level":4}')

    def test_uninstall_refuses_unmanaged_dropin(self):
        _, drop = self.setup_existing_release()
        drop.write_text('somebody else owns this\n')
        result = self.run_script('uninstall.sh', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(drop.read_text(), 'somebody else owns this\n')


if __name__ == '__main__':
    unittest.main()

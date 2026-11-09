"""Optional native management must not open a consumer device or escape its owner."""
import importlib.util
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('management', ROOT/'rocknix/device/management.py')
management = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(management)


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root/'storage/cubby'
        self.app = self.base/'releases/test/app'
        self.app.mkdir(parents=True)
        (self.base/'current').symlink_to('releases/test')
        self.flash = self.root/'flash'
        self.flash.mkdir()
        self.gadgets = self.root/'gadgets'
        self.gadgets.mkdir()
        self.worker = management.Management(self.app, flash=self.flash, gadgets=self.gadgets)
        self.addCleanup(self.worker.close)
        self.key = self.root/'identity'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.key)], check=True)

    def provision(self):
        path = self.flash/'cubby-setup/authorized_keys'
        path.parent.mkdir()
        path.write_bytes(self.key.with_suffix('.pub').read_bytes())
        return path

    def test_missing_or_invalid_provisioning_never_touches_native_tools(self):
        with patch.object(management.subprocess, 'run') as run, patch.object(management.subprocess, 'Popen') as popen:
            self.worker.tick()
            self.provision().write_text('not a public key\n')
            self.worker.tick()
            run.assert_not_called()
            popen.assert_not_called()
        self.assertFalse(self.worker.private.exists())

    def test_trial_development_and_rolled_back_releases_cannot_activate(self):
        self.provision()
        pending = self.base/'updates/pending.json'
        pending.parent.mkdir()
        pending.write_text('{}')
        self.assertFalse(self.worker.confirmed())
        pending.unlink()
        self.assertTrue(self.worker.confirmed())
        (self.base/'current').unlink()
        (self.base/'current').symlink_to('releases/other')
        self.assertFalse(self.worker.confirmed())
        self.assertFalse(management.Management(ROOT).confirmed())

    def test_secure_unique_persistent_identity_and_real_sshd_config(self):
        source = self.provision()
        self.worker.prepare(source.read_text())
        original = self.worker.host_key.read_bytes()
        self.worker.prepare(source.read_text())
        self.assertEqual(self.worker.host_key.read_bytes(), original)
        self.assertNotIn('state', self.worker.host_key.parts)
        self.assertEqual(self.worker.private.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.worker.host_key.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.worker.keys.stat().st_mode & 0o777, 0o600)
        config = self.worker.config.read_text()
        for value in ['Port 2222', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
                      'AuthenticationMethods publickey', 'PermitRootLogin prohibit-password',
                      'AllowUsers root', 'HostKey ' + management.quoted(self.worker.host_key),
                      'AuthorizedKeysFile ' + management.quoted(self.worker.keys)]:
            self.assertIn(value, config)
        if shutil.which('sshd'):
            result = subprocess.run(['sshd', '-T', '-f', str(self.worker.config)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('port 2222', result.stdout.lower())
        other_app = self.root/'other/cubby/releases/test/app'
        other_app.mkdir(parents=True)
        other = management.Management(other_app)
        self.addCleanup(other.close)
        other.prepare(source.read_text())
        self.assertNotEqual(other.host_key.read_bytes(), original)
        self.worker.close()

    def test_valid_public_key_validation_rejects_options_private_and_garbage(self):
        public = self.key.with_suffix('.pub').read_text()
        self.assertTrue(management.valid_keys(public))
        for invalid in ['', 'command="anything" ' + public, self.key.read_text(),
                        'ssh-ed25519 Zm9v\n', public + 'garbage\n']:
            self.assertFalse(management.valid_keys(invalid), invalid[:30])

    def test_usb_repair_waits_for_stock_and_only_selects_prepared_unbound_gadget(self):
        gadget = self.gadgets/'rockchip'
        gadget.mkdir()
        (gadget/'UDC').write_text('')
        run = Mock(return_value=subprocess.CompletedProcess([], 0, stdout='activating\n'))
        self.assertFalse(self.worker.restore_usb(run))
        self.assertEqual(len(run.call_args_list), 1)
        run.return_value.stdout = 'active\n'
        self.assertTrue(self.worker.restore_usb(run))
        self.assertEqual(run.call_args.args[0], ['/usr/bin/usbgadget', 'network'])
        run.reset_mock()
        (gadget/'UDC').write_text('fe800000.usb')
        self.assertTrue(self.worker.restore_usb(run))
        self.assertFalse(any(call.args[0][0] == '/usr/bin/usbgadget' for call in run.call_args_list))
        (self.flash/'CUBBY-USB-DISABLED').touch()
        run.reset_mock()
        self.assertTrue(self.worker.restore_usb(run))
        run.assert_not_called()

    def test_explicit_management_optout_never_runs(self):
        self.provision()
        (self.flash/'CUBBY-MANAGEMENT-DISABLED').touch()
        with patch.object(self.worker, 'prepare') as prepare:
            self.worker.tick()
            prepare.assert_not_called()

    def test_failed_native_configuration_cannot_launch_listener(self):
        self.provision()
        with patch.object(self.worker, 'prepare', side_effect=subprocess.CalledProcessError(1, ['sshd', '-t'])), \
             patch.object(management, 'valid_keys', return_value=True), \
             patch.object(management.subprocess, 'Popen') as popen:
            with self.assertRaises(subprocess.CalledProcessError):
                self.worker.tick()
            popen.assert_not_called()

    def test_listener_is_validated_supervised_and_closed(self):
        self.provision()
        proc = Mock()
        proc.poll.return_value = None
        self.worker.prepare(self.key.with_suffix('.pub').read_text())
        with patch.object(self.worker, 'restore_usb', return_value=True), \
             patch.object(self.worker, 'prepare') as prepare, \
             patch.object(management, 'valid_keys', return_value=True), \
             patch.object(management.subprocess, 'Popen', return_value=proc) as popen:
            self.worker.tick()
            self.assertEqual(popen.call_args.args[0], ['/usr/sbin/sshd', '-D', '-e', '-f', str(self.worker.config)])
            self.worker.tick()
            self.assertEqual(popen.call_count, 1)
            self.worker.close()
            prepare.assert_called_once()
            proc.terminate.assert_called_once()
            proc.wait.assert_called()

    def test_revocation_stops_listener_and_other_worker_cannot_claim_identity(self):
        source = self.provision()
        self.worker.prepare(source.read_text())
        other = management.Management(self.app, flash=self.flash, gadgets=self.gadgets)
        self.addCleanup(other.close)
        with self.assertRaises(BlockingIOError):
            other.prepare(source.read_text())
        proc = Mock()
        proc.poll.return_value = None
        self.worker.process = proc
        source.write_bytes(b'\xff')
        self.worker.tick()
        proc.terminate.assert_called_once()
        self.worker.close()

    def test_usb_failure_does_not_drop_working_wifi_listener(self):
        source = self.provision()
        proc = Mock()
        proc.poll.return_value = None
        self.worker.process = proc
        self.worker.active_keys = source.read_text()
        with patch.object(self.worker, 'restore_usb', side_effect=OSError('USB unavailable')):
            self.worker.tick()
        self.assertIs(self.worker.process, proc)
        proc.terminate.assert_not_called()

    def test_worker_close_reaps_real_owned_process(self):
        # No SSH listener: exercise actual child termination rather than only mocks.
        self.worker.process = subprocess.Popen(['sleep', '60'])
        proc = self.worker.process
        self.worker.thread = threading.Thread(target=self.worker.run)
        self.worker.thread.start()
        self.worker.close()
        self.assertIsNotNone(proc.poll())
        self.assertFalse(self.worker.thread.is_alive())

    def test_legacy_signed_archive_carries_module_and_native_network_loads_it(self):
        from rocknix.update_release import app_entries
        entries = dict(app_entries(ROOT))
        name = 'runtime/native/rg353v/device/management.py'
        self.assertEqual(entries[name], ROOT/'rocknix/device/management.py')
        from rocknix.updates import app_path
        self.assertEqual(app_path(name), name)
        network_spec = importlib.util.spec_from_file_location('network_management_test', ROOT/'rocknix/network.py')
        network = importlib.util.module_from_spec(network_spec)
        network_spec.loader.exec_module(network)
        # Exercise the actual dynamic import from the packaged legacy alias.
        bundled = self.app/name
        bundled.parent.mkdir(parents=True)
        shutil.copy2(entries[name], bundled)
        with patch.object(network, '__file__', str(self.app/'rocknix/network.py')):
            controller = network.start_management()
        self.assertIsNotNone(controller)
        self.assertEqual(controller.app, self.app)
        controller.close()

    def test_native_helper_reaps_management_on_sigterm(self):
        from rocknix import network
        server, controller = Mock(), Mock()
        server.serve_forever.side_effect = lambda: signal.raise_signal(signal.SIGTERM)
        previous = signal.getsignal(signal.SIGTERM)
        with patch.object(sys, 'argv', ['network.py', '--socket', str(self.root/'socket')]), \
             patch.object(network.os, 'geteuid', return_value=0), \
             patch.object(network.os, 'chmod'), \
             patch.object(network, 'HostServer') as host, \
             patch.object(network.threading, 'Thread'), \
             patch.object(network, 'start_power'), \
             patch.object(network, 'Onboarding'), \
             patch.object(network, 'start_management', return_value=controller):
            host.return_value.__enter__.return_value = server
            with self.assertRaises(SystemExit) as exit:
                network.main()
        self.assertEqual(exit.exception.code, 143)
        controller.close.assert_called_once()
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)


if __name__ == '__main__':
    unittest.main()

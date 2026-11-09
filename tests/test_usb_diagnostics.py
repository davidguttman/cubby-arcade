"""Read-only USB status interface and image boot wiring."""
import importlib.util
import errno
import io
import json
from pathlib import Path
import socket
import threading
import tempfile
import subprocess
import unittest
from unittest import mock
from urllib.request import urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]

class DiagnosticsTests(unittest.TestCase):
    def module(self):
        spec = importlib.util.spec_from_file_location('cubby_usb', ROOT / 'rocknix/device/usb-diagnostics.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_read_only_http_has_no_file_or_command_endpoint(self):
        module = self.module()
        with mock.patch.object(module, 'snapshot', return_value={'boot_id':'fixture','units':'failed cog'}):
            server = module.DiagnosticsServer(('127.0.0.1', 0), module.Handler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                address = 'http://127.0.0.1:' + str(server.server_port)
                with urlopen(address + '/status') as response:
                    self.assertEqual(json.load(response)['boot_id'], 'fixture')
                for path in ('/etc/shadow', '/status?cmd=reboot', '/reboot'):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(address + path)
                    self.assertEqual(error.exception.code, 404)
                from urllib.request import Request
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(address+'/status', data=b'reboot'))
                self.assertEqual(error.exception.code, 501)
            finally:
                server.shutdown(); server.server_close(); worker.join()

    def test_usb_listener_binds_device_before_address_and_never_all_interfaces(self):
        module = self.module()
        fake = mock.Mock()
        fake.getsockname.return_value = ('169.254.170.2', 8765)
        with mock.patch.object(module.socket, 'socket', return_value=fake):
            server = module.usb_server()
            fake.setsockopt.assert_any_call(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, b'gadget\0')
            fake.bind.assert_called_once_with(('169.254.170.2', 8765))
            server.server_close()

    def test_boot_hook_registers_independent_service_even_when_cubby_disabled(self):
        from rocknix.image import BOOT_HOOK
        self.assertIn('cubby-usb-diagnostics.service', BOOT_HOOK)
        hook_prefix = BOOT_HOOK.split('[ ! -e /flash/CUBBY-DISABLED ]')[0]
        self.assertIn('cubby-usb-diagnostics.service', hook_prefix)
        unit = (ROOT/'rocknix/device/cubby-usb-diagnostics.service').read_text()
        self.assertIn('After=local-fs.target rocknix-autostart.service', unit)
        self.assertNotIn('Requires=essway', unit)
        self.assertIn('/flash/cubby-usb-diagnostics/start.sh', unit)
        script = (ROOT/'rocknix/device/usb-diagnostics-start.sh').read_text()
        self.assertIn('/usr/bin/usbgadget network', script)
        self.assertIn('USB_MODE=cdc', script)

    def test_startup_cooperates_with_native_boot_and_repeated_listener_starts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in ('run', 'storage/.cache', 'flash', 'etc'):
                (root/path).mkdir(parents=True, exist_ok=True)
            (root/'etc/machine-id').write_text('0123456789abcdef0123456789abcdef')
            gadget = root/'usbgadget'
            # Model the pinned ROCKNIX 20261101 lifecycle: --start first
            # unbinds, prepares CDC, then unconditionally creates MTP. A second
            # --start therefore fails before rebinding; `network` only selects
            # the already prepared CDC gadget and is safe to repeat.
            gadget.write_text('''#!/bin/sh
set -e
cd "''' + str(root) + '''"
printf '%s\\n' "$*" >> calls
case "$1" in
  --start)
    printf '' > UDC
    mkdir -p cdc
    mkdir mtp
    USB_MODE=disabled
    [ ! -f storage/.cache/usbgadget/usbgadget.conf ] || . ./storage/.cache/usbgadget/usbgadget.conf
    [ "$USB_MODE" != cdc ] || printf controller > UDC
    ;;
  network)
    [ -d cdc ]
    printf controller > UDC
    ;;
  *) exit 2 ;;
esac
''')
            gadget.chmod(0o755)
            script = (ROOT/'rocknix/device/usb-diagnostics-start.sh').read_text()
            for original in ('/storage', '/run', '/flash', '/etc'):
                script = script.replace(original, str(root)+original)
            script = script.replace('/usr/bin/usbgadget', str(gadget))
            unit = (ROOT/'rocknix/device/cubby-usb-diagnostics.service').read_text()
            if 'Before=rocknix-autostart.service' in unit:
                subprocess.run(['/bin/sh', '-c', script], check=True)
            native = subprocess.run([str(gadget), '--start'], capture_output=True)
            for _ in range(2):
                subprocess.run(['/bin/sh', '-c', script], check=True)
            self.assertEqual(native.returncode, 0, native.stderr.decode())
            self.assertEqual((root/'UDC').read_text(), 'controller')
            self.assertEqual((root/'calls').read_text().splitlines(), ['--start', 'network', 'network'])
            self.assertEqual((root/'storage/.cache/usbgadget/usbgadget.conf').read_text(), 'USB_MODE=cdc\n')
            self.assertFalse((root/'run/cubby-usb-initialized').exists())
            # A stale old marker must not suppress restoring an unbound gadget.
            (root/'run/cubby-usb-initialized').touch()
            (root/'UDC').write_text('')
            subprocess.run(['/bin/sh', '-c', script], check=True)
            self.assertEqual((root/'UDC').read_text(), 'controller')
            (root/'flash/CUBBY-USB-DISABLED').touch()
            before = (root/'calls').read_text()
            (root/'storage/.cache/usbgadget/usbgadget.conf').write_text('USB_MODE=disabled\n')
            subprocess.run(['/bin/sh', '-c', script], check=True)
            self.assertEqual((root/'calls').read_text(), before)
            self.assertEqual((root/'storage/.cache/usbgadget/usbgadget.conf').read_text(), 'USB_MODE=disabled\n')

    def test_optout_does_not_create_runtime_config_or_invoke_native_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'flash').mkdir()
            (root/'flash/CUBBY-USB-DISABLED').touch()
            script = (ROOT/'rocknix/device/usb-diagnostics-start.sh').read_text()
            for original in ('/storage', '/run', '/flash', '/etc'):
                script = script.replace(original, str(root)+original)
            script = script.replace('/usr/bin/usbgadget', '/does-not-exist')
            subprocess.run(['/bin/sh', '-c', script], check=True)
            self.assertEqual(sorted(path.name for path in root.iterdir()), ['flash'])

    def test_command_capture_timeout_and_limit(self):
        module = self.module()
        result = module.capture(['/bin/sh', '-c', 'printf 123456789'], limit=4)
        self.assertEqual(result['output'], '6789')
        self.assertTrue(result['truncated'])
        result = module.capture(['/bin/sleep', '2'], timeout=.01)
        self.assertIn('timeout', result['error'])

    def test_snapshot_includes_bounded_session_and_wifi_evidence(self):
        module = self.module()
        with mock.patch.object(module, 'capture', return_value={}), \
             mock.patch.object(module, 'read', return_value='fixture'), \
             mock.patch.object(module, 'tail', side_effect=lambda path: path):
            result = module.snapshot()
        self.assertEqual(result['session_log'], '/storage/cubby/state/session.log')
        self.assertEqual(result['previous_session_log'], '/storage/cubby/state/session.previous.log')
        self.assertEqual(result['wifi_recovery'], '/storage/cubby/diagnostics/wifi-recovery.txt')

    def test_persistence_failure_keeps_serving_and_throttles_retries(self):
        for operation, code in (('mkdir', errno.ENOSPC),
                                ('write_text', errno.EROFS),
                                ('replace', errno.ENOSPC)):
            with self.subTest(operation=operation):
                module = self.module()
                server = mock.Mock()
                server.handle_request.side_effect = [None, None, None, StopIteration]
                error = OSError(code, 'snapshot storage unavailable')
                failures = {'side_effect': error}
                with mock.patch.object(module, 'usb_server', return_value=server), \
                     mock.patch.object(module.socket, 'if_nametoindex', return_value=4), \
                     mock.patch.object(module.time, 'monotonic', side_effect=[100, 101, 116]), \
                     mock.patch.object(module, 'snapshot', return_value={'boot_id': 'fixture'}), \
                     mock.patch.object(module.Path, 'mkdir', **(failures if operation == 'mkdir' else {})) as mkdir, \
                     mock.patch.object(module.Path, 'write_text', **(failures if operation == 'write_text' else {})) as write, \
                     mock.patch.object(module.os, 'replace', **(failures if operation == 'replace' else {})) as replace, \
                     mock.patch('sys.stderr', new_callable=io.StringIO) as stderr:
                    with self.assertRaises(StopIteration):
                        module.main()
                self.assertEqual(server.handle_request.call_count, 4)
                failed = {'mkdir': mkdir, 'write_text': write, 'replace': replace}[operation]
                self.assertEqual(failed.call_count, 2)
                self.assertEqual(stderr.getvalue().count('snapshot storage unavailable'), 2)

if __name__ == '__main__': unittest.main()

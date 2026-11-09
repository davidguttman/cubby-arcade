"""No host networking: process and HTTP fixtures only."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from rocknix import network


class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_successful_connect_survives_stock_radio_boot_setting(self):
        import subprocess
        os_release = self.root / 'os-release'
        os_release.write_text('OS_NAME="ROCKNIX"\nOS_VERSION="20261101"\n')
        settings = {'wifi.enabled': '0'}
        calls = []
        def write_setting(argv, **kwargs):
            calls.append((argv, kwargs))
            settings['wifi.enabled'] = argv[-1]
            return subprocess.CompletedProcess(argv, 0)
        adapter = network.NetworkManager(profiles=self.root / 'profiles')
        adapter.command = lambda *args, **kwargs: ''
        adapter.scan = lambda: [{'ssid': 'Private home', 'bssid': 'AA:BB:CC:DD:EE:FF',
                                'security': 'WPA2', 'supported': True}]
        persist = network.persist_wifi_enabled
        with patch.object(network, 'persist_wifi_enabled', side_effect=lambda: persist(os_release)), \
             patch.object(network.subprocess, 'run', side_effect=write_setting), \
             patch.object(network, 'internet_available', return_value=True):
            self.assertTrue(adapter.connect('AA:BB:CC:DD:EE:FF', 'secret pass')['internet'])
        # Stock 080-network disables the radio at boot if this flag is zero.
        self.assertEqual(settings['wifi.enabled'], '1')
        self.assertEqual(calls[0][0], ['/usr/bin/rocknix-settings', '--command', 'write',
                                     '--key', 'wifi.enabled', '--value', '1'])
        self.assertNotIn('secret pass', repr(calls))
        self.assertNotIn('Private home', repr(calls))

    def test_native_setting_failure_does_not_report_persistent_connection(self):
        adapter = network.NetworkManager(profiles=self.root)
        calls = []
        adapter.command = lambda *args, **kwargs: calls.append(args) or ''
        adapter.scan = lambda: [{'ssid': 'Cafe', 'bssid': 'AA:BB:CC:DD:EE:FF',
                                'security': 'WPA2', 'supported': True}]
        with patch.object(network, 'persist_wifi_enabled', side_effect=network.NetworkError('unavailable')):
            with self.assertRaisesRegex(network.NetworkError, '^connection_failed$'):
                adapter.connect('AA:BB:CC:DD:EE:FF', 'secret pass')
        self.assertFalse(list(self.root.glob('*.nmconnection')))
        self.assertIn('delete', repr(calls))

    def test_native_setting_is_never_written_for_failed_connection(self):
        adapter = network.NetworkManager(profiles=self.root)
        adapter.scan = lambda: [{'ssid': 'Cafe', 'bssid': 'AA:BB:CC:DD:EE:FF',
                                'security': 'WPA2', 'supported': True}]
        adapter.command = lambda *args, **kwargs: (_ for _ in ()).throw(network.NetworkError('connection_failed'))
        with patch.object(network, 'persist_wifi_enabled') as persist:
            with self.assertRaises(network.NetworkError):
                adapter.connect('AA:BB:CC:DD:EE:FF', 'secret pass')
        persist.assert_not_called()

    def test_native_setting_skips_other_hosts_and_bounds_private_command_failure(self):
        import subprocess
        os_release = self.root / 'os-release'
        os_release.write_text('NAME="Other Linux"\n')
        with patch.object(network.subprocess, 'run') as run:
            network.persist_wifi_enabled(os_release)
        run.assert_not_called()
        os_release.write_text('OS_NAME="ROCKNIX"\n')
        for failure in [subprocess.CompletedProcess([], 1), OSError('private'),
                        subprocess.TimeoutExpired('private', 10)]:
            kwargs = {'side_effect': failure} if isinstance(failure, Exception) else {'return_value': failure}
            with patch.object(network.subprocess, 'run', **kwargs) as run:
                with self.assertRaisesRegex(network.NetworkError, '^unavailable$'):
                    network.persist_wifi_enabled(os_release)
                self.assertEqual(run.call_args.kwargs['stdout'], subprocess.DEVNULL)
                self.assertEqual(run.call_args.kwargs['stderr'], subprocess.DEVNULL)
                self.assertEqual(run.call_args.kwargs['timeout'], 10)

    def test_nmcli_escaped_fields_and_enterprise_rejection(self):
        rows = network.parse_scan('*:Cafe\\:One:AA\\:BB\\:CC\\:DD\\:EE\\:FF:82:WPA2\n'
                                  ':Enterprise:11\\:22\\:33\\:44\\:55\\:66:50:WPA2 802.1X\n')
        self.assertEqual(rows[0]['ssid'], 'Cafe:One')
        self.assertEqual(rows[0]['bssid'], 'AA:BB:CC:DD:EE:FF')
        self.assertTrue(rows[0]['supported'])
        self.assertFalse(rows[1]['supported'])

    def test_profile_has_private_permissions_secrets_not_argv_and_persists(self):
        adapter = network.NetworkManager(profiles=self.root)
        calls = []
        adapter.command = lambda *args, **kw: calls.append(args) or ''
        adapter.scan = lambda: [{'ssid': 'Cafe\\; x', 'bssid': 'AA:BB:CC:DD:EE:FF',
                                'security': 'WPA2', 'supported': True}]
        with patch.object(network, 'internet_available', return_value=True):
            result = adapter.connect('AA:BB:CC:DD:EE:FF', 'secret pass')
        self.assertTrue(result['internet'])
        profile, = list(self.root.glob('*.nmconnection'))
        self.assertEqual(profile.stat().st_mode & 0o777, 0o600)
        self.assertIn(r'psk=secret\spass', profile.read_text())
        self.assertNotIn('secret pass', repr(calls))
        self.assertIn('connection.autoconnect', repr(calls))

    def test_connection_failure_removes_only_owned_profile_and_hides_secrets(self):
        adapter = network.NetworkManager(profiles=self.root)
        keep = self.root / 'adult.nmconnection'
        keep.write_text('old')
        adapter.scan = lambda: [{'ssid': 'Cafe', 'bssid': 'AA:BB:CC:DD:EE:FF',
                                'security': 'WPA2', 'supported': True}]
        def command(*args, **kw):
            if 'up' in args:
                raise network.NetworkError('connection_failed')
            return ''
        adapter.command = command
        with self.assertRaisesRegex(network.NetworkError, '^connection_failed$'):
            adapter.connect('AA:BB:CC:DD:EE:FF', 'secret pass')
        self.assertEqual(list(self.root.iterdir()), [keep])

    def test_captive_portal_does_not_complete_onboarding(self):
        manager = network.Onboarding(network.Simulation(), self.root)
        manager.adapter.online = False
        self.assertFalse(manager.finish()['complete'])
        self.assertFalse(manager.complete)
        manager.adapter.online = True
        self.assertTrue(manager.finish()['complete'])
        manager.adapter.online = False
        self.assertTrue(manager.status()['complete'])
        self.assertFalse(manager.status()['internet'])

    def test_bad_requests_cannot_be_shell_commands_or_change_unknown_network(self):
        adapter = network.NetworkManager(profiles=self.root)
        adapter.scan = lambda: []
        for request in [('$(touch evil)', 'secret pass'), ('AA:BB:CC:DD:EE:FF', 'x\nsecret')]:
            with self.assertRaises(network.NetworkError): adapter.connect(*request)
        manager = network.Onboarding(network.Simulation(), self.root)
        with self.assertRaises(network.NetworkError): manager.dispatch({'action': 'shell', 'command': 'id'})
        with self.assertRaises(network.NetworkError): manager.dispatch({'action': 'scan', 'extra': True})

    def test_generated_profile_is_accepted_by_real_nmcli_offline_parser(self):
        import shutil
        import subprocess
        executable = shutil.which('nmcli')
        if not executable:
            self.skipTest('nmcli offline parser not installed on development host')
        adapter = network.NetworkManager(profiles=self.root)
        adapter.scan = lambda: [{'ssid': 'Cafe ; unicode é', 'bssid': 'AA:BB:CC:DD:EE:FF',
                                'security': 'WPA2', 'supported': True}]
        adapter.command = lambda *args, **kwargs: ''
        with patch.object(network, 'internet_available', return_value=True):
            adapter.connect('AA:BB:CC:DD:EE:FF', r'secret \\; key')
        profile, = self.root.glob('*.nmconnection')
        result = subprocess.run([executable, '--offline', 'connection', 'modify', 'connection.id', 'fixture'],
                                input=profile.read_bytes(), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, 'Offline NM parser rejected the generated profile')

    def test_tls_catalog_probe_rejects_portal_redirect_oversize_and_bad_json(self):
        import io
        def probe(data, status=200):
            response = io.BytesIO(data)
            response.status = status
            opener = type('Opener', (), {'open': lambda *_args, **_kwargs: response})()
            with patch.object(network.urllib.request, 'build_opener', return_value=opener):
                return network.internet_available()
        self.assertFalse(probe(b'<html>Log in</html>'))
        self.assertFalse(probe(b'[]'))
        self.assertFalse(probe(b'{}'))
        self.assertFalse(probe(b' ' * (1024*1024+1)))
        self.assertFalse(probe(b'[{"id":"game","manifest_url":"https://example.test/manifest.json"}]', 302))
        self.assertTrue(probe(b'[{"id":"game","manifest_url":"https://example.test/manifest.json"}]'))
        with self.assertRaises(network.NetworkError):
            network.NoRedirect().redirect_request(None, None, 302, None, None, 'https://portal.invalid')

    def test_command_does_not_return_error_output_or_include_credentials_in_exceptions(self):
        import subprocess
        adapter = network.NetworkManager(profiles=self.root)
        error = subprocess.CompletedProcess(['nmcli'], 1, stdout=b'sensitive output', stderr=b'private')
        with patch.object(network.subprocess, 'run', return_value=error) as run:
            with self.assertRaisesRegex(network.NetworkError, '^connection_failed$'):
                adapter.command('device', 'status')
            self.assertEqual(run.call_args.kwargs['stderr'], subprocess.DEVNULL)
            self.assertEqual(run.call_args.kwargs['stdin'], subprocess.DEVNULL)


class NetworkHttpTests(unittest.TestCase):
    def setUp(self):
        import threading
        from rocknix.server import State, make_server
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.manager = network.Onboarding(network.Simulation(), self.root)
        self.state = State(Path(__file__).resolve().parents[1], self.root, self.manager)
        self.server = make_server(self.state, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.shutdown)
        self.origin = 'http://127.0.0.1:' + str(self.server.server_address[1])

    def request(self, method, path, body=None, **headers):
        import http.client
        defaults = {'Origin': self.origin, 'Referer': self.origin + '/adult/network',
                    'Content-Type': 'application/json', 'X-Cubby-Session': self.state.adult_token}
        defaults.update(headers)
        client = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        client.request(method, path, json.dumps(body) if body is not None else None, headers=defaults)
        response = client.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        client.close()
        return result

    def test_network_reply_is_sent_only_after_the_busy_flag_clears(self):
        from rocknix.server import Handler
        seen = []
        original = Handler.json_response
        def spy(handler, value, status=200):
            seen.append(self.state.network_busy)
            original(handler, value, status)
        with patch.object(Handler, 'json_response', spy):
            self.assertEqual(self.request('POST', '/api/network', {'action': 'status'})[0], 200)
        self.assertEqual(seen, [False])

    def test_first_run_cannot_bypass_with_play_or_game_url_and_offline_reboot_allowed(self):
        for path in ['/', '/play', '/runtime/index.html', '/games/demo/0.1/index.html']:
            status, headers, _ = self.request('GET', path)
            self.assertEqual(status, 303)
            self.assertEqual(headers['Location'], '/adult/network')
        status, headers, page = self.request('GET', '/adult/network')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertIn(self.state.adult_token.encode(), page)
        self.assertEqual(self.request('POST', '/api/network', {'action': 'finish'})[0], 200)
        self.assertTrue(self.state.onboarding_required)
        self.assertEqual(self.request('POST', '/api/network', {'action': 'connect',
                         'bssid': '02:00:00:00:00:01', 'password': 'cubby-test'})[0], 200)
        self.assertEqual(self.request('POST', '/api/network', {'action': 'finish'})[0], 200)
        self.assertFalse(self.state.onboarding_required)
        self.manager.adapter.online = False
        status, _, page = self.request('GET', '/')
        self.assertEqual(status, 200)
        self.assertNotIn(self.state.adult_token.encode(), page)

    def test_game_token_cross_site_iframe_and_invalid_operations_rejected(self):
        for headers in [dict(Referer=self.origin + '/games/demo/index.html'),
                        {'X-Cubby-Session': self.state.token}, dict(Origin='http://evil.test')]:
            self.assertEqual(self.request('POST', '/api/network', {'action': 'scan'}, **headers)[0], 403)
        for body in [{'action': 'shell'}, {'action': 'scan', 'extra': 'bad'}]:
            self.assertEqual(self.request('POST', '/api/network', body)[0], 400)
        self.state.active_game = 'demo'
        self.assertEqual(self.request('POST', '/api/network', {'action': 'connect',
                         'bssid': '02:00:00:00:00:01', 'password': 'cubby-test'})[0], 409)


class HostSocketTests(unittest.TestCase):
    def test_real_unix_request_protocol_and_private_listener(self):
        import threading
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'socket'
            manager = network.Onboarding(network.Simulation(), directory)
            with network.HostServer(str(path), network.HostHandler) as server:
                server.manager = manager
                server.allowed_uid = os.geteuid()
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    client = network.HostClient(str(path))
                    self.assertTrue(client.dispatch({'action': 'scan'})['simulation'])
                    with self.assertRaisesRegex(network.NetworkError, '^invalid_request$'):
                        client.dispatch({'action': 'shell', 'command': 'id'})
                    self.assertFalse(client.dispatch({'action': 'finish'})['complete'])
                    client.dispatch({'action': 'connect', 'bssid': '02:00:00:00:00:01', 'password': 'cubby-test'})
                    self.assertTrue(client.dispatch({'action': 'finish'})['complete'])
                    with patch('rocknix.network.threading.Timer') as timer:
                        self.assertEqual(client.dispatch({'action': 'power', 'mode': 'reboot'}), {'accepted': True})
                        timer.assert_called_once_with(.3, network.run_power, ('reboot',))
                        timer.return_value.start.assert_called_once_with()
                        for request in ({'action': 'power'}, {'action': 'power', 'mode': 'halt'},
                                        {'action': 'power', 'mode': 'reboot', 'force': True}):
                            with self.assertRaisesRegex(network.NetworkError, '^invalid_request$'):
                                client.dispatch(request)
                        timer.assert_called_once()
                finally:
                    server.shutdown()
                    thread.join()

    def test_power_runs_only_the_named_systemctl_verb(self):
        with patch('rocknix.network.subprocess.run') as run:
            run.return_value.returncode = 0
            network.run_power('poweroff')
        self.assertEqual(run.call_args.args[0], ['/usr/bin/systemctl', '--no-block', 'poweroff'])

if __name__ == '__main__': unittest.main()

import hashlib
import http.client
import json
import configparser
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from rocknix.network import Onboarding, Simulation
from rocknix.server import State, app_version, check_for_update, make_server, update_attention


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'hosting/releases/line-cutter/0.2.1/line-cutter-0.2.1.game.zip'


class SessionTests(unittest.TestCase):
    def test_gamepad_session_loads_audio_autoplay_policy(self):
        # Exercise the actual launcher without requiring the handheld's Wayland
        # compositor or ARM browser. Only external processes and mount paths are
        # substituted; inspect the config Cog really receives.
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            socket_path = temporary / 'wayland-0'
            with socket.socket(socket.AF_UNIX) as compositor:
                compositor.bind(str(socket_path))
                for name, body in {
                    'python3': 'if [ "$1" = -m ]; then exec sleep 30; fi\nexit 0\n',
                    'cog': ('for argument do\n'
                            '  [ "$argument" != --enable-sandbox ] || exit 2\n'
                            'done\n'
                            'printf "%s\\n" "$@" > "$COG_ARGUMENTS"\n'),
                }.items():
                    executable = temporary / name
                    executable.write_text('#!/bin/sh\n' + body)
                    executable.chmod(0o755)
                script = (ROOT / 'rocknix/session.sh').read_text()
                script = script.replace('cd /opt/cubby', 'cd ' + str(ROOT))
                script = script.replace('/run/host-runtime', str(temporary))
                script = script.replace('/var/lib/handheld', str(temporary / 'state'))
                arguments = temporary / 'arguments'
                environment = dict(os.environ, PATH=str(temporary) + ':' + os.environ['PATH'],
                                   WAYLAND_DISPLAY='wayland-0', COG_ARGUMENTS=str(arguments))
                subprocess.run(['bash', '-c', script], env=environment, check=True, timeout=5)
                received = arguments.read_text().splitlines()
                self.assertIn('--webprocess-failure=exit', received)
                self.assertIn('--config', received)
                config_path = Path(received[received.index('--config') + 1])
                settings = configparser.ConfigParser()
                settings.read(ROOT / config_path)
                self.assertFalse(settings.getboolean('websettings',
                                                     'media-playback-requires-user-gesture'))


class VersionTests(unittest.TestCase):
    def test_reads_the_release_stamp_and_tolerates_unreleased_builds(self):
        with tempfile.TemporaryDirectory() as directory:
            class Holder: app = Path(directory)
            self.assertIsNone(app_version(Holder))
            (Holder.app / 'runtime').mkdir()
            (Holder.app / 'runtime/version.json').write_text('not json')
            self.assertIsNone(app_version(Holder))
            (Holder.app / 'runtime/version.json').write_text('{"version": "1.2.3"}')
            self.assertEqual(app_version(Holder), '1.2.3')


class UpdateWatchTests(unittest.TestCase):
    class Updater:
        def __init__(self, phase): self.phase, self.actions = phase, []
        def dispatch(self, body):
            self.actions.append(body['action'])
            return {'phase': self.phase}

    def state(self, phase='idle', internet=True, busy=False):
        class Holder: pass
        holder = Holder()
        adapter = Simulation(); adapter.online = internet
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        # The real Onboarding interface, so a renamed or missing call fails here.
        holder.updater, holder.network, holder.network_busy = self.Updater(phase), Onboarding(adapter, self.directory.name), busy
        return holder

    def test_checks_only_when_online_from_idle_or_past_failure(self):
        for phase in ('idle', 'error'):
            state = self.state(phase)
            self.assertTrue(check_for_update(state))
            self.assertIn('check', state.updater.actions)

    def test_never_demotes_staged_update_or_overwrites_rollback(self):
        for phase in ('available', 'staged', 'rolled_back', 'checking', 'downloading', 'trial', 'unconfigured'):
            state = self.state(phase)
            self.assertTrue(check_for_update(state))
            self.assertNotIn('check', state.updater.actions)

    def test_offline_or_connecting_stays_silent_and_retries(self):
        for state in (self.state(internet=False), self.state(busy=True)):
            self.assertFalse(check_for_update(state))
            self.assertEqual(state.updater.actions, [])

    def test_unreachable_updater_means_retry_and_no_badge(self):
        state = self.state()
        def fail(_): raise OSError('socket gone')
        state.updater.dispatch = fail
        self.assertFalse(check_for_update(state))
        self.assertFalse(update_attention(state))

    def test_attention_only_for_actionable_phases(self):
        for phase, expected in (('available', True), ('staged', True), ('idle', False),
                                ('error', False), ('rolled_back', False), ('trial', False)):
            self.assertIs(update_attention(self.state(phase)), expected)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = State(ROOT, Path(self.tmp.name))
        payload = PACKAGE.read_bytes()
        self.state.catalog = [{'id': 'line-cutter', 'title': 'Fixture', 'version': '0.2.1',
                               'url': PACKAGE.as_uri(), 'size': len(payload),
                               'sha256': hashlib.sha256(payload).hexdigest()}]
        self.state.developer = True
        logger = patch('rocknix.server.Handler.log_message')
        logger.start()
        self.addCleanup(logger.stop)
        self.httpd = make_server(self.state, port=0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.thread.join)
        self.addCleanup(self.httpd.shutdown)
        self.origin = 'http://127.0.0.1:' + str(self.httpd.server_address[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=5)
        defaults = {'Origin': self.origin, 'Referer': self.origin + '/',
                    'Content-Type': 'application/json', 'X-Cubby-Session': self.state.token}
        defaults.update(headers or {})
        connection.request(method, path, body=json.dumps(body) if body is not None else None,
                           headers=defaults)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def install(self):
        self.assertEqual(self.request('POST', '/api/install', {'id': 'line-cutter'})[0], 202)
        for _ in range(100):
            status = json.loads(self.request('GET', '/api/status')[1]).get('line-cutter', {})
            if status.get('phase') not in {'checking', 'downloading', 'verifying'}:
                return status
            time.sleep(.01)
        self.fail('Install did not finish')

    def test_battery_endpoint_is_device_host_read_only_and_uncached(self):
        value = {'available': True, 'level': 14, 'charging': True}
        with patch('rocknix.server.battery.read_battery', return_value=value) as reader:
            connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=5)
            try:
                connection.request('GET', '/api/battery')
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                self.assertEqual(json.loads(response.read()), value)
            finally:
                connection.close()
            reader.assert_called_once_with()
            self.assertEqual(self.request('GET', '/api/battery', headers={'Host': 'evil.example'})[0], 403)
        with patch('rocknix.server.battery.read_battery', return_value={'available': False}):
            self.assertEqual(json.loads(self.request('GET', '/api/battery')[1]), {'available': False})
        self.assertNotEqual(self.request('POST', '/api/battery', {})[0], 200)

    def test_shared_hub_and_explicit_local_install_roundtrip_preserves_saves(self):
        page = self.request('GET', '/')[1]
        profile = b'window.CubbyDeviceProfile="rg353v"'
        preferences = self.request('GET', '/runtime/core/preferences.js')[1]
        self.assertTrue(preferences.startswith(profile))
        adapter = (ROOT / 'rocknix/gamepad.js').read_bytes()
        self.assertIn(adapter, preferences)
        self.assertTrue(preferences.endswith((ROOT / 'runtime/core/preferences.js').read_bytes()))
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=5)
        try:
            connection.request('GET', '/runtime/core/preferences.js')
            response = connection.getresponse()
            self.assertEqual(response.getheader('Cache-Control'), 'no-store')
            response.read()
        finally:
            connection.close()
        self.assertIn(b'/runtime/core/preferences.js', page)
        self.assertIn(b'/rocknix/bridge.js', page)
        self.assertLess(page.index(b'/rocknix/bridge.js'), page.index(b'browser-bootstrap.js'))
        self.assertEqual(json.loads(self.request('GET', '/library')[1]), [])
        self.assertEqual(len(json.loads(self.request('GET', '/catalog')[1])), 1)
        self.assertEqual(self.install()['phase'], 'installed')
        library = json.loads(self.request('GET', '/library')[1])
        self.assertEqual(library[0]['id'], 'line-cutter')
        game = self.request('GET', library[0]['entrypoint'])
        self.assertEqual(game[0], 200)
        self.assertIn(b'data-handheld-system', game[1])
        self.assertIn(b'/runtime/core/preferences.js', game[1])
        self.assertTrue(self.request('GET', '/runtime/core/preferences.js')[1].startswith(profile))
        self.assertEqual(self.request('POST', '/api/uninstall', {'id': 'line-cutter'})[0], 409)
        self.request('GET', '/')
        save = self.state.data / 'profile' / 'save'
        save.parent.mkdir()
        save.write_text('keep')
        self.assertEqual(self.request('POST', '/api/uninstall', {'id': 'line-cutter'})[0], 200)
        self.assertEqual(json.loads(self.request('GET', '/library')[1]), [])
        self.assertEqual(save.read_text(), 'keep')

    def test_adult_pages_install_device_face_mapping_before_controller_scripts(self):
        adapter = self.request('GET', '/rocknix/gamepad.js')
        self.assertEqual(adapter, (200, (ROOT / 'rocknix/gamepad.js').read_bytes()))
        for name in ('network', 'updates'):
            page = self.request('GET', '/adult/' + name)[1]
            self.assertLess(page.index(b'/rocknix/gamepad.js'),
                            page.index(('/adult/' + name + '.js').encode()))

    def test_mutations_require_same_origin_hub_and_token_and_reviewed_id(self):
        for headers in [{'Origin': 'https://evil.invalid'}, {'Host': 'evil.invalid'},
                        {'Referer': self.origin + '/games/line-cutter/index.html'},
                        {'X-Cubby-Session': 'wrong'}, {'Content-Type': 'text/plain'}]:
            self.assertEqual(self.request('POST', '/api/install', {'id': 'line-cutter'}, headers)[0], 403)
        for body in [{'id': '../oops'}, {'id': 'not-reviewed'},
                     {'id': 'line-cutter', 'url': 'https://evil.invalid'}]:
            self.assertEqual(self.request('POST', '/api/install', body)[0], 400)
        self.assertEqual(self.request('GET', '/rocknix/server.py')[0], 404)
        self.assertEqual(self.request('GET', '/runtime/../server.py')[0], 404)

    def test_integrity_failure_does_not_install_or_rewrite_existing_games(self):
        self.state.catalog[0]['sha256'] = '0' * 64
        with patch('traceback.print_exc'):
            self.assertEqual(self.install()['phase'], 'error')
        self.assertEqual(json.loads(self.request('GET', '/library')[1]), [])

    def test_concurrent_install_blocks_launch_and_uninstall(self):
        self.assertEqual(self.install()['phase'], 'installed')
        entered, release = threading.Event(), threading.Event()
        from rocknix import server
        original = server.catalog.install_entry
        def slow(*args, **kwargs):
            entered.set()
            release.wait(5)
            return original(*args, **kwargs)
        with patch.object(server.catalog, 'install_entry', slow):
            self.request('POST', '/api/install', {'id': 'line-cutter'})
            self.assertTrue(entered.wait(2))
            try:
                self.assertEqual(self.request('GET', '/games/line-cutter/play.html')[0], 409)
                self.assertEqual(self.request('POST', '/api/uninstall', {'id': 'line-cutter'})[0], 409)
            finally:
                release.set()

class CatalogWatchTests(unittest.TestCase):
    def test_poll_retries_after_startup_and_keeps_last_valid_catalog(self):
        from rocknix import server
        with tempfile.TemporaryDirectory() as directory:
            state = State(ROOT, directory)
            first = list(state.catalog)
            with patch.object(server.catalog, 'load', side_effect=[[], ValueError('bad'), first]):
                self.assertTrue(state.refresh_catalog())
                self.assertEqual(state.catalog, [])
                self.assertFalse(state.refresh_catalog())
                self.assertEqual(state.catalog, [])
                self.assertEqual(json.loads((state.data / 'catalog.json').read_text()), [])
                self.assertTrue(state.refresh_catalog())
                self.assertEqual(state.catalog, first)
            restarted = State(ROOT, directory)
            self.assertEqual(restarted.catalog, first)

    def test_watch_polls_repeatedly_but_not_during_game_or_network_setup(self):
        from rocknix import server
        with tempfile.TemporaryDirectory() as directory:
            state = State(ROOT, directory)
            calls, waits = [], []
            def wait(seconds):
                waits.append(seconds)
                if len(waits) == 1: state.active_game = 'demo'
                elif len(waits) == 2: state.active_game = None; state.network_busy = True
                elif len(waits) == 3: state.network_busy = False
                else: raise InterruptedError('test finished')
            with patch.object(state, 'refresh_catalog', side_effect=lambda: calls.append(True)):
                with self.assertRaises(InterruptedError): server.watch_catalog(state, wait=wait)
            self.assertEqual(calls, [True, True])
            self.assertEqual(waits, [300, 300, 300, 300])

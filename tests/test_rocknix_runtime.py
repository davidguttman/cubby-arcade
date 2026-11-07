import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from rocknix.network import NetworkError, Onboarding, Simulation
from rocknix.updates import app_path
from runtime import server as assets
from rocknix.server import State, app_version, check_for_update, make_server, relay_system_events, update_attention


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'hosting/releases/line-cutter/0.2.1/line-cutter-0.2.1.game.zip'


class SessionTests(unittest.TestCase):
    def test_session_launches_the_cog_the_release_carries(self):
        # Exercise the actual launcher without requiring the handheld's Wayland
        # compositor or ARM browser. Only external processes and mount paths are
        # substituted. The runtime's stock Cog holds audio until a touch, so
        # the session must never fall through to it.
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            socket_path = temporary / 'wayland-0'
            result = temporary / 'launched'
            bundled = temporary / 'app/runtime/native/rg353v'
            stock = temporary / 'opt-cog'
            tools = temporary / 'tools'
            for folder, name, body in [
                (bundled, 'cog', 'printf "bundled %s\\n" "$*" > "$RESULT"\n'),
                (stock, 'cog', 'printf "stock %s\\n" "$*" > "$RESULT"\n'),
                (tools, 'python3', 'if [ "$1" = -m ]; then exec sleep 30; fi\nexit 0\n'),
            ]:
                folder.mkdir(parents=True)
                executable = folder / name
                executable.write_text('#!/bin/sh\n' + body)
                executable.chmod(0o755)
            with socket.socket(socket.AF_UNIX) as compositor:
                compositor.bind(str(socket_path))
                script = (ROOT / 'rocknix/session.sh').read_text()
                script = script.replace('/opt/cubby-cog-gtk4-kiosk/bin', str(stock))
                script = script.replace('/opt/cubby', str(temporary / 'app'))
                script = script.replace('/run/host-runtime', str(temporary))
                script = script.replace('/var/lib/handheld', str(temporary / 'state'))
                environment = dict(os.environ, PATH=str(tools) + ':' + os.environ['PATH'],
                                   WAYLAND_DISPLAY='wayland-0', RESULT=str(result))
                subprocess.run(['bash', '-c', script], env=environment, check=True, timeout=5)
            launched = result.read_text()
            self.assertTrue(launched.startswith('bundled '), launched)
            self.assertIn('--webprocess-failure=exit', launched)


class BundledCogTests(unittest.TestCase):
    COG = ROOT / 'runtime/native/rg353v/cog'

    def test_release_carries_an_arm64_cog_with_the_autoplay_policy(self):
        body = self.COG.read_bytes()
        self.assertEqual(body[:4], b'\x7fELF')
        self.assertEqual(int.from_bytes(body[18:20], 'little'), 183)  # EM_AARCH64
        for marker in [b'website-policies', b'autoplay', b'COG_PLATFORM_GTK4_KIOSK']:
            self.assertIn(marker, body)
        self.assertTrue(self.COG.stat().st_mode & 0o111)

    def test_updater_accepts_the_path_on_existing_devices(self):
        # updates.py is a baseline file that app releases cannot replace.
        self.assertEqual(app_path('runtime/native/rg353v/cog'), 'runtime/native/rg353v/cog')

    def test_kiosk_recipe_stays_valid_because_autoplay_is_a_separate_patch(self):
        recipe = (ROOT / 'rocknix/build-kiosk-rootfs.sh').read_text()
        self.assertNotIn('cog-0.18.4-autoplay.patch', recipe)
        pinned = re.search(r'^PATCH_SHA=(\w+)$', recipe, re.MULTILINE).group(1)
        kiosk = (ROOT / 'rocknix/patches/cog-0.18.4-gtk4-kiosk.patch').read_bytes()
        self.assertEqual(hashlib.sha256(kiosk).hexdigest(), pinned)

    def test_binary_is_not_served_to_pages(self):
        handler = object.__new__(assets.Handler)
        served = handler.translate_path('/runtime/native/rg353v/cog')
        self.assertTrue(served.endswith('.missing-runtime-asset'), served)


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

    def test_painted_page_tells_the_boot_screen_to_step_aside(self):
        with tempfile.TemporaryDirectory() as runtime, patch.dict(os.environ, {'XDG_RUNTIME_DIR': runtime}):
            marker = Path(runtime) / 'cubby-ui-ready'
            self.assertEqual(self.request('POST', '/api/ui-ready', {}, {'X-Cubby-Session': 'wrong'})[0], 403)
            self.assertFalse(marker.exists())
            self.assertEqual(self.request('POST', '/api/ui-ready', {})[0], 200)
            self.assertTrue(marker.exists())

    def test_power_state_reports_work_the_idle_timer_must_not_interrupt(self):
        def busy():
            status, body = self.request('GET', '/api/power-state')
            self.assertEqual(status, 200)
            return json.loads(body)['busy']
        self.assertFalse(busy())
        for flag in ('busy', 'network_busy'):
            setattr(self.state, flag, True)
            self.assertTrue(busy(), flag)
            setattr(self.state, flag, False)
        class Updater:
            phase = 'idle'
            def dispatch(self, request):
                if self.phase == 'broken':
                    raise ValueError('Updater unavailable')
                return {'phase': self.phase}
        self.state.updater = Updater()
        for phase, expected in [('idle', False), ('available', False), ('staged', False), ('error', False), ('broken', False),
                                ('checking', True), ('downloading', True), ('trial', True)]:
            self.state.updater.phase = phase
            self.assertEqual(busy(), expected, phase)

    def test_pages_hear_system_events_by_long_polling(self):
        status, body = self.request('GET', '/api/system-events?after=-1')
        self.assertEqual((status, json.loads(body)), (200, {'seq': 0, 'events': []}))
        event = {'seq': 1, 'type': 'sleep', 'detail': {'reason': 'idle'}}
        threading.Timer(.05, self.state.system_events.add, (1, [event])).start()
        started = time.monotonic()
        status, body = self.request('GET', '/api/system-events?after=0')
        self.assertEqual((status, json.loads(body)), (200, {'seq': 1, 'events': [event]}))
        self.assertLess(time.monotonic() - started, 2)
        # A page that loads later starts from now, not from history.
        self.assertEqual(json.loads(self.request('GET', '/api/system-events?after=-1')[1]), {'seq': 1, 'events': []})
        self.assertEqual(self.request('GET', '/api/system-events?after=-1', headers={'Host': 'evil.test'})[0], 403)

    def test_a_page_ack_reaches_the_host_and_only_from_this_origin(self):
        calls = []
        class Host:
            def dispatch(self, request):
                calls.append(request)
                return {'accepted': True}
        self.state.network = Host()
        self.assertEqual(self.request('POST', '/api/system-events/ack', {'seq': 3})[0], 200)
        self.assertEqual(calls, [{'action': 'system-ack', 'seq': 3}])
        self.assertEqual(self.request('POST', '/api/system-events/ack', {'seq': 4}, {'Origin': 'http://evil.test'})[0], 403)
        for body in ({'seq': 'x'}, {}, [1]):
            self.assertEqual(self.request('POST', '/api/system-events/ack', body)[0], 400, body)
        self.assertEqual(len(calls), 1)

    def test_relay_acks_at_once_when_no_page_listens_and_waits_when_one_does(self):
        event = {'seq': 1, 'type': 'sleep', 'detail': {}}
        for listening, acks in ((False, [{'action': 'system-ack', 'seq': 1}]), (True, [])):
            with self.subTest(listening=listening):
                state = State(ROOT, Path(self.tmp.name))
                calls = []
                class Host:
                    def dispatch(self, request):
                        calls.append(request)
                        if request['action'] == 'system-wait' and request['after'] < 0:
                            return {'seq': 0, 'events': []}
                        if request['action'] == 'system-wait':
                            return {'seq': 1, 'events': [event]}
                        return {'accepted': True}
                state.network = Host()
                if listening:
                    state.system_events.wait(-1, 0)
                rounds = iter([True, True, False])
                relay_system_events(state, keep_going=lambda: next(rounds))
                self.assertEqual([c for c in calls if c['action'] == 'system-ack'], acks)
                self.assertEqual(state.system_events.seq, 1)

    def test_relay_survives_a_host_without_system_events(self):
        state = State(ROOT, Path(self.tmp.name))
        waits = []
        class Host:
            def dispatch(self, request):
                raise NetworkError('unavailable')
        state.network = Host()
        rounds = iter([True, True, False])
        relay_system_events(state, wait=waits.append, keep_going=lambda: next(rounds))
        self.assertEqual(waits, [5, 5])

    def test_power_is_hub_only_and_waits_for_writes(self):
        calls = []
        class Host:
            def dispatch(self, request):
                calls.append(request)
                return {'accepted': True}
        self.assertEqual(self.request('POST', '/api/power', {'mode': 'reboot'})[0], 503)
        self.state.network = Host()
        for headers in ({'X-Cubby-Session': 'wrong'}, {'Origin': 'http://evil.test'},
                        {'Referer': self.origin + '/games/line-cutter/play.html'},
                        {'X-Cubby-Session': self.state.adult_token}):
            self.assertEqual(self.request('POST', '/api/power', {'mode': 'reboot'}, headers)[0], 403, headers)
        for body in ({'mode': 'halt'}, {'mode': 'reboot', 'force': True}, {}, ['reboot']):
            self.assertEqual(self.request('POST', '/api/power', body)[0], 400, body)
        for flag in ('active_game', 'network_busy'):
            setattr(self.state, flag, True)
            self.assertEqual(self.request('POST', '/api/power', {'mode': 'poweroff'})[0], 409, flag)
            setattr(self.state, flag, False if flag != 'active_game' else None)
        self.state.status['line-cutter'] = {'phase': 'downloading'}
        self.assertEqual(self.request('POST', '/api/power', {'mode': 'poweroff'})[0], 409)
        self.state.status['line-cutter'] = {'phase': 'installed', 'version': '1'}
        self.assertEqual(calls, [])
        # A failed update apply keeps busy set until restart, so restart has to work.
        self.state.busy = True
        self.assertEqual(self.request('POST', '/api/power', {'mode': 'reboot'})[0], 200)
        self.assertEqual(calls.pop(), {'action': 'power', 'mode': 'reboot'})
        self.state.busy = False
        status, body = self.request('POST', '/api/power', {'mode': 'poweroff'})
        self.assertEqual((status, json.loads(body)), (200, {'accepted': True}))
        self.assertEqual(calls, [{'action': 'power', 'mode': 'poweroff'}])
        class Broken:
            def dispatch(self, request):
                raise NetworkError('unavailable')
        self.state.network = Broken()
        self.assertEqual(self.request('POST', '/api/power', {'mode': 'reboot'})[0], 503)

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
        # Players: the game page gets the launching player's storage, and the hub its pictures.
        self.assertIn(b'<script data-cubby-profile src="/runtime/core/profiles.js"></script>', game[1])
        # keyboard.js/.css: the one on-screen keyboard, for player names and the Wi-Fi password.
        for name in ('profiles.js', 'avatars.js', 'keyboard.js', 'keyboard.css'):
            served = self.request('GET', '/runtime/core/' + name)
            self.assertEqual((served[0], served[1]), (200, (ROOT / 'runtime/core' / name).read_bytes()))
        self.assertLess(page.index(b'/runtime/core/profiles.js'), page.index(b'/runtime/core/platform.js'))
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
        # The Wi-Fi password is typed on Cubby's one shared on-screen keyboard.
        page = self.request('GET', '/adult/network')[1]
        self.assertLess(page.index(b'/runtime/core/keyboard.js'), page.index(b'/adult/network.js'))
        self.assertEqual(self.request('GET', '/runtime/core/keyboard.js'),
                         (200, (ROOT / 'runtime/core/keyboard.js').read_bytes()))

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

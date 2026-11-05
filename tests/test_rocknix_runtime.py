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

from rocknix.server import State, make_server


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

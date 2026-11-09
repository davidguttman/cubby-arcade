"""The handheld's half of game updates: real server, real downloads, real version switches."""
import http.client
import http.server
import json
import subprocess
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from rocknix import server as device
from rocknix.server import State, make_server
from runtime import file_manifest

ROOT = Path(__file__).resolve().parents[1]


class Publisher(http.server.ThreadingHTTPServer):
    def __init__(self):
        super().__init__(('127.0.0.1', 0), Published)
        self.documents, self.requests, self.gate = {}, [], threading.Event()
        self.gate.set()

    def publish(self, version):
        with tempfile.TemporaryDirectory() as temporary:
            build = Path(temporary)
            (build / 'play.html').write_text('<canvas></canvas><!-- ' + version + ' -->')
            (build / 'cover.svg').write_text('<svg/>')
            release = file_manifest.generate(build, 'demo', version, 'play.html', 'cover.svg', version + '/')
            for name in ('play.html', 'cover.svg'):
                self.documents[f'/{version}/{name}'] = (build / name).read_bytes()
        self.documents['/manifest.json'] = json.dumps(release).encode()


class Published(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append(self.path)
        if self.path != '/manifest.json':
            self.server.gate.wait(10)
        body = self.server.documents.get(self.path)
        if body is None:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class GameUpdates(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        logger = patch('rocknix.server.Handler.log_message')
        logger.start()
        self.addCleanup(logger.stop)
        self.publisher = Publisher()
        threading.Thread(target=self.publisher.serve_forever, daemon=True).start()
        self.addCleanup(self.publisher.server_close)
        self.addCleanup(self.publisher.shutdown)
        self.state = State(ROOT, Path(temporary.name))
        self.state.developer = True
        self.state.catalog = [{'id': 'demo', 'title': 'Demo', 'artwork': 'https://a.test/c.png',
                               'manifest_url': f'http://127.0.0.1:{self.publisher.server_address[1]}/manifest.json'}]
        self.httpd = make_server(self.state, port=0)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.origin = 'http://127.0.0.1:' + str(self.httpd.server_address[1])

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=10)
        headers = {'Origin': self.origin, 'Referer': self.origin + '/', 'Content-Type': 'application/json',
                   'X-Cubby-Session': self.state.token}
        try:
            connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def wait_for(self, *phases):
        deadline = time.time() + 10
        while time.time() < deadline:
            status = json.loads(self.request('GET', '/api/status')[1]).get('demo', {})
            if status.get('phase') in phases and not self.state.busy:
                return status
            time.sleep(0.02)
        self.fail(f'never reached {phases}: {status}')

    def update(self, *phases):
        self.assertEqual(self.request('POST', '/api/install', {'id': 'demo'})[0], 202)
        return self.wait_for(*(phases or ('installed',)))

    def version(self):
        return json.loads(self.request('GET', '/library')[1])[0]['version']

    def test_real_bridge_blends_and_pins_selected_source_across_restarts(self):
        self.publisher.publish('1')
        self.publisher.documents['/first.json'] = self.publisher.documents['/manifest.json'].replace(b'"version": "1"', b'"version": "9"')
        def offer(host, title, manifest):
            return {'id': 'demo', 'title': title, 'manifest_url': f'https://{host}/{manifest}',
                    'artwork': f'https://{host}/art.svg'}
        self.publisher.documents['/catalog'] = json.dumps([offer('first.test', 'First', 'first.json')]).encode()
        self.publisher.documents['/other-catalog'] = json.dumps([offer('other.test', 'Other', 'manifest.json')]).encode()
        download = device.catalog.download
        def routed(url, destination, limit, developer=False, *args, **kwargs):
            from urllib.parse import urlsplit
            parsed = urlsplit(url)
            path = '/other-catalog' if parsed.hostname == 'other.test' and parsed.path == '/catalog' else parsed.path
            return download(f'http://127.0.0.1:{self.publisher.server_address[1]}{path}',
                            destination, limit, True, *args, **kwargs)
        def run(mode):
            result = subprocess.run(['node', 'tests/handheld_feed_bridge.js', self.origin, self.state.token, mode],
                                    cwd=ROOT, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        with patch.object(device.catalog, 'download', side_effect=routed):
            self.assertEqual(run('install')[0]['version'], '1')
            self.publisher.publish('2')
            self.publisher.requests.clear()
            self.assertEqual(run('reorder')[0]['version'], '2')
            self.assertIn('/manifest.json', self.publisher.requests)
            self.assertNotIn('/first.json', self.publisher.requests)
            self.publisher.publish('3')
            for mode in ['disable', 'remove']:
                self.publisher.requests.clear()
                self.assertEqual(run(mode)[0]['version'], '2')
                self.assertNotIn('/manifest.json', self.publisher.requests)
            del self.publisher.documents['/other-catalog']
            self.assertEqual(run('offline')[0]['version'], '2')
            self.assertEqual(run('replace')[0]['version'], '9')
        restarted = State(ROOT, self.state.data)
        saved = restarted.read_feed_state()
        self.assertEqual(saved['sources']['demo']['feed_url'], 'https://cubby.david.app/catalog')

    def test_new_release_replaces_the_installed_one(self):
        self.publisher.publish('1.0.0')
        self.assertEqual(self.update()['version'], '1.0.0')
        self.publisher.publish('1.0.1')
        self.assertEqual(self.update()['version'], '1.0.1')
        self.assertEqual(self.version(), '1.0.1')
        self.assertIn(b'1.0.1', self.request('GET', '/games/demo/play.html')[1])

    def test_unchanged_release_costs_one_manifest(self):
        self.publisher.publish('1.0.0')
        self.update()
        self.publisher.requests.clear()
        with patch.object(device.catalog, 'stage_files', side_effect=AssertionError('nothing to stage')):
            self.update()
        self.assertEqual(self.publisher.requests, ['/manifest.json'])

    def test_a_game_can_launch_while_an_update_downloads(self):
        self.publisher.publish('1.0.0')
        self.update()
        self.publisher.publish('1.0.1')
        self.publisher.gate.clear()
        self.assertEqual(self.request('POST', '/api/install', {'id': 'demo'})[0], 202)
        try:
            deadline = time.time() + 5
            while not any(path.startswith('/1.0.1/') for path in self.publisher.requests):
                self.assertLess(time.time(), deadline)
                time.sleep(0.02)
            status, page = self.request('GET', '/games/demo/play.html')
            self.assertEqual(status, 200)
            self.assertIn(b'1.0.0', page)
        finally:
            self.publisher.gate.set()

    def test_the_version_switches_only_on_returning_to_the_hub(self):
        self.publisher.publish('1.0.0')
        self.update()
        self.assertEqual(self.request('GET', '/games/demo/play.html')[0], 200)
        self.publisher.publish('1.0.1')
        with self.state.lock:
            self.state.busy = True  # What /api/install does, with a game already running.
        self.state.install(self.state.catalog[0])
        self.assertEqual(self.wait_for('pending')['version'], '1.0.1')
        self.assertIn(b'1.0.0', self.request('GET', '/games/demo/play.html')[1])
        self.assertEqual(self.request('GET', '/')[0], 200)
        self.assertEqual(self.wait_for('installed')['version'], '1.0.1')
        self.assertIn(b'1.0.1', self.request('GET', '/games/demo/play.html')[1])
        self.assertEqual(self.request('GET', '/')[0], 200)

    def test_a_failed_update_keeps_the_current_release(self):
        self.publisher.publish('1.0.0')
        self.update()
        self.publisher.publish('1.0.1')
        del self.publisher.documents['/1.0.1/play.html']
        with patch('traceback.print_exc'):
            self.update('error')
        self.assertEqual(self.version(), '1.0.0')
        self.assertIn(b'1.0.0', self.request('GET', '/games/demo/play.html')[1])

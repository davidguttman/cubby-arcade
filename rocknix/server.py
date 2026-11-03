"""Device-local Cubby host; reviewed publishers only, no arbitrary URL API.

Games are trusted application code, not an isolation boundary. Cross-site callers
and direct game-frame requests cannot invoke the adult package-management API.
"""
import http.server
import io
import json
import os
from pathlib import Path
import secrets
import threading
from urllib.parse import unquote, urlsplit

import yaml

from runtime import catalog, packages, server as assets


class State:
    def __init__(self, app, data):
        self.app, self.data = Path(app), Path(data)
        self.data.mkdir(parents=True, exist_ok=True)
        self.games = self.data / 'games'
        self.token = secrets.token_hex(32)
        self.lock = threading.RLock()
        self.active_game = None
        self.busy = False
        self.status = {}
        self.developer = False
        self.catalog = catalog.validate_registry(yaml.safe_load(
            (self.app / 'hosting/catalog.yaml').read_text()))
        try:
            self.catalog = catalog.validate_registry(json.loads((self.data / 'catalog.json').read_text()))
        except (OSError, ValueError, TypeError):
            pass

    def refresh_catalog(self):
        try:
            entries = catalog.load('https://cubby.david.app/catalog')
            if not isinstance(entries, list):
                raise ValueError('Expected discovery registry')
            temporary = self.data / 'catalog.tmp'
            temporary.write_text(json.dumps(entries))
            temporary.replace(self.data / 'catalog.json')
            with self.lock:
                self.catalog = entries
        except (OSError, ValueError, TypeError):
            # A verified cache or checked-in discovery pointers work offline.
            pass

    def install(self, entry):
        game_id = entry['id']
        try:
            with self.lock:
                self.status[game_id] = {'phase': 'downloading'}
            result = catalog.install_entry(entry, self.games, developer=self.developer)
            with self.lock:
                self.status[game_id] = {'phase': 'installed', 'version': result['version']}
        except Exception:
            # Details belong to adult logs, never the wordless child UI.
            import traceback
            traceback.print_exc()
            with self.lock:
                self.status[game_id] = {'phase': 'error'}
        finally:
            with self.lock:
                self.busy = False


class Handler(assets.Handler):
    @property
    def state(self):
        return self.server.state

    @property
    def origin(self):
        return 'http://127.0.0.1:' + str(self.server.server_address[1])

    def valid_host(self):
        return self.headers.get('Host') == self.origin.removeprefix('http://')

    def json_response(self, value, status=200):
        content = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
        if path.startswith('/games/'):
            try:
                _, _, game_id, relative = path.split('/', 3)
                packages.safe_path(relative)
                entry = next(item for item in packages.library(self.state.games) if item['id'] == game_id)
                release = (self.state.games / entry['id'] / 'current').resolve(strict=True)
                manifest = packages.validate_manifest(json.loads((release / 'manifest.json').read_text()))
                target = (release / relative).resolve(strict=True)
                if relative not in manifest['files'] or not target.is_relative_to(release):
                    raise ValueError('Not a package asset')
                return str(target)
            except (OSError, ValueError, KeyError, StopIteration, TypeError):
                return str(self.state.app / '.missing-runtime-asset')
        if path == '/rocknix/bridge.js':
            return str(self.state.app / 'rocknix/bridge.js')
        # Reuse the VM server's explicit shared-core allowlist, never expose
        # arbitrary app files or Python implementation source.
        result = Path(super().translate_path(path))
        try:
            relative = result.relative_to(assets.ROOT)
        except ValueError:
            relative = Path('.missing-runtime-asset')
        return str(self.state.app / relative)

    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        if path in {'/', '/play', '/play/', '/runtime/index.html'}:
            if self.command == 'GET':
                with self.state.lock:
                    self.state.active_game = None
            content = (self.state.app / 'runtime/index.html').read_bytes().replace(
                b'</head>', ('<script>window.CubbyDeviceToken=' + json.dumps(self.state.token)
                            + ';</script><script src="/rocknix/bridge.js"></script></head>').encode(), 1)
            self.range_length = None
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            return io.BytesIO(content)
        if self.command == 'GET' and path.startswith('/games/'):
            with self.state.lock:
                entry = next((item for item in packages.library(self.state.games)
                              if item['entrypoint'] == path), None)
                if entry:
                    if self.state.busy:
                        self.send_error(409, 'Package operation in progress')
                        return None
                    self.state.active_game = entry['id']
        return super().send_head()

    def do_HEAD(self):
        if not self.valid_host():
            self.send_error(403)
            return
        super().do_HEAD()

    def do_GET(self):
        if not self.valid_host():
            self.send_error(403)
            return
        path = urlsplit(self.path).path
        with self.state.lock:
            if path in {'/library', '/api/library'}:
                self.json_response(packages.library(self.state.games))
                return
            if path in {'/catalog', '/api/catalog'}:
                self.json_response(self.state.catalog)
                return
            if path == '/api/status':
                self.json_response(self.state.status)
                return
        if path == '/health':
            self.json_response({'ready': True})
            return
        # Skip assets.Handler.do_GET, whose library is the VM's global path.
        http.server.SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        if (not self.valid_host() or self.headers.get('Origin') != self.origin
                or self.headers.get('Referer') not in {self.origin + '/', self.origin + '/play',
                                                       self.origin + '/play/',
                                                       self.origin + '/runtime/index.html'}
                or self.headers.get('X-Cubby-Session') != self.state.token
                or self.headers.get('Content-Type') != 'application/json'):
            self.send_error(403)
            return
        if self.path not in {'/api/install', '/api/uninstall'}:
            self.send_error(404)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 256:
                raise ValueError('Invalid request size')
            request = json.loads(self.rfile.read(size))
            if not isinstance(request, dict) or set(request) != {'id'}:
                raise ValueError('Expected game ID only')
            game_id = request['id']
            if not isinstance(game_id, str) or not catalog.ID.fullmatch(game_id):
                raise ValueError('Invalid ID')
            with self.state.lock:
                if self.state.busy or self.state.active_game:
                    self.json_response({'error': 'busy'}, 409)
                    return
                if self.path == '/api/install':
                    entry = next((item.copy() for item in self.state.catalog if item['id'] == game_id), None)
                    if not entry:
                        raise ValueError('Unknown publisher')
                    self.state.busy = True
                    self.state.status[game_id] = {'phase': 'checking'}
                    threading.Thread(target=self.state.install, args=(entry,), daemon=True).start()
                    self.json_response({'accepted': True}, 202)
                else:
                    catalog.remove(game_id, self.state.games)
                    self.state.status.pop(game_id, None)
                    self.json_response({'removed': True})
        except (ValueError, TypeError, OSError, KeyError):
            self.json_response({'error': 'invalid operation'}, 400)


def make_server(state, port=8080):
    instance = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    instance.state = state
    return instance


if __name__ == '__main__':
    state = State(Path(__file__).resolve().parents[1],
                  Path(os.environ.get('CUBBY_STATE', '/var/lib/handheld')))
    threading.Thread(target=state.refresh_catalog, daemon=True).start()
    make_server(state).serve_forever()

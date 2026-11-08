"""Device-local Cubby host; reviewed publishers only, no arbitrary URL API.

Games are trusted application code, not an isolation boundary. Cross-site callers
and direct game-frame requests cannot invoke the adult package-management API.
"""
import http.server
import io
import json
import os
import re
from pathlib import Path
import secrets
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

import yaml

from runtime import battery, catalog, packages, server as assets
from rocknix import network, updates

UPDATE_CHECK_SECONDS = 15 * 60
UPDATE_RETRY_SECONDS = 5 * 60
UPDATE_FIRST_CHECK_SECONDS = 60
SYSTEM_EVENT_WAIT = 25


def feed_url(value):
    """Transport validation only; ordering, caching and pin policy are shared JS."""
    if (not isinstance(value, str) or len(value) > 2048
            or not re.match(r'^https://[^/]', value, re.I)
            or re.search(r'[\\\x00-\x20\x7f#]|%(?![0-9a-f]{2})|%(?:0[0-9a-f]|1[0-9a-f]|20|7f|5c)', value, re.I)):
        raise ValueError('Invalid feed URL')
    catalog.check_url(value)
    return value


def feed_entries(entries):
    catalog.validate_registry(entries)
    for entry in entries:
        for key in ('manifest_url', 'artwork', 'attract'):
            if key in entry:
                feed_url(entry[key])
        for url in entry.get('screenshots', []):
            feed_url(url)
    return entries


class SystemEvents:
    """Sleep and wake for game pages. Pages long-poll this; the host helper feeds it."""
    LISTENING_SECONDS = 35

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.condition = threading.Condition()
        self.seq = 0
        self.events = []
        self.polled_at = None

    def add(self, seq, events):
        with self.condition:
            self.seq = max(self.seq, seq)
            self.events = (self.events + events)[-16:]
            self.condition.notify_all()

    def listening(self):
        with self.condition:
            return self.polled_at is not None and self.clock() - self.polled_at < self.LISTENING_SECONDS

    def wait(self, after, timeout):
        deadline = self.clock() + timeout
        with self.condition:
            self.polled_at = self.clock()
            if after >= 0:
                while self.seq <= after and self.clock() < deadline:
                    self.condition.wait(min(1, max(0, deadline - self.clock())))
            self.polled_at = self.clock()
            return {'seq': self.seq, 'events': [e for e in self.events if e['seq'] > after] if after >= 0 else []}


class State:
    def __init__(self, app, data, network_adapter=None):
        self.app, self.data = Path(app), Path(data)
        self.data.mkdir(parents=True, exist_ok=True)
        self.games = self.data / 'games'
        self.token = secrets.token_hex(32)
        self.adult_token = secrets.token_hex(32)
        self.network = network_adapter
        self.updater = None
        self.lock = threading.RLock()
        self.active_game = None
        self.busy = False
        self.unpacking = False
        self.network_busy = False
        self.pending = {}
        self.status = {}
        self.system_events = SystemEvents()
        self.developer = False
        self.fetched_feeds = {}
        self.catalog = catalog.validate_registry(yaml.safe_load(
            (self.app / 'hosting/catalog.yaml').read_text()))
        try:
            self.catalog = catalog.validate_registry(json.loads((self.data / 'catalog.json').read_text()))
        except (OSError, ValueError, TypeError):
            pass

    @property
    def onboarding_required(self):
        if self.network is None:
            return False
        try:
            return json.loads((self.data / 'network-onboarded.json').read_text()) != {'schema': 1, 'complete': True}
        except (OSError, ValueError):
            return True

    def read_feed_state(self):
        file = self.data / 'game-feeds.json'
        try:
            if file.stat().st_size > 20 * 1024 * 1024:
                raise ValueError('Feed state too large')
            value = json.loads(file.read_bytes())
        except FileNotFoundError:
            return None
        cache = value.get('cache', {}) if isinstance(value, dict) else {}
        for url, entries in (cache.items() if isinstance(cache, dict) else []):
            try:
                feed_url(url)
                self.fetched_feeds[url] = feed_entries(entries)
            except (ValueError, TypeError):
                pass
        return value

    def write_feed_state(self, value):
        encoded = json.dumps(value).encode()
        if len(encoded) > 20 * 1024 * 1024:
            raise ValueError('Feed state too large')
        temporary = self.data / 'game-feeds.tmp'
        with self.lock:
            temporary.write_bytes(encoded)
            temporary.replace(self.data / 'game-feeds.json')

    def fetch_feed(self, url):
        feed_url(url)
        entries = feed_entries(catalog.load(url))
        with self.lock:
            self.fetched_feeds[url] = entries
        return entries

    def selected_offer(self, game_id, offer):
        if not isinstance(offer, dict) or offer.get('id') != game_id:
            raise ValueError('Invalid selected offer')
        feed_entries([offer])
        source = offer.get('_source')
        if not isinstance(source, dict):
            raise ValueError('Missing game source')
        url = feed_url(source.get('feed_url'))
        manifest = feed_url(source.get('manifest_url'))
        if manifest != offer['manifest_url'] or not any(
                entry['id'] == game_id and entry.get('manifest_url') == manifest
                for entry in self.fetched_feeds.get(url, [])):
            raise ValueError('Game source not offered')
        return offer.copy()

    def install(self, entry):
        """Download and verify now; switch versions only outside gameplay."""
        game_id = entry['id']
        try:
            with self.lock:
                self.status[game_id] = {'phase': 'downloading'}
            manifest = catalog.stage_entry(entry, self.games, developer=self.developer)
            if manifest is None:
                self.install_legacy(entry)
                return
            with self.lock:
                self.pending[game_id] = manifest['version']
                self.status[game_id] = {'phase': 'pending', 'version': manifest['version']}
                self.activate_pending()
        except Exception:
            # Details belong to adult logs, never the wordless child UI.
            import traceback
            traceback.print_exc()
            with self.lock:
                self.status[game_id] = {'phase': 'error'}
        finally:
            with self.lock:
                self.busy = False

    def install_legacy(self, entry):
        """A ZIP release unpacks straight into place, so no game may run meanwhile."""
        with self.lock:
            if self.active_game:
                raise ValueError('Game running; the next check retries')
            self.unpacking = True
        try:
            result = catalog.install_entry(entry, self.games, developer=self.developer)
        finally:
            with self.lock:
                self.unpacking = False
        with self.lock:
            self.status[entry['id']] = {'phase': 'installed', 'version': result['version']}

    def activate_pending(self):
        """Caller holds the lock. Launching takes it too, so a game can't start mid-switch."""
        if self.active_game:
            return
        for game_id, version in self.pending.items():
            try:
                catalog.activate_release(self.games, game_id, version)
                self.status[game_id] = {'phase': 'installed', 'version': version}
            except OSError:
                # The hub still has to open. The stage is kept, so the next check retries.
                import traceback
                traceback.print_exc()
                self.status[game_id] = {'phase': 'error'}
        self.pending.clear()


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
        if path in {'/adult/network.js', '/adult/network.css', '/adult/updates.js', '/adult/ready.js'}:
            return str(self.state.app / 'rocknix/adult' / path.rsplit('/', 1)[1])
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
        if path in {'/rocknix/bridge.js', '/rocknix/gamepad.js'}:
            return str(self.state.app / path.lstrip('/'))
        # Reuse the VM server's explicit shared-core allowlist, never expose
        # arbitrary app files or Python implementation source.
        result = Path(super().translate_path(path))
        try:
            relative = result.relative_to(assets.ROOT)
        except ValueError:
            relative = Path('.missing-runtime-asset')
        return str(self.state.app / relative)

    def ready_script(self, token):
        return ('<script src="/adult/ready.js" data-token="' + token + '"></script>').encode()

    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        if path == '/runtime/core/preferences.js':
            # Both the hub and delivered game pages load this host module. Keep
            # the profile ahead of module initialization without modifying any
            # immutable game bytes or changing ordinary browser-host defaults.
            content = (b'window.CubbyDeviceProfile="rg353v";\n'
                       + (self.state.app / 'rocknix/gamepad.js').read_bytes() + b'\n'
                       + (self.state.app / 'runtime/core/preferences.js').read_bytes())
            self.range_length = None
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            return io.BytesIO(content)
        if path in {'/adult/network', '/adult/updates'}:
            content = (self.state.app / ('rocknix/adult/updates.html' if path.endswith('updates') else 'rocknix/adult/network.html')).read_bytes().replace(
                b'__ADULT_SESSION__', self.state.adult_token.encode()).replace(
                    b'<head>', b'<head><script src="/rocknix/gamepad.js"></script>', 1).replace(
                    b'</head>', self.ready_script(self.state.adult_token)+b'</head>')
            self.range_length = None
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; object-src 'none'")
            self.end_headers()
            return io.BytesIO(content)
        if self.state.onboarding_required and (path in {'/', '/play', '/play/', '/runtime/index.html'}
                                               or path.startswith('/games/')):
            self.send_response(303)
            self.send_header('Location', '/adult/network')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        if path in {'/', '/play', '/play/', '/runtime/index.html'}:
            if self.command == 'GET':
                with self.state.lock:
                    self.state.active_game = None
                    self.state.activate_pending()
            content = (self.state.app / 'runtime/index.html').read_bytes().replace(
                b'</head>', ('<script>window.CubbyDeviceToken=' + json.dumps(self.state.token)
                            + ';</script><script src="/rocknix/bridge.js"></script></head>').encode(), 1)
            content = content.replace(b'</head>', self.ready_script(self.state.token)+b'</head>', 1)
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
                    # A background download doesn't touch what's running: only unpacking
                    # a legacy ZIP and network changes hold a launch back.
                    if self.state.unpacking or self.state.network_busy:
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
        if path == '/api/battery':
            self.json_response(battery.read_battery())
            return
        if path == '/api/version':
            self.json_response({'version': app_version(self.state)})
            return
        if path == '/api/update-attention':
            self.json_response({'attention': update_attention(self.state)})
            return
        if path == '/api/power-state':
            self.json_response({'busy': power_busy(self.state)})
            return
        if path == '/api/system-events':
            try:
                after = int(parse_qs(urlsplit(self.path).query).get('after', ['-1'])[0])
            except ValueError:
                after = -1
            self.json_response(self.state.system_events.wait(after, SYSTEM_EVENT_WAIT))
            return
        if path == '/health':
            self.json_response({'ready': True})
            return
        # Skip assets.Handler.do_GET, whose library is the VM's global path.
        http.server.SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        if self.path == '/api/system-events/ack':
            self.system_event_ack()
            return
        if self.path in {'/api/update', '/api/ui-ready'}:
            ready = self.path == '/api/ui-ready'
            expected_token = self.state.adult_token
            allowed = {self.origin+'/adult/updates'}
            if ready:
                allowed |= {self.origin+'/', self.origin+'/play', self.origin+'/play/',
                            self.origin+'/runtime/index.html', self.origin+'/adult/network'}
                expected_token = (self.state.adult_token if self.headers.get('Referer','').startswith(self.origin+'/adult/') else self.state.token)
            if (not self.valid_host() or self.headers.get('Origin') != self.origin
                    or self.headers.get('Referer') not in allowed
                    or self.headers.get('X-Cubby-Session') != expected_token
                    or self.headers.get('Content-Type') != 'application/json'):
                self.send_error(403); return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 128: raise ValueError('Invalid request')
                body = json.loads(self.rfile.read(size))
                if ready:
                    if body != {}: raise ValueError('Invalid readiness')
                    mark_ui_ready()
                    trial = os.environ.get('CUBBY_UPDATE_TRIAL')
                    if trial and self.state.updater:
                        self.state.updater.dispatch({'action':'ready','token':trial})
                    self.json_response({'accepted':True}); return
                if not isinstance(body,dict) or set(body)!={'action'} or body['action'] not in {'status','check','download','apply'}:
                    raise ValueError('Invalid action')
                if not self.state.updater:
                    self.json_response({'phase':'unconfigured','configured':False}); return
                with self.state.lock:
                    if body['action']=='apply':
                        if self.state.active_game or self.state.busy or self.state.network_busy:
                            self.json_response({'error':'busy'},409); return
                        self.state.busy=True
                        try: result=self.state.updater.dispatch(body)
                        except updates.Rejected:
                            self.state.busy=False; raise
                        # A dropped connection is ambiguous: the coordinator
                        # may still activate. Keep gameplay blocked until restart.
                    else: result=self.state.updater.dispatch(body)
                self.json_response(result)
            except (OSError,ValueError,TypeError):
                self.json_response({'error':'Update operation unavailable. Check update status before retrying.'},400)
            return
        if self.path == '/api/network':
            if (not self.valid_host() or self.headers.get('Origin') != self.origin
                    or self.headers.get('Referer') != self.origin + '/adult/network'
                    or self.headers.get('X-Cubby-Session') != self.state.adult_token
                    or self.headers.get('Content-Type') != 'application/json'):
                self.send_error(403)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 2048:
                    raise ValueError('Invalid size')
                request = json.loads(self.rfile.read(size))
                if not self.state.network:
                    raise network.NetworkError('unavailable')
                with self.state.lock:
                    if self.state.active_game or self.state.busy or self.state.network_busy:
                        self.json_response({'error': 'busy'}, 409)
                        return
                    self.state.network_busy = True
                try:
                    result = self.state.network.dispatch(request)
                finally:
                    with self.state.lock:
                        self.state.network_busy = False
                # Reply only once free: the Wi-Fi page sends its next request immediately.
                self.json_response(result)
            except network.NetworkError as error:
                self.json_response({'error': str(error) if str(error) in network.ERRORS else 'unavailable'}, 400)
            except (ValueError, TypeError, OSError):
                self.json_response({'error': 'invalid_request'}, 400)
            return
        if (not self.valid_host() or self.headers.get('Origin') != self.origin
                or self.headers.get('Referer') not in {self.origin + '/', self.origin + '/play',
                                                       self.origin + '/play/',
                                                       self.origin + '/runtime/index.html'}
                or self.headers.get('X-Cubby-Session') != self.state.token
                or self.headers.get('Content-Type') != 'application/json'):
            self.send_error(403)
            return
        if self.path == '/api/power':
            self.request_power()
            return
        if self.path.startswith('/api/feeds/'):
            self.feed_operation()
            return
        if self.path not in {'/api/install', '/api/uninstall'}:
            self.send_error(404)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= (65536 if self.path == '/api/install' else 256):
                raise ValueError('Invalid request size')
            request = json.loads(self.rfile.read(size))
            if (not isinstance(request, dict) or 'id' not in request
                    or set(request) - ({'id', 'offer', 'update'} if self.path == '/api/install' else {'id'})
                    or ('update' in request and request['update'] is not True)):
                raise ValueError('Invalid game request')
            game_id = request['id']
            if not isinstance(game_id, str) or not catalog.ID.fullmatch(game_id):
                raise ValueError('Invalid ID')
            with self.state.lock:
                if self.state.onboarding_required:
                    self.json_response({'error': 'onboarding required'}, 409)
                    return
                if self.state.busy or self.state.active_game or self.state.network_busy:
                    self.json_response({'error': 'busy'}, 409)
                    return
                if self.path == '/api/install':
                    if request.get('update') and not any(game['id'] == game_id for game in packages.library(self.state.games)):
                        self.json_response({'skipped': True})
                        return
                    entry = (self.state.selected_offer(game_id, request['offer']) if 'offer' in request else
                             next((item.copy() for item in self.state.catalog if item['id'] == game_id), None))
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


    def feed_operation(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            limit = 20 * 1024 * 1024 if self.path == '/api/feeds/write' else 4096
            if not 0 < size <= limit:
                raise ValueError('Invalid feed request size')
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError('Invalid feed request')
            if self.path == '/api/feeds/read' and body == {}:
                self.json_response(self.state.read_feed_state())
            elif self.path == '/api/feeds/write':
                self.state.write_feed_state(body)
                self.json_response({'saved': True})
            elif self.path == '/api/feeds/fetch' and set(body) == {'url'}:
                with self.state.lock:
                    if self.state.active_game or self.state.busy or self.state.network_busy:
                        self.json_response({'error': 'busy'}, 409)
                        return
                self.json_response(self.state.fetch_feed(body['url']))
            else:
                raise ValueError('Unknown feed operation')
        except (ValueError, TypeError, OSError, KeyError):
            self.json_response({'error': 'invalid feed operation'}, 400)

    def system_event_ack(self):
        if not self.valid_host() or self.headers.get('Origin') != self.origin:
            self.send_error(403)
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 128:
                raise ValueError('Invalid size')
            seq = json.loads(self.rfile.read(size)).get('seq')
            if type(seq) is not int:
                raise ValueError('Invalid sequence')
            if self.state.network:
                self.state.network.dispatch({'action': 'system-ack', 'seq': seq})
            self.json_response({'accepted': True})
        except (ValueError, TypeError, AttributeError, OSError, network.NetworkError):
            self.json_response({'error': 'invalid request'}, 400)

    def request_power(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 64:
                raise ValueError('Invalid request size')
            request = json.loads(self.rfile.read(size))
            if not isinstance(request, dict) or set(request) != {'mode'} or request['mode'] not in network.POWER_MODES:
                raise ValueError('Invalid power request')
            with self.state.lock:
                # Let installs and Wi-Fi changes finish writing. Not state.busy: a failed
                # update apply leaves it set until restart, which this request must allow.
                installing = any(item.get('phase') in {'checking', 'downloading'}
                                 for item in self.state.status.values())
                if installing or self.state.active_game or self.state.network_busy:
                    self.json_response({'error': 'busy'}, 409)
                    return
            if not self.state.network:
                raise network.NetworkError('unavailable')
            self.state.network.dispatch({'action': 'power', 'mode': request['mode']})
            self.json_response({'accepted': True})
        except network.NetworkError:
            self.json_response({'error': 'unavailable'}, 503)
        except (ValueError, TypeError):
            self.json_response({'error': 'invalid operation'}, 400)


def make_server(state, port=8080):
    instance = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    instance.state = state
    return instance


def mark_ui_ready():
    """Tell the host's boot screen a page has painted, so it can step aside."""
    try:
        (Path(os.environ.get('XDG_RUNTIME_DIR', '/run/host-runtime')) / 'cubby-ui-ready').touch()
    except OSError:
        pass


def app_version(state):
    """The release's version stamp; None for a build that wasn't released."""
    try:
        return json.loads((state.app / 'runtime/version.json').read_text())['version']
    except (OSError, ValueError, KeyError, TypeError):
        return None


def update_attention(state):
    """Whether an adult has an update to act on. Never fails the hub."""
    if not state.updater:
        return False
    try:
        return state.updater.dispatch({'action': 'status'}).get('phase') in {'available', 'staged'}
    except (OSError, ValueError, TypeError):
        return False


def check_for_update(state):
    """Ask the updater to look at the feed; True once it has been consulted.

    Only from idle or a past failure: checking again would demote a staged
    update and overwrite the record of a rollback. Offline stays silent, so a
    handheld away from Wi-Fi doesn't report an update failure to the adult.
    """
    try:
        if state.network_busy or not state.network or not state.updater:
            return False
        if not state.network.dispatch({'action': 'status'}).get('internet'):
            return False
        if state.updater.dispatch({'action': 'status'}).get('phase') in {'idle', 'error'}:
            state.updater.dispatch({'action': 'check'})
        return True
    except (OSError, ValueError, TypeError, network.NetworkError):
        return False


def power_busy(state):
    """Work the idle timer must not interrupt. Button sleep is the person's own call."""
    if state.busy or state.network_busy:
        return True
    if not state.updater:
        return False
    try:
        return state.updater.dispatch({'action': 'status'}).get('phase') in {'checking', 'downloading', 'trial'}
    except (OSError, ValueError, TypeError):
        return False    # A failed update reports as an error, and that's not work in progress.


def relay_system_events(state, wait=time.sleep, keep_going=lambda: True):
    """Carry sleep and wake from the host helper to game pages, acking at once when none listens."""
    seq = -1
    while keep_going():
        try:
            reply = state.network.dispatch({'action': 'system-wait', 'after': seq, 'timeout': 20})
            seq = reply['seq']
            state.system_events.add(seq, reply['events'])
            if reply['events'] and not state.system_events.listening():
                state.network.dispatch({'action': 'system-ack', 'seq': seq})
        except (network.NetworkError, KeyError, TypeError):
            wait(5)


def watch_for_updates(state, wait=time.sleep):
    wait(UPDATE_FIRST_CHECK_SECONDS)
    while True:
        wait(UPDATE_CHECK_SECONDS if check_for_update(state) else UPDATE_RETRY_SECONDS)


if __name__ == '__main__':
    state = State(Path(__file__).resolve().parents[1],
                  Path(os.environ.get('CUBBY_STATE', '/var/lib/handheld')),
                  network_adapter=network.HostClient())
    state.updater = updates.HostClient()
    if os.environ.get('CUBBY_NETWORK_SIMULATION') == '1':
        state.network = network.Onboarding(network.Simulation(), state.data)
    threading.Thread(target=watch_for_updates, args=(state,), daemon=True).start()
    threading.Thread(target=relay_system_events, args=(state,), daemon=True).start()
    make_server(state).serve_forever()

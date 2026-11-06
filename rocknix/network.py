"""Narrow host Wi-Fi bridge for pinned ROCKNIX NetworkManager+iwd.

Only this stdlib helper runs outside the WPE chroot. No shell, arbitrary paths,
URLs or NM properties may be supplied by its client. Its UNIX socket directory
is root-only and is bind-mounted into the chroot; no TCP listener is opened.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

CATALOG = 'https://cubby.david.app/catalog'
SOCKET = '/run/cubby-network/socket'
BSSID = re.compile(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}')
ERRORS = {'invalid_request', 'connection_failed', 'busy', 'unavailable', 'unsupported_network'}
POWER_MODES = {'poweroff', 'reboot'}


class NetworkError(Exception):
    pass


def split_nmcli(line):
    fields, text, escaped = [], '', False
    for char in line:
        if escaped:
            text += char
            escaped = False
        elif char == '\\':
            escaped = True
        elif char == ':':
            fields.append(text)
            text = ''
        else:
            text += char
    fields.append(text)
    return fields


def parse_scan(output):
    result, seen = [], set()
    for line in output.splitlines():
        row = split_nmcli(line)
        if len(row) != 5:
            continue
        active, ssid, bssid, strength, security = row
        if not ssid or len(ssid.encode('utf-8')) > 32 or not BSSID.fullmatch(bssid):
            continue
        if any(ord(char) < 32 for char in ssid) or bssid in seen:
            continue
        seen.add(bssid)
        result.append({'ssid': ssid, 'bssid': bssid, 'signal': int(strength) if strength.isdigit() else 0,
                       'security': security, 'connected': active == '*',
                       'supported': ('802.1X' not in security and 'WEP' not in security
                                     and (security in ('', '--') or 'WPA' in security))})
    return sorted(result, key=lambda row: (not row['connected'], -row['signal']))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise NetworkError('unavailable')


def internet_available():
    """Check the real catalog over certificate-validated HTTPS, not NM's state.

    Redirects, HTML captive portals and malformed/oversized JSON are not online.
    No caller-supplied probe URL, proxy override or TLS bypass is accepted.
    """
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(CATALOG, timeout=8) as response:
            content = response.read(1024 * 1024 + 1)
            if response.status != 200 or len(content) > 1024 * 1024:
                return False
            entries = json.loads(content)
            return (isinstance(entries, list) and bool(entries) and len(entries) <= 1000
                    and all(isinstance(entry, dict) and isinstance(entry.get('id'), str)
                            and isinstance(entry.get('manifest_url'), str)
                            and entry['manifest_url'].startswith('https://') for entry in entries))
    except (OSError, ValueError, NetworkError):
        return False


def escape_keyfile(value):
    # GLib KeyFile escapes; SSID itself uses the unambiguous byte-array syntax.
    return value.replace('\\', '\\\\').replace(' ', '\\s')


class NetworkManager:
    simulation = False

    def __init__(self, profiles=Path('/storage/.config/NetworkManager/system-connections')):
        self.profiles = Path(profiles)

    def command(self, *arguments, timeout=20):
        try:
            result = subprocess.run(['/usr/bin/nmcli', '--colors', 'no', *arguments],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, timeout=timeout, check=False,
                                    env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
            if result.returncode or len(result.stdout) > 256 * 1024:
                raise NetworkError('connection_failed')
            return result.stdout.decode('utf-8', errors='replace')
        except (OSError, subprocess.TimeoutExpired):
            raise NetworkError('unavailable') from None

    def interface(self):
        output = self.command('-t', '-f', 'DEVICE,TYPE', 'device', 'status')
        for line in output.splitlines():
            row = split_nmcli(line)
            if len(row) == 2 and row[1] == 'wifi' and re.fullmatch(r'[a-zA-Z0-9_-]{1,32}', row[0]):
                return row[0]
        raise NetworkError('unavailable')

    def scan(self):
        interface = self.interface()
        self.command('radio', 'wifi', 'on')
        # Rescan on the selected Wi-Fi interface only; never touch Ethernet/USB.
        return parse_scan(self.command('-t', '--escape', 'yes', '-f',
                         'IN-USE,SSID,BSSID,SIGNAL,SECURITY', 'device', 'wifi', 'list',
                         'ifname', interface, '--rescan', 'yes', timeout=25))

    def status(self):
        return {'internet': internet_available(), 'simulation': False}

    def connect(self, bssid, password):
        if (not isinstance(bssid, str) or not BSSID.fullmatch(bssid)
                or not isinstance(password, str) or len(password) > 64
                or any(ord(char) < 32 or ord(char) > 126 for char in password)):
            raise NetworkError('invalid_request')
        entry = next((row for row in self.scan() if row['bssid'].lower() == bssid.lower()), None)
        if entry is None:
            raise NetworkError('invalid_request')
        if not entry['supported']:
            raise NetworkError('unsupported_network')
        secured = entry['security'] not in ('', '--')
        sae = 'WPA3' in entry['security'] and 'WPA2' not in entry['security']
        if secured and not (8 <= len(password) <= 63 or (not sae and re.fullmatch('[0-9a-fA-F]{64}', password))):
            raise NetworkError('invalid_request')
        if not secured and password:
            raise NetworkError('invalid_request')
        identity = str(uuid.uuid4())
        # NM's pinned configuration persists keyfiles here. Credentials never
        # occur in subprocess argv, logs, our state JSON, or browser storage.
        self.profiles.mkdir(parents=True, exist_ok=True)
        profile = self.profiles / ('cubby-' + identity + '.nmconnection')
        content = (f'[connection]\nid=cubby-{identity}\nuuid={identity}\ntype=wifi\nautoconnect=false\n'
                   '[wifi]\nmode=infrastructure\nssid=' + ''.join(str(b) + ';' for b in entry['ssid'].encode())
                   + '\n[ipv4]\nmethod=auto\n[ipv6]\nmethod=auto\n')
        if secured:
            method = 'sae' if sae else 'wpa-psk'
            content += f'[wifi-security]\nkey-mgmt={method}\npsk-flags=0\npsk={escape_keyfile(password)}\n'
        created = False
        try:
            with open(profile, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
                created = True
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            self.command('connection', 'load', str(profile))
            self.command('--wait', '90', 'connection', 'up', 'uuid', identity, timeout=95)
            self.command('connection', 'modify', 'uuid', identity, 'connection.autoconnect', 'yes')
        except (OSError, NetworkError):
            if created:
                try:
                    self.command('connection', 'delete', 'uuid', identity)
                except NetworkError:
                    pass
                profile.unlink(missing_ok=True)
            raise NetworkError('connection_failed') from None
        return self.status()


class Simulation:
    """Explicit desktop fixture. Never detects or changes the host's network."""
    simulation = True

    def __init__(self):
        self.online = False

    def scan(self):
        return [{'ssid': 'Cubby simulation Wi-Fi', 'bssid': '02:00:00:00:00:01',
                 'signal': 95, 'security': 'WPA2', 'supported': True, 'connected': self.online}]

    def status(self):
        return {'internet': self.online, 'simulation': True}

    def connect(self, bssid, password):
        if bssid != '02:00:00:00:00:01' or password != 'cubby-test':
            raise NetworkError('connection_failed')
        self.online = True
        return self.status()


class Onboarding:
    def __init__(self, adapter, state):
        self.adapter, self.state = adapter, Path(state)
        self.lock = threading.Lock()

    @property
    def complete(self):
        try:
            return json.loads((self.state / 'network-onboarded.json').read_text()) == {'schema': 1, 'complete': True}
        except (OSError, ValueError):
            return False

    def status(self):
        return dict(self.adapter.status(), complete=self.complete)

    def finish(self):
        result = self.status()
        if result['internet']:
            self.state.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix='.network-onboarded-', dir=self.state)
            try:
                with os.fdopen(fd, 'w') as stream:
                    json.dump({'schema': 1, 'complete': True}, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.state / 'network-onboarded.json')
                result['complete'] = True
            finally:
                Path(temporary).unlink(missing_ok=True)
        return result

    def dispatch(self, request):
        if not isinstance(request, dict):
            raise NetworkError('invalid_request')
        action = request.get('action')
        if action == 'status' and set(request) == {'action'}:
            return self.status()
        if action not in {'scan', 'connect', 'finish'}:
            raise NetworkError('invalid_request')
        expected = {'action', 'bssid', 'password'} if action == 'connect' else {'action'}
        if set(request) != expected:
            raise NetworkError('invalid_request')
        if not self.lock.acquire(blocking=False):
            raise NetworkError('busy')
        try:
            if action == 'scan':
                return {'networks': self.adapter.scan(), 'simulation': self.adapter.simulation}
            if action == 'connect':
                return self.adapter.connect(request['bssid'], request['password'])
            return self.finish()
        finally:
            self.lock.release()


class HostClient:
    def __init__(self, path=SOCKET):
        self.path = path

    def dispatch(self, request):
        try:
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(240)
                client.connect(self.path)
                client.sendall(json.dumps(request).encode() + b'\n')
                with client.makefile('rb') as stream:
                    response = json.loads(stream.readline(256 * 1024 + 1))
            if 'error' in response:
                raise NetworkError(response['error'] if response['error'] in ERRORS else 'unavailable')
            return response
        except (OSError, ValueError):
            raise NetworkError('unavailable') from None


def run_power(mode):
    result = subprocess.run(['/usr/bin/systemctl', '--no-block', mode], stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
    if result.returncode:
        print('Cubby power request failed:', mode, result.returncode, file=sys.stderr)


def request_power(request, delay=.3):
    """Power off or restart the host.

    This helper runs outside the chroot, from the running release. Shutdown stops
    this service at once, so answer before starting it.
    """
    if set(request) != {'action', 'mode'} or request['mode'] not in POWER_MODES:
        raise NetworkError('invalid_request')
    threading.Timer(delay, run_power, (request['mode'],)).start()
    return {'accepted': True}


class HostHandler(socketserver.StreamRequestHandler):
    def handle(self):
        # Mode 0700 directory plus root peer check: even a local non-root user
        # cannot bypass the adult HTTP flow by sending requests to the socket.
        _, uid, _ = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != self.server.allowed_uid:
            return
        self.request.settimeout(5)
        try:
            line = self.rfile.readline(4097)
            if len(line) > 4096 or not line.endswith(b'\n'):
                raise NetworkError('invalid_request')
            request = json.loads(line)
            if isinstance(request, dict) and request.get('action') == 'power':
                result = request_power(request)
            else:
                result = self.server.manager.dispatch(request)
        except NetworkError as error:
            result = {'error': str(error) if str(error) in ERRORS else 'unavailable'}
        except (OSError, ValueError, TypeError):
            result = {'error': 'invalid_request'}
        self.wfile.write(json.dumps(result).encode() + b'\n')


class HostServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def bridge_to_guarded_updates(wait=60, sleep=time.sleep):
    """Carry a device installed by the old baseline coordinator onto signed whole-device updates.

    This is the only code from an update that such a device runs outside its
    chroot, and it runs from the release, so it waits for that release to pass
    its own trial. updates.py sits beside this file. Network setup must keep
    working whatever happens here.
    """
    try:
        here = Path(__file__).resolve()
        release, base = here.parents[2], here.parents[4]
        if release.parent.name != 'releases':
            return
        spec = importlib.util.spec_from_file_location('cubby_updates', here.with_name('updates.py'))
        updates = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(updates)
        while updates.bridge(base, release) == 'waiting':
            sleep(wait)
    except Exception as error:  # Retried from the next session; never breaks this helper.
        print('Cubby update bridge did not finish:', error, file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', default=SOCKET)
    parser.add_argument('--state', default='/storage/cubby/state')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Host network helper requires device root')
    path = Path(args.socket)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    # Invoked once per private essway mount namespace. No reuse of another
    # session's listener: chroot-run owns and removes exactly this socket.
    with HostServer(str(path), HostHandler) as server:
        os.chmod(path, 0o600)
        server.allowed_uid = 0
        server.manager = Onboarding(NetworkManager(), args.state)
        threading.Thread(target=bridge_to_guarded_updates, daemon=True).start()
        server.serve_forever()


if __name__ == '__main__':
    main()

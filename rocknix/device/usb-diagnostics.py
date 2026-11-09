#!/usr/bin/python3
"""Read-only status over ROCKNIX's USB NCM interface; no command/file API."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

USB_ADDRESS = '169.254.170.2'
USB_INTERFACE = 'gadget'
PORT = 8765


def capture(argv, limit=65536, timeout=5):
    """Fixed commands only. Spool output rather than accumulating it in RAM."""
    with tempfile.TemporaryFile() as output:
        try:
            result = subprocess.run(argv, stdout=output, stderr=subprocess.STDOUT,
                                    timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            return {'error': 'timeout'}
        except OSError as error:
            return {'error': str(error)}
        size = output.tell()
        output.seek(max(0, size-limit))
        return {'exit': result.returncode, 'output': output.read(limit).decode(errors='replace'),
                'truncated': size > limit}


def read(path, limit=4096):
    try:
        with open(path, 'rb') as stream:
            return stream.read(limit).replace(b'\x00', b'').decode(errors='replace').strip()
    except OSError as error:
        return str(error)


def tail(path, limit=32768):
    try:
        with open(path, 'rb') as stream:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - limit))
            return stream.read(limit).decode(errors='replace')
    except OSError as error:
        return str(error)


def snapshot():
    return {
        'schema': 1, 'time': time.time(),
        'boot_id': read('/proc/sys/kernel/random/boot_id'),
        'model': read('/proc/device-tree/model'),
        'uptime': read('/proc/uptime'),
        'cubby_launch_failures': read('/run/cubby-launch-failures'),
        'kernel': capture(['dmesg'], limit=32768),
        'boot_log': tail('/var/log/boot.log'),
        'session_log': tail('/storage/cubby/state/session.log'),
        'previous_session_log': tail('/storage/cubby/state/session.previous.log'),
        'wifi_recovery': tail('/storage/cubby/diagnostics/wifi-recovery.txt'),
        'units': capture(['systemctl', '--no-pager', '--full', 'status',
                          'rocknix-autostart.service', 'essway.service', 'sway.service',
                          'cubby-usb-diagnostics.service', 'cubby-wifi-recovery.service']),
        'journal': capture(['journalctl', '-b', '--no-pager', '-n', '120',
                            '-u', 'essway.service', '-u', 'sway.service',
                            '-u', 'rocknix-autostart.service']),
        'storage': capture(['findmnt', '/storage']),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/status':
            self.send_error(404)
            return
        body = json.dumps(snapshot(), sort_keys=True).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def setup(self):
        self.request.settimeout(3)
        super().setup()

    def log_message(self, *_):
        pass


class DiagnosticsServer(HTTPServer):
    allow_reuse_address = True


def usb_server():
    server = DiagnosticsServer((USB_ADDRESS, PORT), Handler, bind_and_activate=False)
    try:
        # Fail closed if binding to the USB interface is unavailable. The address
        # alone would also be reachable via a host route through another NIC.
        server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE,
                                 USB_INTERFACE.encode() + b'\0')
        server.server_bind()
        server.server_activate()
        server.timeout = 2
        return server
    except BaseException:
        server.server_close()
        raise


def main():
    server = usb_server()
    interface_index = socket.if_nametoindex(USB_INTERFACE)
    last = 0
    while True:
        # If native USB mode management recreates the gadget, let systemd
        # restart us and bind its replacement rather than retain a stale index.
        if socket.if_nametoindex(USB_INTERFACE) != interface_index:
            raise RuntimeError('USB interface recreated; reconnecting')
        server.handle_request()
        now = time.monotonic()
        if now - last >= 15:
            # Offline snapshots are optional: storage trouble must not take
            # down the live diagnostic path. Throttle failed attempts too.
            last = now
            try:
                directory = Path('/storage/cubby/diagnostics')
                directory.mkdir(parents=True, exist_ok=True)
                temporary = directory / 'latest.json.tmp'
                temporary.write_text(json.dumps(snapshot(), sort_keys=True) + '\n')
                os.replace(temporary, directory / 'latest.json')
            except OSError as error:
                print(f'Unable to persist USB diagnostic snapshot: {error}',
                      file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()

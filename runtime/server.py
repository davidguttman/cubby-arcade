"""Loopback-only offline asset server; stores bounded browser diagnostics."""
import http.server
import io
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit
try:
    from . import packages, game_shell
except ImportError:
    import packages, game_shell

ROOT = Path(__file__).resolve().parents[1]
STATE = Path('/var/lib/handheld')
GAMES = packages.GAMES


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_head(self):
        # A sync can replace bytes without changing the HTTP timestamp. Always
        # deliver the current file rather than validating an older cached copy.
        for header in ('If-Modified-Since', 'If-None-Match'):
            if header in self.headers:
                del self.headers[header]
        self.range_length = None
        value = self.headers.get('Range')
        path = Path(self.translate_path(self.path))
        # The local WPE host already manages disk packages through /library.
        # Mark that host explicitly: ordinary HTTPS browsers use their own
        # service worker/storage adapter, not this legacy loopback capability.
        if path == ROOT / 'runtime/index.html' and path.is_file():
            original = path.read_bytes()
            content = original.replace(b'</head>',
                b'<script>window.HandheldPlatformOptions={kind:"kiosk"};</script></head>', 1)
            if content != original:
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                return io.BytesIO(content)
        if urlsplit(self.path).path.startswith('/games/') and path.suffix.lower() == '.html' and path.is_file():
            content = game_shell.inject(path.read_bytes())
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            return io.BytesIO(content)
        if not value or not path.is_file():
            return super().send_head()
        # Video decoders seek even with local files. Support a single bounded
        # byte range without buffering the whole package asset into memory.
        content = path.open('rb')
        size = path.stat().st_size
        match = re.fullmatch(r'bytes=([0-9]{0,20})-([0-9]{0,20})', value)
        start, end = 0, -1
        if match and any(match.groups()) and size:
            left, right = match.groups()
            if left:
                start = int(left)
                end = min(int(right), size - 1) if right else size - 1
            elif int(right):
                start, end = max(0, size - int(right)), size - 1
        if not 0 <= start <= end < size:
            content.close()
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        self.range_length = end - start + 1
        content.seek(start)
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(str(path)))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(self.range_length))
        self.end_headers()
        return content

    def copyfile(self, source, outputfile):
        if self.range_length is None:
            return super().copyfile(source, outputfile)
        remaining = self.range_length
        while remaining:
            chunk = source.read(min(65536, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
        if path.startswith('/games/'):
            parts = path.split('/')
            game_id, relative = parts[2], '/'.join(parts[3:])
            try:
                packages.safe_path(relative)
                entry = next(g for g in packages.library(GAMES) if g['id'] == game_id)
                release = (GAMES / entry['id'] / 'current').resolve(strict=True)
                manifest = packages.validate_manifest(json.loads((release / 'manifest.json').read_text()))
                if relative not in manifest['files']:
                    raise ValueError('Not a package asset')
                target = (release / relative).resolve(strict=True)
                if not target.is_relative_to(release):
                    raise ValueError('Invalid path')
                return str(target)
            except (ValueError, OSError, StopIteration, KeyError, TypeError):
                return str(ROOT / '.missing-game-asset')
        if path in {'/', '/play', '/play/'}:
            path = '/runtime/index.html'
        if path not in {'/runtime/index.html', '/runtime/core/input.js',
                         '/runtime/core/browser-store.js', '/runtime/core/browser-bootstrap.js',
                         '/runtime/core/preferences.js', '/runtime/core/platform.js', '/runtime/core/sdk.js',
                         '/runtime/core/controls.js', '/runtime/core/screen.css',
                         '/runtime/core/hub.js', '/runtime/core/hub.css', '/runtime/core/game-shell.js',
                         '/runtime/core/host-osd.js', '/runtime/core/host-osd.css',
                         '/runtime/core/profiles.js', '/runtime/core/avatars.js',
                         '/runtime/core/keyboard.js', '/runtime/core/keyboard.css'}:
            return str(ROOT / '.missing-runtime-asset')
        return str(ROOT / path.lstrip('/'))

    def do_GET(self):
        if urlsplit(self.path).path in {'/library', '/catalog'}:
            content = json.dumps(packages.library(GAMES)).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        super().do_GET()

    def do_POST(self):
        if self.path != '/report':
            self.send_error(404)
            return
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 16384:
            self.send_error(413)
            return
        try:
            value = json.loads(self.rfile.read(size))
            temporary = STATE / 'browser-report.tmp'
            temporary.write_text(json.dumps(value, indent=2) + '\n')
            temporary.replace(STATE / 'browser-report.json')
        except (ValueError, OSError):
            self.send_error(400)
            return
        self.send_response(204)
        self.end_headers()


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('127.0.0.1', 8080), Handler).serve_forever()

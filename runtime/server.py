"""Loopback-only offline asset server; stores bounded browser diagnostics."""
import http.server
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit
try:
    from . import packages
except ImportError:
    import packages

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
        return super().send_head()

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
        if path == '/':
            path = '/runtime/index.html'
        if path != '/runtime/index.html':
            return str(ROOT / '.missing-runtime-asset')
        return str(ROOT / 'runtime/index.html')

    def do_GET(self):
        if urlsplit(self.path).path == '/library':
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

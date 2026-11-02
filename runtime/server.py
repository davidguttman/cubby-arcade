"""Loopback-only offline asset server; stores bounded browser diagnostics."""
import http.server
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE = Path('/var/lib/handheld')


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

    def do_GET(self):
        if self.path == '/':
            self.path = '/runtime/index.html'
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

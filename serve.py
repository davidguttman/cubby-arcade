#!/usr/bin/env python3
"""Read-only Cubby Arcade preview/catalog host; Python standard library only."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

PUBLIC = Path(__file__).resolve().parent / 'public'
IMMUTABLE = re.compile(r'^/store/(?:line-cutter/0\.2\.(?:0|1)|little-camp/0\.1\.0)/[^/].*$')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self.remaining = None
        super().__init__(*args, **kwargs)

    def translate_path(self, path):
        # Exact aliases only: never rewrite missing assets into HTML.
        parsed = urlsplit(path)
        aliases = {'/': '/site/index.html', '/index.html': '/site/index.html',
                   '/play': '/index.html', '/play/': '/index.html',
                   '/native/index.html': '/index.html'}
        return super().translate_path(aliases.get(parsed.path, parsed.path))

    def guess_type(self, path):
        if Path(path).name in {'catalog', 'library', 'hub-manifest.json'}:
            return 'application/json; charset=utf-8'
        return super().guess_type(path)

    def send_response(self, code, message=None):
        self.response_code = code
        super().send_response(code, message)

    def end_headers(self):
        path = unquote(urlsplit(self.path).path)
        if urlsplit(self.path).path in {'/', '/index.html'}:
            self.send_header('Vary', 'Referer')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Range')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
        cache = ('public, max-age=31536000, immutable' if (self.response_code in (200, 206, 304) and IMMUTABLE.fullmatch(path))
                 else 'public, max-age=0, must-revalidate')
        self.send_header('Cache-Control', cache)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        if urlsplit(self.path).path != '/report':
            self.send_error(404)
            return
        # The static preview has no report storage. Do not read or retain input.
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True

    def send_head(self):
        self.remaining = None
        # Legacy games shipped with a root-relative Back action. Keep those
        # immutable payloads working, without changing direct/bookmarked landing
        # visits or accepting a foreign site's navigation hint.
        if urlsplit(self.path).path in {'/', '/index.html'}:
            try:
                referer = urlsplit(self.headers.get('Referer', ''))
                legacy_return = (referer.scheme in {'http', 'https'}
                                 and referer.netloc.lower() == self.headers.get('Host', '').lower()
                                 and referer.username is None
                                 and referer.path.startswith('/games/'))
            except ValueError:
                legacy_return = False
            if legacy_return:
                self.send_response(302)
                self.send_header('Location', '/play')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return None
        request_path = unquote(urlsplit(self.path).path)
        if any(part.startswith('.') for part in request_path.split('/') if part):
            self.send_error(404)
            return None
        path = Path(self.translate_path(self.path))
        if not path.resolve().is_relative_to(PUBLIC.resolve()):
            self.send_error(404)
            return None
        requested_range = self.headers.get('Range')
        if requested_range is None or not path.is_file():
            return super().send_head()
        # Single byte ranges support video seeking and resumable package reads.
        size = path.stat().st_size
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested_range.strip())
        try:
            if not match or not any(match.groups()):
                raise ValueError
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            else:
                suffix = int(last)
                if suffix <= 0:
                    raise ValueError
                start, end = max(0, size - suffix), size - 1
            if start >= size or start > end or size == 0:
                raise ValueError
        except ValueError:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        stream = path.open('rb')
        stream.seek(start)
        self.remaining = end - start + 1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(str(path)))
        self.send_header('Content-Length', str(self.remaining))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Last-Modified', self.date_time_string(path.stat().st_mtime))
        self.end_headers()
        return stream

    def copyfile(self, source, outputfile):
        if self.remaining is None:
            return super().copyfile(source, outputfile)
        while self.remaining:
            block = source.read(min(65536, self.remaining))
            if not block:
                break
            outputfile.write(block)
            self.remaining -= len(block)


def server(address):
    return ThreadingHTTPServer(address, partial(Handler, directory=str(PUBLIC)))


if __name__ == '__main__':
    with server(('0.0.0.0', int(os.environ.get('PORT', '10000')))) as host:
        host.serve_forever()

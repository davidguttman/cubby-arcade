#!/usr/bin/env python3
"""Read-only Cubby Arcade preview/catalog host; Python standard library only."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

PUBLIC = Path(__file__).resolve().parents[1] / '.cache/web'
IMMUTABLE = re.compile(r'^/store/[a-z0-9-]+/[0-9]+\.[0-9]+\.[0-9]+/[^/]+$')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self.remaining = None
        super().__init__(*args, **kwargs)

    def guess_type(self, path):
        if Path(path).name in {'catalog', 'library', 'hub-manifest.json'}:
            return 'application/json; charset=utf-8'
        return super().guess_type(path)

    def send_response(self, code, message=None):
        self.response_code = code
        super().send_response(code, message)

    def end_headers(self):
        path = unquote(urlsplit(self.path).path)
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
        request_path = unquote(urlsplit(self.path).path)
        if any(part.startswith('.') for part in request_path.split('/') if part):
            self.send_error(404)
            return None
        redirect = self.server.manifest_redirects.get(request_path)
        if redirect:
            self.send_response(302)
            self.send_header('Location', redirect)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        path = Path(self.translate_path(self.path))
        if not path.resolve().is_relative_to(Path(self.directory).resolve()):
            self.send_error(404)
            return None
        if path.is_dir():
            for name in ('index.html', 'index.htm'):
                index = path / name
                if index.exists():
                    if not index.resolve().is_relative_to(Path(self.directory).resolve()):
                        self.send_error(404)
                        return None
                    break
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


def server(address, directory=PUBLIC):
    directory = Path(directory)
    config = directory / '.manifest-redirects.json'
    redirects = json.loads(config.read_text()) if config.is_file() else {}
    if not isinstance(redirects, dict):
        raise ValueError('Invalid manifest redirects')
    for source, target in redirects.items():
        parsed = urlsplit(target)
        if not re.fullmatch(r'/store/[a-z0-9-]+/manifest\.json', source) or parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or any(c in target for c in '\r\n'):
            raise ValueError('Invalid manifest redirect')
    host = ThreadingHTTPServer(address, partial(Handler, directory=str(directory)))
    host.manifest_redirects = redirects
    return host


if __name__ == '__main__':
    with server(('0.0.0.0', int(os.environ.get('PORT', '10000')))) as host:
        host.serve_forever()

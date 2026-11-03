#!/usr/bin/env python3
"""Read-only Cubby Arcade preview/catalog host; Python standard library only."""
from functools import partial
import io
import json
import sys
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPException
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from runtime import catalog

PUBLIC = ROOT / '.cache/web'
IMMUTABLE = re.compile(r'^/store/[a-z0-9-]+/[0-9]+\.[0-9]+\.[0-9]+/[^/]+$')


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        raise ValueError('Upstream metadata redirects rejected')


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

    def forwarded_manifest(self, target, game_id):
        # Buffer and validate a bounded metadata response before sending any bytes.
        # This is live forwarding, not a cached release snapshot or HTTP redirect.
        try:
            opener = urllib.request.build_opener(RejectRedirects())
            with opener.open(target, timeout=self.server.metadata_timeout) as response:
                if response.status != 200:
                    raise ValueError('Unexpected upstream status')
                length = response.headers.get('Content-Length')
                if length is not None and int(length) > catalog.MAX_RELEASE:
                    raise ValueError('Upstream manifest too large')
                body = response.read(catalog.MAX_RELEASE + 1)
                if len(body) > catalog.MAX_RELEASE:
                    raise ValueError('Upstream manifest too large')
                catalog.validate_release(json.loads(body), game_id, self.server.developer_local)
        except (OSError, HTTPException, ValueError, TypeError, RecursionError):
            self.send_error(502, 'Unable to read release metadata')
            return None
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        return io.BytesIO(body)

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
        target = self.server.manifest_proxies.get(request_path)
        if target:
            return self.forwarded_manifest(target, request_path.split('/')[2])
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


def server(address, directory=PUBLIC, developer_local=False):
    directory = Path(directory)
    config = directory / '.manifest-proxies.json'
    proxies = json.loads(config.read_text()) if config.is_file() else {}
    if not isinstance(proxies, dict):
        raise ValueError('Invalid manifest forwarding configuration')
    for source, target in proxies.items():
        if not re.fullmatch(r'/store/[a-z0-9-]+/manifest\.json', source):
            raise ValueError('Invalid manifest forwarding path')
        catalog.check_url(target, developer_local)
        if any(c in target for c in '\r\n'):
            raise ValueError('Invalid manifest forwarding URL')
    host = ThreadingHTTPServer(address, partial(Handler, directory=str(directory)))
    host.manifest_proxies = proxies
    host.metadata_timeout = 20
    host.developer_local = developer_local
    return host


if __name__ == '__main__':
    with server(('0.0.0.0', int(os.environ.get('PORT', '10000')))) as host:
        host.serve_forever()

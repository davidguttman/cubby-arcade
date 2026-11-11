"""Introduces two paired devices so they can open a direct connection.

Stores nothing on disk and cannot read what it carries: each blob is encrypted
with a key only the paired devices hold, and a room name is a hash of that key's
secret. Messages live in memory for a minute, long enough for both sides to be
polling at once. Standard library only.
"""
import http.server
import json
import re
import threading
import time
from urllib.parse import parse_qs, urlsplit

ROOM = re.compile(r'^/v1/rooms/([0-9a-f]{32})/messages$')
MEMBER = re.compile(r'^[0-9a-f]{16}$')
MAX_BLOB = 16384
MAX_MESSAGES = 32
MESSAGE_SECONDS = 60
PRESENT_SECONDS = 40
MAX_WAIT = 25
MAX_ROOMS = 20000


class Rooms:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.changed = threading.Condition()
        self.rooms = {}

    def _room(self, name):
        room = self.rooms.get(name)
        if room is None:
            if len(self.rooms) >= MAX_ROOMS:
                self._sweep()
                if len(self.rooms) >= MAX_ROOMS:
                    raise OverflowError
            room = self.rooms[name] = {'seq': 0, 'messages': [], 'seen': {}}
        return room

    def _sweep(self):
        now = self.clock()
        for name in [name for name, room in self.rooms.items()
                     if not self._present(room, now) and not self._fresh(room, now)]:
            del self.rooms[name]

    @staticmethod
    def _present(room, now):
        return sorted(member for member, at in room['seen'].items() if now - at < PRESENT_SECONDS)

    @staticmethod
    def _fresh(room, now):
        room['messages'] = [item for item in room['messages'] if now - item['at'] < MESSAGE_SECONDS]
        return room['messages']

    def send(self, name, sender, blob):
        with self.changed:
            room = self._room(name)
            room['seq'] += 1
            room['messages'] = (room['messages'] + [{'seq': room['seq'], 'from': sender, 'blob': blob,
                                                    'at': self.clock()}])[-MAX_MESSAGES:]
            self.changed.notify_all()
            return room['seq']

    def poll(self, name, member, after, wait):
        """Messages from others after `after`, and who else is here. Returns early on either changing."""
        deadline = self.clock() + min(max(wait, 0), MAX_WAIT)
        with self.changed:
            room = self._room(name)
            # A cursor from before a relay restart is ahead of this room: start over.
            if after > room['seq']:
                after = 0
            before = None
            while True:
                now = self.clock()
                room['seen'][member] = now
                peers = [other for other in self._present(room, now) if other != member]
                messages = [{'seq': item['seq'], 'from': item['from'], 'blob': item['blob']}
                            for item in self._fresh(room, now) if item['seq'] > after and item['from'] != member]
                if before is None:
                    before = peers
                    # Tell everyone already waiting that this member arrived.
                    self.changed.notify_all()
                if messages or peers != before or now >= deadline:
                    return {'seq': max([after] + [item['seq'] for item in messages]),
                            'messages': messages, 'peers': peers}
                self.changed.wait(min(deadline - now, 5))


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def reply(self, status, value=None):
        content = b'' if value is None else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Max-Age', '86400')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_OPTIONS(self):
        self.reply(204)

    def do_GET(self):
        parts = urlsplit(self.path)
        if parts.path == '/health':
            return self.reply(200, {'ready': True})
        match = ROOM.match(parts.path)
        query = parse_qs(parts.query)
        member = query.get('me', [''])[0]
        if not match or not MEMBER.match(member):
            return self.reply(404, {'error': 'not found'})
        try:
            after = int(query.get('after', ['0'])[0])
            wait = float(query.get('wait', ['25'])[0])
            self.reply(200, self.server.rooms.poll(match.group(1), member, after, wait))
        except ValueError:
            self.reply(400, {'error': 'bad request'})
        except OverflowError:
            self.reply(503, {'error': 'busy'})

    def do_POST(self):
        match = ROOM.match(urlsplit(self.path).path)
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            size = -1
        if not match or not 0 < size <= MAX_BLOB + 256:
            return self.reply(404 if not match else 413, {'error': 'rejected'})
        try:
            body = json.loads(self.rfile.read(size))
            sender, blob = body['from'], body['blob']
            if not MEMBER.match(sender) or not isinstance(blob, str) or not 0 < len(blob) <= MAX_BLOB:
                raise ValueError
            self.reply(200, {'seq': self.server.rooms.send(match.group(1), sender, blob)})
        except (ValueError, KeyError, TypeError):
            self.reply(400, {'error': 'bad request'})
        except OverflowError:
            self.reply(503, {'error': 'busy'})


def make_server(host='127.0.0.1', port=8790, rooms=None):
    server = http.server.ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.rooms = rooms or Rooms()
    return server


if __name__ == '__main__':
    import os
    make_server(os.environ.get('HOST', '0.0.0.0'), int(os.environ.get('PORT', '8790'))).serve_forever()

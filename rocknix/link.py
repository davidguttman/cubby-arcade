"""The handheld's end of Cubby Link: a pipe, and nothing more.

The handheld's browser has no WebRTC, so this process reaches the introduction
relay and holds the data channels for it. It never sees a pairing secret and
cannot read an introduction; `runtime/core/link.js` in the page decides
everything and tells this what to carry. It outlives page changes, so a
connection stays up while the child moves between the hub and games.
"""
import asyncio
import importlib.util
import json
import re
import secrets
import threading
import time
import urllib.error
import urllib.request

ROOM = re.compile(r'^[0-9a-f]{32}$')
MEMBER = re.compile(r'^[0-9a-f]{16}$')
RELAY = re.compile(r'^(https://[a-z0-9.-]+(:\d+)?|http://127\.0\.0\.1:\d+)$')
MAX_EVENTS = 2000
MAX_ROOMS = 16
MAX_DATA = 200000
POLL_SECONDS = 25


def webrtc_installed():
    """Whether this runtime carries the WebRTC library, without loading it."""
    try:
        return importlib.util.find_spec('aiortc') is not None
    except (ImportError, ValueError):
        return False


def webrtc():
    import aiortc
    return aiortc


class Link:
    def __init__(self, opener=urllib.request.urlopen, rtc=webrtc, installed=webrtc_installed, wait=time.sleep):
        self.boot = secrets.token_hex(8)
        self.opener, self.wait = opener, wait
        # Loaded on first use: a Cubby with nothing paired never pays for it.
        self.load_rtc, self.rtc = rtc, None
        self.has_rtc = bool(installed())
        self.available = True  # relay-only fallback works without aiortc
        self.changed = threading.Condition()
        self.events, self.seq = [], 0
        self.me, self.relay = None, None
        self.rooms = {}        # room -> {'stop': Event, 'peers': [...]}
        self.lines = {}        # room -> {'pc': ..., 'channel': ...}; touched only on the loop thread
        self.relay_lines = {}  # room -> True; relay-only connections when aiortc unavailable
        self.loop = None

    # --- events for the page ---
    def emit(self, event):
        with self.changed:
            self.seq += 1
            self.events = (self.events + [{'seq': self.seq, **event}])[-MAX_EVENTS:]
            self.changed.notify_all()

    def read(self, boot, after, timeout):
        """Events after `after`. A cursor from an earlier run of this process starts over."""
        if boot != self.boot:
            after = 0
        deadline = time.monotonic() + timeout
        with self.changed:
            while True:
                events = [event for event in self.events if event['seq'] > after]
                remaining = deadline - time.monotonic()
                if events or remaining <= 0:
                    return {'boot': self.boot, 'seq': events[-1]['seq'] if events else after, 'events': events}
                self.changed.wait(remaining)

    # --- the relay ---
    def set_rooms(self, me, rooms, relay):
        if not MEMBER.match(me or '') or len(rooms) > MAX_ROOMS or any(not ROOM.match(room) for room in rooms):
            raise ValueError('Invalid rooms')
        if rooms and not RELAY.match(relay or ''):
            raise ValueError('Invalid relay')
        gone = []
        with self.changed:
            if (me, relay) != (self.me, self.relay):
                for entry in self.rooms.values():
                    entry['stop'].set()
                self.rooms = {}
            self.me, self.relay = me, relay
            for room in [room for room in self.rooms if room not in rooms]:
                self.rooms.pop(room)['stop'].set()
                gone.append(room)
            for room in rooms:
                if room not in self.rooms:
                    entry = self.rooms[room] = {'stop': threading.Event(), 'peers': []}
                    threading.Thread(target=self.poll, args=(room, entry, me, relay), daemon=True).start()
            current = {room: list(entry['peers']) for room, entry in self.rooms.items()}
        # Outside the lock: closing a connection reports events, which need it.
        for room in gone:
            self.close(room)
        return {room: {'peers': peers, 'open': self.is_open(room)} for room, peers in current.items()}

    def poll(self, room, entry, me, relay):
        after, known = 0, None
        while not entry['stop'].is_set():
            try:
                # Saying who we last saw lets the relay answer at once when that changed.
                url = f'{relay}/v1/rooms/{room}/messages?me={me}&after={after}&wait={POLL_SECONDS}'
                if known is not None:
                    url += '&peers=' + ','.join(known)
                with self.opener(url, timeout=POLL_SECONDS + 10) as reply:
                    body = json.loads(reply.read(1 << 20))
                if entry['stop'].is_set():
                    return
                after = body['seq']
                peers = known = sorted(str(peer) for peer in body['peers'])
                batch = []
                if peers != entry['peers']:
                    entry['peers'] = peers
                    batch.append({'type': 'presence', 'room': room, 'peers': peers})
                for message in body['messages']:
                    blob = str(message['blob'])
                    if blob.startswith('d:'):
                        if str(message.get('from', '')) != me:  # skip own data echoed back
                            batch.append({'type': 'message', 'room': room, 'data': blob[2:]})
                    else:
                        batch.append({'type': 'signal', 'room': room, 'blob': blob})
                if batch:
                    with self.changed:
                        for event in batch:
                            self.seq += 1
                            self.events = (self.events + [{'seq': self.seq, **event}])[-MAX_EVENTS:]
                        self.changed.notify_all()
            except (OSError, ValueError, KeyError, TypeError):
                known = None
                if entry['peers']:
                    entry['peers'] = []
                    self.emit({'type': 'presence', 'room': room, 'peers': []})
                self.wait(5)

    def signal(self, room, blob):
        if room not in self.rooms or not isinstance(blob, str):
            raise ValueError('Unknown room')
        request = urllib.request.Request(f'{self.relay}/v1/rooms/{room}/messages', method='POST',
                                         headers={'Content-Type': 'application/json'},
                                         data=json.dumps({'from': self.me, 'blob': blob}).encode())
        with self.opener(request, timeout=10) as reply:
            reply.read()

    # --- data channels; aiortc runs on its own loop thread ---
    def run(self, job, timeout=20):
        if not self.has_rtc:
            job.close()
            raise RuntimeError('Link unavailable')
        with self.changed:
            if self.loop is None:
                self.rtc = self.load_rtc()
                self.loop = asyncio.new_event_loop()
                threading.Thread(target=self.loop.run_forever, daemon=True).start()
        return asyncio.run_coroutine_threadsafe(job, self.loop).result(timeout)

    def is_open(self, room):
        if room in self.relay_lines:
            return True
        line = self.lines.get(room)
        return bool(line and line['channel'] is not None and line['channel'].readyState == 'open')

    async def drop(self, room):
        line = self.lines.pop(room, None)
        if line:
            await line['pc'].close()

    def connection(self, room):
        # No outside lookups: the phone is on the same home network, and waiting on
        # one costs five seconds here.
        pc = self.rtc.RTCPeerConnection(self.rtc.RTCConfiguration(iceServers=[]))
        line = self.lines[room] = {'pc': pc, 'channel': None}

        @pc.on('connectionstatechange')
        async def state_changed():
            if pc.connectionState in ('failed', 'closed') and self.lines.get(room) is line:
                self.lines.pop(room, None)
                self.emit({'type': 'close', 'room': room})
                await pc.close()
        return line

    def attach(self, room, line, channel):
        line['channel'] = channel

        def opened():
            if self.lines.get(room) is line:
                self.emit({'type': 'open', 'room': room})

        @channel.on('message')
        def message(data):
            if self.lines.get(room) is line and isinstance(data, str) and len(data) <= MAX_DATA:
                self.emit({'type': 'message', 'room': room, 'data': data})

        @channel.on('close')
        def closed():
            if self.lines.get(room) is line:
                self.lines.pop(room, None)
                self.emit({'type': 'close', 'room': room})
        if channel.readyState == 'open':
            opened()
        else:
            channel.on('open', opened)

    async def _answer(self, room, sdp):
        await self.drop(room)
        line = self.connection(room)
        line['pc'].on('datachannel', lambda channel: self.attach(room, line, channel))
        await line['pc'].setRemoteDescription(self.rtc.RTCSessionDescription(sdp=sdp, type='offer'))
        await line['pc'].setLocalDescription(await line['pc'].createAnswer())
        return line['pc'].localDescription.sdp

    async def _offer(self, room):
        await self.drop(room)
        line = self.connection(room)
        self.attach(room, line, line['pc'].createDataChannel('cubby'))
        await line['pc'].setLocalDescription(await line['pc'].createOffer())
        return line['pc'].localDescription.sdp

    async def _accept(self, room, sdp):
        await self.lines[room]['pc'].setRemoteDescription(self.rtc.RTCSessionDescription(sdp=sdp, type='answer'))

    async def _send(self, room, data):
        if not self.is_open(room):
            raise ConnectionError('Not connected')
        self.lines[room]['channel'].send(data)

    def answer(self, room, sdp):
        if not self.has_rtc or sdp == 'relay-only':
            self.known(room)
            self.relay_lines[room] = True
            self.emit({'type': 'open', 'room': room})
            return 'relay-only'
        return self.run(self._answer(self.known(room), sdp))

    def offer(self, room):
        if not self.has_rtc:
            self.known(room)
            self.relay_lines[room] = True
            self.emit({'type': 'open', 'room': room})
            return 'relay-only'
        return self.run(self._offer(self.known(room)))

    def accept(self, room, sdp):
        if sdp == 'relay-only' or not self.has_rtc:
            return  # offerer already emitted open in offer()
        self.run(self._accept(self.known(room), sdp))

    def send(self, room, data):
        if not isinstance(data, str) or len(data) > MAX_DATA:
            raise ValueError('Invalid data')
        if room in self.relay_lines:
            self.signal(room, 'd:' + data)
            return
        self.run(self._send(self.known(room), data))

    def close(self, room):
        if self.relay_lines.pop(room, None):
            self.emit({'type': 'close', 'room': room})
        if ROOM.match(room or '') and self.has_rtc and self.loop is not None:
            self.run(self.drop(room))

    def known(self, room):
        if room not in self.rooms:
            raise ValueError('Unknown room')
        return room

    def request(self, action, body):
        """One page request. Raises ValueError for anything malformed."""
        if not isinstance(body, dict):
            raise ValueError('Invalid request')
        if action == 'rooms':
            return {'rooms': self.set_rooms(body.get('me'), body.get('rooms') or [], body.get('relay'))}
        room = body.get('room')
        if action == 'signal':
            self.signal(room, body.get('blob'))
            return {}
        if action == 'answer':
            return {'sdp': self.answer(room, str(body.get('sdp', '')))}
        if action == 'offer':
            return {'sdp': self.offer(room)}
        if action == 'accept':
            self.accept(room, str(body.get('sdp', '')))
            return {}
        if action == 'send':
            self.send(room, body.get('data'))
            return {}
        if action == 'close':
            self.close(room)
            return {}
        raise ValueError('Unknown action')

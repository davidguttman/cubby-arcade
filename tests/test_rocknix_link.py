"""The handheld's link pipe carries what the page tells it to, and nothing else."""
import asyncio
import http.client
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from rocknix import link
from rocknix.server import State, make_server

ROOT = Path(__file__).resolve().parents[1]
ROOM, OTHER, ME, PEER = 'a' * 32, 'b' * 32, '1' * 16, '2' * 16
RELAY = 'https://relay.test'


class Emitter:
    def __init__(self):
        self.handlers = {}

    def on(self, name, fn=None):
        if fn is None:
            return lambda handler: self.handlers.setdefault(name, handler) and handler
        self.handlers[name] = fn

    def fire(self, name, *args):
        result = self.handlers[name](*args)
        if asyncio.iscoroutine(result):
            asyncio.ensure_future(result)


class Channel(Emitter):
    def __init__(self):
        super().__init__()
        self.readyState, self.sent = 'open', []

    def send(self, data):
        self.sent.append(data)


class Connection(Emitter):
    made = []

    def __init__(self, configuration):
        super().__init__()
        self.configuration, self.connectionState, self.closed, self.remote = configuration, 'new', False, None
        self.localDescription = None
        Connection.made.append(self)

    async def setRemoteDescription(self, description):
        self.remote = description

    async def createAnswer(self):
        return FakeRtc.RTCSessionDescription(sdp='answer-sdp', type='answer')

    async def createOffer(self):
        return FakeRtc.RTCSessionDescription(sdp='offer-sdp', type='offer')

    async def setLocalDescription(self, description):
        self.localDescription = description

    def createDataChannel(self, label):
        self.channel = Channel()
        return self.channel

    async def close(self):
        self.closed = True


class FakeRtc:
    RTCPeerConnection = Connection

    class RTCConfiguration:
        def __init__(self, iceServers):
            self.iceServers = iceServers

    class RTCSessionDescription:
        def __init__(self, sdp, type):
            self.sdp, self.type = sdp, type


class Relay:
    """Stands in for urlopen: one poll reply per room, then waits to be released."""
    def __init__(self):
        self.polls, self.posts, self.replies, self.hold = [], [], {}, threading.Event()

    def __call__(self, request, timeout=None):
        if isinstance(request, str):
            self.polls.append(request)
            room = request.split('/rooms/')[1].split('/')[0]
            if self.replies.get(room):
                return io.BytesIO(json.dumps(self.replies[room].pop(0)).encode())
            self.hold.wait(5)
            raise OSError('relay closed')
        self.posts.append((request.full_url, json.loads(request.data)))
        return io.BytesIO(b'{}')


class LinkTests(unittest.TestCase):
    def setUp(self):
        Connection.made = []
        self.relay = Relay()
        self.addCleanup(self.relay.hold.set)
        self.link = link.Link(opener=self.relay, rtc=lambda: FakeRtc, installed=lambda: True, wait=lambda seconds: time.sleep(0.01))

    def events(self, after=0, timeout=1):
        return [{k: v for k, v in event.items() if k != 'seq'} for event in self.link.read(self.link.boot, after, timeout)['events']]

    def on_loop(self, fn):
        async def call():
            fn()
        self.link.run(call())

    def test_the_relay_is_polled_for_each_room_and_what_arrives_reaches_the_page(self):
        self.relay.replies[ROOM] = [{'seq': 4, 'peers': [PEER], 'messages': [{'seq': 4, 'from': PEER, 'blob': 'sealed'}]}]
        self.assertEqual(list(self.link.set_rooms(ME, [ROOM], RELAY)), [ROOM])
        self.assertEqual(self.events(), [{'type': 'presence', 'room': ROOM, 'peers': [PEER]}, {'type': 'signal', 'room': ROOM, 'blob': 'sealed'}])
        self.assertEqual(self.relay.polls[0], f'{RELAY}/v1/rooms/{ROOM}/messages?me={ME}&after=0&wait=25')
        for _ in range(100):
            if len(self.relay.polls) > 1:
                break
            time.sleep(0.01)
        self.assertEqual(self.relay.polls[1], f'{RELAY}/v1/rooms/{ROOM}/messages?me={ME}&after=4&wait=25&peers={PEER}')
        # A later page asking again is told who is already here.
        self.assertEqual(self.link.set_rooms(ME, [ROOM], RELAY), {ROOM: {'peers': [PEER], 'open': False}})
        self.link.signal(ROOM, 'reply')
        self.assertEqual(self.relay.posts, [(f'{RELAY}/v1/rooms/{ROOM}/messages', {'from': ME, 'blob': 'reply'})])

    def test_an_offer_is_answered_and_the_channel_carries_text_both_ways(self):
        self.link.set_rooms(ME, [ROOM], RELAY)
        self.assertEqual(self.link.request('answer', {'room': ROOM, 'sdp': 'offer-sdp'}), {'sdp': 'answer-sdp'})
        pc = Connection.made[0]
        self.assertEqual((pc.configuration.iceServers, pc.remote.sdp, pc.remote.type), ([], 'offer-sdp', 'offer'))
        channel = Channel()
        self.on_loop(lambda: pc.fire('datachannel', channel))
        self.on_loop(lambda: channel.fire('message', 'hello'))
        self.on_loop(lambda: channel.fire('message', b'bytes are not carried'))
        self.assertEqual(self.events(), [{'type': 'open', 'room': ROOM}, {'type': 'message', 'room': ROOM, 'data': 'hello'}])
        self.assertEqual(self.link.set_rooms(ME, [ROOM], RELAY)[ROOM]['open'], True)
        self.link.request('send', {'room': ROOM, 'data': 'back'})
        self.assertEqual(channel.sent, ['back'])
        # A new offer replaces the old connection without reporting it as a drop.
        seen = self.link.seq
        self.link.request('answer', {'room': ROOM, 'sdp': 'offer-2'})
        self.assertTrue(pc.closed)
        self.on_loop(lambda: channel.fire('close'))
        self.assertEqual(self.events(seen, 0.1), [])

    def test_a_dropped_connection_is_reported_once_and_sending_then_fails(self):
        self.link.set_rooms(ME, [ROOM], RELAY)
        self.link.request('answer', {'room': ROOM, 'sdp': 'offer-sdp'})
        pc, channel = Connection.made[0], Channel()
        self.on_loop(lambda: pc.fire('datachannel', channel))
        pc.connectionState = 'failed'
        self.on_loop(lambda: pc.fire('connectionstatechange'))
        self.on_loop(lambda: channel.fire('close'))
        self.assertEqual(self.events()[1:], [{'type': 'close', 'room': ROOM}])
        with self.assertRaises(ConnectionError):
            self.link.request('send', {'room': ROOM, 'data': 'late'})

    def test_removing_a_room_stops_its_poll_and_closes_its_connection(self):
        self.link.set_rooms(ME, [ROOM, OTHER], RELAY)
        self.link.request('answer', {'room': ROOM, 'sdp': 'offer-sdp'})
        self.assertEqual(sorted(self.link.set_rooms(ME, [OTHER], RELAY)), [OTHER])
        self.assertTrue(Connection.made[0].closed)
        with self.assertRaises(ValueError):
            self.link.request('send', {'room': ROOM, 'data': 'x'})

    def test_a_cursor_from_an_earlier_run_starts_over_and_bad_requests_are_refused(self):
        self.link.emit({'type': 'open', 'room': ROOM})
        self.assertEqual(len(self.link.read('another-boot', 99, 0)['events']), 1)
        self.assertEqual(self.link.read(self.link.boot, 1, 0), {'boot': self.link.boot, 'seq': 1, 'events': []})
        for action, body in [('rooms', {'me': 'me', 'rooms': [], 'relay': RELAY}), ('rooms', {'me': ME, 'rooms': ['short'], 'relay': RELAY}),
                             ('rooms', {'me': ME, 'rooms': [ROOM], 'relay': 'http://192.168.1.4:8790'}), ('rooms', {'me': ME, 'rooms': [ROOM] * 17, 'relay': RELAY}),
                             ('signal', {'room': ROOM, 'blob': 'x'}), ('send', {'room': ROOM, 'data': 'x'}), ('launch', {}), ('send', [])]:
            with self.assertRaises(ValueError, msg=(action, body)):
                self.link.request(action, body)
        self.link.set_rooms(ME, [ROOM], RELAY)
        with self.assertRaises(ValueError):
            self.link.request('send', {'room': ROOM, 'data': 'x' * (link.MAX_DATA + 1)})

    def test_a_runtime_without_webrtc_says_so_and_never_loads_it(self):
        loaded = []
        bare = link.Link(opener=self.relay, rtc=lambda: loaded.append(1), installed=lambda: False)
        self.assertFalse(bare.available)
        bare.set_rooms(ME, [ROOM], RELAY)
        with self.assertRaises(RuntimeError):
            bare.request('answer', {'room': ROOM, 'sdp': 'offer'})
        self.assertEqual(loaded, [])
        self.assertEqual(self.link.rtc, None, 'loaded only when a connection is first needed')


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = State(ROOT, Path(self.tmp.name))
        self.relay = Relay()
        self.addCleanup(self.relay.hold.set)
        self.state.link = link.Link(opener=self.relay, rtc=lambda: FakeRtc, installed=lambda: True, wait=lambda seconds: time.sleep(0.01))
        logger = patch('rocknix.server.Handler.log_message')
        logger.start()
        self.addCleanup(logger.stop)
        self.httpd = make_server(self.state, port=0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.thread.join)
        self.addCleanup(self.httpd.shutdown)
        self.origin = 'http://127.0.0.1:' + str(self.httpd.server_address[1])

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=5)
        defaults = {'Origin': self.origin, 'Content-Type': 'application/json'}
        defaults.update(headers or {})
        connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=defaults)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        try:
            return response.status, json.loads(data)
        except ValueError:
            return response.status, data

    def test_the_page_can_reach_the_pipe_and_other_origins_cannot(self):
        self.assertEqual(self.request('GET', '/api/link'), (200, {'available': True}))
        rooms = {'me': ME, 'rooms': [ROOM], 'relay': RELAY}
        self.assertEqual(self.request('POST', '/api/link/rooms', rooms), (200, {'rooms': {ROOM: {'peers': [], 'open': False}}}))  # the fake relay never answers this poll
        self.assertEqual(self.request('POST', '/api/link/answer', {'room': ROOM, 'sdp': 'offer-sdp'}), (200, {'sdp': 'answer-sdp'}))
        self.assertEqual(self.request('POST', '/api/link/rooms', rooms, {'Origin': 'https://elsewhere.test'})[0], 403)
        self.assertEqual(self.request('POST', '/api/link/rooms', rooms, {'Content-Type': 'text/plain'})[0], 403)
        self.assertEqual(self.request('POST', '/api/link/rooms', {'me': 'bad'}), (400, {'error': 'invalid request'}))
        self.assertEqual(self.request('POST', '/api/link/send', {'room': ROOM, 'data': 'x'}), (503, {'error': 'unavailable'}))
        self.state.link.emit({'type': 'open', 'room': ROOM})
        status, body = self.request('GET', '/api/link/events?boot=' + self.state.link.boot + '&after=0')
        self.assertEqual((status, [event['type'] for event in body['events']]), (200, ['open']))

    def test_the_hub_and_game_pages_load_the_link_and_the_settings_list_offers_phones(self):
        page = self.request('GET', '/')[1]
        self.assertLess(page.index(b'/runtime/core/link.js'), page.index(b'/runtime/core/hub.js'))
        self.assertLess(page.index(b'/runtime/core/qr.js'), page.index(b'/runtime/core/hub.js'))
        for name in ('link.js', 'qr.js'):
            self.assertEqual(self.request('GET', '/runtime/core/' + name), (200, (ROOT / 'runtime/core' / name).read_bytes()))
        self.assertIn(b"href: '#adult-link'", self.request('GET', '/rocknix/bridge.js')[1])


if __name__ == '__main__':
    unittest.main()

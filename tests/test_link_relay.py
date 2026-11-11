import threading
import unittest

from hosting import link_relay

ROOM, A, B = 'a' * 32, '1' * 16, '2' * 16


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class RelayTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.rooms = link_relay.Rooms(self.clock)

    def test_a_newcomer_hears_at_once_who_is_here_and_messages_skip_their_sender(self):
        self.assertEqual(self.rooms.poll(ROOM, A, 0, 0), {'seq': 0, 'messages': [], 'peers': []})
        # B has never polled: it is told about A without waiting for anything to change.
        self.assertEqual(self.rooms.poll(ROOM, B, 0, 25), {'seq': 0, 'messages': [], 'peers': [A]})
        self.assertEqual(self.rooms.send(ROOM, A, 'blob'), 1)
        self.assertEqual(self.rooms.poll(ROOM, A, 0, 0, [B])['messages'], [])
        self.assertEqual(self.rooms.poll(ROOM, B, 0, 0, [A]), {'seq': 1, 'messages': [{'seq': 1, 'from': A, 'blob': 'blob'}], 'peers': [A]})
        self.assertEqual(self.rooms.poll(ROOM, B, 1, 0, [A])['messages'], [])

    def test_a_waiting_member_is_woken_by_an_arrival_and_by_a_message(self):
        self.rooms = link_relay.Rooms()
        results = []
        waiter = threading.Thread(target=lambda: results.append(self.rooms.poll(ROOM, A, 0, 10, [])))
        waiter.start()
        while ROOM not in self.rooms.rooms:
            pass
        self.rooms.poll(ROOM, B, 0, 0)
        waiter.join(5)
        self.assertEqual(results, [{'seq': 0, 'messages': [], 'peers': [B]}])
        waiter = threading.Thread(target=lambda: results.append(self.rooms.poll(ROOM, A, 0, 10, [B])))
        waiter.start()
        self.rooms.send(ROOM, B, 'hello')
        waiter.join(5)
        self.assertEqual(results[1]['messages'], [{'seq': 1, 'from': B, 'blob': 'hello'}])

    def test_messages_and_presence_expire_and_a_stale_cursor_starts_over(self):
        self.rooms.poll(ROOM, A, 0, 0)
        self.rooms.send(ROOM, A, 'old')
        self.clock.now = link_relay.PRESENT_SECONDS + 1
        self.assertEqual(self.rooms.poll(ROOM, B, 0, 0)['peers'], [])
        self.clock.now = link_relay.MESSAGE_SECONDS + 1
        self.assertEqual(self.rooms.poll(ROOM, B, 0, 0)['messages'], [])
        self.rooms.send(ROOM, A, 'new')
        self.assertEqual([m['blob'] for m in self.rooms.poll(ROOM, B, 99, 0)['messages']], ['new'])

    def test_the_server_refuses_bad_rooms_members_and_oversize_blobs(self):
        import json
        import urllib.error
        import urllib.request
        server = link_relay.make_server(port=0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = 'http://127.0.0.1:%d' % server.server_address[1]
        self.addCleanup(server.shutdown)

        def post(path, body):
            request = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(request, timeout=5) as reply:
                    return reply.status, json.loads(reply.read()), reply.headers.get('Access-Control-Allow-Origin')
            except urllib.error.HTTPError as error:
                return error.code, None, None
        self.assertEqual(post(f'/v1/rooms/{ROOM}/messages', {'from': A, 'blob': 'x'}), (200, {'seq': 1}, '*'))
        self.assertEqual(post('/v1/rooms/short/messages', {'from': A, 'blob': 'x'})[0], 404)
        self.assertEqual(post(f'/v1/rooms/{ROOM}/messages', {'from': 'me', 'blob': 'x'})[0], 400)
        self.assertEqual(post(f'/v1/rooms/{ROOM}/messages', {'from': A, 'blob': 'x' * (link_relay.MAX_BLOB + 1)})[0], 400)
        with urllib.request.urlopen(f'{base}/v1/rooms/{ROOM}/messages?me={B}&after=0&wait=0', timeout=5) as reply:
            self.assertEqual(json.loads(reply.read()), {'seq': 1, 'messages': [{'seq': 1, 'from': A, 'blob': 'x'}], 'peers': []})


if __name__ == '__main__':
    unittest.main()

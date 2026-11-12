'use strict';
// The link's rules, run through the shared code with an in-memory relay and wire.
const test = require('node:test'), assert = require('node:assert/strict');
const Link = require('../runtime/core/link.js');

function memoryStorage() { const map = new Map(); return {getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); }, map}; }
// A relay and data channels that behave like the real ones, minus the network.
function world() {
  const rooms = new Map(), ends = new Set();
  const members = room => [...ends].filter(end => end.online && end.rooms.includes(room));
  function presence(room) { for (const end of members(room)) end.emit({type: 'presence', room, peers: members(room).filter(other => other !== end).map(other => other.id)}); }
  function transport() {
    const end = {id: '', rooms: [], online: true, listener: () => {}, lines: new Map(), sent: [],
      emit(event) { return Promise.resolve().then(() => end.listener(event)); }};
    ends.add(end);
    const api = {
      end,
      on(fn) { end.listener = fn; },
      async setRooms(id, list) { end.id = id; const all = new Set([...end.rooms, ...list]); end.rooms = list; for (const room of all) presence(room); },
      async signal(room, blob) { end.sent.push(blob); for (const other of members(room)) if (other !== end) other.emit({type: 'signal', room, blob: api.tamper ? blob.slice(0, -4) + 'AAAA' : blob}); },
      async offer(room) { end.lines.delete(room); rooms.set(room, {offerer: end}); return 'offer-from-' + end.id; },
      async answer(room, sdp) { const line = rooms.get(room); assert.equal(sdp, 'offer-from-' + line.offerer.id); line.answerer = end; return 'answer-from-' + end.id; },
      async accept(room, sdp) {
        const line = rooms.get(room); assert.equal(sdp, 'answer-from-' + line.answerer.id);
        line.offerer.lines.set(room, line.answerer); line.answerer.lines.set(room, line.offerer);
        line.offerer.emit({type: 'open', room}); line.answerer.emit({type: 'open', room});
      },
      async send(room, data) { const other = end.lines.get(room); if (!other || !end.online || !other.online) throw Error('Not connected'); if (!api.dropData) other.emit({type: 'message', room, data}); },
      async close(room) { const other = end.lines.get(room); end.lines.delete(room); if (other) { other.lines.delete(room); other.emit({type: 'close', room}); } },
      async dispose() { api.offline(); },
      offline() { end.online = false; for (const [room, other] of end.lines) { other.lines.delete(room); other.emit({type: 'close', room}); end.listener({type: 'close', room}); } end.lines.clear(); for (const room of end.rooms) presence(room); },
      online() { end.online = true; for (const room of end.rooms) presence(room); }
    };
    return api;
  }
  return {transport};
}
// Key derivation runs off-thread, so give real time, not just turns of the loop.
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(done => setTimeout(done, 20)); };
function device(net, role, extra = {}) {
  const storage = extra.storage || memoryStorage(), transport = net.transport();
  const link = Link.createLink({role, storage, transport, describe: () => role === 'cubby' ? {name: 'Cubby', players: [{id: 'p_first', name: 'Lex', avatar: 'cat'}]} : {name: 'Phone'}, player: extra.player, setTimeout: extra.setTimeout || (() => {})});
  return {link, storage, transport};
}
async function pair(net, cubbyExtra, parentExtra) {
  const cubby = device(net, 'cubby', cubbyExtra), parent = device(net, 'parent', parentExtra);
  await cubby.link.start(); await parent.link.start();
  const code = await cubby.link.beginPairing();
  const room = await parent.link.acceptPairing(code);
  await settle();
  return {cubby, parent, code, room};
}

test('a scanned code pairs the two and each learns who the other is', async () => {
  const {cubby, parent, room} = await pair(world());
  assert.deepEqual(cubby.link.pairings().map(p => [p.id, p.role, p.name, p.confirmed, p.connected]), [[room, 'parent', 'Phone', true, true]]);
  const seen = parent.link.pairings()[0];
  assert.deepEqual([seen.role, seen.name, seen.confirmed, seen.connected], ['cubby', 'Cubby', true, true]);
  assert.deepEqual(seen.players, [{id: 'p_first', name: 'Lex', avatar: 'cat'}]);
});

test('the relay never sees the code, the room is not the code, and a changed blob is ignored', async () => {
  const net = world(), cubby = device(net, 'cubby'), parent = device(net, 'parent');
  await cubby.link.start(); await parent.link.start();
  const code = await cubby.link.beginPairing();
  parent.transport.tamper = true;
  const room = await parent.link.acceptPairing(code); await settle();
  assert.ok(!room.includes(code) && /^[0-9a-f]{32}$/.test(room));
  assert.ok(parent.transport.end.sent.length > 0 && parent.transport.end.sent.every(blob => !blob.includes(code) && !blob.includes('offer-from')));
  assert.equal(cubby.link.pairings()[0].connected, false);
  assert.equal(cubby.link.pairings()[0].confirmed, false);
});

test('a message waits for its game to open, arrives once, and then stops being held', async () => {
  const {cubby, parent, room} = await pair(world());
  const phone = parent.link.channel('good-bribes-only');
  phone.send({wheel: 7}, {to: room}); await settle();
  assert.equal(phone.waiting(), 0, 'stored on the Cubby, so the phone lets go of it');
  const got = [];
  cubby.link.channel('good-bribes-only').onMessage(message => got.push(message)); await settle();
  assert.deepEqual(got.map(m => [m.body, m.from.name, m.from.role]), [[{wheel: 7}, 'Phone', 'parent']]);
  const again = []; cubby.link.channel('good-bribes-only').onMessage(message => again.push(message)); await settle();
  assert.deepEqual(again, [], 'delivered once');
  const other = []; cubby.link.channel('another-game').onMessage(message => other.push(message)); await settle();
  assert.deepEqual(other, [], 'another game never sees it');
});

test('a message sent while the other side is away is held and delivered when it returns', async () => {
  const timers = [], {cubby, parent} = await pair(world(), {}, {setTimeout: fn => timers.push(fn)});
  parent.transport.offline(); await settle();
  assert.equal(cubby.link.pairings()[0].connected, false);
  const game = cubby.link.channel('good-bribes-only');
  game.send({won: 'picnic'}); game.send({won: 'coin'});
  assert.equal(game.waiting(), 2);
  const got = []; parent.link.channel('good-bribes-only').onMessage(message => got.push(message.body));
  parent.transport.online(); await settle(); for (const fn of timers.splice(0)) fn(); await settle();
  assert.deepEqual(got, [{won: 'picnic'}, {won: 'coin'}]);
  assert.equal(game.waiting(), 0);
});

test('a lost acknowledgement resends without delivering twice', async () => {
  const timers = [], {cubby, parent, room} = await pair(world(), {}, {setTimeout: fn => timers.push(fn)});
  const got = []; cubby.link.channel('good-bribes-only').onMessage(message => got.push(message.body));
  cubby.transport.dropData = true;                       // the Cubby stores it but its acknowledgement is lost
  const phone = parent.link.channel('good-bribes-only'); phone.send({n: 1}, {to: room}); await settle();
  assert.deepEqual(got, [{n: 1}]); assert.equal(phone.waiting(), 1);
  cubby.transport.dropData = false;
  parent.transport.offline(); await settle(); parent.transport.online(); await settle(); for (const fn of timers.splice(0)) fn(); await settle();
  assert.deepEqual(got, [{n: 1}]); assert.equal(phone.waiting(), 0);
});

test('a message for one player waits for that player', async () => {
  let playing = 'p_first';
  const {cubby, parent, room} = await pair(world(), {player: () => playing});
  const got = []; cubby.link.channel('good-bribes-only').onMessage(message => got.push([message.player, message.body]));
  const phone = parent.link.channel('good-bribes-only');
  phone.send('for sam', {to: room, player: 'p_sam'}); phone.send('for everyone', {to: room}); await settle();
  assert.deepEqual(got, [[null, 'for everyone']]);
  playing = 'p_sam'; cubby.link.channel('good-bribes-only').onMessage(message => got.push([message.player, message.body])); await settle();
  assert.deepEqual(got.slice(1).every(entry => entry[0] === 'p_sam' && entry[1] === 'for sam') && got.length > 1, true);
  cubby.link.channel('good-bribes-only').send('hi');
  assert.equal(JSON.parse(cubby.storage.getItem('cubby:link:outbox:v1')).at(-1).player, 'p_sam', 'a game speaks as the player playing it');
});

test('both sides work out the same game secret with no connection, different per label and game', async () => {
  const {cubby, parent, room} = await pair(world());
  parent.transport.offline(); await settle();
  const a = await cubby.link.channel('good-bribes-only').key(room, 'coin:p_first'), b = await parent.link.channel('good-bribes-only').key(room, 'coin:p_first');
  assert.equal(a, b); assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.notEqual(a, await cubby.link.channel('good-bribes-only').key(room, 'coin:p_sam'));
  assert.notEqual(a, await cubby.link.channel('another-game').key(room, 'coin:p_first'));
});

test('pairing survives a new page, an unscanned code expires, and removing a phone forgets it', async () => {
  const net = world(), {cubby, parent, room} = await pair(net);
  const next = device(net, 'cubby', {storage: cubby.storage}); cubby.transport.offline();
  await next.link.start(); await settle();
  assert.deepEqual(next.link.pairings().map(p => [p.id, p.name, p.confirmed]), [[room, 'Phone', true]]);
  const first = await next.link.beginPairing(); await next.link.beginPairing();
  assert.equal(next.link.pairings().length, 2, 'only one unscanned code at a time');
  const late = device(net, 'parent'); await late.link.start(); await late.link.acceptPairing(first); await settle();
  assert.equal(late.link.pairings()[0].connected, false, 'the replaced code no longer works');
  next.link.channel('good-bribes-only').send('held');
  await next.link.removePairing(room);
  assert.deepEqual(next.link.pairings().filter(p => p.confirmed), []);
  assert.equal(JSON.parse(next.storage.getItem('cubby:link:outbox:v1')).length, 0);
  await settle();   // the phone opens what was already in flight before it hears the line close
  assert.equal(parent.link.pairings()[0].connected, false);
});

test('what crosses the line is sealed, and a message not sealed with the pairing secret is ignored', async () => {
  const net = world(), {cubby, parent, room} = await pair(net);
  const seen = [], got = [];
  const send = parent.transport.send; parent.transport.send = (r, data) => { seen.push(data); return send(r, data); };
  cubby.link.channel('good-bribes-only').onMessage(message => got.push(message.body));
  parent.link.channel('good-bribes-only').send({word: 'tiger'}, {to: room}); await settle();
  assert.deepEqual(got, [{word: 'tiger'}]);
  assert.ok(seen.length > 0 && seen.every(data => !data.includes('tiger') && !data.includes('msg')));
  // Whoever carries the bytes (the relay, when there is no data channel) cannot forge one.
  await cubby.transport.end.listener({type: 'message', room, data: JSON.stringify({t: 'msg', id: 'forged', game: 'good-bribes-only', body: 'forged'})});
  await settle();
  assert.deepEqual(got, [{word: 'tiger'}]);
});

test('a paired device can be renamed on this side only, and keeps the name when it says hello again', async () => {
  const net = world(), {cubby, parent, room} = await pair(net);
  await parent.link.renamePairing(room, '  Living room Cubby  ');
  assert.deepEqual([parent.link.pairings()[0].name, parent.link.pairings()[0].ownName], ['Living room Cubby', 'Cubby']);
  assert.equal(cubby.link.pairings()[0].name, 'Phone', 'the other side is untouched');
  parent.transport.offline(); parent.transport.online(); await settle();
  const next = device(net, 'parent', {storage: parent.storage}); await next.link.start(); await settle();
  assert.equal(next.link.pairings()[0].name, 'Living room Cubby', 'kept across pages and after a fresh hello');
  await next.link.renamePairing(room, ''); assert.equal(next.link.pairings()[0].name, 'Cubby');
  await assert.rejects(next.link.renamePairing('nope', 'x'), /Unknown/);
});

test('two pages on one phone never write back each other\'s stale copy', async () => {
  const net = world(), {parent, room} = await pair(net);
  const other = device(net, 'parent', {storage: parent.storage}); await other.link.start(); await settle();
  await other.link.renamePairing(room, 'Car Cubby');
  // The first page then saves something of its own (a hello arriving, say).
  parent.transport.offline(); parent.transport.online(); await settle();
  await parent.link.channel('good-bribes-only').key(room, 'x');
  assert.equal(parent.link.pairings()[0].name, 'Car Cubby');
  assert.equal(JSON.parse(parent.storage.getItem('cubby:parent-link:v1')).pairings[0].label, 'Car Cubby');
  const seen = []; parent.link.onChange(() => seen.push(1)); await other.link.renamePairing(room, 'Kitchen'); await parent.link.refresh();
  assert.ok(seen.length > 0, 'a page hears about a change made by another'); assert.equal(parent.link.pairings()[0].name, 'Kitchen');
});

test('a game asks its channel who is playing', async () => {
  let who = 'p_dad';
  const net = world(), cubby = device(net, 'cubby', {player: () => who});
  await cubby.link.start();
  assert.equal(cubby.link.channel('good-bribes-only').player(), 'p_dad');
  who = 'p_lex'; assert.equal(cubby.link.channel('good-bribes-only').player(), 'p_lex');
});

test('a phone must say which Cubby, and oversize or bad input is refused', async () => {
  const {cubby, parent} = await pair(world());
  assert.throws(() => parent.link.channel('good-bribes-only').send('x'), /which Cubby/);
  assert.throws(() => cubby.link.channel('good-bribes-only').send('x'.repeat(Link.MAX_MESSAGE)), /under/);
  assert.throws(() => cubby.link.channel('Bad Id'), /Invalid game id/);
  await assert.rejects(parent.link.acceptPairing('nope'), /Invalid pairing code/);
});

test('the handheld transport reports where things stand without waiting on the caller', async () => {
  // The server keeps connections across pages; a page asking for its rooms is told what is already open.
  const calls = [], storage = memoryStorage();
  const fetch = async (url, init) => {
    calls.push(url);
    if (url === '/api/link/rooms') return {ok: true, json: async () => ({rooms: {['a'.repeat(32)]: {peers: ['b'.repeat(16)], open: true}}})};
    if (url.startsWith('/api/link/events')) return new Promise(() => {});
    return {ok: true, json: async () => ({})};
  };
  const transport = Link.createHostTransport({fetch, storage, relay: 'https://relay.test', setTimeout: () => {}});
  const seen = []; let release; const blocked = new Promise(done => { release = done; });
  transport.on(event => { seen.push(event.type); return blocked; });   // a listener that is still busy
  await transport.setRooms('c'.repeat(16), ['a'.repeat(32)]);          // must return anyway
  assert.deepEqual(seen, ['presence', 'open']); release();
  const link = Link.createLink({role: 'cubby', storage: memoryStorage(), transport: Link.createHostTransport({fetch, storage: memoryStorage(), relay: 'https://relay.test', setTimeout: () => {}}), setTimeout: () => {}});
  await link.start();
  assert.match(await Promise.race([link.beginPairing(), new Promise(done => setTimeout(() => done('stalled'), 500))]), /^[A-Za-z0-9_-]{22}$/);
});

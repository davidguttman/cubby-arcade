/* Cubby Link: a direct line between this Cubby and the devices paired with it.
 *
 * A grown-up pairs their phone once, by scanning a code from the gear tab. After
 * that a game and its page on the phone can pass messages. Messages are held on
 * the sender until the other side has stored them, so the two never need to be
 * open at the same moment for something to arrive.
 *
 * Everything that decides what happens lives here, for every host: who is paired
 * and as what, the encrypted introduction, held messages, and the game-facing
 * channel. A host supplies only a transport: something that can reach the
 * introduction relay and carry bytes over a data channel. Browsers do that in the
 * page. The handheld's browser cannot, so its server does it and this file talks
 * to it over /api/link (see rocknix/link.py). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.CubbyLinkAPI = api; root.CubbyLink = api.install(root); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STATE_KEY = 'cubby:link:v1', OUTBOX_KEY = 'cubby:link:outbox:v1', INBOX_KEY = 'cubby:link:inbox:v1:', SEEN_KEY = 'cubby:link:seen:v1', CURSOR_KEY = 'cubby:link:cursor:v1';
  // Set when the relay has a permanent address. Hosts and tests pass their own.
  const DEFAULT_RELAY = '';
  // Where a phone lands after scanning: the grown-ups' pages, which load this same file.
  const DEFAULT_COMPANION = '';
  const MAX_MESSAGE = 180000, MAX_HELD = 200, SEEN_IDS = 300;
  const PENDING_PAIRING_MS = 10 * 60 * 1000, NEGOTIATION_MS = 15000;
  const GAME_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
  const encoder = new TextEncoder(), decoder = new TextDecoder();

  function toBase64Url(bytes) { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function fromBase64Url(text) { const raw = atob(String(text).replace(/-/g, '+').replace(/_/g, '/')); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); return bytes; }
  function hex(bytes) { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }

  // Both sides hold one 16-byte secret from pairing. The relay only ever sees a
  // hash of it (the room) and blobs sealed with a key derived from it.
  function createCrypto(webcrypto) {
    const subtle = webcrypto.subtle;
    const random = length => webcrypto.getRandomValues(new Uint8Array(length));
    async function derive(secret, label, length) {
      const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
      return new Uint8Array(await subtle.deriveBits({name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(label)}, base, length * 8));
    }
    const sealKeys = new Map();
    async function sealKey(code) {
      if (!sealKeys.has(code)) sealKeys.set(code, subtle.importKey('raw', await derive(fromBase64Url(code), 'cubby-link signal v1', 32), 'AES-GCM', false, ['encrypt', 'decrypt']));
      return sealKeys.get(code);
    }
    return {
      random,
      newCode: () => toBase64Url(random(16)),
      newId: () => hex(random(8)),
      room: async code => hex(await derive(fromBase64Url(code), 'cubby-link room v1', 16)),
      appKey: async (code, label) => toBase64Url(await derive(fromBase64Url(code), 'cubby-link app v1:' + label, 32)),
      async seal(code, value) {
        const iv = random(12), sealed = new Uint8Array(await subtle.encrypt({name: 'AES-GCM', iv}, await sealKey(code), encoder.encode(JSON.stringify(value))));
        const out = new Uint8Array(12 + sealed.length); out.set(iv); out.set(sealed, 12); return toBase64Url(out);
      },
      async open(code, blob) {
        const bytes = fromBase64Url(blob);
        return JSON.parse(decoder.decode(await subtle.decrypt({name: 'AES-GCM', iv: bytes.slice(0, 12)}, await sealKey(code), bytes.slice(12))));
      }
    };
  }

  function validCode(code) { try { return typeof code === 'string' && fromBase64Url(code).length === 16; } catch (_) { return false; } }

  /* The link itself. `role` is what this device is: 'cubby' or 'parent'. */
  function createLink(options) {
    const role = options.role === 'parent' ? 'parent' : 'cubby';
    const storage = options.storage, transport = options.transport, crypto = createCrypto(options.crypto || globalThis.crypto);
    const now = options.now || (() => Date.now()), later = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const describe = options.describe || (() => ({})), currentPlayer = options.player || (() => null);
    const listeners = new Set(), handlers = new Map(), live = new Map();
    let state = null, started = false, stopped = false, work = Promise.resolve(), counter = 0;

    function read(key, fallback) { try { const value = storage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch (_) { return fallback; } }
    function write(key, value) { storage.setItem(key, JSON.stringify(value)); }
    function load() {
      if (state) return state;
      const saved = read(STATE_KEY, null);
      state = saved && typeof saved.id === 'string' && Array.isArray(saved.pairings) ? saved : {id: crypto.newId(), pairings: []};
      if (!saved) write(STATE_KEY, state);
      return state;
    }
    function save() { write(STATE_KEY, state); changed(); }
    function changed() { for (const fn of [...listeners]) { try { fn(); } catch (_) {} } }
    function pairing(room) { return load().pairings.find(item => item.room === room); }
    function status(room) { let value = live.get(room); if (!value) live.set(room, value = {open: false, present: false, offering: 0, tries: 0}); return value; }
    function publicPairing(item) { return {id: item.room, role: item.role, name: item.name || null, confirmed: !!item.confirmed, connected: !!live.get(item.room)?.open, players: item.players || [], since: item.created}; }
    // One thing at a time: events from the transport and calls from the page share state.
    function queue(job) { const run = work.then(job, job); work = run.catch(() => {}); return run; }

    function expirePending() {
      const before = state.pairings.length;
      state.pairings = state.pairings.filter(item => item.confirmed || now() - item.created < PENDING_PAIRING_MS);
      return state.pairings.length !== before;
    }
    function rooms() { return transport.setRooms(state.id, state.pairings.map(item => item.room)); }

    function held() { return read(OUTBOX_KEY, []); }
    function inbox(game) { return read(INBOX_KEY + game, []); }
    function remember(id) {
      const seen = read(SEEN_KEY, []);
      if (seen.includes(id)) return false;
      write(SEEN_KEY, [...seen, id].slice(-SEEN_IDS)); return true;
    }
    function wire(room, value) { return transport.send(room, JSON.stringify(value)); }
    async function flush(room) {
      if (!status(room).open) return;
      for (const item of held()) if (item.to === room) await wire(room, {t: 'msg', id: item.id, game: item.game, player: item.player, body: item.body}).catch(() => {});
    }
    function deliver(game) {
      const fns = handlers.get(game);
      if (!fns || !fns.size) return;
      const player = currentPlayer(), waiting = inbox(game), keep = [];
      for (const item of waiting) {
        // A message for one player waits until that player is the one playing.
        if (item.player && player && item.player !== player) { keep.push(item); continue; }
        const from = pairing(item.from), message = {id: item.id, from: from ? publicPairing(from) : {id: item.from}, player: item.player || null, body: item.body};
        for (const fn of [...fns]) { try { fn(message); } catch (_) {} }
      }
      if (keep.length !== waiting.length) write(INBOX_KEY + game, keep);
    }

    async function negotiate(room) {
      const item = pairing(room), line = status(room);
      if (!item || line.open || line.offering || stopped) return;
      const n = line.offering = ++counter;
      try {
        const sdp = await transport.offer(room);
        await transport.signal(room, await crypto.seal(item.code, {t: 'offer', n, sdp}));
      } catch (_) { line.offering = 0; return; }
      later(() => queue(() => {
        if (line.offering !== n || line.open) return;
        line.offering = 0; line.tries++;
        transport.close(room).catch(() => {});
        if (line.present) later(() => queue(() => negotiate(room)), Math.min(30000, 2000 * line.tries));
      }), NEGOTIATION_MS);
    }

    async function onSignal(room, blob) {
      const item = pairing(room); if (!item) return;
      let message; try { message = await crypto.open(item.code, blob); } catch (_) { return; }
      const line = status(room);
      if (message.t === 'offer' && role === 'cubby' && typeof message.sdp === 'string') {
        line.open = false;
        const sdp = await transport.answer(room, message.sdp);
        await transport.signal(room, await crypto.seal(item.code, {t: 'answer', n: message.n, sdp}));
      } else if (message.t === 'answer' && line.offering && message.n === line.offering && typeof message.sdp === 'string') {
        await transport.accept(room, message.sdp);
      }
    }
    async function onMessage(room, data) {
      const item = pairing(room); if (!item) return;
      let message; try { message = JSON.parse(data); } catch (_) { return; }
      if (message.t === 'hello') {
        // Arrives over the data channel, which only the holder of the pairing secret could open.
        if (message.role !== item.role) return;
        Object.assign(item, {peer: String(message.id || ''), name: String(message.name || '').slice(0, 40) || item.name, confirmed: true,
          players: Array.isArray(message.players) ? message.players.slice(0, 16).map(p => ({id: String(p.id), name: String(p.name || '').slice(0, 20), avatar: String(p.avatar || '')})) : item.players});
        save();
      } else if (message.t === 'msg' && GAME_ID.test(message.game) && typeof message.id === 'string') {
        if (remember(message.id)) {
          const waiting = inbox(message.game);
          if (waiting.length >= MAX_HELD) return;   // unacknowledged: the sender keeps it and tries again later
          write(INBOX_KEY + message.game, [...waiting, {id: message.id, from: room, player: message.player || null, body: message.body, at: now()}]);
        }
        await wire(room, {t: 'ack', id: message.id}).catch(() => {});
        deliver(message.game);
      } else if (message.t === 'ack') {
        const before = held(), after = before.filter(entry => !(entry.id === message.id && entry.to === room));
        if (after.length !== before.length) { write(OUTBOX_KEY, after); changed(); }
      }
    }
    function onEvent(event) {
      return queue(async () => {
        if (stopped) return;
        const line = status(event.room);
        if (event.type === 'signal') await onSignal(event.room, event.blob);
        else if (event.type === 'presence') {
          line.present = event.peers.length > 0;
          if (line.present && role === 'parent' && !line.open) await negotiate(event.room);
        } else if (event.type === 'open') {
          Object.assign(line, {open: true, offering: 0, tries: 0});
          await wire(event.room, {t: 'hello', id: state.id, role, ...describe()}).catch(() => {});
          await flush(event.room); changed();
        } else if (event.type === 'close') {
          if (!line.open && !line.offering) return;
          line.open = false; changed();
          if (line.present && role === 'parent' && !line.offering) later(() => queue(() => negotiate(event.room)), 2000);
        } else if (event.type === 'message') await onMessage(event.room, event.data);
      });
    }

    const link = {
      role,
      start() {
        return queue(async () => {
          if (started) return; started = true; load();
          if (expirePending()) write(STATE_KEY, state);
          transport.on(onEvent);
          await rooms();
        });
      },
      stop() { stopped = true; return transport.dispose(); },
      pairings() { return load().pairings.map(publicPairing); },
      /* What the scanned code says: where to go, the code, and the relay when it is not the usual one. */
      pairingAddress(code) { return (options.companion || DEFAULT_COMPANION) + '#pair=' + code + (options.relay && options.relay !== DEFAULT_RELAY ? '&relay=' + encodeURIComponent(options.relay) : ''); },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      /* Cubby: a fresh code for a phone to scan. Any earlier unscanned code stops working. */
      beginPairing() {
        return queue(async () => {
          load(); const code = crypto.newCode();
          state.pairings = state.pairings.filter(item => item.confirmed);
          state.pairings.push({room: await crypto.room(code), code, role: role === 'cubby' ? 'parent' : 'cubby', created: now()});
          save(); await rooms(); return code;
        });
      },
      /* The scanning side: join with the code it was shown. */
      acceptPairing(code) {
        return queue(async () => {
          if (!validCode(code)) throw Error('Invalid pairing code');
          load(); const room = await crypto.room(code);
          if (!pairing(room)) { state.pairings.push({room, code, role: role === 'parent' ? 'cubby' : 'parent', created: now()}); save(); await rooms(); }
          return room;
        });
      },
      removePairing(id) {
        return queue(async () => {
          load(); state.pairings = state.pairings.filter(item => item.room !== id); live.delete(id);
          write(OUTBOX_KEY, held().filter(item => item.to !== id)); save();
          await transport.close(id).catch(() => {}); await rooms();
        });
      },
      /* What a game (or its page on the phone) uses. */
      channel(game) {
        if (!GAME_ID.test(game)) throw Error('Invalid game id');
        return {
          /* Held until each receiver has stored it. `to` is one paired device; without it, every paired grown-up. */
          send(body, target = {}) {
            const encoded = JSON.stringify(body);
            if (encoded === undefined || encoded.length > MAX_MESSAGE) throw Error('Message must be JSON under ' + MAX_MESSAGE + ' characters');
            const to = target.to ? [target.to] : load().pairings.filter(item => item.confirmed && item.role === 'parent').map(item => item.room);
            if (target.to && !pairing(target.to)) throw Error('Unknown paired device');
            if (!target.to && role !== 'cubby') throw Error('Say which Cubby this is for');
            const player = target.player || (role === 'cubby' ? currentPlayer() : null) || null, id = crypto.newId() + crypto.newId();
            const waiting = held();
            if (waiting.length + to.length > MAX_HELD) throw Error('Too many messages waiting');
            write(OUTBOX_KEY, [...waiting, ...to.map(room => ({id, to: room, game, player, body, at: now()}))]);
            for (const room of to) queue(() => flush(room));
            changed(); return id;
          },
          onMessage(fn) {
            if (!handlers.has(game)) handlers.set(game, new Set());
            handlers.get(game).add(fn); queue(() => deliver(game));
            return () => handlers.get(game).delete(fn);
          },
          peers: () => link.pairings().filter(item => item.confirmed),
          waiting: () => held().filter(item => item.game === game).length,
          /* A secret both sides can work out with no connection, for this game and label. */
          key(peer, label) { const item = pairing(peer); if (!item) return Promise.reject(Error('Unknown paired device')); return crypto.appKey(item.code, game + ':' + String(label)); }
        };
      }
    };
    return link;
  }

  /* Transport for anything with WebRTC in the page: phones, desktop, the web hub. */
  function createBrowserTransport(options) {
    const relay = String(options.relay || '').replace(/\/+$/, ''), fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    const Peer = options.RTCPeerConnection || globalThis.RTCPeerConnection, wait = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const watched = new Map(), lines = new Map();
    let listener = () => {}, me = '', disposed = false;
    const emit = event => { try { listener(event); } catch (_) {} };
    const url = room => relay + '/v1/rooms/' + room + '/messages';
    async function poll(room, entry) {
      let after = 0;
      while (!disposed && watched.get(room) === entry) {
        try {
          const reply = await fetcher(url(room) + '?me=' + me + '&after=' + after + '&wait=25', {cache: 'no-store', signal: entry.abort.signal});
          if (!reply.ok) throw Error('Relay unavailable');
          const body = await reply.json(); after = body.seq;
          emit({type: 'presence', room, peers: body.peers});
          for (const message of body.messages) emit({type: 'signal', room, blob: message.blob});
        } catch (_) { if (!disposed && watched.get(room) === entry) await new Promise(done => wait(done, 3000)); }
      }
    }
    function drop(room) { const line = lines.get(room); if (!line) return; lines.delete(room); try { line.channel?.close(); line.pc.close(); } catch (_) {} }
    function attach(room, line, channel) {
      line.channel = channel;
      channel.onopen = () => { if (lines.get(room) === line) emit({type: 'open', room}); };
      channel.onclose = () => { if (lines.get(room) === line) { lines.delete(room); emit({type: 'close', room}); } };
      channel.onmessage = event => { if (lines.get(room) === line && typeof event.data === 'string') emit({type: 'message', room, data: event.data}); };
    }
    function connection(room) {
      drop(room);
      // No outside lookups: the two devices are on the same home network.
      const line = {pc: new Peer({iceServers: []}), channel: null}; lines.set(room, line);
      line.pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(line.pc.connectionState) && lines.get(room) === line) { lines.delete(room); emit({type: 'close', room}); } };
      return line;
    }
    function gathered(pc) {
      return new Promise(done => {
        if (pc.iceGatheringState === 'complete') return done();
        const check = () => { if (pc.iceGatheringState === 'complete') done(); };
        pc.addEventListener('icegatheringstatechange', check); wait(done, 2500);
      });
    }
    return {
      on(fn) { listener = fn; },
      async setRooms(id, list) {
        me = id;
        for (const [room, entry] of watched) if (!list.includes(room)) { watched.delete(room); entry.abort.abort(); drop(room); }
        for (const room of list) if (!watched.has(room)) { const entry = {abort: new AbortController()}; watched.set(room, entry); poll(room, entry); }
      },
      async signal(room, blob) {
        const reply = await fetcher(url(room), {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({from: me, blob})});
        if (!reply.ok) throw Error('Relay unavailable');
      },
      async offer(room) {
        const line = connection(room); attach(room, line, line.pc.createDataChannel('cubby'));
        await line.pc.setLocalDescription(await line.pc.createOffer()); await gathered(line.pc);
        return line.pc.localDescription.sdp;
      },
      async answer(room, sdp) {
        const line = connection(room); line.pc.ondatachannel = event => attach(room, line, event.channel);
        await line.pc.setRemoteDescription({type: 'offer', sdp});
        await line.pc.setLocalDescription(await line.pc.createAnswer()); await gathered(line.pc);
        return line.pc.localDescription.sdp;
      },
      async accept(room, sdp) { const line = lines.get(room); if (!line) throw Error('No offer'); await line.pc.setRemoteDescription({type: 'answer', sdp}); },
      async send(room, data) { const line = lines.get(room); if (!line?.channel || line.channel.readyState !== 'open') throw Error('Not connected'); line.channel.send(data); },
      async close(room) { drop(room); },
      async dispose() { disposed = true; for (const entry of watched.values()) entry.abort.abort(); watched.clear(); for (const room of [...lines.keys()]) drop(room); }
    };
  }

  /* Transport for a host whose server holds the connection (the handheld). The
   * server keeps it across page changes; each page picks up where the last left off. */
  function createHostTransport(options) {
    const fetcher = options.fetch || globalThis.fetch.bind(globalThis), storage = options.storage, wait = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const relay = options.relay || '', abort = new AbortController();
    let listener = () => {}, disposed = false, running = false;
    async function post(path, body) {
      const reply = await fetcher('/api/link/' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      if (!reply.ok) throw Error('Link unavailable');
      return reply.json();
    }
    async function events() {
      let cursor = {boot: '', seq: 0};
      try { cursor = JSON.parse(storage.getItem(CURSOR_KEY)) || cursor; } catch (_) {}
      while (!disposed) {
        try {
          const reply = await fetcher('/api/link/events?boot=' + encodeURIComponent(cursor.boot) + '&after=' + cursor.seq, {cache: 'no-store', signal: abort.signal});
          if (!reply.ok) throw Error('Link unavailable');
          const body = await reply.json();
          for (const event of body.events) await listener(event);
          cursor = {boot: body.boot, seq: body.seq};
          try { storage.setItem(CURSOR_KEY, JSON.stringify(cursor)); } catch (_) {}
        } catch (_) { if (!disposed) await new Promise(done => wait(done, 2000)); }
      }
    }
    return {
      on(fn) { listener = fn; },
      async setRooms(id, list) {
        const reply = await post('rooms', {me: id, rooms: list, relay});
        // The server kept its connections while the page changed: tell this page where things stand.
        for (const [room, now] of Object.entries(reply.rooms || {})) { await listener({type: 'presence', room, peers: now.peers || []}); if (now.open) await listener({type: 'open', room}); }
        if (!running) { running = true; events(); }
      },
      signal: (room, blob) => post('signal', {room, blob}),
      offer: async room => (await post('offer', {room})).sdp,
      answer: async (room, sdp) => (await post('answer', {room, sdp})).sdp,
      accept: (room, sdp) => post('accept', {room, sdp}),
      send: (room, data) => post('send', {room, data}),
      close: room => post('close', {room}),
      async dispose() { disposed = true; abort.abort(); }
    };
  }

  /* In a page: find what this host can do and offer one link. Hosts set
   * window.CubbyLinkOptions = {role, relay, describe} before this script. */
  function install(win) {
    if (!win.document || !win.location) return null;
    const options = win.CubbyLinkOptions || {};
    let storage; try { storage = win.localStorage; } catch (_) { return null; }
    if (!storage || !win.crypto?.subtle) return null;
    const session = (() => { try { return win.sessionStorage; } catch (_) { return null; } })();
    const match = /^\/(?:games|__cubby_games__)\/([a-z0-9][a-z0-9-]{0,79})\//.exec(win.location.pathname), game = options.game || (match && match[1]) || null;
    const role = options.role === 'parent' ? 'parent' : 'cubby';
    const player = () => { try { return role === 'cubby' && win.HandheldProfiles ? win.HandheldProfiles.current({storage, session}) : null; } catch (_) { return null; } };
    const describe = options.describe || (() => {
      if (role !== 'cubby' || !win.HandheldProfiles) return {name: options.name || (role === 'cubby' ? 'Cubby' : 'Phone')};
      const registry = win.HandheldProfiles.readRegistry(storage);
      return {name: options.name || 'Cubby', players: registry.profiles.map(p => ({id: p.id, name: p.name || win.HandheldProfiles.ANIMAL_NAMES[p.avatar] || '', avatar: p.avatar}))};
    });
    let relay = options.relay || DEFAULT_RELAY; try { relay = storage.getItem('cubby:link:relay') || relay; } catch (_) {}
    const ready = (async () => {
      let transport = options.transport;
      if (!transport && role === 'cubby' && /^https?:$/.test(win.location.protocol)) {
        try { const reply = await win.fetch('/api/link', {cache: 'no-store'}); if (reply.ok && (await reply.json()).available) transport = createHostTransport({storage, relay, fetch: win.fetch.bind(win)}); } catch (_) {}
      }
      if (!transport && win.RTCPeerConnection && relay) transport = createBrowserTransport({relay, fetch: win.fetch.bind(win), RTCPeerConnection: win.RTCPeerConnection});
      if (!transport) return null;
      let companion = options.companion || DEFAULT_COMPANION; try { companion = storage.getItem('cubby:link:companion') || companion; } catch (_) {}
      const link = createLink({role, storage, transport, crypto: win.crypto, describe, player, relay, companion});
      await link.start(); return link;
    })().catch(() => null);
    return {
      game, role,
      /* Resolves to the link, or null on a host that cannot make one. Never show a dead control. */
      ready,
      /* A game's own channel: `const line = await CubbyLink.channel()`; null when unavailable. */
      async channel(id) { const link = await ready; return link ? link.channel(id || game) : null; }
    };
  }

  return {createLink, createBrowserTransport, createHostTransport, createCrypto, install, validCode, DEFAULT_RELAY, MAX_MESSAGE};
});

/* Vendor this file with a game's companion. It uses the Cubby parent app's
 * existing connection; it creates no pairing, relay connection or secret store. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.CubbyCompanion = api;
    root.CubbyLinkAPI = {MAX_MESSAGE: 180000};
    root.CubbyLink = api.attach(root);
  }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function fromPort(port) {
    let peers = [], game = null, waiting = 0, closed = false, next = 0, resolveReady;
    const pending = new Map(), changes = new Set(), handlers = new Set(), inbox = [];
    const ready = new Promise(resolve => { resolveReady = resolve; });
    function close(reason = 'Companion closed') {
      if (closed) return; closed = true;
      resolveReady(null);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error(reason)); }
      pending.clear(); peers = []; waiting = 0;
      for (const fn of changes) fn();
      changes.clear(); handlers.clear(); port.onmessage = null; port.close();
    }
    function request(op, fields) {
      if (closed) return Promise.reject(Error('Companion closed'));
      if (pending.size >= 64) return Promise.reject(Error('Too many requests'));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(Error('Cubby did not answer. Try again.')); }, 15000);
        pending.set(id, {resolve, reject, timer});
        port.postMessage({id, op, ...fields});
      });
    }
    const line = {
      send: (body, target = {}) => request('send', {body, target}),
      key: (peer, label) => request('key', {peer, label}),
      onMessage(fn) { handlers.add(fn); for (const message of inbox.splice(0)) fn(message); return () => handlers.delete(fn); },
      waiting: () => waiting,
      peers: () => peers.map(item => structuredClone(item)),
      player: () => null
    };
    const link = {
      pairings: () => peers.map(item => structuredClone(item)),
      onChange(fn) { changes.add(fn); return () => changes.delete(fn); },
      channel(id) { if (id && id !== game) throw Error('Not the selected game'); return line; }
    };
    port.onmessage = event => {
      const data = event.data;
      if (closed || !data) return;
      if (data.type === 'state') {
        game = data.game; peers = data.pairings; waiting = data.waiting;
        resolveReady(link); for (const fn of changes) fn();
      } else if (data.type === 'message') { if (!handlers.size) { inbox.push(data.message); if (inbox.length > 200) inbox.shift(); } else for (const fn of handlers) fn(data.message); }
      else if (data.type === 'result') {
        const entry = pending.get(data.id); if (!entry) return;
        pending.delete(data.id); clearTimeout(entry.timer);
        if (data.error) entry.reject(Error(data.error)); else entry.resolve(data.value);
      } else if (data.type === 'closed') close(data.error);
    };
    port.start();
    return {ready, close, channel: async id => { const live = await ready; return live ? live.channel(id) : null; }};
  }
  function attach(win) {
    let client = null, resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    if (win.parent === win) { resolveReady(null); return {ready, embedded: false}; }
    // The host sends a port only after checking this window and the publisher
    // origin. Do not accept connections from siblings, nested frames or popups.
    function receive(event) {
      if (client || event.source !== win.parent || event.data?.type !== 'cubby-companion-connect' || event.data.version !== 1 || !event.ports?.[0]) return;
      win.removeEventListener('message', receive); clearTimeout(timer);
      client = fromPort(event.ports[0]); client.ready.then(resolveReady);
    }
    win.addEventListener('message', receive);
    const timer = setTimeout(() => { win.removeEventListener('message', receive); resolveReady(null); }, 15000);
    function hello() { win.parent.postMessage({type:'cubby-companion-ready', version:1}, '*'); }
    if (win.document.readyState === 'complete') hello(); else win.addEventListener('load', hello, {once:true});
    win.addEventListener('pagehide', () => { clearTimeout(timer); win.removeEventListener('message', receive); client?.close(); }, {once:true});
    return {ready, embedded: true, channel: async id => { const live = await ready; return live ? live.channel(id) : null; }};
  }
  return {fromPort, attach};
});

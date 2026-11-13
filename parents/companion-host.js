/* The parent's pairing stays here. A game receives only a revocable capability
 * for one installed game on one Cubby, never the pairing secret or transport. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CubbyCompanionHost = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function connect(win, {frame, link, game, peer, url, onReady = () => {}, onClose = () => {}}) {
    const origin = new URL(url, win.location.href).origin;
    // A script with the dashboard's origin could read its storage without a
    // bridge. Publishers must host their companion on their own origin.
    if (origin === win.location.origin || !/^https:\/\//.test(origin)) throw Error('Companions need their own HTTPS origin');
    let closed = false, port = null, unsubscribeMessage = null, unsubscribeChange = null;
    let pending = 0;
    const channel = link.channel(game);
    function current() {
      const cubby = link.pairings().find(item => item.id === peer && item.confirmed);
      return cubby && cubby.games?.includes(game) && cubby.companions?.some(item => item.id === game && item.companion?.url === url) ? cubby : null;
    }
    function publicPeer(item) {
      return {id: item.id, name: item.name, confirmed: !!item.confirmed, connected: !!item.connected,
        players: (item.players || []).map(player => ({id: player.id, name: player.name, avatar: player.avatar}))};
    }
    function send(value) { if (!closed && port) port.postMessage(value); }
    function snapshot() {
      const cubby = current();
      if (!cubby) return close('This game is no longer available on this Cubby.');
      send({type: 'state', game, pairings: [publicPeer(cubby)], waiting: channel.waiting(peer)});
    }
    function close(reason = 'Companion closed') {
      if (closed) return;
      send({type: 'closed', error: reason}); closed = true;
      win.removeEventListener('message', handshake);
      unsubscribeMessage?.(); unsubscribeChange?.();
      if (port) { port.onmessage = null; port.close(); }
      onClose(reason);
    }
    async function request(event) {
      const data = event.data;
      if (closed || !data || !Number.isSafeInteger(data.id) || data.id < 1 || typeof data.op !== 'string') return;
      const id = data.id;
      if (++pending > 64) { pending--; return send({type:'result', id, error:'Too many requests'}); }
      try {
        const cubby = current(); if (!cubby) { close('This game is no longer available on this Cubby.'); return; }
        let value;
        if (data.op === 'send') {
          const target = data.target || {};
          if (target.to && target.to !== peer) throw Error('Not the selected Cubby');
          if (target.player && !cubby.players?.some(player => player.id === target.player)) throw Error('Unknown player');
          value = channel.send(data.body, {to: peer, ...(target.player ? {player: target.player} : {})});
        } else if (data.op === 'key') {
          if (data.peer !== peer) throw Error('Not the selected Cubby');
          if (typeof data.label !== 'string' || data.label.length > 256) throw Error('Invalid key label');
          value = await channel.key(peer, data.label);
        } else if (data.op === 'waiting') value = channel.waiting(peer);
        else throw Error('Unknown companion operation');
        send({type:'result', id, value}); snapshot();
      } catch (error) { send({type:'result', id, error: error.message || 'Companion request failed'}); }
      finally { pending--; }
    }
    function handshake(event) {
      if (closed || port || event.source !== frame.contentWindow || event.origin !== origin ||
          event.data?.type !== 'cubby-companion-ready' || event.data.version !== 1) return;
      if (!current()) return close('This game is no longer available on this Cubby.');
      const pair = new win.MessageChannel(); port = pair.port1;
      port.onmessage = request; port.start();
      unsubscribeMessage = channel.onMessage(message => {
        if (message.from?.id === peer) send({type:'message', message: {...message, from: publicPeer(message.from)}});
      });
      unsubscribeChange = link.onChange(snapshot);
      event.source.postMessage({type:'cubby-companion-connect', version:1}, origin, [pair.port2]);
      snapshot(); onReady();
    }
    if (!current()) throw Error('Game not installed on the selected Cubby');
    win.addEventListener('message', handshake);
    return {close};
  }
  return {connect};
});

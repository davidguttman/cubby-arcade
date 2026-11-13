/* Generic phone dashboard. Games declare their own companion in their release
 * manifest; the paired Cubby advertises only its installed versions. No catalog,
 * game-specific route, or game-specific code belongs here. */
(function (win) {
  'use strict';
  const doc = win.document, app = doc.getElementById('app');
  let active = null;
  const FACES = {cubby: '🏠', fox: '🦊', frog: '🐸', bear: '🐻', bunny: '🐰', panda: '🐼', owl: '🦉', cat: '🐱', chick: '🐥'};
  function add(parent, tag, text, cls) { const node = doc.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; parent.appendChild(node); return node; }
  function head() { const h = add(app, 'header'); h.innerHTML = '<svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><path class="roof" d="M24 3.5 44 18.5V39a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V18.5Z"/><rect class="door" x="11" y="20" width="26" height="18" rx="6"/><g class="face"><circle cx="19" cy="27.5" r="2.4"/><circle cx="29" cy="27.5" r="2.4"/><path d="M19.5 32.5q4.5 3.4 9 0"/></g></svg>'; const t = add(h, 'div'); add(t, 'h1', 'Cubby'); add(t, 'p', 'for grown-ups', 'tagline'); }
  function unpaired(note) {
    app.replaceChildren(); head();
    const card = add(app, 'section', '', 'card');
    add(card, 'h2', 'Pair with a Cubby');
    add(card, 'p', note || 'This phone isn’t paired with a Cubby yet.');
    if (!note) { const steps = add(card, 'ol'); for (const step of ['On the Cubby, open the gear tab and answer the question.', 'Choose Phones, then Add a phone.', 'Point this phone’s camera at the code.']) add(steps, 'li', step); }
    pairingAction(card);
  }
  // The same action adds a first or another Cubby without hiding known devices.
  function pairingAction(parent) {
    const paste = add(parent, 'button', 'Paste pairing link', 'paste-pairing'); paste.type = 'button';
    add(parent, 'p', 'For the installed app: show a fresh Cubby code, then copy the link from the camera’s QR preview before opening it. Paste it here, not from the browser’s address bar.', 'hint');
    const error = add(parent, 'p', '', 'hint'); error.hidden = true; error.setAttribute('role', 'status');
    paste.addEventListener('click', async () => {
      const text = win.prompt('Paste the fresh Cubby link copied from the camera’s QR preview before opening it');
      if (!text) return;
      error.hidden = true;
      try {
        const parsed = win.CubbyParsePairingLink(text);
        let relay = null; try { relay = win.localStorage.getItem('cubby:parent-link:relay'); } catch (_) {}
        if (parsed.relay && parsed.relay !== relay) {
          // The transport reads its relay at startup. Restart only this app;
          // pairing.js consumes and clears the transient fragment immediately.
          win.history.replaceState(null, '', win.location.pathname + '#pair=' + parsed.code + '&relay=' + encodeURIComponent(parsed.relay));
          win.location.reload();
          return;
        }
        const link = await win.CubbyLink.ready;
        if (!link) throw Error('Pairing unavailable');
        await link.acceptPairing(parsed.code); render(link);
      } catch (_) {
        error.textContent = 'That link couldn’t be used. Show a fresh Cubby code and copy its camera preview link before opening it. Your existing pairings are unchanged.';
        error.hidden = false;
      }
    });
  }

  function openCompanion(link, cubby, game) {
    if (active) return;
    app.replaceChildren();
    const panel = add(app, 'section', '', 'companion-panel');
    const bar = add(panel, 'div', '', 'companion-bar');
    const back = add(bar, 'button', '‹ All games', 'companion-back'); back.type = 'button';
    add(bar, 'span', game.companion.title || game.id, 'companion-title');
    const status = add(panel, 'p', 'Opening game controls…', 'hint companion-status'); status.setAttribute('role', 'status');
    const retry = add(panel, 'button', 'Try again', 'companion-retry'); retry.hidden = true;
    const frame = add(panel, 'iframe', '', 'companion-frame');
    frame.title = (game.companion.title || game.id) + ' controls for ' + (cubby.name || 'Cubby');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
    frame.referrerPolicy = 'no-referrer';
    let bridge = null, timer = null, firstLoad = true;
    function stop() { clearTimeout(timer); bridge?.close(); bridge = null; }
    function close() {
      if (!active) return;
      active = null; stop(); frame.remove(); app.classList?.remove('with-companion'); render(link);
    }
    function failed(message) { if (!active) return; clearTimeout(timer); status.textContent = message; status.hidden = false; retry.hidden = false; }
    function connect() {
      stop();
      try {
        bridge = win.CubbyCompanionHost.connect(win, {frame, link, game: game.id, peer: cubby.id, url: game.companion.url,
          onReady() { clearTimeout(timer); status.hidden = true; retry.hidden = true; },
          onClose(reason) { if (active) failed(reason); }});
        timer = setTimeout(() => { failed('These controls couldn’t connect. Check your connection and try again.'); }, 15000);
        return true;
      } catch (_) { failed('These game controls can’t open inside Cubby. The game needs an updated companion.'); return false; }
    }
    active = {close}; app.classList?.add('with-companion');
    back.addEventListener('click', () => { if (win.history?.state?.cubbyCompanion) win.history.back(); else close(); });
    retry.addEventListener('click', () => { status.textContent = 'Opening game controls…'; retry.hidden = true; firstLoad = true; if (connect()) frame.src = game.companion.url; });
    frame.addEventListener('load', () => { if (firstLoad) { firstLoad = false; return; } connect(); });
    frame.addEventListener('error', () => failed('Couldn’t load these game controls. Check your connection and try again.'));
    if (connect()) frame.src = game.companion.url;
    win.history?.pushState({cubbyCompanion: true}, '', win.location.pathname);
    back.focus?.();
  }
  win.addEventListener?.('popstate', () => active?.close());
  win.addEventListener?.('pagehide', () => active?.close());
  function render(link) {
    // Keep the embedded document and any in-progress edits alive while the
    // shared connection updates; the bridge pushes state into it separately.
    if (active) return;
    const cubbies = link.pairings();
    if (!cubbies.length) return unpaired();
    app.replaceChildren(); head();
    for (const cubby of cubbies) {
      const card = add(app, 'section', '', 'card'), top = add(card, 'div', '', 'top'), title = add(top, 'button', '', 'name'); title.type = 'button';
      add(title, 'span', cubby.name || 'Cubby'); add(title, 'span', '✎', 'pen'); title.setAttribute('aria-label', 'Rename ' + (cubby.name || 'Cubby'));
      // A name of your own for each Cubby, so two in one house can be told apart. Kept on this phone.
      title.addEventListener('click', () => { const next = win.prompt('Name this Cubby', cubby.name || 'Cubby'); if (next !== null) link.renamePairing(cubby.id, next.trim() === (cubby.ownName || '') ? '' : next); });
      add(top, 'span', cubby.connected ? 'Connected' : cubby.confirmed ? 'Not in reach' : 'Pairing…', 'state' + (cubby.connected ? ' on' : ''));
      if (!cubby.confirmed) { add(card, 'p', 'Keep the Cubby on and this page open for a moment.', 'hint'); continue; }
      const players = add(card, 'ul', '', 'players');
      for (const player of cubby.players) { const li = add(players, 'li'); add(li, 'span', FACES[player.avatar] || '🙂', 'face'); add(li, 'span', player.name); }
      if (!cubby.connected) add(card, 'p', 'Showing the last information synced from this Cubby. Each game’s companion manages its own changes.', 'hint');
      add(card, 'h2', 'Games');
      if (!Array.isArray(cubby.companions)) {
        add(card, 'p', 'Open the Cubby launcher to sync its installed game companions. If no list appears, update Cubby first.', 'hint');
      } else {
        const seen = new Set(), installed = cubby.companions.flatMap(game => {
          if (!game || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(game.id) || !cubby.games?.includes(game.id) || seen.has(game.id)) return [];
          try { const companion = win.CubbyLinkAPI.validateCompanion(game.companion); seen.add(game.id); return [{id: game.id, companion}]; }
          catch (_) { return []; }
        });
        if (!installed.length) add(card, 'p', 'No installed games with grown-up controls.', 'hint');
        else {
          if (!cubby.connected) add(card, 'p', 'Last synced games', 'hint');
          const grid = add(card, 'div', '', 'games');
          for (const game of installed) {
            const companion = game.companion, title = companion.title || game.id.replace(/-/g, ' ');
            const a = add(grid, 'button', '', 'game'); a.type = 'button';
            a.addEventListener('click', () => openCompanion(link, cubby, game));
            if (companion.artwork) { const img = add(a, 'img'); img.src = companion.artwork; img.alt = ''; img.loading = 'lazy'; }
            add(a, 'span', title);
          }
        }
      }
    }
    const pairingCard = add(app, 'section', '', 'card');
    add(pairingCard, 'h2', 'Add another Cubby');
    pairingAction(pairingCard);
    // What this phone calls itself on the Cubby's Phones page; the Cubby hears it next time they connect.
    const me = add(app, 'button', '', 'quiet self'); me.type = 'button';
    add(me, 'span', 'This phone: ' + (win.CubbyLinkOptions.name || 'Phone')); add(me, 'span', '✎', 'pen');
    me.addEventListener('click', () => {
      const next = win.prompt('Name this phone', win.CubbyLinkOptions.name || 'Phone'); if (next === null || !next.trim()) return;
      try { win.localStorage.setItem('cubby:parent-link:name', next.trim().slice(0, 40)); } catch (_) {}
      win.CubbyLinkOptions.name = next.trim().slice(0, 40);
      link.announce?.(); render(link);   // the Cubby hears the new name now
    });
    for (const cubby of cubbies) {
      const remove = add(app, 'button', 'Forget ' + (cubby.name || 'this Cubby'), 'quiet'); remove.type = 'button';
      remove.addEventListener('click', () => { if (win.confirm('Forget ' + (cubby.name || 'this Cubby') + '? You can pair again from its settings.')) link.removePairing(cubby.id); });
    }
  }
  if (!win.CubbyLink) unpaired('This browser can’t connect to a Cubby. Try the phone’s own browser.');
  else win.CubbyLink.ready.then(async link => {
    if (!link) return unpaired(win.CubbyPairingCode ? 'That code couldn’t be used. Open Add a phone on the Cubby again and scan the new code.' : 'This browser can’t connect to a Cubby. Try the phone’s own browser.');
    link.onChange(() => render(link));
    if (win.CubbyPairingCode) { try { await link.acceptPairing(win.CubbyPairingCode); } catch (_) {} }
    render(link);
  });
})(window);

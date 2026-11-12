/* Cubby for grown-ups: the page a phone opens by scanning a Cubby's code. It pairs, shows
 * which Cubbies this phone knows and who plays on them, and opens each game's own grown-ups
 * page. Those live under /parents/<game>/ on this same site, so they use this pairing. */
(function (win) {
  'use strict';
  const doc = win.document, app = doc.getElementById('app');
  const FACES = {cubby: '🏠', fox: '🦊', frog: '🐸', bear: '🐻', bunny: '🐰', panda: '🐼', owl: '🦉', cat: '🐱', chick: '🐥'};
  let games = [];
  function add(parent, tag, text, cls) { const node = doc.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; parent.appendChild(node); return node; }
  function head() { const h = add(app, 'header'); h.innerHTML = '<svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><path class="roof" d="M24 3.5 44 18.5V39a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V18.5Z"/><rect class="door" x="11" y="20" width="26" height="18" rx="6"/><g class="face"><circle cx="19" cy="27.5" r="2.4"/><circle cx="29" cy="27.5" r="2.4"/><path d="M19.5 32.5q4.5 3.4 9 0"/></g></svg>'; const t = add(h, 'div'); add(t, 'h1', 'Cubby'); add(t, 'p', 'for grown-ups', 'tagline'); }
  function unpaired(note) {
    app.replaceChildren(); head();
    const card = add(app, 'section', '', 'card');
    add(card, 'h2', 'Pair with a Cubby');
    add(card, 'p', note || 'This phone isn’t paired with a Cubby yet.');
    if (!note) { const steps = add(card, 'ol'); for (const step of ['On the Cubby, open the gear tab and answer the question.', 'Choose Phones, then Add a phone.', 'Point this phone’s camera at the code.']) add(steps, 'li', step); }
  }
  function render(link) {
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
      if (!cubby.connected) add(card, 'p', 'Changes are kept on this phone and reach the Cubby when both are on at home.', 'hint');
    }
    if (cubbies.some(cubby => cubby.confirmed) && games.length) {
      const card = add(app, 'section', '', 'card');
      add(card, 'h2', 'Games');
      const grid = add(card, 'div', '', 'games');
      for (const game of games) {
        const a = add(grid, 'a', '', 'game'); a.href = game.id + '/';
        const img = add(a, 'img'); img.src = game.artwork; img.alt = ''; img.loading = 'lazy';
        add(a, 'span', game.title);
      }
    }
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
  // Games that have a grown-ups page: from the store and the early-release list.
  const catalogs = ['../catalog', '../beta/catalog'].map(url => fetch(url, {cache: 'no-store'}).then(r => r.ok ? r.json() : []).catch(() => []));
  Promise.all(catalogs).then(lists => {
    const seen = new Set();
    games = lists.flat().filter(game => game && typeof game.parents === 'string' && /^[a-z0-9-]+$/.test(game.id) && !seen.has(game.id) && seen.add(game.id));
  }).finally(() => {
    if (!win.CubbyLink) return unpaired('This browser can’t connect to a Cubby. Try the phone’s own browser.');
    win.CubbyLink.ready.then(async link => {
      if (!link) return unpaired(win.CubbyPairingCode ? 'That code couldn’t be used. Open Add a phone on the Cubby again and scan the new code.' : 'This browser can’t connect to a Cubby. Try the phone’s own browser.');
      link.onChange(() => render(link));
      if (win.CubbyPairingCode) { try { await link.acceptPairing(win.CubbyPairingCode); } catch (_) {} }
      render(link);
    });
  });
})(window);

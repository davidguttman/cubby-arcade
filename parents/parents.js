/* The grown-ups' home page: which Cubbies this phone is paired with, and who plays on them. */
(function (win) {
  'use strict';
  const doc = win.document, app = doc.getElementById('app');
  function add(parent, tag, text, cls) { const node = doc.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; parent.appendChild(node); return node; }
  function unpaired(note) {
    app.replaceChildren(); add(app, 'h1', 'Cubby');
    add(app, 'p', note || 'This phone isn’t paired with a Cubby yet.');
    const steps = add(app, 'ol');
    for (const step of ['On the Cubby, open the gear tab and answer the question.', 'Choose Phones, then Add a phone.', 'Point this phone’s camera at the code.']) add(steps, 'li', step);
  }
  function render(link) {
    const cubbies = link.pairings();
    if (!cubbies.length) return unpaired();
    app.replaceChildren(); add(app, 'h1', 'Cubby');
    for (const cubby of cubbies) {
      const card = add(app, 'section', '', 'cubby'), head = add(card, 'h2', cubby.name || 'Cubby');
      add(head, 'span', cubby.connected ? 'Connected' : cubby.confirmed ? 'Not in reach' : 'Pairing…', 'state' + (cubby.connected ? ' on' : ''));
      const players = add(card, 'ul', '', 'players');
      for (const player of cubby.players) add(players, 'li', player.name);
      if (cubby.confirmed && !cubby.connected) add(card, 'p', 'Changes you make are kept here and sent the next time this phone and the Cubby are both on at home.', 'hint');
      const remove = add(card, 'button', 'Forget this Cubby', 'quiet'); remove.type = 'button';
      remove.addEventListener('click', () => { if (win.confirm('Forget ' + (cubby.name || 'this Cubby') + '? You can pair again from its settings.')) link.removePairing(cubby.id); });
    }
  }
  if (!win.CubbyLink) return unpaired('This browser can’t connect to a Cubby. Try the phone’s own browser.');
  win.CubbyLink.ready.then(async link => {
    if (!link) return unpaired(win.CubbyPairingCode ? 'That code couldn’t be used. Open Add a phone on the Cubby again and scan the new code.' : '');
    link.onChange(() => render(link));
    if (win.CubbyPairingCode) { try { await link.acceptPairing(win.CubbyPairingCode); } catch (_) {} }
    render(link);
  });
})(window);

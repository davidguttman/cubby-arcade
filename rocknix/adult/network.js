/* Adult-only page. Password lives only in the input/request, never storage/logs. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const token = document.querySelector('meta[name="cubby-session"]').content;
  // `settings` means the adult came from the hub; otherwise this is required first-run setup.
  let selected = null, pending = false, shifted = false, knownComplete = false, settings = false, focusList = false;
  const letters = [['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'], ['!@#$%^&*()', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']];
  const ICONS = {
    backspace: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h12v14H9l-6-7ZM12 9.5l5 5M17 9.5l-5 5"/></svg>',
    bars: '<svg class="bars" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="16" width="4" height="5" rx="1"/><rect x="8.5" y="12" width="4" height="9" rx="1"/><rect x="14" y="8" width="4" height="13" rx="1"/><rect x="19.5" y="4" width="3" height="17" rx="1"/></svg>',
    tick: '<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12 5 5L21 5"/></svg>'
  };
  function message(text, tone) {
    $('status').textContent = text;
    if (tone) $('status').dataset.tone = tone; else delete $('status').dataset.tone;
  }
  function simulation(value) { $('simulation').hidden = !value; }
  // The password field is for attached keyboards; the controller drives the on-screen keys.
  function visibleButtons() { return [...document.querySelectorAll('button')].filter(b => !b.disabled && b.getClientRects().length); }
  function focusDefault() {
    (selected ? $('keyboard').querySelector('button')
      : !$('continue').hidden ? $('continue')
      : $('networks').querySelector('button') || visibleButtons()[0])?.focus();
  }
  function setBusy(value) {
    pending = value;
    document.body.classList.toggle('busy', value);
    document.querySelectorAll('button,input').forEach(b => { b.disabled = value; });
  }
  async function request(action, fields = {}) {
    const response = await fetch('/api/network', {method: 'POST', cache: 'no-store',
      headers: {'Content-Type': 'application/json', 'X-Cubby-Session': token},
      body: JSON.stringify({action, ...fields})});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'unavailable');
    simulation(result.simulation);
    return result;
  }
  async function operation(fn) {
    if (pending) return;
    const before = document.activeElement;
    setBusy(true);
    try { await fn(); }
    catch (error) {
      const texts = {connection_failed: 'Could not connect. Check the password and try again.',
        invalid_request: 'Check the Wi-Fi password (8–63 characters for a secured network).',
        unsupported_network: 'This network needs unsupported enterprise or WEP setup. Try a home Wi-Fi network.',
        busy: 'Cubby is busy. Return to the hub and try again.',
        unavailable: 'Wi-Fi is not available yet. Wait a moment, then retry.'};
      message(texts[error.message] || 'Connection check failed. Please retry.', 'bad');
    }
    finally {
      setBusy(false);
      // Disabling controls drops focus; a controller needs it back to keep working.
      if (!focusList && before?.matches?.('button') && before.getClientRects().length) before.focus();
      else focusDefault();
      focusList = false;
    }
  }
  function chrome() {
    $('title').textContent = selected ? selected.ssid : settings ? 'Wi-Fi' : 'Connect Cubby';
    $('intro').hidden = settings || !!selected;
    $('back').hidden = !selected && !settings;
    $('continue').hidden = settings || !knownComplete;
    document.body.classList.toggle('can-leave', !!selected || knownComplete);
    document.body.classList.toggle('entering', !!selected);
  }
  function showResult(result) {
    knownComplete = result.complete || knownComplete;
    chrome();
    if (result.internet) message('Internet is working. Cubby can get games and updates.', 'ok');
    else if (knownComplete) message('You are offline. Installed games still work; downloads wait for internet.', 'warn');
    else message('Internet is not available. Connect Wi-Fi, then check again.', 'warn');
  }
  function key(label, onPress, className) {
    const button = document.createElement('button');
    button.textContent = label;
    if (className) button.className = className;
    button.onclick = onPress;
    $('keyboard').append(button);
    return button;
  }
  function type(char) { const input = $('password'); if (input.value.length < 64) input.value += char; }
  function toggleCase() {
    const keys = [...$('keyboard').children], index = keys.indexOf(document.activeElement);
    shifted = !shifted; keyboard();
    $('keyboard').children[Math.max(index, 0)]?.focus();
  }
  function keyboard() {
    $('keyboard').replaceChildren();
    const row = (chars, ...extra) => {
      for (const char of chars) key(char, () => type(char));
      for (const char of extra) key(char, () => type(char));
    };
    const [digits, top, home, bottom] = letters[shifted ? 1 : 0];
    row(digits);
    const backspace = key('', () => { const input = $('password'); input.value = input.value.slice(0, -1); });
    backspace.innerHTML = ICONS.backspace; backspace.setAttribute('aria-label', 'Backspace');
    row(top, '-');
    row(home, ';', "'");
    row(bottom, ',', '.', '/', '?');
    row('', '_', '=', '+', '[', ']', '{', '}', ':', '"', '\\', '|');
    key(shifted ? 'abc' : 'ABC', toggleCase, 'case');
    key('Space', () => type(' '), 'space');
    row('', '`', '~', '<', '>');
  }
  function choose(entry) {
    if (!entry.supported) { message('Enterprise and WEP networks are not supported. Choose a home Wi-Fi network.', 'bad'); return; }
    selected = entry;
    $('password').value = '';
    $('password-panel').hidden = false;
    chrome(); keyboard();
    if (!entry.security || entry.security === '--') message('This is an open network. Press Connect; no password is needed.');
    else message('Enter the Wi-Fi password with the controller.');
    focusDefault();
  }
  function leavePassword() {
    selected = null; $('password').value = ''; $('password-panel').hidden = true;
    chrome();
  }
  function networkRow(entry) {
    const button = document.createElement('button');
    button.className = 'network' + (entry.connected ? ' connected' : '');
    button.innerHTML = ICONS.bars;
    button.firstChild.dataset.level = Math.max(1, Math.ceil(entry.signal / 25));
    const name = document.createElement('span'); name.className = 'name'; name.textContent = entry.ssid;
    const detail = document.createElement('small'); detail.textContent = entry.connected ? 'Connected' : entry.security && entry.security !== '--' ? entry.security : 'Open';
    button.append(name, detail);
    if (entry.connected) button.insertAdjacentHTML('beforeend', ICONS.tick);
    button.onclick = () => choose(entry);
    return button;
  }
  async function listNetworks() {
    const {networks} = await request('scan');
    $('networks').replaceChildren(...networks.map(networkRow));
    return networks;
  }
  async function scanNetworks() {
    leavePassword(); message('Finding Wi-Fi networks…');
    const networks = await listNetworks();
    focusList = true;
    const result = await request('status');
    showResult(result);
    if (!networks.length) message('No networks found. Move closer to the router and retry.', 'warn');
    else if (!result.internet && !knownComplete) message('Choose your Wi-Fi network.');
  }
  $('rescan').onclick = () => operation(scanNetworks);
  $('verify').onclick = () => operation(async () => { message('Checking internet access…'); showResult(await request('finish')); });
  $('connect').onclick = () => operation(async () => {
    if (!selected) return;
    message('Connecting… This can take a couple of minutes.');
    const password = $('password').value; $('password').value = '';
    await request('connect', {bssid: selected.bssid, password});
    leavePassword(); showResult(await request('finish'));
    await listNetworks().catch(() => {});
  });
  $('back').onclick = back;
  $('continue').onclick = () => { $('password').value = ''; location.replace('/'); };
  function move(dx, dy) {
    const buttons = visibleButtons(), active = document.activeElement;
    if (!buttons.length) return;
    if (!buttons.includes(active)) { buttons[0].focus(); return; }
    const a = active.getBoundingClientRect(), ax = a.x+a.width/2, ay=a.y+a.height/2;
    const candidates = buttons.filter(b => b !== active).map(button => {
      const r=button.getBoundingClientRect(), x=r.x+r.width/2-ax, y=r.y+r.height/2-ay;
      return {button, x,y, score: Math.hypot(x,y) + Math.abs(dx ? y : x)*3};
    }).filter(c => dx ? c.x*dx>2 : c.y*dy>2).sort((a,b)=>a.score-b.score);
    candidates[0]?.button.focus(); document.activeElement?.scrollIntoView({block:'nearest'});
  }
  function back() {
    if (selected) { leavePassword(); focusDefault(); }
    else if (settings) location.replace('/#options');
    else if (knownComplete) location.replace('/');
  }
  document.addEventListener('keydown', event => {
    const moves={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    if (moves[event.key] && document.activeElement !== $('password')) { event.preventDefault(); move(...moves[event.key]); }
    if (event.key === 'Escape') { event.preventDefault(); back(); }
  });
  let lastAction=0, lastButtons=[];
  function poll(now) {
    const pad = [...(navigator.getGamepads?.() || [])].find(p => p?.connected);
    if (pad && !pending) {
      const down=pad.buttons.map(b=>b.pressed);
      const edge = n => down[n] && !lastButtons[n];
      if (edge(0)) document.activeElement?.click();
      if (edge(1)) back();
      if ((edge(4) || edge(5)) && selected) toggleCase();
      if (edge(9) && selected) $('connect').click();
      if (now-lastAction > 170) {
        if (down[12] || pad.axes[1] < -.6) { move(0,-1); lastAction=now; }
        else if (down[13] || pad.axes[1] > .6) { move(0,1); lastAction=now; }
        else if (down[14] || pad.axes[0] < -.6) { move(-1,0); lastAction=now; }
        else if (down[15] || pad.axes[0] > .6) { move(1,0); lastAction=now; }
      }
      lastButtons=down;
    }
    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);
  operation(async () => {
    let result = await request('status');
    settings = !!result.complete;
    // A saved connection can already be online at first boot. Persist the
    // verified onboarding result before offering a route to the launcher.
    if (result.internet && !result.complete) result = await request('finish');
    showResult(result);
    window.CubbyUIReady?.();
    if (!result.internet) await scanNetworks();
    else await listNetworks().catch(() => {});
  });
})();

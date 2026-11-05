/* Adult-only page. Password lives only in the input/request, never storage/logs. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const token = document.querySelector('meta[name="cubby-session"]').content;
  let selected = null, pending = false, shifted = false, knownComplete = false;
  const chars = '1234567890qwertyuiopasdfghjklzxcvbnm';
  const symbols = '!@#$%^&*()QWERTYUIOPASDFGHJKLZXCVBNM';
  const punctuation = ['-', '_', '=', '+', '[', ']', '{', '}', ';', ':', "'", '"', ',', '.', '/', '?', '\\', '|', '`', '~', '<', '>'];
  function message(text) { $('status').textContent = text; }
  function simulation(value) { $('simulation').hidden = !value; }
  function visibleButtons() { return [...document.querySelectorAll('button,input')].filter(b => !b.disabled && b.getClientRects().length); }
  function focusFirst() { visibleButtons()[0]?.focus(); }
  function setBusy(value) {
    pending = value;
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
    setBusy(true);
    try { await fn(); }
    catch (error) {
      const texts = {connection_failed: 'Could not connect. Check the password and try again.',
        invalid_request: 'Check the Wi-Fi password (8–63 characters for a secured network).',
        unsupported_network: 'This network needs unsupported enterprise or WEP setup. Try a home Wi-Fi network.',
        busy: 'Cubby is busy. Return to the hub and try again.',
        unavailable: 'Wi-Fi is not available yet. Wait a moment, then retry.'};
      message(texts[error.message] || 'Connection check failed. Please retry.');
    }
    finally { setBusy(false); }
  }
  function showResult(result) {
    knownComplete = result.complete || knownComplete;
    $('continue').hidden = !knownComplete;
    $('cancel').hidden = !knownComplete;
    $('updates').hidden = !knownComplete;
    message(result.internet ? 'Internet is working. Cubby can get games and updates.' :
      knownComplete ? 'You are offline. Installed games still work; downloads wait for internet.' :
      'Internet is not available. Connect Wi-Fi, then check again.');
  }
  function keyboard() {
    const board = $('keyboard'); board.replaceChildren();
    [...(shifted ? symbols : chars), ...punctuation, 'Space', '⌫', shifted ? 'abc' : 'ABC'].forEach(char => {
      const button = document.createElement('button'); button.textContent = char;
      button.onclick = () => {
        const input = $('password');
        if (char === '⌫') input.value = input.value.slice(0, -1);
        else if (char === 'ABC' || char === 'abc') { shifted = !shifted; keyboard(); $('keyboard').querySelector('button')?.focus(); }
        else if (input.value.length < 64) input.value += char === 'Space' ? ' ' : char;
      };
      board.append(button);
    });
  }
  function choose(entry) {
    if (!entry.supported) { message('Enterprise and WEP networks are not supported. Choose a home Wi-Fi network.'); return; }
    selected = entry;
    $('selected').textContent = entry.ssid;
    $('password').value = '';
    $('password-panel').hidden = false; $('connect').hidden = false; $('rescan').hidden = true;
    $('back').hidden = false; $('verify').hidden = true;
    document.body.classList.add('entering');
    keyboard();
    if (!entry.security || entry.security === '--') message('This is an open network. Press Connect; no password is needed.');
    else message('Enter the Wi-Fi password using the controller keyboard.');
    $('keyboard').querySelector('button')?.focus();
  }
  function leavePassword() {
    selected = null; $('password').value = ''; $('password-panel').hidden = true;
    $('connect').hidden = true; $('rescan').hidden = false;
    $('back').hidden = true; $('verify').hidden = false;
    document.body.classList.remove('entering'); focusFirst();
  }
  async function scanNetworks() {
    leavePassword(); message('Finding Wi-Fi networks…');
    const {networks} = await request('scan'); $('networks').replaceChildren();
    networks.forEach(entry => {
      const button = document.createElement('button');
      button.textContent = entry.ssid + (entry.connected ? ' ✓' : '');
      const detail = document.createElement('small'); detail.textContent = ` ${entry.signal}% · ${entry.security || 'Open'}`;
      button.append(document.createElement('br'), detail); button.onclick = () => choose(entry);
      $('networks').append(button);
    });
    message(networks.length ? (knownComplete ? 'You are offline. Choose Wi-Fi or return to installed games.' : 'Choose your Wi-Fi network.') : 'No networks found. Move closer to the router and retry.');
    // The new buttons were created while controls were disabled.
    setBusy(false); focusFirst();
  }
  $('rescan').onclick = () => operation(scanNetworks);
  $('verify').onclick = () => operation(async () => { message('Checking internet access…'); showResult(await request('finish')); });
  $('connect').onclick = () => operation(async () => {
    if (!selected) return;
    message('Connecting… This can take a couple of minutes.');
    const password = $('password').value; $('password').value = '';
    await request('connect', {bssid: selected.bssid, password});
    leavePassword(); showResult(await request('finish'));
    setBusy(false); $('continue').hidden || $('continue').focus();
  });
  $('back').onclick = leavePassword;
  $('continue').onclick = () => { $('password').value = ''; location.replace('/'); };
  $('updates').onclick = () => { location.replace('/adult/updates'); };
  $('cancel').onclick = () => { $('password').value = ''; location.replace('/'); };
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
  function back() { if (selected) leavePassword(); else if (knownComplete) location.replace('/'); }
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
      if (edge(4) || edge(5)) { shifted=!shifted; keyboard(); $('keyboard').querySelector('button')?.focus(); }
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
  keyboard(); requestAnimationFrame(poll);
  operation(async () => {
    let result = await request('status');
    // A saved connection can already be online at first boot. Persist the
    // verified onboarding result before offering a route to the launcher.
    if (result.internet && !result.complete) result = await request('finish');
    showResult(result);
    setBusy(false);
    if (!result.internet) await scanNetworks(); else $('verify').focus();
    window.CubbyUIReady?.();
  });
})();

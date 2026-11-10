// Run the real adult page script with a scripted host and clock: no host Wi-Fi.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const settle = () => new Promise(resolve => setImmediate(resolve));
const nearby = {ssid: 'Fixture Wi-Fi', bssid: '02:00:00:00:00:01', signal: 90,
  security: 'WPA2', supported: true, connected: false};

function page(scans) {
  const elements = new Map(), calls = [], timers = [];
  let inFlight = 0, maxInFlight = 0;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.dataset = {}; this.hidden = false;
      this.disabled = false; this.classList = {toggle() {}};
    }
    set innerHTML(_) { this.children = [{dataset: {}}]; }
    get firstChild() { return this.children[0]; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    insertAdjacentHTML() {}
    querySelector() { return this.children.find(child => child.tagName === 'button') || null; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    focus() { document.activeElement = this; }
    matches(selector) { return selector === this.tagName; }
  }
  for (const id of ['status', 'simulation', 'title', 'intro', 'password', 'password-panel', 'keyboard', 'networks',
    'rescan', 'verify', 'continue', 'connect', 'back']) {
    elements.set(id, new Element(['rescan', 'verify', 'continue', 'connect', 'back'].includes(id) ? 'button' : 'div'));
  }
  elements.get('continue').hidden = true;
  elements.get('connect').hidden = true;
  const document = {
    activeElement: null, body: new Element(), addEventListener() {},
    getElementById: id => elements.get(id), createElement: tag => new Element(tag),
    querySelector: () => ({content: 'fixture-adult-token'}),
    querySelectorAll: () => [...elements.values(), ...elements.get('networks').children]
      .filter(element => element.tagName === 'button' || element.tagName === 'input')
  };
  const fetch = async (_, options) => {
    const {action} = JSON.parse(options.body);
    calls.push(action); maxInFlight = Math.max(maxInFlight, ++inFlight);
    // Keep each request in flight for a microtask so overlapping calls are visible.
    await Promise.resolve();
    const reply = action === 'scan' ? scans.shift() : {internet: false, complete: false};
    inFlight--;
    if (reply instanceof Error) throw reply;
    if (action === 'scan') assert.notEqual(reply, undefined, 'unexpected extra scan');
    return {ok: !reply?.error, json: async () => action === 'scan' && Array.isArray(reply) ? {networks: reply} : reply};
  };
  vm.runInNewContext(fs.readFileSync('rocknix/adult/network.js', 'utf8'), {
    document, fetch, window: {}, navigator: {}, requestAnimationFrame() {},
    setTimeout(callback, delay) { timers.push({callback, delay}); }
  });
  return {
    elements, calls, timers, maxInFlight: () => maxInFlight,
    status: () => elements.get('status').textContent,
    scanCount: () => calls.filter(action => action === 'scan').length,
    async advance(delay) {
      assert.equal(timers[0]?.delay, delay, 'expected bounded retry delay');
      timers.shift().callback(); await settle();
    }
  };
}

test('an empty startup scan retries while busy, then shows nearby networks without another click', async () => {
  const p = page([[], [nearby]]); await settle();
  assert.equal(p.status(), 'Finding Wi-Fi networks…');
  assert.equal(p.elements.get('rescan').disabled, true);
  p.elements.get('rescan').onclick(); await settle();
  assert.equal(p.scanCount(), 1, 'a repeated action cannot overlap the pending scan');
  await p.advance(1000);
  assert.equal(p.scanCount(), 2);
  assert.equal(p.elements.get('networks').children.length, 1);
  assert.equal(p.status(), 'Choose your Wi-Fi network.');
  assert.equal(p.elements.get('rescan').disabled, false);
  assert.equal(p.maxInFlight(), 1);
  assert.equal(p.timers.length, 0);
});

test('a genuinely empty area stops after three scans and still permits a manual retry', async () => {
  const p = page([[], [], [], [nearby]]); await settle();
  await p.advance(1000);
  assert.equal(p.status(), 'Finding Wi-Fi networks…');
  await p.advance(2000);
  assert.equal(p.scanCount(), 3);
  assert.match(p.status(), /^No networks found\./);
  assert.equal(p.elements.get('rescan').disabled, false);
  assert.equal(p.timers.length, 0);
  p.elements.get('rescan').onclick(); await settle();
  assert.equal(p.scanCount(), 4);
  assert.equal(p.status(), 'Choose your Wi-Fi network.');
  assert.equal(p.maxInFlight(), 1);
});

test('a populated first scan has no retry delay', async () => {
  const p = page([[nearby]]); await settle();
  assert.equal(p.scanCount(), 1);
  assert.equal(p.timers.length, 0);
  assert.equal(p.status(), 'Choose your Wi-Fi network.');
});

for (const failure of [{error: 'unavailable'}, {error: 'connection_failed'}, Error('fetch failed')]) {
  test('scan failure is not retried: ' + (failure.error || failure.message), async () => {
    const p = page([failure]); await settle();
    assert.equal(p.scanCount(), 1);
    assert.equal(p.timers.length, 0);
    assert.equal(p.elements.get('rescan').disabled, false);
    assert.equal(p.elements.get('status').dataset.tone, 'bad');
    assert.doesNotMatch(p.status(), /No networks found/);
  });
}

test('an error during an empty-scan retry ends the operation instead of hiding it as no networks', async () => {
  const p = page([[], {error: 'unavailable'}]); await settle();
  await p.advance(1000);
  assert.equal(p.scanCount(), 2);
  assert.equal(p.timers.length, 0);
  assert.match(p.status(), /^Wi-Fi is not available yet\./);
  assert.equal(p.elements.get('rescan').disabled, false);
});

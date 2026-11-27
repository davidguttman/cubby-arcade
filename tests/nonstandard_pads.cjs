'use strict';
// A pad the browser could not map (mapping '') must work in the hub and in games with
// no calibration: host-osd turns it into a standard pad before anything reads it.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {createCalibration, createDevice, controllerKey} = require('../runtime/core/host-osd.js');
const {createInput} = require('../runtime/core/input.js');
const {install: installShell} = require('../runtime/core/game-shell.js');
const preferencesAPI = require('../runtime/core/preferences.js');
const storageKey = 'cubby:controller-labels:v1';

// The input.js that published games carry (Wonder Patch, Waddle Wars): every axis must
// rest inside the deadzone before it hears a press. Load it as a game page would.
function frozenInput() {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/frozen-input/1aef9c86.js'), 'utf8'), module = {exports: {}};
  vm.runInNewContext(source, {module, require: () => preferencesAPI});
  return module.exports.createInput;
}

function pad(id, mapping, buttons, axes) {
  return {id, index: 0, mapping, connected: true, timestamp: 1, buttons: Array.from({length: buttons}, () => ({pressed: false, touched: false, value: 0})), axes: axes.slice(), rest: axes.slice()};
}
// What browsers report for Xbox-style pads they cannot map.
const layouts = {
  standard: () => pad('Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'standard', 17, [0, 0, 0, 0]),
  // Linux joydev/xpad order (old Firefox, Chrome for drivers it does not know): sticks only.
  flat: () => pad('0e6f-02a7-PDP Wired Controller', '', 11, [0, 0, 0, 0, 0, 0]),
  // Same order with the triggers on axes 2 and 5 resting at -1 and the hat on 6/7.
  triggers: () => pad('24c6-581a-PowerA Xbox Wired Controller', '', 11, [0, 0, -1, 0, 0, -1, 0, 0]),
  // macOS HID: axes by usage, triggers at -1, the hat on one axis resting above 1.
  hat: () => pad('24c6-543a-PowerA Xbox One wired', '', 12, [0, 0, -1, 0, 0, -1, 0, 0, 0, 9 / 7]),
  // macOS 360Controller driver: Start 8, Back 9, d-pad buttons 11-14.
  mac360: () => pad('Xbox 360 Wired Controller', '', 15, [0, 0, -1, 0, 0, -1]),
};
const hatAt = k => -1 + k * 2 / 7;   // 0 up, 2 right, 4 down, 6 left
// For each layout: the raw control a player uses, and the Cubby button it must become.
const presses = {
  standard: [['button', 0, 'a'], ['button', 1, 'b'], ['button', 9, 'start'], ['button', 12, 'up'], ['button', 15, 'right'], ['axis', [0, 1], 'right']],
  flat: [['button', 0, 'a'], ['button', 1, 'b'], ['button', 7, 'start'], ['axis', [0, -1], 'left'], ['axis', [1, 1], 'down']],
  triggers: [['button', 0, 'a'], ['button', 1, 'b'], ['button', 7, 'start'], ['axis', [7, -1], 'up'], ['axis', [7, 1], 'down'], ['axis', [6, -1], 'left'], ['axis', [6, 1], 'right'], ['axis', [1, -1], 'up']],
  hat: [['button', 0, 'a'], ['button', 1, 'b'], ['button', 9, 'start'], ['axis', [9, hatAt(0)], 'up'], ['axis', [9, hatAt(2)], 'right'], ['axis', [9, hatAt(4)], 'down'], ['axis', [9, hatAt(6)], 'left']],
  mac360: [['button', 0, 'a'], ['button', 1, 'b'], ['button', 8, 'start'], ['button', 11, 'up'], ['button', 12, 'down'], ['button', 13, 'left'], ['button', 14, 'right']],
};

function memory(values = {}) { const map = new Map(Object.entries(values)); return {map, getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v)}; }
// The browser pad → calibration → host device, as host-osd installs it.
function hostPipeline(raw, storage = memory()) {
  const calibration = createCalibration(() => [raw], storage), device = createDevice(() => calibration.getGamepads());
  return {calibration, device, storage};
}
const quiet = {get: () => ({keyboard: {}}), subscribe: () => () => {}};
const surface = {addEventListener() {}, removeEventListener() {}};
// The hub reads the host device directly with the current input.js.
function hub(device) {
  let frame, time = 0;const actions = [];
  createInput({target: surface, document: null, preferences: quiet, navigator: {getGamepads: () => device.getGamepads()},
    requestFrame: fn => { frame = fn; return 1; }, cancelFrame() {}, onAction: e => actions.push(e.button)});
  return {actions, run: (ms = 16) => { time += ms; frame(time); }};
}
// A game reads the host device through the game shell, with its own frozen input.js.
function game(device, create = frozenInput()) {
  const frames = {};let time = 0;const actions = [];
  const env = {document: {readyState: 'complete', hidden: false, hasFocus: () => true,
      createElement: () => ({style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, focus() {}, remove() {}}), body: {appendChild() {}}},
    navigator: {getGamepads: () => device.getGamepads()}, location: {pathname: '/games/demo/main.html', href: '', protocol: 'file:'},
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: fn => { frames.shell = fn; return 1; }, cancelAnimationFrame() {},
    dispatchEvent() {}, CustomEvent: class {}, setTimeout: fn => fn()};
  const shell = installShell(env);
  create({target: surface, document: null, preferences: quiet, navigator: env.navigator,
    requestFrame: fn => { frames.game = fn; return 1; }, cancelFrame() {}, onAction: e => actions.push(e.button)});
  return {actions, shell, run: (ms = 16) => { time += ms; frames.shell(time); frames.game(time); }};
}
function act(raw, [kind, which], on) {
  if (kind === 'button') { const b = raw.buttons[which]; b.pressed = on; b.touched = on; b.value = on ? 1 : 0; }
  else raw.axes[which[0]] = on ? which[1] : raw.rest[which[0]];
}
function play(raw, reader, list) {
  for (let i = 0; i < 30; i++) reader.run();
  for (const [kind, which] of list) { act(raw, [kind, which], true); reader.run(); reader.run(); act(raw, [kind, which], false); reader.run(); reader.run(); }
  return reader.actions;
}

for (const [name, make] of Object.entries(layouts)) {
  const expected = presses[name].map(p => p[2]), controls = presses[name].map(p => [p[0], p[1]]);
  test(`${name} pad, uncalibrated: the host shows it first, as a standard pad`, () => {
    const raw = make(), {device} = hostPipeline(raw), first = device.getGamepads().find(Boolean);
    assert.equal(first.id, raw.id, 'the real pad, not the on-screen one');
    assert.equal(first.mapping, 'standard');
    if (name !== 'standard') { assert.equal(first.buttons.length, 17); assert.deepEqual(first.axes, [0, 0, 0, 0], 'resting triggers and hats are not axes'); }
  });
  test(`${name} pad, uncalibrated: the hub hears A, B, Start and every direction`, () => {
    const raw = make(), {device} = hostPipeline(raw);
    assert.deepEqual(play(raw, hub(device), controls), expected);
  });
  test(`${name} pad, uncalibrated: a game's frozen input.js hears them through the game shell`, () => {
    const raw = make(), {device} = hostPipeline(raw);
    assert.deepEqual(play(raw, game(device), controls), expected);
  });
}

test('the standard pad still reaches readers untouched', () => {
  const raw = layouts.standard(), {device, calibration} = hostPipeline(raw);
  assert.equal(calibration.getGamepads()[0], raw);assert.equal(device.getGamepads()[0], raw);
});

test('triggers at -1: calibration arms, captures A, B, X, Y, and the saved faces drive the hub and games', () => {
  const raw = layouts.triggers(), storage = memory(), {calibration} = hostPipeline(raw, storage), steps = [];
  calibration.begin(step => steps.push(step));calibration.getGamepads();
  assert.equal(calibration.state().ready, true, 'the resting triggers are not a held control');
  for (const index of [1, 0, 3, 2]) { raw.buttons.forEach((b, i) => { b.pressed = i === index; }); calibration.getGamepads(); raw.buttons.forEach(b => { b.pressed = false; }); calibration.getGamepads(); }
  assert.equal(steps.at(-1).phase, 'saved');
  assert.deepEqual(JSON.parse(storage.map.get(storageKey)), {[controllerKey(raw)]: [1, 0, 3, 2]});
  calibration.cancel();calibration.getGamepads();assert.equal(calibration.isBlocking(), false, 'draining ends once released, despite the triggers');
  const list = [['button', 1], ['button', 0], ['button', 7], ['axis', [7, -1]]];
  for (const reader of [d => hub(d), d => game(d)]) {
    const fresh = layouts.triggers(), {device} = hostPipeline(fresh, memory({[storageKey]: storage.map.get(storageKey)}));
    assert.deepEqual(play(fresh, reader(device), list), ['a', 'b', 'start', 'up']);
  }
});

test('a calibrated face button is never also Select, Start or a direction', () => {
  const raw = layouts.mac360(), key = controllerKey(raw), {device} = hostPipeline(raw, memory({[storageKey]: JSON.stringify({[key]: [8, 1, 11, 3]})}));
  raw.buttons[8].pressed = true;let first = device.getGamepads()[0];
  assert.equal(first.buttons[0].pressed, true);assert.equal(first.buttons[9].pressed, false);
  raw.buttons[8].pressed = false;raw.buttons[11].pressed = true;first = device.getGamepads()[0];
  assert.equal(first.buttons[2].pressed, true);assert.equal(first.buttons[12].pressed, false);
});

test('a hat that first appears pressed is learned once it rests out of range', () => {
  const raw = layouts.hat(), {device} = hostPipeline(raw);raw.axes[9] = hatAt(0);
  const first = device.getGamepads()[0];assert.equal(first.axes[1], 0);
  raw.axes[9] = 9 / 7;device.getGamepads();raw.axes[9] = hatAt(6);
  assert.equal(device.getGamepads()[0].buttons[14].pressed, true);
});

test('Select + Start on a nonstandard pad opens the game menu', () => {
  const raw = layouts.triggers(), {device} = hostPipeline(raw), g = game(device);
  for (let i = 0; i < 30; i++) g.run();
  raw.buttons[6].pressed = true;raw.buttons[7].pressed = true;g.run();g.run();
  assert.equal(g.shell.isOpen(), true);assert.deepEqual(g.actions, [], 'the chord is not game input');
});

test('neutral ignores extra axes resting at -1 in the hub, the shell and the frozen game', () => {
  // A standard pad that appends trigger axes after the sticks.
  const raw = pad('Extra axes', 'standard', 17, [0, 0, 0, 0, -1, -1]), {device} = hostPipeline(raw);
  assert.deepEqual(play(raw, hub(device), [['button', 0]]), ['a']);
  // The frozen game reads its own all-axes rule; through the host it sees only four axes
  // when the pad is nonstandard. For a standard pad the shell must at least not mask it.
  const g = game(device, (options) => createInput(options));
  assert.deepEqual(play(raw, g, [['button', 0]]), ['a']);
});

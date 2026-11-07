'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createInput} = require('../runtime/core/input.js');
const {install} = require('../runtime/core/game-shell.js');

function harness() {
  let frame = null, time = 0, pads = [];
  const actions = [];
  const preferences = {get: () => ({keyboard: {}}), subscribe: () => () => {}};
  const target = {addEventListener() {}, removeEventListener() {}};
  createInput({target, document: null, preferences, navigator: {getGamepads: () => pads},
    requestFrame: fn => { frame = fn; return 1; }, cancelFrame() {},
    onAction: event => actions.push(event.button)});
  return {
    actions,
    pad(pressed = []) { const buttons = Array.from({length: 16}, (_, i) => ({pressed: pressed.includes(i)})); pads = [{index: 0, id: 'pad', buttons, axes: [0, 0]}]; },
    hide() { pads = []; },
    run(ms) { time += ms; frame(time); },
  };
}

test('the press that reveals a hidden pad is delivered', () => {
  const h = harness();
  h.hide(); h.run(16); h.run(1000);
  h.pad([0]); h.run(16);
  assert.deepEqual(h.actions, ['a']);
  h.run(16);
  assert.deepEqual(h.actions, ['a'], 'one press, no repeat');
  h.pad(); h.run(16); h.pad([0]); h.run(16);
  assert.deepEqual(h.actions, ['a', 'a'], 'later presses still work');
});

test('a button held through navigation does not fire on a pad visible from the start', () => {
  const h = harness();
  h.pad([0]); h.run(16); h.run(1000);
  assert.deepEqual(h.actions, []);
  h.pad(); h.run(16); h.pad([0]); h.run(16);
  assert.deepEqual(h.actions, ['a'], 'accepted after release');
});

test('a button held through navigation does not fire when the pad appears right after load', () => {
  const h = harness();
  h.hide(); h.run(16); h.run(100);
  h.pad([0]); h.run(16); h.run(1000);
  assert.deepEqual(h.actions, []);
});

test('a pad revealed neutral accepts the next press', () => {
  const h = harness();
  h.hide(); h.run(16); h.run(1000);
  h.pad(); h.run(16); h.pad([1]); h.run(16);
  assert.deepEqual(h.actions, ['b']);
});

// Game pages read pads through the shell, and either poll can run first in a frame.
// revealMs Infinity behaves like the frozen input.js that published games carry.
for (const heldFromLastPage of [false, true]) for (const virtual of [true, false]) for (const frozen of [true, false]) for (const shellFirst of [true, false]) test(`a ${frozen ? 'frozen' : 'current'} input.js ${heldFromLastPage ? 'ignores a held button' : 'hears the revealing press'} through the shell (${virtual ? 'on-screen pad' : 'no pad'} before it, shell polls ${shellFirst ? 'first' : 'second'})`, () => {
  let pads = [];
  const frames = {};
  const env = {document: {readyState: 'complete', hidden: false, hasFocus: () => true,
      createElement: () => ({style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, focus() {}, remove() {}}), body: {appendChild() {}}},
    navigator: {getGamepads: () => pads}, location: {pathname: '/games/demo/main.html', href: ''},
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: fn => { frames.shell = fn; return 1; }, cancelAnimationFrame() {},
    dispatchEvent() {}, CustomEvent: class {}, setTimeout: fn => fn()};
  const shell = install(env);
  // This matrix exercises gameplay polling after the player explicitly chose Play.
  // Initial-menu suspension and confirmation are covered in game_shell.cjs.
  shell.resume();
  const actions = [];
  createInput({target: {addEventListener() {}, removeEventListener() {}}, document: null,
    preferences: {get: () => ({keyboard: {}}), subscribe: () => () => {}}, navigator: env.navigator,
    requestFrame: fn => { frames.input = fn; return 1; }, cancelFrame() {}, revealMs: frozen ? Infinity : undefined, onAction: event => actions.push(event.button)});
  let time = 0;
  const run = ms => { time += ms; const order = shellFirst ? ['shell', 'input'] : ['input', 'shell']; order.forEach(name => frames[name](time)); };
  // Before any input, game pages read the on-screen pad rather than none.
  if (virtual) pads = [{index: 0, id: 'Cubby virtual controller', buttons: Array.from({length: 16}, () => ({pressed: false})), axes: [0, 0]}];
  const real = pressed => [{index: 0, id: 'pad', buttons: Array.from({length: 16}, (_, i) => ({pressed: pressed && i === 0})), axes: [0, 0]}];
  run(16); run(heldFromLastPage ? 100 : 1000);
  pads = real(true);
  run(16); run(16); run(16);
  assert.deepEqual(actions, heldFromLastPage ? [] : ['a']);
  pads = real(false); run(16); run(16);
  pads = real(true); run(16); run(16); run(16);
  assert.deepEqual(actions, heldFromLastPage ? ['a'] : ['a', 'a'], 'the next press after release always counts');
});

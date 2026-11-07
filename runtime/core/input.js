/* Shared input for browsers and WPE. No platform or game dependencies. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./preferences.js') : root.HandheldPreferences);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (preferencesAPI) {
  'use strict';
  const buttons = {0:'a', 1:'b', 2:'x', 3:'y', 8:'select', 9:'start', 12:'up', 13:'down', 14:'left', 15:'right'};
  const directions = new Set(['up', 'down', 'left', 'right']);
  const semantic = {a:'confirm', b:'back', start:'pause'};
  function createInput(options) {
    options = options || {};
    const target = options.target || window;
    const doc = options.document || target.document;
    let focused = !doc || !doc.hasFocus || doc.hasFocus();
    const active = () => focused && !(doc && doc.hidden);
    const navigator = options.navigator || globalThis.navigator || {};
    const requestFrame = options.requestFrame || requestAnimationFrame;
    const cancelFrame = options.cancelFrame || cancelAnimationFrame;
    const deadzone = options.deadzone === undefined ? 0.5 : options.deadzone;
    // Games get each button going down and coming up, and repeat a held direction themselves.
    // Repeated presses are for moving through menus: only the hub asks for them.
    const repeat = !!options.repeat, repeatMs = options.repeatMs || 180;
    // Browsers hide a pad from a new page until it sees input, so the press that
    // reveals the pad is a real press. A pad seen sooner than this after the page
    // starts polling may be a button still held from the previous page.
    const revealMs = options.revealMs === undefined ? 250 : options.revealMs;
    const preferences = options.preferences || preferencesAPI.preferences;
    let keys = {}, capture = null, liftKeyboard = null;
    const heldKeys = new Set(), blockedKeys = new Set(), cleanup = [];
    function updateKeyboard(value) {
      if (typeof liftKeyboard === 'function') liftKeyboard();
      heldKeys.forEach(code => blockedKeys.add(code));
      heldKeys.clear(); keys = {};
      Object.entries(value.keyboard).forEach(([button, codes]) => codes.forEach(code => keys[code] = button));
    }
    updateKeyboard(preferences.get());
    cleanup.push(preferences.subscribe(updateKeyboard));
    let shouldersBlocked = false;
    let last = new Set(), repeated = {}, ready = false, identity = null, hiddenSince = null, frameId, disposed = false;
    function emit(button, source) {
      if (disposed || capture || !active() || !options.onAction) return false;
      options.onAction({action:semantic[button] || button, button, source});
      return true;
    }
    // Which sources hold each button that was reported down, so it comes up exactly once, when the last one lets go.
    const down = new Map();
    function press(button, source, holder) {
      if (!emit(button, source)) return;
      if (!down.has(button)) down.set(button, new Map());
      down.get(button).set(holder || source, source);
    }
    function lift(button, holder) {
      const holders = down.get(button);
      if (!holders || !holders.has(holder)) return;
      const source = holders.get(holder);
      holders.delete(holder);
      if (holders.size) return;
      down.delete(button);
      if (options.onRelease) options.onRelease({action:semantic[button] || button, button, source});
    }
    function liftAll() { Array.from(down.entries()).forEach(([button, holders]) => Array.from(holders.keys()).forEach(holder => lift(button, holder))); }
    const pressedKeys = new Map();   // the button each key went down as: a remap mustn't change which button it lifts
    function listen(element, name, fn) {
      element.addEventListener(name, fn);
      cleanup.push(() => element.removeEventListener(name, fn));
    }
    listen(target, 'keydown', e => {
      if (capture) {
        e.preventDefault(); blockedKeys.add(e.code);
        if (!e.repeat && active() && preferencesAPI.isKeyboardCode(e.code)) capture(e.code);
        return;
      }
      const button = keys[e.code];
      if (!button) return;
      e.preventDefault();
      // A genuine new press proves release even when its keyup happened off-window.
      // Keep repeats blocked until that press or an observed keyup arrives.
      if (!e.repeat) blockedKeys.delete(e.code);
      if (blockedKeys.has(e.code) || (e.repeat && !heldKeys.has(e.code))) return;
      // A repeated keydown can arrive on a new page after navigation.
      if (!heldKeys.has(e.code) && !e.repeat) { press(button, 'keyboard', e.code); pressedKeys.set(e.code, button); }
      else if (repeat && heldKeys.has(e.code) && e.repeat && directions.has(button)) emit(button, 'keyboard');
      heldKeys.add(e.code);
    });
    listen(target, 'keyup', e => {
      heldKeys.delete(e.code); blockedKeys.delete(e.code);
      if (pressedKeys.has(e.code)) { lift(pressedKeys.get(e.code), e.code); pressedKeys.delete(e.code); }
    });
    liftKeyboard = () => { pressedKeys.forEach((button, code) => lift(button, code)); pressedKeys.clear(); };
    function reset() { liftAll(); pressedKeys.clear(); heldKeys.clear(); last.clear(); repeated = {}; ready = false; identity = null; hiddenSince = null; }
    listen(target, 'blur', () => { focused = false; reset(); });
    listen(target, 'focus', () => { focused = true; reset(); });
    if (doc) listen(doc, 'visibilitychange', reset);
    function poll(time) {
      if (disposed) return;
      if (!active()) { reset(); frameId = requestFrame(poll); return; }
      const pad = navigator.getGamepads && Array.from(navigator.getGamepads()).find(Boolean);
      if (!pad) { ready = false; identity = null; last.clear(); repeated = {}; if (hiddenSince === null) hiddenSince = time; }
      else {
        const id = pad.index + ':' + pad.id;
        if (identity !== id) { identity = id; ready = hiddenSince !== null && time - hiddenSince >= revealMs; last.clear(); repeated = {}; }
        hiddenSince = null;
        const down = pad.buttons.map(b => b.pressed);
        const axes = pad.axes || [];
        const neutral = !down.some(Boolean) && axes.every(a => Math.abs(a) < deadzone);
        const current = new Set();
        Object.keys(buttons).forEach(i => { if (down[i]) current.add(buttons[i]); });
        if (axes[0] < -deadzone) current.add('left');
        if (axes[0] > deadzone) current.add('right');
        if (axes[1] < -deadzone) current.add('up');
        if (axes[1] > deadzone) current.add('down');
        if (!down[4] && !down[5]) shouldersBlocked = false;
        if (!shouldersBlocked) {
          if (down[4]) current.add(options.navigationShoulders ? 'previousView' : 'l');
          if (down[5]) current.add(options.navigationShoulders ? 'nextView' : 'r');
        }
        if (down[4] && down[5]) { shouldersBlocked = true; current.clear(); current.add('exit'); }
        if (!ready) ready = neutral;
        else current.forEach(button => {
          if (!last.has(button)) { press(button, 'gamepad'); repeated[button] = time; }
          else if (repeat && directions.has(button) && time - (repeated[button] || 0) >= repeatMs) { emit(button, 'gamepad'); repeated[button] = time; }
        });
        last.forEach(button => { if (!current.has(button)) lift(button, 'gamepad'); });
        last = current;
      }
      frameId = requestFrame(poll);
    }
    frameId = requestFrame(poll);
    return {
      preferences,
      captureKeyboard(onCode) {
        if (disposed || capture || typeof onCode !== 'function') throw Error('Keyboard capture unavailable');
        capture = onCode;
        heldKeys.forEach(code => blockedKeys.add(code)); reset();
        return () => { if (capture === onCode) { capture = null; reset(); } };
      },
      attachPointer(element, chooseButton) {
        const pointers = new Map();
        listen(element, 'pointerdown', e => {
          e.preventDefault();
          const button = chooseButton ? chooseButton(e) : 'a', holder = 'pointer:' + e.pointerId;
          press(button, 'pointer', holder); pointers.set(holder, button);
        });
        const up = e => { const holder = 'pointer:' + e.pointerId; if (pointers.has(holder)) { lift(pointers.get(holder), holder); pointers.delete(holder); } };
        listen(target, 'pointerup', up); listen(target, 'pointercancel', up);
      },
      dispose() {
        if (disposed) return;
        disposed = true; capture = null; cancelFrame(frameId); cleanup.forEach(fn => fn()); reset();
      }
    };
  }
  return {createInput};
});

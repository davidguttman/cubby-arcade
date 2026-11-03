/* Shared input for browsers and WPE. No platform or game dependencies. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./preferences.js') : root.HandheldPreferences);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldInput = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (preferencesAPI) {
  'use strict';
  const buttons = {0:'a', 1:'b', 8:'select', 9:'start', 12:'up', 13:'down', 14:'left', 15:'right'};
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
    const repeatMs = options.repeatMs || 180;
    const preferences = options.preferences || preferencesAPI.preferences;
    let keys = {}, capture = null;
    const heldKeys = new Set(), blockedKeys = new Set(), cleanup = [];
    function updateKeyboard(value) {
      heldKeys.forEach(code => blockedKeys.add(code));
      heldKeys.clear(); keys = {};
      Object.entries(value.keyboard).forEach(([button, codes]) => codes.forEach(code => keys[code] = button));
    }
    updateKeyboard(preferences.get());
    cleanup.push(preferences.subscribe(updateKeyboard));
    let shouldersBlocked = false;
    let last = new Set(), repeated = {}, ready = false, identity = null, frameId, disposed = false;
    function emit(button, source) {
      if (!disposed && !capture && active() && options.onAction) options.onAction({action:semantic[button] || button, button, source});
    }
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
      if ((!heldKeys.has(e.code) && !e.repeat) || (heldKeys.has(e.code) && e.repeat && directions.has(button))) emit(button, 'keyboard');
      heldKeys.add(e.code);
    });
    listen(target, 'keyup', e => { heldKeys.delete(e.code); blockedKeys.delete(e.code); });
    function reset() { heldKeys.clear(); last.clear(); repeated = {}; ready = false; identity = null; }
    listen(target, 'blur', () => { focused = false; reset(); });
    listen(target, 'focus', () => { focused = true; reset(); });
    if (doc) listen(doc, 'visibilitychange', reset);
    function poll(time) {
      if (disposed) return;
      if (!active()) { reset(); frameId = requestFrame(poll); return; }
      const pad = navigator.getGamepads && Array.from(navigator.getGamepads()).find(Boolean);
      if (!pad) { ready = false; identity = null; last.clear(); repeated = {}; }
      else {
        const id = pad.index + ':' + pad.id;
        if (identity !== id) { identity = id; ready = false; last.clear(); repeated = {}; }
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
        if (options.navigationShoulders && !shouldersBlocked) {
          if (down[4]) current.add('previousView');
          if (down[5]) current.add('nextView');
        }
        if (down[4] && down[5]) { shouldersBlocked = true; current.clear(); current.add('exit'); }
        if (!ready) ready = neutral;
        else current.forEach(button => {
          if (!last.has(button) || (directions.has(button) && time - (repeated[button] || 0) >= repeatMs)) {
            emit(button, 'gamepad'); repeated[button] = time;
          }
        });
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
        listen(element, 'pointerdown', e => { e.preventDefault(); emit(chooseButton ? chooseButton(e) : 'a', 'pointer'); });
      },
      dispose() {
        if (disposed) return;
        disposed = true; capture = null; cancelFrame(frameId); cleanup.forEach(fn => fn()); reset();
      }
    };
  }
  return {createInput};
});

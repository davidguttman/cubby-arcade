/* Host-local options shared by launcher and packaged games at the same origin. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldPreferences = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const STORAGE_KEY = 'handheld:preferences:v1';
  const DEFAULT_KEYBOARD = Object.freeze({up:Object.freeze(['ArrowUp']), down:Object.freeze(['ArrowDown']),
    left:Object.freeze(['ArrowLeft']), right:Object.freeze(['ArrowRight']), a:Object.freeze(['KeyZ','Space']),
    b:Object.freeze(['KeyX']), start:Object.freeze(['Enter','KeyP']), select:Object.freeze(['KeyM','ShiftRight']), exit:Object.freeze(['Escape'])});
  const BUTTONS = Object.freeze(Object.keys(DEFAULT_KEYBOARD));
  // Physical KeyboardEvent.code names, not locale-dependent labels or arbitrary text.
  function isKeyboardCode(code) {
    return typeof code === 'string' && /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal|Comma|ParenLeft|ParenRight|Backspace|Clear|ClearEntry|Hash|Star)|Arrow(?:Up|Down|Left|Right)|(?:Shift|Control|Alt|Meta)(?:Left|Right)|Backspace|Tab|Enter|Space|Escape|Insert|Delete|Home|End|PageUp|PageDown|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|ContextMenu|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen|Convert|NonConvert|KanaMode|Lang[1-5])$/.test(code);
  }
  const copy = value => JSON.parse(JSON.stringify(value));
  function validateKeyboard(keyboard) {
    if (!keyboard || typeof keyboard !== 'object' || Array.isArray(keyboard) || Object.keys(keyboard).length !== BUTTONS.length) throw Error('Map every logical button');
    const seen = new Set();
    for (const button of BUTTONS) {
      const codes = keyboard[button];
      if (!Array.isArray(codes) || !codes.length || codes.length > 16) throw Error('Each button needs 1–16 keys');
      for (const code of codes) {
        if (!isKeyboardCode(code)) throw Error('Invalid keyboard code');
        if (seen.has(code)) throw Error('A key can map to only one button');
        seen.add(code);
      }
    }
    return copy(keyboard);
  }
  function validate(value) {
    if (!value || !['auto','on','off'].includes(value.touchOverlay)) throw Error('Invalid touch overlay mode');
    return {touchOverlay:value.touchOverlay, keyboard:validateKeyboard(value.keyboard)};
  }
  function createPreferences(options) {
    options = options || {};
    const target = options.target || root;
    let storage = options.storage;
    if (storage === undefined) { try { storage = root.localStorage; } catch (_) {} }
    // Device-host policy is supplied before this module executes. A touchscreen
    // on a physical handheld is not a request to reserve a virtual button deck.
    // Saved adult choices still win, including an explicit "auto" choice.
    const defaults = () => ({touchOverlay:root.CubbyDeviceProfile === 'rg353v' ? 'off' : 'auto', keyboard:copy(DEFAULT_KEYBOARD)});
    const listeners = new Set();
    function decode(raw) { try { return raw === null ? defaults() : validate(JSON.parse(raw)); } catch (_) { return defaults(); } }
    let value;
    try { value = decode(storage ? storage.getItem(STORAGE_KEY) : null); } catch (_) { value = defaults(); }
    function notify() { listeners.forEach(fn => fn(copy(value))); }
    const onStorage = event => {
      if ((event.key === STORAGE_KEY || event.key === null) && (!event.storageArea || event.storageArea === storage)) {
        value = decode(event.key === null ? null : event.newValue); notify();
      }
    };
    if (target.addEventListener) target.addEventListener('storage', onStorage);
    const api = {
      get:() => copy(value),
      set(patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['touchOverlay','keyboard'].includes(key))) throw Error('Invalid preferences');
        const next = validate({...value, ...patch});
        // Private browsing/storage denial must not disable controls for this session.
        try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (_) {}
        value = next; notify(); return copy(value);
      },
      reset() { return api.set(defaults()); },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      showTouchControls(environment) {
        if (value.touchOverlay !== 'auto') return value.touchOverlay === 'on';
        environment = environment || root;
        const nav = environment.navigator || {};
        return Number(nav.maxTouchPoints) > 0 || !!(environment.matchMedia && environment.matchMedia('(any-pointer: coarse)').matches);
      },
      editKeyboard() {
        let draft = copy(value.keyboard), closed = false;
        function open() { if (closed) throw Error('Keyboard edit is closed'); }
        return {
          get() { open(); return copy(draft); },
          setBinding(button, codes) { open(); if (!BUTTONS.includes(button)) throw Error('Invalid logical button'); draft = validateKeyboard({...draft, [button]:codes}); return copy(draft); },
          set(keyboard) { open(); draft = validateKeyboard(keyboard); return copy(draft); },
          reset() { open(); draft = copy(DEFAULT_KEYBOARD); return copy(draft); },
          apply() { open(); const result = api.set({keyboard:draft}); closed = true; return result; },
          cancel() { closed = true; }
        };
      },
      dispose() { listeners.clear(); if (target.removeEventListener) target.removeEventListener('storage', onStorage); }
    };
    return api;
  }
  return {STORAGE_KEY, DEFAULT_KEYBOARD, BUTTONS, isKeyboardCode, validateKeyboard, createPreferences, preferences:createPreferences()};
});

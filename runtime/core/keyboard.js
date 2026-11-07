/* Cubby's on-screen keyboard: text entry with only a controller, for adult pages.
 * One keyboard for every page that takes text on the handheld (the Wi-Fi password,
 * a player's name). It types into a text field; the page moves focus between keys. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldKeyboard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const BACKSPACE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h12v14H9l-6-7ZM12 9.5l5 5M17 9.5l-5 5"/></svg>';
  // Picture keys for layouts with no words: a shift arrow (filled while on) and a space bar.
  const SHIFT = on => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 12h5v8h8v-8h5Z"' + (on ? ' fill="currentColor"' : '') + '/></svg>';
  const SPACE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v5h18v-5"/></svg>';
  // Eleven columns. A row is a string of keys, then extra keys that don't fit a string.
  const LAYOUTS = {
    password: [
      [['1234567890', '!@#$%^&*()'], 'backspace'],
      [['qwertyuiop', 'QWERTYUIOP'], '-'],
      [['asdfghjkl', 'ASDFGHJKL'], ';', "'"],
      [['zxcvbnm', 'ZXCVBNM'], ',', '.', '/', '?'],
      [['', ''], '_', '=', '+', '[', ']', '{', '}', ':', '"', '\\', '|'],
      [['', ''], 'case', 'space', '`', '~', '<', '>']
    ],
    // Names, ten columns: letters, the few marks names use, no symbols to wade through.
    name: [
      [['qwertyuiop', 'QWERTYUIOP']],
      [['asdfghjkl', 'ASDFGHJKL'], 'backspace'],
      [['', ''], 'shift', ...'zxcvbnm', '-'],
      [['', ''], "'", '.', 'spacebar']
    ]
  };
  // field: an <input>. Typing respects its maxLength and fires an input event.
  function create(options) {
    const container = options.container, doc = container.ownerDocument, field = options.field;
    const layout = LAYOUTS[options.layout || 'password'];
    if (!layout) throw Error('Unknown keyboard layout');
    // A name starts with a capital: the keys show capitals until the first letter.
    let shifted = !!options.capitalizeFirst && !field.value, manual = false;
    container.classList.add('cubby-keyboard');
    container.dataset.layout = options.layout || 'password';
    function changed() {
      if (options.capitalizeFirst && !manual) { const want = !field.value; if (want !== shifted) { shifted = want; keep(render); } }
      field.dispatchEvent?.(new (doc.defaultView?.Event || Event)('input', {bubbles: true}));
    }
    function type(char) {
      const limit = field.maxLength > 0 ? field.maxLength : Infinity;
      if ([...field.value].length >= limit) return;
      field.value += char; changed();
    }
    function backspace() { field.value = [...field.value].slice(0, -1).join(''); changed(); }
    function key(label, onPress, className) {
      const button = doc.createElement('button');
      button.type = 'button'; button.textContent = label;
      if (className) button.className = className;
      button.addEventListener('click', onPress);
      container.appendChild(button);
      return button;
    }
    function special(name) {
      if (name === 'backspace') { const b = key('', backspace, 'backspace'); b.innerHTML = BACKSPACE; b.setAttribute('aria-label', 'Backspace'); return; }
      if (name === 'case') { key(shifted ? 'abc' : 'ABC', toggleCase, 'case'); return; }
      if (name === 'space') { key('Space', () => type(' '), 'space'); return; }
      if (name === 'shift') { const b = key('', toggleCase, 'case'); b.innerHTML = SHIFT(shifted); b.setAttribute('aria-label', 'Shift'); b.setAttribute('aria-pressed', String(shifted)); return; }
      if (name === 'spacebar') { const b = key('', () => type(' '), 'space'); b.innerHTML = SPACE; b.setAttribute('aria-label', 'Space'); return; }
      const char = shifted ? name.toUpperCase() : name;
      key(char, () => type(char));
    }
    function render() {
      container.replaceChildren();
      for (const [strings, ...extra] of layout) {
        for (const char of strings[shifted ? 1 : 0]) key(char, () => type(char));
        extra.forEach(special);
      }
    }
    // Re-rendering keeps focus on the same key position, so the controller stays put.
    function keep(fn) {
      const keys = [...container.children], index = keys.indexOf(doc.activeElement);
      fn();
      if (index >= 0) container.children[Math.min(index, container.children.length - 1)]?.focus();
    }
    function toggleCase() { manual = true; shifted = !shifted; keep(render); }
    render();
    return {toggleCase, type, backspace, focus: () => container.querySelector('button')?.focus(), get shifted() { return shifted; }};
  }
  return {create, LAYOUTS};
});

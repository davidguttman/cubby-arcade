/* Small game lifecycle/input bridge; games keep ownership of their content. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./input.js') : root.HandheldInput);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldSDK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inputAPI) {
  'use strict';
  function createGameHost(options) {
    let game = null, disposed = false, suspended = false;
    const target = options.target || globalThis;
    const document = options.document || globalThis.document;
    function pause() { if (!disposed && game && !suspended) { suspended = true; game.stop(); } }
    function resume() { if (!disposed && game && suspended && !(document && document.hidden)) { suspended = false; if (game.start) game.start(); game.wake(); } }
    function visibility() { if (document.hidden) pause(); else resume(); }
    if (target.addEventListener) { target.addEventListener('blur', pause); target.addEventListener('focus', resume); }
    if (document && document.addEventListener) document.addEventListener('visibilitychange', visibility);
    const input = (options.inputFactory || inputAPI.createInput)({target, document, preferences:options.preferences, onAction(event) {
      if (event.action === 'exit') { if (options.onExit) options.onExit(); }
      else if (game) game.press(event.button);
    }});
    return {
      input,
      saves: options.platform.saves(options.gameId, options.legacySaveKeys),
      pause, resume,
      start(instance) { if (disposed) throw Error('Game host disposed'); if (game) game.stop(); game = instance; suspended = false; game.wake(); },
      dispose() { if (disposed) return; disposed = true; input.dispose(); if (target.removeEventListener) { target.removeEventListener('blur', pause); target.removeEventListener('focus', resume); } if (document && document.removeEventListener) document.removeEventListener('visibilitychange', visibility); if (game) game.stop(); game = null; }
    };
  }
  return {createGameHost};
});

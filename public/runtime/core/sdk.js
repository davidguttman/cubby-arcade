/* Small game lifecycle/input bridge; games keep ownership of their content. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./input.js') : root.HandheldInput);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldSDK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inputAPI) {
  'use strict';
  function createGameHost(options) {
    const target = options.target || globalThis;
    let game = null, disposed = false, suspended = false, systemMenu = !!target.HandheldGameShell?.isOpen();
    const document = options.document || globalThis.document;
    function pause() { if (!disposed && game && !suspended) { suspended = true; game.stop(); } }
    function resume() { if (!disposed && game && suspended && !systemMenu && !(document && document.hidden)) { suspended = false; if (game.start) game.start(); game.wake(); } }
    function systemMenuChanged(event) { systemMenu = !!event.detail.open; if (systemMenu) pause(); else resume(); }
    if (target.addEventListener) target.addEventListener('handheld:system-menu', systemMenuChanged);
    function visibility() { if (document.hidden) pause(); else resume(); }
    if (target.addEventListener) { target.addEventListener('blur', pause); target.addEventListener('focus', resume); }
    if (document && document.addEventListener) document.addEventListener('visibilitychange', visibility);
    const input = (options.inputFactory || inputAPI.createInput)({target, document, preferences:options.preferences, onAction(event) {
      if (event.action === 'exit') { if (target.HandheldGameShell) target.HandheldGameShell.open(); else if (options.onExit) options.onExit(); }
      else if (game && !suspended) game.press(event.button);
    }});
    return {
      input,
      saves: options.platform.saves(options.gameId, options.legacySaveKeys),
      pause, resume,
      start(instance) { if (disposed) throw Error('Game host disposed'); if (game) game.stop(); game = instance; suspended = false; if (systemMenu) pause(); else game.wake(); },
      dispose() { if (disposed) return; disposed = true; input.dispose(); if (target.removeEventListener) { target.removeEventListener('handheld:system-menu', systemMenuChanged); target.removeEventListener('blur', pause); target.removeEventListener('focus', resume); } if (document && document.removeEventListener) document.removeEventListener('visibilitychange', visibility); if (game) game.stop(); game = null; }
    };
  }
  return {createGameHost};
});

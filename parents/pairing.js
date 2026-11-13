/* Runs before link.js. A scanned code arrives in the address after '#', which is
 * never sent to a server; take it out of the address bar and history at once. */
(function (win) {
  'use strict';
  const params = new URLSearchParams(win.location.hash.slice(1)), code = params.get('pair'), relay = params.get('relay');
  const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
  try { if (relay && /^https:\/\/[a-z0-9.-]+(:\d+)?$|^http:\/\/127\.0\.0\.1:\d+$/.test(relay)) win.localStorage.setItem('cubby:parent-link:relay', relay); } catch (_) {}
  if (code) win.history.replaceState(null, '', win.location.pathname + win.location.search);
  // Home Screen apps cannot always receive camera links from Safari. Paste a
  // trusted Cubby link instead; never navigate to a pasted arbitrary URL.
  win.CubbyParsePairingLink = function (text) {
    const url = new URL(String(text).trim());
    const allowed = [win.location.origin, 'https://cubbyarcade.com', 'https://cubby.david.app'];
    if (!allowed.includes(url.origin) || url.username || url.password || url.pathname !== '/parents/' || url.search) throw Error('Not a Cubby pairing link');
    const values = new URLSearchParams(url.hash.slice(1)), pair = values.get('pair'), via = values.get('relay');
    if (!pair || !/^[A-Za-z0-9_-]{22}$/.test(pair) || !win.CubbyLinkAPI.validCode(pair)) throw Error('Invalid pairing code');
    if (via && !/^https:\/\/[a-z0-9.-]+(:\d+)?$|^http:\/\/127\.0\.0\.1:\d+$/.test(via)) throw Error('Invalid relay');
    return {code: pair, relay: via};
  };
  win.CubbyPairingCode = code || null;
  let own = null; try { own = win.localStorage.getItem('cubby:parent-link:name'); } catch (_) {}
  win.CubbyLinkOptions = {role: 'parent', name: own || name};   // link.js reads the stored name too, for game pages
})(window);

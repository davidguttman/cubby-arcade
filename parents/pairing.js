/* Runs before link.js. A scanned code arrives in the address after '#', which is
 * never sent to a server; take it out of the address bar and history at once. */
(function (win) {
  'use strict';
  const params = new URLSearchParams(win.location.hash.slice(1)), code = params.get('pair'), relay = params.get('relay');
  const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
  try { if (relay && /^https:\/\/[a-z0-9.-]+(:\d+)?$|^http:\/\/127\.0\.0\.1:\d+$/.test(relay)) win.localStorage.setItem('cubby:parent-link:relay', relay); } catch (_) {}
  if (code) win.history.replaceState(null, '', win.location.pathname + win.location.search);
  win.CubbyPairingCode = code || null;
  win.CubbyLinkOptions = {role: 'parent', name};
})(window);

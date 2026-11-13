/* Installation belongs to this adult companion, not the wordless game hub. */
(function (win) {
  'use strict';
  const doc = win.document, nav = win.navigator;
  const card = doc.getElementById('install-card'), button = doc.getElementById('install-button');
  const help = doc.getElementById('install-help'), offline = doc.getElementById('offline-note');
  const display = win.matchMedia('(display-mode: standalone)');
  let prompt = null, installedHere = false;
  const installed = () => installedHere || display.matches || nav.standalone === true;
  function render() {
    offline.hidden = nav.onLine !== false;
    card.hidden = installed() || !win.isSecureContext;
    button.hidden = !prompt || installed();
    const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
    help.hidden = !!prompt;
    help.textContent = ios ? 'In Safari, tap Share, then Add to Home Screen and Open as Web App (if shown). If you’re in another browser, open this page in Safari first.' : 'In your browser menu, choose Install app or Add to Home Screen. If that option is missing, try Chrome, Edge, or Safari.';
  }
  win.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt = event; render(); });
  win.addEventListener('appinstalled', () => { installedHere = true; prompt = null; render(); });
  win.addEventListener('online', render); win.addEventListener('offline', render);
  display.addEventListener?.('change', render);
  button.addEventListener('click', async () => {
    if (!prompt) return;
    const current = prompt; prompt = null; button.disabled = true;
    try { await current.prompt(); await current.userChoice; } catch (_) { /* Browser menu remains available. */ }
    finally { button.disabled = false; render(); }
  });
  render();
  if (win.isSecureContext && nav.serviceWorker) {
    win.addEventListener('load', () => {
      nav.serviceWorker.register('worker.js', {scope: '/parents/', updateViaCache: 'none'}).catch(() => {
        // Browsing/pairing still works when offline storage is unavailable.
        help.hidden = false;
        help.textContent = 'Offline setup isn’t available right now. You can still use Cubby in this browser while connected.';
      });
    });
  }
})(window);

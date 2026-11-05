/* The local WPE host supplies installs; browser service workers are not used. */
(function (win) {
  'use strict';
  async function request(path, body) {
    const options = body === undefined ? {} : {method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Cubby-Session': win.CubbyDeviceToken},
      body: JSON.stringify(body)};
    const response = await win.fetch(path, options);
    if (!response.ok) throw Error('Local package operation failed');
    return response.json();
  }
  const listeners = new Set();
  let timer;
  async function status() {
    const states = await request('/api/status');
    listeners.forEach(fn => fn(states));
    return states;
  }
  const bridge = {
    library: () => request('/api/library'),
    catalog: () => request('/api/catalog'),
    installStatus: status,
    async install(id) {
      await request('/api/install', {id});
      for (;;) {
        const states = await status();
        if (states[id]?.phase === 'installed') return;
        if (states[id]?.phase === 'error') throw Error('Install failed');
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    },
    uninstall: id => request('/api/uninstall', {id}),
    onInstallState(fn) {
      listeners.add(fn);
      if (!timer) timer = setInterval(() => status().catch(() => {}), 800);
      return () => {listeners.delete(fn); if (!listeners.size) {clearInterval(timer); timer = null;}};
    }
  };
  // The hub's gear tab is the only settings screen. Its picture tiles ask an adult
  // math question, then open the worded pages kept out of the wordless child hub.
  win.HandheldPlatformOptions = {kind: 'kiosk', bridge, settings: [
    {icon: 'wifi', label: 'Wi-Fi settings', href: '/adult/network'},
    {icon: 'update', label: 'Cubby updates', href: '/adult/updates'}
  ]};
  // Controller shortcut to the gear tab, where the tiles still ask the question:
  // hold L+R+Start for two seconds.
  win.addEventListener('DOMContentLoaded', () => {
    let held = 0, fired = false;
    function adultShortcut(now) {
      const pad = [...(navigator.getGamepads?.() || [])].find(p => p?.connected);
      if (pad?.buttons[4]?.pressed && pad?.buttons[5]?.pressed && pad?.buttons[9]?.pressed) {
        if (!held) held = now;
        if (now-held > 2000 && !fired) { fired = true; win.location.hash = 'options'; }
      } else { held = 0; fired = false; }
      requestAnimationFrame(adultShortcut);
    }
    requestAnimationFrame(adultShortcut);
  });
})(window);

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
        // Pending is verified and waiting for the hub: it switches on the next hub entry.
        if (['installed', 'pending'].includes(states[id]?.phase)) return;
        if (states[id]?.phase === 'error') throw Error('Install failed');
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    },
    uninstall: id => request('/api/uninstall', {id}),
    power: mode => request('/api/power', {mode}),
    updateAttention: () => request('/api/update-attention'),
    version: () => request('/api/version'),
    onInstallState(fn) {
      listeners.add(fn);
      if (!timer) timer = setInterval(() => status().catch(() => {}), 800);
      return () => {listeners.delete(fn); if (!listeners.size) {clearInterval(timer); timer = null;}};
    }
  };
  // The hub's gear tab is the only settings screen. It asks an adult math question,
  // then these picture tiles open the worded pages kept out of the wordless child hub.
  win.HandheldPlatformOptions = {kind: 'kiosk', bridge, settings: [
    {icon: 'update', label: 'Cubby updates', href: '/adult/updates', notice: true},
    {icon: 'wifi', label: 'Wi-Fi settings', href: '/adult/network'},
    {icon: 'trash', label: 'Game saves', href: '#adult-saves'}
  ]};
  // Controller shortcut to the gear tab, which still asks the question:
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

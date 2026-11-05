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
  win.HandheldPlatformOptions = {kind: 'kiosk', bridge};
  // Adult management remains separate from the wordless child hub. The gear
  // is also reachable without a pointer: hold L+R+Start for two seconds.
  win.addEventListener('DOMContentLoaded', () => {
    const settings = document.createElement('button');
    settings.textContent = '⚙';
    settings.setAttribute('aria-label', 'Adult Wi-Fi settings');
    settings.style.cssText = 'position:fixed;right:8px;top:8px;z-index:1000;width:38px;height:38px;border-radius:50%;border:1px solid #708090;background:#172639;color:#fff;font-size:24px';
    settings.onclick = () => { win.location.href = '/adult/network'; };
    document.body.append(settings);
    let held = 0;
    function adultShortcut(now) {
      const pad = [...(navigator.getGamepads?.() || [])].find(p => p?.connected);
      if (pad?.buttons[4]?.pressed && pad?.buttons[5]?.pressed && pad?.buttons[9]?.pressed) {
        if (!held) held = now;
        if (now-held > 2000) win.location.href = '/adult/network';
      } else held = 0;
      requestAnimationFrame(adultShortcut);
    }
    requestAnimationFrame(adultShortcut);
  });
})(window);

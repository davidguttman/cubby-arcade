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
    readFeedState: () => request('/api/feeds/read', {}),
    writeFeedState: value => request('/api/feeds/write', value),
    fetchCatalog: url => request('/api/feeds/fetch', {url}),
    installStatus: status,
    async install(id, {offer} = {}) {
      await request('/api/install', offer ? {id,offer} : {id});
      for (;;) {
        const states = await status();
        // Pending is verified and waiting for the hub: it switches on the next hub entry.
        if (['installed', 'pending'].includes(states[id]?.phase)) return;
        if (states[id]?.phase === 'error') throw Error('Install failed');
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    },
    async update(id, {offer} = {}) {
      const reply=await request('/api/install', offer ? {id,offer,update:true} : {id});
      if(reply.skipped)return;
      for (;;) {
        const states=await status();
        if(['installed','pending'].includes(states[id]?.phase))return;
        if(states[id]?.phase==='error')throw Error('Install failed');
        await new Promise(resolve=>setTimeout(resolve,400));
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
    {icon: 'wifi', label: 'Wi-Fi settings', href: '/adult/network'},
    {icon: 'update', label: 'Cubby updates', href: '/adult/updates', notice: true}
  ]};
  // Players, saves, Phones, controller, feeds and power are the shared hub's own tiles.
  // Hold L+R+Start for the gear tab lives in the shared hub (runtime/core/hub.js).
})(window);

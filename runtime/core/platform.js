/* Capability-driven bridge. Native/Steam hosts can supply implementations. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./profiles.js') : root.HandheldProfiles, typeof module === 'object' && module.exports ? require('./game-feeds.js') : root.HandheldGameFeeds);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldPlatform = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Profiles, Feeds) {
  'use strict';
  // Historical SDK alias used by published Line Cutter releases. Keep this
  // explicit: prefix guessing could erase unrelated application preferences.
  const legacySaveKeys = {'line-cutter': ['linecutter_run']};
  const systemIds = new Set(['favorites', 'preferences', 'account', 'tokens']);
  function gameSaveId(id) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) || systemIds.has(id)) throw Error('Invalid game save scope');
    return id;
  }
  // Save management takes the player whose saves it means. Without one it means
  // the first player's storage, which is all a Cubby without players ever had.
  function playerPrefix(profile) {
    if (profile === undefined) return '';
    if (!Profiles) throw Error('Players unavailable');
    return Profiles.prefix(profile);
  }
  function createPlatform(options) {
    options = options || {};
    const doc = options.document || globalThis.document;
    let storage = options.storage;
    if (!storage) { try { storage = globalThis.localStorage; } catch (_) {} }
    const fetcher = options.fetch || globalThis.fetch;
    const native = options.bridge || {};
    const nativeSaves = typeof native.saves === 'function';
    const feeds = Feeds && ['readFeedState','writeFeedState','fetchCatalog'].every(name => typeof native[name] === 'function')
      ? Feeds.createManager({read:()=>native.readFeedState(),write:value=>native.writeFeedState(value),fetchCatalog:url=>native.fetchCatalog(url)}) : null;
    let offers=[];
    async function library() {
      if(native.library)return native.library();
      const response=await fetcher(options.libraryURL||'/library');
      if(!response.ok)throw Error('Library unavailable');
      const entries=await response.json();if(!Array.isArray(entries))throw Error('Invalid library');return entries;
    }
    // Only the library that predates this platform's managed installs is legacy.
    // A native install may expose bytes before its source pin is durable.
    let legacyIds=null,migration=Promise.resolve();
    function migrate(){
      const job=migration.then(async()=>{
        if(!legacyIds)legacyIds=new Set((await library()).map(game=>game.id));
        await feeds.migrateInstalled([...legacyIds]);
      });
      migration=job.catch(()=>{});return job;
    }
    async function retireLegacy(id){
      legacyIds?.delete(id);
      // Drain migrations that already captured this ID before allowing native
      // bytes to change. Later migrations see the pruned legacy set.
      await migration;
      legacyIds?.delete(id);
    }
    async function catalog(requestOptions={}) {
      if(feeds){const entries=await feeds.catalog(requestOptions);await migrate();offers=entries;return entries;}
      if(native.catalog)return native.catalog(requestOptions);
      const response=await fetcher(options.catalogURL||'/catalog',{...requestOptions,cache:'no-store'});
      if(!response.ok)throw Error('Catalog unavailable');
      const entries=await response.json();if(!Array.isArray(entries))throw Error('Invalid catalog');return entries;
    }
    async function install(id,requestOptions={}) {
      if(!feeds)return native.install(id,requestOptions);
      requestOptions.signal?.throwIfAborted();
      if(!offers.length)await catalog(requestOptions);
      await migrate();
      const offer=offers.find(entry=>entry.id===id);if(!offer)throw Error('Game not offered');
      const pin=await feeds.source(id),selected=Feeds.sourceOf(offer);
      if(pin&&(pin.feed_url!==selected.feed_url||pin.manifest_url!==selected.manifest_url))throw Error('Game already belongs to another source');
      if(!pin&&(await library()).some(game=>game.id===id))throw Error('Installed game source unavailable');
      await retireLegacy(id);
      const result=await native.install(id,{...requestOptions,offer});
      // Keep this exact issued object, never an IPC-returned/serialized clone.
      await feeds.pin(id,offer);return result;
    }
    async function update(id,requestOptions={}) {
      if(!feeds)return native.update?native.update(id,requestOptions):native.install(id,requestOptions);
      requestOptions.signal?.throwIfAborted();await migrate();
      const offer=await feeds.updateOffer(id);if(!offer)return;
      if(!(await library()).some(game=>game.id===id))return;
      const result=await (native.update?native.update(id,{...requestOptions,offer}):native.install(id,{...requestOptions,offer}));
      if((await library()).some(game=>game.id===id))await feeds.pin(id,offer);return result;
    }
    function saves(gameId, legacyKeys) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(gameId)) throw Error('Invalid game id');
      const key = name => {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw Error('Invalid save key');
        return legacyKeys && Object.prototype.hasOwnProperty.call(legacyKeys, name) ? legacyKeys[name] : 'handheld:' + gameId + ':' + name;
      };
      function requireStorage() { if (!storage) throw Error('Save storage unavailable'); return storage; }
      if (nativeSaves) {
        const backend = native.saves(gameId);
        return {
          get(name) {
            key(name);
            const value = backend.get(name);
            if (value !== null) return value;
            // Explicit legacy aliases migrate on read; never copy another game's namespace.
            if (legacyKeys && Object.prototype.hasOwnProperty.call(legacyKeys, name) && storage) {
              const previous = storage.getItem(key(name));
              if (previous !== null) { const parsed = JSON.parse(previous); backend.set(name, parsed); return parsed; }
            }
            return null;
          },
          set(name, value) { key(name); if (JSON.stringify(value) === undefined) throw Error('Save must be JSON'); backend.set(name, value); },
          remove(name) { key(name); backend.remove(name); if (legacyKeys && Object.prototype.hasOwnProperty.call(legacyKeys, name) && storage) storage.removeItem(key(name)); }
        };
      }
      return {
        get(name) { const value = requireStorage().getItem(key(name)); return value === null ? null : JSON.parse(value); },
        set(name, value) { const encoded = JSON.stringify(value); if (encoded === undefined) throw Error('Save must be JSON'); requireStorage().setItem(key(name), encoded); },
        remove(name) { requireStorage().removeItem(key(name)); }
      };
    }
    function localSaveKeys(id, player) {
      gameSaveId(id);
      if (!storage) { if (!nativeSaves) throw Error('Save storage unavailable'); return []; }
      const prefix = player + 'handheld:' + id + ':', aliases = (legacySaveKeys[id] || []).map(key => player + key), keys = [];
      // Snapshot before removal: Storage indexes shift after each deleted item.
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (name && (name.startsWith(prefix) || aliases.includes(name))) keys.push(name);
      }
      return keys;
    }
    function storedGames(player) {
      const ids = new Set();
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i) || '', match = name.startsWith(player) && /^handheld:([a-z0-9][a-z0-9-]{0,79}):[a-zA-Z0-9_-]+$/.exec(name.slice(player.length));
        if (match && !systemIds.has(match[1])) ids.add(match[1]);
      }
      for (const [id, aliases] of Object.entries(legacySaveKeys)) if (aliases.some(key => storage.getItem(player + key) !== null)) ids.add(id);
      return ids;
    }
    return {
      async savedGames(profile) {
        const player = playerPrefix(profile);
        const ids = new Set(native.savedGames ? await native.savedGames(profile) : []);
        if (storage) for (const id of storedGames(player)) ids.add(id);
        else if (!native.savedGames) throw Error('Save storage unavailable');
        return [...ids].filter(id => {try {gameSaveId(id);return true;} catch {return false;}}).sort();
      },
      async resetGameSaves(id, profile) {
        const keys = localSaveKeys(id, playerPrefix(profile));
        if (nativeSaves && !native.resetGameSaves) throw Error('Save reset unavailable');
        if (native.resetGameSaves) await native.resetGameSaves(id, profile);
        for (const key of keys) storage.removeItem(key);
      },
      // Everything one player saved, in every game. The first player's storage is
      // the shared unprefixed namespace, so only its game saves go, never settings.
      async removeProfile(profile) {
        if (!Profiles) throw Error('Players unavailable');
        const player = Profiles.prefix(profile);
        if (nativeSaves && !native.removeProfile) throw Error('Player removal unavailable');
        if (native.removeProfile) await native.removeProfile(profile);
        if (!storage) return;
        const keys = [];
        if (player) for (let i = 0; i < storage.length; i++) { const name = storage.key(i); if (name && name.startsWith(player)) keys.push(name); }
        else for (const id of storedGames('')) keys.push(...localSaveKeys(id, ''));
        for (const key of keys) storage.removeItem(key);
      },
      kind: options.kind || 'web',
      settings: options.settings || [],
      // Native saves need a host that knows which player is playing.
      capabilities: Object.freeze({saves:!!storage || nativeSaves, profiles:!!Profiles && !!storage && (!nativeSaves || typeof native.useProfile === 'function' && typeof native.removeProfile === 'function'), fullscreen:!!(doc && doc.documentElement && doc.documentElement.requestFullscreen),
        tokens:typeof native.account==='function'&&typeof native.launch==='function', quit:typeof native.quit === 'function', power:typeof native.power === 'function', install:typeof native.install === 'function', uninstall:typeof native.uninstall === 'function', volume:typeof native.setVolume === 'function', sleep:typeof native.sleep === 'function'}),
      saves,
      library,
      catalog,
      feedConfig: feeds ? ()=>feeds.config() : undefined,
      setFeedConfig: feeds ? async config=>{const result=await feeds.setConfig(config);offers=[];return result;} : undefined,
      updateOffer: feeds ? id=>feeds.updateOffer(id) : undefined,
      async fullscreen() {
        if (!doc || !doc.documentElement || !doc.documentElement.requestFullscreen) return false;
        await doc.documentElement.requestFullscreen(); return true;
      },
      account:native.account&&native.account.bind(native),
      launch:native.launch&&native.launch.bind(native),
      refillTokens:native.refillTokens&&native.refillTokens.bind(native),
      onAccountState:native.onAccountState&&native.onAccountState.bind(native),
      quit: typeof native.quit === 'function' ? native.quit.bind(native) : undefined,
      power: typeof native.power === 'function' ? native.power.bind(native) : undefined,
      install: native.install && install,
      // Installing fetches the current release, so it is also how a game updates. A host
      // overrides this only to add safeguards; it can't opt out by forgetting it.
      update: native.install && update,
      uninstall: typeof native.uninstall === 'function' ? async id=>{const result=await native.uninstall(id);if(feeds){await retireLegacy(id);await feeds.forget(id);}return result;} : undefined,
      installStatus: native.installStatus && native.installStatus.bind(native),
      onInstallState: native.onInstallState && native.onInstallState.bind(native),
      updateAttention: native.updateAttention && native.updateAttention.bind(native),
      version: native.version && native.version.bind(native),
      useProfile: native.useProfile && native.useProfile.bind(native),
      setVolume: native.setVolume && native.setVolume.bind(native),
      sleep: native.sleep && native.sleep.bind(native)
    };
  }
  return {createPlatform};
});

/* Capability-driven bridge. Native/Steam hosts can supply implementations. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldPlatform = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Historical SDK alias used by published Line Cutter releases. Keep this
  // explicit: prefix guessing could erase unrelated application preferences.
  const legacySaveKeys = {'line-cutter': ['linecutter_run']};
  const systemIds = new Set(['favorites', 'preferences', 'account', 'tokens']);
  function gameSaveId(id) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) || systemIds.has(id)) throw Error('Invalid game save scope');
    return id;
  }
  function createPlatform(options) {
    options = options || {};
    const doc = options.document || globalThis.document;
    let storage = options.storage;
    if (!storage) { try { storage = globalThis.localStorage; } catch (_) {} }
    const fetcher = options.fetch || globalThis.fetch;
    const native = options.bridge || {};
    const nativeSaves = typeof native.saves === 'function';
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
    function localSaveKeys(id) {
      gameSaveId(id);
      if (!storage) { if (!nativeSaves) throw Error('Save storage unavailable'); return []; }
      const prefix = 'handheld:' + id + ':', aliases = legacySaveKeys[id] || [], keys = [];
      // Snapshot before removal: Storage indexes shift after each deleted item.
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (name && (name.startsWith(prefix) || aliases.includes(name))) keys.push(name);
      }
      return keys;
    }
    return {
      async savedGames() {
        const ids = new Set(native.savedGames ? await native.savedGames() : []);
        if (storage) {
          for (let i = 0; i < storage.length; i++) {
            const name = storage.key(i), match = /^handheld:([a-z0-9][a-z0-9-]{0,79}):[a-zA-Z0-9_-]+$/.exec(name || '');
            if (match && !systemIds.has(match[1])) ids.add(match[1]);
          }
          for (const [id, aliases] of Object.entries(legacySaveKeys)) if (aliases.some(key => storage.getItem(key) !== null)) ids.add(id);
        } else if (!native.savedGames) throw Error('Save storage unavailable');
        return [...ids].filter(id => {try {gameSaveId(id);return true;} catch {return false;}}).sort();
      },
      async resetGameSaves(id) {
        const keys = localSaveKeys(id);
        if (nativeSaves && !native.resetGameSaves) throw Error('Save reset unavailable');
        if (native.resetGameSaves) await native.resetGameSaves(id);
        for (const key of keys) storage.removeItem(key);
      },
      kind: options.kind || 'web',
      settings: options.settings || [],
      capabilities: Object.freeze({saves:!!storage || nativeSaves, fullscreen:!!(doc && doc.documentElement && doc.documentElement.requestFullscreen),
        tokens:typeof native.account==='function'&&typeof native.launch==='function', quit:typeof native.quit === 'function', power:typeof native.power === 'function', install:typeof native.install === 'function', uninstall:typeof native.uninstall === 'function', volume:typeof native.setVolume === 'function', sleep:typeof native.sleep === 'function'}),
      saves,
      async library() {
        if (native.library) return native.library();
        const response = await fetcher(options.libraryURL || '/library');
        if (!response.ok) throw Error('Library unavailable');
        const entries = await response.json();
        if (!Array.isArray(entries)) throw Error('Invalid library');
        return entries;
      },
      async catalog(requestOptions = {}) {
        if (native.catalog) return native.catalog(requestOptions);
        const response = await fetcher(options.catalogURL || '/catalog', {...requestOptions, cache: 'no-store'});
        if (!response.ok) throw Error('Catalog unavailable');
        const entries = await response.json();
        if (!Array.isArray(entries)) throw Error('Invalid catalog');
        return entries;
      },
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
      install: native.install && native.install.bind(native),
      uninstall: typeof native.uninstall === 'function' ? native.uninstall.bind(native) : undefined,
      installStatus: native.installStatus && native.installStatus.bind(native),
      onInstallState: native.onInstallState && native.onInstallState.bind(native),
      updateAttention: native.updateAttention && native.updateAttention.bind(native),
      version: native.version && native.version.bind(native),
      setVolume: native.setVolume && native.setVolume.bind(native),
      sleep: native.sleep && native.sleep.bind(native)
    };
  }
  return {createPlatform};
});

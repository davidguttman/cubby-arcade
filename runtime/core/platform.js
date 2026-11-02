/* Capability-driven bridge. Native/Steam hosts can supply implementations. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HandheldPlatform = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
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
    return {
      kind: options.kind || 'web',
      capabilities: Object.freeze({saves:!!storage || nativeSaves, fullscreen:!!(doc && doc.documentElement && doc.documentElement.requestFullscreen),
        install:typeof native.install === 'function', volume:typeof native.setVolume === 'function', sleep:typeof native.sleep === 'function'}),
      saves,
      async library() {
        if (native.library) return native.library();
        const response = await fetcher(options.libraryURL || '/library');
        if (!response.ok) throw Error('Library unavailable');
        const entries = await response.json();
        if (!Array.isArray(entries)) throw Error('Invalid library');
        return entries;
      },
      async fullscreen() {
        if (!doc || !doc.documentElement || !doc.documentElement.requestFullscreen) return false;
        await doc.documentElement.requestFullscreen(); return true;
      },
      install: native.install && native.install.bind(native),
      setVolume: native.setVolume && native.setVolume.bind(native),
      sleep: native.sleep && native.sleep.bind(native)
    };
  }
  return {createPlatform};
});

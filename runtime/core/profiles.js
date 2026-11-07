/* Players: each one has its own game saves and favorites.
 *
 * The first player keeps exactly the storage every earlier Cubby used, so nothing
 * is migrated and a device that rolls back still finds those saves. Every other
 * player's storage sits under one prefix that no game or older Cubby reads.
 *
 * Hosts inject this script into game pages after their own modules and before the
 * game's scripts. There it gives the page the launching player's storage, so frozen
 * game releases, including ones that use localStorage directly, save per player
 * without a byte of the game changing. The hub loads it without that marker. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.HandheldProfiles = api; api.enterGamePage(root); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const FIRST = 'p_first';
  const REGISTRY_KEY = 'cubby:profiles:v1';
  // Per tab: the player the hub launched with. A game page always runs as that
  // player, whatever another tab chooses; switching happens only on the hub.
  const PIN_KEY = 'cubby:profile';
  const AVATARS = Object.freeze(['fox', 'frog', 'bear', 'bunny', 'panda', 'owl', 'cat', 'chick']);
  // Cubby's own settings, which every player shares, even when read from a game page.
  const SHARED_KEYS = new Set(['handheld:preferences:v1', 'cubby:controller-labels:v1']);
  // The underscore keeps player ids apart from every game id and system id, which
  // allow only lowercase letters, digits and hyphens.
  const ID = /^p_[a-z0-9]{1,24}$/;
  const validId = id => typeof id === 'string' && ID.test(id);
  function prefix(id) {
    if (!validId(id)) throw Error('Invalid player');
    return id === FIRST ? '' : 'cubby:profile:' + id + ':';
  }

  function scopeStorage(storage, id) {
    const pre = prefix(id);
    if (!pre || !storage) return storage;
    const name = key => { key = String(key); return SHARED_KEYS.has(key) ? key : pre + key; };
    function own() {
      const keys = [];
      for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key && key.startsWith(pre)) keys.push(key.slice(pre.length)); }
      return keys;
    }
    const scoped = {
      getItem: key => storage.getItem(name(key)),
      setItem: (key, value) => storage.setItem(name(key), String(value)),
      removeItem: key => storage.removeItem(name(key)),
      key: index => own()[index] ?? null,
      clear() { for (const key of own()) storage.removeItem(pre + key); },
      get length() { return own().length; }
    };
    // A real Storage also answers named access (storage.x = 1); keep that scoped too.
    const named = key => typeof key === 'string' && !(key in scoped);
    return new Proxy(scoped, {
      get: (target, key) => named(key) ? target.getItem(key) ?? undefined : target[key],
      set: (target, key, value) => { if (!named(key)) return false; target.setItem(key, value); return true; },
      deleteProperty: (target, key) => { if (named(key)) target.removeItem(key); return true; },
      has: (target, key) => key in target || (named(key) && target.getItem(key) !== null)
    });
  }

  function implicit() { return {stored: false, profiles: [{id: FIRST, avatar: AVATARS[0]}], active: FIRST}; }
  function readRegistry(storage) {
    try {
      const value = JSON.parse(storage.getItem(REGISTRY_KEY));
      if (!value || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > AVATARS.length) return implicit();
      const profiles = [], ids = new Set(), avatars = new Set();
      for (const entry of value.profiles) {
        if (!entry || !validId(entry.id) || ids.has(entry.id) || !AVATARS.includes(entry.avatar) || avatars.has(entry.avatar)) return implicit();
        ids.add(entry.id); avatars.add(entry.avatar); profiles.push({id: entry.id, avatar: entry.avatar});
      }
      return {stored: true, profiles, active: ids.has(value.active) ? value.active : profiles[0].id};
    } catch (_) { return implicit(); }
  }
  function readPin(session, registry) {
    try { const id = session && session.getItem(PIN_KEY); return registry.profiles.some(p => p.id === id) ? id : null; } catch (_) { return null; }
  }
  function current({storage, session}) {
    const registry = readRegistry(storage);
    return readPin(session, registry) || registry.active;
  }

  // The hub's view of the players. `platform` supplies host file access for saves.
  function createProfiles(options) {
    const {storage, session} = options, platform = options.platform || {};
    const random = options.random || (() => { const value = new Uint32Array(1); root.crypto.getRandomValues(value); return value[0] / 2 ** 32; });
    let registry = readRegistry(storage);
    const find = id => registry.profiles.find(p => p.id === id);
    function write(profiles, active) {
      const next = {profiles: profiles.map(p => ({id: p.id, avatar: p.avatar})), active};
      storage.setItem(REGISTRY_KEY, JSON.stringify(next));
      registry = {stored: true, ...next};
    }
    function pin(id) { try { if (session) session.setItem(PIN_KEY, id); } catch (_) {} }
    function freeAvatar(avatar, except) {
      if (!AVATARS.includes(avatar)) throw Error('Unknown picture');
      if (registry.profiles.some(p => p.avatar === avatar && p.id !== except)) throw Error('Picture already used');
    }
    function newId() {
      for (;;) {
        let id = 'p_';
        for (let i = 0; i < 10; i++) id += '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)];
        if (id !== FIRST && !find(id)) return id;
      }
    }
    // The host must be playing as this player before any game page can save.
    async function enter(id) {
      if (!find(id)) throw Error('Unknown player');
      if (platform.useProfile) await platform.useProfile(id);
      pin(id);
    }
    return {
      list: () => registry.profiles.map(p => ({...p})),
      current: () => readPin(session, registry) || registry.active,
      pinned: () => readPin(session, registry),
      storageFor: id => scopeStorage(storage, id),
      enter,
      async select(id) {
        await enter(id);
        if (registry.stored && registry.active !== id) write(registry.profiles, id);
      },
      add(avatar) {
        if (registry.profiles.length >= AVATARS.length) throw Error('No pictures left');
        freeAvatar(avatar);
        const profile = {id: newId(), avatar};
        write([...registry.profiles, profile], registry.active);
        return {...profile};
      },
      setAvatar(id, avatar) {
        if (!find(id)) throw Error('Unknown player');
        freeAvatar(avatar, id);
        write(registry.profiles.map(p => p.id === id ? {id, avatar} : p), registry.active);
      },
      // Saves go first: if that fails the player stays listed, so an adult can retry.
      async remove(id) {
        if (!find(id)) throw Error('Unknown player');
        if (registry.profiles.length < 2) throw Error('The only player stays');
        if (!platform.removeProfile) throw Error('Player removal unavailable');
        const wasPinned = readPin(session, registry) === id;
        await platform.removeProfile(id);
        const profiles = registry.profiles.filter(p => p.id !== id), active = registry.active === id ? profiles[0].id : registry.active;
        write(profiles, active);
        if (wasPinned) pin(active);
      }
    };
  }

  // Runs in a game page that a host marked. The first player needs nothing.
  function enterGamePage(win) {
    const script = win.document && win.document.currentScript;
    if (!script || !script.hasAttribute || !script.hasAttribute('data-cubby-profile')) return null;
    let storage, session;
    try { storage = win.localStorage; session = win.sessionStorage; } catch (_) { return null; }
    if (!storage) return null;
    const id = current({storage, session});
    if (id === FIRST) return id;
    const scoped = scopeStorage(storage, id);
    try { Object.defineProperty(win, 'localStorage', {configurable: true, enumerable: true, get: () => scoped}); } catch (_) {}
    // Games build their platform from these options, so their saves stay scoped
    // even if a browser refused to replace localStorage above. Hosts with their own
    // options (desktop) scope native saves themselves.
    if (win.HandheldPlatformOptions === undefined) win.HandheldPlatformOptions = {storage: scoped};
    return id;
  }

  return {FIRST, REGISTRY_KEY, PIN_KEY, AVATARS, SHARED_KEYS, validId, prefix, scopeStorage, readRegistry, current, createProfiles, enterGamePage};
});

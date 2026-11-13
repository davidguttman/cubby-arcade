# Cubby for grown-ups

The phone companion lives at `https://cubbyarcade.com/parents/`. It is a separate
installable web app, not the wordless player at `/play/`.

## Ownership and discovery

This is only Cubby's generic pairing/device dashboard. Each **game** owns its
actual grown-up companion app and declares `companion: {url, title?, artwork?}`
in its package/release manifest; see [the game manifest contract](game-release-manifest.md#game-owned-phone-companions).
The paired Cubby announces companions from its installed versions, including
custom-feed games. The dashboard does not fetch a fixed public catalog or need
a per-game Cubby route, source change, or hosting rewrite. Updates and removal
follow the installed game manifest; when a Cubby is unreachable, the phone shows
its last successfully synced list.

Pair Cubby once. Tapping a game opens its game-owned page **inside this parent
app**, not a separate browser or another pairing flow. The parent's live connection
stays open and a generic bridge scopes messages to that game and selected Cubby.
The game receives public player/device state and game-derived keys, never raw
pairing codes, pairing management, other games' channels or other Cubbies.

Publishers vendor `runtime/core/companion.js` with their game companion and load
it instead of the standalone `link.js` transport. See [the embedded SDK](#embedded-game-sdk).
Companions must be hosted on a publisher HTTPS origin different from the parent
app, and must permit framing (no blocking `X-Frame-Options` or `frame-ancestors`).
The iframe sandbox permits scripts, publisher storage, forms and game confirmation
dialogs, but not popups or top-level navigation. This preserves game-local state
without granting access to Cubby's pairing storage.

Existing releases without companion metadata remain playable but need a new
release to appear here. Existing standalone companions must migrate to the SDK;
Cubby never falls back to asking a parent for another game-specific pairing.

## Embedded game SDK

The vendored SDK sets `window.CubbyLink` and a message-size constant in
`window.CubbyLinkAPI.MAX_MESSAGE`. It does not start a transport, consume QR codes
or read pairing credentials. `await CubbyLink.ready` returns a scoped facade or
`null` when opened outside Cubby or when the parent cannot connect.

```js
const link = await CubbyLink.ready;
if (!link) { /* Tell the adult to open this game in Cubby. */ }
else {
  const line = link.channel('my-game');
  line.onMessage(message => { /* message.from, message.player, message.body */ });
  for (const cubby of link.pairings()) {
    await line.send({t: 'ask'}, {to: cubby.id});
    const key = await line.key(cubby.id, 'my-game-label');
  }
  link.onChange(() => { /* Public connected/player state changed. */ });
}
```

`link.pairings()` contains only the selected Cubby. `link.onChange(fn)` and
`line.onMessage(fn)` return unsubscribe functions. `line.send(body, {to?, player?})`
is **asynchronous**: await it and handle errors. It defaults to the selected Cubby;
other peers and unknown players are rejected. `line.key(peer, label)` derives a
key for this game's channel only. `line.waiting()` returns the latest queued
message count for this game/Cubby; the shared connection delivers queued edits.
No accept/remove/rename pairing operations are exposed. `channel()` cannot select
another game. Back/All games closes the capability. Removing the game or pairing,
or replacing the companion URL, revokes it. Connection changes push state without
reloading the iframe or discarding edits. Game pages own their own UI/state/cache;
the Cubby shell does not promise offline caching of publisher pages.

The handshake validates both publisher origin and iframe window, then uses a
single private `MessagePort`. Old frames/ports are closed when leaving/reloading.
Requests and pending responses are bounded; a missing SDK or blocked page leaves
an in-app retry/back path rather than navigating away.

## Install

- Android/Chrome and desktop Chrome/Edge: open the page and choose **Install Cubby**
  when offered, or use the browser's **Install app / Add to Home Screen** menu.
- iPhone/iPad: open the page in Safari, tap **Share → Add to Home Screen** and
  leave **Open as Web App** enabled when that option appears.
- Open the new Cubby house icon. Install first, then pair from that app. On iOS,
  browser and Home Screen storage can be separate: an existing Safari pairing
  may not carry over. If needed, open the Cubby's gear tab → Phones → Add a phone
  and display a fresh code. In the camera's QR preview, copy the link **before
  opening it**, reopen the installed Cubby app, and choose **Paste pairing link**.
  Do not copy Safari's address bar: opening the link consumes the code and removes
  it from that address. If you already opened it, display a new code first.
  The same paste action can add another Cubby when the app is already paired.
  The app validates the Cubby address and consumes the code using the existing
  pairing flow; invalid links leave existing pairings visible and unchanged.

Installation needs HTTPS (or a localhost development origin) and browser support.
The installation card is absent in the standalone app. The manifest has a stable,
code-free launch URL and regular, maskable, favicon and Apple touch icons using
the existing Cubby house mark.

## Offline and updates

After one successful online visit, the companion shell and its shared pairing
code are cached. Saved pairings remain in this device's existing local storage;
the worker never stores pairing records, scanned codes, relay responses, game
settings pages, game art or catalogs. Offline, the app can show known Cubbies but
cannot promise a live connection or open uncached game settings. The offline
notice explains this. Reconnect to use those features. Clearing browser/app data
also removes pairings and the offline shell.

The worker is scoped to `/parents/`, handles only an explicit shell whitelist,
and never substitutes its home screen for legacy `/parents/<game>/` pages.
Game-owned companion pages remain outside this shell cache. Online shell
requests prefer the network; failed requests fall back to cached shell files.
A new worker waits until the previous app is closed before activating, preserving
an open pairing/settings session. Bump `CACHE` in `parents/worker.js` when changing
the offline shell; activation cleans only obsolete `cubby-parents-*` caches.
Both `web.py build` and `hosting/build.py` include the complete companion.

## Icon source

`parents/icons/favicon.svg` is the existing `website/favicon.svg` Cubby house.
The PNGs render that vector on an opaque `#1f1633` square. The regular/Apple icons
use a 64-unit square with the 48-unit mark centered; the maskable icon uses a
76-unit square, keeping the mark inside the central 80%-diameter safe circle.

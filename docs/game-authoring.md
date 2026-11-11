# Make a game for Cubby Arcade

Cubby Arcade is a controller-first arcade for pre-literate children. This guide
is for adults and coding agents; the games themselves must not require reading.

## Start with the player

Use pictures, animation, sound and demonstrated actions, not written tutorials,
menus or error messages. A button glyph can supplement an action but must not
be the only explanation. Support keyboard and standard controller input. Cubby supplies the on-screen
virtual controller; games must not own or bundle it. Line Cutter is a technical test payload, not a UX template.

## Build an offline web game

Ship static HTML, JavaScript, styles, artwork and audio with relative asset
references. The entrypoint and all required assets must work without a network.
Do not depend on your website's server routes, root-relative game assets, logins,
CDNs or browser storage tied to the publishing domain. Cubby installs each game
under `/games/<id>/`; it does not navigate to the remote game's website.

Use a stable lowercase game ID such as `my-game`. Keep saves compatible between
versions or migrate them. Keep old release files available.

## Controls, lifecycle and saves

The optional shared JavaScript modules live in `runtime/core/` in the
[Cubby repository](https://github.com/davidguttman/cubby-arcade/tree/main/runtime/core).
They are not an npm package. Existing `Handheld*` names are compatibility APIs,
not outdated instructions. Inspect those modules before integrating:

- `preferences.js` and `input.js`: `HandheldInput.createInput({onAction})`
  provides semantic input. Direction buttons retain their names; `a` maps to
  `confirm`, `b` to `back`, and `start` to `pause`. The event also contains
  `button` and `source`. Keyboard mappings follow user preferences.
- `platform.js`: `HandheldPlatform.createPlatform()` exposes capability-based
  services. `platform.saves(gameId)` returns `get(name)`, `set(name, value)`
  and `remove(name)` for JSON saves. The native bridge is host supplied;
  do not invent a server-side save or wallet API.
- `sdk.js`: `HandheldSDK.createGameHost({gameId, platform})` connects shared
  input, pause/resume and saves. Its game instance must have `press(button)` and
  `release(button)`, plus `stop()`, `wake()` and optionally `start()`. Follow the
  actual source and its tests for lifecycle details.

**Input is one layer.** Your game has its own controls; something connects to
them. In a plain browser your page connects keyboard and gamepad events to
`press` and `release`. Under Cubby the host connects to those same two functions.
Nothing below that line changes between the two.

- `press` comes when a button goes down, `release` when it comes up. Nothing repeats,
  so a held direction is one `press` and later one `release`: while it's down, keep
  walking. "Hold a direction and press A" is just knowing what's down.
- In Cubby, take input from the host, not `keydown` or `getGamepads()`. Remapping
  happens before the host calls you, so reading devices yourself loses it.
- `createInput({repeat:true})` is for moving through menus, which is what the hub uses.
- Cubby's on-screen controller is host-owned, like a USB controller. Consume
  it through the host like any other button, not through OSD UI callbacks. Do not include `host-osd.js`/CSS in a game package. Legacy
  `controls.js` is a standalone fallback; hosted `createControls` calls are
  suppressed so old packages continue working without an update.

OSD layout/visibility/lifecycle and keyboard binding policy belong to Cubby.
Updating them must not require releasing or rewriting a game package.

Cubby injects a host-owned game menu even if you do not use the SDK. Escape,
Select + Start, or both shoulders open it. Do not intercept or repurpose that
system menu. Listen for `handheld:system-menu` (`event.detail.open`) to pause
your own simulation and audio while it is open; pause on lost focus/visibility.
The injected menu alone cannot automatically pause an arbitrary game loop.

### Quitting from your own game menu

When a player chooses Quit, save their progress and return your game to a
playable title screen, clearing held input and stopping gameplay audio as needed.
Then dispatch this window event:

```js
window.dispatchEvent(new CustomEvent('handheld:quit'));
```

The event has no required detail. Cubby's injected host shell listens for it and
returns to the library (`/play` in a browser, `/` on native hosts), without opening
the system menu. This works without an SDK or with an older bundled SDK; the
listener belongs to Cubby, not to immutable game packages. Outside Cubby, no host
handles the event, so the game stays at its title and can be played again. Do not
navigate to a blank page, close the tab, or call `HandheldGameShell.home()` from
game code. This event is separate from the controller's system-menu exit action.

Cubby also tells games about system events. You don't have to listen; a game that
doesn't is simply frozen and resumed. Each one is a window event carrying
`event.detail`:

- `handheld:sleep`: the device is about to sleep. `detail.reason` is `button`,
  `idle` or `system`. It may not wake again before the battery runs out, so this
  is a good moment to save if your game needs to.
- `handheld:wake`: the device is back. `detail.reason` is `button` or `other`.

```js
addEventListener('handheld:sleep', event => {
  save();                                  // Synchronous work just happens.
  event.waitUntil(saveToServer());         // Or ask for a moment; about a second, not more.
});
```

Cubby injects this, so no SDK or package change is involved, and the display and
sound are already off when you hear `handheld:sleep`. Don't start music or
animations in response to it. On hosts with no such signal, these events don't fire.

## Publish once, without a ZIP

1. Build offline files into `dist/game/`.
2. Download the standalone [manifest generator](/tools/cubby_manifest.py).
3. Generate sizes, SHA-256 hashes and versioned URLs from those exact files.
4. Upload the unchanged files to your own HTTPS domain under a versioned path.
5. Verify the upload, then publish the stable manifest last, in that same
   GitHub release workflow. No second release or hand-entered checksums.

```sh
uv run python tools/cubby_manifest.py dist/game \
  --id my-game --version "$RELEASE_VERSION" \
  --entrypoint index.html --artwork cover.png \
  --base-url "/releases/$RELEASE_VERSION/" \
  --output dist/release-manifest.json
```

The generator is Python 3.11+ and standard-library only; copying it into your
repo does not require installing Cubby. Keep its output outside `dist/game/`.
The game does not need to know its deployment domain. Omit `--base-url` when
the payload files sit beside the hosted manifest (the default is `./`). For a
stable manifest pointing at versioned files, supply a relative directory such
as `releases/$RELEASE_VERSION/`, or a root-relative directory as above. Cubby
resolves download references against the requested manifest URL, not the
catalog's origin. Explicit absolute HTTPS bases remain supported for CDNs.
If the same manifest is served at both a stable and version-specific path,
use a root-relative base so its download references mean the same thing at both.
See the [complete release manifest specification](/docs/game-release-manifest.html)
for fields, validation, size limits, media and compatibility.

## Add the game to the store once

Cubby's trusted developer registry is the `/catalog` JSON array. Ask its
maintainer to add a listing with this shape; there is no public submission API:

```json
{
  "id": "my-game",
  "title": "My Game",
  "manifest_url": "https://my-game.example/arcade/manifest.json",
  "artwork": "https://my-game.example/discovery/cover.png",
  "attract": "https://my-game.example/discovery/trailer.webm",
  "screenshots": []
}
```

`attract` (trailer) is optional; discovery media URLs are HTTPS. The registry
holds the stable manifest URL and discovery media. Your game owns its release
manifest and payload files. Subsequent releases update that stable manifest,
not Cubby's registry or executable. Browsing does not fetch the install manifest.

### Release to beta first

Cubby has two independent discovery lists: `hosting/catalog.yaml` publishes to
https://cubby.david.app/catalog (stable), and `hosting/beta-catalog.yaml` publishes
to https://cubby.david.app/beta/catalog (beta). The beta list starts empty. Ask
the maintainer to add an early game to beta using the same listing shape above,
then build/deploy the static site normally (`uv run python web.py build`). Every
export includes both catalogs and validates their metadata before replacing the
previous export; no separate backend is needed.

Publish and verify the game's HTTPS release manifest and payloads before adding
its listing. For a beta-only game, add it only to `beta-catalog.yaml`; it must not
also appear in stable. Future beta releases update the manifest URL that beta's
listing points to. When ready for everyone, add the listing to `catalog.yaml`.
If stable and beta builds coexist, use separate game IDs: Cubby shares installed
packages and pins each installed ID to its original feed, so two listings with
the same ID are not two independently installed channels. Keep the beta listing
available for existing beta installs until they can intentionally uninstall and
reinstall from stable; saves remain on the device.

To opt in, select your player, open the gear, pass the adult check, then open
**Game feeds** and enable **Cubby Beta**. The face/name at the top identifies the
player being configured. Each profile has its own selection; beta is off by
default, and enabling it for your player does not enable it for the kids.
Disabling or removing a feed hides its games in both Store and Library without
deleting installed packages or saves. Existing profiles preserve the old
device-wide feed choices when upgraded; newly created profiles start with only
stable enabled. This is profile visibility, not private distribution or access
control: the beta catalog is a public URL, and packages are shared on the device.

## Understand the launcher boundary

Downloads and updates are free. The desktop test account starts with 10 local
tokens; one token is charged per successful launch, not per game purchase or
minute played. There is no timer. Do not implement charging inside the game.
The browser demo is free and does not simulate native wallet enforcement.
There are no real-money payments, creator payouts or cloud accounts.

Cubby verifies every file, stages a complete release and activates updates only
outside gameplay. Existing ZIP schema 1 releases remain supported. New schema 2
file releases with absolute URLs require Cubby Arcade desktop 0.3.0 or newer.
Relative download URLs require Cubby Arcade desktop **0.4.0 or newer**; existing
0.3.0 bundles do not support them. Update the executable before switching a
game's stable manifest to relative URLs. A child's existing 0.2.0 executable
must also be replaced to gain the file installer.

## Before handing off

Test a fresh offline install, keyboard/controller input, pause/resume, return to
library, save/restart and an update from a prior version. Verify all payload URLs
use direct HTTPS (no redirects), and that uploaded byte sizes/hashes match.
Physical controller and target-device performance need real hardware testing.

## Cover and trailer shape

The hub shows every cover and trailer in a 4:3 frame, the shape of the handheld's
640 by 480 screen, and never crops them: a picture of another shape is shown whole
with bars. Make `cover.png` and the attract video 4:3 (for example 1440 by 1080 and
640 by 480). Keep a title a sixth of the way in from the top and the sides: the
store's back button sits over the top left corner of the large preview.

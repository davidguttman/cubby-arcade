# Make a game for Cubby Arcade

Cubby Arcade is a controller-first arcade for pre-literate children. This guide
is for adults and coding agents; the games themselves must not require reading.

## Start with the player

Use pictures, animation, sound and demonstrated actions, not written tutorials,
menus or error messages. A button glyph can supplement an action but must not
be the only explanation. Support keyboard and controller, with touch controls
when appropriate. Line Cutter is a technical test payload, not a UX template.

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
- `sdk.js`: `HandheldSDK.createGameHost({gameId, platform})` optionally connects
  shared input, pause/resume and saves. Its game instance has `press(button)`,
  `stop()`, `wake()` and optionally `start()`. Follow the actual source and its
  tests for lifecycle details.
- `controls.js`: optional pictorial controls via
  `HandheldControls.createControls(input, 'game')`.

Cubby injects a host-owned game menu even if you do not use the SDK. Escape,
Select + Start, or both shoulders open it. Do not intercept or repurpose that
system menu. Listen for `handheld:system-menu` (`event.detail.open`) to pause
your own simulation and audio while it is open; pause on lost focus/visibility.
The injected menu alone cannot automatically pause an arbitrary game loop.

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

## Understand the launcher boundary

Downloads and updates are free. The desktop test account starts with 10 local
tokens; one token is charged per successful launch, not per game purchase or
minute played. There is no timer. Do not implement charging inside the game.
The browser demo is free and does not simulate native wallet enforcement.
There are no real-money payments, creator payouts or cloud accounts yet.

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

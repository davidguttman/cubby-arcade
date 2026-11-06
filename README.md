# Cubby Arcade

An independent home for Linux/OS integration, a picture-first launcher, and the
ARM64 development VM. The dedicated RG353V image is separate from the QEMU disk;
never flash the QEMU disk to a handheld.

For a physical **Anbernic RG353V**, use the separate
[all-in-one SD-card image and adult setup guide](docs/rg353v-install.md): flash
one image, insert the card, and power on. ROCKNIX, WPE, Cubby startup, and offline
Trail Mix are preinstalled, with a stock-launcher recovery path. The image is
not publicly published or hardware-certified yet; VM results do not certify
the handheld.

Repository: https://github.com/davidguttman/cubby-arcade . Local checkout:
`/mnt/data/play/native/cubby-arcade`. See `MIGRATION.md` for preserved profile,
game-package and prepared-VM compatibility, plus deployment boundaries.

## Audience: pre-literate children

**No words by default** in child-facing launchers, libraries, prompts, errors,
instructions or games. Use pictures, animation, sound and demonstrated actions.
Any word needs a compelling reason and must be short, simple and phonetic;
reading must never be necessary. Text is allowed in separate adult management.
See `AGENTS.md`.

Line Cutter is an unchanged **technical test payload**, not the product design
or intended audience. Its internal written menus are not precedent. Its new
package title/start controls and play affordance use no words. The cover title is an explicit requested exception. The attract
loop is the **actual 46.6-second gameplay trailer used on david.app**, played
muted from the installed package. Original game text inside this test footage
is not precedent for child-facing games. No reading is required to start or exit.

## Disk-installed example game

OS and games now have independent lifecycles:

```text
/opt/handheld/runtime/                     OS launcher, server, installer
/var/lib/handheld/games/line-cutter/
  releases/0.3.0/                          complete installed package
    manifest.json                         identity/version/integrity inventory
    cover.png                             game-inspired cover art (title requested)
    play.html                             game-owned browser/input adapter
    line-cutter.js                        unchanged upstream game
    title-loop.mp3
    match-loop.mp3
    trailer-handheld.webm                 recorded gameplay, local/offline
  current -> releases/0.3.0                atomically selected active release
```

`GET /library` discovers installed manifests, never an upstream repo or catalog.
The generic launcher consumes package artwork and entrypoint; it contains no
Line Cutter-specific logic. `/games/<id>/<asset>` serves only inventoried files
from that game's active release. The package owns title/start/attract, its input
adapter, actual gameplay and all audio. Everything plays offline after install.

Manifest schema 1 has `id`, `version`, `runtime: web`, `entrypoint`, `artwork`, an
optional `attract` media asset (WebM/MP4 for inline discovery previews), capabilities/provenance metadata and a SHA-256
inventory. These are local integrity checks, **not publisher authentication or
signatures**. Use only trusted developer-built packages. Web games currently
share the kiosk origin/profile, so this is **not isolation for untrusted games**.

The installer bounds archive size/count, rejects traversal/symlinks/extra files,
and checks every hash before activation. It stages on the same filesystem,
retains prior releases and atomically replaces `current`. A failed validation
leaves the active install untouched. Identical reinstall is idempotent; reusing
a version with different bytes fails. Old releases are intentionally retained.
Adult catalog/download/install management is described below. There is no
automatic rollback UI, garbage collection, package signing or power-loss
durability guarantee yet. Atomic selector changes
protect against process interruption, not arbitrary storage failure.

### Build and install

From this repo on the prepared development host:

```sh
./vm.py fetch-games
./vm.py sync
./vm.py build-example
./vm.py install-game /mnt/data/vms/cubby-arcade/line-cutter-0.3.0.game.zip
./vm.py view
```

`games.lock.json` now pins the **complete upstream Line Cutter 0.3.0 package**
from `davidguttman/line-cutter`, including its full source commit, public immutable
HTTPS archive URL, byte size and SHA-256. The game, adapter, pinned SDK, audio,
cover and trailer are maintained/released by that repository, not rebuilt from
portfolio assets or this repo's legacy example wrapper.

`fetch-games` needs only public HTTPS access using Python's standard library; no
GitHub credential, FFmpeg or Node is needed for the current package. Verified
bytes stay in ignored `.cache/games`. `build-example` rechecks package integrity
and identity, then copies the exact archive to the VM state directory. It works
offline from a verified cache and cannot silently repackage different game bytes.
The older individual-asset lock format and `examples/line-cutter/` remain only for
legacy developer/test compatibility, not as the current game's release source.

`sync` updates **only OS runtime/services**, not packages or saves. Fresh bootstrap
starts with an empty pictorial library; install is explicit. New games supply the
same complete-package contract; the launcher contains no game-specific code.

### Controls and saves

Library: arrows/D-pad choose; A/Enter opens the selected game's detail preview. Play launches the game directly, without another trailer screen. Store: only games not yet in the Library can be selected. Owned games stay on the shelf as dimmed pictures with a check, and a finished download goes straight to its Library Play button. Gameplay: Z/Space=A, X=B,
arrows=D-pad, Enter/P=Start, M/right Shift=Select. Escape, Select+Start, or L1+R1 opens the
wordless system menu to resume or return to the library. Standard Gamepad API support still needs real-device mapping tests.

The 240×160 surfaces display at 480×320, centered on the 640×480 output.
Persistent saves remain in the existing guest user's WebKit profile, outside
all replaceable game directories. The origin stays `http://127.0.0.1:8080`, and
Line Cutter keeps its existing `linecutter_run` key: prior saves are preserved
without copying/resetting the profile. This example is compatible with existing
saves; the shared SDK provides per-game save namespaces for new games.

## ARM64 development VM

```sh
# First initialization only (existing disk/saves are preserved):
./vm.py init
./vm.py start
./vm.py sync
./vm.py status
./vm.py view
./vm.py screenshot
./vm.py key ret
./vm.py key esc
./vm.py ssh 'cat /var/lib/handheld/browser-report.json'
./vm.py stop
```

Uses QEMU `virt`, 4 Cortex-A55 CPUs, 2GB RAM, Debian 13 ARM64 and WPE/Cog/Weston.
Guest packages include GStreamer GL video sinks for the WPE media path. Existing
VMs made before video support need `./vm.py ssh 'sudo apt-get install -y
gstreamer1.0-gl'` once (from the pinned guest package snapshot).
VM software rendering is **not** an RG353V speed/GPU benchmark. Hardware graphics,
controls, audio latency, suspend and ROCKNIX integration need device validation.
No Node server, Docker or desktop changes. The guest uses a loopback Python server.
VNC is host loopback port 5907 and SSH port 12222, with a task-specific SSH key;
there is no public server or jump.sh URL. Forward VNC over SSH for remote access.

The executable uses `uv` with pinned utility dependencies. The prepared rootless
QEMU 11.1.2 toolchain is under `/mnt/data/vms/cubby-arcade/toolchain/root/usr`;
manifest/signature provenance is alongside it. Prerequisites are `uv`, `curl`,
`ssh`, `ssh-keygen`, `vncviewer`, plus QEMU ARM64/image tools/EDK2 firmware (system
or the prepared rootless toolchain), QEMU GPU/audio modules and host PipeWire/PA.
`CUBBY_ARCADE_FIRMWARE_DIR` overrides system EDK2 paths; `CUBBY_ARCADE_VM_DIR` overrides
artifact state. Fixed ports mean only one VM at a time.

Debian cloud image build 20261026-2643 is SHA-512 pinned in `vm.py`; signed guest
packages use snapshot 20261027T000000Z. Installed versions are recorded in
`/var/lib/handheld/packages.lock.tsv`. VM disks, keys, logs, screenshots, generated
packages and firmware state stay outside Git at `/mnt/data/vms/cubby-arcade`.
No host filesystem is mounted into the guest. Original VM migration preserved
its complete state from `/mnt/data/vms/david-app-handheld`; never replace a disk
to migrate saves. Inspect serial/bootstrap/session logs there and under
`/var/lib/handheld` for diagnostics; gameplay posts the browser report to `/report`.

## Verification

```sh
uv run python -m unittest discover -s tests -v
bash -n guest/bootstrap.sh guest/run-kiosk.sh
```

Tests cover pinned fetch/cache integrity, deterministic offline packaging,
OS/game bundle separation, install/update validation, invalid install preservation,
version immutability, traversal and manifest-only offline discovery/HTTP serving.
The trailer is included in deterministic offline builds and the integrity inventory.
The loopback server supports bounded single-byte-range requests so WPE can
seek packaged media without downloading external media. The title reopens
the local file on completion; native WPE loop seeking stalled in the VM. The original MP4 and a reduced
H.264 control stalled after initial frames; VP8/WebM was verified advancing.
Title diagnostics at `/report` include advancing media time, dimensions, ready
state and decode errors for VM verification. Actual device video performance
remains unverified; QEMU playback is not a handheld benchmark.

## Shared runtime core

`runtime/core/input.js` normalizes keyboard, pointer and standard Gamepad API
input for both WPE and ordinary browsers. Actions are `confirm`, `back`, `pause`,
`select`, directions and `exit`; events also carry the logical game button
(`a`, `b`, `start`, etc.) and source. Analog dead zones, directional repeat,
reconnect/neutral latching and listener teardown live here, not in individual
screens. A/Start confirms in launcher/title; Escape or L1+R1 exits gameplay.

`runtime/core/preferences.js` supplies `HandheldPreferences.preferences` (one
shared instance per page). Preferences live under `handheld:preferences:v1` in
host-origin/profile localStorage, separate from game saves; launcher, title and
game packages read the same values. A denied/unavailable store falls back to
session-only values. Controller visibility is always automatic: hidden on desktop,
shown for touch-capable devices or a coarse pointer. Legacy `on`/`off` values
normalize to `auto` without changing saved keyboard bindings. Controls react
immediately to pointer-capability changes; there is no manual visibility setting.

Adult Options UI API (load preferences before input/controls):

```js
const prefs = HandheldPreferences.preferences;
prefs.get(); // detached {touchOverlay: 'auto', keyboard: {up: ['ArrowUp'], …}}
const edit = prefs.editKeyboard();
const stopCapture = input.captureKeyboard(code => {
  // No navigation/game actions while capturing; rejects unknown physical codes.
  edit.setBinding('exit', [code]); // throws on conflicts/invalid codes
  stopCapture();
});
// edit.get(), edit.set(fullMap), edit.reset() only change the draft.
edit.apply(); // persists and updates all live input instances; edit.cancel() discards
prefs.reset(); // restore keyboard defaults
const unsubscribe = prefs.subscribe(value => { /* detached current value */ });
```

All nine logical buttons (`up/down/left/right/a/b/start/select/exit`) must have
1–16 unique physical `KeyboardEvent.code` bindings, with no key assigned twice.
`BUTTONS`, `DEFAULT_KEYBOARD`, `isKeyboardCode` and `validateKeyboard` are exported
for the remapping editor. Remapping is based on physical codes, not translated
key labels. Defaults preserve Z/Space, X, Enter/P, M/right Shift and Escape.
New mappings take effect without reload; old/captured held keys must release
before activating anything. Capture returns a cancellation function; always call
it on apply/cancel. It also suppresses pointer/gamepad actions until cancelled.
Inputs accept an optional `preferences` instance for embedding/tests, expose it
as `input.preferences`, and unsubscribe on disposal. SDK `createGameHost` forwards
that option. Other same-origin windows receive changes via the storage event.
Installed packages contain pinned copies, so existing old packages require an
explicit package update to adopt this preferences contract.

`runtime/core/platform.js` is the capability bridge. `createPlatform(options)`
accepts a library URL/fetch, storage and an optional native bridge. Web/WPE
share HTTP library loading and browser-profile saves. Desktop supplies a native
per-game save bridge; unsupported system controls are not advertised. Fullscreen is detected,
and unsupported install/volume/sleep capabilities stay false. Future desktop
hosts supply bridge methods without changing the launcher. `window.HandheldPlatformOptions`
can configure hosts before boot; these screens use the same default `/library`.

`runtime/core/sdk.js` owns input/lifecycle and a game-scoped JSON saves API.
New games use `host.saves.get/set/remove`; Line Cutter remains byte-for-byte
upstream and uses its existing storage internally. Its explicit compatibility
alias maps `run` to `linecutter_run`, preserving old saves at the existing origin.
Games may bundle optional input/lifecycle/save SDK modules, checksummed with the
package. Those game-owned SDK bytes still change only with a versioned game
update. **The on-screen controller is not part of that SDK contract.** Cubby
loads `runtime/core/host-osd.js` and `host-osd.css` before game scripts at the
browser-worker, desktop-protocol and WPE delivery boundaries. Installed package
bytes remain unchanged. The OSD lives in an isolated host-owned Shadow DOM and
presents a standard virtual controller through `navigator.getGamepads()`; games
need no OSD module or Cubby-specific input API. Old bundled `createControls`
calls become no-ops only while hosted, preventing duplicate overlays.

The host-owned touch deck places a compact cross-shaped D-pad on the left and a
lettered Xbox face-button diamond on the right (Y top, X left, B right, A bottom).
Adjacent circular buttons sit roughly 5px apart without shrinking touch targets.
L/R shoulder buttons sit in a separate row above the clusters. Select (−) and
Start (+) sit
below; Exit remains separate in the upper-left.
Pointer presses emit the matching logical button; standard browser gamepads
retain A/B on indices 0/1 and provide X/Y on indices 2/3 and L/R on indices 4/5.
The hub still uses shoulders to switch views; pressing both consumes individual
shoulder input and opens the system menu. Existing keyboard preferences are
unchanged; X/Y and L/R are available through touch or gamepad.
The host reserves screen space for the `.screen`/`canvas#screen`/`canvas.library`
layout conventions. Shadow DOM isolates controls and styles, not the browser
viewport: arbitrary games that calculate their layout from `innerHeight` still
need responsive canvas sizing. Hidden controls restore the normal viewport.
Targets stay at least 44px. `tests/fixtures/host-osd.html` checks a plain Gamepad
API consumer, or `?legacy` checks an unchanged legacy input/overlay consumer.
Call `verifyHostOSD()` in the browser after loading beside `/runtime/core/`.

Run shared input/platform/lifecycle regression tests with
`node --test tests/shared_core.cjs` or `uv run python -m unittest discover -s tests`.

## Web host: same launcher and packages

```sh
uv run python web.py build
jump.sh start cubby-arcade --json
```

The local development preview is https://cubby-arcade.davidguttman.jump.sh .
The public browser app and package registry use https://cubby.david.app .
Check `jump.sh ls --json` for current status rather than assuming it is running.
The repo's compose file runs only a Python static preview; Jump owns its lifecycle
and HTTPS routing. Re-run the build after editing shared code/package sources.
`web.py build path/to/game.game.zip ...` exports any explicitly selected trusted
packages to Store routes after the same installer validation. The default build
exports only the launcher and discovery pointers, with an empty Library and no
game payloads. Generated `.cache/web` is ignored, not checked in.

The export copies `runtime/index.html` and shared core bytes, never preinstalled
`/games/<id>/` assets. It is not a second launcher. Package changes are released
by their game repository; native and browser hosts install validated releases through the Store. A browser's saves stay
local to its HTTPS origin/profile; they are not synced to the VM or another host.

Library arrow pictures select, the play picture opens the title/trailer, and
its play picture starts the game. A back-arrow picture returns. Gameplay has
pictorial pointer/touch controls alongside keyboard and standard browser gamepads.
New games should draw their own input demonstrations instead of written instructions.
All surfaces fit narrow screens without scrolling. These controls are also shared
with WPE; the 240×160 content remains centered at up to 480×320 on 640×480.
The web preview is for UX testing, not RG353V hardware/performance validation.


## Desktop / Steam host

### Windows (adult setup)

The landing-page download defaults to Windows (including without JavaScript),
switching to Linux for desktop Linux user agents, not Android. Both CTAs target
the latest release's stable platform filenames `CubbyArcade-win32-x64.zip` and
`CubbyArcade-linux-x64.tar.gz`. The desktop release workflow publishes both
automatically, together with their SHA-256 checksum files.

### Automatic product releases (adult/developer flow)

Bump the shared product version in `package.json` and `package-lock.json`
according to SemVer, commit, then push `main` once. **Cubby builds and releases**
builds on native Windows and Linux runners, runs packaged
install/update/play/offline and uninstall/save-retention smokes, and signs the
handheld app update from the same commit and version.
Only after **both** platform jobs succeed does its publishing job create the
matching `vX.Y.Z` tag and draft GitHub Release, upload all seven assets, verify
every remote asset's size and SHA-256 digest, then publish the complete release
and advance the signed handheld feed. The landing-page download links follow
the latest release without source edits or manual uploads. After the commit's
checks succeed, Render automatically deploys the website and cloud launcher
used by desktop apps from `main`; no separate tag push or manual deploy is
needed. A handheld installs the published update only when an adult chooses
the gear tab's updates tile. No npm, app-store or executable self-update
publication is involved. See [release details and retries](docs/releases.md).

Main pushes without a version bump still run checks/builds and deploy the
website after checks pass, but never overwrite a published platform release.
New platform artifacts require a new version. Matching tag pushes and manual
runs on `main` can retry publication; other branches only build/test.

An upload failure leaves an unpublished draft, never a half-complete latest
release. Matching reruns can resume missing uploads; differing draft assets
are rejected rather than overwritten (inspect and remove only that failed
draft before retrying if new builds produce different bytes). Published
release assets are immutable: a rerun must match every archive and checksum.

Windows 10/11 x64 uses the same launcher, Store, controller input and offline
game library as Linux. Download the portable
[`CubbyArcade-win32-x64.zip`](https://github.com/davidguttman/cubby-arcade/releases/latest/download/CubbyArcade-win32-x64.zip)
from the [latest GitHub Release](https://github.com/davidguttman/cubby-arcade/releases/latest).
Extract **the entire ZIP**, then
open `CubbyArcade-win32-x64/CubbyArcade.exe`; moving only the EXE will not work.
No Python, Node, administrator access or Developer Mode is needed to play or
install games. There is no installer. This build is unsigned; no code-signing or
Microsoft Store certification is claimed.

Saves, downloaded games, settings and tokens live outside the extracted folder,
normally under `%APPDATA%/CubbyArcade`. Existing recognized legacy profiles are
preserved. Replacing the application folder does not reset that profile.
Desktop game selectors use atomic regular files, with legacy Linux symlink
selectors still readable. Game package bytes are unchanged.

Developers can build the complete Windows folder and ZIP on Windows or Linux:

```sh
npm ci
npm run desktop:build:windows
# dist/CubbyArcade-win32-x64/CubbyArcade.exe
# dist/CubbyArcade-win32-x64.zip and .zip.sha256
```

Building requires `uv` and Node; running the packaged app does not. The Windows
desktop GitHub Actions job tests the installer and runs the packaged EXE through
isolated install/update/play/offline and uninstall/save-retention smokes. Its
screenshots and JSON reports are separate build artifacts. A Linux cross-build
alone is not evidence of native Windows behavior.

The Electron shell opens the same exported launcher and validated game assets;
it does not run a Node HTTP server or create another launcher implementation.
Electron and the packaging tool are pinned in `package-lock.json`.

```sh
npm ci
npm run desktop:prepare
npm run desktop:start
npm run desktop:build
# Result: dist/CubbyArcade-linux-x64/CubbyArcade
# Archive: dist/CubbyArcade-linux-x64.tar.gz and .tar.gz.sha256
```

The Linux x64 folder is a self-contained local distribution (runtime and games
included). Add its `CubbyArcade` executable as a non-Steam game to open one
fullscreen hub. In Steam, use **Games → Add a Non-Steam Game → Browse**, select that executable, then **Properties → Controller → Enable Steam Input** and the **Gamepad** template. Leave forced compatibility/Proton disabled for this native Linux build; keep the entire distribution folder intact. Steam account integration, Steam Cloud, achievements, store
publishing and Steam Deck verification are **not** implemented or claimed.
macOS packaging and physical controller behavior remain unverified.
Standard keyboard/Gamepad API/pictorial controls are the shared implementations.
Exit using the pictorial power control in Settings and its cancel/confirm pictures,
or the window-manager/Steam close action (e.g. Alt+F4). The child UI has no text menus. Blur suppresses input, suspends the game loop/audio and pauses
video; focus resumes. Existing gameplay state is retained within that session.

The `hub://app` protocol reads the generated launcher export and serves media byte
ranges, without opening a network listener. With a managed games directory it
discovers installed releases and serves only manifest-inventoried assets from
their active selectors (see catalog commands below). Node integration is disabled in
renderers, with context isolation and renderer sandbox enabled. The isolated
preload exposes only game-scoped JSON saves; the main process validates sender
origin, top-level frame, game scope, key and size. This is not an arbitrary-game
sandbox: installed developer packages still share an origin/profile.

SDK saves use `<Electron userData>/saves/<game>/<key>.json`, atomically written
outside package assets. Native bridge calls are synchronous to preserve the
existing SDK API. Explicit legacy aliases can migrate old browser saves on read.
Unchanged Line Cutter still writes its original localStorage internally, so its
legacy progress stays in the desktop browser profile; it is not automatically
mirrored to disk JSON or Steam Cloud. Web/VM profiles remain separate and untouched.

Run isolated, self-terminating smoke checks without using the live VM profile:

```sh
CUBBY_ARCADE_USER_DATA=/tmp/cubby-arcade-desktop-test CUBBY_ARCADE_SMOKE_DIR=/tmp/cubby-arcade-desktop-evidence npm run desktop:smoke -- --ozone-platform=x11 --disable-gpu
```

Smoke mode uses a hidden offscreen window and exits itself (X11 is needed for
full-size screenshots on this host; headless Ozone can return a 1×1 capture); it checks local library,
trailer playback, native saves and absent renderer Node APIs, writing screenshots
and `report.json` when `CUBBY_ARCADE_SMOKE_DIR` is set. Without `CUBBY_ARCADE_USER_DATA`, smoke mode
uses a dedicated temporary-directory profile, not the real app profile. The same
`--smoke` arguments work with the built executable. No Steam credentials or App ID
are required. Rebuild the web export and desktop bundle after package updates;
OS/VM package installation is still explicit.

## Adult catalog and install management

`runtime.catalog` is the adult/developer management CLI, not a child-facing
store screen. It runs on the host or handheld; there is no public write endpoint,
no extra child text, no account/payment system and no production catalog yet.
The static browser host installs schema-2 web game files into Cache Storage, with
IndexedDB atomically selecting the verified active release. A root service worker
serves installed files and caches the launcher for offline play. Installation
requires HTTPS, service workers, IndexedDB and site storage. Publisher downloads
must allow CORS. No application server is required. Browser installs are local
to the current origin/profile; clearing site data removes them. Browsers may
evict storage despite the best-effort persistence request. Uninstall uses the
same Cancel-default confirmation as native, removes managed releases, and keeps
saves and favorites. Native game files are not installed into a browser.

The browser hub checks installed, still-listed games on entry, every five minutes
while the tab is visible, and when visibility or connectivity returns. Background
tabs may have their timers throttled; closing/navigating away from the hub stops
checks and cancels its pending update work. Returning via browser Back restarts
the hub and checks. Each check fetches the current catalog and stable manifests;
an unchanged release identity does not download game files again. A complete new
release is verified in a private cache before an IndexedDB transaction switches
the active release. Existing game tabs retain their old, version-isolated URLs,
so an update never reloads a running game or mixes its assets. Failed/offline
checks keep the current release and saves; a later check retries. There is no
background-service update promise when the hub is closed, and browser storage
eviction remains possible.

A schema-1 catalog contains `games`, one entry per game, with `id`, `version`,
adult `title`, HTTPS package `url`, exact compressed `size` and `sha256`.
`list` validates the full catalog; `install` downloads to temporary storage,
checks size/hash and catalog/archive identity, validates every inventory entry,
then atomically activates the versioned release using the existing installer.
`update` requires an already installed game and selects the version in the
chosen catalog; it does not guess version ordering or silently choose a catalog.
Previous releases remain available on disk. Bad downloads/archives leave the
active release unchanged. `remove` removes only the named game's package folder;
SDK saves, legacy localStorage and browser profiles are never removed.

HTTPS is required by default. Catalogs are limited to 1 MiB, packages to 128 MiB,
with exact expected size/hash, 20-second request timeouts, 120-second transfer
deadlines, and at most three redirects (no redirect to a file). The explicit
`--developer-local` flag additionally allows file URIs and loopback-only HTTP
for development. It does not allow arbitrary plain-HTTP hosts.

Create an offline example catalog and manage a disposable desktop profile:

```sh
./vm.py build-example
uv run python -m runtime.catalog create /mnt/data/vms/cubby-arcade/line-cutter-0.3.0.game.zip --output .cache/catalog/catalog.json
uv run python -m runtime.catalog --developer-local list "file://$PWD/.cache/catalog/catalog.json"
uv run python -m runtime.catalog --developer-local --root .cache/desktop-profile/games install "file://$PWD/.cache/catalog/catalog.json" line-cutter
CUBBY_ARCADE_USER_DATA="$PWD/.cache/desktop-profile" npm run desktop:start
# After publishing a newer version into the selected catalog:
uv run python -m runtime.catalog --developer-local --root .cache/desktop-profile/games update "file://$PWD/.cache/catalog/catalog.json" line-cutter
uv run python -m runtime.catalog --root .cache/desktop-profile/games installed
uv run python -m runtime.catalog --root .cache/desktop-profile/games remove line-cutter
```

A fresh desktop starts with an empty Library. Explicit Store or CLI installs
are stored in `<userData>/games`, which is the **entire** game library, including
when empty. Existing installs and saves remain intact; no bundled copies are
imported or used as a fallback. `CUBBY_ARCADE_GAMES_DIR` can explicitly select
another managed directory (create it before launching).
The launcher/core still come from the app export; game bytes come from installed
releases. Close/reopen a library page after management changes to refresh it.
Run management operations serially and close a running game before updating or
removing it. The desktop app does not need Python to play installed games; adult
management currently uses the separate Python CLI.

For a hosted trusted catalog, publish the created archives and catalog together:

```sh
uv run python -m runtime.catalog create path/to/game.game.zip --output .cache/publish/catalog.json --base-url https://your-host.example/games/
uv run python -m runtime.catalog --root path/to/installed-games install https://your-host.example/games/catalog.json line-cutter
```

On the VM, `./vm.py sync` copies the management module without touching games or
saves. Then use `./vm.py ssh 'cd /opt/handheld && sudo python3 -m runtime.catalog list https://your-host.example/games/catalog.json'`, or replace `list` with
`install <catalog-url> <game-id>`, `update ...` or `remove <game-id>`.
The guest defaults to `/var/lib/handheld/games`; restart `handheld-kiosk` or return
to a fresh library page after changes. Existing `./vm.py install-game <archive>`
remains the offline side-loading path for an already downloaded archive.

These are **trusted developer catalogs/packages**. HTTPS and hashes detect
transport/corruption mistakes; they are not publisher authentication or game
isolation. Games still share an origin/profile. Production signing, third-party
trust, permissions and publisher onboarding remain separate work, not claims of
this example. Browser and native installation use separate storage adapters with
the same release integrity checks; browser downloads currently require schema-2
file manifests rather than legacy ZIP releases.

### Store registry and stable release manifests

Native installation also accepts **schema-2 file manifests**, without ZIPs:
see [Game-owned releases](docs/game-release-manifest.md) for the contract and
single-release workflow. Schema-1 ZIP releases below remain compatible.

`web.py build` exports both the playable web preview and a hosted registry. The
public root defaults to `https://cubby.david.app`; override it
with `--base-url https://your-host.example/`. All advertised media, manifests,
and ZIP archives are written into the selected export, not just referenced.

Registry `/catalog` is a JSON array. A game entry contains `id`, adult `title`,
`manifest_url`, `artwork`, optional `attract` (trailer), and `screenshots` (array).
Discovery URLs are absolute HTTPS URLs independent of the installed `/games/`
assets. Browsing never follows the manifest or downloads a game archive.

The stable `/store/<id>/manifest.json` describes the currently offered release:

```json
{
  "schema_version": 1,
  "id": "line-cutter",
  "version": "0.2.0",
  "runtime": "web",
  "entrypoint": "play.html",
  "package": {
    "url": "https://cubby.david.app/store/line-cutter/0.2.0/line-cutter-0.2.0.game.zip",
    "size": 12345,
    "sha256": "<64 lowercase hexadecimal characters>"
  }
}
```

`size` above is illustrative; generated manifests contain the exact ZIP byte
count and checksum. The ZIP's own `manifest.json` inventories every file and
must match the release's identity, version, runtime, and entrypoint. Release
manifests are bounded to 256 KiB and use the same HTTPS/explicit-local transport
rules as the legacy catalog. This is a trusted-developer web runtime, not an
arbitrary executable installer or cryptographic publisher-authentication scheme.

To add or update a game on the existing generated host:

```sh
uv run python -m runtime.publishing path/to/new-version.game.zip --output .cache/web --base-url https://cubby.david.app/
```

This command validates before publishing, creates immutable versioned archive
and media files, then atomically replaces that game's stable manifest. Adding
a game adds one registry entry and refreshes the shell's catalog hash. Updating
an existing game preserves the registry bytes, original discovery media URLs,
and every previous version. A conflicting same-version payload is rejected;
use a new version for changed bytes. Cooperating publishers are serialized.
Publication writes **only the selected local static directory**: serve it with
the existing Jump project or deploy it separately; it does not upload to a CDN.
`web.py build` regenerates the preview from its explicit package list; use the
publish command, not a rebuild, to retain previously published versions/games.

The existing management CLI accepts either this registry or the legacy schema-1
inline catalog without breaking old callers:

```sh
uv run python -m runtime.catalog list https://cubby.david.app/catalog
uv run python -m runtime.catalog --root path/to/games install https://cubby.david.app/catalog line-cutter
```

Installation/update resolves the stable manifest at the time of the operation.
Game launch accounting, native automatic update scheduling, and child-facing
install controls are separate from this publication protocol; publication and
installation themselves never spend tokens.

### Library, discovery, and options

The shared hub starts on a **cover grid**, not a detail screen. Pointer hover,
keyboard/controller focus, or tapping a cover opens the actual packaged trailer,
a persistent favorite star, and a play control. Favorites are a binary preference,
not a rating. The library, shopping-bag discovery tab, and gear options tab use
pictures only; R1/RB cycles forward and L1/LB backward through these tabs, wrapping
at either end. Shoulders do not switch views in games or while a dialog/capture is open.
The desktop Settings power picture quits the hub after pictorial confirmation;
unsupported web/VM hosts do not show it. Accessible names are available to assistive technology.

The static/cloud `/catalog` is a **store registry**, separate from `/library`.
Entries advertise a stable manifest URL and remotely hosted cover, trailer, and
optional screenshots, so discovery does not depend on installing the game.
The VM's local catalog still reflects installed packages. The desktop can browse
the hosted registry and provides pictorial one-button installation through its
native adapter. Uninstalled entries show a download action, then become playable
after installation. Unsupported browser/VM hosts require the adult CLI.

Options use three touch-control modes: automatic detection, always shown, and
hidden. These control the game/title overlays; the hub's own large navigation and
action buttons remain usable with a pointer regardless of that setting. The
keyboard/person pictogram opens a separate **Adult setup** dialog. It captures
physical keys for all nine logical controls, rejects duplicate bindings, and has
explicit Save, Cancel, Reset keys, and Cancel capture actions. Draft edits never
change live controls until saved. Adult text is confined to that dialog.

`--smoke` now also exercises the actual rendered hub (grid/hover/favorites,
discovery/options, key capture and draft cancellation). It briefly shows and
focuses its window because key capture intentionally cannot run in a hidden,
unfocused window.

The Line Cutter cover is ImageGen-created pixel-art key art, based on the actual
gameplay trailer palette and archery theme. It replaces the generic SVG target;
the cover includes the explicitly requested LINE CUTTER title, with the arrowhead fully buried in the target, and is not represented as a gameplay screenshot. The earlier wordless version is preserved as `cover-wordless.png`.


### System-owned game menu

Games do not need a Quit button or SDK to return to the library. Every host
injects `/runtime/core/game-shell.js` into served game HTML **before game
scripts**, leaving installed archives and their checksums unchanged.

- **Keyboard:** Escape opens the wordless menu. Escape again resumes; arrows
  select the play/resume or grid/library picture, Enter confirms.
- **Controller:** Select + Start opens the menu (L1 + R1 is also supported).
  Release the shortcut, choose with left/right, A confirms, B resumes.
- **Touch:** the pictorial menu button follows Options → touch visibility.
  It remains outside the game's UI; no reading is required.

SDK games pause while this menu is open, and resume only when dismissed.
Non-SDK games still have blocked keyboard/pointer/controller input and a reliable
route out, but may keep simulating or playing audio behind the menu. This is not
a browser/process-crash recovery mechanism, nor a sandbox against malicious games.
The shared-origin catalog continues to require trusted developer game packages.

### Cloud-backed desktop launcher

The desktop executable is a thin, sandboxed shell. On launch it requests
`https://cubby.david.app/hub-manifest.json`, downloads the small
launcher UI/core/catalog snapshot, verifies its size/hash inventory, and caches
it coherently before opening the hub. Rebuilding/publishing the web export is
all that is needed to deliver launcher/store UI changes on the next app launch.
There is no binary self-updater, update menu, mid-game reload, or restart loop.

The internal `hub://app` origin remains stable, preserving browser preferences,
favorites, and legacy localStorage. `/library`, `/games/`, and native SDK saves
remain local. Shell refreshes do not download or update game packages. Independently,
the native installer checks installed games' stable manifests on hub entry,
downloads updates in the background, and activates them only while in the hub.
Installed-game previews work offline; store media for uninstalled games requires
connectivity. A failed or incompatible refresh retains the last verified cached
shell; first-run offline falls back to the bundled shell. Startup network work
has a five-second total deadline. The current shell stays fixed for that process.

The HTTPS cloud host is trusted to supply launcher JavaScript, but never gets
Node access or arbitrary filesystem/native bridge access. `bridge_version: 1`
is the compatibility gate; future native-runtime changes still require a new
executable. The default browser preview/catalog host is Render at
https://cubby.david.app; the local Jump preview is a separate adult
development override, not the desktop default.
`CUBBY_ARCADE_CLOUD_ORIGIN` can select another HTTPS root for adult deployment/testing.
For the built-executable offline smoke only, `CUBBY_ARCADE_SMOKE_OFFLINE=1` simulates a
network failure while keeping the same origin/profile and cache.

### Desktop downloads and automatic game updates

The desktop bridge exposes installation only to the main launcher frame. A Store
entry with a release manifest gets a pictorial download control; downloading
shows progress and disables duplicate requests, and an interrupted download shows
a retry picture. Installed games appear in Library and retain offline play.
Unsupported browser/VM hosts do not pretend to install packages.

The native host resolves the selected ID from its validated catalog, fetches its
HTTPS release manifest and archive, verifies compressed size/SHA-256 and every
inventory file, and rejects unsupported runtimes, identity mismatches, ZIP path
traversal, duplicate/unlisted files, directories, symlinks, and oversized content.
It requires no system Python. A pristine desktop starts with an empty Library.
Only an explicit Store install adds a game; launchers never import bundled games.
Existing disk installs and separate saves remain authoritative and are not deleted.

Every return to the hub checks installed games' stable manifest URLs in the
background. Downloads may finish during gameplay, but activation waits until the
native window has returned to the hub. Previous releases and separate saves are
retained; failed or offline checks leave the current game playable. Downloads
and updates do not charge tokens. Native capabilities are optional, so the shared
shell remains compatible with bridge-version-1 hosts that lack installation.

Run the native archive regressions with:

```sh
node --test tests/desktop_installer.cjs
```

The self-terminating `--install-smoke` option additionally accepts an isolated
`CUBBY_ARCADE_USER_DATA`, a freshly generated `CUBBY_ARCADE_SMOKE_SITE`, and
`CUBBY_ARCADE_SMOKE_INSTALL_DIR` containing `demo-1.zip` and `demo-2.zip` fixture packages
(ID `demo`, entrypoint `index.html`). It exercises the real Electron IPC and UI
with HTTPS fetch fixtures, without running a server. `CUBBY_ARCADE_SMOKE_DIR` captures
retry/progress/installed/mobile evidence. Keep fixture profiles separate from
family/test profiles; this smoke installs its demo and stages updates.

### Family arcade trial: one token per launch

The desktop's local test profile starts with **10 tokens once**. Starting an
installed game spends one token after its main document loads successfully.
There is no play timer: pause, resume, focus changes, and reloading the current
game do not spend more. Returning to the hub ends that play; launching again
spends another token. Downloads and updates are free. A missing game, failed
load, or exhausted budget cannot spend a token. Rapid duplicate activation shares
one launch. The native window also handles older cached UIs that navigate directly
to a game; renderer-side localStorage cannot refill the native account.

The hub displays countable coin pictures and a one-coin Play control. At zero,
Play is disabled. Options → keyboard/person picture opens the separate **Adult
setup** flow; **Add 10 test tokens** replenishes this profile. This deliberate
adult entry is a test management flow, not parental authentication or a PIN lock.
The browser/VM preview without native token capability remains a free demo and
does not pretend to enforce this budget.

The native account lives in `account.json` under Electron's user-data directory,
separate from game saves and installed releases. Atomic writes and a single
application writer per profile preserve the balance across restarts. Corrupt or
unreadable account data fails closed without silently issuing another ten tokens;
preserve it for adult diagnosis. Charging happens only after a successful load,
so an interrupted launch before completion does not lose a token. This trial has
no server account, cross-device sync, real-money checkout, creator payouts, or
anti-tampering guarantees against someone with access to the profile files.

For family testing:

1. Build/install the new desktop executable once (`npm run desktop:build`), and
   add `dist/CubbyArcade-linux-x64/CubbyArcade` as a non-Steam game. Existing native
   executables need replacement for the new installer and token bridge.
2. Children browse the Store, download games for free, and spend a token to play.
3. Publish a new game/release to the directory served by the configured HTTPS
   host (the local Jump preview serves `.cache/web`):

   ```sh
   uv run python -m runtime.publishing new-release.game.zip --output .cache/web --base-url https://cubby.david.app/
   ```

   Existing installed games check their stable manifest on hub entry, download
   updates in the background, and activate only outside gameplay. Publishing
   updates is independent of rebuilding the desktop. This command writes the
   selected local served directory; it is not a remote uploader. An explicit
   `web.py build` replaces its generated export, so include all desired packages
   when rebuilding or use the incremental publishing command above.

Versioning uses SemVer: new backward-compatible product/distribution capabilities
are minor releases; fixes to an existing capability are patches; breaking runtime
or install contracts require a major release. Game package versions are immutable:
any changed bundled core or asset requires a distinct game version. This build is
**0.11.0**, adding the RG353V runtime, required adult Wi-Fi onboarding, USB
diagnostics, and signed app updates with rollback. Physical handheld profiles
suppress the touchscreen deck; ordinary browsers retain automatic touch detection.
The 0.10.1 release fixed Back navigation in Library and Store: the selected
game's preview, actions, and playing trailer stay visible while focus returns to
the game shelf, then the current section tab. The 0.10.0 release added a portable
Windows x64 build, versionless platform download links, and automatic dual-platform GitHub Releases after native
Windows and Linux verification. The 0.9.0 release added browser hub checks for
installed game updates on entry, every five minutes while visible, and when visibility or connectivity
returns. Unchanged releases fetch metadata only; complete verified releases
activate atomically while already-running games keep their original isolated
assets. Offline or failed checks preserve the installed release and saves.
The 0.8.3 release made nonempty libraries select a game and show its preview and Play
control by default. Library refreshes preserve a valid selection or select a
remaining game; Back now retains the selected-card highlight and its
preview/actions. No game payloads changed. Touch controls always follow device detection; the manual
selector is removed and legacy on/off preferences normalize to automatic.
Empty libraries start on Store, Store opens its first game's
preview and controls automatically, and Trail Mix is first in the catalog.
Manual tab choices remain intact during startup. The 0.8.0 release made the
on-screen controller a Cubby-owned host module
that supplies standard virtual gamepad input. Existing game packages work
unchanged: legacy bundled overlays are suppressed without rewriting installed
bytes. OSD layout, visibility and lifecycle updates require only a Cubby update,
never a game release. The 0.7.0 release introduced the compact Xbox-style deck,
separate L/R shoulders, +/− controls, and physical X/Y/L/R input support. The 0.6.0 release
added browser installation, offline play, save-preserving uninstall, and
continuous install progress animation on the static site. The
0.5.1 release corrected static hosting and the canonical cloud origin after
0.5.0 added Store-only game discovery and save-preserving uninstall
with a pictorial confirmation. Fresh libraries contain no bundled games; Line
Cutter and Trail Mix are installed explicitly from their game-owned publishers.
Domain-free relative download URLs for file and ZIP releases remain supported,
alongside absolute URLs. Replace older desktop executables to use uninstall and
relative-path game manifests. Historical hosted archives remain available for
compatibility, not as a fresh-library seed. No external store release or hardware
certification is implied by local packaging.

Run native budget tests with `node --test tests/launch_tokens.cjs`. The isolated
`--token-smoke` executable mode verifies the actual pictorial UI, duplicate launch,
10 → 9 → 8 spending, free resume/reload, failed launch, legacy navigation, zero
balance, adult refill, and disk persistence. A fresh smoke profile first verifies
an empty Library, then explicitly installs the first Store offer through the
normal verified installer before the budget checks. Store download access is
required even when `CUBBY_ARCADE_SMOKE_OFFLINE=1` disables cloud-shell refresh.
Use a fresh `CUBBY_ARCADE_USER_DATA` profile,
`CUBBY_ARCADE_SMOKE_SITE` pointing to a newly generated export, `CUBBY_ARCADE_SMOKE_OFFLINE=1`, and
optional `CUBBY_ARCADE_SMOKE_DIR` for screenshots. A second run with the same profile and
`CUBBY_ARCADE_TOKEN_RESTART_EXPECT=9` verifies persistence across actual process restarts.
Never use smoke modes with a family profile.

For game-owned, ZIP-free releases, see [the standalone manifest generator and
single release workflow](docs/game-release-manifest.md#generate-in-the-games-repository).
The desktop and adult catalog CLI accept schema-2 per-file manifests while
retaining compatibility with existing ZIP releases.


### Public website and game-author specifications

The adult-facing landing page at `https://cubby.david.app/` links to the
[game-author guide](docs/game-authoring.md), the
[file release specification](docs/game-release-manifest.md), browsable HTML
copies, and a downloadable standalone generator. The wordless launcher remains
separate; `/play` is the free browser demo on the public deployment.

`web.py build` exports website assets under `site/`, documentation under `docs/`,
and `tools/cubby_manifest.py`. Its physical `index.html` remains the native hub,
with an identical `native/index.html` transport alias. `hosting/build.py` makes
the production root `index.html` the landing page; the native transport file stays
unchanged. Render Static Site rewrites `/play` and `/play/` to that physical native
file, while `/` and `/index.html` serve the landing page directly. Do not replace the native
shell inventory with landing-page bytes. The current desktop fetches that native
route first, verifies its inventory hash, and falls back to `/index.html` only for
legacy hosts. Older desktop clients that request the now-public `/index.html`
reject its mismatching hash and use their previously verified cache or bundle;
they never install the landing page as the launcher. Browser demo return-to-home
returns to the browser hub at `/play`; the native app returns to its wordless hub.
The root Jump/VM preview may continue showing the hub until its adapter adopts
these routes; this does not change the installed launcher or children's UI.

## Source-hosted cloud deployment and independent game updates

Render automatically deploys source `main` after its checks pass, using
`branch: main` and `autoDeployTrigger: checksPass` in the checked-in `render.yaml`.
The static build is:

```sh
uv run python hosting/build.py
# Render build: python3 -m pip install -r requirements.txt && python3 hosting/build.py
# Render Static Site publish directory: .cache/web
# No start command or runtime server
```

The build uses pinned PyYAML for the hand-authored Store catalog and fetches/verifies the historical pinned upstream archive, exports
the launcher with an empty Library, and lists only Line Cutter and Trail Mix in
the Store. It keeps all immutable previously published releases (including the
unlisted Little Camp) for existing clients. `hosting/releases/` contains the exact historical distribution
archives, not editable game source. Their size/hash/provenance inventory is
`hosting/releases.json`; old package and media URLs remain byte-identical.
Render serves `.cache/web` from its Static Site CDN, with the routes, CORS, JSON
content types and cache headers declared in `render.yaml`. Python runs only at
build time. There is no request-time process, cold-starting web service or API
server. `hosting/serve.py` remains a local development/test adapter, not the
production host.

New exports advertise Line Cutter's independent stable manifest:
`https://linecutter.david.app/store/line-cutter/manifest.json`. The previous Cubby
stable URL `/store/line-cutter/manifest.json` is a compatibility snapshot generated
at Cubby build time. The build downloads bounded metadata, validates identity and
integrity fields, resolves relative paths against the final publisher URL, and
fails if that metadata cannot be safely exported. This legacy endpoint refreshes
only when Cubby is deployed; it is not a live proxy. Current catalogs point at the
game-owned stable URLs directly, so normal game updates still need no Cubby build.
Former versioned ZIP/media URLs stay byte-identical. Little Camp is unlisted.
No private forwarding map is generated or required.

Line Cutter 0.3.0 is retained as a historical hosted ZIP, not
a requirement for new releases. New game-owned releases use the ZIP-free schema-2
file manifest and single GitHub-release workflow documented above.
That seed lock does not pin the updater: future Line Cutter releases need no new
ZIP, `games.lock.json` edit, or Cubby release.

`web.py build` exports a shell-only fallback with the reviewed pointers in
`hosting/catalog.yaml` (parsed with `yaml.safe_load` and registry validation; generated
`/catalog` remains JSON): no payload download, no `games/`, no Store archives in
the desktop bundle, and `library` is always empty. Explicit package arguments
publish those packages to Store routes only; they never preinstall them. Browser
previews show discovery metadata; installation requires a capable native host.
Native game updates resolve the publisher manifest independently on hub entry
and activate outside gameplay. Updating Line Cutter does not require a Cubby
launcher release. Existing game IDs, origins, storage keys and tokens are unchanged.

Trail Mix owns its schema-2 releases at `https://trailmix.david.app`.
The Store follows its stable `/arcade/manifest.json` pointer and uses
`/discovery/cover.png` and `/discovery/trailer.webm` for discovery media.
The publisher manifest selects immutable versioned files; Cubby neither embeds
nor pins a Trail Mix payload. Future game releases need no launcher release.
`hosting/releases.json` retains only previously published historical archives;
the unpublished temporary Trail Mix archive has been removed.
Never rebuild or edit game bytes inside the launcher repository.

Build dependencies are pinned in `pyproject.toml` / `uv.lock`. Regenerate Render’s
`requirements.txt` with `uv export --locked --no-dev --no-hashes --no-emit-project --output-file requirements.txt`.
Production serving is Render Static Site CDN delivery; no Python is running there.

### Uninstalling installed games

Native game previews include a separate trash control. It opens a picture-only
confirmation showing that game's cover. Cancel is initially selected; Back/Escape
also cancels. Removing a game deletes its managed downloaded releases, not saves,
favorites, settings, or tokens. The Store offers it for installation again, and
reinstallation picks up the retained saves. Removal is unavailable during a launch,
an install/update, or gameplay. Discovery-only web and older native bridges do not
show an unsupported uninstall control.

An isolated offline native smoke uses the checked-in historical test package and
checks cancellation/default focus/repeat protection, failure/retry, actual IPC
removal and reinstall, save retention, and game-frame rejection:

```bash
uv run python web.py build --output /tmp/cubby-uninstall-site
CUBBY_ARCADE_USER_DATA="$(mktemp -d /tmp/cubby-uninstall-profile-XXXXXX)" \
  CUBBY_ARCADE_SMOKE_SITE=/tmp/cubby-uninstall-site \
  CUBBY_ARCADE_SMOKE_DIR=/tmp/cubby-uninstall-evidence \
  ./node_modules/.bin/electron . --uninstall-smoke --ozone-platform=x11 --disable-gpu
```

Never run smoke modes against a family profile. The smoke captures desktop and
narrow confirmation screenshots plus a JSON report in `CUBBY_ARCADE_SMOKE_DIR`.

For a packaged `--uninstall-smoke` run, set
`CUBBY_ARCADE_SMOKE_UNINSTALL_PACKAGE` to the absolute path of the historical
`hosting/releases/line-cutter/0.2.1/line-cutter-0.2.1.game.zip` fixture. The desktop
distribution does not contain that game archive.

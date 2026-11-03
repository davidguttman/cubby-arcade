# Cubby Arcade

An independent home for Linux/OS integration, a picture-first launcher, and the
ARM64 development VM. Not a flashable RG353V OS; do not flash its QEMU disk.

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

Library: arrows/D-pad choose; A/Enter opens the selected game's detail preview. Play launches the game directly, without another trailer screen. Gameplay: Z/Space=A, X=B,
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
session-only values. Defaults hide the controller overlay on desktop; `auto`
shows it for touch-capable devices or a coarse pointer, `on`/`off` override it.
Controls react immediately to preference and pointer-capability changes.

Adult Options UI API (load preferences before input/controls):

```js
const prefs = HandheldPreferences.preferences;
prefs.get(); // detached {touchOverlay: 'auto', keyboard: {up: ['ArrowUp'], …}}
prefs.set({touchOverlay: 'off'}); // partial top-level update, validated atomically
const edit = prefs.editKeyboard();
const stopCapture = input.captureKeyboard(code => {
  // No navigation/game actions while capturing; rejects unknown physical codes.
  edit.setBinding('exit', [code]); // throws on conflicts/invalid codes
  stopCapture();
});
// edit.get(), edit.set(fullMap), edit.reset() only change the draft.
edit.apply(); // persists and updates all live input instances; edit.cancel() discards
prefs.reset(); // restore both overlay and keyboard defaults
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
Game packages include exact copies of these core source files, checksummed with
the rest of the package; they do not depend on mutable host scripts. The generic
launcher loads the same source under `/runtime/core/`. SDK changes only reach
installed games through explicit versioned package updates, never OS sync.

Run shared input/platform/lifecycle regression tests with
`node --test tests/shared_core.cjs` or `uv run python -m unittest discover -s tests`.

## Web host: same launcher and packages

```sh
uv run python web.py build
jump.sh start cubby-arcade --json
```

The local development preview is https://cubby-arcade.davidguttman.jump.sh .
The public browser preview and package registry use https://cubby-arcade.onrender.com .
Check `jump.sh ls --json` for current status rather than assuming it is running.
The repo's compose file runs only a Python static preview; Jump owns its lifecycle
and HTTPS routing. Re-run the build after editing shared code/package sources.
`web.py build path/to/game.game.zip ...` exports any explicitly selected trusted
packages after the same installer validation. Default build uses the pinned
Line Cutter package. Network fetch is separate; cached builds work
offline. Generated `.cache/web` and game assets are ignored, not checked in.

The export copies `runtime/index.html` and shared core bytes, and copies only
manifest-inventoried game assets from validated packages into `/games/<id>/`.
It is not a second launcher. Package changes are released by their game repository;
web and handheld can install/export that same archive. A browser's saves stay
local to its HTTPS origin/profile; they are not synced to the VM or another host.

Library arrow pictures select, the play picture opens the title/trailer, and
its play picture starts the game. A back-arrow picture returns. Gameplay has
pictorial pointer/touch controls alongside keyboard and standard browser gamepads.
New games should draw their own input demonstrations instead of written instructions.
All surfaces fit narrow screens without scrolling. These controls are also shared
with WPE; the 240×160 content remains centered at up to 480×320 on 640×480.
The web preview is for UX testing, not RG353V hardware/performance validation.


## Desktop / Steam host

The Electron shell opens the same exported launcher and validated game assets;
it does not run a Node HTTP server or create another launcher implementation.
Electron and the packaging tool are pinned in `package-lock.json`.

```sh
npm ci
npm run desktop:prepare
npm run desktop:start
npm run desktop:build
# Result: dist/CubbyArcade-linux-x64/CubbyArcade
```

The Linux x64 folder is a self-contained local distribution (runtime and games
included). Add its `CubbyArcade` executable as a non-Steam game to open one
fullscreen hub. In Steam, use **Games → Add a Non-Steam Game → Browse**, select that executable, then **Properties → Controller → Enable Steam Input** and the **Gamepad** template. Leave forced compatibility/Proton disabled for this native Linux build; keep the entire distribution folder intact. Steam account integration, Steam Cloud, achievements, store
publishing and Steam Deck verification are **not** implemented or claimed.
Windows/macOS packaging and physical controller behavior remain unverified.
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
The static browser host exports selected validated packages; a browser cannot
silently install native games. Its platform installation capability stays off.

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

Without a managed directory, a fresh desktop uses the bundled demo library.
Once `<userData>/games` exists it becomes the **entire** game library, including
when empty: removing a game cannot resurrect its bundled copy. `CUBBY_ARCADE_GAMES_DIR`
can explicitly select another managed directory (create it before launching).
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
this example. Web downloads for offline browser installation are not implemented;
native installation and static web export are intentionally different adapters.

### Store registry and stable release manifests

Native installation also accepts **schema-2 file manifests**, without ZIPs:
see [Game-owned releases](docs/game-release-manifest.md) for the contract and
single-release workflow. Schema-1 ZIP releases below remain compatible.

`web.py build` exports both the playable web preview and a hosted registry. The
public root defaults to `https://cubby-arcade.onrender.com`; override it
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
    "url": "https://cubby-arcade.onrender.com/store/line-cutter/0.2.0/line-cutter-0.2.0.game.zip",
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
uv run python -m runtime.publishing path/to/new-version.game.zip --output .cache/web --base-url https://cubby-arcade.onrender.com/
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
uv run python -m runtime.catalog list https://cubby-arcade.onrender.com/catalog
uv run python -m runtime.catalog --root path/to/games install https://cubby-arcade.onrender.com/catalog line-cutter
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
`https://cubby-arcade.onrender.com/hub-manifest.json`, downloads the small
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
https://cubby-arcade.onrender.com; the local Jump preview is a separate adult
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
It requires no system Python. A pristine desktop imports its bundled archives
atomically so adding a downloaded game does not hide the shipped game. Existing
externally managed libraries remain authoritative.

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
   uv run python -m runtime.publishing new-release.game.zip --output .cache/web --base-url https://cubby-arcade.onrender.com/
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
desktop **0.4.0**, adding domain-free relative download URLs for both file and
ZIP releases while retaining absolute-URL compatibility. Replace older desktop
executables before publishing relative-path game manifests. Source-hosted previews
still pin upstream Line Cutter **0.3.0** as their historical offline seed. No external
store release or hardware certification is implied by local packaging.

Run native budget tests with `node --test tests/launch_tokens.cjs`. The isolated
`--token-smoke` executable mode verifies the actual pictorial UI, duplicate launch,
10 → 9 → 8 spending, free resume/reload, failed launch, legacy navigation, zero
balance, adult refill, and disk persistence. Use a fresh `CUBBY_ARCADE_USER_DATA` profile,
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
with an identical `native/index.html` transport alias. The source-hosted Render
adapter maps `/` and `/index.html` to `site/index.html`, `/play` and `/play/` to
the wordless hub, and `/native/index.html` to the hub. Do not replace the native
shell inventory with landing-page bytes. The current desktop fetches that native
route first, verifies its inventory hash, and falls back to `/index.html` only for
legacy hosts. Older desktop clients that request the now-public `/index.html`
reject its mismatching hash and use their previously verified cache or bundle;
they never install the landing page as the launcher. Browser demo return-to-home
returns to the browser hub at `/play`; the native app returns to its wordless hub.
The root Jump/VM preview may continue showing the hub until its adapter adopts
these routes; this does not change the installed launcher or children's UI.

## Source-hosted cloud deployment and independent game updates

Render can deploy source `main` with the checked-in `render.yaml`:

```sh
uv run python hosting/build.py
# Render: python3 hosting/build.py ; python3 hosting/serve.py
```

The stdlib build fetches/verifies the pinned upstream archive, exports the current
launcher and both Line Cutter and Little Camp, and keeps all immutable previously
published releases. `hosting/releases/` contains the exact historical distribution
archives, not editable game source. Their size/hash/provenance inventory is
`hosting/releases.json`; old package and media URLs remain byte-identical.
The server serves only `.cache/web`, supports CORS/media ranges, and revalidates
live catalog/shell metadata. Free Render instances may cold-start.

New exports advertise Line Cutter's independent stable manifest:
`https://linecutter.david.app/store/line-cutter/manifest.json`. The previous Cubby
stable URL `/store/line-cutter/manifest.json` forwards live publisher metadata as
HTTP 200 JSON (GET and HEAD), so clients with a cached old catalog get future
releases without a Cubby rebuild. Forwarding is bounded to 256 KiB and a 20-second
socket timeout, validates schema/identity, rejects upstream redirects, and returns
502 on failure; it never substitutes a stale local release snapshot. This retains
compatibility with installers that reject metadata redirects. Former versioned
ZIP/media URLs stay byte-identical. Little Camp's publication remains on Cubby.
The generated forwarding map is server-private, not part of the downloaded shell.

Line Cutter 0.3.0 is retained as a historical ZIP bootstrap/offline preview, not
a requirement for new releases. New game-owned releases use the ZIP-free schema-2
file manifest and single GitHub-release workflow documented above.
That seed lock does not pin the updater: future Line Cutter releases need no new
ZIP, `games.lock.json` edit, or Cubby release.

The browser preview is the pinned offline package baseline; native game updates
resolve the publisher manifest independently on hub entry and activate outside
gameplay. Updating Line Cutter's website/package/manifest does not require a
Cubby launcher release. Updating this repo's pin changes fresh bundles/browser
previews only. Existing game IDs, origins, storage keys and token logic stay
unchanged. Do not run Cubby's local `runtime.publishing` command for a game whose
manifest is owned by its external publisher; publish it in the game's repository.


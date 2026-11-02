# handheld-os (working name)

An independent home for Linux/OS integration, a picture-first launcher, and the
ARM64 development VM. Not a flashable RG353V OS; do not flash its QEMU disk.

## Audience: pre-literate children

**No words by default** in child-facing launchers, libraries, prompts, errors,
instructions or games. Use pictures, animation, sound and demonstrated actions.
Any word needs a compelling reason and must be short, simple and phonetic;
reading must never be necessary. Text is allowed in separate adult management.
See `AGENTS.md`.

Line Cutter is an unchanged **technical test payload**, not the product design
or intended audience. Its internal written menus are not precedent. Its new
package cover, title/start controls and play affordance use no words. The attract
loop is the **actual 46.6-second gameplay trailer used on david.app**, played
muted from the installed package. Original game text inside this test footage
is not precedent for child-facing games. No reading is required to start or exit.

## Disk-installed example game

OS and games now have independent lifecycles:

```text
/opt/handheld/runtime/                     OS launcher, server, installer
/var/lib/handheld/games/line-cutter/
  releases/0.1.13/                          complete installed package
    manifest.json                         identity/version/integrity inventory
    cover.png                             wordless game-inspired cover art
    index.html                            wordless controls + recorded gameplay trailer
    play.html                             game-owned browser/input adapter
    line-cutter.js                        unchanged upstream game
    title-loop.mp3
    match-loop.mp3
    trailer-handheld.webm                 recorded gameplay, local/offline
  current -> releases/0.1.13                atomically selected active release
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
./vm.py install-game /mnt/data/vms/handheld-os/line-cutter-0.1.13.game.zip
./vm.py view
```

First fetch needs authenticated `gh` access to the private upstream repository
`davidguttman/misc.davidguttman.com`. `games.lock.json` pins the full upstream
commit and the three game asset SHA-256 values. It also pins the HTTPS URL and
SHA-256 for the existing david.app trailer (H.264/AAC, 1280×800, 46.6 seconds).
`fetch-games` uses FFmpeg n9.0.2 to prepare a checksum-pinned silent
VP8/WebM 480×300/30fps rendition of that same footage for the small display.
The recipe/version and both hashes are in the lock; a mismatched encoder output
fails validation. Building from the verified cache needs no network or FFmpeg.
The source audio is deliberately omitted from attract playback, not the game.
`fetch-games` downloads that external media with HTTPS-only curl; a changed file
fails checksum validation instead of silently replacing it. The installed manifest
records that separate provenance. Assets stay in ignored `.cache/games`; no
credentials or game payload are committed here. Package building is deterministic
and offline, and rechecks cached hashes. The generated `.game.zip` stays outside
Git in `/mnt/data/vms/handheld-os`.

`sync` updates **only OS runtime/services**, not packages or saves. Fresh bootstrap
starts with an empty pictorial library; install is explicit. Cover, title/attract,
and adapter source for this example live under `examples/line-cutter/`, separate
from the generic launcher. Future games can supply the same package contract.

### Controls and saves

Library: arrows/D-pad choose; A/Enter opens the selected package. Its trailer/title: A/Enter plays; B/Escape returns to the library. Gameplay: Z/Space=A, X=B,
arrows=D-pad, Enter/P=Start, M/right Shift=Select. Escape or L1+R1 returns to the
package title. Standard Gamepad API support still needs real-device mapping tests.

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
QEMU 11.1.2 toolchain is under `/mnt/data/vms/handheld-os/toolchain/root/usr`;
manifest/signature provenance is alongside it. Prerequisites are `uv`, `curl`,
`ssh`, `ssh-keygen`, `vncviewer`, plus QEMU ARM64/image tools/EDK2 firmware (system
or the prepared rootless toolchain), QEMU GPU/audio modules and host PipeWire/PA.
`HANDHELD_FIRMWARE_DIR` overrides system EDK2 paths; `HANDHELD_VM_DIR` overrides
artifact state. Fixed ports mean only one VM at a time.

Debian cloud image build 20261026-2643 is SHA-512 pinned in `vm.py`; signed guest
packages use snapshot 20261027T000000Z. Installed versions are recorded in
`/var/lib/handheld/packages.lock.tsv`. VM disks, keys, logs, screenshots, generated
packages and firmware state stay outside Git at `/mnt/data/vms/handheld-os`.
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
jump.sh start handheld-os --json
```

The registered development preview is https://handheld-os.davidguttman.jump.sh .
Check `jump.sh ls --json` for current status rather than assuming it is running.
The repo's compose file runs only a Python static preview; Jump owns its lifecycle
and HTTPS routing. Re-run the build after editing shared code/package sources.
`web.py build path/to/game.game.zip ...` exports any explicitly selected trusted
packages after the same installer validation. Default build uses the pinned
Line Cutter example. Network/authenticated fetch is separate; cached builds work
offline. Generated `.cache/web` and game assets are ignored, not checked in.

The export copies `runtime/index.html` and shared core bytes, and copies only
manifest-inventoried game assets from validated packages into `/games/<id>/`.
It is not a second launcher. Package source changes bump the example version;
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
# Result: dist/HandheldHub-linux-x64/HandheldHub
```

The Linux x64 folder is a self-contained local distribution (runtime and games
included). Add its `HandheldHub` executable as a non-Steam game to open one
fullscreen hub. Steam account integration, Steam Cloud, achievements, store
publishing and Steam Deck verification are **not** implemented or claimed.
Windows/macOS packaging and physical controller behavior remain unverified.
Standard keyboard/Gamepad API/pictorial controls are the shared implementations.
Close with the window-manager/Steam close action (e.g. Alt+F4); the child UI has
no text menus. Blur suppresses input, suspends the game loop/audio and pauses
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
HUB_USER_DATA=/tmp/handheld-desktop-test HUB_SMOKE_DIR=/tmp/handheld-desktop-evidence npm run desktop:smoke -- --ozone-platform=x11 --disable-gpu
```

Smoke mode uses a hidden offscreen window and exits itself (X11 is needed for
full-size screenshots on this host; headless Ozone can return a 1×1 capture); it checks local library,
trailer playback, native saves and absent renderer Node APIs, writing screenshots
and `report.json` when `HUB_SMOKE_DIR` is set. Without `HUB_USER_DATA`, smoke mode
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
uv run python -m runtime.catalog create /mnt/data/vms/handheld-os/line-cutter-0.1.13.game.zip --output .cache/catalog/catalog.json
uv run python -m runtime.catalog --developer-local list "file://$PWD/.cache/catalog/catalog.json"
uv run python -m runtime.catalog --developer-local --root .cache/desktop-profile/games install "file://$PWD/.cache/catalog/catalog.json" line-cutter
HUB_USER_DATA="$PWD/.cache/desktop-profile" npm run desktop:start
# After publishing a newer version into the selected catalog:
uv run python -m runtime.catalog --developer-local --root .cache/desktop-profile/games update "file://$PWD/.cache/catalog/catalog.json" line-cutter
uv run python -m runtime.catalog --root .cache/desktop-profile/games installed
uv run python -m runtime.catalog --root .cache/desktop-profile/games remove line-cutter
```

Without a managed directory, a fresh desktop uses the bundled demo library.
Once `<userData>/games` exists it becomes the **entire** game library, including
when empty: removing a game cannot resurrect its bundled copy. `HUB_GAMES_DIR`
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

### Library, discovery, and options

The shared hub starts on a **cover grid**, not a detail screen. Pointer hover,
keyboard/controller focus, or tapping a cover opens the actual packaged trailer,
a persistent favorite star, and a play control. Favorites are a binary preference,
not a rating. The library, shopping-bag discovery tab, and gear options tab use
pictures only; accessible names are available to assistive technology.

The `/catalog` discovery feed currently contains the **packages available to that
host**: exported packages in the static web build, installed packages in the VM
and managed desktop host. This is a real separate browsing view, but not a remote
commercial catalog. It does not pretend to purchase, download, or install a game.
The adult CLI remains the installation mechanism. A future remote catalog can
supply additional entries through the platform adapter without changing the hub;
uninstalled entries have no play action.

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
the cover contains no words and is not represented as a gameplay screenshot.

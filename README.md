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
package cover, title/start presentation and animated archery attract loop use
no words. The loop is an illustration, **not recorded gameplay or a trailer**.

## Disk-installed example game

OS and games now have independent lifecycles:

```text
/opt/handheld/runtime/                     OS launcher, server, installer
/var/lib/handheld/games/line-cutter/
  releases/0.1.1/                          complete installed package
    manifest.json                         identity/version/integrity inventory
    cover.svg                             recognizable library artwork
    index.html                            picture-only title + attract animation
    play.html                             game-owned browser/input adapter
    line-cutter.js                        unchanged upstream game
    title-loop.mp3
    match-loop.mp3
  current -> releases/0.1.1                atomically selected active release
```

`GET /library` discovers installed manifests, never an upstream repo or catalog.
The generic launcher consumes package artwork and entrypoint; it contains no
Line Cutter-specific logic. `/games/<id>/<asset>` serves only inventoried files
from that game's active release. The package owns title/start/attract, its input
adapter, actual gameplay and all audio. Everything plays offline after install.

Manifest schema 1 has `id`, `version`, `runtime: web`, `entrypoint`, `artwork`, an
optional `attract` entrypoint, capabilities/provenance metadata and a SHA-256
inventory. These are local integrity checks, **not publisher authentication or
signatures**. Use only trusted developer-built packages. Web games currently
share the kiosk origin/profile, so this is **not isolation for untrusted games**.

The installer bounds archive size/count, rejects traversal/symlinks/extra files,
and checks every hash before activation. It stages on the same filesystem,
retains prior releases and atomically replaces `current`. A failed validation
leaves the active install untouched. Identical reinstall is idempotent; reusing
a version with different bytes fails. Old releases are intentionally retained.
There is no automatic rollback UI, garbage collection, catalog/download flow,
package signing or power-loss durability guarantee yet. Atomic selector changes
protect against process interruption, not arbitrary storage failure.

### Build and install

From this repo on the prepared development host:

```sh
./vm.py fetch-games
./vm.py sync
./vm.py build-example
./vm.py install-game /mnt/data/vms/handheld-os/line-cutter-0.1.1.game.zip
./vm.py view
```

First fetch needs authenticated `gh` access to the private upstream repository
`davidguttman/misc.davidguttman.com`. `games.lock.json` pins the full upstream
commit and all three SHA-256 values. Assets stay in ignored `.cache/games`; no
credentials or game payload are committed here. Package building is deterministic
and offline, and rechecks cached hashes. The generated `.game.zip` stays outside
Git in `/mnt/data/vms/handheld-os`.

`sync` updates **only OS runtime/services**, not packages or saves. Fresh bootstrap
starts with an empty pictorial library; install is explicit. Cover, title/attract,
and adapter source for this example live under `examples/line-cutter/`, separate
from the generic launcher. Future games can supply the same package contract.

### Controls and saves

Library: arrows/D-pad choose; A/Enter opens the selected package. Its animated
title: A/Enter plays; B/Escape returns to the library. Gameplay: Z/Space=A, X=B,
arrows=D-pad, Enter/P=Start, M/right Shift=Select. Escape or L1+R1 returns to the
package title. Standard Gamepad API support still needs real-device mapping tests.

The 240×160 surfaces display at 480×320, centered on the 640×480 output.
Persistent saves remain in the existing guest user's WebKit profile, outside
all replaceable game directories. The origin stays `http://127.0.0.1:8080`, and
Line Cutter keeps its existing `linecutter_run` key: prior saves are preserved
without copying/resetting the profile. This example is compatible with existing
saves; a future SDK needs an explicit per-game save API/namespace for other games.

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

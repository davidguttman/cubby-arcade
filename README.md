# handheld-os (working name)

An independent home for the handheld OS integration, picture-first launcher,
and ARM64 development environment. The product name is undecided.
The current implementation is a **development VM**, not a flashable RG353V OS.

## Product requirements: pre-literate gamers

The intended players are pre-literate. **No words by default in child-facing
UI**: launcher, game/library/store discovery, prompts, instructions, status,
errors, and games. Use recognizable pictures, animation, sound, and demonstrated
actions. Any visible word needs a compelling reason why it must be a word;
it must be short, simple, and phonetic, and never required to proceed.
Text belongs only in a clearly separate adult setup/management flow.
The current launcher uses an archery picture and a play symbol; its A-button
glyph is an optional matching physical-control cue, not a reading gate.
See `AGENTS.md` for the persistent implementation contract.

**Line Cutter is only the existing runtime test payload, not the product design
target.** Its unchanged title screens/gameplay include text, so it is not a
pre-literate-ready game and must not define the child UX contract.

## Repository boundary

This repository owns `guest/` (Linux kiosk setup and services), `runtime/`
(pictorial launcher and input adapter), `vm.py` (QEMU/VM lifecycle and bundling),
and the explicit development game dependency in `games.lock.json`.
Game source and music remain upstream: no game implementation or audio is
vendored here. No david.app checkout or relative path is needed to run this repo.

`./vm.py fetch-games` uses the authenticated GitHub CLI to retrieve three exact
Line Cutter assets at a full commit, checks each SHA-256, and caches them under
ignored `.cache/games/`. The upstream game repository is private, so first fetch
requires `gh` access to `davidguttman/misc.davidguttman.com`. Credentials are never
copied into this repo or the VM. Bundling verifies the cache again and never
fetches implicitly. Once fetched, bundling, sync, and game play work offline.
This developer dependency command is **not** the future child-facing store or
an installed-game manager.

## Next: games store and installation

- An adult-facing catalog/setup flow, separate from a child's offline pictorial
  game library; child discovery and play must not depend on written descriptions.
- Versioned game packages/catalog entries with recognizable artwork, controller
  capabilities, and integrity/provenance metadata.
- Download verification and atomic install/update with rollback on interruption.
- Saves kept separately from replaceable game packages, surviving updates.
- Installed games available offline, with clear visual/audio status feedback.

These are upcoming work, not implemented features. The present launcher has
one test tile; it is not yet a multi-game library or downloadable OS image.

## RG353V development VM

ARM64 Linux development appliance for the gray **Anbernic RG353V (2 GB)**.
The pinned Line Cutter JavaScript and two MP3s are bundled unchanged from the
verified dependency cache, alongside a small game picker and input adapter.

## Run

From the repository root:

```sh
./vm.py fetch-games
./vm.py init
./vm.py start
./vm.py status
./vm.py view
```

The executable uses `uv` and pinned Python utility dependencies. First boot
installs the guest runtime; follow progress in
`/mnt/data/vms/handheld-os/serial.log` or:

```sh
./vm.py ssh 'tail -30 /var/log/handheld-bootstrap.log'
```

`view` opens the host's VNC viewer. VNC is loopback-only, port **5907**, and
SSH is loopback-only, port **12222**. There is no public server or jump.sh URL.
For viewing from another computer, forward VNC over your normal SSH connection
to this host; do not bind VNC to the LAN.

### Development commands

```sh
./vm.py sync        # copies current launcher/runtime and verified cached game
./vm.py screenshot  # prints path to actual VNC framebuffer capture
./vm.py key ret     # injected physical Enter key (QMP qcode)
./vm.py key z
./vm.py key esc
./vm.py ssh 'cat /var/lib/handheld/browser-report.json'
./vm.py stop        # ACPI clean shutdown; no unrelated process killed
```

Controls: Enter/A opens the selected game; Z/Space is A, X is B, arrows are the
D-pad, Enter/P is Start, M/right Shift is Select. Escape returns to the picker.
Standard browser gamepad mappings are supported, with **L1+R1** returning to the
picker. Actual RG353V controller enumeration/mapping still needs hardware
verification. The screen can also be clicked for A.

The picker and game render at **240×160**, displayed at **480×320** (exact 2× scale) centered
in a **640×480** output. Both use Canvas2D; the picker has a low-rate blinking
selection indicator. The runtime uses WPE WebKit with Cog and Weston, not
Chromium. Local saves live in the guest user's persistent WebKit profile.
Returning to the picker reloads the page to release audio/render resources.

## Host prerequisites / rootless toolchain

- `uv`, `curl`, `ssh`, `ssh-keygen`, `vncviewer`; authenticated `gh` for first game fetch
- QEMU system ARM64, QEMU image tools, and AArch64 EDK2 firmware
- QEMU `virtio-gpu-pci` and PulseAudio backend modules; a host PulseAudio/PipeWire
  compatibility server for audible output

The prepared host has a user-local QEMU **11.1.2** installation at
`/mnt/data/vms/handheld-os/toolchain/root/usr`. No host root permission,
desktop configuration changes, Docker, or Node server is needed.
The CLI automatically uses that layout and sets:

```text
LD_LIBRARY_PATH=<root>/usr/lib
QEMU_MODULE_DIR=<root>/usr/lib/qemu
QEMU -L <root>/usr/share/qemu
```

Firmware is `share/edk2/aarch64/QEMU_EFI.fd` plus a private copy of
`QEMU_VARS.fd`. With system-installed QEMU, those paths default to
`/usr/share/edk2/aarch64`; override the firmware directory using
`HANDHELD_FIRMWARE_DIR` if the distribution uses another location.
The rootless package manifest/signature verification provenance is in
`toolchain/manifest.json` in the artifact directory.

## Reproducibility and isolation

- Fixed Debian 13 ARM64 cloud image build **20261026-2643**; SHA-512 is pinned
  in `vm.py` and checked before use. Source: Debian's HTTPS cloud image archive.
- Guest package archive snapshot: **20261027T000000Z**, with Debian package
  signature verification enabled. No moving `latest` package/image inputs.
- Exact installed package versions are saved to
  `/var/lib/handheld/packages.lock.tsv`; the game SHA-256 is saved beside it.
- Persistent disk, SSH keys, firmware variables, screenshots, and logs stay
  outside Git at `/mnt/data/vms/handheld-os` (mode 0700).
- Task-specific SSH key only; SSH passwords and host agent forwarding disabled.
- Guest static HTTP binds only to guest loopback, with no public port forward.
- No host directories are mounted into the guest. `sync` copies only the scoped
  runtime files and the three hash-verified game assets from `games.lock.json`.
- `HANDHELD_VM_DIR` can select a separate artifact directory, but ports are fixed:
  stop this VM before starting a second one on the same host.
- `init` preserves an existing guest disk; it does not reset saves or rerun
  cloud-init on an already initialized guest. `sync` updates the runtime safely.

## What is and is not apples-to-apples

QEMU uses ARM64 `virt`, four Cortex-A55 CPUs and 2 GB RAM. The VM kernel,
virtual display, audio device, and llvmpipe software rendering differ from the
RG353V's Rockchip kernel/Mali GPU/real controls. Emulation is **not a handheld
speed benchmark**. This VM verifies ARM ABI, WebKit behavior, asset packaging,
input flow and persistence. Frame time, input/audio latency, GPU acceleration,
power, suspend, and actual controller mappings must be measured on the device.

The pinned runtime and game bundle are candidates for the device, **not an
already-verified ROCKNIX package**. A matching device userland/runtime build is
still required; Debian binaries cannot simply be assumed compatible with
ROCKNIX. Do not flash this generic QEMU image to the RG353V.

## Verification

```sh
uv run python -m unittest discover -s tests -v
bash -n guest/bootstrap.sh guest/run-kiosk.sh
```

The dependency tests cover exact commit retrieval, cache reuse without network,
missing/corrupt assets, failed download cleanup, and correct offline packaging.

## Existing VM migration

The original development VM's state was external to david.app at
`/mnt/data/vms/david-app-handheld`; the standalone default is now
`/mnt/data/vms/handheld-os`. Do not create a new disk to migrate saves. Stop only
the owned VM cleanly before relocating its state, preserve the complete directory
(including keys, firmware, seed, profile disk, and toolchain), and update the
qcow2 backing-image path if it is absolute. Then start and sync with this CLI.
Use `HANDHELD_VM_DIR` to target a retained state directory instead of moving it.
Existing cloud-init metadata is preserved when regenerating a seed.

## Diagnostics

`status` reports QEMU PID, guest services and the actual WPE page report.
`/var/lib/handheld/browser-report.json` records viewport, Canvas2D/localStorage,
Web Audio state, decoded MP3 availability, rendered frames and JS errors.
`/var/lib/handheld/weston.log`, `/var/lib/handheld/session.log`, the systemd journal, and bootstrap log contain
graphics/startup details. Check audio samples as well as AudioContext state
before claiming sound works; API presence alone is not an audio test.

# Cubby updates on ROCKNIX

A signed update can replace everything Cubby owns under `/storage/cubby`: the app,
Cog, the WPE/WebKit runtime, the coordinator, the device files and the trusted key
and feed. No reflash is needed. ROCKNIX, its kernel and bootloader, and Cubby's
files on the boot partition (`/flash`: Wi-Fi recovery, USB diagnostics, boot
splash) are not covered. Games update through the catalog, and saves remain under
`/storage/cubby/state` and are never touched.

## How one update replaces everything

A release directory is the unit of update:

```
releases/app-N-<hash>/
  app/       the signed files, including rocknix/updates.py (the coordinator) and Cog
  device ->  app/runtime/native/rg353v/device (chroot-run.sh, launch.sh, guard.py, ...)
  rootfs ->  ../../runtimes/<sha256 of the runtime archive>
  trust/     config.json and release-key.pem
  release.json
```

Flipping `current` therefore swaps all of it at once, and flipping back restores
all of it. Three things sit outside releases, on purpose:

- `boot/guard.py` starts the current release and backs out of a bad one, including
  one whose coordinator cannot start or hangs. `boot/guard.previous.py` is the
  guard before the last change.
- `updater/coordinator.py` is the boot entry every `launch.sh` already runs. It is
  a few lines that reach the guard, then the previous guard, then the baseline.
- `updater/coordinator.baseline.py`, `updater/device` and the `fallback` release are
  the last resort. The baseline runtime is never collected.

### A normal update

1. `update.json` (schema 2) beside the legacy feed is fetched and checked: Ed25519
   signature, compatibility, strictly increasing sequence, not previously rejected.
2. A new runtime, if the manifest names one, streams to disk with its own limits
   (2 GiB archive, 6 GiB unpacked, free space checked first), is verified by SHA-256,
   unpacked at low priority and probed in a private mount namespace before anything
   can point at it. An existing runtime is reused.
3. `platform.zip` is checked file by file and staged as a new release directory.
   `launch.sh` and `chroot-run.sh` must parse, and `guard.py` and `updates.py` must
   compile, or the release is refused.
4. **Install** journals `updates/pending.json`, flips `current`, and the coordinator
   exits so the guard can start the new release's own coordinator.
5. The guard proves the path systemd will take at the next boot, then gives the
   release one trial: browser ready and server healthy for ten seconds, within two
   minutes. A trial that fails, crashes, hangs (four minutes) or is interrupted by a
   reboot flips back. The older coordinator records the rejection.
6. On confirmation the sequence advances, the guard and boot entry are refreshed if
   they changed, a rotated key reaches the baseline too, and runtimes that nothing
   could still start from are removed.

### If a confirmed release stops working later

Two failed coordinator runs in a row step `current` down to `previous`, then
`fallback`, rejecting the release that failed. Stock ROCKNIX is the end of that
line, with Cubby's files intact and SSH available. A newer signed update is still
accepted after any of this.

### Carrying a device from the old coordinator

Devices installed before this design run a coordinator that accepts only the legacy
`manifest.json` and `app.zip`, so every release publishes those too:

1. The old coordinator installs the release normally, with its normal trial.
2. `rocknix/network.py` runs from that release, outside the chroot. Once the release
   is confirmed it calls `updates.bridge()`, which checks the files against the
   signed inventory and builds a new-format copy of the release (`-p2`), arms
   `boot/activate.json`, keeps the old coordinator as
   `updater/coordinator.baseline.py`, and installs the guard and boot entry last.
   `current` does not move and the running session is untouched.
3. At the next boot the entry reaches the guard, which starts the `-p2` release's
   coordinator in a trial. Failure returns to the release from step 1 and the old
   coordinator, which can take the next update and bridge again. A rejected `-p2` is
   not retried.

Images and installs made from this source start on this checkout's coordinator
without a guard, and gain the guard on their first update.

### Shipping a new runtime

Build and audit it as described in `rocknix/ROOTFS.md`, upload the archive to its
own immutable release, and put its SHA-256, URL, size and unpacked size in
`rocknix/runtime.json`. That version publishes only the platform trio, so old
coordinators stay on the last release they can run, which bridges them. A device
whose `-p2` trial failed needs a later release published on the baseline runtime.

## Adult experience

After required Wi-Fi setup, open the updates tile on the hub's gear tab and answer its math question. Cubby
checks the feed about a minute after starting and every 15 minutes while online,
and marks the gear tab and updates tile with a badge when an update is ready. Check, download, and verify an update; install outside
active gameplay. Download failure leaves the running app unchanged. An offline
installed app keeps working. Failed staging can be retried by checking again;
partial downloads are discarded rather than activated.

The browser and server share the package-operation lock for activation. If the
activation reply is lost, gameplay stays blocked until restart because activation
may already be underway; an explicit rejection releases the lock. The
candidate must paint a page, acknowledge its unique trial token, and keep both
browser/session and HTTP server alive for ten seconds. A 120-second startup timeout or
process failure rolls back. Reboot with an unfinished trial also restores the
previous release. Rejected releases are not retried automatically.

## Trust and configuration

The production stable feed is:

<https://github.com/davidguttman/cubby-arcade/releases/download/cubby-device-stable/manifest.json>

New baseline images provision this feed and the production Ed25519 public key
tracked at `rocknix/device/release-key.pem` by default. `--disable-updates` builds
an explicitly unconfigured image; a complete `--update-feed` / `--update-key`
pair overrides the production trust. There is no unsigned fallback or test key.
The private signing key stays outside the repository, device, and installer.

A baseline image can be composed with:

```sh
unshare --map-auto --map-root-user uv run rocknix/image.py \
  --rocknix official.img.gz --rootfs rootfs.tar.xz --output cubby.img.gz \
  --update-feed https://github.com/davidguttman/cubby-arcade/releases/download/cubby-device-stable/manifest.json \
  --update-key /path/to/public-release-key.pem
```

The public key must be Ed25519 SubjectPublicKeyInfo PEM. On existing installations,
provision root-owned `/storage/cubby/updater/release-key.pem` and `config.json`:

```json
{"feed":"https://github.com/davidguttman/cubby-arcade/releases/download/cubby-device-stable/manifest.json","public_key":"release-key.pem"}
```

This is an explicit baseline trust operation, not a caller-supplied URL in the UI.
After that, a signed release can change the key and feed through its `trust` field:
the current key must sign that manifest, the new trust applies only after the
release's trial passes, and rollback restores the old one.

## Maintainer release

**Normal releases are now automated by GitHub Actions.** Use the shared Cubby
version in `package.json`; see [release workflow](releases.md). New desktop and
handheld artifacts share `vX.Y.Z`. The existing stable feed URL and trust key do
not change. Handheld 0.2.0 upgrades normally to the shared version.

The commands below document the **legacy device-only publisher and recovery
history**, not the normal release process. Do not create another independent
device version counter. New immutable handheld assets are on `vX.Y.Z`, not
`cubby-device-vX.Y.Z`.


Historically, device app versions used a separate `cubby-device-vX.Y.Z` namespace.
That namespace is retained only for historical releases.
Version 0.1.1 / sequence 3 is the first accepted production device release.
The initial 0.1.0 candidate exposed a missing controller asset during acceptance;
UI health rejected it and restored the previous working installation. Its
immutable release is marked superseded. The stable feed has since advanced.
Sequences strictly increase; gaps are permitted. Never publish a deliberately
broken rollback probe.

Build from a clean, verified source checkout. Protect the private key with mode
0600 and keep its protected backup separate from this checkout. The default
local key directory is `/home/dguttman/.local/share/cubby-release/`; only
`release-key.pem` is public. Do not pass private key contents on the command line
or copy them into output artifacts.

```sh
uv run --python 3.12 python -m rocknix.update_release \
  --source . --output .cache/device-release-0.1.1 --version 0.1.1 --sequence 3 \
  --archive-url https://github.com/davidguttman/cubby-arcade/releases/download/cubby-device-v0.1.1/app.zip \
  --key /home/dguttman/.local/share/cubby-release/private-key.pem

uv run --python 3.12 python -m rocknix.update_publish \
  --output .cache/device-release-0.1.1 \
  --public-key rocknix/device/release-key.pem \
  --commit FULL_VERIFIED_SOURCE_COMMIT_SHA
```

The publisher verifies the local signature, archive hash/size and exact immutable
URL; authenticates an existing stable feed; and refuses replay or sequence reuse.
It uploads `app.zip`, `manifest.json`, and `manifest.json.sig` to the immutable
release, then downloads each and compares bytes before touching the stable feed.
It can resume a partial immutable upload only if every existing asset already
matches; it never clobbers an immutable asset. An identical release is idempotent.

Only one maintainer/publishing host may publish this channel at a time. The CLI
uses a local advisory lock; it is **not a distributed lock**. GitHub cannot replace
manifest/signature assets atomically. During the brief replacement interval,
devices reject a mismatched pair without changing the current app; retry the
check. An observed publication failure restores and verifies the old pair. If
that restoration itself fails, or the publisher is killed/power fails between
uploads, repair explicitly from the intended immutable release:

1. Download its metadata and archive into a new empty directory using
   `gh release download vX.Y.Z --repo davidguttman/cubby-arcade`
   (use `cubby-device-vX.Y.Z` only for historical device-only releases).
2. Verify the manifest with the tracked public key and compare the downloaded
   archive's size/hash with the signed inventory. Confirm its sequence is the
   intended latest (do not downgrade to work around a failed publication).
3. Upload only its `manifest.json` and `manifest.json.sig` to
   `cubby-device-stable` using `gh release upload ... --clobber`.
4. Download the public HTTPS feed and signature again, verify them, then check
   the device. Never edit signed JSON, reserialize it, or overwrite immutable
   release content to repair the stable alias.

The stable feed carries no private key or ROCKNIX image. Signature verification,
compatibility, monotonic sequence, archive size/hash and every file's hash/mode
are checked before anything is activated. Games and ROCKNIX have separate
update/release surfaces.

## Storage and recovery

The existing runtime is moved once to `runtimes/<digest>` without copying its
contents. Releases reference a runtime by digest and carry their own device files.
Old releases staged by the baseline coordinator keep using `updater/device`.

`updates/pending.json` is fsynced before atomically changing `current`.
`previous` is retained after health confirmation. No updater routine deletes saves,
installed games, browser profile, previous app releases, or the Android backup.
Only runtimes that `current`, `previous`, `fallback` or a pending or staged release
do not use are removed, and never the baseline runtime.
A power interruption during activation may reject an otherwise-good release; it
must not leave an unconfirmed release in a reboot loop. Retention cleanup is
intentionally not automatic yet.

## Verification boundary

Whole-device updates, the guard and the bridge are tested off-device against the
exact 0.11.0 baseline coordinator (`tests/test_update_everything.py`); the session
itself is a stub there, because it needs root and the GPU. They have not yet run on
hardware.

On 2026-11-05 the physical RG353V downloaded the signed production feed and app
over Wi-Fi, rejected modified signed metadata, staged and activated 0.1.1, and
confirmed browser readiness plus sustained process/server health. A real failed
UI candidate timed out and automatically restored the previous working release.
After a device reboot, version 0.1.1 / sequence 3 remained confirmed, Cubby's
library rendered, and the adult update API reported configured/idle without error.
All 34 installed game files were unchanged. Existing browser save progress and
preferences remained present; ordinary gameplay may still update live save data.
Evidence is retained locally under `.cache/production-update-acceptance/`.

The Python suite ran 256 tests with one skipped. Unit tests use ephemeral keys
and disposable files; browser regressions are explicit 640×480 simulations.
Default trust provisioning is tested, but a newly composed first-boot image and
abrupt physical power interruption still need separate hardware acceptance.

## Hardware validation

On 2026-11-06 an RG353V ran this path from its installed 0.20.1 layout, using
signed test builds on a separate feed:

- The old coordinator installed a release, then the bridge armed without moving
  `current`. The first boot through the guard confirmed the new layout 39 seconds
  after power-on, and later reboots stayed clean.
- A whole-device update replaced the coordinator and device files.
- Rollback worked for a session that exits, a coordinator that raises on start, a
  hub that never reports ready (122 seconds), and a hard crash during a trial.
- A runtime update took 141 seconds to download, unpack, verify and probe, and rolled
  back across runtimes when its session failed.
- Corrupting a confirmed release stepped down to `previous` (67 seconds after
  power-on), then to the old-layout `fallback`, which took a new update and migrated
  again.

Key rotation and the final step down to stock ROCKNIX are covered by tests only.

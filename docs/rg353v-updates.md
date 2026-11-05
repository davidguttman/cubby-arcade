# Cubby app updates on ROCKNIX

This is an **app-only** update mechanism. It does not update ROCKNIX, kernels,
bootloaders, WPE, device supervisors, or games. Those require separately reviewed
release surfaces. Games and saves remain under `/storage/cubby/state`.

## Adult experience

After required Wi-Fi setup, open adult Wi-Fi settings (gear or hold L+R+Start),
then **Cubby updates**. Check, download, and verify an update; install outside
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
Existing devices require this one-time baseline trust provisioning. Subsequent
app releases cannot replace the coordinator, public key, or configured feed.

## Maintainer release

Device app versions have their own `cubby-device-vX.Y.Z` namespace; they do not
move the repository's general `vX.Y.Z` releases or GitHub's latest release.
Version 0.1.1 / sequence 3 is the first accepted production device release.
The initial 0.1.0 candidate exposed a missing controller asset during acceptance;
UI health rejected it and restored the previous working installation. Its
immutable release is marked superseded; the stable feed points to 0.1.1.
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
   `gh release download cubby-device-vX.Y.Z --repo davidguttman/cubby-arcade`.
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
are checked by the baseline coordinator outside the replaceable app. Games,
WPE, and ROCKNIX have separate update/release surfaces.

## Storage and recovery

`updater/coordinator.py` is the baseline supervisor. The existing runtime is moved
once to `runtimes/<digest>` without copying its contents. Releases reference that
runtime and baseline device scripts. Candidate ZIPs cannot replace those scripts.

`updates/pending.json` is fsynced before atomically changing `current`.
`previous` is retained after health confirmation. No updater routine deletes saves,
installed games, browser profile, previous app releases, or the Android backup.
A power interruption during activation may reject an otherwise-good release; it
must not leave an unconfirmed release in a reboot loop. Retention cleanup is
intentionally not automatic yet.

## Verification boundary

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

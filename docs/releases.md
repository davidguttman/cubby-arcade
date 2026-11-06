# Cubby releases

`package.json` is the single Cubby product-version source. Windows, Linux, and
handheld app artifacts share `vX.Y.Z` and the same source commit. Games, the
immutable WPE runtime, and ROCKNIX retain their own independent versions.

## Normal release

1. Make the change, update `package.json` and `package-lock.json` to the next
   SemVer version (patch for fixes, minor for compatible capabilities, major for
   breaking behavior), then push `main`.
2. **Cubby builds and releases** validates the version and runs regressions,
   builds and smoke-tests Windows/Linux, and signs the handheld app package.
3. After both platform jobs succeed, the same workflow creates the exact-commit
   `vX.Y.Z` tag, uploads all seven assets to a draft release, verifies their
   uploaded sizes and SHA256 digests, and publishes the complete release.
4. Only then does it verify the published handheld bytes and advance
   `cubby-device-stable/manifest.json` and its detached signature. Existing
   handhelds keep using their configured feed and trust key, and update through
   the gear tab → updates tile. No reinstall, reflash, or save reset.
5. Render's Static Site tracks `main` with `autoDeployTrigger: checksPass` in
   `render.yaml`. After the commit's checks succeed, Render automatically builds
   and deploys the website, including `/play` and the cloud launcher used by
   Windows/Linux apps. No second push, manual web deploy, or tag push is needed.

One versioned push therefore publishes the Windows, Linux, and handheld release
and updates the website. Publication does not install the handheld update:
an adult still chooses it in the device's updates tile. Desktop apps refresh
their cloud launcher from the website; this is not executable self-update.

No second device version or manually incremented device counter is needed.
The anti-replay sequence is derived from SemVer: `(major*10000+minor)*10000+patch+1`;
components must be below 10000. This is larger than the legacy sequence 4 at
0.2.0. Legacy device tags remain historical; new device archives live beside
desktop assets on the shared `vX.Y.Z` release.

An ordinary push keeping an already published version performs checks/builds
and automatically updates the website after checks pass, but does not overwrite
or manufacture another release. New platform artifacts require a new version.
Main version changes publish automatically; matching tag pushes and manual runs
on main can retry.
The workflow does not rely on a GITHUB_TOKEN-created tag triggering another
workflow. Publication is serialized with `cancel-in-progress: false`.

## Signing and retries

Repository Actions secret `CUBBY_DEVICE_SIGNING_KEY` contains the existing
Ed25519 private key. Linux signing fails closed when it is absent or does not
match the tracked public key. The key is written only to a private runner-temp
file outside the checkout and removed on exit; it is never an artifact.
The publish job has write permission; build jobs have read permission.

Failures before complete publication do not advance the feed. Rerun **failed
jobs** in the same Actions run so verified artifact bytes are retained; immutable
published bytes are never replaced. Draft retries complete only matching missing
assets. Conflicting tag commits or asset hashes fail rather than overwrite.
A successful release followed by a feed failure can retry publication with those
same artifacts. The stable pair cannot be atomically swapped by GitHub; devices
reject mismatched signatures and the publisher restores the old pair on observed
failure. For uncatchable termination, use the recovery procedure in
[device updates](rg353v-updates.md), taking metadata from `vX.Y.Z` for new releases.

The stable feed is a compatibility alias, not a second product release/version.
Never delete it or rotate its key without an explicit installed-device migration.

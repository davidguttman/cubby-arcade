# Cubby releases

`package.json` is the single Cubby product-version source. Windows, Linux, and
handheld app artifacts share `vX.Y.Z` and the same source commit. Games, the
pinned WPE runtime, and ROCKNIX retain their own independent versions.

## Normal release

1. Make the change, update `package.json` and `package-lock.json` to the next
   SemVer version (patch for fixes, minor for compatible capabilities, major for
   breaking behavior), then push `main`.
2. **Cubby builds and releases** validates the version and runs regressions,
   builds and smoke-tests Windows/Linux, signs the handheld app package, and
   builds and independently verifies the versioned full handheld installation
   image against the exact release source commit.
3. After the Windows, Linux, and full-image jobs all succeed, the same workflow
   verifies the image/receipt/checksum against the publication checkout before
   creating the exact-commit `vX.Y.Z` tag. It uploads all thirteen assets to a
   draft release (ten when a runtime change omits the legacy update trio),
   verifies their uploaded sizes and SHA256 digests, and publishes the complete
   release.
4. Only then does it verify the published handheld bytes and advance
   `cubby-device-stable/manifest.json`, `update.json` and their detached signatures.
   Existing handhelds keep using their configured feed and trust key, and update
   through the gear tab → updates tile. No reinstall, reflash, or save reset.
   A version that changes `rocknix/runtime.json` publishes only the platform trio
   for handheld updates; desktop and full-image assets are still required.
   See [device updates](rg353v-updates.md).
5. Independently of those release gates, Render's Static Site
   tracks `main` with auto-deploy **On Commit**, managed in the dashboard/API.
   It builds with `python3 -m pip install -r requirements.txt && python3 hosting/build.py`
   and publishes `.cache/web`, with no runtime start command. Each main commit
   deploys the website, including `/play` and the cloud launcher used by
   Windows/Linux apps, without waiting for checks. No second push, manual web
   deploy, or tag push is needed. This does not bypass platform-release or
   device-feed verification.

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
and independently auto-deploys the website On Commit, but does not overwrite
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

## Full installation image is a mandatory release surface

Every real release also runs a separate, secret-free `image` job. It composes
an unprovisioned full RG353V image from the exact release checkout, boot artwork,
current updater and pinned firmware/runtime; then independently decompresses and
audits its actual FAT/ext4 filesystems. The publish job requires that image,
its `.img.gz.json` build receipt and `.img.gz.sha256` checksum before making
any tag/release writes or advancing the handheld feeds. A standard release has
13 assets, not just the desktop archives and app/platform updates.

Publication rejects an image from another version/commit, altered source
inventories, corrupt bytes/filesystems, or customer provisioning keys—even keys
omitted from its receipt. The public image contains no management credentials.
A maintainer may separately build a provisioned image using a public key per the
installation guide; that artifact cannot pass the public-release gate.

The immutable GTK4 runtime input is published separately, never as latest, at
`rg353v-runtime-e1859403acf7/rootfs-gtk4-kiosk.tar.xz` in this repository's GitHub
releases. The complete digest remains pinned in `rocknix/image.py`. The input
release carries provenance, package/source inventories and applicable licenses,
patches and source-access notices; runtime license files remain inside the
archive. Do not overwrite these inputs or accept a rebuilt archive under the
same hash. See `rocknix/ROOTFS.md` for corresponding-source instructions.

The image job requires 25 GiB available runner disk, filesystem tooling, and a
private root mount/PID namespace on its disposable runner. Builds and independent
verification have a 60-minute job ceiling; downloads have byte limits, checksums,
per-socket timeouts and atomic cache publication. The full-image receipt records
`hardware_validated: false`: integrity and version checks do **not** certify a
fresh device boot. Complete the hardware acceptance checklist before calling a
release customer-ready.

## Cubby Arcade catalogs (maintainers)

Outside game makers use their own feeds ([game authoring guide](game-authoring.md#play-it-on-your-own-cubby)); these lists are for our own games.

### Release to beta first

Cubby has two independent discovery lists: `hosting/catalog.yaml` publishes to
https://cubby.david.app/catalog (stable), and `hosting/beta-catalog.yaml` publishes
to https://cubby.david.app/beta/catalog (beta). The beta list starts empty. Add
an early game to beta using the listing shape in the game authoring guide,
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

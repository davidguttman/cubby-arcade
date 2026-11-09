# Cubby Arcade on RG353V

**Download one image. Flash the card. Insert it and power on.**

The image contains ROCKNIX, WPE and Cubby, with **no installed games**.
No terminal, Python, SSH, or second installation is required on the handheld.
First launch opens [adult Wi-Fi onboarding](rg353v-network.md): internet is
required to finish setup and get new content. Installed games work offline afterward.

## Adult setup

You need an **Anbernic RG353V** (not RG353VS), a charged battery, a reliable
microSD card (**16 GB minimum; 32 GB recommended**), and a computer/card reader.

1. **Download the versioned `Cubby-Arcade-RG353V-v<VERSION>-<COMMIT>.img.gz` and its `.json` build receipt.** This is the complete image,
   not the source ZIP, advanced maintenance kit, or development VM disk.
2. **Flash it with [balenaEtcher](https://etcher.balena.io/).** Select the `.img.gz`,
   select the intended microSD card, and Flash. This erases that card; back up
   anything on it first. Keep Etcher's verification enabled.
3. **Insert the card in the handheld's OS slot and power on.** Leave it powered
   while ROCKNIX expands the storage partition and automatically reboots.
   Cubby opens fullscreen into adult Wi-Fi setup, then an empty Library.
   Install games through Cubby after setup. No test saves or prior setup data are included.

**Availability/status:** the image builder produces a local artifact; a public
image download has not yet been published. Physical RG353V cold boot, GPU,
buttons, sound, and sleep/wake are not yet certified. A built image or VM test
is not hardware acceptance.

### If this RG353V cannot boot ROCKNIX

Some RG353V units have an internal Android/eMMC bootloader conflict. Read the
[upstream device instructions](https://rocknix.org/devices/anbernic/rg353pmvvs/)
for that exception. The Cubby image **does not erase or modify internal Android**;
there is no automatic internal-storage wipe. This is a hardware prerequisite,
not a separate Cubby installation step.

## Recovery

Power off, put the card in the computer, and open its visible ROCKNIX partition.
Create an empty file named **`CUBBY-DISABLED`** beside `CUBBY-RECOVERY.txt`
(no `.txt` extension). Reinsert and power on to use stock ROCKNIX instead.
Delete that file to re-enable Cubby. Games, saves, and browser state stay on the
card. Reflashing, unlike recovery, erases them.

If Cubby repeatedly fails to start, its launcher falls back to stock ROCKNIX.

## For maintainers only

The image starts with the checksum-pinned official **ROCKNIX 20261101 Generic**
release and keeps its bootloader, kernel, immutable `SYSTEM`, partition types
and partition starts. Each build receives unique GPT disk/partition identities,
FAT serial, ext4 UUID and filesystem labels; all Extlinux boot/disk label references
are updated together. This avoids ambiguity with the older internal installation.
First-boot resize randomizes UUIDs, so fixed UUID boot references are not used.
An identical image cloned onto two attached disks can still collide: do not
use the same generated image on SD and internal storage simultaneously.

The explicit RG353V `rg353v-sdio-hs25` Wi-Fi compatibility profile removes only
`sd-uhs-sdr50` and caps `/mmc@fe000000` at 25 MHz in the exact checksum-pinned
RG353V DTB. The original DTB is retained on FAT under `cubby-recovery/`; all other
device trees stay unchanged. `--wifi-profile stock` disables that timing change.
The profile plus late-driver recovery has demonstrated chip enumeration and
SSID scanning, not association, internet access, reconnect or sleep/wake. Its
profile/hash and media identities are recorded in image provenance.

The builder adds a tiny boot hook and recovery note to FAT, then prepopulates
an enlarged data filesystem with the verified
ARM64 WPE runtime and Cubby. The hook creates only a volatile systemd override;
it does not prepopulate `.config`/`.cache`, which would prevent stock first-boot
resize. Upstream's RK3566 resize expands the existing filesystem without
formatting it, preserving the preinstalled runtime and Cubby.

On the Linux build host, after building the [GTK4 kiosk runtime](../rocknix/ROOTFS.md),
select the intended release's clean committed checkout and explicit version:

```sh
unshare --map-auto --map-root-user uv run rocknix/production_image.py \
  --rocknix .cache/rg353v-image-input/ROCKNIX-RK3566.aarch64-20261101-Generic.img.gz \
  --rootfs .cache/rg353v-kiosk-runtime/rootfs.tar.xz \
  --expect-version 0.34.0 \
  --output-directory .cache/production-images
```

Use the version of the selected release, not an archived image's date. See
[production provisioning](#production-provisioning-maintainers) for the build
receipt, artifact verification and hardware acceptance gate. `rocknix/image.py`
is a low-level development compositor, not the customer provisioning entry point.

The namespace preserves numeric ownership without sudo. Build tools are `uv`,
`unshare`, `tar`, `fatlabel`, `dumpe2fs`, `debugfs`, `mkfs.ext4`, and `e2fsck`; Python build
dependencies are pinned in the script. The image builder writes only regular
files, never physical disks. It validates upstream and rootfs checksums, GPT
checksums/layout, and the created filesystem; it generates an image SHA-256
sidecar. Source commit and input checksums are recorded under
`/storage/cubby/image-provenance`. Building the image does not fetch or install
any game. Both pre-packaging and actual-filesystem audits reject games, saves,
profiles, setup progress, network credentials and prior management identities.
Required system and installed-version records are retained.

Advanced SSH installation onto an existing supported ROCKNIX card remains
available in [the maintenance guide](rg353v-maintenance.md). It is **not** the
normal consumer setup. Neither tool wipes internal Android.

## Automatic USB diagnostics

Newly built images enable a read-only diagnostic link over USB, independent of
Cubby's browser and display startup. See [USB diagnostics](rg353v-usb-diagnostics.md)
for the Linux host command, logs available, opt-out, and early-boot limitations.
Images flashed before this addition need updating; rebuilding does not update
the connected handheld automatically.


## Production provisioning (maintainers)

Do not use an archived `ready.img.gz` and expect an app update to finish the
installation. Boot artwork and independent recovery live on FAT and are not
installed by normal app updates. Select the intended product version and commit
first; a date-only filename or a working upgraded unit is not acceptance evidence.

Build from a **clean committed checkout**, using the pinned kiosk rootfs (not
the development VM or baseline pre-kiosk rootfs):

```sh
unshare --map-auto --map-root-user uv run rocknix/production_image.py \
  --rocknix /path/to/ROCKNIX-RK3566.aarch64-20261101-Generic.img.gz \
  --rootfs /path/to/rootfs-gtk4-kiosk.tar.xz \
  --expect-version 0.34.0 \
  --output-directory .cache/production-images
```

`--expect-version` must equal the selected release's package and lockfile
versions. This is an explicit freshness check: the builder never guesses that
an arbitrary archive is latest. It rejects dirty/uncommitted sources and probes
the exact updater's healthy status response and app-path compatibility before
building. It stamps `runtime/version.json`, uses version+commit in the image's
release directory and filename, and audits actual FAT/ext4 file contents against
source hashes before publishing the image and its checksum. The JSON receipt
also covers the initial updater record and the release's separate `image.json`
composition identity. Fresh installs report the bundled version and start with
that version's anti-replay floor, not sequence zero. `image.json` is not an
invented signed manifest: every downloaded update still requires the release
signature, while checking the same signed version reports up to date. Older
signed versions cannot replace the installed image.

The JSON receipt records exact source commit/version, pinned firmware/runtime hashes, required
boot files and all packaged app files, image digest/size, and
`hardware_validated: false`. Read-only independent USB diagnostics and the boot
progress service are registered on the **first** boot, without precreating
`/storage/.config` and breaking stock resize.

For a supported customer device, optionally add
`--management-public-key /path/to/customer-support-key.pub`. For stock USB provisioning, also supply
`--device-cid <target-emmc-cid>` to build a separate artifact for that unit; the
installer rejects unbound images and other units’ CID bindings. Only valid **public**
keys are accepted. Never supply a private key or clone a provisioned customer's
image for another customer. No management listener is enabled without explicit
public-key provisioning. Provisioning enables normal management on port 2222 and
an independent recovery listener on 2223; both require that key. Recovery's
Python implementation is on FAT, not in a Cubby release, so a missing/broken app
or failed boot trial does not remove access. It generates its own persistent
private host key on the device outside browser-bound state; none is shipped.
Stock USB setup and Cubby's diagnostics unit own USB configuration; the recovery
listener never initializes or reconfigures the gadget. Put
`CUBBY-MANAGEMENT-DISABLED` on FAT to disable both management listeners.

Recheck downloaded/copied artifacts before selecting a disk to flash:

```sh
uv run rocknix/production_image.py verify \
  --image /path/to/Cubby-Arcade-RG353V-v0.34.0-<COMMIT>.img.gz \
  --manifest /path/to/Cubby-Arcade-RG353V-v0.34.0-<COMMIT>.img.gz.json \
  --expect-version 0.34.0 --expect-commit <FULL_COMMIT>
```

This checks the compressed image digest and reads its actual FAT/ext4 files,
including the boot artwork, current updater, and packaged app version. The JSON
is a build receipt, **not a signature**: obtain image and receipt from the trusted
release channel and independently select the expected commit. Do not trust an
unknown sender who supplies both bytes and an altered receipt. Neither command
writes physical disks, enables a management key by default, publishes a release,
or marks hardware certified.

Before calling an image customer-ready, flash that exact artifact on a clean
supported unit/card and record: first boot/resize and cold boot artwork, Wi-Fi
setup and reboot reconnect, USB and provisioned recovery access with Cubby
stopped, accelerated UI, physical controls, sound, explicit game installation,
offline game launch/saves,
signed update and trial rollback, sleep/wake, and reboot persistence. Preserve
checksums, commit, device model and the observed results with the artifact.
Install test games only during commissioning, then remove their packages, saves,
profiles and temporary bench-network/setup data before customer handoff. A
fresh image audit is not proof of post-commissioning cleanup.
Software tests or repair of an already-upgraded device do not satisfy this gate.

### Selecting the current public installation image

Use the full `Cubby-Arcade-RG353V-vX.Y.Z-<commit>.img.gz` image from the intended
versioned GitHub release, with its matching `.json` receipt and `.sha256` file.
Do not use a date-only archived image and assume app updates will repair it.
Each new release now builds and publishes this image as a mandatory gate before
advancing app updates. The receipt ties the boot partition, updater and app
inventory to the exact release source. Hardware acceptance remains a separate
record; a receipt with `hardware_validated: false` is not a certification.

Public downloads have no device/customer SSH keys. For a managed device, use the
explicit public-key provisioning build described above, keep that artifact
separate from public downloads, and verify recovery access on the target unit.

### Stock Android USB entry (candidate)

For the resumable host-side stock Android transport, profile boundaries,
no-backup behavior, exact image readback, pinned recovery enrollment and remaining
hardware acceptance requirements, see [stock USB provisioning](stock-usb-provisioning.md).
This is separate from the SSH bundle installer and does not yet certify an
unattended customer-ready installation.

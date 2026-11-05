# Cubby Arcade on RG353V

**Download one image. Flash the card. Insert it and power on.**

The image already contains ROCKNIX, WPE, Cubby, and an offline copy of Trail Mix.
No terminal, Python, SSH, network setup, or second installation is required.
Wi-Fi is optional for downloading more games later.

## Adult setup

You need an **Anbernic RG353V** (not RG353VS), a charged battery, a reliable
microSD card (**16 GB minimum; 32 GB recommended**), and a computer/card reader.

1. **Download `Cubby-Arcade-RG353V-20261101.img.gz`.** This is the complete image,
   not the source ZIP, advanced maintenance kit, or development VM disk.
2. **Flash it with [balenaEtcher](https://etcher.balena.io/).** Select the `.img.gz`,
   select the intended microSD card, and Flash. This erases that card; back up
   anything on it first. Keep Etcher's verification enabled.
3. **Insert the card in the handheld's OS slot and power on.** Leave it powered
   while ROCKNIX expands the storage partition and automatically reboots.
   Cubby is configured to open fullscreen; Trail Mix is already installed.

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
release and keeps its bootloader, kernel, device trees, immutable `SYSTEM`, disk
GUID, partition GUIDs, and partition starts. It adds a tiny boot hook and recovery
note to FAT, then prepopulates an enlarged `STORAGE` filesystem with the verified
ARM64 WPE runtime and Cubby. The hook creates only a volatile systemd override;
it does not prepopulate `.config`/`.cache`, which would prevent stock first-boot
resize. Upstream's RK3566 resize expands the existing filesystem without
formatting it, preserving the preinstalled runtime and game.

On the Linux build host, after building the WPE rootfs:

```sh
unshare --map-auto --map-root-user uv run rocknix/image.py \
  --rocknix .cache/rg353v-image-input/ROCKNIX-RK3566.aarch64-20261101-Generic.img.gz \
  --rootfs .cache/rg353v-bundle/rootfs.tar.xz \
  --output .cache/Cubby-Arcade-RG353V-20261101.img.gz
```

The namespace preserves numeric ownership without sudo. Build tools are `uv`,
`unshare`, `tar`, `dumpe2fs`, `debugfs`, `mkfs.ext4`, and `e2fsck`; Python build
dependencies are pinned in the script. The image builder writes only regular
files, never physical disks. It validates upstream and rootfs checksums, GPT
checksums/layout, and the created filesystem; it generates an image SHA-256
sidecar. Trail Mix's release manifest and verified file inventory, source commit,
and input checksums are recorded under `/storage/cubby/image-provenance`.

Advanced SSH installation onto an existing supported ROCKNIX card remains
available in [the maintenance guide](rg353v-maintenance.md). It is **not** the
normal consumer setup. Neither tool wipes internal Android.

## Automatic USB diagnostics

Newly built images enable a read-only diagnostic link over USB, independent of
Cubby's browser and display startup. See [USB diagnostics](rg353v-usb-diagnostics.md)
for the Linux host command, logs available, opt-out, and early-boot limitations.
Images flashed before this addition need updating; rebuilding does not update
the connected handheld automatically.

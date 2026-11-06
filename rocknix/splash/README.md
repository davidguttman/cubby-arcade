# Cubby RG353V boot artwork

The source composition reuses Cubby's existing Steam handheld/orbit/sunset art.
`source.png` is the ImageGen-adapted 4:3 composition; `preview.png` is the exact
640×480 display sampling. `assets/steam/` retains the original Steam art.
The requested **Cubby** wordmark is a branding exception to the usual wordless
child-facing UI; the boot screen has no instructions or reading requirement.

Maintainers regenerate only the technical display encodings with ImageMagick:

```sh
uv run python rocknix/boot_splash.py prepare rocknix/splash/source.png
```

The two `.raw` files are little-endian XRGB8888 and RGB565. Their checksums,
geometry, framebuffer stride, pan offset, rotation, and channel layout are
checked before the early shell renderer writes any bytes. Supported fb0 is
640×480 with virtual size 640×480, zero pan/rotation, 32-bit XRGB8888 (stride
2560), or 16-bit RGB565 (stride 1280). Unknown layouts, nonzero device-tree
rotation, missing/corrupt data, other models, and `CUBBY-DISABLED` use stock
ROCKNIX rendering. A mock framebuffer alone does not prove panel initialization; see the physical
RG353V evidence below.
No kernel, bootloader, initramfs, SYSTEM image, game data or saves are patched.

## Existing Cubby card: offline install and restore

Power the handheld off, remove its card, and mount the FAT **boot** partition
on a computer. The following path is an example mount point, not a device.
Do not point this tool at `/dev/...`, the STORAGE partition, or a running
handheld's mounted `/flash`.

```sh
uv run python rocknix/boot_splash.py install /media/you/CUBBYBOOT
# To restore the exact previous post-sysroot hook and remove owned splash files:
uv run python rocknix/boot_splash.py remove /media/you/CUBBYBOOT
```

Installation accepts only the exact current Cubby `post-sysroot.sh` baseline or
the pre-diagnostics baseline from `3c113fc` (SHA-256
`718957a1a6d059cd5f44d754f75a63024d69f7b03682c6f31436996c6c7ac213`);
custom/unmanaged hooks are refused. It appends only the splash loader to that
baseline, without adding diagnostics/Wi-Fi dependencies to older cards.
It retains the original hook, stages the
raster files first, and activates through an atomic hook rename last. Repeating
an identical install is harmless. Modified hooks/files and unknown extra files
are preserved/refused, not overwritten or removed. Unmount the card cleanly
before returning it to the handheld. This is a boot-partition installation,
not an app update; installing a regular Cubby app update does not install it.

New `rocknix/image.py` images include the same hook, assets, and recovery backup.
An empty `CUBBY-DISABLED` file on the boot partition bypasses the custom screen
and launches the existing stock recovery path. This change does not replace an
earlier bootloader logo if a device firmware independently displays one.

## Why not `oemsplash.png`?

Upstream source inspected at distribution commit
`cefc14339a4ae18c02bb69888f27835e50664b60` (ROCKNIX 20261101):

- `projects/ROCKNIX/packages/sysutils/busybox/scripts/init` defines
  `load_splash()` at line 486, invoking `/usr/bin/rocknix-splash` directly.
- `mount_sysroot()` sources `/flash/post-sysroot.sh` at line 289; the boot loop
  calls `mount_sysroot` at 1304, then `mount_storage`, then `load_splash` at 1306.
  The existing supported hook can therefore replace the shell function before
  invocation, without replacing the firmware binary.
- `projects/ROCKNIX/packages/sysutils/busybox/config/busybox-init.conf` enables
  `fbset` (fancy/readmode), `dd`, `sha256sum` with check support, `tr`,
  `grep`, `cat`, and ash builtins. `FBSPLASH`, `find`, and `od` are disabled.
  Rotation inspection therefore uses shell-glob recursion and checks the hash
  of the exact four-byte zero rotation value, not unavailable applets.
- `projects/ROCKNIX/packages/tools/rocknix-splash/package.mk` pins
  `9d295bcb74be2282e32c6b614efbea6036974ba8`. That Git object was not retrievable
  through the tree API during development; current upstream `main.c` hardcodes
  ROCKNIX SVG paths. The firmware-specific init, rather than that moving source,
  determines this hook contract.

The generic `packages/sysutils/busybox/scripts/init` has an OEM PNG path but is
**not** the ROCKNIX-specific init used here. Merely copying `oemsplash.png` would
not replace this pinned renderer. Cold power-on and a direct view of the early boot sequence remain unverified.

After a successful framebuffer write, the early renderer records
`rendered 640x480 <depth>` in `/run/cubby-splash.status`. This volatile marker
survives the root switch and proves execution, not physical panel appearance.
Failure to write this diagnostic marker does not prevent the custom splash.

## Physical RG353V verification — 2026-11-06

Installed over authenticated SSH on the existing ROCKNIX 20261101 card. The
exact older Cubby hook was preserved; only the splash-loader stanza was added.
The boot partition was returned to read-only. An additional original-hook backup
is at `/storage/cubby/repair-backups/cubby-boot-screen-20261106/` on this device.

- Live fb0: 640×480, 32-bit XRGB8888, stride 2560, zero pan/rotation;
  no device-tree rotation properties.
- Invoked the guarded renderer on the handheld; its full framebuffer readback
  matched `splash-32.raw` SHA-256
  `8e63b06b54ea253f5216037b3e7ee9c2522b7bd33c3eee51d7fc2c634402c5cc`.
  Decoded and inspected that readback: clear Cubby wordmark and correct artwork.
- Reboot changed boot ID from `dc93be0f-efd2-4465-a2d9-d4dcfd66cafb` to
  `988b91b0-def4-412c-a2db-819a72b8f990`. Without manually invoking the renderer
  after boot, `/run/cubby-splash.status` contained `rendered 640x480 32`, proving
  the early hook successfully wrote the framebuffer. The marker is best-effort
  volatile evidence, not a panel photograph or a persistent card write.
- Cubby `essway` returned active; a direct Wayland screenshot showed the hub.
  USB NCM and authenticated SSH also returned after reboot.

This verifies a warm reboot on this unit. Cold power-on, optical capture of
splash duration/transition, and the 16-bit format on real hardware were not tested.

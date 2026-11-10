# Cubby RG353V boot artwork

The source composition reuses Cubby's Steam handheld/orbit/sunset art.
`source.png` is the 4:3 composition; `preview.png` is the exact 640×480 display
sampling. `assets/steam/` retains the original Steam art. The **Cubby** wordmark
is a branding exception to the usual wordless child-facing UI; the boot screen
has no instructions or reading requirement.

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
ROCKNIX rendering. A mock framebuffer alone does not prove panel initialization; see the
hardware test notes below.
No kernel, bootloader, initramfs, SYSTEM image, game data or saves are patched.

## Holding the art for the whole boot

`load.sh` draws the art, then unbinds the text console. Otherwise systemd's console
reset zeroes the framebuffer as it starts, and ROCKNIX's boot messages draw over it.
`runtime/native/rg353v/boot-screen/boot-screen.py` then keeps the art up with a
progress bar: on the framebuffer before Sway, then as an overlay layer surface once
Sway runs. It exits when the hub reports it has painted (`/api/ui-ready` touches
`cubby-ui-ready` in the runtime directory), or after 60 seconds so recovery is never hidden.

The overlay buffer must keep a format with alpha. Sway sends no frame callbacks
to a window under an opaque surface, so an opaque overlay stops the hub painting
and the boot screen then waits for a signal it is preventing.

The stars twinkle on both surfaces. Their boxes are a table in `boot-screen.py`, found
by `rocknix/boot_splash.py stars rocknix/splash/splash-32.raw` and tied to this exact art by its
hash, so a card with other art just stays still. After replacing the art, run that
command and paste the table in; a test fails until you do. Before the service starts
(about 3.5 seconds in), only the early hook has drawn, so the stars begin there.

The bar estimates from the last boot's time (`/storage/cubby/state/boot-seconds`).
Updates deliver the unit and script: `rocknix/network.py` installs the unit once a
release passes its trial. `load.sh` stays on `/flash` with the rest of the card's
boot files. Initramfs sources it, so a bad write can stop the device booting and no
rollback reaches it, which keeps it outside updates (see `docs/rg353v-updates.md`).
New images carry it; an existing card without it uses the offline installer below,
and until then the art may clear early before the service redraws it.
Nothing draws before that early hook runs, so the screen stays dark from the reset until then.

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
  `9d295bcb74be2282e32c6b614efbea6036974ba8`; upstream `main.c` hardcodes
  ROCKNIX SVG paths. The firmware-specific init, rather than that source,
  determines this hook contract.

The generic `packages/sysutils/busybox/scripts/init` has an OEM PNG path but is
**not** the ROCKNIX-specific init used here. Merely copying `oemsplash.png` would
not replace this pinned renderer.

After a successful framebuffer write, the early renderer records
`rendered 640x480 <depth>` in `/run/cubby-splash.status`. This volatile marker
survives the root switch and proves execution, not physical panel appearance.
Failure to write this diagnostic marker does not prevent the custom splash.

## Hardware testing

Installed on an RG353V running ROCKNIX 20261101 from an existing Cubby card;
only the splash-loader stanza was added to the existing hook.

- Live fb0: 640×480, 32-bit XRGB8888, stride 2560, zero pan/rotation;
  no device-tree rotation properties.
- The guarded renderer's full framebuffer readback matched `splash-32.raw`
  SHA-256 `8e63b06b54ea253f5216037b3e7ee9c2522b7bd33c3eee51d7fc2c634402c5cc`.
- After a warm reboot, without manually invoking the renderer,
  `/run/cubby-splash.status` contained `rendered 640x480 32`, showing the early
  hook wrote the framebuffer. Cubby, USB NCM and SSH came back normally.

The 16-bit format has not been run on hardware.

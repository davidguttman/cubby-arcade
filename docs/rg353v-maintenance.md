# Cubby Arcade on Anbernic RG353V — adult setup

The intended result is **power on → ROCKNIX → fullscreen WPE → Cubby**.
Games install locally from Cubby's Store and saves remain on the card. No
Electron, Chromium, desktop navigation, or game rewrite is involved.

**Status:** installation tools are implemented for ROCKNIX **20261101** on the
**RG353V**, not RG353VS. A successful build or VM test is not hardware validation.
Screen/GPU acceleration, physical controls, sound, suspend/resume and cold boot
must pass on a real RG353V before this kit is described as a certified install.

## What you need

- RG353V with a charged battery, a reliable microSD card (32 GB recommended; at least 6 GiB free on `/storage`),
  card reader, and Wi-Fi. Back up existing card data first.
- Computer with Python **3.11+** and OpenSSH (`ssh`). macOS/Linux are supported;
  on Windows use Python 3.11+ and Windows' OpenSSH client in PowerShell.
- The **complete prebuilt Cubby RG353V kit**, including `install.py`, `device/`,
  `cubby-rg353v.tar.gz`, its `.sha256` file, and this guide. End users do not build
  WPE or install developer tools. Keep the kit together in one extracted folder.
  Until an actual kit is published, the source checkout alone is not that kit.

## 1. Put ROCKNIX on the card

Use the pinned [ROCKNIX 20261101 release](https://github.com/ROCKNIX/distribution/releases/tag/20261101):

**`ROCKNIX-RK3566.aarch64-20261101-Generic.img.gz`** — the release's device table
lists RG353V under **Generic**, not Specific. Download the matching `.sha256`
and verify it before flashing. Use an imaging app such as
[balenaEtcher](https://etcher.balena.io/) to select this image and the intended
microSD card; flashing erases that card. Do **not** flash Cubby's QEMU/VM disk.

Follow the [RG353V-specific ROCKNIX instructions](https://rocknix.org/devices/anbernic/rg353pmvvs/)
and the [ROCKNIX install guide](https://rocknix.org/play/install/).
**Important dual-boot prerequisite:** upstream currently says RG353V users may
need to erase the internal Android installation for ROCKNIX to boot. That is
separate from flashing a card, destroys Android, and is **not performed by this
installer**. Read the upstream backup/recovery instructions before deciding;
do not erase internal storage just to try Cubby's helper. First establish that
this particular handheld boots supported ROCKNIX normally.

Insert the prepared card in the OS slot, boot and allow first-boot setup to
finish. Confirm the stock interface, screen, buttons and sound work before
installing Cubby. Do not update ROCKNIX past the pinned release until Cubby's
integration has been validated against that release.

## 2. Connect the handheld

In ROCKNIX's adult system/network settings, connect Wi-Fi, enable SSH, note the
IP address, and note the configured root password. The computer must be on the
same network. The installer prompts through OpenSSH; it does not save passwords.
On the first connection, check the handheld address before accepting its SSH
host-key fingerprint. No cloud account or API keys are required.

## 3. Run one setup command

Open a terminal in the extracted kit folder. Replace `192.168.1.50` with the
handheld's address:

```sh
python3 install.py install 192.168.1.50
```

On Windows, use `py -3 install.py install 192.168.1.50`.

The helper verifies the kit checksum locally, checks the exact device, OS,
release and startup service over SSH, uploads the kit, verifies it again, stages
its WPE runtime, checks that Cog/Python can load, and only then changes startup.
It leaves ROCKNIX's compositor, graphics and audio services in charge. Cubby's
runtime and data live in `/storage/cubby`; the immutable OS is not rewritten.
The final activation restarts the stock UI service with Cubby's client wrapper.

An interrupted or rejected setup must not be called a successful installation.
Keep its error output. The helper removes its own interrupted staging directory and restores startup if
activation fails. It does not delete unknown directories or previous releases.

## 4. Confirm the actual handheld

After setup, Cubby should appear fullscreen. Cold boot once. Confirm:

- Cubby appears without selecting an app or opening a browser.
- D-pad, face/shoulder buttons and back/home behavior work.
- Store artwork loads; download a game and launch it locally.
- Sound, saves, sleep/wake and the system volume/power buttons behave correctly.
- Disconnect Wi-Fi and cold boot: the library and installed games still work.
- Reconnect Wi-Fi: Store discovery and installations resume.

These are hardware acceptance criteria, not claims that a software build proves
them. The startup wrapper returns to stock ROCKNIX after three failed launches
per boot, rather than keeping a broken browser in a restart loop.

## Recovery and uninstall

Restore the stock interface while keeping Cubby games and saves:

```sh
python3 install.py uninstall 192.168.1.50
```

For emergency bypass over SSH:

```sh
ssh root@192.168.1.50 'touch /storage/cubby/DISABLED; systemctl restart essway.service'
```

If networking is unavailable, power off cleanly, mount the card's Linux
`STORAGE` partition on another Linux computer, create the empty file
`cubby/DISABLED` on that partition, then return the card to the handheld and boot.
Windows/macOS generally cannot mount this Linux partition without extra tools.
The bypass leaves the original ROCKNIX launcher intact. Installing the kit again
re-enables Cubby and retains `/storage/cubby/state`. Uninstall intentionally does
not erase downloads, saves, caches, or runtime releases.

## Maintainer packaging (not the end-user flow)

Build and verify the Debian ARM64 rootfs with the checked-in rootfs build tool,
then assemble the kit from this checkout:

```sh
uv run python rocknix/package.py --rootfs /path/to/rootfs.tar.xz --output .cache/rg353v-kit
```

The output includes the installer and all device scripts beside the verified
bundle. Distribute the **whole directory**, not just `install.py`. Keep published
checksums with the kit and use a trusted distribution channel; checksums detect
corruption, not replacement of both an archive and its checksum by an attacker.
The source host can explicitly select a bundle with `--bundle PATH --sha256 HEX`.

### Upstream integration provenance

The installation contract was inspected against ROCKNIX tag `20261101`, commit
`cefc14339a4ae18c02bb69888f27835e50664b60`:

- `projects/ROCKNIX/packages/ui/emulationstation/system.d/essway.service`:
  starts `/usr/bin/start_es.sh`, requires `sway.service`.
- `packages/sysutils/systemd/patches/0001-move-etc-systemd-system-to-storage-.config-system.d.patch`:
  persistent unit configuration is `/storage/.config/system.d`.
- `projects/ROCKNIX/packages/wayland/sway` and compositor profile:
  host Wayland runtime is `/var/run/0-runtime-dir`.

The installer owns only
`/storage/.config/system.d/essway.service.d/90-cubby.conf`; it refuses to replace
an unmanaged file at that path. No stock unit is masked, deleted or overwritten.

## Cubby boot artwork

New Cubby images include a custom boot screen derived from the Steam artwork.
Existing compatible Cubby cards can install it without rewriting firmware or
saves using the [offline boot-artwork installer and exact restore procedure](../rocknix/splash/README.md).
App updates carry the service that holds it on screen until the hub paints; the
early loader stays a boot-partition file. Framebuffer layouts
outside the documented guard retain the stock screen. The linked guide records
physical RG353V framebuffer and warm-reboot evidence, plus untested cold-boot limits.

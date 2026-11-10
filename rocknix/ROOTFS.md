# ARM64 WPE runtime build (maintainers)

The adult installer consumes a prebuilt `rootfs.tar.xz`; families do not build
WebKit or install Debian packages themselves. This is **not** a bootable OS
image. ROCKNIX supplies the kernel, firmware, input, audio server and Wayland
compositor; the Debian chroot supplies WPE/Cog and its matching userspace
libraries, Python and media codecs.

On Linux, with GNU tar, curl, xz, subordinate UID/GID ranges and working user
namespaces:

```sh
# On x86 Linux, also install/register ARM64 qemu-user-static/binfmt.
rocknix/build-rootfs.sh
```

Output defaults to `.cache/rg353v-bundle/`; the optional first argument changes
the output directory and the second changes the download/build cache. The
builder needs several GB of free disk. It does not use Docker, sudo or the
project's development server. Debian package scripts run inside a private
mount/PID/user namespace and service startup is blocked during the build.

The base is pinned to an official Debian artifact commit and its OCI SHA-256.
APT resolves against the signed Debian and Debian-security snapshots at
`20261027T000000Z`, not a moving `latest`. Package versions are recorded in
`packages.tsv`; `sources.tsv` records their corresponding Debian source package
names and versions. This fixes the dependency inputs, not every generated
timestamp in the resulting archive. `SHA256SUMS` identifies the exact built
archive to distribute. Preserve that checksum and provenance with each release.

The image retains Debian package copyright/license files under
`/usr/share/doc/*/copyright`. Corresponding Debian source packages are available
from the same snapshot: configure matching `deb-src` entries (same suites and
snapshot URLs as the rootfs's `etc/apt/sources.list.d/debian.sources`) and run
`apt-get source SOURCE_PACKAGE=SOURCE_VERSION` using the recorded source
inventory. Keep these records and the applicable source-access/license notices
with distributed runtime bundles. Cubby's source is distributed separately.

The builder executes ARM64 `cog --version`, imports Python's SSL/YAML/server
modules and checks Cog's shared-library closure before archiving. The Wayland
and headless Cog modules and Bubblewrap are required. It does not start a
compositor, force software rendering, or certify RG353V graphics/audio/input.
Actual device boot, accelerated rendering, controls, sound, saves and sleep/wake
still require the hardware acceptance checks in the installation guide.

## RG353V production GTK4 kiosk runtime

The original `build-rootfs.sh` output remains the pinned **baseline**, not the
RG353V production runtime. The RG353V kernel uses Mali kbase, and its EGL
implementation lacks the Wayland extension required by Cog's stock `wl` plugin.
The integration used on hardware is WPE 2.48.3 and Cog 0.18.4's upstream GTK4
backend with the small opt-in patch in `patches/cog-0.18.4-gtk4-kiosk.patch`.
`COG_PLATFORM_GTK4_KIOSK=1` hides browser chrome and requests fullscreen; it does
not replace rendering/input code. `GSK_RENDERER=opengl` is a supported GTK4
setting, unlike the deprecated `gl` alias.

```sh
rocknix/build-kiosk-rootfs.sh \
  .cache/rg353v-bundle/rootfs.tar.xz \
  .cache/rg353v-kiosk-runtime
```

This recipe checks the baseline, Cog source, patch, signed Debian metadata and
all baseline package versions. Snapshot is `20261027T000000Z`; mirror fallback
is accepted only while its signed InRelease digest is identical to the pinned
snapshot. The runtime excludes the build toolchain and retains package licenses,
Cog COPYING, the patch, package inventory and provenance. Like the baseline,
this fixes inputs but not generated timestamps: every rebuilt archive needs an
independent audit and reviewed digest change, not automatic acceptance.

### Cog launcher carried by app releases

`rocknix/session.sh` runs `runtime/native/rg353v/cog`, not the runtime's copy.
WebKit's default website policy (autoplay without sound) overrides
`media-playback-requires-user-gesture`, and gamepad input is never a user
gesture, so the runtime's Cog holds game audio until a touch. The extra
`patches/cog-0.18.4-autoplay.patch` sets the policy to allow in the kiosk profile.

The launcher is a separate file so that a Cog fix can ship in a normal release
without changing the pinned runtime. It lives under `runtime/` because the
legacy `app.zip` has to carry it to devices on the baseline coordinator, and the
servers' explicit allowlists keep it from being served to pages. Rebuild it with
`rocknix/build-bundled-cog.sh COG_SOURCE.tar.gz`. Accept it on hardware: from a
cold game launch with only gamepad input, `pactl list short sink-inputs` must
show a stream and the game must be audible.

Archive downloads use `apt_archives.py` in both build and runtime phases.
It resolves apt's selected versions without downloading, requires each archive's
size and SHA256 from the authenticated package indexes, then fetches boundedly
from the pinned snapshot or the corresponding official Debian mirror. Mirror
fallback never refreshes indexes or changes package selection. Only verified,
atomically cached archives reach `apt-get --no-download`; missing historical
packages or different bytes fail the build. Download planning has 90-second
subprocess limits, fetches have a 15-minute total budget and 15-second socket
timeouts. Blocking DNS, header, and body operations run in a disposable Python
process; the caller enforces the wall deadline, kills/reaps that process before
cleaning partial files, and never publishes a timed-out attempt. This does not
replace caller signal handlers and works from worker threads too. Installation
is bounded to ten minutes per phase.

The pinned, hardware-tested archive has SHA256
`e1859403acf7593e5b2ad9b932092258302f415a093959de24fd402b7475ee92`.
Image composition requires that exact runtime, and it stays on every device. A
newer one ships through `rocknix/runtime.json`; see `docs/rg353v-updates.md`. The Linux
payload packager follows the same pin; the old baseline is rejected.

At launch the private chroot namespace self-binds its root and preserves the
host runtime-directory alias used by accessibility D-Bus. Only the matching
five stock ROCKNIX GPU library files are checksum-checked and read-only bound;
no host libc, broad `/usr`, or additional system bus is exposed. Their hashes
are tied to the pinned ROCKNIX release. A Bubblewrap wrapper preserves every
argument and adds only `/dev/dma_heap/system`; WebKit's sandbox stays enabled.
Actual device screenshots, Mali-G52 EGL/GLES identity, WebProcess seccomp,
NoNewPrivs and PID namespace were verified in the isolated kiosk probe.

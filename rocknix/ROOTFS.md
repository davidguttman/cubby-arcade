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

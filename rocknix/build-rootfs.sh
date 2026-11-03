#!/usr/bin/env bash
# Build on Linux without Docker or root. On x86, install qemu-user-static/binfmt
# and configure subordinate uid/gid ranges for unshare --map-auto first.
set -euo pipefail
BASE_COMMIT=e36653f9967231373aeba7cff2102fd004ac4f4a
BASE_SHA256=dfb68c024d5cdf4872bb7f0be8d63874aa6d0b7a0050f1b06169573e34ea543a
SNAPSHOT=20261027T000000Z
if [[ ${1:-} == --help ]]; then
  echo 'Usage: rocknix/build-rootfs.sh [OUTPUT_DIRECTORY] [CACHE_DIRECTORY]'
  echo 'Requires Linux user namespaces, subordinate uid/gid ranges, curl, xz, GNU tar, and ARM64 binfmt on non-ARM hosts.'
  exit 0
fi
project=$(cd "$(dirname "$0")/.." && pwd)
output=$(realpath -m "${1:-$project/.cache/rg353v-bundle}")
cache=$(realpath -m "${2:-$project/.cache/rg353v-build}")
mkdir -p "$output" "$cache"
base="$cache/debian-arm64-$BASE_COMMIT.tar.gz"
if [[ ! -f $base ]]; then
  curl --fail --location --retry 3 \
    "https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/$BASE_COMMIT/trixie/oci/blobs/rootfs.tar.gz" \
    --output "$base.download"
  mv "$base.download" "$base"
fi
printf '%s  %s\n' "$BASE_SHA256" "$base" | sha256sum --check --status
build=$(mktemp -d "$cache/rootfs.XXXXXXXX")
echo "Building ARM64 WPE in $build"
# Mounts and processes cannot escape this namespace; PID namespace enables proc.
unshare --map-auto --map-root-user --mount --pid --fork \
  bash -s -- "$base" "$build" "$output" "$SNAPSHOT" "$BASE_COMMIT" "$BASE_SHA256" <<'BUILD'
set -euo pipefail
base=$1 root=$2 output=$3 snapshot=$4 base_commit=$5 base_hash=$6
mount --make-rprivate /
tar xzf "$base" -C "$root"
cp --dereference /etc/resolv.conf "$root/etc/resolv.conf"
mkdir -p "$root/proc" "$root/dev" "$root/sys" "$root/run/host-runtime" "$root/opt/cubby" "$root/var/lib/handheld"
mount --rbind /dev "$root/dev"
mount --make-rslave "$root/dev"
mount -t proc proc "$root/proc"
cat >"$root/etc/apt/sources.list.d/debian.sources" <<EOF
Types: deb
URIs: http://snapshot.debian.org/archive/debian/$snapshot/
Suites: trixie trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp
Check-Valid-Until: no

Types: deb
URIs: http://snapshot.debian.org/archive/debian-security/$snapshot/
Suites: trixie-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp
Check-Valid-Until: no
EOF
# A signed APT snapshot pins dependency resolution; transport need not be trusted.
printf '#!/bin/sh\nexit 101\n' >"$root/usr/sbin/policy-rc.d"
chmod 755 "$root/usr/sbin/policy-rc.d"
chroot "$root" /usr/bin/env DEBIAN_FRONTEND=noninteractive /bin/sh -ec '
  apt-get -o Acquire::Retries=3 update
  apt-get -y --no-install-recommends install cog python3 python3-yaml \
    ca-certificates libgl1-mesa-dri libegl-mesa0 fonts-dejavu-core \
    gstreamer1.0-gl gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    gstreamer1.0-libav pulseaudio-utils
  test "$(dpkg --print-architecture)" = arm64
  cog --version
  test -f /usr/lib/aarch64-linux-gnu/cog/modules/libcogplatform-wl.so
  test -f /usr/lib/aarch64-linux-gnu/cog/modules/libcogplatform-headless.so
  test -x /usr/bin/bwrap
  python3 -c "import ssl, yaml, http.server; print(ssl.OPENSSL_VERSION)"
  ldd /usr/bin/cog > /tmp/cog-libraries.txt
  if grep -q "not found" /tmp/cog-libraries.txt; then
    echo "Cog has unresolved shared-library dependencies:" >&2
    cat /tmp/cog-libraries.txt >&2
    exit 1
  fi
  mkdir -p /usr/share/cubby-build
  dpkg-query -W -f="\${Package}\t\${Version}\t\${Architecture}\n" > /usr/share/cubby-build/packages.tsv
  dpkg-query -W -f="\${binary:Package}\t\${source:Package}\t\${source:Version}\n" > /usr/share/cubby-build/sources.tsv
  cp /tmp/cog-libraries.txt /usr/share/cubby-build/
  apt-get clean
  rm -f /tmp/cog-libraries.txt
  rm -rf /var/lib/apt/lists/*
'
printf 'base_commit=%s\nbase_sha256=%s\ndebian_snapshot=%s\n' "$base_commit" "$base_hash" "$snapshot" >"$root/usr/share/cubby-build/provenance.txt"
cp "$root/usr/share/cubby-build/packages.tsv" "$output/packages.tsv"
cp "$root/usr/share/cubby-build/sources.tsv" "$output/sources.tsv"
cp "$root/usr/share/cubby-build/provenance.txt" "$output/provenance.txt"
# All Debian copyright/license files remain inside the shipped rootfs.
# Never ship host DNS details; the device launcher supplies its own resolv.conf.
: >"$root/etc/resolv.conf"
umount "$root/proc"
umount --lazy "$root/dev"
# A probe without /dev mounted can create a regular /dev/null file. It is not a
# device and must not carry probe output into the distributed rootfs.
if [[ -f "$root/dev/null" && ! -L "$root/dev/null" ]]; then
  rm -f -- "$root/dev/null"
fi
# Runtime directories may contain package-created empty directories/symlinks
# (for example /run/shm -> /dev/shm), never transient files or devices.
if [[ -n $(find "$root/dev" "$root/proc" "$root/sys" "$root/run" \
  -mindepth 1 ! -type d ! -type l -print -quit) ]]; then
  echo 'Refusing to archive transient runtime files or devices.' >&2
  exit 1
fi
tar --numeric-owner -C "$root" -c . | xz -T0 -3 >"$output/rootfs.tar.xz.tmp"
mv "$output/rootfs.tar.xz.tmp" "$output/rootfs.tar.xz"
cd "$output"
sha256sum rootfs.tar.xz >SHA256SUMS
# Cleanup must run inside this namespace because rootfs has subordinate owners.
rm -rf -- "$root"
BUILD
echo "Built $output/rootfs.tar.xz (checksum, package inventory and provenance alongside)"

#!/usr/bin/env bash
# Linux user namespaces, subordinate IDs and ARM64 binfmt; no Docker or sudo.
set -euo pipefail
BASE_SHA=a0976631e2be72ba9d20334609771fab39048d10b2228c9b60942cee60d566bb
COG_SHA=fc426f71c7438e708896c989e268625846abf72eed2dfd053448555db7f8f77b
PATCH_SHA=644dd5ca0258a7a34dd219fefaf98916995a69fc87347012257a10950cbd7aba
RELEASE_SHA=0584fba32e13e0ab8285fb16c27adea1ec03a73669c18702821094fd6ca86675
if [[ ${1:-} == --help ]]; then
  echo 'Usage: rocknix/build-kiosk-rootfs.sh BASE_ROOTFS.tar.xz OUTPUT_DIRECTORY [CACHE_DIRECTORY]'
  echo 'Build the baseline with build-rootfs.sh first; independently validate new runtime digests.'
  exit 0
fi
project=$(cd "$(dirname "$0")/.." && pwd)
baseline=$(realpath "${1:?baseline required}")
output=$(realpath -m "${2:?output directory required}")
cache=$(realpath -m "${3:-$project/.cache/gtk4-runtime-build}")
[[ ! -e $output ]] || { echo 'Refusing existing runtime output' >&2; exit 1; }
printf '%s  %s\n' "$BASE_SHA" "$baseline" | sha256sum -c --status
mkdir -p "$cache"
source_tar=$cache/cog-0.18.4.tar.gz
if [[ ! -e $source_tar ]]; then
  curl --fail --location --retry 3 https://codeload.github.com/Igalia/cog/tar.gz/refs/tags/0.18.4 --output "$source_tar.download"
  mv "$source_tar.download" "$source_tar"
fi
printf '%s  %s\n' "$COG_SHA" "$source_tar" | sha256sum -c --status
patch=$project/rocknix/patches/cog-0.18.4-gtk4-kiosk.patch
printf '%s  %s\n' "$PATCH_SHA" "$patch" | sha256sum -c --status
stage=$(mktemp -d "$cache/build.XXXXXXXX")
unshare --map-auto --map-root-user --mount --pid --fork bash -s -- "$stage" "$baseline" "$source_tar" "$patch" "$RELEASE_SHA" "$BASE_SHA" "$COG_SHA" "$PATCH_SHA" "$project/rocknix/apt_archives.py" <<'BUILD'
set -euo pipefail
stage=$1 baseline=$2 source_tar=$3 patch=$4 release_hash=$5 base_hash=$6 source_hash=$7 patch_hash=$8 archive_helper=$9
mount --make-rprivate /
mkdir "$stage/build" "$stage/runtime"
tar -xJf "$baseline" -C "$stage/build"
root=$stage/build
cp --dereference /etc/resolv.conf "$root/etc/resolv.conf"
mkdir -p "$root/opt/cog-source"
tar -xzf "$source_tar" -C "$root/opt/cog-source" --strip-components=1
cp "$patch" "$root/tmp/cubby-kiosk.patch"
cp "$archive_helper" "$root/tmp/cubby-apt-archives.py"
mount --rbind /dev "$root/dev"; mount --make-rslave "$root/dev"; mount -t proc proc "$root/proc"
trap 'umount "$root/proc" || true; umount --lazy "$root/dev" || true' EXIT
cat > "$root/etc/apt/sources.list.d/debian.sources" <<'SOURCES'
Types: deb
URIs: http://snapshot.debian.org/archive/debian/20261027T000000Z/
Suites: trixie
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp
Check-Valid-Until: no
By-Hash: force

Types: deb
URIs: http://snapshot.debian.org/archive/debian-security/20261027T000000Z/
Suites: trixie-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp
Check-Valid-Until: no
By-Hash: force
SOURCES
chroot "$root" /usr/bin/env DEBIAN_FRONTEND=noninteractive RELEASE_HASH="$release_hash" /bin/bash -s <<'CHROOT'
set -euo pipefail
# The fallback is usable only while its signed metadata is byte-identical to
# the pinned snapshot. A later mirror update fails closed before installation.
if ! apt-get -o Acquire::Retries=3 update; then
  sed -i 's|http://snapshot.debian.org/archive/debian/20261027T000000Z/|https://deb.debian.org/debian|' /etc/apt/sources.list.d/debian.sources
  apt-get -o Acquire::Retries=3 -o Acquire::By-Hash=force update
fi
release=$(find /var/lib/apt/lists -maxdepth 1 -name '*_dists_trixie_InRelease' -print)
[[ -n $release && $(printf '%s\n' "$release" | wc -l) == 1 ]]
printf '%s  %s\n' "$RELEASE_HASH" "$release" | sha256sum -c
dpkg-query -W -f='Package: ${binary:Package}\nPin: version ${Version}\nPin-Priority: 1001\n\n' > /etc/apt/preferences.d/cubby-baseline
python3 /tmp/cubby-apt-archives.py install build-essential meson ninja-build pkg-config patch libwpewebkit-2.0-dev=2.48.3-1 libwpebackend-fdo-1.0-dev=1.16.0-1 libgtk-4-dev=4.18.6+ds-2 libepoxy-dev libmanette-0.2-dev
cd /opt/cog-source
patch -p1 < /tmp/cubby-kiosk.patch
meson setup build --prefix=/opt/cubby-cog-gtk4-kiosk -Dplatforms=gtk4 -Dwpe_api=2.0 -Ddocumentation=false -Dmanpages=false
meson compile -C build -j 4
meson install -C build
CHROOT
umount "$root/proc"; umount --lazy "$root/dev"; trap - EXIT
tar -xJf "$baseline" -C "$stage/runtime"
target=$stage/runtime
cp --dereference /etc/resolv.conf "$target/etc/resolv.conf"
cp "$root/etc/apt/sources.list.d/debian.sources" "$target/etc/apt/sources.list.d/debian.sources"
cp "$root/etc/apt/preferences.d/cubby-baseline" "$target/etc/apt/preferences.d/cubby-baseline"
cp -a "$root/var/lib/apt/lists/." "$target/var/lib/apt/lists/"
cp "$archive_helper" "$target/tmp/cubby-apt-archives.py"
root=$target
mount --rbind /dev "$root/dev"; mount --make-rslave "$root/dev"; mount -t proc proc "$root/proc"
trap 'umount "$root/proc" || true; umount --lazy "$root/dev" || true' EXIT
chroot "$root" /usr/bin/env DEBIAN_FRONTEND=noninteractive python3 /tmp/cubby-apt-archives.py install libgtk-4-1=4.18.6+ds-2 libepoxy0=1.5.10-2 libgles2=1.7.0-1+b2
cp -a "$stage/build/opt/cubby-cog-gtk4-kiosk" "$root/opt/"
mkdir -p "$root/usr/share/cubby-kiosk-build"
cp "$stage/build/opt/cog-source/COPYING" "$root/usr/share/cubby-kiosk-build/COPYING.cog"
cp "$patch" "$root/usr/share/cubby-kiosk-build/"
printf 'baseline_sha256=%s\ncog_source_sha256=%s\nkiosk_patch_sha256=%s\nmain_inrelease_sha256=%s\nsnapshot=20261027T000000Z\n' "$base_hash" "$source_hash" "$patch_hash" "$release_hash" > "$root/usr/share/cubby-kiosk-build/provenance.txt"
chroot "$root" /bin/bash -s <<'CHROOT'
set -euo pipefail
/opt/cubby-cog-gtk4-kiosk/bin/cog --version
ldd /opt/cubby-cog-gtk4-kiosk/bin/cog > /usr/share/cubby-kiosk-build/ldd.txt
find /opt/cubby-cog-gtk4-kiosk -type f -name '*.so*' -exec sh -c 'ldd "$1"' _ {} \; >> /usr/share/cubby-kiosk-build/ldd.txt
! grep -q 'not found' /usr/share/cubby-kiosk-build/ldd.txt
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' > /usr/share/cubby-kiosk-build/packages.tsv
python3 - <<'PY'
from pathlib import Path
def inventory(path):
    return dict(line.split('\t',1) for line in Path(path).read_text().splitlines())
before=inventory('/usr/share/cubby-build/packages.tsv')
after=inventory('/usr/share/cubby-kiosk-build/packages.tsv')
assert all(after.get(name)==version for name,version in before.items()), 'Baseline package versions changed'
PY
apt-get clean
rm -f /tmp/cubby-apt-archives.py
rm -f /var/lib/apt/lists/* 2>/dev/null || true
CHROOT
: > "$root/etc/resolv.conf"
umount "$root/proc"; umount --lazy "$root/dev"; trap - EXIT
[[ -z $(find "$root/dev" "$root/proc" "$root/sys" "$root/run" -mindepth 1 ! -type d ! -type l -print -quit) ]]
tar --numeric-owner -C "$root" -c . | xz -T4 -3 > "$stage/rootfs.tar.xz"
cd "$stage"
sha256sum rootfs.tar.xz > SHA256SUMS
xz -t rootfs.tar.xz
BUILD
mkdir "$output"
mv "$stage/rootfs.tar.xz" "$stage/SHA256SUMS" "$output/"
echo "Built $output/rootfs.tar.xz; independently validate before changing the pinned runtime digest."

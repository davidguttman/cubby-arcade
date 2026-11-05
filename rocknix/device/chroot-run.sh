#!/bin/bash
set -euo pipefail
RELEASE=$1
BASE=/storage/cubby
# BusyBox remount looks up canonical mount targets, not release symlink aliases.
ROOT=$(readlink -f "$RELEASE/rootfs")
mkdir -p "$BASE/state" "$ROOT/var/lib/handheld" "$ROOT/opt/cubby" \
  "$ROOT/run/host-runtime" "$ROOT/run/udev" "$ROOT/run/cubby-network" "$ROOT/run/cubby-updater"
# Never unmount another task's mounts. Our service owns this private namespace.
if [ "${CUBBY_MOUNT_NAMESPACE:-}" != yes ]; then
  exec unshare --mount --propagation private env CUBBY_MOUNT_NAMESPACE=yes "$0" "$RELEASE"
fi
# Bubblewrap must be able to make the chroot root a slave mount.
mount --bind "$ROOT" "$ROOT"
mount --rbind /dev "$ROOT/dev"
mount --make-rslave "$ROOT/dev"
mount -t proc proc "$ROOT/proc"
mount --rbind /sys "$ROOT/sys"
mount --make-rslave "$ROOT/sys"
mount --bind /run/udev "$ROOT/run/udev"
mount --bind /var/run/0-runtime-dir "$ROOT/run/host-runtime"
# The accessibility D-Bus returns its native absolute runtime path. /var/run
# inside Debian points to /run: preserve that alias without exposing host /run.
[ ! -e "$ROOT/run/0-runtime-dir" ] || [ -L "$ROOT/run/0-runtime-dir" ]
ln -sfn host-runtime "$ROOT/run/0-runtime-dir"
# The pinned kernel uses Mali kbase, not Panfrost. Bind the matching ROCKNIX
# userspace graphics closure only, never host libc or a broad host /usr mount.
[ -c /dev/mali0 ] && [ -c /dev/dma_heap/system ]
mkdir -p "$ROOT/usr/lib/rocknix-gpu"
while read -r expected library; do
  source=$(readlink -f "/usr/lib/$library")
  [ -f "$source" ] || { echo "Cubby: missing ROCKNIX GPU library $library" >&2; exit 1; }
  printf '%s  %s\n' "$expected" "$source" | sha256sum -c -s
  target="$ROOT/usr/lib/rocknix-gpu/$library"
  [ ! -L "$target" ]
  [ -e "$target" ] || touch "$target"
  mount --bind "$source" "$target"
  mount -o remount,bind,ro "$target"
done <<'GPU_LIBRARIES'
7d1102a454df100cbf4ecada381aadf51050c4b1795221c5d881073e728d5448 libEGL.so.1
88e5534e0763a5465be5a9c747cddeef1b06edb97dd4e6ecccc7f36ce21d5dfa libGLESv2.so.2
150d90ace2f01be82f9df042205b2902e30ac5336cc45b915410a7ec8428d775 libgbm.so.1
605e3a5caf1be62bb48d97b1168434257355d56db5e3be9b515cfa742c173118 libmali.so.1
cc5acbd57a64808d8cb3892745c87c30df3b5bae79e57142005ced48b15b8564 libmali-hook.so.1
GPU_LIBRARIES
# Preserve every original Bubblewrap argument and the sandbox itself. Both
# aliases are mounts in this private namespace; original runtime bytes remain.
[ -e "$ROOT/usr/bin/bwrap.cubby-original" ] || touch "$ROOT/usr/bin/bwrap.cubby-original"
mount --bind "$ROOT/usr/bin/bwrap" "$ROOT/usr/bin/bwrap.cubby-original"
mount --bind "$RELEASE/device/bwrap-dma-heap.py" "$ROOT/usr/bin/bwrap"
mount --bind "$BASE/state" "$ROOT/var/lib/handheld"
mount --bind "$RELEASE/app" "$ROOT/opt/cubby"
# Copy only public resolver configuration; never host identity or credentials.
rm -f "$ROOT/etc/resolv.conf"
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"
# Keep NetworkManager and its D-Bus outside the browser's chroot. The client
# receives only a private UNIX socket, never the system bus or host /etc.
NETWORK_DIR=$(mktemp -d /run/cubby-network.XXXXXX)
network_pid=
browser_pid=
cleanup() {
  [ -z "$browser_pid" ] || kill "$browser_pid" 2>/dev/null || true
  [ -z "$network_pid" ] || kill "$network_pid" 2>/dev/null || true
  [ -z "$browser_pid" ] || wait "$browser_pid" 2>/dev/null || true
  [ -z "$network_pid" ] || wait "$network_pid" 2>/dev/null || true
  rm -f "$NETWORK_DIR/socket"
  rmdir "$NETWORK_DIR"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
/usr/bin/python3 "$RELEASE/app/rocknix/network.py" --socket "$NETWORK_DIR/socket" --state "$BASE/state" &
network_pid=$!
for ((n=0; n<50; n++)); do
  kill -0 "$network_pid"
  [ ! -S "$NETWORK_DIR/socket" ] || break
  sleep .1
done
[ -S "$NETWORK_DIR/socket" ]
mount --bind "$NETWORK_DIR" "$ROOT/run/cubby-network"
if [ -S /run/cubby-updater/socket ]; then
  mount --bind /run/cubby-updater "$ROOT/run/cubby-updater"
fi
chroot "$ROOT" /usr/bin/env LD_LIBRARY_PATH=/usr/lib/rocknix-gpu:/opt/cubby-cog-gtk4-kiosk/lib/aarch64-linux-gnu /bin/bash /opt/cubby/rocknix/session.sh &
browser_pid=$!
wait "$browser_pid"

#!/bin/bash
set -euo pipefail
RELEASE=$1
BASE=/storage/cubby
ROOT=$RELEASE/rootfs
mkdir -p "$BASE/state" "$ROOT/var/lib/handheld" "$ROOT/opt/cubby" \
  "$ROOT/run/host-runtime" "$ROOT/run/udev" "$ROOT/run/cubby-network"
# Never unmount another task's mounts. Our service owns this private namespace.
if [ "${CUBBY_MOUNT_NAMESPACE:-}" != yes ]; then
  exec unshare --mount --propagation private env CUBBY_MOUNT_NAMESPACE=yes "$0" "$RELEASE"
fi
mount --rbind /dev "$ROOT/dev"
mount --make-rslave "$ROOT/dev"
mount -t proc proc "$ROOT/proc"
mount --rbind /sys "$ROOT/sys"
mount --make-rslave "$ROOT/sys"
mount --bind /run/udev "$ROOT/run/udev"
mount --bind /var/run/0-runtime-dir "$ROOT/run/host-runtime"
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
chroot "$ROOT" /bin/bash /opt/cubby/rocknix/session.sh &
browser_pid=$!
wait "$browser_pid"

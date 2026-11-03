#!/bin/bash
set -euo pipefail
RELEASE=$1
BASE=/storage/cubby
ROOT=$RELEASE/rootfs
mkdir -p "$BASE/state" "$ROOT/var/lib/handheld" "$ROOT/opt/cubby" \
  "$ROOT/run/host-runtime" "$ROOT/run/udev"
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
exec chroot "$ROOT" /bin/bash /opt/cubby/rocknix/session.sh

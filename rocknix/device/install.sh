#!/bin/bash
# Invoked by install.py after model/release/archive validation and upload.
set -euo pipefail
DIGEST=$1
[[ "$DIGEST" =~ ^[a-f0-9]{64}$ ]] || exit 1
BASE=/storage/cubby
UPLOAD=/storage/cubby-upload-$DIGEST.tar.gz
DROP=/storage/.config/system.d/essway.service.d/90-cubby.conf
MARKER='# Managed by Cubby Arcade RG353V installer'
mkdir -p "$BASE"
exec 9>"$BASE/.install.lock"
flock -n 9 || { echo 'Another Cubby installation is running.' >&2; exit 1; }
if [ -e "$DROP" ] && ! grep -qxF "$MARKER" "$DROP"; then
  echo "Refusing to replace unmanaged $DROP" >&2; exit 1
fi
printf '%s  %s\n' "$DIGEST" "$UPLOAD" | sha256sum -c -
mkdir -p "$BASE/releases" "$BASE/state" "$(dirname "$DROP")"
STAGE=$BASE/releases/.stage-$DIGEST-$$
FINAL=$BASE/releases/$DIGEST
BACKUP=$BASE/dropin-before-install-$$
OLD=$(readlink "$BASE/current" || true)
WAS_DISABLED=no
[ ! -e "$BASE/DISABLED" ] || WAS_DISABLED=yes
TRANSACTION=no
COMMITTED=no
cleanup() {
  code=$?
  trap - EXIT
  if [ "$TRANSACTION" = yes ] && [ "$COMMITTED" != yes ]; then
    if [ -n "$OLD" ]; then
      ln -s "$OLD" "$BASE/current.rollback-$$"
      mv -Tf "$BASE/current.rollback-$$" "$BASE/current"
    else
      rm -f "$BASE/current"
    fi
    if [ -e "$BACKUP" ]; then mv "$BACKUP" "$DROP"; else rm -f "$DROP"; fi
    if [ "$WAS_DISABLED" = yes ]; then touch "$BASE/DISABLED"; else rm -f "$BASE/DISABLED"; fi
    systemctl daemon-reload || true
    systemctl restart essway.service || true
  fi
  # STAGE includes this invocation's PID; never clean unknown prior work.
  rm -rf -- "$STAGE"
  rm -f "$BACKUP" "$BASE/current.new-$$" "$DROP.tmp-$$"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ ! -d "$FINAL" ]; then
  AVAILABLE=$(df -Pk /storage | awk 'END {print $4}')
  [ "$AVAILABLE" -ge 6291456 ] || { echo 'At least 6 GiB free on /storage is required for staging.' >&2; exit 1; }
  mkdir "$STAGE"
  tar -xzf "$UPLOAD" -C "$STAGE"
  (cd "$STAGE" && sha256sum -c SHA256SUMS)
  mkdir "$STAGE/rootfs"
  tar -xJf "$STAGE/rootfs.tar.xz" -C "$STAGE/rootfs" --numeric-owner
  [ -x "$STAGE/rootfs/usr/bin/cog" ] && [ -x "$STAGE/rootfs/usr/bin/python3" ]
  [ -f "$STAGE/app/rocknix/session.sh" ] && [ -x "$STAGE/device/launch.sh" ]
  mv "$STAGE" "$FINAL"
fi
[ -x "$FINAL/rootfs/usr/bin/cog" ] && [ -x "$FINAL/rootfs/usr/bin/python3" ]
[ -f "$FINAL/app/rocknix/session.sh" ] && [ -x "$FINAL/device/launch.sh" ]
# Even Cog's version query initializes GLib and needs the normal device/proc
# environment. Keep probe mounts private and let namespace teardown remove them;
# no probe failure can leave mounts behind or alter the active release.
unshare --mount --propagation private bash -s -- "$FINAL/rootfs" <<'RUNTIME_PROBE'
set -euo pipefail
ROOT=$1
mount --rbind /dev "$ROOT/dev"
mount --make-rslave "$ROOT/dev"
mount -t proc proc "$ROOT/proc"
chroot "$ROOT" /usr/bin/python3 --version
chroot "$ROOT" /usr/bin/cog --version
RUNTIME_PROBE
[ ! -e "$DROP" ] || cp "$DROP" "$BACKUP"
TRANSACTION=yes
ln -s "releases/$DIGEST" "$BASE/current.new-$$"
mv -Tf "$BASE/current.new-$$" "$BASE/current"
printf '%s\n[Service]\nExecStart=\nExecStart=/storage/cubby/current/device/launch.sh\n' "$MARKER" > "$DROP.tmp-$$"
mv "$DROP.tmp-$$" "$DROP"
# First coordinator only. Updates install the guarded boot entry over it and keep this copy.
mkdir -p "$BASE/updater"
if [ ! -e "$BASE/updater/coordinator.py" ] && [ -f "$FINAL/app/rocknix/updates.py" ]; then
  cp "$FINAL/app/rocknix/updates.py" "$BASE/updater/coordinator.py"
fi
systemctl daemon-reload
# Activation happens only after all preflight gates.
rm -f "$BASE/DISABLED"
systemctl restart essway.service
COMMITTED=yes
rm -f "$UPLOAD"
echo 'Cubby installed and startup configured. Hardware acceptance checks remain required.'

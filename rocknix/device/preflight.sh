#!/bin/bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'SSH must use the ROCKNIX root account.' >&2; exit 1; }
[ "$(uname -m)" = aarch64 ] || { echo 'Requires aarch64 ROCKNIX on RG353V.' >&2; exit 1; }
. /etc/os-release
[ "${NAME:-}" = ROCKNIX ] || [ "${ID:-}" = rocknix ] || { echo 'Requires ROCKNIX.' >&2; exit 1; }
MODEL=$(tr -d '\0' < /proc/device-tree/model)
case "$MODEL" in "Anbernic RG353V") ;; *) echo "Unsupported device: $MODEL" >&2; exit 1;; esac
[ "${VERSION_ID:-}" = 20261101 ] || [ "${1:-}" = recovery ] || { echo 'This installer targets ROCKNIX 20261101; other releases are not validated.' >&2; exit 1; }
for cmd in tar sha256sum systemctl mount unshare chroot readlink flock df awk; do
  command -v "$cmd" >/dev/null || { echo "Missing ROCKNIX command: $cmd" >&2; exit 1; }
done
systemctl cat essway.service | grep -q '/usr/bin/start_es.sh' || { echo 'Expected ROCKNIX essway.service not found.' >&2; exit 1; }
[ -d /storage/.config/system.d ] || { echo 'Persistent ROCKNIX systemd directory missing.' >&2; exit 1; }
[ -w /storage ] || exit 1
printf 'Verified: %s / ROCKNIX %s\n' "$MODEL" "$VERSION_ID"

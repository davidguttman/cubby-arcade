#!/bin/bash
set -euo pipefail
BASE=/storage/cubby
DROP=/storage/.config/system.d/essway.service.d/90-cubby.conf
MARKER='# Managed by Cubby Arcade RG353V installer'
if [ -e "$DROP" ] && ! grep -qxF "$MARKER" "$DROP"; then
  echo "Refusing to remove unmanaged $DROP" >&2; exit 1
fi
mkdir -p "$BASE"
touch "$BASE/DISABLED"
rm -f "$DROP"
systemctl daemon-reload
systemctl restart essway.service
echo 'Stock ROCKNIX startup restored. Cubby downloads, saves and runtime remain in /storage/cubby.'

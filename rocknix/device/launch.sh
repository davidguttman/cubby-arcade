#!/bin/bash
# Runs as essway.service's client, leaving ROCKNIX's Sway/GPU/audio services intact.
set -eu
BASE=/storage/cubby
STOCK=/usr/bin/start_es.sh
fallback() { exec "$STOCK"; }
[ ! -e "$BASE/DISABLED" ] || fallback
# The updater coordinator is a baseline file outside replaceable app releases.
if [ -f "$BASE/updater/coordinator.py" ]; then
  exec /usr/bin/python3 "$BASE/updater/coordinator.py" supervise
fi
RELEASE=$(readlink -f "$BASE/current") || fallback
[ -x "$RELEASE/rootfs/usr/bin/cog" ] || fallback
[ -f "$RELEASE/app/rocknix/session.sh" ] || fallback
# /run is cleared on every boot. Once exhausted, stock ES is used until reboot.
COUNT=/run/cubby-launch-failures
n=0
[ ! -f "$COUNT" ] || read -r n < "$COUNT"
[[ "$n" =~ ^[0-9]+$ ]] || n=3
[ "$n" -lt 3 ] || fallback
while [ "$n" -lt 3 ] && [ ! -e "$BASE/DISABLED" ]; do
  RELEASE=$(readlink -f "$BASE/current") || fallback
  if "$RELEASE/device/chroot-run.sh" "$RELEASE"; then
    # A deliberate close returns to stock ES, rather than trapping an adult.
    fallback
  fi
  n=$((n + 1))
  printf '%s\n' "$n" > "$COUNT"
  sleep 2
done
fallback

#!/bin/sh
# Sourced by the managed post-sysroot hook BEFORE initramfs load_splash.
# Pinned ROCKNIX 20261101; no kernel, initramfs, SYSTEM, or bootloader changes.
# The initramfs disables find/od/hexdump. Traverse with ash's built-in glob
# and accept only the hash of an exact four-byte big-endian zero property.
cubby_rotation_clear() {
  [ -d "$1" ] && [ -r "$1" ] && [ -x "$1" ] && [ "$2" -le 64 ] || return 1
  for cubby_entry in "$1"/*; do
    if [ "${cubby_entry##*/}" = rotation ]; then
      [ -f "$cubby_entry" ] && [ -r "$cubby_entry" ] || return 1
      cubby_rotation_hash=$(sha256sum "$cubby_entry") || return 1
      [ "${cubby_rotation_hash%% *}" = 'df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119' ] || return 1
    elif [ -d "$cubby_entry" ]; then
      cubby_rotation_clear "$cubby_entry" "$(( $2 + 1 ))" || return 1
    fi
  done
}

cubby_show_splash() {
  [ "$(tr -d '\000' < /proc/device-tree/model)" = 'Anbernic RG353V' ] || return 1
  [ ! -e /flash/CUBBY-DISABLED ] || return 1
  [ "$(cat /sys/class/graphics/fb0/virtual_size)" = '640,480' ] || return 1
  [ "$(cat /sys/class/graphics/fb0/pan)" = '0,0' ] || return 1
  [ "$(cat /sys/class/graphics/fb0/rotate)" = '0' ] || return 1
  # Match the stock renderer's device-tree rotation contract. Unknown rotation
  # falls back to stock rather than displaying sideways/corrupt pixels.
  cubby_rotation_clear /proc/device-tree 0 || return 1
  cubby_depth=$(cat /sys/class/graphics/fb0/bits_per_pixel) || return 1
  cubby_layout=$(fbset -s) || return 1
  case "$cubby_depth" in
    32)
      [ "$(cat /sys/class/graphics/fb0/stride)" = '2560' ] || return 1
      echo "$cubby_layout" | grep -q '^[[:space:]]*rgba 8/16,8/8,8/0,0/0[[:space:]]*$' || return 1
      ;;
    16)
      [ "$(cat /sys/class/graphics/fb0/stride)" = '1280' ] || return 1
      echo "$cubby_layout" | grep -q '^[[:space:]]*rgba 5/11,6/5,5/0,0/0[[:space:]]*$' || return 1
      ;;
    *) return 1 ;;
  esac
  echo "$cubby_layout" | grep -q "^[[:space:]]*geometry 640 480 640 480 $cubby_depth[[:space:]]*$" || return 1
  (cd /flash/cubby-splash && sha256sum -c "splash-$cubby_depth.sha256" >/dev/null 2>&1) || return 1
  dd if="/flash/cubby-splash/splash-$cubby_depth.raw" of=/dev/fb0 bs=4096 2>/dev/null || return 1
  # /run is moved into the real root; retain boot execution evidence without
  # writing to the card. Diagnostics must not turn a successful draw into failure.
  { printf 'rendered 640x480 %s\n' "$cubby_depth" > /run/cubby-splash.status; } 2>/dev/null || :
  return 0
}

load_splash() {
  if cubby_show_splash; then return 0; fi
  # Exact stock fallback from the pinned ROCKNIX-specific init, not the generic
  # LibreELEC init (whose oemsplash.png path is not used by this firmware).
  /usr/bin/rocknix-splash
  echo -en "\033[1000H\033[2K$(cat /sysroot/etc/issue)\n\n" >/dev/console
  if [ -f /storage/.configured ]; then
    echo -ne "\033[1000H\033[2K==> Loading, please wait..." >/dev/console
  else
    echo -ne "\033[1000H\033[2K==> Initializing, please wait..." >/dev/console
  fi
}

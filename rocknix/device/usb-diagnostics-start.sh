#!/bin/sh
# Native ROCKNIX tools, independent of Cubby's chroot, compositor, and browser.
set -eu
[ ! -e /flash/CUBBY-USB-DISABLED ] || exit 0
mkdir -p /storage/.cache/usbgadget
# At runtime only: preseeding .cache in the image would suppress stock resizing.
printf 'USB_MODE=cdc\n' > /storage/.cache/usbgadget/usbgadget.conf
if [ ! -s /storage/.cache/systemd-machine-id ]; then
  cp /etc/machine-id /storage/.cache/systemd-machine-id
fi
# Stock autostart prepares configfs once, even when its default mode is disabled.
# --start is not idempotent: a second call unbinds CDC, then fails creating the
# existing MTP directory. Select the prepared network mode instead. This native
# operation also safely reuses an active gadget when the listener restarts.
/usr/bin/usbgadget network

#!/bin/sh
# Native ROCKNIX tools, independent of Cubby's chroot, compositor, and browser.
set -eu
[ ! -e /flash/CUBBY-USB-DISABLED ] || exit 0
[ ! -e /run/cubby-usb-initialized ] || exit 0
mkdir -p /storage/.cache/usbgadget
# At runtime only: preseeding .cache in the image would suppress stock resizing.
printf 'USB_MODE=cdc\n' > /storage/.cache/usbgadget/usbgadget.conf
if [ ! -s /storage/.cache/systemd-machine-id ]; then
  cp /etc/machine-id /storage/.cache/systemd-machine-id
fi
/usr/bin/usbgadget --start
touch /run/cubby-usb-initialized

#!/bin/bash
# userconfig.service must finish before writing the native ROCKNIX setting.
# network-base-setup reads this same setting for the kernel hostname and Avahi.
set -e
. /etc/profile.d/001-functions
device_hostname=$(/usr/bin/python3 /flash/cubby-device-identity/identity.py)
if [ "$(get_setting system.hostname)" != "$device_hostname" ]; then
  set_setting system.hostname "$device_hostname"
fi
/usr/bin/hostname "$device_hostname"

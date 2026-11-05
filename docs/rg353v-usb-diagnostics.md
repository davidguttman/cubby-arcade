# RG353V USB boot diagnostics (adult/developer flow)

The Cubby image enables ROCKNIX's native **USB NCM networking** automatically.
The host can retrieve status without Wi-Fi, Android ADB, browser startup, or a
person reading the screen. This is read-only diagnostics, not a remote root
shell. It needs no password or pairing because its listener is restricted to the
USB `gadget` interface with Linux `SO_BINDTODEVICE`; it never listens on Wi-Fi.
Only connect a trusted computer: kernel and service logs can contain local paths
and operational information.

## On the Linux host

1. Leave a USB data cable connected to the handheld's **DC** port (the port used
   for Android recovery/USB device mode), not its host-only OTG port.
2. When ROCKNIX starts, Linux should enumerate a USB NCM Ethernet device
   (`lsusb` typically shows `1d6b:0104`; `ip -br link` shows a new Ethernet link).
   NetworkManager normally obtains `169.254.170.1` from ROCKNIX's DHCP server.
3. Retrieve status:
   ```sh
   curl --noproxy '*' --connect-timeout 5 --max-time 45 \
     http://169.254.170.2:8765/status > cubby-status.json
   ```
   If automatic address setup is disabled, identify the **USB** interface first,
   then assign `169.254.170.1/16` to that interface and bring it up. Do not change
   an unrelated Wi-Fi/LAN interface. No default route is necessary.

The JSON includes the boot ID/model/uptime, `/storage` mount, kernel log tail,
Sway/EmulationStation/Cubby service status, and their journal tails. Only exact
`GET /status` is accepted; there are no file-reading, command, reboot, or write
endpoints. Commands have timeouts and output tails. Every 15 seconds while idle,
the service also replaces `/storage/cubby/diagnostics/latest.json`; that file
can be inspected offline after a failed boot. It is the latest snapshot, not a
complete persistent journal.

## Boot wiring and limits

- `rocknix/image.py` adds the service/scripts to the FAT partition and registers
  the service through `/post-sysroot.sh` in initramfs. No kernel, bootloader, DTB,
  or stock SYSTEM bytes are changed.
- The native `usbgadget --start` configures NCM and its RK3566 cable-reconnect
  workaround. Setup runs before ROCKNIX autostart. The diagnostic Python process
  uses **native ROCKNIX Python**, not Cubby's WPE chroot. If stock autostart
  recreates the USB interface, systemd restarts the listener on its new index.
- Diagnostics remain enabled if `CUBBY-DISABLED` returns the UI to stock ROCKNIX.
  Create `CUBBY-USB-DISABLED` on the FAT partition to disable diagnostics; it
  prevents automatic diagnostic gadget setup on the next boot. Existing ROCKNIX
  USB mode settings remain native ROCKNIX's responsibility.
- `.cache` is created **at runtime**, not preseeded: stock first-boot storage
  expansion remains intact. That expansion can reboot before diagnostics appear.
- This begins after initramfs has mounted storage and handed off to systemd.
  It cannot report a dead bootloader, kernel panic before userspace, failed
  storage mount, wrong DTB/no UDC, or a charge-only/bad cable. Those failures can
  still require recovery mode, serial hardware, or physical intervention.
- The pinned RK3566 kernel enables NCM/ECM but explicitly disables ACM/serial
  gadget functions, so a USB serial console cannot be added as configuration
  alone. Native NCM avoids rebuilding or replacing the official kernel.

Evidence inspected: official release `20261101` RK3566 kernel configuration;
`projects/ROCKNIX/packages/rocknix/sources/scripts/usbgadget`, native autostart and
udev rules; actual pinned SYSTEM containing `/usr/bin/python3.14` and
`/usr/bin/usbgadget`. Source/HTTP tests do **not** prove physical enumeration.

**Hardware status:** USB enumeration, host DHCP, and status retrieval from the
physical RG353V remain unverified. An image already flashed before this change
has none of these additions. Rebuilding alone does not update that device.

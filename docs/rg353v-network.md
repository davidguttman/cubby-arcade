# RG353V Wi-Fi and required adult onboarding

The device image runs **ROCKNIX → Wayland/Sway → WPE/Cog → Cubby**. Wi-Fi is
owned by ROCKNIX, not a separate network manager inside the browser's rootfs.
Internet is required to complete initial setup and fetch new content. It is not
required to launch already installed games after setup.

## Adult flow

On first launch the local device server opens a distinct **Connect Cubby** page:

1. Find nearby Wi-Fi networks and choose a supported home network.
2. Enter the password with D-pad + A on the on-screen keyboard. L/R switches
   case; the keyboard includes printable ASCII symbols and space. B returns to
   network selection, Start connects. USB keyboard/pointer also work.
3. The device connects and checks the real Cubby catalog using HTTPS with normal
   certificate validation. Wi-Fi association or a captive-portal page alone is
   not sufficient. The adult can retry a wrong password or unavailable internet.
4. **Continue to Cubby** becomes available after the verified internet check
   saves the completion marker. Loading a game URL directly does not bypass it.

Completion is stored in `/storage/cubby/state/network-onboarded.json`. On later
boots the local hub and installed games remain usable offline; this marker does
not mean current internet access is guaranteed. Return to adult Wi-Fi settings
from the Wi-Fi tile on the hub's gear tab, which asks a random math question first.
Holding **L + R + Start for two seconds** jumps to that tab.
Adult settings can change networks and recheck internet without erasing games,
saves, browser state or previous networking configuration.

The initial supported networks are visible, open or WPA-personal (WPA2, and
WPA3/SAE when reported by NetworkManager) home networks. Enterprise/802.1X, WEP,
hidden-SSID entry, captive-portal login, and non-ASCII password entry are not
implemented. Unsupported security is shown explicitly rather than attempting
an insecure fallback. Valid personal passwords are 8–63 printable ASCII
characters, or a 64-hex WPA PSK (not WPA3/SAE). A connection to a router without
working DNS/TLS/catalog access cannot complete onboarding.

## Implementation and privilege boundary

Pinned upstream **ROCKNIX 20261101** uses **NetworkManager 1.51.4 with iwd** for
Wi-Fi, not ConnMan. Evidence inspected in the release tag:

- [`wifictl`](https://github.com/ROCKNIX/distribution/blob/20261101/projects/ROCKNIX/packages/rocknix/sources/scripts/wifictl)
- [`NetworkManager.conf`](https://github.com/ROCKNIX/distribution/blob/20261101/projects/ROCKNIX/packages/network/networkmanager/config/NetworkManager.conf)
- [`package.mk`](https://github.com/ROCKNIX/distribution/blob/20261101/projects/ROCKNIX/packages/network/networkmanager/package.mk)

`rocknix/device/chroot-run.sh` starts the stdlib host helper
`rocknix/network.py` in the service's private mount namespace and binds its
root-only UNIX socket into the WPE rootfs. No system D-Bus or host credential
directory is exposed to the browser, and no host network-control TCP port is
opened. Its small JSON protocol allows only status, scan, connect and finish.
It rejects unknown fields/actions; there is no arbitrary shell/path/URL API.

The local HTTP bridge requires the adult-page session token, exact local Host
and Origin, and adult-page Referer. It rejects game-frame referrers and network
operations during active gameplay/package installation. Adult HTML is not
cacheable or frameable, and its token is not injected into the child hub.
Games remain trusted same-origin code as documented elsewhere in this project;
these request guards are not a sandbox against a malicious trusted game.

Credentials never go in process argv, logs, Cubby state JSON or browser storage.
The helper creates a uniquely named mode-0600 NetworkManager keyfile in the
upstream configured `/storage/.config/NetworkManager/system-connections` path.
The SSID is encoded as a byte array; keyfile passwords are escaped, not shell
interpolated. Only fixed nmcli properties/commands are used. Candidate profiles
have autoconnect disabled until connection succeeds; successful profiles enable
NetworkManager autoconnect for subsequent boot/wake. Failed candidates are
removed without deleting previously saved adult profiles. Password input is
cleared when submitted or when leaving the entry screen.

On native ROCKNIX, a successful adult connection also writes the non-secret
`wifi.enabled=1` setting through `rocknix-settings`. Stock late boot reads this
flag and otherwise disables the radio even when NetworkManager has a saved
autoconnect profile. A failed connection does not change the flag; a failed
settings write reports connection failure and removes only the new candidate
instead of claiming a persistent connection. Desktop/simulation runs do not
invoke the native settings writer. Existing affected installations should
reconnect once from adult Wi-Fi settings after updating; startup does not
silently override a deliberately disabled radio.

The helper is started at runtime only, after ROCKNIX has mounted/expanded storage.
No `/storage/.config` is preseeded in the flashable image, preserving the stock
first-boot expansion behavior. Normal package/image builders include this code
through their existing recursive `rocknix`/`device` packaging.

## Verification without changing the host network

### Bounded early-driver recovery

The image includes a separate host-side `cubby-wifi-recovery.service`, ordered
before the frontend but not required for it to start. It is outside replaceable
Cubby app releases. For the exact `Anbernic RG353V` model and Realtek SDIO
`024c:c821` only, it can perform one driver-stack reload after this boot's kernel
journal confirms Bluetooth firmware initialization. An existing target wireless
interface—even disconnected—is never reloaded. Absent SDIO enumeration, missing
Bluetooth evidence, or another wireless/rtw88 consumer means no reload.
It allows six seconds for normal SDIO discovery before declaring it absent.

The helper has a 45-second service limit and bounded command/wait phases; failed
removal still attempts driver restoration. It neither changes Wi-Fi credentials
nor unloads USB/Bluetooth. Create `/flash/CUBBY-WIFI-RECOVERY-DISABLED` to skip it.
Its latest result is journaled and saved best-effort in
`/storage/cubby/diagnostics/wifi-recovery.txt`, also exposed by USB diagnostics.

**Hardware limitation:** the observed late reload created an interface and scan
results only with the tested 25 MHz/non-UHS device-tree candidate. The original
DTB failed before SDIO enumeration; this helper alone cannot fix that condition.
This change does not modify device trees. Cold boot, authentication, HTTPS,
reconnection and sleep/wake still need hardware acceptance.

Session startup now waits up to 30 seconds for a real Wayland socket, respecting
an explicit display instead of silently choosing another. Small rotated event
logs live at `state/session.log` and `state/session.previous.log`; writing them is
best-effort. The update trial budget includes these readiness phases, and USB
diagnostics includes both logs to distinguish frontend startup failures.

```sh
uv run --python 3.12 python -m unittest discover -s tests -p test_rocknix_network.py
uv run tests/browser_device_network.py --cdp http://127.0.0.1:18800 --screenshots .cache/wifi-ui-evidence
```

The browser check connects to the existing **OpenClaw** browser profile's CDP
endpoint, opens/closes only its own page and starts a disposable loopback Python
fixture. The page explicitly says **SIMULATION** and accepts `cubby-test`; it
never invokes nmcli or changes host Wi-Fi. Tests cover controller movement,
entry/case/Start, wrong-password retry, required completion, offline reload and
adult settings access. The Python suite also checks request guards, the UNIX
protocol, generated keyfile permissions, NM's real **offline** keyfile parser
when available, profile cleanup, and rejection of captive/invalid catalog data.

For manual desktop-only preview use an isolated state directory:

```sh
CUBBY_NETWORK_SIMULATION=1 CUBBY_STATE=/tmp/cubby-network-preview uv run python -m rocknix.server
```

This is not physical-device certification. Real RG353V radio enumeration,
WPA2/WPA3 authentication, DNS/time/TLS, reboot autoconnect and sleep/wake require
hardware verification. The installed eMMC is not changed by building these files.
An existing installation needs the new Cubby payload before it has onboarding.
Cubby binary updates and post-onboarding game-download behavior are separate
features; this Wi-Fi flow does not claim to implement their release machinery.

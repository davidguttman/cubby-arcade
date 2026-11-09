# Optional native management

Consumer images do not enable an SSH shell. For an explicitly managed device,
an adult provisions **public keys only** in
`/flash/cubby-setup/authorized_keys`. The file accepts bare OpenSSH public keys
(Ed25519, RSA, or NIST ECDSA), optionally with comments; authorized-key options
are not accepted. Keep the corresponding private identity on the administrator's
computer, never in an image or release. Missing, malformed, or unreadable keys
leave management disabled and do not change USB state.

Once the running signed release has passed its update trial, the native network
helper starts a separate OpenSSH listener on **port 2222**, on both IPv4/IPv6
interfaces (including Wi-Fi and USB). Only `root` with a provisioned public key
can authenticate; password, keyboard-interactive, host-based, and empty-password
authentication are disabled. It uses an explicit validated configuration, not
the system SSH configuration or default host identities. For example:

```sh
ssh -p 2222 -i /path/to/your/private-identity root@DEVICE_ADDRESS
```

The device generates its own persistent Ed25519 host identity under
`/storage/cubby/management/private` (directory mode 0700, private key 0600).
This is deliberately **outside** `/storage/cubby/state`, which is bound into the
browser chroot. Verify and retain the host fingerprint when first connecting;
ordinary updates preserve this identity.

The worker also recovers an already prepared, unbound USB gadget by selecting
native `usbgadget network`, but only after stock `rocknix-autostart.service` has
finished. It never repeats `usbgadget --start`, initializes configfs, or writes
`/flash`. Wi-Fi access does not depend on USB recovery succeeding.
`/flash/CUBBY-USB-DISABLED` prevents this USB recovery without disabling Wi-Fi
management. `/flash/CUBBY-MANAGEMENT-DISABLED` disables management entirely.
Removing or invalidating the provisioned keys also stops the listener; the
worker checks at five-second intervals. These actions stop new SSH connections;
they do not forcibly terminate already authenticated administrative sessions.

## Lifecycle and update compatibility

This listener belongs to the native `rocknix/network.py` process, outside the
browser chroot. It is stopped/reaped when that helper exits normally or receives
SIGTERM (including browser restarts), and is restarted with the next helper.
It is **not** an independent always-on rescue service: it cannot provide access
when Cubby fails before launching its native network helper. The enclosing
ROCKNIX service remains responsible for its process group after an abrupt kill.

The signed legacy app archive includes the helper as
`runtime/native/rg353v/device/management.py`; the replacement `rocknix/network.py`
loads that alias even when the existing old `chroot-run.sh` is still launching
it. Development paths, pending trials, and releases no longer selected by
`/storage/cubby/current` cannot activate management. A process lock prevents two
helpers from concurrently owning the same management identity/listener.

Installing this update still requires an existing update transport. It cannot
remotely start itself on a unit that has no reachable service; that case requires
one initial signed update through the device UI or an offline recovery path.

# Internal reflash from independent Linux SD recovery (candidate)

`rocknix/linux_rescue.py` is a separate entry point for a handheld already
running Cubby/ROCKNIX, not an Android transport and not the bundle installer.
It does not prove factory Android ADB access or unattended factory installation.
It deliberately refuses to overwrite an internal installation that is running.
No actual device was operated while implementing this path; hardware acceptance
remains pending. A passing simulation does not certify a customer device.

## Prerequisites

- Explicit authorization to erase this unit's internal installation; no backup
  is made. The current unit has that authorization already.
- Cold boot from a separately identified recovery SD: `/flash` on
  `/dev/mmcblk1p1`, `/storage` on `/dev/mmcblk1p2`, root backing ultimately on
  `mmcblk1`. The read-only collector traverses partition, loop-file and block
  slave dependencies. Unknown or cyclic dependencies stop the job.
- The characterized non-removable BJTD4R eMMC, 61,071,360 sectors, CID
  `150100424a5444345200ec55ccb75600`, battery at least 30%. This narrow route
  does not claim support for arbitrary stock devices.
- No eMMC-backed mount (including other live process mount namespaces), swap,
  block holder, open raw block descriptor, file/directory descriptor, cwd/root/
  executable reference, or file mapping. Detached/lazily unmounted filesystems
  still count as active. Unreadable or unresolved process dependencies block
  installation rather than being treated as unused storage.
  Checks repeat before writing, readback, enrollment and shutdown.
- Strictly trusted SSH known-hosts for the recovery SD, and the private client
  key matching the public key in the new image. Do not use `accept-new`, disable
  checking, or overwrite a mismatching known-host record to get past a failure.
  Read/enroll recovery identity through an independently trusted channel.
- A freshly built, independently verified, CID-bound image for internal storage,
  with media identities **different from the SD**. Do not clone the exact same
  bound image onto SD and internal storage. The public-key build contains no
  private client/host credential.

## Plan and install

From the project checkout, with the exact full source commit and artifact paths:

```sh
uv run --with pyfatfs==1.1.0 --with setuptools==80.9.0 --with pyyaml==6.0.3 \
  python -m rocknix.linux_rescue plan \
  --image /private/internal.img.gz --manifest /private/internal.img.gz.json \
  --expect-version 0.35.0 --expect-commit FULL_40_CHARACTER_COMMIT \
  --public-key /private/operator.pub --identity /private/operator \
  --recovery-known-hosts /private/sd-known-hosts --recovery-port 2223 \
  --job /private/jobs/internal-reflash
```

`plan` is default and read-only: it does not create a checkpoint or change the
handheld. Both actions independently audit the compressed image and actual
filesystems, confirm the public/private client match and CID binding, and
inspect dependencies. The host must already route `169.254.170.2`; `--host`
selects another explicitly known host. Port 2222 can be selected when the
existing trusted normal management channel is the recovery ingress.

Use `install` with the same arguments after authorization. It probes the actual
SSH binary stdin/stderr/exit semantics and required recovery tools, generates
an exclusive per-job internal recovery host key, streams to **remote** eMMC,
and reads every image byte back (including the final backup GPT sectors).
Failure blocks enrollment. A raw-write checkpoint never authorizes skipping
readback. The kernel partition table must refresh successfully and both
partition extents must match the validated image before mounting new storage.
Then the tool enrolls the per-device recovery host key and verifies persisted
key bytes through a read-only remount. The receipt distinguishes the raw-image
checksum from this explicitly recorded post-readback personalization.

After enrollment it records `awaiting_internal_boot` and requests shutdown.
Disconnect can race the shutdown response; that receipt does **not** prove the
screen is off or that the new system has booted. Once powered off, remove the SD
and power on. Run `verify` with the same arguments: it uses the enrolled internal
host key on port 2223, checks actual internal mounts, CID, source version/commit
and on-disk device binding, then records `commissioning_pending`. Retrying
`install` on an awaiting/completed checkpoint also permits only pinned internal
verification, never another disk write. A `verify` action without an enrolled
checkpoint refuses to operate.

Do not shut down/reconfigure unrelated devices. No host block device is opened
by this tool. Physical SD insertion/removal is currently required for this Linux
recovery test; it is not the target stock-device plug-in-only workflow. Continue
with [commissioning](stock-usb-provisioning.md#remaining-commissioning-gates) after verified internal boot. Commissioning
and separate physical/save/sleep/update-rollback evidence remain required before
customer handoff; this tool never emits a customer-ready certification.

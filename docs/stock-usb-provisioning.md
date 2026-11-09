# Stock Android USB provisioning (candidate, not hardware-certified)

`rocknix/provision.py` is the host-side **stock Android → internal Cubby**
transport. `rocknix/install.py` remains the separate SSH bundle installer for
an already-running ROCKNIX system. Neither a passing simulation nor an existing
Cubby/SD installation proves this stock-device path works end to end.

## Supported entry profile and limitations

The explicit `rg353v-android11` profile means the supervisor has independently
identified the physical handheld as the characterized RG353V. Its shared stock
Android firmware reports model `RG353P`, Android 11, and platform `rk3566`.
**Those Android strings alone do not distinguish the physical RG353V/RG353P.**
The characterized unit used V1.20E, rooted `su 0`, root ADB recovery, and a
non-removable BJTD4R eMMC with 61,071,360 sectors. The tool intentionally rejects
other MMC names/capacities rather than guessing compatibility. A present SD
card, unauthorized/multiple ADB devices, mounted internal partitions, battery
below 30%, unknown battery level, or missing recovery primitives stop the job.
The supported fingerprint is not a claim that every factory shipment exposes
ADB/root without interaction. A stock unit with locked/disabled ADB is a real
entry blocker, not an invitation to bypass or hide an authorization dialog.

The current connected Cubby unit is **not stock Android**. David has authorized
reflashing that exact unit for clean internal-install acceptance, but doing so
cannot establish acceptance of the factory Android entry path. No real stock device was written while
implementing the tool. Root-mode properties, recovery mount utilities, USB
re-enumeration, DHCP/link configuration, and complete unattended installation
still require acceptance on a genuinely stock unit. The host must already be
able to route the USB management address `169.254.170.2`.

## Inputs and read-only plan

Build a fresh production image for this device's eMMC CID with the operator's **public** management key.
The corresponding private client identity stays on the host. The image and
receipt must come from a trusted build/release channel: the receipt is a build
record, not a signature authenticating an arbitrary supplier's bytes. Select
the exact version and full source commit; do not select a date-only archive.

The supervisor performs these steps without handing setup work back to the customer:

1. Identify one authorized ADB serial and read its eMMC CID using checked
   shell-v2 (`adb -s SERIAL shell -T su 0 cat /sys/block/mmcblk0/device/cid`).
   The installer still independently checks model, capacity, mounts and CID.
2. Run the versioned production builder with `--device-cid THE_32_HEX_CID`
   **and** `--management-public-key /private/operator.pub`, then independently
   verify the result. Each build generates fresh disk/partition GUIDs,
   filesystem UUID/serial and matching boot/storage labels. No private key
   is embedded. Bound image names include a CID suffix; use distinct job outputs.
3. Pass that verified per-unit image to `plan`/`install` below. Unbound generic
   images and images built for another CID are refused before any write,
   including resume. Reconnect also checks the binding stored on actual media.

The binding and all media identities are recorded in the receipt and actual
`/storage/cubby/image-provenance/device.json`; FAT/ext4 and GPT audits compare
actual identifiers and boot references, not just the declared record. Public
release images have no CID or management key, and their release gate rejects
bound/provisioned artifacts. A generic public image is unique **per build**;
manual cloning is not the per-device fleet provisioning procedure.

For example, from the project root (replace the paths and commit):

```sh
uv run --with pyfatfs==1.1.0 --with setuptools==80.9.0 --with pyyaml==6.0.3 \
  python -m rocknix.provision plan \
  --profile rg353v-android11 --serial STOCK_ADB_SERIAL \
  --image /path/to/verified.img.gz --manifest /path/to/verified.img.gz.json \
  --expect-version 0.35.0 --expect-commit FULL_40_CHARACTER_COMMIT \
  --public-key /private/operator.pub --identity /private/operator \
  --job /private/jobs/device-task
```

`plan` is the default action. It verifies the complete compressed image and
actual FAT/ext4 contents, checks the selected public key and matching private
client identity, hashes the entire uncompressed image, and probes the one
serial-bound stock device. It does **not** restart ADB as root, reboot, write
storage, or create a job checkpoint. The parent job directory must be private
to the host user (0700); private client keys must be usable without prompts.

Use the explicit `install` action with the **same arguments** after setup is
authorized. The supervisor can do this without a separate human confirmation
when the task already authorizes replacement of Android. Installation erases
internal Android; this procedure intentionally makes no backups. `--adb` can
select an existing platform-tools executable; it does not download one.

## Checked USB transport

Every remote shell command and binary stream uses serial-bound **`adb shell -T`
with shell-v2 framing**, never raw `exec-out`/`exec-in` or `shell -x`. Raw ADB
output does not convey remote exit status; `exec-out` also does not transmit host
stdin and combines remote diagnostics with binary output.

Before trusting shell commands, the installer checks the connected daemon's
`shell_v2` feature and executes a harmless binary-stdin echo / separate-stderr /
nonzero-exit probe. Missing support or mismatched framing blocks before image or
key transmission. The probe is repeated after root/reboot/wait transitions, so
stock Android support is not assumed to persist into recovery. Image/key stdin,
readback stdout, and remote diagnostics remain separate; failed remote commands
never authorize another stage. These semantics are host-regression-tested but
still need acceptance with the supported stock/recovery daemon versions.

## State and verification

1. Match exactly one authorized ADB serial and validate stock/hardware facts.
2. Atomically bind a locked host checkpoint to serial, profile, compressed image
   hash, version/commit, selected public key, and the actual eMMC CID.
3. Enter root Android recovery; re-probe identity, mounts (including by-name
   aliases), battery, capacity, absence of an SD card, and required tools.
   Require `blockdev --rereadpt /dev/block/mmcblk0` to succeed on the unmounted
   stock disk **before** writing, proving that this recovery/kernel supports
   the actual partition-table reread operation, not merely a help option.
   Unsupported recovery primitives block installation; they are not assumed
   to be available on every stock unit.
4. Stream gzip through recovery's pipefail-protected `gzip | dd`, fsync, check
   exit status, then read back **every image sector**. The SHA-256 covers the
   non-MiB-aligned final backup GPT sectors as well as the main range.
5. Reread the partition table again with checked `blockdev --rereadpt` after
   complete raw readback. Compare the kernel sysfs start/size for **both**
   partitions to the image's validated primary/backup GPT, rejecting missing,
   mismatched, duplicate, or extra partitions. Raw `dd` alone does not refresh
   Android's partition mapping; no mount or key enrollment occurs until this
   check succeeds.
6. Generate a unique SSH server key **on the host**, transfer it only through
   serial-bound root ADB to the written internal ext4 filesystem at
   `/storage/cubby/recovery/private/ssh_host_ed25519_key`, fsync/unmount, then
   remount read-only to verify the persisted private-key digest. This is an
   explicit per-device personalization **after** raw-image verification; the
   final personalized disk is not claimed to have the original raw-image hash.
7. Recheck eMMC identity and unmounted state, reboot, and reconnect to independent
   recovery SSH port 2223. Strict host-key checking pins the generated public
   host key, without TOFU, a password, or `StrictHostKeyChecking=no`.
8. Verify the expected image version/commit, same eMMC CID, and internal—not
   SD—boot/storage mounts. Report `commissioning_pending`, never customer-ready.

A USB disconnect, bad hash, tool failure, wrong storage identity or wrong live
image is a machine-readable `blocked` result. Child command output is never
included in errors. No host block-device pathname is accepted or written.
The SSH host key and checkpoints are private operational artifacts under the
job directory, not source files or image release assets. Preserve this directory
and pass an explicit `--serial` to resume after Linux no longer exposes ADB.

On resume in Android recovery, the tool re-probes the device and repeats the
entire raw write/readback and host-key enrollment; a stale `written` checkpoint
never skips verification. If reboot was already requested, resume only attempts
pinned SSH validation—it does not silently reflash a running Linux device.
Interrupted or failed transitions may require supervisor diagnosis; timeout is
never presented as a successful installation.

## Remaining commissioning gates

This transport does not configure customer/bench Wi-Fi, install games, clear
test data, certify display/audio/buttons/sleep, exercise signed update rollback,
or produce a customer acceptance certificate. Those are the subsequent bounded
commissioning stage. Per-device bound builds prevent this installer from
reusing another unit's artifact, but do not certify factory USB access or
commissioning on real hardware. Do not claim this candidate
alone fulfills the plug-in-and-walk-away product contract.

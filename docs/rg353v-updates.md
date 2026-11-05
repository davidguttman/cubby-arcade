# Cubby app updates on ROCKNIX

This is an **app-only** update mechanism. It does not update ROCKNIX, kernels,
bootloaders, WPE, device supervisors, or games. Those require separately reviewed
release surfaces. Games and saves remain under `/storage/cubby/state`.

## Adult experience

After required Wi-Fi setup, open adult Wi-Fi settings (gear or hold L+R+Start),
then **Cubby updates**. Check, download, and verify an update; install outside
active gameplay. Download failure leaves the running app unchanged. An offline
installed app keeps working. Failed staging can be retried by checking again;
partial downloads are discarded rather than activated.

The browser and server share the package-operation lock for activation. If the
activation reply is lost, gameplay stays blocked until restart because activation
may already be underway; an explicit rejection releases the lock. The
candidate must paint a page, acknowledge its unique trial token, and keep both
browser/session and HTTP server alive for ten seconds. A 45-second timeout or
process failure rolls back. Reboot with an unfinished trial also restores the
previous release. Rejected releases are not retried automatically.

## Trust and configuration

Updates are intentionally **unconfigured** until a production public key and
HTTPS feed are provisioned. There is no unsigned fallback or built-in test key.
The private signing key must stay outside the repository, device, and installer.

A baseline image can be composed with:

```sh
unshare --map-auto --map-root-user uv run rocknix/image.py \
  --rocknix official.img.gz --rootfs rootfs.tar.xz --output cubby.img.gz \
  --update-feed https://YOUR-PUBLISHER/manifest.json \
  --update-key /path/to/public-release-key.pem
```

The public key must be Ed25519 SubjectPublicKeyInfo PEM. On existing installations,
provision root-owned `/storage/cubby/updater/release-key.pem` and `config.json`:

```json
{"feed":"https://YOUR-PUBLISHER/manifest.json","public_key":"release-key.pem"}
```

This is an explicit baseline trust operation, not a caller-supplied URL in the UI.
Publishing/key provisioning is separate from implementation; example URLs are
placeholders and not a live update service.

## Maintainer release

```sh
uv run --python 3.12 python -m rocknix.update_release \
  --source . --output /outside/release-1 --version 1.0.0 --sequence 1 \
  --archive-url https://YOUR-PUBLISHER/releases/1/app.zip \
  --key /private/signing-key.pem
```

Publish the immutable `app.zip` at its signed URL and `manifest.json` plus
`manifest.json.sig` at the configured feed. The signature covers exact manifest
bytes; do not pretty-print the manifest after signing. Never reuse a sequence or
replace an existing release. The builder refuses existing output files.

The feed is HTTPS-only, including redirects. Exact signature size, compatibility,
monotonic sequence, archive size/hash, every file size/hash/mode and archive
structure are checked. OpenSSL verification runs in the known pinned runtime,
not in the candidate app. All filesystem and trust decisions are made by a
baseline coordinator outside the replaceable app.

## Storage and recovery

`updater/coordinator.py` is the baseline supervisor. The existing runtime is moved
once to `runtimes/<digest>` without copying its contents. Releases reference that
runtime and baseline device scripts. Candidate ZIPs cannot replace those scripts.

`updates/pending.json` is fsynced before atomically changing `current`.
`previous` is retained after health confirmation. No updater routine deletes saves,
installed games, browser profile, previous app releases, or the Android backup.
A power interruption during activation may reject an otherwise-good release; it
must not leave an unconfirmed release in a reboot loop. Retention cleanup is
intentionally not automatic yet.

## Verification boundary

Tests use ephemeral Ed25519 keys and disposable files. Browser tests are explicit
simulations at 640×480. Real handheld health/rollback, first-boot operation, and a
published production feed still require integration acceptance. Passing these
tests is not evidence of hardware certification or production publication.

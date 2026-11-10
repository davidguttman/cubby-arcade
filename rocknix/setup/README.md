# Linux setup engine

This module is the image-composition layer for the adult desktop installer.
It does not flash cards or modify Android. Linux is the only supported host.

ROCKNIX is downloaded directly from the pinned official GitHub release. We
distribute only `rootfs.tar.xz` (WPE), Cubby source/configuration, and a manifest.
The combined image is created on the customer's computer, never required as a
hosted download. This layer needs no Git checkout at runtime.

## Python API

- `make_payload(rootfs, output, source_root=image.ROOT)` is a maintainer function.
  It emits a new directory with `rootfs.tar.xz`, `app/{runtime,rocknix}`, the
  catalog, and `payload.json` (file hashes, sizes, modes, pinned inputs, source
  commit/dirty status). It excludes caches, bytecode and disk images. Package
  that directory with the desktop app; no archive extraction API is needed.
- `validate_payload(payload)` checks the complete inventory, including modes,
  rootfs checksum, unsafe paths, symlinks and unexpected files. The manifest is
  an integrity inventory, not a publisher signature: distribute it through the
  same trusted app release channel as the application.
- `fetch_rocknix(cache, progress=None)` returns the verified official compressed
  image path. It checks the cache on every call; corrupt cache files are
  redownloaded. Downloads are size-limited, checksum-pinned and atomic. A failed
  download never becomes a cache entry. The download URL is not user-provided.
- `compose(payload, cache, output, storage_gib=6, progress=None,
  worker_command=None)` validates the payload, fetches official ROCKNIX, and
  runs the worker inside a root-mapped Linux user namespace. Paths are `Path`
  objects; `progress` receives human-readable string events. Errors raise.
- `compose_image(upstream, payload, output, storage_gib=6, progress=None)` is
  the worker API and requires the root-mapped namespace. It calls the existing
  image builder with packaged source paths and recorded provenance.

Default worker command: `[sys.executable, '-m', 'rocknix.setup']`. The desktop
app can supply a command list for its bundled interpreter/launcher. Commands
are argument arrays, never shell text. Its Python import path must expose the
packaged `rocknix` and `runtime` modules, and bundled filesystem helpers must be
on `PATH`. The app is responsible for packaging Python, Python dependencies
(`pyfatfs`, `setuptools`, `pyyaml`), Linux helpers and namespace prerequisites;
this engine does not install system dependencies or ask customers to run uv.

## Maintainer CLI

```sh
uv run --python 3.12 python -m rocknix.setup payload \
  --rootfs .cache/rg353v-bundle/rootfs.tar.xz --output .cache/setup-payload

uv run --python 3.12 --with pyfatfs==1.1.0 --with setuptools==80.9.0 \
  python -m rocknix.setup compose --payload .cache/setup-payload \
  --cache .cache/official-rocknix --output .cache/Cubby-RG353V-local.img.gz
```

The `worker` subcommand takes `--upstream`, `--payload`, `--output` and optional
`--storage-gib`. `fetch --cache DIR` can prefetch/check the official image.

Image-content verification is not hardware acceptance.

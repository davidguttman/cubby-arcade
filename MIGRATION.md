# Cubby Arcade name and deployment migration

The product is **Cubby Arcade**, repository `davidguttman/cubby-arcade`.
Canonical development checkout: `/mnt/data/play/native/cubby-arcade`.
Canonical VM state: `/mnt/data/vms/cubby-arcade`.
Local Jump preview: https://cubby-arcade.davidguttman.jump.sh .
Public web/catalog origin: https://cubby-arcade.onrender.com .
The desktop build is `dist/CubbyArcade-linux-x64/CubbyArcade`.

## Compatibility, not old branding

- `CUBBY_ARCADE_VM_DIR` and `CUBBY_ARCADE_FIRMWARE_DIR` take precedence;
  `HANDHELD_VM_DIR` and `HANDHELD_FIRMWARE_DIR` remain supported aliases.
- Desktop adult/developer settings use `CUBBY_ARCADE_*`; existing `HUB_*`
  environment overrides remain accepted. Explicit overrides keep their meaning.
- The browser tab title names Cubby Arcade without adding reading to child UI.
  New desktop profiles use `CubbyArcade`. Both historical `handheld-os-desktop` and
  `HandheldHub` profile directories are recognized in packaged and development
  runs. When no canonical profile exists, the historical package-name profile
  (`handheld-os-desktop`) takes precedence over the product-name fallback,
  preserving games, saves, preferences and local token budgets.
  No profile is silently copied, reset or deleted.
- `hub:` IPC/origin, `Handheld*` JavaScript globals, `handheld:*` storage/event
  identifiers, `.handheld-web-export`, and `data-handheld-system` are stable
  compatibility contracts consumed by already-built game packages. They are not
  user-facing names and intentionally remain unchanged.
- Existing Linux guest `/opt/handheld`, `/etc/handheld`, `/var/lib/handheld`,
  unit/executable names and cloud-init metadata remain compatible. Renaming a
  project must not strand a running prepared VM or reset its identity/saves.
  New VM window names and fresh cloud-init host identity use `cubby-arcade`.
- Locked upstream game bytes, media filenames/recipes, provenance and hashes
  are not rewritten as branding. Generic references to handheld hardware stay.
- Host directory migration may leave narrowly scoped old-path symlinks so a
  running VM/process and older adult commands continue to resolve their files.

## Deployment boundaries

`render-site` is the **historical generated deployment-only branch**, not
application source and not a branch to merge into `main`. Preserve it unchanged.
Production uses a dashboard/API-managed Render **Static Site** in **Superstruct**,
tracking `main` with auto-deploy **On Commit**. There is no repository Blueprint.
Build with `python3 -m pip install -r requirements.txt && python3 hosting/build.py`
and publish `.cache/web`; there is no runtime start command. A Python Web Service
running `hosting/serve.py` is not the production deployment type. The release
supervisor verifies/integrates source and configures the Static Site separately;
see the [hosting settings](README.md#source-hosted-cloud-deployment-and-independent-game-updates).
This does not replace native executables or change their release gates.

The CDN serves the generated browser preview, registry, stable manifests and
immutable archives. `hosting/serve.py` is only a local development/test adapter.
Legacy Line Cutter 0.2.0/0.2.1 and Little Camp 0.1.0 distribution archives are
retained exactly under `hosting/releases/` with checksum/source inventory. Every
source build reproduces their old package/media URLs, keeping existing installs
and old catalog previews usable. The token implementation was released separately
in desktop 0.2.0; this migration changes no budget/session behavior.

Line Cutter source now belongs to `davidguttman/line-cutter`; its published complete
0.3.0 historical bootstrap package replaces the old portfolio asset dependency.
New releases follow the schema-2 file manifest and single GitHub-release contract
introduced in Cubby 0.3.0, without requiring ZIP publication.
The historical bootstrap lock is not an updater version pin: future releases
require no new ZIP, lock edit, or Cubby release. Fresh catalogs point
to its publisher-owned stable manifest. The old Cubby stable metadata endpoint
serves a compatibility snapshot generated at Cubby build time, not a live proxy
or redirect. The build validates bounded publisher metadata, resolves relative
file URLs against its final URL, and fails closed on invalid metadata. That old
endpoint refreshes only on a Cubby deployment; current catalogs use the
publisher-owned stable URL directly. Native clients keep their origin, ID, saves and update
activation rules, and future game releases do not require a launcher rebuild.
The native installer remains a desktop/VM adapter, not a browser capability.

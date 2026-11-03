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
The independent-game migration introduces a source deployment from `main` using
`hosting/build.py`, `hosting/serve.py` and `render.yaml`; the release supervisor
switches the existing Render service only after source verification/integration.
No extra Render service or native executable replacement is required.

The free Python stdlib host serves the generated `.cache/web` browser preview,
registry, stable manifests and immutable archives (with possible cold starts).
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
forwards bounded, validated live publisher JSON with HTTP 200 and revalidation,
not an HTTP redirect or a copied release snapshot. Upstream failures/redirects
return 502, leaving installed versions unchanged. Native clients keep their origin, ID, saves and update
activation rules, and future game releases do not require a launcher rebuild.
The native installer remains a desktop/VM adapter, not a browser capability.

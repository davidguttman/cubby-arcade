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

`render-site` is a **generated deployment-only branch**, not application source
and not a branch to merge into `arcade-store`. It records its source snapshot
and validated game package versions. The current Render adapter is a free Python stdlib web service serving static
exports (with cold starts), separate from the existing `web.py` adapter.
Render serves the browser preview,
registry, stable release manifests and immutable versioned game archives.
The native installer remains a desktop/VM adapter, not a browser capability.

The existing token implementation belongs to the paused development task and
remains uncommitted WIP until its own final review/rebuild. The rename does not
certify that feature or constitute a finished desktop release. A web preview
must identify its committed source snapshot and exclude unfinished WIP.

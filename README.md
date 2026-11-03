# Cubby Arcade — Render static deployment

Generated deployment-only branch: `render-site`. This branch is not application
source and should not be merged back into the development branch.

## Snapshot

- Application snapshot: `1d26b904b70ad6917c0614625ae8cc626151b1d2` (`arcade-store`, committed state only).
- Included validated packages: Line Cutter 0.2.0; Little Camp 0.1.0.
- Origin: https://cubby-arcade.onrender.com/
- The uncommitted token work was deliberately excluded. This is a browser preview
  and catalog/package host, not a finished token-enabled desktop release.
- Browser play uses the static web platform. Native installation, desktop Quit,
  and the desktop token bridge are not browser capabilities.

## Render

`render.yaml` describes a static site, publishing `public/`, with no runtime
server or Node build. No SPA catch-all rewrite is used: missing asset, catalog,
and package URLs must return 404 rather than HTML.

The public JSON pointers revalidate on each request. Only the exact immutable
version directories receive year-long immutable caching. Public read-only CORS
allows the native app to consume the catalog/package host. If creating the service
through the CLI/API rather than a Blueprint, apply the same headers explicitly
using Render's static-site header API; merely committing this file does not apply
configuration to an existing non-Blueprint service.

## Regeneration

Export the chosen committed application revision into an isolated artifact
staging directory. From that export, run:

```sh
uv run python web.py build /path/to/line-cutter-0.2.0.game.zip /path/to/little-camp-0.1.0.game.zip --output /path/to/staging/public --base-url https://cubby-arcade.onrender.com/
```

Set the generated `index.html` browser title to `Cubby Arcade`, then update its
size/SHA-256 in `hub-manifest.json`. Validate all inventories before deploying.
Keep previous versioned store files when publishing game updates; a clean export
only retains packages explicitly selected for that export.

# Cubby Arcade — public site and launcher host

Generated deployment-only branch: `render-site`. This branch is not application
source and should not be merged back into the development branch.

## Snapshot

- Application snapshot: `e6b0241042388d7840e0dcf0bb667503a1f5ca1c` (`main`, committed state only).
- Included validated packages: Line Cutter 0.2.1; Little Camp 0.1.0.
- Origin: https://cubby-arcade.onrender.com/
- Includes the committed token-aware launcher for compatible native hosts. Browser
  play remains a free preview; native profiles own token budgets and accounting.
- Browser play uses the static web platform. Native installation, desktop Quit,
  and the desktop token bridge are not browser capabilities.

## Render

`render.yaml` describes a **free Python web service**, running `python serve.py`.
`serve.py` uses only the standard library and serves the fixed `public/` directory
on `0.0.0.0:$PORT`. There is no Node server, dependency install, or application
build. Render free-service cold starts apply.

The public JSON pointers revalidate on each request. Only the exact immutable
version directories receive year-long immutable caching. The server supplies
read-only public CORS, JSON MIME types for extensionless catalog/library paths,
single byte ranges for video seeking/package reads, HEAD/OPTIONS, and discarded
`POST /report` responses. Missing paths and directory listings return 404; no SPA
catch-all rewrite exposes HTML for missing package assets. `headers.json` is
retained as documentation; the Python server supplies its headers directly.

## Regeneration

Export the chosen committed application revision into an isolated artifact
staging directory. From that export, run:

```sh
uv run python web.py build /path/to/line-cutter-0.2.1.game.zip /path/to/little-camp-0.1.0.game.zip --output /path/to/staging/public --base-url https://cubby-arcade.onrender.com/
```

The exporter generates the landing page, HTML/raw specifications, and standalone
manifest generator. Keep the logical `/index.html` inventory as the wordless native
shell; serve it at `/native/index.html` and `/play`. Serve `/site/index.html` at
the public root. Validate every inventory before deploying.
Keep previous versioned store files when publishing game updates; a clean export
only retains packages explicitly selected for that export.


## Public-site routing

The application export deliberately retains its physical `public/index.html`
wordless launcher so native cloud inventories remain unchanged. The deployment
adapter maps `/` and `/index.html` to `public/site/index.html`, the adult/developer
landing page; `/play` and `/play/` serve the original wordless browser preview.
`/native/index.html` serves the launcher bytes named `/index.html` in the cloud
inventory. All other assets, APIs, package URLs, and immutable releases retain
their existing paths. This is exact path routing, not an SPA fallback.

Native builds from 0.3.0 prefer `/native/index.html`, retaining compatibility with
older hosts that only provide `/index.html`. Earlier desktop versions cannot
fetch the new landing as a valid hub snapshot: inventory integrity verification
fails and they retain their previously verified cache or bundled launcher.
They must install the new executable for file-manifest support.

For regeneration, retain this deployment-only `serve.py` and `test_serve.py`,
export the committed source with explicit existing game archives, preserve all
prior immutable version files byte-for-byte, and preserve stable catalog metadata
URLs. The generated `site/` comes from the application source. Never replace the
physical launcher `index.html` with the landing or rewrite its inventory hash to
match the landing. Run `uv run python -m unittest -v test_serve` after generation.

# Cubby Arcade — Render browser preview

Generated deployment-only branch: `render-site`. This branch is not application
source and should not be merged back into the development branch.

## Snapshot

- Application snapshot: `ed3e97e6c54790a9a7756fdd5a7194d9fe66e813` (`arcade-store`, committed state only).
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

Set the generated `index.html` browser title to `Cubby Arcade`, then update its
size/SHA-256 in `hub-manifest.json`. Validate all inventories before deploying.
Keep previous versioned store files when publishing game updates; a clean export
only retains packages explicitly selected for that export.

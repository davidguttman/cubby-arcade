# Shared browser device shell

`website/play.html` mounts the dependency-free Cubby Buddy Shell and adapts its
standard controls/lifecycle to the existing origin-bound handheld embed protocol.
The actual shared hub UI—not its early control-readiness message—acknowledges
startup. System menus, storage and gameplay remain owned by the ordinary hub.

The generated static dependency is pinned by `website/vendor/cubby-buddy-shell/manifest.json`
(version and SHA-256 per file). Never edit generated files. From a reviewed shell
checkout, update/check it with:

```sh
node /path/to/cubby-buddy-shell/scripts/install.mjs website/vendor/cubby-buddy-shell
node /path/to/cubby-buddy-shell/scripts/install.mjs website/vendor/cubby-buddy-shell --check
```

The web exporter copies and caches all dependency files and hashes their bytes
into the browser cache version. They are outside the native hub inventory and
immutable game archives. Old `/site/boot.*` outputs remain compatibility assets.
This browser-only wrapper does not change handheld rendering or establish device
performance.

Focused checks:

```sh
uv run python -m unittest discover -s tests -p 'test_web_host.py'
uv run python -m unittest discover -s tests -p 'test_static_hosting.py'
uv run tests/browser_play_boot.py --cdp <configured-CDP-URL> --origin <verified-jump-preview>
```

The browser test routes the exact checked-out wrapper/vendor files over the
preview's existing shared hub; it needs no separate development server. It covers
startup races, mobile/desktop layouts, focused-iframe controls, reduced motion and
storage-failure reveal, and saves screenshots under `.cache/play-boot-screenshots`.

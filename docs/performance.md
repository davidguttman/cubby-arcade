# Preserving handheld browsing performance

Library and Store share `runtime/core/hub.js` and `hub.css`. Changes to the
shared hub must retain the following safeguards unless a real RG353V comparison
justifies replacing them:

- Selection uses cached shelf geometry and updates only the previous/new cards
  and their circular copies. Do not add steady-selection layout reads, full
  shelf scans, or markup serialization.
- Reuse the preview shell, poster and applicable action controls. Actions must
  resolve the current game, not a stale captured selection.
- On RG353V, artwork and actions update immediately; trailer construction and
  playback wait until browsing settles (currently 280ms, beyond controller repeat).
  Cancel pending work on navigation, launch and disposal. Retired video elements
  must release their decoder and ignore delayed playback/frame events.
- Use thumbnail/hero/trailer media variants with original-media fallback. Keep
  the verified offline media cache separate from immutable signed game packages.
- Handheld cards use a solid gold selection ring, not blurred shadows. Keep
  the blurred backdrop hidden, card effects non-interpolated, and idle decorative
  animations disabled. 0.53.0 intentionally also removes shelf card transitions;
  preserving older motion is not a performance requirement.

## Regression gates

CI runs these functional guards against the exact source being built:

```sh
node --test tests/hub_views.cjs
uv run python -m unittest discover -s tests -p test_media_cache.py -v
uv run --with playwright==1.65.2 python -m playwright install --with-deps chromium
uv run --script tests/browser_hub_performance.py --verify-guards
```

`hub_views.cjs` checks hot-path operation counts, preview reuse, delayed allocation,
media fallback and video retirement. `test_media_cache.py` checks cache integrity,
offline reuse, bounded downloads and preservation of signed game files.
`browser_hub_performance.py` loads the real shared hub/CSS without a server and
checks computed styles in Library and Store at 640×480, including selected,
focused and idle original/copy cards. In-memory late CSS overrides prove the
guards reject blurred shadows, shadow transitions, visible backdrop and idle
animation regressions. Local runs may pass `--browser-executable /path/to/chromium`.

## Hardware evidence and limits

The optimization releases were measured using synthetic navigation on a physical
RG353V, not physical button-to-pixel instrumentation:

- 0.51.0 / PR #43 (`d173e56`): smaller media and offline derivatives; media sizing
  alone did not materially improve selection-handler time.
- 0.51.1 / PR #44 (`fd776fa`): shelf caching/preview reuse, eight runs and 192
  selections against exact 0.51.0. Median selection work was 21–22ms → 18–20ms;
  input-to-next-animation-frame scheduling was 32–33ms → 19–21ms. Stalls remained.
- 0.52.1 / PR #45 (`df41e9f`): deferred video construction removed intermediate
  allocations but did not demonstrate a responsiveness gain on its own. Separate
  paint experiments against `68be483` used 20 runs and 480 selections with identical
  games/media. Simpler shadows reduced >50ms stalls roughly 58% in Library and
  70% in Store while retaining motion and rounded corners. Worst frames still
  reached about 120ms. Variants were tested separately, not as a combined result.

Functional guards do **not** prove frame rate, latency, decoder support or thermal
behavior. For changes to selection work, media lifecycle/sizing, shelf effects or
layout, repeat an alternating RG353V A/B using exact source hashes and identical
game/media inventories. Record frame intervals, >50ms stalls per second, worst
frames, media errors and thermal conditions; report negative results too. Restore
the normal launcher and verify signed files and temporary-server cleanup afterward.
Chromium/desktop/VM results must not be presented as RG353V performance evidence.

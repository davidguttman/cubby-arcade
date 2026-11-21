# Device canvas contract and audit

Target: RG353V, **640×480 (4:3)**. The current game sources checked below
already target this output shape. Logical canvases such as 160×120, 240×180
and 320×240 are correct with proportional
scaling; they do not need resolution migrations. Do not stretch or crop an
incompatible logical canvas to make it fill the device.

## Corrected conclusion

The original hardware comparison incorrectly treated Line Cutter's 240×160
legacy test surface, described in the README, as Cubby's general canvas.
That was not evidence that current games had wrong resolutions. The corrections
below clarify the contract and remove shared host sizing assumptions; they do
not rewrite game worlds or imply current games needed conversion.

## Game sources checked (2026-11-20; not an exhaustive catalog scan)

- Owl the Way Home (`owlpack/play.html`) and Spell Castle
  (`spell-castle/play.html`): 160×120, **4:3**.
- Trail Mix, Fox Barrister, Small Change, Alphabet Soup and Thimble
  (`play.html` in each game's repository): 240×180, **4:3**.
- Grab Bag and Scrap Rally (`src/draw.js`, `src/main.js`, `index.html`
  in each game's repository): 320×240 intermediate canvas, scaled to
  640×480 output, **4:3**.
- Bonk Bots (`src/draw.js`), Color Duel (`index.html`), Snowball
  (`index.html`) and Good Bribes Only (`game.js`): 640×480, **4:3**.
- Surprise Seeds (`index.html`, `core/farm.js`, `src/main.js`): 640×480
  output, **4:3**. A 214×160 intermediate buffer is uniformly scaled 3× to
  642×480 at x=-1, cropping one output pixel per side, not stretching pixels.
- Line Cutter (`examples/line-cutter/play.html` in Cubby and
  `cubby/play.html` in the Line Cutter repository): 240×160, **3:2**,
  intentionally preserved as the legacy technical fixture, not a current-game
  authoring example.

This inventory checks source dimensions and scaling, not every gameplay screen
or deployed package. Game repositories remain separate dependencies.

## Correction inventory

- `runtime/core/screen.css`: shared screen defaults, fullscreen sizing and
  visible-controller sizing assumed 3:2 (`1.5`). Defaults now use 4:3;
  sizing preserves a canvas's intrinsic ratio. This is a host presentation
  correction, not a change to game backing resolutions.
- `runtime/core/host-osd.js`: injected touch-controller space reservation also
  assumed 3:2. Use the actual canvas shape for known screen conventions;
  reserve the controller's space without changing the game's backing pixels.
- `README.md`: two passages presented the legacy 240×160/480×320 test-game
  dimensions as the general Cubby presentation. Distinguish that compatibility
  case from the current device target.
- `docs/game-authoring.md`: add gameplay-canvas guidance, including the device
  target, responsive sizing, touch-controller space and legacy compatibility.
- `tests/fixtures/controls.html` and `tests/fixtures/host-osd.html`: make the
  host-owned synthetic examples demonstrate 4:3, while retaining separate
  explicit 3:2 compatibility coverage.
- Browser regressions use synthetic canvases to verify aspect, bounds, full-device fit and separation
  from touch controls, not just the relative canvas heights with controls on/off.

## Already correct / no separate implementation

- `website/play.html` emulates a 640×480 4:3 device.
- QEMU output, the RG353V splash and hub artwork frames already target 4:3.
- Native (`runtime/server.py` / `runtime/game_shell.py`), browser
  (`runtime/core/browser-store.js`) and desktop (`desktop/main.cjs`) delivery
  inject the same host-owned OSD. Fix the shared implementation, not three copies.

## Intentionally preserved

- `examples/line-cutter/`, its locked upstream package and historical dimension
  stubs are compatibility fixtures, not new-game templates. Repository policy
  requires the Line Cutter technical payload to remain unchanged.
- Published game packages are immutable. Their backing canvas/world belongs to
  their game's source and release; changing host CSS is not a game-world migration.
- A legacy 240×160 game must retain 3:2 without distortion. Its unused device
  area is a compatibility limitation, not a reason to force every new game to 3:2.
- Media rendition dimensions, thumbnail sizes, timeouts and character limits
  are not gameplay-canvas defects.

## Verification boundary

Browser geometry and screenshots can establish rendering, bounds and controller
separation for the tested cases. They do not establish RG353V hardware support
or performance. Record hardware checks separately when the device is reachable.

## Verification recorded

- Browser matrix passed 36 configurations (direct/library/wrapper, 4:3 and
  legacy 3:2, controls on/off, three viewports), including intrinsic resizing
  and disposal. Independent screenshots confirmed full 640×480 rendering and
  a proportional canvas above the controls at 390×844.
  These synthetic fixtures establish host geometry, not a defect in any listed
  current game or universal rendering correctness.
- Focused host/input/preferences checks: 15 Node tests and one Python
  game-shell test passed. Spec and code-quality reviews found no issues.
- RG353V discovery returned `Found 0 matching handhelds. No connection made`.
  The repository's required actual-device A/B layout/performance gate remains
  open; browser evidence is not hardware validation. No device was changed.

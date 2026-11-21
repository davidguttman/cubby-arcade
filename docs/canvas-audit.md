# Device canvas audit

Target: RG353V, **640×480 (4:3)**. A new game's logical canvas should match
that shape, for example 320×240 scaled 2×. Do not stretch or crop game pixels
to make an incompatible logical canvas fill the device.

## Correction inventory

- `runtime/core/screen.css`: shared screen defaults, fullscreen sizing and
  visible-controller sizing assumed 3:2 (`1.5`), inherited from Line Cutter.
  New defaults must be 4:3; sizing must preserve a canvas's intrinsic ratio.
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
- Browser regressions: verify aspect, bounds, full-device fit and separation
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
- Focused host/input/preferences checks: 15 Node tests and one Python
  game-shell test passed. Spec and code-quality reviews found no issues.
- RG353V discovery returned `Found 0 matching handhelds. No connection made`.
  The repository's required actual-device A/B layout/performance gate remains
  open; browser evidence is not hardware validation. No device was changed.

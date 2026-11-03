# Shared game hub architecture

Product name: Cubby Arcade. Audience: pre-literate children; no words by
default in any child-facing surface. Line Cutter is only a compatibility payload.

## Product contract

One controller-first hub, like EmulationStation, with three hosts:

- Web: open a URL, browse pictures, watch a game's trailer, play, return.
- Handheld: boot Linux directly into the same hub under WPE.
- Desktop/Steam: launch the hub as one application, not separate Steam games.

Physical controllers are supported in the browser as well as native hosts.
Keyboard and touch are alternative input sources, not separate UI implementations.
The on-screen controller belongs to Cubby, equivalent to a USB controller.
`host-osd.js` and its CSS are delivered by the host before game scripts, use an
isolated Shadow DOM, and expose a standard virtual Gamepad API device. Games
consume controller input; they do not own OSD layout, visibility or lifecycle.
Legacy bundled overlay entrypoints are suppressed without changing installed
bytes. Layout changes require a Cubby update, never a game release.
The host's canvas-space reservation supports documented `.screen`/`#screen`
conventions; Shadow DOM does not create a separate browser viewport.
Game packages, title screens, trailers and game code are shared across hosts.
Web is the everyday UX testing path; VM validates ARM/WPE integration, not device
performance. Real RG353V hardware testing remains necessary.

## Boundaries

1. **Input:** normalized controls, state/edges, controller mappings, dead zones,
   disconnect/reconnect, transition release gates. No Linux dependencies.
2. **Platform contract:** capability discovery, library, per-game saves and host
   functions. Browser/Linux/desktop adapters implement the contract; unavailable
   capabilities must not appear as dead controls.
3. **Launcher:** shared pictorial library/navigation and visual/audio feedback.
   No device paths, raw controller indices, or game-specific logic.
4. **Game host/SDK:** lifecycle, input, saves and exit. Legacy games use an adapter;
   new games use the SDK. Each game owns its art, title/trailer and gameplay.
5. **Catalog/install:** separate adult management, catalog discovery, verified
   download/staging/activation/removal. Installed games work offline. Saves are
   outside replaceable game packages. Steam may distribute the hub while games
   are managed separately; Steam DLC is not a required content model.
6. **Host shells:** Linux boot/WPE/hardware/VM and desktop fullscreen packaging.
   A desktop build is not evidence of Steam publishing or Steam Deck validation.

## Implementation order and acceptance

1. Shared input/platform/SDK extraction, preserving existing installed games,
   legacy saves, held-button navigation protection and offline trailer playback.
2. Browser build/preview using the same runtime and package bytes, responsive
   presentation, pointer/touch/controller navigation and direct browser inspection.
3. Desktop fullscreen host/build and adult catalog/install foundations. No
   credentials or Steam App ID required for a local non-Steam smoke test.
4. Independently verify focused tests, browser navigation/media/saves, VM parity,
   desktop launch/build, and document commands plus remaining hardware/Steam gates.

Use bounded implementation slices with independent spec then code-quality review.
Preserve the existing VM disk/profile. No Node servers or manual Docker operations.

## Deferred decisions, not blockers

Final name/art direction, paid content, accounts, cloud sync policy, Steam App ID,
store submission and production catalog hosting. Do not pretend these are shipped.

Publisher authentication and game isolation are separate concerns from archive
hash checks. Current trusted developer packages share an origin/profile; do not
describe this as a sandbox or accept arbitrary third-party packages without an
explicit trust/isolation design. Browser saves are local to that origin, not
automatically synced with the handheld or Steam Cloud.

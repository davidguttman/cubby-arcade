# Cubby Arcade project rules

## Audience: pre-literate children

- Child-facing UI defaults to **no words**: launcher, library/store discovery,
  prompts, instructions, status, errors, and games.
- Any proposed visible word requires a specific, compelling justification for
  why pictures, animation, sound, or demonstrated actions cannot do the job.
  It must be short, simple, and phonetic. Never require reading to proceed.
- A physical button glyph may identify the matching control; it must not become
  a written instruction or the only way to understand the action.
- A player's own name is the one sanctioned word in child-facing UI: David says
  kids recognize their own names early, so it shows under their face in the
  player picker and beside it on the hub. A face always comes with it, and
  nothing else may require reading.
- Setup and management may use text only in an explicitly separate adult flow.
- Line Cutter is an unchanged technical test payload, **not** the intended
  audience, game design, art direction, or UX template. Its text is not precedent.

## Controller ownership — invariant

- Cubby owns the on-screen controller, just like a USB/gamepad input device.
- OSD layout, visibility, lifecycle and key-binding policy live in the host/input layer, never in a game package. Games consume standard controller input.
- Do not vendor OSD changes into games or release games to update the controller. Preserve immutable game bytes; legacy bundled overlays are suppressed at host delivery.

## One core — invariant

- Every host (desktop, browser, handheld) mounts the same hub in `runtime/core`. Behavior belongs there. A host only does what its platform forces it to: file or cache access, and when a version may safely switch. Never give one host its own copy of a behavior.
- Game updates are the worked example. `runtime/core/hub.js` alone decides when games update and which ones; hosts never schedule. A host supplies `install`, and that alone gets it updates (`platform.update` falls back to it). `tests/game_updates.cjs` runs each host's real bridge through the shared code, so add any new host there.

## Adult settings and notices

- The hub's gear tab is the only settings screen, on every host, and it shows the math question until answered. Leaving the tab locks it again; returning from a worded page does not. On the device, add a page by listing it in `settings` in `rocknix/bridge.js`. Never add a second entry point or skip the question.
- To flag something an adult should act on, use the shimmer: the `has-notice` class on a button (`runtime/core/hub.css`). Things look normal and a glint of light sweeps across them. No dots, badges, or color changes: David rejected those.
- The update notice is wired through `updateAttention` in `rocknix/bridge.js` and `update_attention()` in `rocknix/server.py`; `notice: true` on a `settings` entry marks its tile. `check_for_update()` runs in the background, and only from idle or a past failure.
- A signed update can replace everything Cubby owns under `/storage/cubby`: app, Cog, runtime, coordinator (`rocknix/updates.py`), device files (`rocknix/device/`) and trust. Don't work around the update path or present it as a limit; see `docs/rg353v-updates.md`.
- `rocknix/device/guard.py` runs outside every release and is what rolls back a bad one. Keep it small and stdlib-only, and keep every older coordinator able to read what newer ones leave behind (`tests/test_update_everything.py` runs the 0.11.0 baseline).
- Legacy `app.zip` still only carries what `app_path()` allows, because the baseline coordinator refuses anything else. A device on that coordinator bridges with the files under `runtime/native/rg353v/`, so that release must keep working on the baseline runtime.
- Releasing: bump `package.json` and `package-lock.json`, then push `main` (see `docs/releases.md`). That only publishes; a device installs it from the updates tile.

## Scope

This repo owns the Linux/OS integration, launcher, development VM, and future
catalog/download/install infrastructure. Games are separate dependencies.
The product name is **Cubby Arcade**; use `cubby-arcade` for project slugs.
Existing package/storage/guest compatibility identifiers are documented in
`MIGRATION.md`; do not break them just to remove an old internal prefix.

Do not claim that VM results prove RG353V performance or hardware support.
Do not flash the QEMU development disk onto a handheld.

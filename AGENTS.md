# Cubby Arcade project rules

## Audience: pre-literate children

- Child-facing UI defaults to **no words**: launcher, library/store discovery,
  prompts, instructions, status, errors, and games.
- Any proposed visible word requires a specific, compelling justification for
  why pictures, animation, sound, or demonstrated actions cannot do the job.
  It must be short, simple, and phonetic. Never require reading to proceed.
- A physical button glyph may identify the matching control; it must not become
  a written instruction or the only way to understand the action.
- Setup and management may use text only in an explicitly separate adult flow.
- Line Cutter is an unchanged technical test payload, **not** the intended
  audience, game design, art direction, or UX template. Its text is not precedent.

## Controller ownership — invariant

- Cubby owns the on-screen controller, just like a USB/gamepad input device.
- OSD layout, visibility, lifecycle and key-binding policy live in the host/input layer, never in a game package. Games consume standard controller input.
- Do not vendor OSD changes into games or release games to update the controller. Preserve immutable game bytes; legacy bundled overlays are suppressed at host delivery.

## Adult settings and notices

- On the device, the hub's gear tab is the only settings screen. Add a page by listing it in `settings` in `rocknix/bridge.js`; its tile asks the math question, then opens the worded page. Never add a second entry point or skip the question.
- To flag something an adult should act on, use the shimmer: the `has-notice` class on a button (`runtime/core/hub.css`). Things look normal and a glint of light sweeps across them. No dots, badges, or color changes: David rejected those.
- The update notice is wired through `updateAttention` in `rocknix/bridge.js` and `update_attention()` in `rocknix/server.py`; `notice: true` on a `settings` entry marks its tile. `check_for_update()` runs in the background, and only from idle or a past failure.
- `rocknix/updates.py` runs on the device as a baseline coordinator that app updates cannot replace. Changes to it reach new images only, so put new behavior in `rocknix/server.py` where possible.
- Releasing: bump `package.json` and `package-lock.json`, then push `main` (see `docs/releases.md`). That only publishes; a device installs it from the updates tile.

## Scope

This repo owns the Linux/OS integration, launcher, development VM, and future
catalog/download/install infrastructure. Games are separate dependencies.
The product name is **Cubby Arcade**; use `cubby-arcade` for project slugs.
Existing package/storage/guest compatibility identifiers are documented in
`MIGRATION.md`; do not break them just to remove an old internal prefix.

Do not claim that VM results prove RG353V performance or hardware support.
Do not flash the QEMU development disk onto a handheld.

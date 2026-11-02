# Handheld project rules

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

## Scope

This repo owns the Linux/OS integration, launcher, development VM, and future
catalog/download/install infrastructure. Games are separate dependencies.
`handheld-os` is a working name, not a settled product name.

Do not claim that VM results prove RG353V performance or hardware support.
Do not flash the QEMU development disk onto a handheld.

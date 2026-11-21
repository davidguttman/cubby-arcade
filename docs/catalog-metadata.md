# Catalog marketing metadata

`hosting/catalog.yaml` and `hosting/beta-catalog.yaml` carry optional adult-facing
marketing copy. All six fields remain optional in the registry schema. A missing
field means unknown or inapplicable, not a value a consumer should invent.

## Age recommendations

`ages` is an editorial suggested audience, not an age rating, certification, or
claim of child playtesting. Children progress at different rates; adults can use
skills and interests as a better guide than age alone. The initial recommendations
were filled on 2026-11-18 from the games' documented controls and learning tasks:

- **Trail Mix: 3–6.** Its `README.md` describes young children who cannot read yet;
  `docs/CONTROLLER-LADDER.md` starts with directions and builds to button timing
  and copying patterns. The numeric range is editorial.
- **Fox Barrister: 5–7.** Its `README.md` describes beginning readers decoding short
  sentences, choosing a word against picture evidence, with no timer or losing.
  The numeric range is editorial.
- **Small Change: 5–8.** Its `README.md` describes making change from 5 and 10,
  denominations 1/5/10, buying stock, and gradually removing the balancing-scale
  aid. The numeric range is editorial.
- **Owl the Way Home: 4–7.** Explicit audience in `POCKETFUL.md`, “Audience and
  session shape”: roughly ages 4 to 7, no reading required. Its `README.md`
  describes wordless exploration and trading. Repository folder: `owlpack`.
- **Good Bribes Only: 4–7.** Its `README.md` describes an adult giving a word that
  the child enters on an A–Z spelling pad for a coin, then three coins per spin.
  The range is editorial and assumes adult help with the word. `teaches: letter
  recognition` names the alphabet-entry practice, not an invented earning task or
  a full phonics curriculum. Repository folder: `good-bribes-cubby`, game ID
  `good-bribes-only` (not the separate `good-bribes-only-cubby` project).
- **Spell Castle: 4–7.** Its `README.md` describes building three-letter words
  with letter tiles, spoken completed words and no losing. The range is editorial.
- **Waddle Wars: 4–7.** Its `README.md` describes a wordless snowball game for little
  kids; `docs/STORYBOARD.md` introduces moving, dice, and goals step by step.
  The range is editorial. Repository folder: `snowball`.
- **Wonder Patch: 3–6.** Its `README.md` describes a farm for little kids with no words: plant a seed, water it,
  be home by dark, and see what it grew into. Nothing dies and there is no timer to beat or way to lose. The range is
  editorial. It has no `teaches` value: the game names no learning task. Repository folder: `wonder-patch`.

The referenced files live in each game's independent repository, under the
`davidguttman` GitHub account; `README.md` is the source for the existing taglines,
learning descriptions, and browser-play links. Catalog metadata does not change
immutable game packages.

## Beta and dates

Line Cutter's `README.md` identifies it as a barebow archery tournament roguelike.
Its beta entry therefore has a descriptive tagline, `kind: game`, and the current
browser URL, but no invented educational outcome or child age recommendation:
Cubby's `AGENTS.md` identifies it as a technical test payload, not the intended
child audience.

`added` means the first appearance in a Cubby feed, not the last deploy or a move
between feeds. Line Cutter first appeared in `hosting/catalog.yaml` at `85c659c`
(2026-11-02); `4e62dc5` moved it to beta on 2026-11-12. Existing stable join dates
are preserved.

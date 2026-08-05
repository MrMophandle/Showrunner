# Character

> Someone who acts in the story. The category every other one ends up pointing at.

## Category

- key: character
- applies to: premise-brief, outline, script, scene-text, shot-image, tts-take

## Fields

- standing: core / recurring / one-shot / retired. Declared intent, not a count —
  appearance history is computed from artifact provenance (3.1).
- status: active / historical / candidate.
- aliases: what else the scripts call them, comma separated.

## Relation types

Declared here, per D23, because a checker cannot traverse an edge whose meaning
nobody wrote down. Each declaration carries the type name, the category it points
at, its cardinality, whether it is required, and its **inverse name** — so blast
radius is computable from both ends. A relation whose type is not on this list is
invalid; free verbs are rejected rather than guessed at.

- species → species · cardinality: exactly-one · required: yes · inverse: members
- stationed-at → location · cardinality: at-most-one · required: no · inverse: crew
- carries → technology · cardinality: any · required: no · inverse: carried-by

`species` is required (D22) and is the reason the world-rules check in this
fixture can fire at all: "in vacuum without a suit" only catches Tobin Wick if
something in scope says what Tobin Wick is. When a character's species genuinely
isn't decided yet, the sheet declares it as the literal word `unknown` — legal,
tracked, and visible on the canon library's gaps list. It is never left blank,
because a blank is indistinguishable from a sheet nobody finished.

An inverse is not a second declaration. `members` is navigable from the species
side because this line names it; the species category does not declare `members`
of its own.

## Check instructions

Read the artifact against exactly the facts loaded for this character and for the
species it declares. Behaviour that contradicts a fact is a finding anchored at the
scene where it happens. Behaviour ahead of or behind the character's declared arc
waypoint is a finding too (D8) — say which waypoint, and what landing the declared
one would have looked like.

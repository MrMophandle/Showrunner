# Character

> Someone who acts in the story. The category every other one ends up pointing at.

## Category

- key: character
- applies to: premise-brief, outline, script, scene-text, shot-image, tts-take

## Fields

- standing: core / recurring / one-shot / retired. Declared intent, not a count —
  how often someone actually appears is computed from artifact provenance.
- status: active / historical / candidate.
- aliases: what else the scripts call them, comma separated.

## Relation types

- species → species · cardinality: exactly-one · required: yes · inverse: members · inherits facts: yes
- walks-with → character · cardinality: any · required: no · inverse: walked-with

`species` is required (D22), and it is what makes a rule about a body land on a
person: a check reading a scene only knows what the channel does to Ottilie
because her sheet says what she is. When a character's species genuinely is not
decided, the sheet declares the literal word `unknown` — never blank, because a
blank is indistinguishable from a sheet nobody finished.

`inherits facts: yes` says the Fennlander sheet's facts load into check scope with
every character that declares Fennlander. Facts travel the declared edge only, one
way: a character inherits from its species, a species inherits nothing from its
members, and two Fennlanders inherit nothing from each other. `walks-with` carries
no facts, which is the default and the reason nothing is written on it.

An inverse is not a second declaration. `members` is navigable from the species
side because this line names it; the species category declares no `members` of its
own.

## Check instructions

Read the artifact against exactly the facts loaded for this character and for the
species it declares. Behaviour that contradicts a fact is a finding anchored at the
scene where it happens — say which fact, and quote it.

# Grey Harbor

> A working station on a shipping lane that stopped carrying ships. The smallest
> show that still has every shape in it: two episodes, six canon entities across
> five categories, one arc, and two defects planted on purpose.

## Show

- key: greyharbor
- title: Grey Harbor

## Seasons

- 1: Slack Water

## What this show is for

Grey Harbor is synthetic. Nobody watches it, nothing in it is generated, and no
step in this repository may spend a cent producing any of it — the script two
directories down was typed by hand, and it stays that way (fixtures before
features).

It exists to be two things at once:

1. **The worked example.** A new showrunner starting an empty show copies this
   directory, renames it, and edits. Every shape here is complete on purpose —
   a category that skipped its relation types, or an arc whose waypoints said
   only what they were called, would teach the next person to skip them too.
2. **The show every later epic's tests are written against.** E3's checks fire
   on the planted defects in `episode/01-the-long-pier/script.md`. E4 writes
   into this season. E5 renders these screens. So a shape that is wrong here
   gets copied, not corrected.

## What the fixture deliberately leaves out

- **Facts have no status and no lineage in these files.** Status
  (ratified / provisional / reverted) and lineage (established-in, ratified-at)
  are written by ratification at a gate and by nothing else (invariant 1). A
  file that declared its own facts ratified would be canon written by an import,
  which is the exact thing the first invariant forbids. `fixture:load` registers
  entity *identities* and nothing more; the prose bodies and facts below are the
  drafts E2's proposal flow carries to a gate.
- **Three of the shipped categories have no entity here:** faction, timeline,
  and house style (3.2, D10). Five categories is enough to show every shape,
  and adding a sixth is an edit — a `_category.md` and a directory — not
  engineering.
- **No media.** No images, no takes, no mix. E6 produces those; this show stops
  at a script.

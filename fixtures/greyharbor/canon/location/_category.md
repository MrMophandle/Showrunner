# Location

> Where a scene happens, and what it costs to get from one of them to the next.

## Category

- key: location
- applies to: premise-brief, outline, script, scene-text, shot-image

## Fields

- standing: core / recurring / one-shot / retired.
- status: active / historical / candidate.
- aliases: comma separated.

## Relation types

- part-of → location · cardinality: at-most-one · required: no · inverse: contains

## Check instructions

A location's facts carry its geography and its **transit costs** — what is
adjacent to what, and how long the crossing takes. Those are the facts the
continuity board reads to catch impossible adjacency deterministically, so write
them as numbers a machine can compare, not as atmosphere: "cycling the No. 4 lock
takes ninety seconds" is checkable; "the lock is slow" is not.

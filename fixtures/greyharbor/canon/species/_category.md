# Species

> What a body can survive. The category that makes a world rule land on a person.

## Category

- key: species
- applies to: premise-brief, outline, script, scene-text, shot-image

## Fields

- standing: core / recurring / one-shot / retired.
- status: active / historical / candidate.
- aliases: comma separated.

## Relation types

- homeworld → location · cardinality: at-most-one · required: no · inverse: native-species

`homeworld` is declared and deliberately unused: the Halvani sheet leaves it off,
because where the Halvani come from is not canon yet and inventing it here would
put a fact in the world that no gate ever ruled. An optional relation that is
absent is simply absent — which is the difference between it and `species` on a
character, where absence is illegal and `unknown` is the honest answer (D22).

## Check instructions

A species' facts load into check scope **with every character that declares it**
(D22). That is the whole point of the category: physiology and world rules are
written once, here, and inherited. When an inherited fact is wrong for one
character, the fix is a fact on that character naming what it overrides — never a
quiet edit to the species, which would silently move every member.

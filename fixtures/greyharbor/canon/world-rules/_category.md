# World rules

> The physics and the environment the show does not get to bend. A rule here is
> not flavour — it is the thing a scene can be wrong about (D10).

## Category

- key: world-rules
- applies to: premise-brief, outline, script, scene-text, shot-image, tts-take

## Fields

- standing: core / recurring / one-shot / retired.
- status: active / historical / candidate.
- aliases: comma separated.

## Relation types

- applies-to → location · cardinality: any · required: no · inverse: governed-by

`applies-to` is what scopes a rule set to somewhere. A rule that applies nowhere
loads into no check, which is a rule nobody is enforcing.

## Check instructions

Fire per scene, with the location's facts and the facts of **every species in the
scene** loaded alongside (D22). A world rule on its own catches nothing: "vacuum
requires a suit or an active containment field" is only violated by a particular
body outside a particular hull, and the body is what says whether it dies.

Write each rule so the check can name the exception it looked for and did not
find. Severity is high and confidence is high — these are the findings the writer
should never have to argue with.

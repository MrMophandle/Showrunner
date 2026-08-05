# The Long Pier

> The mid-script episode: premise written, outline written, script at draft 1 and
> not yet through its gate. Two defects are planted in the script on purpose.

## Episode

- season: 1
- number: 1
- title: The Long Pier
- lifecycle: script

## Arc positions

- What the harbor is for: 2

Episode 1 declares waypoint **2**, not 1, and that is deliberate. Waypoint 1 is
where Ilse starts — the status quo the season inherits — so the first episode is
the one that moves off it. A declared position is not an episode number, and a
fixture where the two matched would teach that they must.

## Artifacts

- premise-brief: premise.md · touches: Ilse Renn, Tobin Wick, Grey Harbor Station
- outline: outline.md · built from: premise-brief · touches: Ilse Renn, Tobin Wick, Grey Harbor Station
- script: script.md · built from: outline · touches: Ilse Renn, Tobin Wick, Halvani, Grey Harbor Station, Kestrel-pattern containment collar, The hull and the void

`built from` is the freshness edge, not a folder: revise the outline and the
script is stale until it is rebuilt, and the episode room says so in those words.

`touches` is provenance (invariant 2) — checks load exactly these entities and
never the whole bible. The script names all six because all six are on screen in
it: two bodies, the species those bodies are, the station, the collars nobody
wore, and the rules about the outside. Once E2's relations exist, `Halvani` and
`The hull and the void` would *also* arrive in scope by traversal — Halvani
through Tobin's required `species` edge (D22), the rules through the station's
`governed-by` inverse (D23). The two paths agreeing is the point; neither is the
one to trim.

## Scenes

Not listed here. Scenes are **derived from the script** and never prescribed to
the writer (D3) — `fixture:load` reads the scene headings out of `script.md`, in
order, and that is the only place the count comes from. There is no `num_scenes`
in this file, in the schema, or anywhere else, and there must never be one.

## What is planted here, and which check should fire

Both defects are in `script.md`. Neither is mentioned inside that file: the script
is what a check reads, and a script that announced its own bugs would test the
checker's reading comprehension of a hint rather than of a script.

### 1 · World-rules violation — scene 4

**What is wrong.** Tobin Wick works the relay housing at the head of the Long
Pier, in his coveralls, for three minutes. The Long Pier is outside the pressure
hull along its whole length. He is wearing neither a hardsuit nor an active
containment field, and scene 3 says so twice over: he takes a torque bar off the
rack, and all four Kestrel collars are still hanging closed on their pegs behind
him when he cycles the lock.

**Why it is genuinely a violation, and not just odd.** Three facts have to be in
scope at once, which is the whole reason this fixture has five categories instead
of two:

- *The hull and the void* rule 1 — outside the hull is vacuum unless a sealed
  hardsuit or an active containment field is between the body and the void.
- *Grey Harbor Station* — the Long Pier is outside the pressure hull, including
  the housings at its head.
- *Halvani* — a Halvani in unprotected vacuum is unconscious in nine seconds and
  dead inside two minutes. This is the fact that makes the rule land on Tobin, and
  it is in scope only because Tobin's sheet declares `species: Halvani` (D22).
  Delete that one line from `tobin-wick.md` and the scene stops being checkable —
  which is the argument for the relation being required.

**Which check should fire.** The world-rules check on scene 4, severity high,
confidence high, anchored at the scene. Its remediation is a rewrite note, not a
canon proposal: the rules are right and the scene is wrong.

**The near miss it should not report.** *The hull and the void* rules 2 and 3 are
obeyed everywhere in this script. Nothing is said or heard outside the hull — the
only signal from the pier goes over the housing's wired handset — and nothing in
the episode sinks, settles, drifts to a stop, or answers to a tide. A run that
reports either of those is crying wolf, and E3's cried-wolf tracking should be
able to see it here.

### 2 · Continuity contradiction — scenes 5 and 6

**What is wrong.** Scene 5 is the harbourmaster's office at 07:20, with Ilse and
Tobin in it. Scene 6 is the head of the Long Pier, marked CONTINUOUS, with Ilse in
a hardsuit checking the housing panel. Ilse is in two places at one time.

**Why the board catches it without an LLM.** This is the deterministic kind on
purpose (3.2b). Once the board has extracted its per-scene rows — location,
characters present, environment state, elapsed time — the contradiction is a
`COUNT(*)`: one character, two locations, one clock. No judgement is involved and
no model needs to be called, which is what makes it a **blocking** finding for the
next stage rather than an argument (D12, invariant 3).

Scene 6 is the **only** CONTINUOUS in the script, and that is deliberate. Every
other scene carries its own clock — Tobin crosses from the lock at 07:05 to the
pier at 07:07, which is a man walking through a door and not a contradiction. A
fixture where two scenes shared a clock innocently would hand the board a false
positive it could not tell from the planted one, and then the planted one would
prove nothing.

It fails a second, independent way, and should be reported once, not twice: the
No. 4 lock is the only route between the inboard decks and the Long Pier and takes
ninety seconds to cycle, so even read as consecutive rather than simultaneous, the
crossing does not fit. Dual presence is the primary reading; impossible adjacency
is the corroboration.

**Which check should fire.** The continuity board's dual-presence check, blocking
the next stage and rendering red at the script gate — where it is still Ryan's
call, because checks argue and never veto (invariant 3).

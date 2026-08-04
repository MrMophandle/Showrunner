# CLAUDE.md — Showrunner, the standing brief

Showrunner is a containerized web app for multi-show episodic video production:
writing, canon keeping, image and audio generation, assembly, publishing — with
Ryan (the showrunner) ruling at every gate.

This file is the distilled brief. The **ruled design** is
`handoff/docs/concept-and-architecture.md` (D1–D19 in-section, **D20–D24 in the
addendum at the end** — read the addendum, it amends earlier sections). Start at
`handoff/docs/README.md` for what's authoritative. Nothing overrides the concept
doc except a later ruling from Ryan.

## The domain nouns — use these words, not synonyms

**The spine**
- **Show** — owns its canon store, check categories, house style. Everything is
  scoped to a show; no hardcoded show or season anywhere.
- **Season** — story arcs, ordered episodes, and an idea pool (greenlit / parked / spiked).
- **Episode** — the unit of production, telling its own story. Lifecycle:
  premise → outline → script → assets → assembled → published.
- **Scene** — first-class and addressable, but **derived from** the written
  episode, never prescribed to the writer. `num_scenes` is an output, never an
  input. Scenes anchor findings, own their images/audio, scope re-checks.
- **Arc** — first-class, with a scope (show or season), a kind (character or
  story), a prose statement, and ordered **waypoints**. Episodes declare
  positions ("arc1 @ waypoint2"). An episode touching no arc is **vanilla** —
  legal, tracked, never a failure state. Arcs have their own screen (D24).

**Canon**
- **Category** — a kind of canon (character, location, faction, species,
  technology, timeline, house style, world rules), defined as *data*: fields,
  applicable artifact kinds, check instructions, allowed relation types. Adding
  a category is an edit, not engineering.
- **Entity** — one instance: identity + standing (core / recurring / one-shot /
  retired), prose body, facts, references, relations.
- **Fact** — an atomic checkable statement with lineage (established-in, ratified-at)
  and status (ratified / provisional / reverted). Append-only with validity
  ranges, so "canon as of episode 4" is answerable (D9).
- **Relation** — a *typed* edge. Relation types are **declared per category**
  with a target category, cardinality, and an inverse name; an undeclared type
  is invalid (D23). Every character declares exactly one `species` relation,
  required, `unknown` if unknown — never blank (D22). A character's species
  facts load into check scope with the character.
- **Proposal** — the only way canon changes. Five parts: the change, usage
  context, implications (blast radius), alternatives, origin & disposition.
  Provisional proposals ride their episode and are visible to checks.
- **Ratification** — Ryan approving a proposal at its gate. This, and only this,
  writes canon.

**Production**
- **Artifact** — anything produced (outline, script, scene text, shot image, TTS
  take, mix, timeline, render, publish kit). Carries **provenance** (which canon
  entities it touches), a version, and freshness edges. Staleness is *computed*,
  never remembered.
- **Run / Step** — a stage in motion. Steps are code, declare inputs and outputs,
  are idempotent, and persist state before and after.
- **Gate** — a first-class decision object: artifact under review, findings,
  round history, ruling (approve / reject-with-notes / override-with-record).
  A gate always renders its artifact — never a filename.
- **Check / Finding** — one reviewer pass, parameterized by canon category, fired
  at artifact boundaries. A finding has an anchor, concern, severity, confidence,
  and remediation actions.
- **Event** — append-only log of every transition. Drives the live UI over SSE
  and is the audit trail.

## The five invariants — never violate

1. **Only ratification writes canon.** Everything else *proposes* — not agents,
   not checks, not remediations, not the runner, not an import, not a migration.
   A ratification is Ryan's approval of a proposal at a gate.
2. **Every artifact declares provenance.** Checks load exactly the entities in
   scope — never the whole bible.
3. **Checks argue, never veto.** A red finding makes an artifact loud; Ryan's
   approval over it is recorded as an explicit override. One exception (D12):
   **deterministic** findings (continuity board, canon graph) block the *next
   stage*, but never his gate.
4. **Honest confidence.** Text checks gate hard; image checks flag for his eye;
   audio checks verify words only and queue a listen. Never render a weak check
   as a green checkmark.
5. **Nothing runs without a click.** Retries are bounded at **2** — that is **three
   attempts in all**, the first plus two re-runs — everywhere,
   including image generation — then it reaches Ryan with the full attempt history.

## The Archon rule (binding)

**No workflow DSL. No configurable workflow engine.** Pipeline stages (write,
produce, canon, assemble, season review) are TypeScript functions in this app;
changing one is a code change with a test. If you find yourself building a
generic or configurable workflow system, **stop** — that is the failure mode
this project exists to escape. Either party may say "Archon" and the other stops.

## UI rules

- **No generic verbs.** Every action button states **verb + object + scope +
  cost**: "Write the ep07 outline — 1 Opus call, ~$0.85". Never "Launch", "Run",
  "Go", "Do".
- **Preconditions before the button.** A blocked action renders disabled with the
  reason in words — never a failure after launch.
- **One artifact, one ruling.** Media review is one at a time; no batch verdicts.
- **Gates render the artifact** — readable script, viewable image, playable take.
- **Run state is always visible**: what's thinking, what changed, what waits on Ryan.
- **The HIL contract**: everything pertinent, present, zero archaeology. If Ryan
  has to go find context, the screen has failed.
- **Reject is routed, not rewound** (D21, 4.7): the note picks its depth — the
  shot's prompt, the scene, the premise, or hold the slot for a hand-made asset.
  Nothing regenerates until the route lands.
- Eight screens (D24): floor · episode room · gate room · canon library ·
  review desk · screening room · season map · **arc page**. Approved mockups
  live in `mockups/`; E5 builds to them.

## Architecture rulings

- Container app, `docker compose up`; **SQLite for structure + plain files for
  heavy artifacts** on a mounted volume, human-readable and git-versionable (D2).
- One app process: web UI, API, SQLite, runner, SSE. No broker, no job queue (2.1).
- Native Mac GPU worker for GPU steps; the container calls it (D5).
- One `LLMAdapter`, two backends: Anthropic API and the `claude` CLI (D6).
  Subprocess calls pass an argv array, never a shell string.
- One `ImageAdapter`, three backends routed **per shot** in the shot manifest
  (D20): `nano-banana-pro` (cloud) for character shots, `z-image-turbo` (local)
  for ambient, `qwen-image-edit` (local) for hero/identity shots. See
  `handoff/docs/D20-image-backends.md` before writing E6.
- **Named locks.** `gpu` covers local image generation **and** TTS — they must
  never run concurrently (the Metal corruption lesson). `image-api` covers cloud
  image steps, which parallelize with audio. Contention surfaces as
  "waiting on GPU (held by ep05)". Per-episode serialization, cross-episode
  parallelism (D7, D20).
- **A hand-made asset always wins.** Existing files are never overwritten;
  re-runs fill gaps only. Re-rolls are explicit (D20).
- Crash-proof: killed processes resume from the last completed step; open gates
  survive reboots. Long steps stream — streams, not spinners.
- Cost ledger: every LLM call and generation records tokens/dollars against
  step, run, episode, and show (2.4).

## Naming conventions

- **Use the domain nouns above, exactly** — in code, tables, URLs, UI copy, and
  commit messages. A gate is a `gate`, not an "approval step"; a finding is a
  `finding`, not an "issue"; ratification is not "saving".
- SQL tables and columns `snake_case`, table names **singular** (`episode`, not
  `episodes`; `arc_waypoint`); TypeScript `camelCase` values, `PascalCase` types.
- Adapter interfaces are `XAdapter` (`LLMAdapter`, `ImageAdapter`); backend and
  lock ids are `kebab-case` (`gpu`, `image-api`, `z-image-turbo`).
- Migrations are plain numbered SQL files, applied in order.
- Paths: `app/` for the application, `library/` for the mounted volume (SQLite
  file + artifacts), `fixtures/greyharbor/` for the fixture show,
  `handoff/docs/` for the design docs, `mockups/` for the approved screens.

## Commands

Wired by E1-1 (issue #2) — until it lands, they don't exist yet.

```
npm test          # vitest
npm run typecheck # tsc --noEmit
npm test && npm run typecheck   # CI; run both before claiming done
npm run fixture:load            # seed the Grey Harbor fixture (idempotent)
docker compose up               # app on :4400
```

## Working agreements

- **One issue, one session.** Leave the repo green; if unfinished, write
  `HANDOFF.md` — never a half-open migration or a red main.
- Branch; don't commit to `main`. Don't push without asking Ryan.
- Issues live in GitHub Issues on `MrMophandle/Showrunner`, one milestone per
  epic (E1–E8) (D18). Ryan gates epics, not issues.
- **Fixtures before features.** The Grey Harbor fixture backs all tests. Never
  burn real generation money in a test.
- Dead Light (Ryan's live show) ships on the old stack until E7; that repo is
  read-only, forever.

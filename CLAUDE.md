# CLAUDE.md — Showrunner, the standing brief

Showrunner is a containerized web app for multi-show episodic video production:
writing, canon keeping, image and audio generation, assembly, publishing — with
Ryan (the showrunner) ruling at every gate.

This file is the distilled brief. The **ruled design** is
`handoff/docs/concept-and-architecture.md` (D1–D19 in-section, **D20–D25 in the
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
- **Category** — a kind of canon (character, location, faction, species, technology,
  timeline, house style, world rules), defined as *data*: fields, applicable artifact kinds,
  check instructions, allowed relation types. Adding one is an edit, not engineering.
- **Entity** — one instance: identity + standing (core / recurring / one-shot / retired),
  prose body, facts, references, relations. Registering one makes a **`candidate`**.
- **Fact** — an atomic checkable statement with lineage (established-in episode,
  ratified-at ruling) and a validity range, so "canon as of episode 4" is answerable (D9).
  **Rows are immutable and status is derived**; the only state change is a closure row,
  and a supersession closes the predecessor and opens the successor at one ruling — so
  ratifying a provisional fact writes a new row. Ranges count in `canon_ruling.seq`, the
  monotonic clock canon is read by; **a date maps onto a ruling, never the reverse**.
  `canonAsOf` is ratified facts only; provisional facts ride their episode and reach
  checks via the scope helper. `canon_ruling` **is** the disposition ledger every kind of
  ruling lands on — grow it by ADD COLUMN, never a sibling.
- **Relation** — a *typed* edge. Relation types are **declared per category** with a
  target category, cardinality, and an inverse name; an undeclared type is invalid (D23).
  Every character declares exactly one `species` relation, required, `unknown` if unknown
  — never blank (D22); **`unknown` is a relation row with a NULL target**, never a
  sentinel entity. A declaration also says whether **facts travel** it (`inherits facts`),
  one way, declarer → target — so D22's inheritance is data, and an exception displaces
  the *lineage*: a species edit carries the exception onto the successor, visibly stale.
  The write enforces type, target and cardinality; **`required` is enforced at ratification**.
- **Proposal** — the only way canon changes. Five parts: the change (a fact delta, a
  relation delta, or a promotion carrying the full sheet), usage context, implications,
  alternatives, origin & disposition. **Implications are computed at read time** from
  relations + provenance + facts — never stored, the freshness pattern. A proposal with an
  episode rides it (its facts written provisional, visible to checks); **`episode_id` is
  nullable and founding is the reason** — no run, gate, or episode is a precondition for a
  ruling. Relations never ride: an edge is written only by ratification.
- **Ratification** — Ryan approving a proposal at its gate. This, and only this,
  writes canon. Founding is no exception (D25): fixtures, imports (E7), and new
  shows raise **promotion proposals** ruled through the same API — no path writes
  ratified rows directly, and tests exercise the flow rather than bypassing it.
  **One ruling API — ratify / reject-with-notes / defer — convened by every surface**
  (a gate says where Ryan stood, never whether he may rule). A proposal is ruled once and
  every disposition is kept forever: a rejection's note is read back by later writer runs,
  a deferral parks it and stops it riding. Ratification writes relations, then the sheet,
  then facts, then references, and **refuses an incomplete sheet** — a character with no
  `species` (D22); `unknown` satisfies it, absent does not.

**Production**
- **Artifact** — anything produced (outline, script, scene text, shot image, TTS take, mix,
  timeline, render, publish kit). Carries **provenance** (which canon entities it touches),
  a version, and freshness edges. Staleness is *computed*, never remembered.
- **Run / Step** — a stage in motion. Steps are code, declare inputs and outputs,
  are idempotent, and persist state before and after.
- **Gate** — a first-class decision object: artifact under review, findings, round history,
  ruling (approve / reject-with-notes / override-with-record). It renders its artifact.
- **Check / Finding** — one reviewer pass, parameterized by canon category, fired at
  artifact boundaries. A finding has an anchor, concern, severity, confidence, remediations.
- **Event** — append-only log of every transition. Drives the live UI over SSE and is the
  audit trail. **The record, never the state:** `run`, `step`, and `resource_lock` are the
  source of truth; nothing rebuilds state by replaying events, and the runner never reads
  its own log back. Order by the monotonic `seq`, never by the timestamp — `at` is for
  humans. A step narrates itself with `progress()` (the "what" line, latest-wins) and
  `chunk()` (streamed output, accumulating). Append-only is enforced by SQLite triggers,
  so there is no update path and no delete path to find.

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
5. **Nothing runs without a click.** Retries are bounded at **2** — **three attempts in
   all**, the first plus two re-runs — everywhere, including image generation; then it
   reaches Ryan with the full attempt history.

## The Archon rule (binding)

**No workflow DSL. No configurable workflow engine.** Pipeline stages (write, produce,
canon, assemble, season review) are TypeScript functions in this app; changing one is a
code change with a test. If you find yourself building a generic or configurable workflow
system, **stop** — that is the failure mode this project exists to escape. Either party
may say "Archon" and the other stops.

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
- **Reject is routed, not rewound** (D21, 4.7): the note picks its depth — the shot's
  prompt, the scene, the premise, or hold the slot for a hand-made asset. Nothing
  regenerates until the route lands.
- Eight screens (D24): floor · episode room · gate room · canon library · review desk ·
  screening room · season map · **arc page**. Approved mockups live in `mockups/`; E5
  builds to them.

## Architecture rulings

- Container app, `docker compose up`; **SQLite for structure + plain files for
  heavy artifacts** on a mounted volume, human-readable and git-versionable (D2).
- One app process: web UI, API, SQLite, runner, SSE. No broker, no job queue (2.1).
- Native Mac GPU worker for GPU steps; the container calls it (D5).
- One `LLMAdapter`, two backends: Anthropic API and the `claude` CLI (D6).
  Subprocess calls pass an argv array, never a shell string.
- One `ImageAdapter`, three backends routed **per shot** in the shot manifest (D20):
  `nano-banana-pro` (cloud) for character shots, `z-image-turbo` (local) for ambient,
  `qwen-image-edit` (local) for hero/identity. Read `handoff/docs/D20-image-backends.md`.
- **Named locks.** `gpu` covers local image generation **and** TTS — never concurrently
  (the Metal corruption lesson). `image-api` covers cloud image steps, which parallelize
  with audio. Contention surfaces as "waiting on GPU (held by ep05)". Per-episode
  serialization, cross-episode parallelism (D7, D20).
- **A hand-made asset always wins.** Existing files are never overwritten;
  re-runs fill gaps only. Re-rolls are explicit (D20).
- Crash-proof: killed processes resume from the last completed step; open gates
  survive reboots. Long steps stream — streams, not spinners.
- Cost ledger: every LLM call and generation records tokens/dollars against step, run,
  episode, and show (2.4). **One table (`cost_entry`), one write path (`recordCost`), one
  dated price table (`MODEL_PRICE`)** — E6's image and audio calls are rows in it, not a
  second ledger, and its `kind` already accepts them. A row records **dollars always,
  tokens optionally**, and says how it was priced (`rate-card` / `reported` / `unpriced`)
  so a gap never renders as a zero. Append-only; a correction is another row.
  `usage.input_tokens` is the **uncached remainder** of the prompt, not its size — read
  `app/server/cost.ts` before touching the arithmetic.

## Naming conventions

- **Use the domain nouns above, exactly** — in code, tables, URLs, UI copy, and
  commit messages. A gate is a `gate`, not an "approval step"; a finding is a
  `finding`, not an "issue"; ratification is not "saving".
- SQL tables and columns `snake_case`, table names **singular** (`episode`, not
  `episodes`; `arc_waypoint`); TypeScript `camelCase` values, `PascalCase` types.
- Adapter interfaces are `XAdapter` (`LLMAdapter`, `ImageAdapter`); backend and
  lock ids are `kebab-case` (`gpu`, `image-api`, `z-image-turbo`).
- Migrations are plain numbered SQL files, applied in order.
- Paths: `app/` for the application, `library/` for the mounted volume (SQLite file +
  artifacts), `fixtures/greyharbor/` for the fixture show, `handoff/docs/` for the design
  docs, `mockups/` for the approved screens, `scripts/` for manual scripts, never CI.

## Commands

```
npm test && npm run typecheck   # CI — run both before claiming done
npm run fixture:load            # seed the Grey Harbor fixture (idempotent)
docker compose up               # app on :4455
npm run smoke:llm -- --backend claude-cli|anthropic-api   # SPENDS REAL MONEY, by hand
```

`smoke:llm` is the only thing that spends money and CI never runs it; use it after touching
a backend — the fake adapter proves the wiring, a real call proves the numbers it is fed.
`SHOWRUNNER_LLM_BACKEND` forces one; unset, a key means the API and no key means the CLI.

## Working agreements

- **One issue, one session.** Leave the repo green; if unfinished, write `HANDOFF.md`.
- **Design reasoning lives in the code it describes** — module headers, migration comments,
  comments on the type. Not a separate spec file: this repo has no `docs/` tree and a spec
  drifts the day after. What binds OTHER epics goes here, where every session loads it.
- Branch; don't commit to `main`. Don't push without asking Ryan.
- Issues live on GitHub, one milestone per epic (D18). Ryan gates epics, not issues.
- **Fixtures before features.** The Grey Harbor fixture backs all tests. Never
  burn real generation money in a test.
- Dead Light (Ryan's live show) ships on the old stack until E7; that repo is
  read-only, forever.

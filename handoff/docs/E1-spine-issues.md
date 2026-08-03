# Epic 1 — The Spine

> Milestone `E1 · The spine` on `MrMophandle/Showrunner`. One issue = one Opus session.
> Every issue below ends with a machine-checkable done-condition. If a session can't
> finish its issue, it leaves the repo green (tests pass) and a `HANDOFF.md` note —
> never a half-open migration or a red main branch.
>
> **Epic exit (Ryan operates it):** launch a two-step run against the fixture show from
> a bare-bones page, watch it stream, hit a gate, rule on it, kill the process mid-run,
> restart, and see the run resume. Cost ledger shows the spend.

---

## E1-0 · CLAUDE.md — the standing brief

**Context to load:** the ruled Concept & Architecture doc (Sections 1–4 invariants, Section 6.1).
**Deliverable:** `CLAUDE.md` at repo root distilling: the domain nouns and their meanings; the five invariants (only ratification writes canon; provenance everywhere; checks argue never veto — except deterministic findings block the next stage; honest confidence tiers; nothing runs without a click, retries bounded at 2); the Archon rule ("no workflow DSL — stages are code; if you're building a configurable workflow engine, stop"); naming conventions; the no-generic-verbs button rule (verb + object + scope + cost); test and typecheck commands.
**Done:** file exists, under 200 lines, and a fresh Claude session asked "what must never write canon?" answers correctly from it alone.

## E1-1 · Repo scaffold & container

**Context:** CLAUDE.md; D2/D5 rulings (container app, SQLite + volume, native GPU worker later).
**Deliverable:** TypeScript monorepo-lite: `app/` (Hono server + Vite/React SPA, SSE endpoint stub), `Dockerfile` + `docker-compose.yml` (app container, `./library` volume mount for artifacts + SQLite file), vitest + tsc wired, CI script (`npm test && npm run typecheck`).
**Done:** `docker compose up` on a clean checkout serves a hello page on :4400; `npm test` passes; the SQLite file and a sample artifact land under the mounted volume, not inside the container.

## E1-2 · Domain schema & store

**Context:** CLAUDE.md; Concept Sections 1.1–1.3; D3, D9.
**Deliverable:** SQLite schema + typed data layer for: show, season, episode (lifecycle enum), scene; artifact (kind, version, file pointer, provenance list, freshness edges); arc (scope, kind, ordered waypoints) + episode arc-positions; migrations runner (plain numbered SQL files). Facts/proposals tables are stubbed only as reserved names (E2 owns them).
**Done:** unit tests create a show → season → episode → scenes, attach artifacts with provenance, flip a freshness edge (script v4 → v6) and query "which artifacts are stale and why" — all passing.

## E1-3 · The runner: run, step, resume

**Context:** CLAUDE.md; Concept 2.2–2.3; D7.
**Deliverable:** `Run`/`Step` executor: steps are typed TS functions declaring inputs/outputs; per-episode serialization + cross-episode parallelism; named resource locks (`gpu`, `image-api`) with "waiting on X (held by Y)" state; step state persisted before/after execution; crash-resume from last completed step; bounded retry (max 2) with attempt history recorded.
**Done:** test suite proves — two runs on one episode queue; runs on two episodes interleave; a lock contention surfaces the holder; `kill -9` mid-run (simulated) then restart resumes and completes; a step that fails twice surfaces its attempt history.

## E1-4 · The gate primitive

**Context:** CLAUDE.md; Concept 1.3 (gate), 2.2; D12, D15.
**Deliverable:** Gate objects: created by a step (artifact ref + payload), pause their run; ruling API — approve (optional comment) / reject (required notes) / override (recorded as explicit override); round history (reject → revise → re-present increments the round, prior verdicts marked stale); rulings append to the event log; run resumes only on ruling.
**Done:** tests: a run pauses at a gate and survives restart still-open; reject with notes reopens the producing step with the notes as input; round 2 carries round-1 history; override is distinguishable from approve in the log.

## E1-5 · Event log & SSE

**Context:** CLAUDE.md; Concept 2.1, 2.2 (event).
**Deliverable:** Append-only event table (every run/step/gate/lock transition); SSE endpoint streaming events + step output chunks to the browser; simple event-replay query ("everything about run X in order").
**Done:** integration test opens the SSE stream, launches a run, and receives launch → step-start → output chunks → gate-open in order; replay query reconstructs the same sequence.

## E1-6 · Claude adapter & cost ledger

**Context:** CLAUDE.md; Concept 2.4; D6.
**Deliverable:** One `LLMAdapter` interface, two implementations — Anthropic API (key from env) and `claude` CLI (subprocess, argv array never shell string); streaming output in both; per-call token + dollar capture written against step/run/episode/show; projected-cost helper for buttons ("1 Opus call, ~$0.85"); budget config per show with remaining-this-week query.
**Done:** a fake-adapter test proves ledger rollups at all four levels and the projection helper; a smoke script (manual, documented) round-trips one real call on each backend.

## E1-7 · Fixture show

**Context:** CLAUDE.md; Concept 6.1 (fixtures before features).
**Deliverable:** `fixtures/greyharbor/` — a synthetic mini-show ("Grey Harbor"): 2 episodes (one mid-script, one un-started), 6 canon entity files in the documented shapes (2 characters, 1 location, 1 species, 1 technology, 1 world-rules), one arc with 3 waypoints, one script with a planted continuity contradiction and a planted world-rules violation (for E3), seeded via one command.
**Done:** `npm run fixture:load` populates a fresh volume; every E1 test that needs a show uses it; loading twice is idempotent.

## E1-8 · The bare-bones operating page

**Context:** CLAUDE.md; everything above. This is scaffolding UI — the real cockpit is E5; spend nothing on visuals.
**Deliverable:** One page: fixture episodes listed with lifecycle position; a full-sentence launch button (projected cost shown) for a demo two-step run (LLM call → write artifact → gate); live stream panel (SSE); the gate rendered with its artifact readable and approve/reject-with-notes; the run's cost shown after.
**Done:** the epic exit criterion runs end-to-end on this page, including the kill-and-resume drill.

---

### Sequence & dependencies

E1-0 → E1-1 → E1-2 → {E1-3, E1-5, E1-6 in any order} → E1-4 → E1-7 → E1-8.
Eight sessions, plus one integration session if E1-8 surfaces seams.

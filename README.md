# Showrunner

A containerized web app for multi-show episodic video production — writing, canon
keeping, image and audio generation, assembly, and publishing, with the showrunner
ruling at every gate.

**Status: E1–E3 complete, each exit operated for real.** The spine (domain schema, runner
with named locks and crash-resume, gates, the append-only event log over SSE, the Claude
adapter and cost ledger) survived a `SIGKILL` mid-run on Aug 5 2026 — one call in, one call
out, across a kill. Canon (categories, entities, facts with validity ranges, typed
relations, proposals and the one ruling API, founding) was founded and moved by ruling at
the bench on Aug 7. Checks (findings and passes, the continuity board's free deterministic
rules, the generic checker and its honest gap, the D12 wall and its doors, panels with
mandatory story-craft, the three remediations, cried-wolf tracking) ran on real money on
Aug 9 — $1.32 against ~$1.60 projected, both planted contradictions surfaced, and the wall
came down through both doors.

**E4 · The writing line is built, code-done — and its exit belongs to E5, by ruling.** The
writer's desk (canon as *this episode's audience* knows it, the entities left out with the rule
that kept each one out, Ryan's notes with their three origins), the three writing stages with
their gates and their correction loops, scenes derived from the written script, the extraction
that reads an approved draft for what it claims of canon, direct hand editing, the reject that
routes rather than rewinds, and the completion sweep — all of it on fakes, in 963 tests. Ryan
began the drill on the scaffolding page and ruled it off (Aug 10 2026): four epics of records
on one unstyled page had become a wall of shifting text that failed the HIL contract. **E5's
exit — this same flow, run entirely from the cockpit — closes both epics at once.** The flow
the drill scripted (the half-door opening through ep02's demo-era brief, the routed-reject
round trip, the hand edit, the waypoint declared and landed, the sweep ruled one at a time)
is preserved in `handoff/docs/README.md`'s last E4 ledger entry and in git history; there is
nothing to operate here until the cockpit exists.

Each epic ends with a drill Ryan operates, not a test suite that passes. Retired and deferred
drills live in git history; operated-exit records are in
`handoff/docs/concept-and-architecture.md` §6.2.

## Running it

```
cp -n .env.example .env               # once; -n so it never overwrites an existing one
docker compose up                     # the app on http://localhost:4455
```

`.env` is gitignored and read automatically by `docker compose up`, `npm start`, and
`npm run dev` — there is nothing to export, in this shell or any other. Leave
`ANTHROPIC_API_KEY` empty in it to use D6's other backend, the `claude` CLI, which works
outside the container where you are signed in.

> **A running container serves the past.** It keeps the image it was *born* from and the
> environment it was *created* with — merging PRs, editing `.env`, and plain
> `docker compose up` over a live container change nothing it serves. And compose builds
> the **local tree**, not GitHub — `git pull` first. Whenever code or
> `.env` has changed since the container started:
> `git pull && docker compose down && docker compose up --build`. Both real incidents so
> far — a rotated key the container didn't have, and a drill against a two-day-old
> page — were this, and every drill assumes a fresh container.

Everything durable lands in `./library` on the host — `showrunner.db` plus artifacts
as plain files (D2). The directory is gitignored; compose creates it on first run.

Working on it without the container:

```
npm install
npm run build              # the SPA
npm run fixture:load       # seed Grey Harbor; spends nothing, safe to run twice
npm start                  # the app process on :4455
npm run dev:web            # the SPA with HMR on :4456, API proxied to :4455
npm test && npm run typecheck   # CI — run both before claiming done
```

Node 24+ is required: the server runs its TypeScript directly, and SQLite comes from
`node:sqlite` rather than a native module. GPU steps will run on a native Mac worker
outside the container (D5) — nothing GPU-related belongs in compose.

**Which backend it will use** (D6): `SHOWRUNNER_LLM_BACKEND` decides when it is set;
unset, an `ANTHROPIC_API_KEY` means the API and no key means the `claude` CLI. Both are
read from `.env` (or the environment, which wins). Whichever it picks, it checks that the thing is actually there and says so
at boot and on `/api/health` — a container with neither is a legitimate state that
reports itself, not a crash and not a surprise on the first model call.

## Founding Grey Harbor — a fresh library's first click

`npm run fixture:load` does exactly half the job on purpose: it registers the fixture's
entity sheets and raises a promotion proposal per sheet, and **writes no canon at all**
(**loading raises; only founding rules** — D25). On a fresh `./library`, open the page,
scroll to **Canon — Grey Harbor**, and press:

> Found Grey Harbor — ratify its 6 founding sheets, one ruling each on the ledger
> *No model call · $0.00*

One click, six rulings on the ledger, entities `active`. Checks read *ratified* canon
(invariant 2), so anything that reads canon needs this first. Ruling the seventh sheet,
Sefa Doule the deliberate `candidate`, stays yours to do or not at the bench.

## The writing line's exit — deferred to E5, by ruling

The E4 drill lived here and was ruled off mid-run (Aug 10 2026) — not because a mechanism
failed, but because the scaffolding page it ran on had failed the HIL contract. Its script
is in git history; the flow it walked becomes E5's exit drill, re-scripted against the
cockpit's eight approved mockups, and that one drill will close E4 and E5 together.

## Where things are

| Path | What |
|---|---|
| `handoff/docs/README.md` | **Start here.** Index of the design docs, what's authoritative, and how to write an epic's issue file. |
| `handoff/docs/concept-and-architecture.md` | The ruled design — domain, orchestration, canon, checks, screens, build plan. Decisions D1–D24. |
| `handoff/docs/D20-image-backends.md` | Image generation in detail, carried forward from the Dead Light console. |
| `mockups/` | Eight approved screen mockups + their README. Serve that directory and open the floor screen — instructions in `mockups/README.md`. |

Work is tracked in [GitHub Issues](https://github.com/MrMophandle/Showrunner/issues),
one milestone per epic. **E1 · The spine** is issues #1–#9; **E2 · Canon** is issues #23–#29.
The shipped product documents are in `docs/` — `canon-schema.md` is what an empty show is
founded from (3.5), and it is tested like code.

## The data layer

`app/server/db/` is the schema and the one seam onto SQLite; `app/server/domain/` is the
typed layer over it. Four rules hold it together:

- **`node:sqlite` is imported in `db/store.ts` and nowhere else.** Everything else takes a
  `Store` and never sees a database handle, so a driver swap is a one-module change.
- **Migrations are plain numbered SQL files** in `db/migrations/`, applied in order inside a
  transaction and recorded in `schema_migration`. Change the schema by adding the next
  number; never edit an applied file. No ORM, no query builder, no schema DSL.
- **Staleness is computed, never remembered.** There is no `is_stale` column. An artifact
  records what it consumed and at which version — optionally scoped to one scene — and
  "which artifacts are stale and why" is a query over those edges.
- **Scenes are derived, never prescribed.** There is no `num_scenes` anywhere: the count
  is `SELECT COUNT(*)` off the episode the writer actually wrote.

The same computed-not-remembered rule covers arcs: an episode records the waypoint
*ordinal* it declared against, so inserting a waypoint mid-sequence makes the ordinal
drift, and "which episodes need re-checking" falls out of the drift rather than a flag.

## The shape of it

Show → Season → Episode → Scene. A show owns its **canon** — an approval-gated store
of what is true. Episodes move premise → outline → script → assets → assembled →
published. **Checks** compare artifacts against canon at artifact boundaries and raise
findings; findings argue, they never veto. Only **ratification** — the showrunner's
ruling at a gate — writes canon.

Two rules worth knowing before you touch the code:

- **The Archon rule.** No workflow DSL, no configurable workflow engine. Pipeline
  stages are TypeScript functions. If you find yourself building a generic workflow
  system, stop — that's the failure mode this project exists to escape.
- **No generic buttons.** Every action states verb + object + scope + cost: "Write the
  ep07 outline — 1 Opus call, ~$0.85". Never "Launch", "Run", or "Do".

## Epics

E1 spine · E2 canon · E3 checks · E4 the writing line · E5 the cockpit ·
E6 the media line · E7 Dead Light migrates in · E8 someone-who-isn't-Ryan can run it.

Each epic ends with something Ryan *operates*, not reads about.

# Showrunner — the design documents

Start here if you're about to write an epic's issue file, or you need to know what
was ruled and why.

## What's authoritative

| Document | What it is | Authority |
|---|---|---|
| `concept-and-architecture.md` | The ruled design: domain, orchestration, canon, checks, screens, build plan. Decisions **D1–D19** in-section, **D20–D24** in the addendum at the end. | **The source of truth.** Nothing overrides it except a later ruling from Ryan. |
| `D20-image-backends.md` | The image-generation carry-forward from the Dead Light console, in detail — backends, routing, lock semantics, and the operational rules that made it work. | Expands D20. Read before writing E6. |
| `E1-spine-issues.md` | The E1 issue file, as originally drafted. | **Superseded** — the GitHub issues are authoritative (see below). |
| `../../CLAUDE.md` | The standing brief — invariants, domain nouns, Archon rule, conventions, commands. Written by E1-0 (issue #1). | **Binding on every session.** The `handoff/CLAUDE.md` draft is retired and now just points here. |
| `../../mockups/` | Eight approved screen mockups + their README. | Approved. E5 builds to them. |

**Rulings after the export live in the addendum**, not in the sections they amend.
The sections carry `→ Amended by D…` pointers where a ruling changed them — follow
them. The addendum holds five rulings, all made during the mockup review:

- **D20** image generation: three backends routed per shot; `gpu` covers local image
  gen *and* TTS; hand-made assets always win; retries bounded at 2.
- **D21** review-desk reject is routed, not rewound.
- **D22** every character declares a species (required typed relation).
- **D23** relation types are declared per category, with inverses.
- **D24** arcs get their own page — the screen set is eight, not seven.

## Where the issues live

GitHub Issues on `MrMophandle/Showrunner`, one milestone per epic (D18).

**E1 · The spine is done** — issues #1–#9, all closed, and the epic exit was operated by
Ryan on Aug 5 2026 rather than merely tested (see the drill in the root `README.md`). It is
the worked example of the issue format; read the closed issues, not `E1-spine-issues.md`,
which was superseded when six of the nine were amended to absorb D20–D24.

**E2 · Canon is next**, and its issue file does not exist yet. Writing it is the first
piece of work. Follow the procedure below.

## Writing an epic's issue file

Per 6.3, issue files are written **epic-by-epic, just before the epic starts** —
not all up front. It is E2's turn now.

1. **Read the whole concept doc, addendum included.** Then re-read the sections that
   epic owns (E2 → Section 3; E3 → Section 4; E4 → 1.1 + 4; E5 → Section 5 + the
   mockups; E6 → Section 5.5/5.6 + `D20-image-backends.md`).
2. **Check §6.2 for that epic's `→ Scope grew` note.** E2, E5, and E6 all gained
   scope after the original export.
3. **Read "What E1 built, and where" and "Constraints E1 leaves behind" below.** The
   first tells you which module a new issue extends rather than rebuilds; the second is
   the things one epic decided that bind a later one, and every session that skipped
   them lost time rediscovering the reasoning.
   **Size each issue by how many distinct surfaces it touches, not by how hard it is.**
   E1's hardest issue (the runner) went smoothly because it was one idea; its longest
   (the operating page) sprawled because it was a server API, a browser, a new stage,
   and a config fix at once. A deferral counts as a surface — E1-4 shipped no HTTP
   routes and quietly loaded all of them onto E1-8.
4. **Write one issue per Opus session** (6.1). Every issue carries three parts:
   - **Context to load** — the exact sections and prior artifacts, so the session
     doesn't have to hunt.
   - **Deliverable** — what exists when it's done, concretely.
   - **Done** — a *machine-checkable* condition. "Tests pass" is not one; "a planted
     contradiction produces an anchored finding whose rewrite remediation fixes it" is.
5. **Sequence the issues** and state the dependencies at the end of the file, as E1 does.
6. **State the epic exit** at the top: the thing *Ryan operates*, not reads about.
   Ryan gates epics, not issues (6.1).

## What E1 built, and where

The map an epic-writer needs before deciding what a new issue has to build versus extend.
Everything below exists, is tested, and was operated end to end. Read the module, not this
summary, before writing an issue against it — but read this first to know which module.

**The one seam onto SQLite.** `db/store.ts` is the only file that imports `node:sqlite`;
everything else takes a `Store`. `db/migrate.ts` applies plain numbered SQL from
`db/migrations/` (five so far: spine, runner, event, gate, cost). Keep both true — the
driver swap stays a swap only while nothing else holds a handle.

**The spine** (`domain/`). `spine.ts` — show, season, episode, scene. `artifact.ts` —
artifacts with provenance, inputs, revisions, and **computed** freshness (`staleArtifacts`,
`artifactFreshness`; there is no `is_stale` column and never will be). `arc.ts` — arcs with
prose statements, waypoints carrying descriptions and landing criteria, episode positions,
`isVanilla`, `episodesNeedingRecheck`, and an append-only edit history. `canon.ts` —
deliberately thin: `registerEntity`, `findEntity`, `entitiesOfShow`, and nothing else.

**The runner** (`runner/`). `step.ts` — the `Step`/`Stage` types, `LockName`, and
`pauseRun`, which throws `RunPaused` to park a run on a decision. `runner.ts` — scheduling,
per-episode serialization, named locks, bounded retry, crash reclaim. `run.ts` — the run
ledger. `gate.ts` — gates, rounds, rulings, routed reject notes. `stages.ts` — the
name→code catalogue; one stage in it (`demo`), and adding one is a code change with a test.

**The record** (`events.ts`). Append-only, enforced by triggers, ordered by a monotonic
`seq` rather than a clock. `EventLog.append` + `subscribe`; `eventsOfRun`,
`transitionsOfRun`, `eventsSince`. The runner writes to it and never reads it back — state
lives in the runner's own tables.

**Models and money** (`llm/`, `cost.ts`). One `LLMAdapter`, two backends (`anthropic.ts`,
`cli.ts`) chosen by `choose.ts`, which also reports whether the choice can actually reach a
model. `fake.ts` is the test path — no test may touch the network. `cost.ts` prices the
**three** input token counts at their three different rates and rolls up to step, run,
episode, and show.

**The fixture** (`fixture/`). `sheet.ts` parses the markdown format, `read.ts` turns sheets
into types **and refuses anything incomplete**, `load.ts` reconciles into the database
through the domain functions above. `read.ts` already parses facts, relations, and
standings and validates them — it just has nowhere to put them yet, which is E2's seam
rather than E2's rewrite.

**The surface** (`app.ts`, `operating.ts`, `app/web/`). Six HTTP endpoints and one unstyled
page. `operating.ts` composes the button sentences server-side where they have tests, and
`POST /api/run` refuses with the same string the disabled button was already showing.

## Constraints E1 leaves behind

Decisions one epic made that bind a later one. Each was correct where it was made and
is a trap somewhere else. They live here because each was first written down only after
a session had already lost time rediscovering it.

### Reserved table names (E1-2, issue #3)

`facts`, `proposals`, `relations`, relation-type declarations, and canon categories are
reserved but unbuilt. E2 fills them and should not need to alter E1's tables.

### `canon_entity` exists, and `registerEntity` is not ratification

E1-2 built a deliberately thin entity table so `artifact_provenance` could carry a real
foreign key from day one — an unenforced provenance reference loads *nothing* into check
scope, and E3 would then report a clean check on an artifact it never checked. E2 grows
that table additively (`ADD COLUMN` for standing, status, prose body, `category_id`)
rather than rebuilding it; SQLite has no `ADD CONSTRAINT`, which is why the key had to
exist up front.

The trap: **`registerEntity` inserts an identity row without going through a proposal.**
Correct for fixtures and tests, wrong for everything else. Invariant 1 names imports and
migrations among the things that must never write canon, and `registerEntity` is exactly
the convenient function an E7 Dead Light import would reach for. E2 owns the rule and
must state it: an entity becomes canon only by ratified proposal; `registerEntity` stays
the low-level insert beneath that flow, never a way around it. **E7's import raises
proposals — it does not bulk-register.**

### Runs are episode-scoped; the ruled design isn't

E1-3 declared `run.episode_id NOT NULL`, and E1-5's `event.episode_id` follows it. But
2.2 scopes a run to "one episode **or season**", 2.1 lists **season review** among the
stages, and 5.7's "pitch a premise against canon" runs checks *pre-episode* — against an
idea with no episode yet. All three want a run with no episode, and today's schema
refuses. Found during E1-5 and deliberately not churned. Whoever needs the first
season-scoped or episode-less run relaxes both columns in one migration, and should check
that nothing has come to rely on the column being non-null.

### Transport retry is not correction retry (E1-6, issue #7)

The Anthropic SDK ships with `maxRetries: 0` so the runner owns one visible retry policy
rather than two nested invisible ones. That is right — but it means a rate limit now
spends the **correction** budget.

Invariant 5 and 4.4 bound the correction loop: re-running a step *because its output was
wrong*, with findings as notes. A 429 is transport — nothing was produced, nothing was
judged, and there is no ruling for Ryan to make. As built, three quick rate limits
exhaust a step and surface in "needs you" as a decision he cannot make, which is noise in
the one place the design insists stays meaningful.

Harmless today, because nothing rate-limits. **Not harmless in E6:** D20 routes every
character shot to a cloud image API, and those rate-limit routinely. When it bites, the
fix is a bounded transport retry in the runner — honoring `retry-after`, counted
separately from the correction budget — not raising the correction bound.

### The fixture's planted defects are E3's test data (E1-7, issue #8)

`fixtures/greyharbor/episode/01-the-long-pier/script.md` carries two defects planted on
purpose — a world-rules violation in scene 4, dual presence across scenes 5 and 6 — and
**says nothing about either inside itself**, because a script that announced its own bugs
would test a checker's reading of a hint. The write-up lives beside it in `episode.md`:
what is wrong, which entities have to be in scope for it to be a violation at all, and
which check should fire. Treat those scenes as fixed points; a tidy-up to the prose is a
silent break of tests that have not been written yet. Rules 2 and 3 of *The hull and the
void* are obeyed everywhere in that script on purpose — they are the cried-wolf control,
and a run reporting them is the measurement E3 wants.

The other half: `app/server/fixture/read.ts` parses the facts, relations and standings off
the sheets and validates them (a character with no species is refused, D22; an undeclared
relation type is refused, D23), and then writes **none of it** — `load.ts` calls
`registerEntity` and stops. E2 grows that into the proposal flow. Whatever E2 or E7 build
on top, the sheets stay drafts until a gate rules on them, which is the same trap as
`registerEntity` above, one level up.

### The adapter tile cannot say "connected" (E1-8, issue #9)

`mockups/floor.html`'s first tile reads **"Claude adapter — Anthropic API · connected"**,
with a green dot. E1-8 built what feeds it — `describeLLMBackend` in `llm/choose.ts`,
served on `/api/health` and `/api/operating` — and it deliberately cannot answer that
question, because nothing can answer it for free.

What it knows is **presence**: an `ANTHROPIC_API_KEY` is set, or a `claude` binary is on
PATH. A key can be revoked and a CLI can be logged out, and the only way to find out is to
spend money. So `ready` means "there is something here to call with", every sentence it
composes says so in those words, and **invariant 4 forbids rendering that as a green
checkmark**. E5 gets to choose the phrasing; it does not get to promise reach it has not
verified. If a live "connected" is genuinely wanted, that is a deliberate cheap call on a
schedule, with a cost row like everything else — a decision for Ryan, not a tile that
quietly implies it.

The same shape holds for the launch button E5 replaces: the sentence and the reason a
button is blocked are composed in `app/server/operating.ts`, where they have tests, and
the API refuses a launch with the *same string* the disabled button was showing. Keep
those two coming out of one composer. The moment they are written twice, a precondition
becomes a failure after the click, which is exactly what D15 forbids.

### The `demo` stage is a drill, and it spends real money (E1-8, issue #9)

`runner/stages.ts` holds one stage, `demo`, which E1 needs so Ryan has something to
operate: one small Opus call, one artifact on the volume, one gate, one ledger row. It is
not a mock and not a test — `npm test` drives it through the fake backend, and the button
on the page drives it through the real one. It stays until E3's real stages give the drill
something better to run on, and whoever removes it should move the kill-and-resume drill in
`README.md` onto whatever replaces it rather than deleting both.

## Working agreements that bind every session

- One issue, one session. Leave the repo green; if unfinished, write `HANDOFF.md`.
- **Fixtures before features** — the Grey Harbor fixture backs all tests. Never burn
  real generation money in a test.
- **The Archon rule** — no workflow DSL, no configurable workflow engine. Stages are
  TypeScript. If you're building a generic workflow system, stop.
- **Only ratification writes canon.** Everything else proposes.

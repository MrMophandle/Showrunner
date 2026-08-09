# Showrunner — the design documents

Start here if you're about to write an epic's issue file, or you need to know what
was ruled and why.

## What's authoritative

| Document | What it is | Authority |
|---|---|---|
| `concept-and-architecture.md` | The ruled design: domain, orchestration, canon, checks, screens, build plan. Decisions **D1–D19** in-section, **D20–D25** in the addendum at the end. | **The source of truth.** Nothing overrides it except a later ruling from Ryan. |
| `D20-image-backends.md` | The image-generation carry-forward from the Dead Light console, in detail — backends, routing, lock semantics, and the operational rules that made it work. | Expands D20. Read before writing E6. |
| `../../docs/canon-schema.md` | **A product deliverable, not a design doc** — the versioned canon schema that ships with the app: the sheet format, category and relation-type declarations, entity anatomy, the fact and proposal lifecycles, and the empty-show story (3.5). Its examples are real files in `../../docs/canon-schema-example/`, and `app/server/fixture/schema-doc.test.ts` pins them, the vocabularies, and the version. | Authoritative on the **pack format** for outside readers. `app/server/fixture/read.ts` outranks it on any disagreement, and the test is what makes that disagreement fail loudly. |
| `E1-spine-issues.md` | The E1 issue file, as originally drafted. | **Superseded** — the GitHub issues are authoritative (see below). |
| `../../CLAUDE.md` | The standing brief — invariants, domain nouns, Archon rule, conventions, commands. Written by E1-0 (issue #1). | **Binding on every session.** The `handoff/CLAUDE.md` draft is retired and now just points here. |
| `../../mockups/` | Eight approved screen mockups + their README. | Approved. E5 builds to them. |

**Rulings after the export live in the addendum**, not in the sections they amend.
The sections carry `→ Amended by D…` pointers where a ruling changed them — follow
them. The addendum holds six rulings — five from the mockup review, one from filing E2:

- **D20** image generation: three backends routed per shot; `gpu` covers local image
  gen *and* TTS; hand-made assets always win; retries bounded at 2.
- **D21** review-desk reject is routed, not rewound.
- **D22** every character declares a species (required typed relation).
- **D23** relation types are declared per category, with inverses.
- **D24** arcs get their own page — the screen set is eight, not seven.
- **D25** canon is founded by proposals, never imported — no bulk-write path for
  fixtures, E7's migration, or E8's onboarding; loaders raise promotion proposals
  and the real ruling API ratifies them.

## Where the issues live

GitHub Issues on `MrMophandle/Showrunner`, one milestone per epic (D18).

**E1 · The spine is done** — issues #1–#9, all closed, and the epic exit was operated by
Ryan on Aug 5 2026 rather than merely tested (see the drill in the root `README.md`). It is
the worked example of the issue format; read the closed issues, not `E1-spine-issues.md`,
which was superseded when six of the nine were amended to absorb D20–D24.

**E2 · Canon is done** — issues #23–#29 merged, and the exit operated by Ryan on
Aug 7 2026: Grey Harbor founded from the bench, entities promoted and created by
ruling, a ratified fact changed by a second proposal, canon-as-of flipped across his
own ruling. Two deliberate loose ends stand as live test data: Sefa Doule remains a
real candidate (E5's "visibly unofficial" rendering) and Ottilie Bray has no facts
(issue #39).

**E3 · Checks is filed and in progress** — issues #40–#47 plus #39 under the
"E3 · Checks" milestone, sequenced E3-0 → E3-1 → E3-2 → E3-3 → {E3-4, E3-5} → E3-6 →
#39 → E3-7, ending with the check bench and the planted defects of ep01 finally
earning their keep. There is **no intermediate markdown file** for any epic — see
step 5 of the procedure below.

## Writing an epic's issue file

Per 6.3, issue files are written **epic-by-epic, just before the epic starts** —
not all up front. E3's are filed; E4's turn comes when E3's exit is operated.

1. **Read the whole concept doc, addendum included.** Then re-read the sections that
   epic owns (E2 → Section 3; E3 → Section 4; E4 → 1.1 + 4; E5 → Section 5 + the
   mockups; E6 → Section 5.5/5.6 + `D20-image-backends.md`).
2. **Check §6.2 for that epic's `→ Scope grew` note.** E2, E5, and E6 all gained
   scope after the original export.
3. **Read both "What … built" maps and both "Constraints … leaves behind" sections
   below.** The first tells you which module a new issue extends rather than rebuilds; the
   others are the things one epic decided that bind a later one, and every session that
   skipped them lost time rediscovering the reasoning.
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
5. **File straight to GitHub — there is no intermediate markdown file.** (Ruled while
   filing E2: E1's file went stale the moment its issues were amended and is kept only
   as provenance.) Create the epic's milestone first (D18); put the **epic exit and the
   sequence in the milestone description**; repeat the sequence as a footer in the last
   issue. Show Ryan the draft set *before* filing — the review happens in conversation,
   and the filed issues are the only copy.
6. **State the epic exit** in the milestone: the thing *Ryan operates*, not reads about.
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
through the domain functions above. *(E2-4 grew `load.ts` into the proposal flow: it now
declares the categories straight and raises a promotion proposal per entity sheet;
`founded.ts` is the "Grey Harbor, founded" helper every later epic's tests should use.)*

**The surface** (`app.ts`, `operating.ts`, `app/web/`). Six HTTP endpoints and one unstyled
page. `operating.ts` composes the button sentences server-side where they have tests, and
`POST /api/run` refuses with the same string the disabled button was already showing.

## What E2 built, and where

Same purpose as E1's map above: which module an E3+ issue extends rather than rebuilds.
Everything below is tested and was operated at the E2 exit.

**The clock and the ledger** (`0007`, grown by `0008`). `canon_ruling` is the monotonic
clock canon is read by AND the disposition ledger every ruling lands on — ratifications,
rejections, deferrals, all kept forever, one row per ruling. Grow it by ADD COLUMN;
never a sibling. Rulings with no gate never reach the event log (`event.run_id` is NOT
NULL) — the ledger is their record, by ruling.

**Facts and time** (`domain/fact.ts`). Immutable rows + closure rows; supersession
closes predecessor and opens successor at one ruling; `canonAsOf` by ruling seq with
dates mapped on. `factsInScope` is what checks read (invariant 2): own facts + declared
inheritance (`relation_type.inherits_facts`, one-way) − overridden, and it refuses to
collapse the **three kinds of nothing** (no species row / declared-`unknown` NULL
target / species with no facts). `Override.stale` says the ground moved under an
exception — **built for E3 to surface**.

**The graph** (`0006`; `domain/category.ts`, `relation.ts`, `canon.ts`). Categories as
data including per-category `check_instructions` — the generic checker is parameterized,
never hardcoded. Relations typed, declared, inverse-navigable; `unknown` is a NULL
target; `required` enforced at ratification only.

**Change** (`domain/proposal.ts`, `episode-canon.ts`, `founding.ts`). Five-part
proposals (fact delta / relation delta / promotion carrying the full sheet); ONE ruling
API convened by any surface, no run/gate/episode precondition; blast radius computed at
read time. The episode flows all *raise*: `sweepEpisode` (a read — E4's approval gate
calls it), `abandonEpisode` (auto-defers riders, raises one revert proposal per fact),
`landPosition` (wraps `declarePosition`, needs a subject entity — E4's writer supplies
it). `foundCanon` rules loader-origin promotions only, one ruling each.

**Surfaces** (`canon-bench.ts` behind `/api/canon/:showId`; `docs/canon-schema.md`).
The bench renders rulings from the ledger, not events (ruled). The schema doc's examples
are drift-proofed by tests — its example pack parses, founds, and pins the vocabularies
the app enforces.

## What E3 built, and where

Same purpose again: which module an E4+ issue extends rather than rebuilds. Everything
below is tested, and the exit was operated on real money (Aug 9: $1.32 against ~$1.60
projected, failed calls priced honestly).

**Findings, passes, and the third thing** (`0010`, `0012`; `domain/finding.ts`). A
finding is a record, never state — status derives from its disposition, and
`recordCheckPass` is the only write path, so a zero-findings reading leaves its row
(D11's denominator). `check_pass_fact` records what a pass was handed — "loaded and not
cited" is how a silence becomes a measurement. `check_gap` is the third thing a check
can say: could-not-look, neither silence nor finding, kept out of both. `cleared` was
ruled OUT as a disposition and the header says why; `FINDING_DISPOSITION` is
`['dismissed']`.

**The deterministic tier** (`0011`; `domain/board.ts`, `board-rules.ts`,
`runner/board-step.ts`). Extraction is one paid reading of the whole script; the rules
then read rows for free, answer `certain`, and are the only findings allowed to block
anything (D12).

**The generic checker** (`domain/text-check.ts`, `runner/text-check-step.ts`).
Parameterized by `canon_category.check_instructions` — category checks, waypoint-drift
checks (D8), and craft reviewers all flow through one `CheckSubject` composer and one
parser. Nothing trusts the model: quotes must resolve to real spans, cited facts must be
in scope, and a reply nobody can parse **fails the step** — it is never a clean pass.
The tier is retry-atomic, deliberately: there is no half a verdict board
(`text-check-step.ts`'s header carries the argument and its price).

**Panels** (`domain/panel.ts`). The roster is decided by declarations (3.2) plus
story-craft as mandatory equipment nobody can configure away (D13). Findings cluster by
span *overlap* within a scene, never by exact quote match. The verdict board is a READ —
`partial`, `stale`, and `unread` are verdicts precisely so a narrow or outdated reading
never renders as a clean one.

**The correction loop** (`runner/correction-loop.ts`). Produce → check, three drafts,
every attempt kept, then Ryan — non-convergence is his turn, not a failure. Transport
retry and correction retry are different counters, never merged. The gate payload
carries the loop history and the gaps.

**The wall** (`runner/stage-wall.ts`; `runner/gate.ts` → `overriddenVersions`).
Computed, never stored: open deterministic findings at the artifact's current version,
minus what Ryan's rulings reach. An override is version-scoped (it does not survive a
rewrite); a standing dismissal is concern-scoped and reaches byte-identical twins
(`domain/concern.ts`). Stages declare their spend and their work
(`Stage.offerOn` → sentence, cost, `callsModel`, `reads`/`produces`) — the adapter
refuses only spenders, the wall stands only before producers, and no stage name appears
in any refusal.

**Remediations** (`remediation.ts`). The three buttons behind a finding: pre-draft +
apply (the apply is ONE motion — revise, then the free tier re-reads before it
returns), propose-the-canon-change (raises, never rules), dismiss-with-note. The
scene-scoped re-check narrows to the touched scene (D14) against spans resolved over
every scene. The context reader feeds dismissal notes into later runs' prompts (4.4) —
one record, many readers; E4's writer calls the same reader.

**Cried-wolf** (`domain/concern.ts` + the record on the bench). Identity is byte-exact
(check + artifact + scene + span + entity + cited facts + words). The ratio counts ruled
concerns over readings; abstentions sit in neither side; the tune sentence asks and
nothing ever acts on it.

**Surfaces** (`check-bench.ts` behind `/api/checks/:episodeId`; `script-gate`;
`POST /api/gate/:id/override`; the bench's add-a-fact route from #39). The bench renders
every record kind above, unstyled — E5 restyles, it does not re-derive.

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

## Constraints E2 leaves behind

The same thing one epic down: decisions E2 made that are correct where they were made and
are a trap somewhere else. E1's list above is the sibling, and it is the model — each of
these is written here because the alternative is a later session rediscovering it.

### A waypoint landing needs a subject entity (E2-3, issue #26)

D8 says landing a waypoint becomes a fact through the proposal flow, and E2-3 built that:
`landPosition` in `domain/episode-canon.ts` declares the position and raises the landing
proposal beside it. But a fact is about an **entity**, and `proposal.entity_id` is
`NOT NULL` — while `arc` carries no entity link at all, because an arc is a shape a season
makes rather than a claim about one character.

So the caller supplies it: `landPosition({ …, subject })`, the canon entity the landing
reads on. **This lands on E4's writer step**, which is what will call `landPosition` when a
run declares an episode's position — it has to answer "which character or place is this
landing a claim about", and there is no default the schema can supply. For a character arc
it is the character; for a story arc it is whatever the arc is actually about, and that is
a writing judgement, not a lookup.

Two roads were not taken, and knowing why saves re-opening them. Making `entity_id`
nullable would have broken the one thing that makes blast radius answerable in a single
query — every proposal has a subject. Putting a subject entity on `arc` would have forced
one answer per arc at creation time, before anybody knows which of a story arc's several
subjects an individual episode's landing reads on.

### `sweepEpisode` is a read, and E4's approval gate is what calls it (E2-3, issue #26)

The completion sweep collects every proposal still riding an episode into one final ruling
pass (1.2). E2-3 built the collection and **deliberately built nothing that triggers it** —
nothing in this app advances an episode's lifecycle yet, and inventing approval mechanics to
exercise a sweep would have been E4's design made by the wrong epic. So `sweepEpisode` is a
callable flow with a named seam, exactly as `pauseRun` was the seam E1-4 hung its gates off.

**E4 wires it:** the final approval gate calls `sweepEpisode(store, episodeId)`, renders
each `outstanding` proposal with its own `blastRadius`, and convenes E2-2's
`createProposalRulings` on them **one at a time** — one artifact, one ruling. It rules none
of them itself, and no bulk-approve belongs on that gate.

The sweep collects **existing** proposals only. Extracting the implicit facts out of written
prose is LLM work and is E3/E4's: those extractors raise proposals riding the episode, and
this sweep collects them without a line changing here. That is the whole reason it was built
as a collector rather than as something that also generates.

### A `candidate` sheet raises nothing, and re-loading is not a sync (E2-4, issue #27)

Two rulings E2-4 made that later loaders inherit, both about the same seam.

**A sheet whose `status` is `candidate` registers its identity and raises no promotion.**
The alternative — raise it, and have founding leave it unruled — needs founding to know
which promotions are "really" founding documents, and the only ways to tell it are a new
column or a loader-shaped `foundCanon`. Neither is worth it: `registerEntity` already
produces exactly a candidate, so the sheet and the row agree with no mechanism at all.
Promoting one later is the ordinary API, and `promotionFromSheet` (exported from
`fixture/load.ts`) builds the identical draft, so **E2-6's bench can offer "promote from
the sheet" without a second payload builder**. Grey Harbor carries one: Sefa Doule.

**Re-loading never raises delta proposals.** After founding, canon lives in the database
and moves by proposals; the sheets are provenance. A sheet edited afterwards diverges
silently and that is correct. **E7's Dead Light import is where a diffing loader belongs**
— it is a real design (what is a change vs. a new sheet, what supersedes what, who is the
subject of each delta) and it was deliberately not smuggled in here as "idempotency".

`foundCanon` is `domain/founding.ts`, not the fixture's: it rules `loader`- and
`import`-raised promotions (`FOUNDING_ORIGIN`) through `createProposalRulings`, one at a
time, in one transaction. A writer's pre-episode promotion (5.7) rides nothing either and
is deliberately out of its reach.

### The fixture's arc position still raises no landing (E2-4, issue #27)

`load.ts` calls `declarePosition` directly, not `landPosition` — so ep01 @ waypoint 2 is a
pin with no landing proposal behind it, and the two module headers that said "E2-4 changes
that" now say why it did not. A landing is a fact, a fact is about an **entity**, and the
arc sheet carries no subject (the E2-3 constraint above). Supplying one from a loader would
put a claim in the fixture nobody decided. **E4's writer step answers it**; if the fixture
should carry a landing before then, the honest change is a `subject` field on the arc sheet
and a `read.ts` that requires it.

## Constraints E3 leaves behind

Decisions E3 made that are correct where they were made and a trap somewhere else —
the same list one epic further on.

### Every new artifact version must be read before the wall can trust it (E3-5, #45)

The D12 wall counts deterministic findings at the artifact's **current** version, and
the reason a rewrite can't clear it by merely landing is that `remediation.ts`'s apply
is one motion: revise, then the free tier re-reads, *then* return — `check_pass` at the
new version is the receipt. **E4 builds direct editing and a writer that produces
scripts**; any new path that writes an artifact version must go through that same
motion (or its equivalent), because a version nobody has read looks identical to a
version read clean, and the wall cannot tell the difference from findings alone. The
three-kinds-of-nothing rule, at the artifact layer.

### The check tier is retry-atomic, and the loop's resume depends on it (E3-2/E3-4, #44)

The correction loop decides "has this draft been read" by "a pass exists at this
version" (`correction-loop.ts`). That predicate is honest ONLY because the tier records
all-or-nothing — `text-check-step.ts`'s header carries the full argument and the price
(ten reviewers, one garbage reply, three attempts = thirty calls, per round). An E4
stage that composes produce → check inherits both: do not split the panel into steps,
and do not make the loop smarter about partial passes — either move re-opens a resumed
loop skipping a panel three reviewers never finished.

### An override and a dismissal are different verbs at every layer (E3-3/E3-6)

An override is Ryan's opinion of **one draft** (version-scoped; the wall comes back at
v+1). A dismissal is his opinion of **one concern** (identity-scoped; it reaches
byte-identical twins forever). The E3 drill operated both on the same findings. Any E4+
surface that renders them as one "approve anyway" button, or any query that counts them
interchangeably outside cried-wolf's explicit both-count rule, breaks a distinction two
separate rulings created on purpose.

### `script-gate` exists for the override door, and E4 decides its fate (E3-7, #47)

The override verb needs an open gate on the artifact the finding stands in, and until
E3-7 nothing ever opened a gate over a script — so `script-gate` is a zero-spend,
never-walled stage whose whole job is convening Ryan. **E4's real writing gates
supersede the need.** When outline/script gates exist, decide deliberately: retire
`script-gate`, or keep it as the re-present-for-ruling affordance. Leaving it
unexamined means two gates over one artifact with different payloads.

### New stages declare, refusals consult (E3-7, #47)

`Stage.offerOn` is the single source of the button sentence, the cost, `callsModel`,
and `reads`/`produces`. Every stage E4 adds must declare all four; nothing may
special-case a stage name in `launchBlockedBecause` or anywhere else. The board-step
header's "Nothing to call" defect was exactly the cost of one stage that broke the
assumption behind a global refusal — the declaration exists so the next new stage
cannot repeat it.

## Working agreements that bind every session

- One issue, one session. Leave the repo green; if unfinished, write `HANDOFF.md`.
- **Fixtures before features** — the Grey Harbor fixture backs all tests. Never burn
  real generation money in a test.
- **The Archon rule** — no workflow DSL, no configurable workflow engine. Stages are
  TypeScript. If you're building a generic workflow system, stop.
- **Only ratification writes canon.** Everything else proposes.

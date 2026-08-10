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
name→code catalogue, and adding one is a code change with a test. *(E1's one stage, `demo`,
was retired by E4-1; the catalogue and everything around it is unchanged.)*

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

## What E4 built, and where

Same purpose again: which module an E5+ issue extends rather than rebuilds. Everything below is
tested on fakes with no key in the environment. **The exit is the drill in `README.md`, and it
has not been operated yet** — issue #76, which stood between Ryan's library and its writing
line, is closed (the entry below says how), so the drill runs end to end.

**The writer's desk** (`domain/write-context.ts`). One composer, three steps, and the only door
onto canon a writing step has. Canon as **this episode's audience** knows it — a lineage
question, never a clock question — with every inclusion carrying the door it came through, every
entity left OUT carrying the rule that kept it there, every fact carrying its reach, and Ryan's
notes arriving in one stream with three origins on them. Computed, never remembered; there is no
`write_context` table and there must never be one.

**The three writing stages** (`runner/write-step.ts`). `writingStage` builds each one with the
correction loop, the panel, the gate and the lifecycle seam already on it, so a fourth cannot be
assembled without them. `WRITING` holds what each step is asked for and what one call of it is
projected to cost, keyed by step because the steps are not the same size. Provenance runs
backwards for a producer: it declares what it WROTE, through the desk's own matcher.

**The lifecycle seam** (`domain/lifecycle.ts`). Lifecycle names the stage an episode is AT, and
a stage's **gate approving** is the only thing that moves it — four rules, tested one apiece.
`notYetReachedBecause` is the same function read backwards, and it is how a writing stage asks
"was the upstream ruled" without growing a second opinion of "approved".

**Scenes, derived** (`domain/delineate.ts`, `spine.ts`'s `delineateScenes`, migration `0013`). A
scene IS its heading; re-delineating matches by heading and by nothing else, so insertion is
safe and a rename degrades its findings to the whole artifact. One delineator, two callers, and
the fixture is its proof. `num_scenes` is an output of the written script and there is no column
for it.

**What writing does to canon** (`claim.ts`, `runner/claim-step.ts`). One paid reading of the
draft Ryan APPROVED, after the gate and inside the run, raising fact deltas and one landing per
declared arc position — with the subject only a writer can answer for. Four laws, one
`claimScope` read by both the prompt and the parser, and a malformed reply fails the step
because a zero-claims pass is a real answer.

**Ryan's hand** (`edit.ts`, `domain/routing.ts`, migration `0014`). An edit lands verbatim as a
new version through E3-5's one motion, declares provenance out of the whole show, moves no
lifecycle and buys no extraction. A rejection note picks its depth, resolves its address once at
the ruling, and "addressed" is derived from a version comparison — nothing is ever written back
to a note.

**The completion sweep** (`sweep.ts`). A ruling pass an approved episode OWES, computed from the
queue, reached from the episode, ruled one rider at a time through the one ruling API. No
`swept_at`, no sweep table, no bulk verb, and no route for one.

**Surfaces** (`writing-room.ts` behind `/api/writing/:episodeId`; `app/web/WritingRoom.tsx`).
The room renders every record kind above, unstyled, and composes none of them: the offers are
the stages', the gates are `operating.ts`'s, the riders are the sweep's, the pin is the canon
bench's, the clusters are `panel.ts`'s. The one new render is the desk inspector. **E5 restyles;
it does not re-derive, and it does not get to drop a door and leave the sentence that names it.**

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

### The `demo` stage is a drill, and it spends real money (E1-8, issue #9) — **retired in E4-1**

`runner/stages.ts` held one stage, `demo`, which E1 needed so Ryan had something to
operate: one small Opus call, one artifact on the volume, one gate, one ledger row. It was
not a mock and not a test — `npm test` drove it through the fake backend, and the button on
the page drove it through the real one.

**E4-1 (#61) retired it**, because a real premise writer beside a placeholder one makes every
"which button?" question ambiguous. What that means, and what it does not:

- It is out of the catalogue and out of every offer. Nothing anywhere may bring it back for
  a test's convenience — a stage that exists only so tests have something cheap to run is a
  lie in the catalogue, and the E1-era tests that leaned on it now run the premise stage
  through the fake adapter (`runner/write-step.test.ts`, `runner/stages.test.ts`).
- **Its rows are records and they stay.** Demo runs, steps, gates, rulings, cost entries and
  the premise-brief it wrote into slot `demo` all still render; `runner/stages.test.ts` holds
  that, gate buttons included.
- The drill moved with it: the E3 drill in the root `README.md` now reads the ep01 card's
  refusal as the premise stage's own sentence.

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

*Wired by E4-4 (#64).* `landPosition`'s first caller outside a test is the script's fact
extraction: the same paid call that reads the draft's claims answers, per declared position,
which entity the landing reads on — and the answer is refused unless it is in the script's
provenance, exactly like a claim's subject. The subject was never a lookup and it is not one
now; it is a sentence in a prompt that says so.

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

*Half paid by E4-4 (#64): the extractor exists (`claim.ts`, `runner/claim-step.ts`) and the
sweep collects what it raises with not a line changed, exactly as predicted.*

***Paid in full by E4-6 (#66) — and the first clause above turned out to be unbuildable as
written.*** E4-4 put the extraction on the FAR SIDE of the script gate (it reads the draft Ryan
approved), so at the moment that gate renders, the riders extraction will raise **do not exist
yet**. A sweep convened from inside it would present an empty pass and then have nothing to say
about the stack that lands a second later. The reconciliation, argued at length in `sweep.ts`'s
header and tested rather than asserted: **the sweep is the pass that stands OWED once the script
is approved and the extraction has landed**, surfaced from the EPISODE rather than from a gate,
and "episode approval" in 1.2's sense is complete when the pass is. Everything else in the
paragraph is kept literally — each rider with its own `blastRadius`, ruled one at a time through
`createProposalRulings`, no bulk approve anywhere, and the collector still collects only.

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

*Answered by E4-4 (#64), and ep01's pin is still a pin: the extraction step answers the subject
per declared position, out of the written script, and the loader was not touched. Nothing
materialises a landing for ep01 retroactively — this ruling stands.*

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

*Paid by E4-5 (#65), and by ONE FUNCTION rather than an equivalent.* The motion is
`landNewVersion` (still `remediation.ts`), and it has two callers: the pre-drafted rewrite
behind a finding, and Ryan's direct edit (`edit.ts`). An equivalent was the other road and it
is only equivalent until somebody changes one of them. **Any third path — E7's import — calls
it too.**

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

### `script-gate` exists for the override door, and E4 decides its fate (E3-7, #47) — **decided in E4-3**

The override verb needs an open gate on the artifact the finding stands in, and until
E3-7 nothing ever opened a gate over a script — so `script-gate` is a zero-spend,
never-walled stage whose whole job is convening Ryan. **E4's real writing gates
supersede the need.** When outline/script gates exist, decide deliberately: retire
`script-gate`, or keep it as the re-present-for-ruling affordance. Leaving it
unexamined means two gates over one artifact with different payloads.

*E4-1 looked and left it standing, deliberately: the gate it convenes is over the SCRIPT, and
the only writing gate this build has is over the premise-brief — so there are not yet two
gates over one artifact.*

**E4-3 (#63) made the call: generalized, not retired** — `runner/present-step.ts`, one
presenting stage per written kind (`premise-gate`, `outline-gate`, `script-gate`). Retiring it
would have turned two sentences this app already says into lies: a writing stage refuses an
episode that already has its artifact with "rule on it at its gate, or edit it directly", and a
writing gate exists only while its run does — so a script the fixture wrote by hand, an E7
import, or a re-ruling after a rewrite would have had no gate to be ruled at, and ep01's
override door (the one the E3 drill operates) would have closed. `script-gate` keeps E3-7's
name because rows are records and there are runs under it; renaming it would retire a stage
still parked on a decision.

Two gates over one artifact are prevented by two different things, and both are load-bearing.
**Never at once**: a gate belongs to a STEP, and D7's one-run-per-episode refuses every stage
while a run is queued, running or paused — asserted in both directions in
`present-step.test.ts`. **Never two screens**: both doors compose the payload from one
function, `draftsUnderReview` (`correction-loop.ts`), so what Ryan is handed over one artifact
does not depend on which door he came in by. Only the *sentence* differs, because only the
sentence is about why that particular gate opened.

### New stages declare, refusals consult (E3-7, #47)

`Stage.offerOn` is the single source of the button sentence, the cost, `callsModel`,
and `reads`/`produces`. Every stage E4 adds must declare all four; nothing may
special-case a stage name in `launchBlockedBecause` or anywhere else. The board-step
header's "Nothing to call" defect was exactly the cost of one stage that broke the
assumption behind a global refusal — the declaration exists so the next new stage
cannot repeat it.

## Constraints E4 leaves behind

Written as E4's issues land, for the same reason as every list above. The first four are
E4-1's (#61) and the first three bound E4-2 directly; the three after them are E4-2's (#62)
and bound E4-3; then three of E4-3's (#63), and the scene rules among them bind E4-5's
direct editor and E6's shot manifest before anything else touches a scene. Then three of
E4-4's (#64), the first of which bound E4-6 directly; four of E4-5's (#65), of which the first
two bound E4-6 and the third binds E6's review desk — then three of E4-6's (#66), which close
the epic's canon side and bind E5's episode room and E6's watch-through. **The last four are
E4-7's (#67), the issue that closes the epic**, and they bind E5 hardest of all: E5 rebuilds
every surface in this list to the mockups, and three of the four are about what it may not drop
on the way.

### One seam moves an episode's lifecycle, and the builder is what makes it a seam (E4-1, #61)

`domain/lifecycle.ts` owns the ruling: **lifecycle names the stage the episode is AT**, so
ep02 at `premise` is premise work *not yet done*, and it is a stage's **gate approving** that
moves it on — never a producer writing, never a check reading. Four rules fall out and are
tested one apiece: forward only, idempotent, the last stop stays put, and **an abandoned
episode keeps the stage it reached** (`abandoned_at` is a column beside the enum, never a
member of it).

The part that is easy to lose: it is not a function later stages must *remember* to call.
`runner/write-step.ts`'s `writingStage` builds every writing stage with the closing step
already on it, so E4-2's outline and E4-3's script get it by construction. If a stage is ever
assembled by hand instead, that property is gone the same day.

### A writer declares provenance out of what it WROTE (E4-1, #61)

Invariant 2 runs backwards for a producer: there is no upstream declaration to read, because
this is the step that writes one. The premise stage matches its own draft against the entities
the desk handed it, through the desk's own matcher (`nameAppearingIn`, exported from
`write-context.ts` for exactly this), and declares what it names.

Two consequences E4-2/E4-3 inherit rather than re-decide. **The convened panel is a
consequence of the draft**, not a constant: a brief about Ilse convenes the `character` check
and nothing else, even though five of the fixture's categories declare `premise-brief` in
their `applies to` — a category with no entity in provenance correctly stays home (4.1). And
**an entity the writer was never handed can never enter provenance**, because a check would
then be reading canon the writer never saw.

### The premise stage cannot be walled, and D12's button lost its demonstration (E4-1, #61)

`demo` was the only stage declaring `work: 'produces'`, and it could be run on any episode
forever, so the D12 wall's "a producing stage is refused with this exact sentence" was
demonstrable on ep01 in the drill. The premise stage cannot be: it is the FIRST artifact an
episode has, so an episode with material standing against it always has a premise-brief
already — and `launchBlockedBecause` answers "nothing to do" ahead of the wall, correctly (a
stage with nothing to do has nothing to be blocked from doing).

So the wall's button-side proof is now on a **planted** episode (`operating.test.ts`:
ep02 with material and no brief), and the drill reads the wall off the check bench instead.
**E4-2's outline stage is the first real one the wall can stand in front of** — give it the
demonstration back there, on ep01, where the fixture's planted contradictions already live.

*Done by E4-2 (#62), on **ep02** rather than ep01: ep01 already has an outline, so "there is
already one of those" answers ahead of the wall there, exactly as "nothing to do" did for the
premise. `outline-stage.test.ts` stands the wall up with a real `retired-reappearance` finding
on ep02's ruled brief and brings it down again with a dismissal.*

### A run of a retired stage holds its episode forever (E4-1, #61)

`advance` (runner.ts) skips a run whose stage this build has no code for — "a click Ryan
already made is not something a deploy gets to throw away" — and that run then stays `queued`
forever. D7's one-run-per-episode refuses every other stage on that episode with "rule on it,
or let it finish", and neither is possible once the code is gone.

Not new to E4-1: it has been true of any retired stage since E1-3, and E4-1 is simply the
first time a stage was retired. Not fixed here either, because the fix is an **affordance for
putting a run down** — a verb, a row, and a sentence — and that is a decision about what Ryan
may do to a run, not a change to a refusal. `runner/stages.test.ts` pins the behaviour so the
day it bites, the test says what is happening.

### The lifecycle column is how a writing stage asks "was the upstream ruled" (E4-2, #62)

`notYetReachedBecause` (domain/lifecycle.ts) is `advanceOnApproval` read backwards, and
`writingStage` puts it on every writing stage the way it already puts the advance on every
one. So E4-3's script stage inherits "ep02 is at outline and has not reached script yet"
without writing a line, and **must not grow a second opinion of "approved"** — not a gate
query, not a `ruled_at` column, not a check of its own. A stage asking about a gate would be
asking about one that may have been rejected, deferred, re-opened or never built; the column
is the one place an approval is recorded as having happened.

It refuses only NOT-YET-REACHED, never past. An episode that ran ahead and left a gap is a gap
worth filling, and "there is already one of those" is the artifact's question with the
artifact's sentence. The two are asked in that order, and `outline-stage.test.ts` pins which.

### An outline is intent, and E4-3 is where that gets spent or wasted (E4-2, #62)

Nothing E4-2 writes prescribes a scene: no `scenes` field, no scene row, no count, and — the
part that is easy to lose — **nothing parses the draft at all**, so no grid can arrive
inferred either. The ask itself carries the prohibition WITH ITS REASON, because a model told
only "no numbers" writes the same grid with dashes.

The whole point of that restraint is E4-3's to collect: **the script writer reads the outline
as intent and the scenes fall where the story breaks** (1.1, D3). A script step that read the
outline's movements as a scene list would have spent this issue's discipline on nothing, and
it would do it silently — `num_scenes` would simply come out equal to the number of headings
and look like a coincidence. `outline-stage.test.ts`'s zero-scene-rows test is the assertion
that fails on the outline side; E4-3 owes the one that fails on the script side.

*Paid by E4-3: the ask states the count is the writer's and refuses the pairing-off in as many
words ("do not pair its movements off against scenes"), and `script-stage.test.ts` reads the
captured prompt for both. The fixture's own outline has three movements and the test's draft
has three scenes; the assertion that keeps that a coincidence rather than a mechanism is that
nothing anywhere reads the outline's headings — the desk hands it over whole, as prose.*

### E4-2 shipped a stage the floor cannot click, on purpose (E4-2, #62) — **closed in E4-3**

`operatingView` still offers ONE stage per episode and it is still the premise (operating.ts).
Pointing it at "the stage this episode's lifecycle is at" needs a map with no hole in it, and
there is a hole until E4-3's script stage exists — ep01 sits at `script`. So `write-the-outline`
is reachable by name through `POST /api/run` (which is how E4-2's boot proof exercised it) and
by nothing on a screen. **E4-3 completes the map and E5 owns the card**; whoever closes it
should do it once, for all three stages, rather than special-casing two.

*Closed by E4-3 in `stageForEpisode` (operating.ts): `WRITING_STAGE` maps premise → outline →
script onto the three writing stages, once, and the card offers the stage its episode's
lifecycle names. **Past the writing line the map is deliberately partial** — `assets`,
`assembled` and `published` are E6's and E7's, and a map that pretended to cover them would be
a button promising work no code does. An episode past `script` is offered the script presented
for a ruling instead: free, never walled, and the one thing this build can still honestly do
with it. E6 replaces that tail by adding its stages to the map.*

### A scene is its heading, and that is now load-bearing everywhere (E4-3, #63)

E4-3 had to decide how a scene survives a whole-script rewrite, and ruled it in one sentence:
**re-delineating matches a new draft's scenes to the standing rows by heading and by nothing
else.** A heading still there is the same scene wherever it has moved to; a heading gone takes
its scene with it; a heading that is new is a new scene. The argument lives in
`domain/delineate.ts`, the write in `delineateScenes` (spine.ts), and the three edges have a
test apiece (`spine.test.ts`) plus an end-to-end one (`script-stage.test.ts`).

The decisive edge is **insertion**, not renaming: under the ordinal identity this replaced,
a scene added in the middle moved every anchor after it up by one, silently. Identity therefore
cannot be the ordinal, and the ordinal is recomputed from the draft every time.

Three things fall out that a later epic inherits rather than re-decides:

- **Two scenes may not share a heading**, and `delineateScenes` refuses it in words. It is an
  ambiguity, not a duplicate: `sceneSpans` locates a scene by looking its heading up in the
  text, so two the same makes every span after the first wrong — including the ones an anchor
  was verified against. The script ask says so to the writer as well.
- **A rename degrades its findings to the whole artifact**, which is what 0010's
  `ON DELETE SET NULL` was designed for. It had never been reachable: SQLite runs SET NULL as
  an UPDATE and 0010's own immutability trigger aborted it. **Migration 0013** narrows that
  trigger to permit exactly that one update — an anchor may lose its scene and may never be
  moved to a different one — and nothing else about a finding moved.
- **`releaseScene` (artifact.ts) is what the artifact tables do about it**, because
  `artifact_revision` and `artifact_input` both index over `COALESCE(scene_id, '')` and two rows
  degrading together would collide. A revision is a record and merges; an input edge is a
  per-scene reading and goes, which is 0011's ruling for `board_scene` about the same fact.

### One delineator, two callers, and the fixture is its proof (E4-3, #63)

`delineateScript` (`domain/delineate.ts`) is the only thing in this app that reads scenes out of
a script. The fixture's loader goes through it (`fixture/read.ts`) and so does every landed
draft, because "the fixture's scenes" and "a draft's scenes" being two readings of one
convention is the second-parser failure at the scene layer. The proof is not a comment:
`delineate.test.ts` delineates `fixtures/greyharbor/episode/01-the-long-pier/script.md` and
gets back the rows `fixture:load` plants, ids included.

**The fixture's script is a fixed point** (the E1 ledger, still): scene 4 is the world-rules
violation and 5–6 are the dual presence. A delineator that wants that file changed is the
delineator that is wrong.

### Delineation runs per landed draft, and E4-5's editor inherits that (E4-3, #63)

Scenes are derived inside the correction loop, by the producer, **before that round's checks
read a word** — findings anchor by scene, so a panel reading a fresh draft against the last
draft's grid would anchor everything in the wrong place. It also runs BEFORE the bytes land, so
a draft whose scenes cannot be read out of it fails without a file and the runner's retry buys
a NEW draft rather than re-reading the broken one three times.

**Any later path that writes a script version owes the same two motions** — E4-5's direct edit
and E7's import both. It is the artifact-layer sibling of E3-5's rule that every new version
must be read before the wall can trust it: a version delineated against the previous draft's
headings is a grid nobody derived, and nothing downstream can tell it from one that was.

*Paid by E4-5 (#65), for the edit AND for the rewrite.* Both motions moved inside
`landNewVersion`, so the obligation is discharged by construction rather than by remembering:
delineate before the bytes land, then revise, delineate and re-read in one transaction. It
also closed a hole nobody had noticed — E3-5's span rewrite could replace a HEADING and leave
a scene row whose heading is not in the draft, which is the row `domain/delineate.ts` says
cannot locate itself. `remediation.test.ts` now watches that scene go.

### A paid step past the gate is money the launch button already promised (E4-4, #64)

The script stage has three steps since E4-4, and the third runs on the far side of Ryan's
ruling: `extract-the-canon-claims` reads the draft he APPROVED and raises what it claimed.
Three placements, each a decision, and `runner/claim-step.ts` carries the argument —
**after the gate** so it reads the draft that was kept rather than a round the loop replaced;
**inside the run** so the launch click already made is the click that pays for it (E1's
pattern: the gate parks the run and the approval carries it on); **before the close** so the
closing step's `costOfRun` covers what it spent.

Two things fall out that a later stage inherits rather than re-decides.

**The offer's `cost` must cover the whole run, not the part before the gate.** One click buys
every step, so a spend that lands after a ruling is still one Ryan agreed to, and a cost line
that stopped at the gate would be a button that lies cheaply. `offerFor` states it as its own
clause. **Any stage that grows a step past its gate owes the same clause.**

**A failed extraction leaves the episode where it stood, with the gate approved.** The run
fails after three attempts and `advance-past-the-script-gate` never runs, so ep02 stays at
`script` and Ryan has the attempt history (invariant 5). That is the honest state — he ruled,
and the stage did not finish — but there is no affordance for re-running just the tail, which
is the same gap as "a run of a retired stage holds its episode forever" above and wants the
same fix: **a verb for putting a run down, or picking one up again.** Not invented here,
because it is a decision about what Ryan may do to a run.

### A pin is not a landing, and the door only moves the pin (E4-4, #64)

Before E4-4 nothing in this app called `declarePosition` except the fixture loader, so an
episode's position on an arc could be read everywhere and moved nowhere. The door is
`declareEpisodePosition` (canon-bench.ts) behind `POST /api/canon/episode/:id/position`, and
it is deliberately the LOWER of the two calls: it moves the pin, raises nothing, and costs
nothing.

**The split is D8 read literally, and it is why there are two calls at all.** Declaring is a
production decision — Ryan saying which waypoint this episode is written to land. The LANDING
is a claim about the world, so it is a fact, so it needs a subject entity, and the subject is a
writing judgement out of the written episode (the E2-3 constraint). A bench that raised the
landing would have to invent that subject with no text to read it from — the same thing E2-4
refused to do from a loader. So: pin at the bench, free, whenever; landing from the script,
paid, with the subject the writer answered.

**E5's arc page (D24) is what renders this properly.** What is built is what that page needs
already queryable — the sentence, the `$0.00`, and the reason a button is disabled — reached
through the bench view's `?episode=` control, the same shape `?entity=` already had.

*Closed by E4-6 (#66): the landing raised out of the script is ratified at the completion sweep,
and only then does "arc1 reached waypoint2 in ep02" become a fact with lineage. The pin never
moves at that ruling and never needed to — what the ruling changes is whether landing it is
canon (`sweep.test.ts` holds both halves).*

### The extractor's four laws, and the one scope they are read against (E4-4, #64)

`claim.ts` inherits `domain/board.ts`'s pattern whole — nothing trusts the model — and adds the
thing that makes it enforceable: **`claimScope` is composed once and read by both the prompt
and the parser.** So "that entity is not in provenance" and "that fact was not on your list"
are refusals against the exact list the model was handed, rather than against a second query
that happens to agree today. A prompt built from one read and a parser built from another is
`write-context.ts`'s failure mode one layer down.

The four: a claim's span must resolve in the draft; a claim's subject must be in the draft's
provenance (E4-1's rule, read backwards — an entity the writer was never handed is canon
nobody read); a claim already standing verbatim raises nothing; a claim that contradicts a
standing fact is raised as a delta **with its before**. A malformed answer fails the step, and
that is not fussiness: **a zero-claims pass is a real and legal answer**, so a broken reply
rendering as one would tell Ryan this episode touched no canon.

Two implementation rules a later extractor should copy rather than rediscover. The proposals go
through `canon-bench.ts`'s two builders — `proposeFactChange` for a delta with a before and
`proposeNewFact` for one without, the latter widened here with the same three optional fields
the former already had — so the refusal a closed or provisional fact earns is one string
wherever the claim came from. And the usage context is quoted by `quotedLines` (remediation.ts,
exported for this), because a proposal's second part is "the passage that made it necessary"
and two composers would put two shapes of one argument on one queue.

### A stage can now finish without an approval, and every step past a gate must ask (E4-5, #65)

D21 is real on the writing line: a rejection whose notes are all routed to ANOTHER artifact
ends the run instead of writing the draft again (`correction-loop.ts` returns `verdict:
'reject'`; `present-step.ts` returns rather than re-presenting). Nothing regenerates, the note
stands against what it named, and what changes is that artifact's OFFER.

Two steps already sat past a gate and both had to learn the third verdict. **`advance-past-the-…-gate`
does not advance** — an approval is the only thing that moves an episode (E4-1), so it says
where the episode stayed through `stayedAt` (domain/lifecycle.ts) rather than passing a
rejection through the function whose name is its precondition. **`extract-the-canon-claims`
does not read** — it reads the draft Ryan APPROVED, and a rejection is not one, so it returns
`null` and buys nothing.

**E4-6's sweep gate inherits this directly.** Any stage that grows a step past its gate owes
the same question — E4-4's ledger entry above says the COST must cover the whole run, and this
is its other half: the steps past the gate must consult the verdict, because one of the three
means the work did not happen.

### A routed note is a record with an address, and "addressed" is a comparison (E4-5, #65)

`gate_note` carried `depth` and `target` from E1-4 and nothing acted on them. E4-5 acts, and
the two things it needed are in **migration 0014**: `outline` joined the closed depth set (4.7
named the depths before E4-2 made the outline an artifact), and `target_version` records what
the target stood at when the note landed. That column is the whole reason **"addressed" is
derived and never flagged** — a newer version of the target exists, or it does not
(`domain/routing.ts`). Nothing is ever written back to a note.

Three things a later epic inherits rather than re-decides:

- **A depth resolves ONCE, at the ruling, and never refuses.** Nothing may block a ruling
  (`gate.ts`), so a route to a kind this episode has not written lands as a note with no
  address rather than as a rejected verdict.
- **The desk carries routed notes with a THIRD origin**, not a third list — `routed-rejection`
  beside `gate-rejection` and `finding-dismissal` (`write-context.ts`). A writer's prompt can
  say "your note from the ep02 script gate, routed here" versus "your round-2 rejection"
  versus "a finding you dismissed", and a note routed AWAY leaves the desk it was written at.
- **`shot` and `take` reach nothing yet, and the mechanism is waiting for them.** D21 was ruled
  about the REVIEW DESK; E6 wires the same three functions (`addressOf`, `landsOn`,
  `unaddressedNotesTo`) to a shot's prompt and a held slot, and needs no new table to do it.

### An edit does not re-extract, and that was chosen (E4-5, #65)

A hand edit lands verbatim as a new version and runs the free deterministic tier over it, and
that is ALL it runs. It does not buy E4-4's paid extraction: that reads the draft Ryan
approved, a hand edit is not an approval, and a door that spent a model call would break the
one promise on its button — "no model call · $0.00" (invariant 5). So the canon consequences
of his own words are his to raise at the bench (#39's add-a-fact door) or nobody's.

**E4-6's sweep collects whatever is riding the episode either way**, which is why this is a
gap with no hole in it — but if a later session wants an edit to raise claims, it is a second
button with its own cost, never a silent tail on this one. `edit.ts`'s header says the same
thing where the next person will be standing.

### A sentence may not name a door, and the writing stage's refusal names two (E4-5, #65)

"ep02 already has a premise-brief, in slot “demo” — rule on it at its gate, or edit it
directly" is what a writing stage says about an episode that already has its artifact. E4-3
built the gates and nothing offered them; E4-5 built the edit. Both doors are now on the card
that carries the refusal (`operating.ts`'s `WrittenOnThePage`), per written artifact, with the
freshness sentence beside them.

Two things had to give, and both are the same mistake in two places. The presenting stage
asked the CHECKS' question — the singular slot a producer owns — so it could not open over
ep02's demo-era brief, which is the exact artifact the refusal names and the E4 drill's
opening move. It asks `writtenOfKind` now (`write-step.ts`, exported for this), which is the
question the refusal asks. And the writer declared no freshness edge at all, so a hand edit of
an outline the APP wrote staled nothing: `recordInputs` runs every writing round now, and the
fixture's own `built from` stopped being the only edge in the library.

**The rule generalizes and E5 inherits it:** a refusal that names an affordance owes that
affordance a button on the same screen. E5 owns how the eight screens render these; it does
not get to drop one and leave the sentence.

### The completion sweep is a pass Ryan OWES, not a payload a gate carries (E4-6, #66)

The E2 ledger's `sweepEpisode` entry above records the sentence this amended and why it could
not stand. What binds later epics is the shape that replaced it: **an owed pass is a first-class
thing in this app now, and it is not a gate, a run, a step, or a stage.** It is a read over the
proposals riding an episode (`sweep.ts`), reached from the episode, made whenever Ryan sits down
to it, and finished when the last rider is ruled.

Three properties a later surface inherits rather than re-decides:

- **It stands owed rather than blocking.** The pass neither advances the lifecycle nor holds it
  — E4-1's seam already moved the episode when the run's closing step moved it, and an episode
  with riders standing is offerable to E6's assets work exactly as one without. A screen that
  rendered the sweep as a wall would be inventing a gate out of a ruling pass.
- **It convenes rulings; it never spends and never generates.** No adapter is imported here and
  none may be. A script Ryan edited by hand may carry claims nobody raised — that was E4-5's
  choice, and the door for them is the bench's add-a-fact (#39), never a sweep that helpfully
  re-reads his prose. **If a sweep ever calls a model, this rule has been broken.**
- **The riders arrive from more places than one.** Extraction after the gate (E4-4), a check
  remediation mid-loop (E3-5), the bench's own door riding an episode (#39). The pass collects
  whatever rides at the moment it is read, which is the property that made "computed from the
  queue" the only honest implementation.

**E6's watch-through gate is the next thing 1.2 calls "the final gate", and it inherits this
directly:** it does not convene the sweep either. The pass is already reachable, already owed,
and already Ryan's; a second convener would be two screens over one obligation.

### "Swept" is derived, and the absence of a bulk verb is the feature (E4-6, #66)

There is no `swept_at`, no sweep table and no lifecycle hook, and `sweep.test.ts` asserts the
absence of the first two by querying `sqlite_master` and `pragma_table_info` rather than by
comment. The episode card's sentence appears when something rides and goes when the last rider
is ruled, off one read both times (`sweepOnThePage`, in `operating.ts`'s `EpisodeOnThePage`).

**Three riders take three rulings and leave three rows on `canon_ruling`.** There is no bulk
verb on the view, no `ratifyAll` anywhere, and no route for one — `POST /api/sweep/:id/ratify-all`
is a 404 because it does not exist, not because something refuses it, and a test pins that. E5
owns how the episode room renders this pass (5.2, D24); **it does not get to add a fourth
button.** The same rule that makes founding legal makes this one binding: D25's `foundCanon`
rules a stack one at a time through the same API and writes one ledger row per sheet, and it is
a deliberate act over documents already read — not a precedent for a bulk approve elsewhere.

### One proposal, one renderer, two surfaces (E4-6, #66)

`proposalOnTheBench` (`canon-bench.ts`) is exported now and the sweep is its second reader. What
a proposal IS, what ratifying it would write, what it would disturb and why a verb is refused
are one answer wherever Ryan is standing — only the SCOPE differs, which is the same shape
`draftsUnderReview` already holds for a gate's payload (E4-3). A third surface over proposals
calls this rather than composing its own; two renderers drift the day one of them learns
something.

### The desk is a preview, not a post-mortem, and that is what it is FOR (E4-7, #67)

`writing-room.ts`'s inspector renders `composeWriteContext` **before the click**, off the same
composer the step calls — no second read, no cached copy, no `write_context` table (E4-0 forbids
one and always will). That placement is the whole feature: Ryan judges a draft against what the
writer KNEW, and four questions come up at every writing gate that the draft cannot answer —
*why did it write that* (the facts, each with its reach), *why did it not know about X*
(`leftOut`, with the rule in words), *did it read my note* (the three origins, kept apart), and
*what is this about to buy*.

**The prompt is rendered and it is honest about being a floor.** `composeWritePrompt` is the
step's own function, so what is on screen is what would be sent — except for one part that
cannot exist before the click: the CHECKS' notes from a round that has not run. So the round
number is computed the way the loop computes it (`historyOf`) and `promptCaveat` names the
missing clause. **Any later surface that previews a call owes the same confession**; rendering a
guess as the real thing is invariant 4 one layer out from the checks.

### A refusal that names a door owes that door a lifecycle, not just a button (E4-7, #67)

E4-5's ledger entry above generalized the rule *"a refusal that names an affordance owes that
affordance a button on the same screen"*. E4-7 built both buttons and found the rule did not go
far enough: **ep02's demo-era premise-brief had two doors and neither one moved the episode.**
The writing stage was refused because the artifact exists; the presenting stage opened a gate
and carried no lifecycle step; a hand edit deliberately moves nothing; and the outline's refusal
said *"Rule on the ep02 premise first, and this becomes offerable"* to a showrunner who had
ruled on it twice.

**It was [issue #76](https://github.com/MrMophandle/Showrunner/issues/76), filed rather than
fixed under the #39 precedent, and it is CLOSED.** Two things opened the door, and both are
rulings rather than details:

**1 · A ruling is a ruling, whichever door convened it.** Approving at a presenting gate moves
the episode on — the same seam the in-run gate carries, `advanceOnPresentedApproval`
(`domain/lifecycle.ts`) delegating to `advanceOnApproval`, so the four rules are inherited
rather than re-decided. It guards on **AT and only AT**: the episode must be standing at the
stage that produces what he ruled on, because this is the one door with no precondition in
front of it (free, never walled, renders any slot) and forward-only would otherwise let a
script ruled on an episode at `premise` carry it three stops. Two corollaries, both recorded
where the code decides: a script approved here has had **no extraction run** and the sentence
says so, its claims' door being the bench (#39) — `edit.ts`'s no-silent-spend choice, reached
by a second route; and **nothing is retroactive** — the E1-era rulings in Ryan's library move
nothing, ep02 leaves `premise` because he rules AGAIN at a live door.

**2 · The offer got its own question.** `notesOwedBy` beside `routedNotesTo` (`domain/routing.ts`),
one read and two filters. The desk keeps its exclusion untouched — a note written at an
artifact's own gate is already read as an ordinary rejection, and printing it twice hands one
instruction to a writer as two — and the offer keeps those notes, which are the only kind a
presenting gate can write: **the offer's set is `landsOn` said in SQL**, so the unrouted default
(what the drill types), a scene of the draft, and a depth that resolved to this very artifact all
count, each answered by a newer version and by nothing else. The version they landed on comes off
the note when it named an artifact and off `gate_round.artifact_version` when it named none —
0014's own column, read where it does apply. Three readers moved to the new question (`offerFor`, `writtenArtifacts`,
`artifactOnTheWire`) and a fourth that had the same need for a different reason: the correction
loop reads it to know the version Ryan has already ruled on, so the reopened button really
rewrites instead of handing back the words he argued with. **Both questions are tested at their
own call site** (`write-context.test.ts` for the desk, `writing-room.test.ts` for the offer), and
`writing-room.test.ts`'s four-door walk now runs over **two slots** — the demo-era one and the
producer's own — because E7's import and any hand-made artifact arrive in the same shape and
none of it is about `demo`.

### One cluster renderer, three surfaces — and the wall's sentence moved with it (E4-7, #67)

`ClusterSay.sentence` ("world-rules · severity high · confidence high · text, a reading") is
composed in `domain/panel.ts` now, and D12's card sentence is `BLOCKS_THE_NEXT_STAGE` in
`runner/stage-wall.ts`. Both were `check-bench.ts`'s, which was right while the check bench was
the only surface that rendered a cluster — and it is **script-only** (`BENCH_KIND`), so the
premise-brief's and the outline's reviewers had no surface anywhere until the writing room's
gates. Two copies would drift, and the one that drifted would be the one telling Ryan a
deterministic finding reaches his gate. **E5's gate room is the fourth reader and composes
neither.**

### Every gate refusal is one string now, and the browser holds none of them (E4-7, #67)

`rejectionNeedsANote(subject)` (`runner/gate.ts`) is thrown by the ruling, refused with by the
route, and shown on the disabled button — which came down the wire as `GateOnThePage.rejectNeedsNote`
rather than living in `App.tsx`. Until E4-7 those were **three different sentences** for one
rule, and the browser's copy was the one Ryan actually read: "preconditions before the button"
decorated rather than kept (D15). The bench pattern (`CHECK_REFUSALS`, `BENCH_REFUSALS`) had
covered every other typed-field precondition since E2-6; the gate's was the one that got missed
because it predates the pattern. **Nothing in `app/web/` may hold a refusal string**, and
`App.test.tsx` asserts the API's exact sentence rather than a paraphrase of it.

## Working agreements that bind every session

- One issue, one session. Leave the repo green; if unfinished, write `HANDOFF.md`.
- **Fixtures before features** — the Grey Harbor fixture backs all tests. Never burn
  real generation money in a test.
- **The Archon rule** — no workflow DSL, no configurable workflow engine. Stages are
  TypeScript. If you're building a generic workflow system, stop.
- **Only ratification writes canon.** Everything else proposes.

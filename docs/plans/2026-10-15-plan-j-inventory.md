# Plan J ("run until green") — inventory

**Status: this document is an inventory, not a plan.** It was taken on 2026-10-15 against two
repositories, both read and neither written: the engine at `~/GitHub/Showrunner` on branch
`run-situation`, and the live show instance at `~/GitHub/DeadLight2` on `main` at `30d4fa7`. The
only file this inventory writes is itself. Every number below was printed from the files and the run
log named beside it; nothing is recalled.

**The engine repository moved under this inventory, and §4 and §7 are reported at its new HEAD.**
Measurement began with `run-situation` at `c03908d` and five tracked console files modified in the
working tree by the other implementer committing on that branch. That work landed mid-inventory as
**`b912b3b`, "console: the gate page leads with the artifact and keeps the message behind one
expander"** (+361/−26 across six files), and the working tree is clean again. **Every console
citation below is of `b912b3b`**, and the commit is directly in Plan J's path — it is the finding at
J-25, and it retires part of what the brief for this inventory asked §4 to price.

**The ruling Plan J implements (Ryan, 2026-10-15), in three parts.**

1. **The panel runs again after every revision, and revise-then-review repeats until every reviewer
   passes.** The script gate opens only on a green panel. There is no round cap.
2. **The only stop is the weekly quota.** A five-hour limit is waited out, which Plan I already
   built and merged at `3e58c77` (`step_waiting`, `agents.autoRetryWeeklyUtilizationMax`, default
   **65** at `engine/src/show-config.ts:15`). When the seven-day quota reaches that ceiling the run
   stops with Plan I's "Manual resume needed" sentence (`engine/src/agent-step.ts:454`,
   `limitOpening`) and the showrunner's Resume continues the loop.
3. **The reviewers are tightened so the loop converges.** A reviewer fails only for a defect against
   a written law — a canon fact, a style-guide rule, a structure duty, a measured repetition — with
   each issue citing the law and the line. Preferences go in a non-failing field. Each reviewer sees
   its own previous verdict and judges whether the issue is resolved, not whether the scene is now
   perfect.

**One question is still open with Ryan: whether reviewers may also fail on craft judgment.** This
inventory measures both readings' consequences in §3.4 and decides nothing.

The headline counts, measured and not estimated:

| What | Count | Where measured |
|---|---|---|
| Ways the engine can re-run a *set* of earlier steps | **one** — a gate rejection's `rerunOnReject`. No guard, loop or pipeline field can. | §1.5 |
| Steps the script gate's `rerunOnReject` already resets, on the live pipeline | **10** — `hand-edits-script`, `canon-review-script`, `canon-ledger-script`, the six reviewers, `revise` | §1.4 |
| Reviewers that **failed** the one real Season 2 panel | **2** of 7 — `tone-check` (15 issues), `repetition-check` (8 issues) | §2.3 |
| Reviewers that **passed while listing issues** | **1** — `flow-check`, `pass: true` with **5** issues | §2.3 |
| Cost of one panel round on s02e01 (7 reviewers) | **$6.0660** | §2.2 |
| Wall time of that panel round at concurrency 7 | **374.8 s** (6 min 14.8 s), against **1,487.7 s** of agent time | §2.2 |
| Cost of one full review→revise round as the run paid it | **$15.8878**; **1,033.0 s** of wall time excluding the showrunner's gaps | §2.4 |
| That round as a share of the whole write phase ($75.31) | **21.1 %** | §2.4 |
| Reviewer prompts with a non-failing field | **1** of 7 — `canon-review-script`'s `deviations` | §3.2 |
| Reviewer prompts handed any prior verdict | **1** of 7 — `canon-review-script`'s four rejection/hand-edit sources | §3.3 |
| Reviewer prompts whose pass rule is mechanical | **1** of 7 — `canon-review-script.md:50` ("`pass` is true only when `issues` is empty") | §3.2 |
| Characters in the rendered s02e01 script-gate message | **10,618** across **71** lines | §4.1 |
| Weekly-quota figures in the s02e01 run log | **0** — the field is written only when a limit is classified | §5.2 |
| Cost fields on the console's run wire | **0** — `console/shared/types.ts` carries no `costUsd`; one other page renders cost already | §7.3 |
| Findings below | **27** (J-01 … J-27) | §8 |

---

## 1 · The loop machinery the engine already has

**Conclusion: the loop Ryan ruled for already exists in the engine, and it is the gate-rejection
path. The script gate's `rerunOnReject` already names the six reviewers, and the reset closure
already pulls in the canon review and the `revise` loop. What is missing is a trigger: today only a
human rejection fires that path, and no step kind can fire it from a verdict.**

### 1.1 `StepOutcome` and the reset arm — `engine/src/runner.ts:373-378`

`StepOutcome` has exactly four arms:

```
type StepOutcome =
  | { kind: "completed"; result?: unknown }
  | { kind: "failed"; error: string }
  | { kind: "waiting"; gate: GateState }
  /** A gate rejection reset these steps; the pass restarts so they run before the gate reopens. */
  | { kind: "reset"; stepIds: StepId[] };
```

The `reset` arm is produced in **one place**: `engine/src/runner.ts:550`, inside `runGateStep`
(`:463-582`). Confirmed by grep — `kind: "reset"` appears at `:378` (the declaration) and `:550`
(the only `return`), and nowhere else in `engine/src/`.

### 1.2 How the pass restarts — `engine/src/runner.ts:256-344`

The runner's step walk is a labelled infinite loop: `pass: for (;;)` at `:258`, with the comment at
`:256-257` stating the rule ("a gate rejection that reset upstream steps restarts the pass from the
top, where the reset steps are pending again and precede the gate"). The outcome is collected at
`:319` (`let reset: StepId[] | undefined`), assigned at `:330`, and consumed at `:340-343`:

```
      if (reset) {
        for (const id of reset) { delete state.steps[id]; delete ctx.results[id]; }
        continue pass;
      }
```

So the restart is two deletions per step and a `continue`. **The pass restart costs nothing to
build — it is already general.** It does not know or care that a gate produced the outcome.

### 1.3 The three writes and the one read of `step_reset`

Three producers, all in `engine/src/runner.ts`, and only the first is reachable from inside a
pipeline:

| Writer | Line | `payload.by` | Reachable from a pipeline? |
|---|---|---|---|
| A gate rejection's reset closure | `:549` | the gate's step id | **yes** |
| `resetSteps` (the operator's "re-run from here") | `:118` | `"operator"` | no — a console `POST .../reset` (`console/server/app.ts:876`, `:895`) |
| `withdrawApproval` (re-asking an approved gate) | `:146` | `"withdraw:<gateId>"` | no — a console route |

One reader: `deriveRunState`'s `case "step_reset"` at `engine/src/state.ts:53-62`, which does three
things — `delete s.steps[id]`, `delete s.results[id]`, and clears `s.position` when the reset step
was the one in flight. **That is the whole projection contract.** The runner's own in-memory
deletions at `:341` mirror it, so a resumed run and a running one agree.

The idempotence guard is at `engine/src/runner.ts:533-535`: the reset is recorded once per
rejection, tested by scanning for a `step_reset` whose `by` is this gate's id **after** the last
gate event. `engine/src/runner.ts:544-545` then filters the closure: a step with no status is
skipped (it is pending already), and **no gate is ever reset**, including the rejecting gate itself.
`:546-551` refuses to return a reset with an empty closure, "or a reset with no `step_reset` written
would leave `resetAlreadyDone` false and restart the pass forever."

### 1.4 The closure the live pipeline already computes

`downstreamOf(p, ids)` at `engine/src/pipeline.ts:21-36` is the transitive dependent closure in
pipeline order. The script gate declares, at `engine/src/pipelines/episode.ts:247`:

```
      rerunOnReject: ["hand-edits-script", ...REVIEWERS],
```

with `REVIEWERS` at `:53` naming the six: `tone-check`, `flow-check`, `character-check`,
`structure-check`, `environment-check`, `repetition-check`. Walking the live dependency graph —
`canon-review-script` depends on `hand-edits-script` (`:227`), the six reviewers depend on `draft`
(`:116`, the `reviewer()` helper), `canon-ledger-script` on `canon-review-script` (`:228`),
`review-gate` on `canon-review-script` plus the six (`:236`), and `revise` on `review-gate`
(`:240`) — the closure that has a status when the script gate is rejected is **ten steps**:
`hand-edits-script`, `canon-review-script`, `canon-ledger-script`, the six reviewers, and `revise`.

**That is exactly Ryan's round.** The gate-rejection path already re-runs the whole panel and the
revision. `canon-ledger-script` re-runs safely: `scripts/canon-ledger.py:8-9` and `:69-70` dedupe on
`(where, deviation)`, and its doc comment says so in the same words — "a review that re-runs after a
gate rejection does not duplicate the ledger."

### 1.5 What cannot re-run a set of steps today

- **A `guard` cannot.** `GuardStep` (`engine/src/steps.ts:52-55`) has one method, `check`, returning
  `GuardResult` = `{pass: true, message?} | {pass: false, message}` (`:50`). `runStep`'s guard arm
  (`engine/src/runner.ts:387-407`) maps `pass: true` to `{kind: "completed"}` and `pass: false` to
  `{kind: "failed"}` — which **fails the whole run**. A guard has no third answer. This is why
  `review-gate` (`episode.ts:236-238`) always passes and smuggles its verdict in the *message*
  (`"yes"` / `"no"`), read by `revise`'s `when` at `:240`.
- **A `loop` body cannot be a sequence.** `LoopStep.body` is typed `NestedAgentStep`
  (`engine/src/steps.ts:154`) — one agent step, not a list and not a pipeline. `orderSteps` further
  refuses a loop whose body carries a schema (`engine/src/pipeline.ts:63-67`), because the sentinel
  is matched against the body's final text and a schema step's text is the serialized verdict.
- **The pipeline has no rerun list.** `Pipeline` is `{ name: string; steps: Step[] }`
  (`engine/src/steps.ts:170-173`). There is no pipeline-level field of any kind.

### 1.6 The three ways the ruling could be expressed, and what each costs

**(a) Reuse the gate-rejection path from a verdict.** Give the engine a step kind — or a new
`GateStep`/`GuardStep` field — whose "no" returns `{kind: "reset", stepIds}` after writing
`step_reset` for each. The reset machinery, the projection, the idempotence guard, the console's
`step_reset` rendering (`console/server/runs.ts:247`, `console/src/components/StepRail.tsx:129`,
`console/src/components/EventFeed.tsx:51`) and the pass restart are all already built and already
exercised. **Cost: the smallest.** The new code is the trigger and its idempotence test — the
existing guard at `runner.ts:533-535` keys on "a `step_reset` by this gate after the last gate
event", and a verdict-driven reset has no gate event to anchor against, so a round counter or an
anchor of its own is needed. This is the one real design problem in option (a).

**(b) A loop whose body is a sequence.** New type (`body: Step[]` or a nested `Pipeline`), new
executor branch, new id-namespacing rules (`orderSteps`' nested-id check at
`engine/src/pipeline.ts:45-59` assumes one nested step per parent), and the loop's own history model
breaks: `runLoopStep` logs every iteration under the loop's single id
(`engine/src/steps.ts:150-153`), so seven reviewers' events in a round would collapse into one
step's history and the console's per-reviewer chips would lose their step ids. **Cost: the
largest**, and it discards the verdict board.

**(c) A pipeline-level rerun list.** A new `Pipeline` field the runner consults when a named guard
reports "no". This is option (a) with the trigger moved off the step and onto the pipeline; it costs
the same new code plus a second place a step set is declared — the script gate's `rerunOnReject`
already declares one.

**No option needs the reset machinery built.** All three need only a trigger and a round anchor.

### 1.7 The `loop` kind, measured, and the `8c75077` rule

`runLoopStep` at `engine/src/runner.ts:584-652`. The iteration resume rule has two halves, both
written out at `:585-603`:

- **A crashed attempt keeps its count** — iterations logged since the step's most recent
  `step_started` belong to the attempt that crashed, so the cap is per run, not per process.
- **A finished attempt does not** — a `step_failed` or a `step_reset` after that `step_started`
  resets `done` to 0 and discards the sentinel shortcut (`:615`). This is commit `8c75077`'s rule,
  and its doc comment cites the exact measurement Plan J inherits: *"measured on the s02e01 run of
  2026-10-15, where Resume appended run_resumed, step_started and step_failed with no agent_query
  between them."* §2.5 below prints those three events.

**The second half is what makes Plan J's loop resumable at all.** Without it, a `revise` loop that
exhausted its cap could never run again, and a reset `revise` that had already fired its sentinel
would complete without re-running work the reset had just invalidated.

---

## 2 · The review round on the real script

All figures in this section come from
`~/GitHub/DeadLight2/Production/s02e01/runs/20261014T183337Z-8r5w.jsonl` — **526 events, 317,459
bytes, the only Season 2 run** and the only episode run log in the instance (the other 13 `.jsonl`
files are the 2026-10-04 bible-interview runs under `Production/setup/`).

### 2.1 The reviewers' sessions are fresh, so their `costUsd` is per call

`agent_result.costUsd` is `result.total_cost_usd` copied straight through
(`engine/src/agent-step.ts:782`), and `total_cost_usd` is **per session, cumulative**. Whether a
figure is per-call therefore depends on the step's `context`.

- **The six reviewers and `canon-review-script` are `context: "fresh"`** — declared at
  `engine/src/pipelines/episode.ts:116` (the `reviewer()` helper) and `:120` (`canonReview()`), and
  confirmed in the log: all seven `agent_query` events carry `{"resumed": false, "context":
  "fresh"}`, and all seven `sessionId`s are distinct. **Their `costUsd` is the cost of that one
  call.**
- **`revise` is `context: "shared"`** (`episode.ts:241`), and the log proves the figure is
  cumulative: three `agent_result` events in the first attempt all report `costUsd: 6.587001` under
  one `sessionId` (`466674a2-…`), while their `durationMs` falls 447355 → 352 → 328 and `numTurns`
  falls 49 → 1 → 1. **The session total did not move across iterations 2 and 3 because those
  iterations did no work.**

### 2.2 The panel, one reviewer per row

All seven started within 12 ms of each other at `2026-10-14T19:34:58.86x` — the console's production
`--concurrency 7` running the whole panel at once. Model `claude-sonnet-5` for all seven
(`models.medium`).

| Reviewer | `costUsd` | `durationMs` | `numTurns` | `toolCalls` | verdict |
|---|---|---|---|---|---|
| `character-check` | 0.9981572 | 97,557 | 15 | 13 | pass, 0 issues |
| `repetition-check` | 0.8696880 | 142,312 | 11 | 9 | **fail, 8 issues** |
| `structure-check` | 0.7045236 | 161,406 | 6 | 4 | pass, 0 issues |
| `environment-check` | 0.8706890 | 164,587 | 9 | 7 | pass, 0 issues |
| `flow-check` | 0.4338370 | 232,089 | 6 | 4 | **pass, 5 issues** |
| `tone-check` | 0.7130154 | 315,745 | 8 | 6 | **fail, 15 issues** |
| `canon-review-script` | 1.4761122 | 374,025 | 29 | 27 | pass, 0 issues, 0 deviations |
| **total** | **$6.0660224** | **1,487,721 ms** | **84** | **70** | |

**Panel wall time: 374.777 s** — from `repetition-check`'s `step_started` at `19:34:58.861` to
`canon-review-script`'s `step_completed` at `19:41:13.638`. Concurrency 7 compressed 1,487.7 s of
agent time into 374.8 s, and `canon-review-script` was the long pole at 374,025 ms: **the panel's
wall time is the slowest reviewer's, to within 0.8 s.**

### 2.3 Which reviewers failed, and the correction this measurement forces

**Two reviewers failed, not three.** `repetition-check` and `tone-check` returned `pass: false`.
`flow-check` returned **`pass: true` with five issues** — the third reviewer with findings is not a
reviewer that failed. The brief for this inventory said "the three that failed on s02e01"; the log
says two, and §3.4 reads all three sets of issues because `flow-check`'s passing-with-issues is
itself a finding (J-13).

`review-gate`'s result in the log is the bare string `"no"` (`episode.ts:237`'s all-pass test over
seven ids), and `revise` ran on it.

The failing issue arrays, quoted from `step_completed.result`:

**`tone-check` — 15 issues.** Ten of the fifteen name a style-guide section verbatim as the rule
violated. The first three, in full:

1. `Scene Five (The Bad Claim) — "Sarn said his quiet word to the hull as the locks let go — he said it every departure, and no one aboard had ever asked him about it" — Retention contract (never dress atmosphere in load-bearing clothes) — the detail is singled out and left mysterious, which marks it as significant, yet it is never restated, reacted to, or made consequential anywhere in the episode; it should have been one plain clause that washes over, not a hook.`
2. `Scene Five (The Bad Claim) — Sarn's first spoken line of the episode, "'Take the tag,' he said" — Rules of voice (new voices need a runway) — only three words before the attribution, short of the 'roughly five words or more' floor the guide requires for a character's first line of an episode.`
3. `Scene Seven (The Tally) — "Trent kept his eyes on his bowl and ate slower than a man tastes stew. … Sarn finished eating in the time it took him to finish eating." — Retention contract (the auditor's test) — four separate individualized physical tells are stacked for four different characters in one short passage, more signals than the scene's single point (the crew's silent dissent) needs.`

The remaining twelve cite, by name: *Cadence / sentence architecture* (issues 4, 5, 11), *Retention
contract (analogy ration)* (6), *Endings* (7, 10), *Narration (ride one character's shoulder per
scene)* (8, 13), *Rules of voice (the narrator never winks at the plot)* (9, 12), *Rules of voice
(no descriptor tics)* (14), and *Character voices* (15).

**`repetition-check` — 8 issues**, every one of them carrying counts and line numbers. The first and
the last:

1. `Scenes 1,2,3,4,6,7,8,9,10,11,12 (L13,39,135,161,183,253,285,293,299,307,321,417,429) — "the way X did Y" construction used 13 times in one episode — construction — keep ~2-3 load-bearing instances (Veleth's seal-reading simile L39, Trent's tide-line simile L321), rewrite the rest as plain declaratives.`
8. `Scenes 3,4,5,6,7,9,10,11,12 (L81,85,99,109,155,181,203,207,231,239/243,315,343,391,415,421,437) — 'Nobody ___. Nobody ___.' used as a scene/beat-ending punch roughly a dozen times — construction frequency — vary the closing-beat device in at least half of these.`

**`flow-check` — 5 issues on a passing verdict**, three of which overlap `tone-check`'s findings on
the same lines (the Scene Eight toll-booth sentence, the Scene Nine stacked clauses) from the ear's
side rather than the cap's.

### 2.4 The round's total cost and wall time

| Segment | Cost | Wall time |
|---|---|---|
| Panel (7 reviewers, concurrency 7) | $6.0660 | 374.8 s |
| `revise` attempt 1 — 3 iterations, no sentinel, loop **failed** at its cap | $6.5870 | 452.6 s |
| `revise` attempt 3 — 1 iteration, sentinel fired | $3.2348 | 205.6 s |
| **One review→revise round, as the run paid it** | **$15.8878** | **1,033.0 s** (17 min 13 s) |

The wall figure excludes the showrunner's gaps: the run sat failed from `19:48:46` on 2026-10-14
until the first Resume at `00:05:18`, and failed again until the second Resume at
`2026-10-15T19:02:21`. Attempt 2 is omitted from the table because it did no work at all — see §2.5.

**For proportion**, the whole s02e01 write phase, summed as per-session maxima so no shared session
is double-counted: **$75.31**. `draft` $49.1927 across 12 fresh sessions (65.3 %), `revise` $9.8218
(13.0 %), `outline` $8.6414 (11.5 %), `canon-review-outline` $1.5903, and the panel $6.0660
(8.1 %). **One review→revise round is 21.1 % of the write phase.** A loop with no round cap
therefore doubles the write phase's cost in roughly five rounds — which is the arithmetic that makes
the weekly quota a real brake rather than a formality.

### 2.5 What the second panel's verdicts would have been is unknown, and the log says why

**No second panel ran.** The script gate opened at `2026-10-15T19:05:47.532Z` on attempt 1 with the
revised script on disk and the **pre-revision** verdicts in its message. No reviewer has ever read
the revised s02e01 script. **Nothing in the log licenses any estimate of how many rounds the loop
would take**, and the plan must not carry one.

The three `revise` attempts, exactly as logged:

| Attempt | Events | Outcome |
|---|---|---|
| 1 (`19:41:13.785`–`19:48:46.422`) | `agent_query` resumed=false; iteration 1 (49 turns, 48 tool calls, 447,355 ms); iteration 2 (1 turn, **0 tool calls**, 352 ms); iteration 3 (1 turn, **0 tool calls**, 328 ms) | `step_failed: exhausted 3 iterations without sentinel REVISIONS_COMPLETE` |
| 2 (`2026-10-15T00:05:18.156`) | `step_started` then `step_failed` **in the same millisecond, with no `agent_query` between them** | the same sentence — the bug `8c75077` fixed |
| 3 (`19:02:21.954`–`19:05:47.531`) | `agent_query` resumed=false; iteration 1, 7 turns, 6 tool calls, 204,712 ms, **`sentinel: true`** | `step_completed` |

**The same writer, with the same findings, finished in one fresh iteration what three iterations of
a shared session could not.** Iterations 2 and 3 of attempt 1 called no tool, took under 400 ms
each, moved the session's cumulative cost not at all, and burned two thirds of the cap. This is the
single most load-bearing convergence measurement in this inventory (J-21).

The worker log agrees and is the operator-facing record:
`Production/s02e01/runs/20261014T183337Z-8r5w.worker.log` has four lines, two of them the identical
`failed at revise: exhausted 3 iterations without sentinel REVISIONS_COMPLETE`.

---

## 3 · The reviewers' prompts and schemas

### 3.1 Where they live, and the template drift

Instance prompts at `~/GitHub/DeadLight2/prompts/`, generic templates at
`~/GitHub/Showrunner/tools/templates/prompts/`. Measured with `diff`:

| Prompt | Instance lines | Template vs instance |
|---|---|---|
| `canon-review-script.md` | 52 | identical |
| `tone-check.md` | 33 | identical |
| `flow-check.md` | 35 | **1 line** — `:26`, `(e.g. Vale, Pim)` → `(e.g. Remo, Cricket)` |
| `character-check.md` | 47 | identical |
| `structure-check.md` | 30 | identical |
| `environment-check.md` | 50 | **2 lines** — `:28-29`, the Warden's oilskin → Opha's EVA shell |
| `repetition-check.md` | 47 | identical |
| `revise.md` | 32 | identical |

**All seven `.schema.json` files are byte-identical between template and instance.** Six of them
(`tone-check`, `flow-check`, `character-check`, `structure-check`, `environment-check`,
`repetition-check`) are the *same* 366-byte schema: `{pass: boolean, verdict: enum["DRAFT
PASSED","DRAFT FAILED"], issues: string[]}`, all three `required`. The seventh,
`canon-review.schema.json` (782 bytes), adds `deviations: array<{where, deviation, canon,
provenance: enum["premise","locked-beats","rejection-note","hand-edit"], evidence}>`, all five
required per row.

**So Plan J's tightening is one schema edit for six reviewers plus one for the canon review**, and
the six share a file in the templates but not in the instance — each of the six is its own copy, so
a new field is **six instance edits and six template edits**, or a consolidation first.

### 3.2 What each is told to fail on, quoted, and whether a non-failing field exists

| Prompt | The failing criterion, verbatim | Non-failing field | Issues must cite a law/line? |
|---|---|---|---|
| `canon-review-script.md:50-51` | "`pass` is true only when `issues` is empty (deviations never fail the review)." | **yes** — `deviations`; `:43` "It is NOT an issue and is NOT to be fixed" | **yes** — `:49-50` "`<script location> — <what conflicts> — <canon file that says otherwise>`" |
| `tone-check.md:31-32` | "Judge like an editor, not a fan: pass only if the script genuinely holds the register throughout." | no | partly — `:30-31` "`<scene + quote fragment> — <rule violated> — <why>`"; a *rule* but no file or line |
| `flow-check.md:34` | "Pass only if you would greenlight this for recording." | no | **no** — `:33-34` "`<scene> — <problem> — <suggested fix direction>`" |
| `character-check.md:45-46` | "Pass only if every character is recognizably themselves all episode." | no | **yes** — `:44-45` "`<character> — <scene + what they do/say> — <sheet/stance line contradicted (file)> — undeclared`" |
| `structure-check.md:28-29` | "Pass only if the episode lands." | no | **yes** — `:27-28` "`<scene/beat> — <structural defect> — <which law (story-craft section)> — <fix direction>`" |
| `environment-check.md:48-49` | "Pass only if every scene is physically airtight." | no | partly — `:47-48` "`<scene> — <character/moment> — <environment as classified> — <what contradicts it>`" |
| `repetition-check.md:45-46` | "Pass ONLY if the draft is clean enough that a weekly listener would never feel the prose looping." | no | **yes, with counts** — `:43-45` "`<scene(s) + quote fragment(s) with counts> — <class: tic/image/construction/stock/cross-episode(<episode id>)> — <keep-which-one or replacement direction>`" |

**Six of the seven pass rules are judgments, and `canon-review-script` is the one mechanical rule.**
`repetition-check` is the interesting middle case: its individual tests are measurable and it is
told to measure them ("Grep to count", `:16`; "used 2+ times", `:14`; "`the way X did Y` (>3/episode)",
`:23`), but its *pass* rule is "a weekly listener would never feel the prose looping."

**`canon-review-script` is the working model for everything Ryan's part (3) asks for**, and it was
already built: a mechanical pass rule, a non-failing field whose contents are explicitly not to be
fixed, a required citation format, and the prior-verdict handoff of §3.3.

### 3.3 Whether any reviewer is handed a prior verdict

**One is.** `canon-review-script.md:24-47` is a whole section titled "Provenance — who introduced
each discrepancy", and it renders four sources into the prompt, two of them prior verdicts of the
same run:

```
   outline gate: {{results.outline-gate:rejections}}
   script gate: {{results.script-gate:rejections}}
```

(`canon-review-script.md:33-34`), plus `{{results.hand-edits-script}}` at `:38`. Those keys are
built by `deriveRunState`'s `gate_answered` arm, which accumulates every rejection note of the run
in order under `<gateId>:rejections` (`engine/src/state.ts:146-148`), and the runner seeds the key
as `[]` before the first step so the template can never hole (`engine/src/runner.ts:247-248`).

**The other six are handed nothing.** No `{{results.…}}` appears in `tone-check.md`,
`flow-check.md`, `character-check.md`, `structure-check.md`, `environment-check.md` or
`repetition-check.md`. Each reads only its canon files and the script.

**So the mechanism Ryan's part (3) needs is built and proven** — a result key rendered into a
reviewer's prompt — and what is missing is the key. A reviewer's own last verdict is in
`ctx.results[<id>]` right up to the moment its `step_reset` deletes it
(`engine/src/state.ts:59`). **That deletion is the obstacle**: under option (a) of §1.6 the reset
that re-runs the panel is also what erases the verdict the re-run is supposed to read. The verdict
survives in the **log** (`step_completed.payload.result`), which `RunContext.events` already carries
(`engine/src/steps.ts:27-31`, "a guard that needs history … reads it here"), so the handoff is
readable — but not through `{{results.<id>}}`.

### 3.4 The three issue sets read against the written laws — the measurement Ryan's open question turns on

The laws exist, with addresses. From `~/GitHub/DeadLight2/Canon/style-guide.md` (134 lines):

- `:6` — "**Third person, past tense, close but mobile.** Ride one character's shoulder per scene;
  move between them at scene breaks"
- `:47` — "**Atmosphere** — colors the scene, never returns. **Plain words, one clause, NO simile.**"
- `:53` — "**Never dress atmosphere in load-bearing clothes.** That is the whole defect."
- `:55-58` — "**Analogy ration.** … Roughly **one per scene**, and it must land on something
  load-bearing."
- `:59-62` — "**Sentence architecture.** No narrator sentence past ~30 words; no stacked subordinate
  clauses; every third sentence short."
- `:63-66` — "**Judgment over mechanism.** The cap serves the drama, not the reverse. A climactic
  build or an elegiac closing line may run long *on purpose* … Break the rule knowingly, never by
  accident."
- `:67-68` — "**The auditor's test.** For any scene, name the details the listener is meant to
  retain. More than two or three means the scene is over-signalling"
- `:84` — "**The narrator never winks at the plot.** No foreshadowing nudges … no telling the
  audience how to feel."
- `:98` — "**New voices need a runway.** A character's FIRST spoken line of an episode must be a full
  phrase (roughly five words or more)"
- `:103` — "End beats on a quiet, cold button, not a flourish."
- `:106` — "**Cricket** — dry, sardonic, expressive-by-choice."

**I counted the words the reviewer claimed.** `tone-check` issue 4's toll-booth sentence is **41
words** (the reviewer said "roughly 40"); issue 5's broker sentence is **35** (said "roughly 35");
issue 11's Scene Ten sentence is **38** (said "roughly 36"). Issue 2's quoted first line, "Take the
tag", is **3 words** against the "roughly five words or more" floor. **The reviewer's arithmetic
holds.**

Classifying all 28 issues:

| Class | Count | Examples |
|---|---|---|
| **Defect against a written law, measurable without judgment** | **14** | tone 2 (3 words vs the `:98` five-word floor), tone 4/5/11 (41/35/38 words vs the `:59` ~30-word cap), tone 8/13 (`:6` one shoulder per scene, a head-hop with no scene break), tone 14 (`:69` no descriptor tics, 3 recurrences), all 8 of `repetition-check` (counts and line numbers, against `:98-100` and `:69`) |
| **A law is cited, but the finding requires craft judgment to reach** | **9** | tone 1 (`:53`, but "left mysterious … should have been one plain clause" judges which detail is load-bearing), tone 3 (`:67-68`, "more signals than the scene's single point needs" judges the scene's point), tone 6 (`:55` analogy ration, counts two but judges which phrases are analogies), tone 7/10/12 (`:103`'s "quiet, cold button" — an aesthetic predicate), tone 9 (`:84`'s "winks at the plot"), tone 15 (`:106`'s "dry, sardonic" — "no dry or sardonic flavor survives") |
| **Craft judgment with no law cited at all** | **5** | all 5 of `flow-check` — "risking list-reading flatness", "may read clipped aloud even though it's within the letter of the rule", "worth a listen-check" |

**The decisive observation is that the style guide itself licenses the second class.**
`Canon/style-guide.md:63-66` — "Judgment over mechanism. The cap serves the drama, not the reverse. … Break
the rule knowingly, never by accident" — means the ~30-word cap is *not* a measurable law: a 41-word
sentence is a defect only if it is not a deliberate climactic exception, and deciding that is craft
judgment. **A "law and line only" rule applied literally would make `tone-check` unable to fail the
toll-booth sentence at all**, because the law it violates has a judgment clause written into it.

**Both readings' consequences, measured:**

- **Reviewers may fail only on measurable defects.** On s02e01 this would leave 14 failing issues
  (tone 2, 4, 5, 8, 11, 13, 14 and all 8 repetition issues, minus the overlap), still failing both
  reviewers, so round 1 is unchanged. `flow-check` would move all five issues to the non-failing
  field and would still pass — no change there either. The cost falls on the second and later
  rounds: tone 1, 3, 6, 7, 9, 10, 12, 15 — **8 of 15 tone issues, 53 %** — become advisory, and
  `Canon/style-guide.md:63-66`'s judgment clause has to be either deleted from the guide or declared
  unenforceable.
- **Reviewers may also fail on craft judgment.** All 28 issues stay failing-eligible, the guide
  needs no change, and `flow-check`'s "may read clipped aloud even though it's within the letter of
  the rule" stays a fail condition. **The convergence cost is J-22**: a craft-judgment issue has no
  test for "resolved", so the prior-verdict handoff of §3.3 cannot settle it mechanically, and the
  loop's termination then rests entirely on the reviewer agreeing with itself across rounds.

---

## 4 · The gate message

### 4.1 What the s02e01 script gate actually printed

The `gate_opened` event's `message` is **10,618 characters across 71 lines**. Its first six lines:

```
Script drafted: Episodes/s02e01/script.md
Panel verdict (review-gate all-pass): no
Canon: {
  "pass": true,
  "verdict": "CANON PASSED",
  "issues": [],
```

and the last line is `Approve to commit. Reject with notes for a targeted revision.` Between them
sit the seven verdict objects as indented JSON, `tone-check`'s 15 issues and
`repetition-check`'s 8 among them — **beside a script that `revise` had already changed.** That is
the bug the ruling names, printed.

`prompts/script-gate.gate.md` is **10 lines and byte-identical to the template**. Lines 2-9 are
eight bare interpolations with no path: `{{results.review-gate}}`, `{{results.canon-review-script}}`,
`{{results.tone-check}}` and five more.

`prompts/outline-gate.gate.md` (11 lines, also identical to the template) does it differently and
better: `:2` uses `{{results.canon-review-outline.verdict}}` — a **path** — and `:4` pulls only
`{{results.canon-review-outline.deviations}}`.

### 4.2 How `{{results.<id>}}` renders a verdict object today

`renderValue` at `engine/src/prompt-template.ts:48-58`, four rules: a string is itself; a number or
boolean goes through `String()`; `null`/`undefined` is a **TemplateError**; **anything else is
`JSON.stringify(value, null, 2)`** (`:55`). A verdict is an object, so it is pretty-printed JSON.
That is the whole explanation of the 10,618 characters.

The `results` branch at `:117-130` resolves only dotted paths into plain objects: `:126` refuses a
path through an array, so `{{results.tone-check.issues.0}}` cannot be written, and there is no
mapping, filtering, counting or formatting syntax of any kind. **The template language cannot
express a verdict summary.**

### 4.3 What a verdict summary helper would need

Three routes, with their costs:

1. **A new `{{...}}` form** in `renderPrompt` (a `results.*` modifier, or a `{{summary.<id>}}`
   branch). One function in `engine/src/prompt-template.ts`, plus the refusal rules the module's own
   doc comment at `:60-77` commits to ("Every hole is an error").
2. **A computed result key the pipeline writes.** The cheapest-looking route, because
   `review-gate`'s guard already computes a message from all seven verdicts
   (`engine/src/pipelines/episode.ts:237`). **But its message is load-bearest text**: `revise`'s
   `when` reads `ctx.results["review-gate"] === "no"` (`:240`), so changing that string from
   `"yes"`/`"no"` to a formatted summary breaks the revise trigger silently. A *second* guard, or a
   second field, avoids that.
3. **Drop the dump from the message and let the console draw it** — see J-25. The console already
   draws exactly the summary Ryan described (`Verdicts.tsx:58-74`), and as of `b912b3b` it keeps the
   message collapsed behind an expander for any gate that names an artifact. **On this route Plan J
   writes no console code and no engine code — it edits one 10-line gate template.**

Whichever route: the summary Ryan specified is **pass/fail plus an issue count per reviewer, with
the issues listed only when failing**. Measured against s02e01, that is 7 lines in place of 62 —
and on a green panel, 7 lines all reading "pass · 0 issues", with `flow-check` the lone exception at
"pass · 5 issues" if advisory findings are still counted there.

### 4.4 The bug fixes itself, and the plan should say so

The gate's message is rendered **once**, immediately before `gate_opened`
(`engine/src/runner.ts:560-575`), and stored in the event. It is a snapshot. **Under Ryan's part (1)
the gate opens only on a green panel, so the snapshot is taken when the verdicts are green and the
stale-verdict bug cannot occur.** The message's remaining problem is only its length — 62 lines of
JSON that now all say "pass" — which is a readability decision, not a correctness one, and one the
console already answers by collapsing it (§7.2).

**So the whole of §4 reduces to one question for the plan:** is a 62-line JSON dump that says "pass"
seven times worth an engine change, now that the loop retires the staleness and `b912b3b` retires
the wall of text? The cheapest honest answer is route 3 of §4.3 — edit `script-gate.gate.md`, change
no code.

---

## 5 · The weekly figure per round

### 5.1 What Plan I asks, and when

`engine/src/sdk-query.ts:20-34` is the whole of it. The usage call fires **once per query and only
after a rejected limit**:

```
    if (!askedForUsage && mapped.rateLimit?.status === "rejected") {
      askedForUsage = true;
      yield await usageMessage(q);
    }
```

(`:29-32`). The call must happen inside the loop, and the module's doc comment at `:14-19` carries
the measurement: *"Measured live on 2026-10-15 against SDK 0.3.283 with a plain string prompt
(`engine/test/agent-live.test.ts`, the `usage:` test): called mid-stream it answered in 183 ms with
both windows (`available: true`); called after the same stream had ended it failed instantly."*

`usageMessage` (`:66-85`) can never reject: a missing method, a throw, or no answer within
`USAGE_CALL_TIMEOUT_MS = 10_000` (`:43`) all return `{available: false}`.

### 5.2 The log carries no weekly figure at all

**Grepped: there is not one `step_waiting` event, not one `limit` field, and not one
`weeklyUtilization` field anywhere in the s02e01 run log — nor in any of the 14 `.jsonl` files in
the instance.** All 20 `agent_result` events in the s02e01 log are `ok: true`.

The reason is structural: `agent_result`'s payload is built at `engine/src/agent-step.ts:777-790`,
and `usage` is **not among its fields**. The weekly figure reaches the log only as
`limit.weeklyUtilization` (`:709`, `:744`, `:761`) or as `step_waiting`'s payload (`:734`) — both of
which exist only when `classifyLimit` returned a limit. **On an unlimited run the figure is read
into a local (`:601`, `:622`) and discarded.**

A note of caution the plan should carry: `engine/src/agent-step.ts:324` describes "the engine's one
measured limit (the s02e01 run of 2026-10-14)", but **the s02e01 log contains no limit**. That
comment's claim is not supported by any log in the instance; the measurement it refers to was taken
in a live session that was not logged to a run file. The plan must not treat the s02e01 log as a
sample of limit behaviour.

### 5.3 What asking on every query costs, and what attaching it costs

- **Asking on every query: 183 ms per query**, per the `sdk-query.ts:16-17` measurement, bounded at
  10 s by `:43`. Against the s02e01 panel that is 7 × 183 ms = **1.28 s added to a 374.8 s round, or
  0.34 %**, and because the panel runs at concurrency 7 the seven calls overlap, so the round's wall
  time grows by roughly one 183 ms call. Against the whole write phase (20 queries excluding
  `revise`'s resumes, plus 12 `draft` iterations) it is under 6 s. **The cost is negligible and the
  plan can state it as measured.**
- **Attaching it to `agent_result`**: one spread into the payload at
  `engine/src/agent-step.ts:777-790`, mirroring the `limit` spread at `:786`. The `usage` local is
  already in scope (`:601`, assigned at `:622`).
- **How the loop reads the latest figure**: `RunContext.events` already carries the whole log as
  read so far (`engine/src/steps.ts:27-31`), explicitly so that "a guard that needs history … reads
  it here rather than opening the log itself." So a guard or a reset trigger scans backwards for the
  most recent `agent_result` carrying a weekly figure. **No new plumbing.**

### 5.4 The `allowed_warning` events — a free source, with one unknown

**The field exists on every event, whatever its status.** `SDKRateLimitInfo`
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5586-5598`) declares `status: 'allowed' |
'allowed_warning' | 'rejected'`, `rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' |
'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'`, and **`utilization?: number`** — the
figure is not conditioned on the status.

**The engine already captures it with no status check.** `engine/src/agent-step.ts:616-621`:

```
            if (m.rateLimit !== undefined) {
              rateLimit = m.rateLimit;
              if (m.rateLimit.status === "rejected") rejected = m.rateLimit;
              if (isAccountWeeklyWindow(m.rateLimit.window) && typeof m.rateLimit.utilization === "number" && Number.isFinite(m.rateLimit.utilization)) {
                weeklyFromEvent = m.rateLimit.utilization;
              }
            }
```

`isAccountWeeklyWindow` (`:383-385`) accepts **only** `"seven_day"`; the per-model windows are
deliberately excluded, and `:372-382` writes out why (a `seven_day_opus` event at 90 % would block a
wait the account window at 20 % allows). `weeklyFigure` (`:347-351`) prefers this stream source over
the usage call and records which answered.

**So yes — the stream's events are a free source, and the engine already reads them. The gap is
only that the figure is never written to the log.** Attaching `usage` to every `agent_result`
(§5.3) would also make this source visible, with no extra call at all.

**The one unknown, stated as unknown.** Whether an *ordinary, unlimited* query carries a seven-day
`rate_limit_event` at all is **not measurable from any log in the instance**, because the engine
never emits those events. `engine/test/agent-live.test.ts:63-66` and `:86` were written to collect
exactly this ("whether the SDK sends one on an ordinary query is a thing only a real session shows")
and `console.log` the array — but the result is printed, not asserted, and **appears nowhere in Plan
I's record**, whose deferred list says instead: *"Any warning before a limit lands.
`rate_limit_info.status` carries `allowed_warning`, and nothing reads it. The engine learns about a
limit when the limit happens."* **Plan J must re-run that probe before it can rely on the free
source**, and keep the 183 ms usage call as the fallback.

---

## 6 · The convergence risk

### 6.1 A reviewer re-fails the same resolved issue

**The mechanism that would prevent it exists; the handoff does not.** §3.3 measured that six of
seven reviewers see no prior verdict, and §1.4 measured that the reset that re-runs the panel also
deletes each reviewer's result from `ctx.results` (`engine/src/state.ts:59`). So a re-run reviewer
reads the revised script cold and re-derives its own list.

Ryan's part (3) asks for both halves: the reviewer sees its own previous verdict, and judges whether
the *issue* is resolved rather than whether the scene is perfect. Needed: a per-prior-issue
**resolved/unresolved** field in the schema, and a prompt source for the prior verdict that survives
the reset — the log, not `ctx.results` (§3.3).

**The risk is concentrated in the nine judgment-with-a-law issues of §3.4**, where "is this
resolved" has no test. The 14 measurable ones settle themselves: a 41-word sentence split into two
is 41 words no longer, and `repetition-check` can re-count.

### 6.2 Two reviewers whose fixes conflict — measured on s02e01

**This is not hypothetical; the s02e01 verdicts already contain the collision.**

- `tone-check` issue 6 cites `Canon/style-guide.md:55-58`'s analogy ration — "two separate
  similes/analogies land in the same scene, doubling the ration" — and the fix is to cut one.
- `repetition-check` issue 1 names the "the way X did Y" construction 13 times and prescribes "keep
  ~2-3 load-bearing instances (**Veleth's seal-reading simile L39, Trent's tide-line simile
  L321**)" — naming two similes to **keep**.
- `tone-check` issue 8 quotes Scene Nine's "He looked at the screen the way a man looks at a tide
  line higher than his house" as part of a head-hop defect — the same L321 tide-line simile
  `repetition-check` protects.

So one reviewer protects a simile the other's law makes surplus. Needed: a precedence rule between
reviewers, or — because `revise.md:6-12` hands the writer **all seven verdicts at once** (§6.3) — an
instruction to the writer about what to do when two findings disagree. Today the writer has neither.

### 6.3 The writer and the sentinel

**The writer already receives every verdict in one prompt**, which is what Ryan's convergence
requirement asks for: `revise.md:6-12` renders all seven as `{{results.<id>}}`, and `:14-15` tells
it the `deviations` list is the showrunner's and not to be fixed.

The sentinel rule is `revise.md:28-32`: *"When — and only when — every listed issue is resolved and
the script still reads in the register … output exactly: REVISIONS_COMPLETE."* The second conjunct
is a judgment the writer makes about its own prose.

**The measured failure is the writer withholding the sentinel, not declaring it falsely** (§2.5).
Iteration 1 did 48 tool calls of real work and did not emit it; iterations 2 and 3 did nothing at
all and did not emit it; the loop failed at its cap; and one fresh iteration after Resume emitted it
in 6 tool calls. Under Ryan's part (1) the panel is the test of whether the revision worked, so
**the sentinel stops being the thing that decides anything** — a false `REVISIONS_COMPLETE` is
caught by the next panel, and a withheld one costs a round. The plan must decide what `revise`'s
`maxIterations: 3` (`episode.ts:241`) means once the panel is the arbiter.

### 6.4 The repetition check scores the whole script

`repetition-check.md:13-33` audits **within the draft** by counting across the whole episode: a
construction used "2+ times" (`:14`), "the way X did Y" at ">3/episode" (`:23`), a word echo "twice
within ~3 paragraphs" (`:32-33`). Its s02e01 issue 1 lists 13 occurrences across 11 scenes and asks
for "~2-3" to remain.

**So a fix moves the count rather than clearing it**: rewriting ten of thirteen leaves three, which
satisfies the ">3/episode" ration — but the writer's ten replacements are new prose, and whatever
construction it reaches for ten times becomes the next round's finding. `repetition-check.md:35-41`
adds a cross-episode arm that compounds this, because the two most recently approved scripts are
also in scope.

Needed, per Ryan's part (3): a **measured, not judged** repetition rule — a ration stated as a
number against a named construction, so that "resolved" is a count the reviewer can re-take. The
prompt is already closest of the seven to this (it says "Grep to count"), and its pass rule
(`:45-46`) is the part that is not.

---

## 7 · The console side

### 7.1 The verdict summary Ryan described is already built

`console/src/components/Verdicts.tsx` (101 lines) draws **one chip per reviewer, pass or fail, with
the number of issues** (`:59-74`), and clicking a chip lists that reviewer's issues with a `quote`
button that writes the issue into the rejection notes (`:76-98`). `readVerdict` (`:37-42`) reads
`pass === true` and `issues`/`problems`/`findings` defensively; `issueText` (`:21-34`) handles a
string, a number, or an object with a `note`/`line`.

**That is pass/fail plus an issue count per reviewer, with the issues shown only when the reader
opens them** — Ryan's §4 summary, on the screen since Plan G.

The server builds the input structurally rather than from an id list: `console/server/gates.ts:145-152`
intersects the pipeline's schema-bearing agent steps with results shaped `{pass: …}`
(`isVerdict`, `:40-42`). So **a reviewer added to the pipeline appears on the board with no console
change** — the doc comment at `:34-36` says that is the point.

**Critically, the chips are derived live from `deriveRunState(events).results`, while the gate's
message is a snapshot taken at `gate_opened`** (§4.4). Under Plan J's loop the chips are green by
construction and correct by derivation; the message is correct because it is rendered on a green
panel. **The two cannot disagree the way they did on s02e01.**

### 7.2 What the Gate page renders at `b912b3b`, and what that commit already settled

**The gate page's wall of JSON was fixed mid-inventory, on the branch Plan J will branch from.**
Commit `b912b3b` ("console: the gate page leads with the artifact and keeps the message behind one
expander", +361/−26 across six files) reordered the page to: the attempt banners, the artifact panes
(`console/src/pages/Gate.tsx:225-226`, heading *"what the gate is about"*), the verdict board
(`:264-266`, *"what the reviewers found"*), the prior rejections (`:270-271`), the answer
(`:280-281`), and **the message last, inside one native `<details>`** (`:339-342`).

Three details of that commit bear on Plan J:

- **The expander is open by default only for a gate that names no artifact** — `open={view.artifacts.length === 0}`
  at `:339`. The script gate names the script, so its message is **collapsed** by default.
- **The collapsed summary carries the message's first line** through the new `gateSummaryLine`
  (`console/src/projections.ts:144`, with `GATE_SUMMARY_LIMIT = 140` at `:120`), rendered at
  `Gate.tsx:197` and `:340`. For s02e01 that summary is `Script drafted: Episodes/s02e01/script.md`
  — the one useful line of the 71.
- **The commit message states the same ruling Plan J implements**, from the console's side: *"The
  s02e01 script gate opened on a wall of text: the message's one useful sentence … followed by seven
  reviewers' verdicts as raw JSON, with the script itself below the fold. The decision is about the
  script, so the script is what the page opens on."*

**So the message's length is no longer a console problem, and Plan J should not re-plan the gate
page.** What `b912b3b` did *not* change is the message itself: the gate template still renders
10,618 characters of verdict JSON into the log's `gate_opened` event (§4.1), and the engine still
has no way to summarise a verdict (§4.2). Those are Plan J's, if it wants them.

### 7.3 Where the rounds and their cost would come from, and what does not exist

**No cost crosses the console's run wire — but the console does already render cost on one other
page, and that page is the precedent to copy.** Two separate measurements:

- **`console/shared/types.ts` contains no `costUsd`** (grepped: zero occurrences). Neither
  `RunView`, `EpisodeRow`, `StepRow` nor `GateView` carries a cost, so no run, Board row, step row
  or gate on the screen can show one.
- **The "what happened" page does.** `console/server/what-happened.ts:244-245` reads
  `message.total_cost_usd` off its own SDK query, records it at `:189` and `:196`, and
  `console/src/pages/WhatHappened.tsx` renders it per row at `:247` —
  `${row.costUsd.toFixed(4)} estimated` — over a running total summed at `:122`. **That cost is the
  operator's own questions to the "what happened" agent, not any pipeline step's.**

So the house style for a money figure exists (`$0.1234 estimated`, four decimals, with a total), and
what is missing is the figure for pipeline steps.

**The console server does not project `agent_result` at all.** `projectSteps`
(`console/server/runs.ts`) switches on ten event kinds — `step_started` (`:191`), `step_waiting`
(`:197`), `agent_query` (`:208`), `step_completed`/`step_cached` (`:221-222`), `step_failed`
(`:235`), `step_skipped` (`:241`), `step_reset` (`:247`), `gate_opened` (`:252`), `gate_answered`
(`:255`) — and `agent_result` is not among them. The only other reader of agent events is
`console/server/what-happened.ts:102`, which reads `agent_query` for a prompt-file row.

So "the rounds it took and their cost" is **new wire**: a sum over `agent_result.costUsd` and a
count of `step_reset` events whose `by` is the round trigger, computed server-side (the server
already reads the whole log) and carried on `GateView`. The round count has a natural source —
`step_reset` carries `{by, attempt}` (`engine/src/runner.ts:549`), one burst per round.

### 7.4 The situation line during the loop

`runSituation` (`console/src/projections.ts:422`) is Plan I's model and has a fixed vocabulary of
five subjects (`:333-337`): `"A worker is on it."`, `"A worker is on it,"` (the comma form, for a
wait whose sentence the engine continues), `"Needs you."`, `"Done."`, `"Not started."`.

Its `running` arm (`:456-470`) builds `<stepId> for <elapsed>`, appends `(iteration N of M)` from
`iterationLabel` (`:374-377`) when the in-flight row is a loop, and appends the progress clause. A
usage-limit wait outranks the working sentence (`:457-458`, reading `sleepingNote` at `:389`) — the
ruling written out at `:418-421`.

**So "tone-check, round 2 of ∞" has no source today.** `iterationLabel` reads
`StepRow.iteration = {n, max}` (`console/shared/types.ts:207`), which `projectSteps` fills from the
last `loop_iteration` since the step's last `step_started` — a **loop** step's counter. A reviewer
is an agent step and has none. A round number would be a new `StepRow` or `RunView` field, derived
from the `step_reset` bursts of §7.3, and the `∞` has no precedent in the five-subject vocabulary —
`iterationLabel`'s whole point (`:370-373`) is that "iteration 3 of 15" says how close a loop is to
exhausting its cap, and a loop with no cap has nothing to be close to.

---

## 8 · Findings

| # | Finding | Where measured | What it implies for the plan |
|---|---|---|---|
| **J-01** | **The loop Ryan ruled for is the gate-rejection path, and the script gate already names the reviewers.** `rerunOnReject: ["hand-edits-script", ...REVIEWERS]` at `engine/src/pipelines/episode.ts:247`; the closure `downstreamOf` computes is **10 steps** — `hand-edits-script`, `canon-review-script`, `canon-ledger-script`, the six reviewers, `revise`. | `episode.ts:247`, `:53`, `:116`, `:227-240`; `engine/src/pipeline.ts:21-36`; §1.4 | The plan builds a **trigger**, not a loop. Does it say so in writing, so a later reader does not look for machinery that was already there? |
| **J-02** | **Exactly one thing in the engine can re-run a set of earlier steps: a gate rejection.** `{kind: "reset"}` is produced at `engine/src/runner.ts:550` and nowhere else; `step_reset` is written at `:118` (`resetSteps`, a console route), `:146` (`withdrawApproval`, a console route) and `:549` (the gate). | `runner.ts:378`, `:550`, `:118`, `:146`, `:549`; §1.1, §1.3 | Which of §1.6's three options? Option (a) reuses a path that is built, tested and already drawn by the console. |
| **J-03** | **A guard cannot restart a pass — it can only pass or fail the run.** `GuardResult` is a two-arm union (`engine/src/steps.ts:50`) and `runStep`'s guard arm maps `pass: false` to `{kind: "failed"}` (`engine/src/runner.ts:405-406`). This is why `review-gate` always passes and smuggles `"yes"`/`"no"` into its message. | `steps.ts:50-55`; `runner.ts:386-406`; `episode.ts:236-238` | A verdict-driven reset is a new step kind or a new field on an existing one. There is no way to express it with today's kinds. |
| **J-04** | **A loop body cannot be a sequence.** `LoopStep.body` is one `NestedAgentStep` (`engine/src/steps.ts:154`), all its iterations log under the loop's single id (`:150-153`), and `orderSteps` refuses a schema-bearing body (`engine/src/pipeline.ts:63-67`). | `steps.ts:148-166`; `pipeline.ts:63-67` | Option (b) of §1.6 would collapse seven reviewers into one step's history and destroy the per-reviewer verdict board (J-24). Rule it out explicitly. |
| **J-05** | **The reset's idempotence guard has no anchor for a verdict-driven round.** `runner.ts:533-535` tests for "a `step_reset` by this gate **after the last gate event**"; a round that is not triggered by a gate has no gate event to measure from, and `:546-551` warns that a reset returned without a `step_reset` written restarts the pass forever. | `runner.ts:533-551` | **The one real design problem in option (a).** What anchors round N's reset — a round counter in the payload, a `step_started` on the trigger, or the trigger's own last completion? |
| **J-06** | **One panel round costs $6.0660 and 374.8 s of wall time at concurrency 7**, against 1,487,721 ms of agent time. The wall time equals the slowest reviewer's duration (`canon-review-script`, 374,025 ms) to within 0.8 s. | §2.2, from `20261014T183337Z-8r5w.jsonl` | Rounds are priced. The panel's wall cost is `canon-review-script`'s latency, so nothing but that step's speed shortens a round. |
| **J-07** | **One review→revise round cost $15.8878 and 1,033.0 s — 21.1 % of the $75.31 write phase.** `draft` was $49.1927 (65.3 %), `revise` $9.8218, the panel $6.0660. | §2.4 | Five uncapped rounds double the write phase. The weekly quota is a real brake, not a formality — which supports Ryan's part (2) as the only stop. |
| **J-08** | **The reviewers' `costUsd` is per call; `revise`'s is cumulative.** The seven reviewers are `context: "fresh"` with distinct `sessionId`s and `resumed: false`. `revise` is `"shared"` and reported the identical `costUsd: 6.587001` on all three iterations of attempt 1 while `durationMs` fell 447355 → 352 → 328. | `episode.ts:116`, `:120`, `:243`; `engine/src/agent-step.ts:782`; §2.1 | Any cost figure the console shows must take per-session maxima for shared-session steps, or it triple-counts `revise`. |
| **J-09** | **Two reviewers failed, not three. `flow-check` passed with 5 issues.** `repetition-check` `pass: false`, 8 issues; `tone-check` `pass: false`, 15 issues; `flow-check` `pass: true`, 5 issues; the other four passed with 0. | §2.3 | `issues` and `pass` are already decoupled under a judgment pass-rule — which is the non-failing field arriving by accident, in the failing field's place (J-13). |
| **J-10** | **Six of the seven reviewer schemas are the same 366-byte file**, `{pass, verdict, issues}`, and all seven are byte-identical between `tools/templates/prompts/` and the instance. `canon-review.schema.json` alone carries a second array. | §3.1 | A new non-failing field is **six instance edits plus six template edits**, or a consolidation first. The plan should count the edits. |
| **J-11** | **`canon-review-script` is the working model for everything Ryan's part (3) asks for, and it already exists.** A mechanical pass rule (`:50`, "`pass` is true only when `issues` is empty"), a non-failing field whose contents are explicitly not to be fixed (`:43`), a required citation format (`:49-50`), and a prior-verdict handoff (`:33-34`). | `prompts/canon-review-script.md:24-51`; §3.2, §3.3 | Tighten the six by copying the seventh, rather than inventing a form. |
| **J-12** | **Six of seven pass rules are judgments.** "pass only if the script genuinely holds the register throughout" (`tone-check.md:31-32`), "Pass only if you would greenlight this for recording" (`flow-check.md:34`), "Pass only if the episode lands" (`structure-check.md:28-29`), and three more in §3.2. | §3.2 | Ryan's part (3) rewrites six pass rules. That is the whole of the prompt work, and it is independent of the engine work. |
| **J-13** | **No reviewer but the canon review has a non-failing field, and `flow-check` is already using `issues` as one.** All five of its s02e01 findings are craft advice ("worth a listen-check", "may read clipped aloud even though it's within the letter of the rule") delivered on a `pass: true` verdict. | §2.3, §3.2 | The non-failing field is not a new idea to the reviewers — it is a field they are improvising. Naming it costs one schema key and settles where `flow-check`'s five belong. |
| **J-14** | **The prior-verdict handoff mechanism is built and proven, but the reset erases its input.** `canon-review-script.md:33-34` renders `{{results.outline-gate:rejections}}` and `{{results.script-gate:rejections}}`, accumulated by `engine/src/state.ts:146-148` and seeded at `engine/src/runner.ts:247-248`. But `step_reset` deletes `s.results[id]` (`engine/src/state.ts:59`), so a reviewer's own last verdict is gone from `ctx.results` by the time it re-runs. It survives in the log, which `RunContext.events` already carries. | `engine/src/state.ts:59`, `:146-148`; `engine/src/steps.ts:27-31`; §3.3 | The handoff must read the **log**, not `{{results.<id>}}`. That is either a new template branch or a result key the trigger writes before the reset. |
| **J-15** | **The s02e01 script gate printed 10,618 characters across 71 lines, the verdicts stale by one revision.** `prompts/script-gate.gate.md` is 10 lines with eight bare `{{results.<id>}}` interpolations and no paths, byte-identical to the template. `outline-gate.gate.md:2` shows the alternative — `{{results.canon-review-outline.verdict}}`, a path. | §4.1 | The template already has a better pattern eight lines away from the worse one. |
| **J-16** | **`renderValue` pretty-prints any object, and the template language cannot express a summary.** `engine/src/prompt-template.ts:55` is `JSON.stringify(value, null, 2)`; the `results` branch (`:117-130`) resolves dotted paths only, refuses a path through an array (`:126`), and has no mapping, counting or formatting syntax. | `prompt-template.ts:48-58`, `:117-130`; §4.2 | A summary needs a new `{{...}}` form, a computed result key, or the console. §4.3 prices all three. |
| **J-17** | **Changing `review-gate`'s message would break the revise trigger silently.** `episode.ts:237` computes the all-pass message as `"yes"`/`"no"` and `:240`'s `when` reads `ctx.results["review-gate"] === "no"`. | `episode.ts:236-240`; §4.3 | The cheapest-looking route to a summary is a trap. A second guard or a second field avoids it. |
| **J-18** | **The stale-verdict bug fixes itself under Ryan's part (1).** The gate's message is rendered once, immediately before `gate_opened` (`engine/src/runner.ts:560-575`), and the gate now opens only on a green panel — so the snapshot is taken green. | `runner.ts:560-575`; §4.4 | The message's remaining problem is length, not correctness. The plan should not spend engine work on a bug the loop retires. |
| **J-19** | **The run log carries no weekly figure at all — zero in all 14 `.jsonl` files in the instance.** `agent_result`'s payload (`engine/src/agent-step.ts:777-790`) has no `usage` field; the figure reaches the log only via `limit.weeklyUtilization` or `step_waiting`, both of which require a classified limit. The `usage` local at `:601` is read at `:622` and discarded. | §5.2 | Ryan's part (2) needs the figure every round. One spread into the `agent_result` payload is the whole change. |
| **J-20** | **Asking on every query costs 183 ms, and the free stream source is already read with no status check.** The 183 ms is `sdk-query.ts:16-17`'s live measurement, bounded at 10 s by `:43`; against the panel it is 0.34 % of a round, and the seven calls overlap at concurrency 7. `SDKRateLimitInfo.utilization` is declared on every event whatever the status (`sdk.d.ts:5586-5598`) and `agent-step.ts:616-621` captures it for `"seven_day"` without testing the status. | §5.3, §5.4 | Attaching `usage` to `agent_result` surfaces **both** sources at once. But whether an unlimited query carries a seven-day event is **unmeasured** — `engine/test/agent-live.test.ts:63-66` prints it and asserts nothing, and Plan I's record does not carry the result. **Re-run that probe first.** |
| **J-21** | **The measured convergence failure is the writer withholding the sentinel, and a fresh session cured it.** On s02e01: iteration 1 did 48 tool calls and no sentinel; iterations 2 and 3 did **0 tool calls, 1 turn, under 400 ms each** and moved the session's cost not at all; the loop failed at its cap; one fresh iteration after Resume fired the sentinel in 7 turns and 6 tool calls. | §2.5, from the log at events 357-415, 464-465, 514-524 | A **shared** session can wedge and burn the cap doing nothing. Does `revise` stay `context: "shared"` with `maxIterations: 3` once the panel is the arbiter, or does the round become the iteration? |
| **J-22** | **The style guide itself licenses craft judgment, so "a law and a line" cannot be applied literally.** `Canon/style-guide.md:63-66` — "**Judgment over mechanism.** The cap serves the drama, not the reverse. A climactic build or an elegiac closing line may run long *on purpose* … Break the rule knowingly, never by accident." A 41-word sentence is a defect only if it is not a deliberate exception. | `Canon/style-guide.md:63-66`; §3.4 | **This is the measurement Ryan's open question turns on.** A measurable-only rule either deletes that clause from the guide or declares it unenforceable. |
| **J-23** | **Classified against the written laws, the 28 s02e01 issues split 14 / 9 / 5.** 14 are measurable defects (the word counts check out: 41, 35 and 38 words against `Canon/style-guide.md:59`'s ~30 cap; 3 words against `:98`'s five-word floor; `repetition-check`'s 8 all carry counts and line numbers). 9 cite a law but need judgment to reach. 5 — all of `flow-check`'s — cite no law. | §3.4 | **Measurable-only** leaves round 1 unchanged (both reviewers still fail) but makes **8 of 15 tone issues, 53 %, advisory** from round 2 on. **Judgment-allowed** keeps the guide intact and costs J-22's open termination. |
| **J-24** | **Two s02e01 reviewers already prescribe conflicting fixes on the same line.** `tone-check` issue 6 cites `Canon/style-guide.md:55`'s one-analogy-per-scene ration and asks for a cut; `repetition-check` issue 1 names "Trent's tide-line simile L321" as one of two to **keep**; `tone-check` issue 8 quotes that same tide-line simile inside a head-hop defect. | §6.2 | The conflict is real and already in the log. The writer gets all seven verdicts at once (`revise.md:6-12`) and no precedence rule. Which reviewer wins, or does the writer get an instruction? |
| **J-25** | **The console side of the ruling landed mid-inventory as `b912b3b`, and the verdict summary Ryan described was already built before it.** `console/src/components/Verdicts.tsx:58-74` draws pass/fail plus issue count per reviewer, issues on click, each with a `quote` button; the server builds its input structurally from the pipeline's schema-bearing agent steps (`console/server/gates.ts:145-152`), so **a reviewer added to the pipeline appears on the board with no console change**. `b912b3b` then moved the message last, behind one `<details>` collapsed for any gate that names an artifact (`console/src/pages/Gate.tsx:339-342`), with `gateSummaryLine` (`console/src/projections.ts:144`) carrying its first line into the summary. | §7.1, §7.2; `git show b912b3b` | **Plan J must not re-plan the gate page.** It inherits the collapse and the verdict board. What remains unfixed is the message *content* — 10,618 characters of JSON still enter the log (§4.1) — and whether that is worth engine work once J-18 retires the correctness bug. |
| **J-26** | **No cost crosses the console's run wire, and the server never projects `agent_result` — but the cost-rendering precedent exists on another page.** `console/shared/types.ts` has zero `costUsd` occurrences; `projectSteps` switches on ten event kinds (`console/server/runs.ts:191`–`:255`) and `agent_result` is not one; the only reader of agent events there is `what-happened.ts:102` (`agent_query`). Meanwhile `console/src/pages/WhatHappened.tsx:247` already renders `${row.costUsd.toFixed(4)} estimated` with a total at `:122`, from `what-happened.ts:244-245` — **the console's own query cost, not any step's**. | §7.3 | "The rounds it took and their cost" is new wire on `GateView`, summed server-side from `agent_result.costUsd` (taking per-session maxima, J-08). The round count has a source: `step_reset`'s `{by, attempt}` (`engine/src/runner.ts:549`), one burst per round. The money format is settled by precedent. |
| **J-27** | **"round 2 of ∞" has no source and no precedent.** `iterationLabel` (`console/src/projections.ts:374-377`) reads `StepRow.iteration = {n, max}` (`console/shared/types.ts:207`), filled from `loop_iteration` events — a loop step's counter, which a reviewer (an agent step) has none of. The vocabulary is five fixed subjects (`projections.ts:333-337`), and `iterationLabel`'s stated purpose (`:370-373`) is to say how close a loop is to exhausting its cap. | §7.4 | A round number is a new field. And an uncapped round has nothing to be "of" — does the line say "round 2", drop the denominator, or stay silent and let the step id carry it? |

---

## 9 · What the plan must decide

1. **Which of §1.6's three shapes carries the loop** — and if option (a), **what anchors the reset's
   idempotence guard** when no gate event precedes the round (J-05). This is the only unsolved
   engine problem in the inventory.
2. **Ryan's open question: may a reviewer fail on craft judgment?** The consequences are measured in
   §3.4 and J-22/J-23, and the decisive fact is that `Canon/style-guide.md:63-66` writes a judgment
   clause into the sentence-length law itself. Measurable-only makes 8 of 15 tone issues advisory
   and requires a change to the guide; judgment-allowed keeps the guide and leaves termination
   resting on a reviewer agreeing with itself.
3. **Where the prior verdict comes from**, given that the reset deletes it from `ctx.results`
   (J-14): a new template branch over `RunContext.events`, or a result key the trigger writes before
   it resets.
4. **Whether `revise` stays `context: "shared"` with `maxIterations: 3`** once the panel is the
   arbiter rather than the sentinel (J-21). The measured failure was a wedged shared session burning
   two thirds of the cap on 0-tool-call iterations.
5. **Which reviewer wins a conflict** (J-24), or what the writer is told when two findings on the
   same line disagree.
6. **Whether the weekly figure is read from the stream, the usage call, or both**, and **whether the
   probe at `engine/test/agent-live.test.ts:63-66` is re-run first** (J-20) — because whether an
   unlimited query carries a seven-day event is recorded nowhere.
7. **What the script gate's message says on a green panel.** J-18 retires the correctness bug and
   `b912b3b` retires the wall of text (J-25), so the only live option is route 3 of §4.3 — edit
   `prompts/script-gate.gate.md` and `tools/templates/prompts/script-gate.gate.md`, change no code.
   **Does Plan J take even that, or leave the message as it is?**
8. **What the console shows**: whether `GateView` grows a round count and a cost (J-26), and what
   the situation line says during a round with no cap (J-27). Plan J inherits the gate page's
   collapse and the verdict board from `b912b3b` and should say in writing that it does, so a later
   reader does not re-plan them.
9. **How many prompt and schema edits the plan is buying**: six instance schemas plus six templates
   for a non-failing field (J-10), six pass rules (J-12), and six prior-verdict sections, against
   `canon-review-script` as the model that needs none of them (J-11).

## 10 · How this inventory was taken

Every figure above was printed in this session from the files and the log named beside it. The run
measurements come from one file, `~/GitHub/DeadLight2/Production/s02e01/runs/20261014T183337Z-8r5w.jsonl`
(526 events), parsed with `python3 -c` scripts that printed the costs, durations, turn counts, tool
counts, timestamps and verdict payloads reproduced in §2. The word counts in §3.4 were taken with
`len(text.split())` over the sentences the reviewer quoted. The prompt and schema comparisons in
§3.1 were taken with `diff` and `diff -q` between `~/GitHub/Showrunner/tools/templates/prompts/` and
`~/GitHub/DeadLight2/prompts/`. The SDK declaration in §5.4 was read from
`~/GitHub/Showrunner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5586-5598`.

The read-only discipline, stated so it can be checked: both repositories were read with `cat`,
`sed`, `grep`, `ls`, `diff`, `wc`, `git log`, `git show`, `git diff`, `git status` and `python3 -c`,
and written by nothing. No branch was switched, no file in either repository was created or
modified, and no server was started. `~/GitHub/DeadLight2` was left on `main` at `30d4fa7` with the
same modified `showrunner.json` and the same three untracked paths (`Episodes/s02e01/outline.md`,
`Episodes/s02e01/script.md`, `Production/s02e01/`) it carried at the start.

**`~/GitHub/Showrunner` moved, and not by this inventory.** It was at `run-situation` / `c03908d`
with five modified and one untracked console file when measurement began, and at `run-situation` /
`b912b3b` with a clean working tree when it ended: the other implementer committed their work in
progress as `b912b3b` partway through. **Every console line number in §4 and §7 was re-read against
`b912b3b` after that commit landed**, and §7.2 and J-25 were rewritten from the earlier
working-tree reading to the committed one. The engine files this inventory depends on
(`engine/src/runner.ts`, `state.ts`, `steps.ts`, `pipeline.ts`, `prompt-template.ts`,
`agent-step.ts`, `sdk-query.ts`, `show-config.ts`, `pipelines/episode.ts`) are untouched by that
commit, so §1–§6's citations are unaffected by it.

**Three claims were measured as wrong or unsupported, and are corrected above rather than
repeated.** The brief for this inventory said three reviewers failed on s02e01; **two** did, and
`flow-check` passed with five issues (§2.3, J-09). `engine/src/agent-step.ts:324` describes "the
engine's one measured limit (the s02e01 run of 2026-10-14)", but **no log in the instance contains a
rate limit, a `step_waiting` or a weekly figure** (§5.2) — that measurement was taken in a live
session that reached no run file. And Plan I's record carries the usage call's 183 ms but **not** the
`rate_limit_events` array its own probe prints, so whether the free weekly source answers on an
unlimited query is recorded nowhere (§5.4, J-20).

## 11 · Change log

- **2026-10-15 — created.** Inventory taken against `Showrunner` on branch `run-situation` — begun
  at `c03908d` with the other implementer's console work uncommitted, finished at **`b912b3b`**
  after they committed it mid-session (§10, J-25) — and `DeadLight2` on `main` at `30d4fa7`.
  Twenty-seven findings, J-01 … J-27. Nothing in either repository was changed.

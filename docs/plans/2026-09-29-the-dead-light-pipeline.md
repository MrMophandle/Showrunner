# The Dead Light Pipeline Implementation Plan (Plan D of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the five Archon workflows into one typed `episode` pipeline in the engine — premise in, publishable episode out, canon absorbed — with the stage map, the three `Needs` probes, the canon reviewer of spec §2, and the runner changes the deferred records assign to Plan D; prove it end to end with fake executors and, for the deterministic steps, with a script-only exercise on the non-canon test episode `ep98`.

**Architecture:** One pipeline per episode (`engine/src/pipelines/episode.ts`, 70 steps, one run log per episode) built by a factory from the show config and the episode id, so no engine file names the show. Four runner additions make the pipeline honest: a gate's `rerunOnReject` list (a rejection resets the named steps and everything downstream, recorded as `step_reset` events), `resumeRun` for retrying a failed run (`run_resumed`), a run-wide `<gate>:rejections` result key, and `RunContext.events` so a guard can read the log. The canon reviewer is one schema and two prompt files (outline pass, script pass) whose `deviations` a script writes to `Episodes/<id>/canon-ledger.md`; provenance comes from the premise, `locked-beats.md`, the rejection notes in `ctx.results`, and a `hand-edits` guard that compares recorded output hashes with disk. The show repository gains the reviewer prompts, a `## Cast` section in outlines (the `NEEDS_REFS` source), a `source` field on shots (the `NEEDS_IMAGES` source), and the smoothed rejection prompts.

**Tech Stack:** TypeScript 5 (strict, ESM, `NodeNext`), vitest 2, Node ≥ 22 for `engine/`; Python 3 with `uv` and pytest for `scripts/`; the show's prompts are Markdown and JSON Schema draft-07.

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` — §0 (what it does; the eight gates; `NEEDS_IDEA`, `NEEDS_REFS`, `NEEDS_IMAGES`), §1 (ordering rules 1.1–1.3), §2 (the canon reviewer and the provenance rule), §3 (the stage vocabulary; `NEEDS_IMAGES` derived from `prompts.json`'s `source`; `NEEDS_REFS` between SCRIPT and DRAFT_CASTING), §4.4 (fences), §6 (the core model: declared inputs, skipped ≠ failed, the log is the source of truth, §6.7 disk-derived loop progress, §6.9 restart), §7.1 (the review panel). **The inventory this plan is written from:** `docs/plans/2026-09-29-plan-d-inventory.md` — every node typed (§1), the stage map (§2), the probes (§3), the gates and their re-run sets (§4), the canon reviewer measured against the spec (§5), the loops (§6), the engine changes (§7), the first run (§8), and 21 findings (§9). **The deferred records this plan pays:** `docs/plans/2026-09-26-engine-core-deferred.md` (Plan D section), `docs/plans/2026-09-27-agent-runner-deferred.md` (Plan D section), `docs/plans/2026-09-28-show-config-and-prompts-deferred.md` (Plan D section).

**This is plan D of six.** A (engine core), B (agent runner) and C (show config and prompts) are merged to the engine's `main`. E (the console), F (cutover) and G (new-show setup) follow. **Ryan ruled 2026-09-29 that Plan D builds no command line and that the first Season 2 episode waits for Plan E, and possibly Plan G.** Plan D therefore proves the pipeline with fake executors and one script-only exercise; no agent step runs against the real show in this plan.

## Rulings on the inventory's findings (made 2026-09-29; the spec is the authority, this plan its argument)

| Finding | Ruling |
|---|---|
| F-01 `NEEDS_REFS` has no subject list before the shot list exists | **The outline declares its cast.** `prompts/outline.md` requires a `## Cast` section, one line per named character and recurring location, in the grammar `- <Name> (<tags>)` with tags from `recurring`, `guest`, `speaks`, `location`. The probe reads that section: a `recurring` name needs a reference image in the visual bible (`visual.refs`, key = the name slugged, or `the-` + slug) and, if it `speaks`, a `LOCKED` voice in the voice cast (`<audio.voiceRefsDir>/refs.json`); a `guest` that `speaks` needs a WAV in `Production/<id>/guest-refs/` whose name starts with the slug; a `location` needs the reference image only. The canon reviewer's outline pass treats a missing or incomplete `## Cast` section as an issue, so the section is enforced by the fix loop, not by the probe. `NEEDS_REFS` is reported only from SCRIPT to CASTING: `NEEDS_RULES` gains a `from` stage. The `refs-ready` guard before `tts-script` fails with the missing list, so the line stops where the spec says. |
| F-02 `prompts.json` has no `source` | **Added.** `source` is `"pipeline"` (the default when absent) or `"showrunner"`. `prompts/visual-direction.md` documents the field; `prompts/nano-banana-gate.reject.md` sets `"showrunner"` on a shot the showrunner says he will make; `nano-banana-generate.py` and `image-generate.py` skip `showrunner` shots; `image-sheet.py` marks them; the `showrunner-images` guard after `nano-banana-gate` fails while any `showrunner` shot lacks its PNG. `imagesMissing` reads the field and is reported only from AUDIO to IMAGES. |
| F-03 a rejection re-runs nothing | **A runner change: `rerunOnReject?: StepId[]` on `GateStep`.** After the fix agent completes (at once when there is none), the runner emits `step_reset` for each named step and every step downstream of it (not the gate itself), clears them from the derived state, and restarts its pass, so they re-execute before the gate reopens. A script step whose declared inputs and outputs are unchanged is served from cache, so naming a step costs nothing when the fix touched nothing it reads. |
| F-04 the two bash decisions | `outline-fix-gate` and `review-gate` are guards returning `{ pass: true, message: "yes" \| "no" }`; the `when` predicates read the message. |
| F-05 a bypassed gate never advances a stage | CANON is keyed on `canon-commit`. `validateStageMap` refuses an `approved` key naming a step that carries `when`. |
| F-06 / F-07 the draft sentinel file | **Dropped.** `.draft-complete` and `draft-complete-check` are gone: the engine already fails a loop that exhausts its cap without the sentinel text, the reviewers depend on `draft` directly, and `prompts/draft.md`'s completion section no longer writes a file. `draft` carries a `progress` probe (scene headers in `script.md` against `### Beat N` headers in `outline.md`). |
| F-08 rejection notes are out of scope for the reviewer | **A run-wide result key `<gate-id>:rejections`**: an array of every rejection note the gate has received in this run, in order, kept by `deriveRunState` and initialised to `[]` by the runner for every gate step, so a prompt may always render it. The reviewer prompts render `{{results.outline-gate:rejections}}` and `{{results.script-gate:rejections}}`. |
| F-09 hand-edit detection needs log data | **`RunContext.events`** (the run's log as read so far) and `handEdits(ctx, files)` in `engine/src/provenance.ts`: a file is hand-edited when its current hash differs from the `outputHashes` of the last `step_completed` that recorded it. Two guards, `hand-edits-outline` and `hand-edits-script`, return the list as their message for the reviewer prompts to render. Loops and gate fix agents now record `outputHashes` on completion, so the comparison has data. |
| F-10 the reviewer never edits, but the ledger must be written | The reviewer returns `deviations` in its verdict JSON; the script step `canon-ledger.py` writes `Episodes/<id>/canon-ledger.md` (rows `PENDING`). `propose` later reads the ledger and marks rows `ACCEPTED`; a canon-gate rejection may mark one `WITHDRAWN`. |
| F-11 two gates on `DRAFT_IMAGES` | Accepted. The two gate messages name their own review. |
| F-12 `HUM_DB` | Dropped; the step declares no `env`. |
| F-13 `image-audit` has no guard and is not idempotent | **The loop is unrolled** into up to three audit rounds, each a fresh schema step (`image-audit-1..3`) with a regeneration script step between rounds (`image-regenerate-1..2`, `when` the previous audit failed), closed by the `image-audit-verdict` guard. The prompt writes the bumped seed to `prompts.json` before deleting a PNG, so a re-run can tell. |
| F-14 `toolCalls` is 0 on a failed iteration | `AgentOutcome`'s failure variant carries `toolCalls`; the executor fills it; the runner writes the true number. |
| F-15 the sequential runner | **Task 10, the last task, and the one Ryan may cut**: agent steps that are ready at the same moment run concurrently, capped by `RunOptions.concurrency` (default 1), with log appends serialised so array order is file order. |
| F-16 `premise.md` vs `launch-premise.md` | `Episodes/<id>/premise.md`, as Plan C ruled. `launch-premise.md` is never read. |
| F-17 `Canon/season-2.md:18` | The sentence is corrected to say that rows marked RULED were ruled at the 2026-09-17 desk and every other row is DRAFT. |
| F-18 `audio.mainCast` | `Mute` and `Ilvaren` are added. |
| F-19 `[SPEAKER]` tags | Not needed by the probe (F-01 reads the outline); left as the production editor's convention. Recorded, not changed. |
| F-20 `Canon/README.md` lacks §5.3's rule | Added now, verbatim from the spec. |
| F-21 `season-2.md:69` cites a moved ledger line | The implementer repairs the citation only if exactly one open thread in `Canon/continuity-ledger.md` matches the row's meaning (Remo's withdrawn sighting); otherwise the row is left alone and the report says so. |

**Rulings the findings did not ask for, made so the plan is one design:**

- **One pipeline, `episode`, not four.** A run is an episode: the four Archon workflows become four phases of one step list, so ordering rules 1.1 and 1.2 are dependency edges, the stage map's `final` is unambiguous, and there is no cross-run state to merge. Step ids are unique across the whole list; the five `setup` and five `commit` nodes become named guards and named commit steps. **Cost if wrong:** an operator who wants to re-run one phase from the start uses `resetSteps` on its first step rather than launching a phase. 
- **A failed run can be resumed.** `resumeRun(log, runId)` appends `run_resumed`; the failed step and every step it swept become pending and `run()` continues. Without it every failure after a gate would re-run every agent step (agent steps have no cache) and reopen approved gates. **Cost if wrong:** two more event kinds in the vocabulary (`step_reset`, `run_resumed`) for the console to render.
- **`resetSteps(pipeline, log, runId, stepIds)` is the operator's "re-run from here"** and the same mechanism a rejection uses. 
- **Commits are one engine script, `git-commit.py`**, taking the paths and the message; the four commit messages live in the pipeline definition and name no show.
- **`publish.json` is written by a new agent step, `publish-copy`**, after script approval (the logline the old `LOGLINE` dictionary held by hand). Its prompt is new show data.
- **`tts-script` loses `Bash`.** Plan C's prompt already says a new voice is designed by the showrunner outside the step.
- **The nano-banana re-roll is mechanical:** the fix agent folds the showrunner's note into the shot's `brief` in `prompts.json` and deletes the PNG; `nano-banana-generate.py` regenerates whatever is missing. No `--only`, no `--notes` from the pipeline.
- **`prompts/index.json` is frozen as Plan C's extraction record and the extractor is not run again.** The pipeline definition in the engine is the manifest of which prompt file each step reads. `prompts/README.md` says so.
- **`STATUS.md` stamps stay** (six `status.py` steps) until Plan F retires console v1; the engine never derives a stage from the file.
- **Remotion's frame progress is not parsed** (`--log=error` stays); render progress is a Plan E concern. Recorded in the deferred record.

## Global Constraints

- **Two repositories, two branches.** Engine work is on branch `plan-d` in `~/GitHub/Showrunner` (cut from `main` at `a7e6127`; the inventory is its first commit, `143bc4a`). Show-data work is on branch `plan-d-show-data` in `~/GitHub/DeadLight`, cut from `plan-c-show-data` at `fbb8c16` (the show's Plan C branch; PR #4 into `console-operating-layer` is still open). Neither branch is merged or pushed to `main` by this plan.
- **"A script in the engine repository may not contain the name of a show"** (spec §7.4). After every engine task, `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ scripts/ render/ tools/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache` prints nothing. The pipeline definition reads directory names, file patterns, model aliases and tool lists from `ShowConfig` or from fixed engine vocabulary (`prompts/outline.md` is a prompt file name, not a show name).
- **"argv arrays, never shell strings"** (spec §4.4). Every `ScriptStep.argv` is an array; every guard that runs a program uses `execFile` with an array.
- **The event log is the source of truth.** Every new behaviour is recorded as an event before it is acted on, and `deriveRunState` is the only reader of those events for state.
- **Never declare a directory as an `inputs` or `outputs` path.** `hashFiles` streams each path; a directory throws `EISDIR` and fails the step.
- **Every commit ends with these two trailer lines, in ONE final paragraph** (use `git commit -F -` with a heredoc), in both repositories:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9`
- Engine tests: `cd ~/GitHub/Showrunner/engine && npx vitest run` and `npm run typecheck`. Script tests: `cd ~/GitHub/Showrunner/scripts && uv run pytest`. Both must be clean before every commit that touches them. At the start of this plan the engine suite is 160 passed and 2 skipped across 20 files; the scripts suite is 298 passed.
- `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` are on in `engine/`; no `any`; `.js` on intra-package imports; every exported function carries a doc comment that says why, in the register of the existing files.
- **Prompts are show data.** No engine file contains prompt text. A prompt edit in the show repository is diffed against this plan's exact wording by the task reviewer.

---

## File Structure

```
~/GitHub/Showrunner/
  engine/src/
    steps.ts                 MODIFY: EventKind + step_reset, run_resumed; RunContext.events?; GateStep.rerunOnReject?; AgentOutcome failure toolCalls?
    state.ts                 MODIFY: deriveRunState handles step_reset, run_resumed, <gate>:rejections
    pipeline.ts              MODIFY: downstreamOf(); orderSteps validates rerunOnReject ids
    runner.ts                MODIFY: reset/restart pass; resetSteps(); resumeRun(); loop sentinel resume; loop + fix-agent hashes; toolCalls on failure; rejections init; ctx.events
    agent-step.ts            MODIFY: failure outcomes carry toolCalls
    sdk-query.ts             MODIFY: the StructuredOutput drop is gated on outputFormat
    stages.ts                MODIFY: NEEDS_RULES from; validateStageMap(); StageMapError
    show-config.ts           MODIFY: formatFilename(); mixFilename()
    needs.ts                 NEW: episodeNeeds(), missingRefs(), missingShowrunnerImages(), parseCastSection()
    provenance.ts            NEW: handEdits()
    pipelines/episode.ts     NEW: episodePipeline(), EPISODE_STAGE_MAP, EpisodePipelineOptions
    index.ts                 MODIFY: export needs, provenance, pipelines/episode
  engine/test/
    state.test.ts            MODIFY: step_reset, run_resumed, rejections
    steps-types.test.ts      MODIFY: the EventKind list (18)
    pipeline.test.ts         MODIFY: downstreamOf, rerunOnReject validation
    gate.test.ts             MODIFY: rerunOnReject re-runs; reset recorded once; fix-agent outputHashes
    runner.test.ts           MODIFY: resetSteps, resumeRun, ctx.events, rejections key
    loop.test.ts             MODIFY: sentinel resume from a hand-written log; loop hashes; toolCalls on failure
    sdk-query.test.ts        MODIFY: gating
    stages.test.ts           MODIFY: window; validateStageMap
    show-config.test.ts      MODIFY: formatFilename, mixFilename
    needs.test.ts            NEW
    provenance.test.ts       NEW
    episode-pipeline.test.ts NEW: the whole pipeline with fake executors, every gate, two rejections, a failure resumed, the stage at every stop
    ep98-exercise.test.ts    NEW: env-gated (SHOWRUNNER_EP98=1): audio-mix, and build-timeline → render → master, with the real script executor
    concurrency.test.ts      NEW (Task 11)
  scripts/
    git-commit.py            NEW
    canon-ledger.py          NEW
    populator-check.py       MODIFY: --report-only
    nano-banana-generate.py  MODIFY: skip source=showrunner; exit 0 on NANO_PARTIAL
    image-generate.py        MODIFY: skip source=showrunner
    image-sheet.py           MODIFY: mark source=showrunner shots
    tests/test_git_commit.py, tests/test_canon_ledger.py  NEW; test_populator_check.py, test_nano_banana_generate.py, test_image_sheet.py MODIFY
  tools/show-data/deadlight-check-context.json  MODIFY: sample results for the new variables
  README.md                  MODIFY: "The episode pipeline" section; resume contract additions; the two new event kinds
  docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md  NEW (written at the end, by the controller)

~/GitHub/DeadLight/  (branch plan-d-show-data)
  prompts/canon-review-outline.md, canon-review-script.md, canon-review.schema.json   NEW
  prompts/outline-canon-check.md, outline-canon-check.schema.json, continuity-check.md, continuity-check.schema.json   DELETE
  prompts/image-audit.md (rewritten), image-audit.schema.json (NEW), publish-copy.md (NEW)
  prompts/outline.md, draft.md, visual-direction.md, tts-script.md, propose.md, outline-revise.md, revise.md   MODIFY
  prompts/outline-gate.gate.md, script-gate.gate.md, image-gate.gate.md, final-gate.gate.md, canon-gate.gate.md   MODIFY
  prompts/audio-gate.reject.md, final-gate.reject.md, image-gate.reject.md, nano-banana-gate.reject.md   MODIFY (rewritten)
  prompts/README.md          MODIFY
  showrunner.json            MODIFY: audio.mainCast
  Canon/README.md            MODIFY: the §5.3 rule
  Canon/season-2.md          MODIFY: line 18; line 69's citation if unambiguous
```

---

## Task 1: Two event kinds and the state they derive

**Files:**
- Modify: `engine/src/steps.ts:5-11` (EventKind), `engine/src/steps.ts:16-26` (RunContext), `engine/src/steps.ts:94-103` (GateStep), `engine/src/steps.ts:136-138` (AgentOutcome)
- Modify: `engine/src/state.ts:31-111`
- Test: `engine/test/state.test.ts`, `engine/test/steps-types.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `EventKind` gains `"step_reset"` and `"run_resumed"` (18 kinds). `RunContext.events?: readonly Event[]`. `GateStep.rerunOnReject?: StepId[]`. `AgentOutcome` failure variant `{ ok: false; error: string; toolCalls?: number }`. `deriveRunState` keeps `results["<gateId>:rejections"]: string[]`.

- [ ] **Step 1: Write the failing state tests**

Append to `engine/test/state.test.ts`:

```ts
describe("step_reset and run_resumed", () => {
  const ev = (kind: string, stepId: string | undefined, payload: Record<string, unknown> = {}) =>
    ({ ts: "t", runId: "r", ...(stepId ? { stepId } : {}), kind: kind as Event["kind"], payload }) as Event;

  it("a step_reset returns the step to pending and drops its result", () => {
    const s = deriveRunState([
      ev("run_started", undefined), ev("step_started", "a"), ev("step_completed", "a", { result: "one" }),
      ev("step_reset", "a", { by: "g", attempt: 1 }),
    ]);
    expect(s.steps["a"]).toBeUndefined();
    expect(s.results["a"]).toBeUndefined();
  });

  it("a run_resumed reopens a failed run: failed and skipped steps become pending, bypassed and completed stay", () => {
    const s = deriveRunState([
      ev("run_started", undefined), ev("step_started", "a"), ev("step_completed", "a"),
      ev("step_started", "b"), ev("step_failed", "b", { error: "boom" }),
      ev("step_skipped", "c", { reason: "dependency failed: b" }), ev("step_skipped", "d", { reason: "when: false" }),
      ev("run_finished", undefined, { status: "failed" }),
      ev("run_resumed", undefined, { by: "operator" }),
    ]);
    expect(s.finished).toBe(false);
    expect(s.status).toBeUndefined();
    expect(s.steps).toEqual({ a: "completed", d: "bypassed" });
  });

  it("keeps every rejection note of a gate under <id>:rejections, in order", () => {
    const s = deriveRunState([
      ev("run_started", undefined),
      ev("gate_opened", "g", { attempt: 1, message: "m" }), ev("gate_answered", "g", { approved: false, notes: "first" }),
      ev("gate_opened", "g", { attempt: 2, message: "m" }), ev("gate_answered", "g", { approved: false, notes: "second" }),
      ev("gate_opened", "g", { attempt: 3, message: "m" }), ev("gate_answered", "g", { approved: true }),
    ]);
    expect(s.results["g:rejections"]).toEqual(["first", "second"]);
    expect(s.steps["g"]).toBe("completed");
  });
});
```

Add `import type { Event } from "../src/events.js";` at the top if the file does not already import it. In `engine/test/steps-types.test.ts`, find the assertion that pins the `EventKind` list (search for `step_cached`) and add `"step_reset"` after `"step_cached"` and `"run_resumed"` after `"run_finished"`, so the list has 18 entries.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/state.test.ts test/steps-types.test.ts`
Expected: FAIL — `step_reset` is not a known kind (a TypeScript error under `tsc -p tsconfig.test.json`, and the three new `it` blocks fail at runtime).

- [ ] **Step 3: Change the types**

In `engine/src/steps.ts`:

```ts
import type { Progress } from "./state.js";
import type { Event } from "./events.js";

export type StepId = string;

export type EventKind =
  | "run_started" | "run_finished" | "run_resumed"
  | "step_started" | "step_completed" | "step_failed" | "step_skipped" | "step_cached" | "step_reset"
  | "step_progress" | "script_line"
  | "agent_query" | "agent_tool_call" | "agent_result"
  | "loop_iteration"
  | "gate_opened" | "gate_answered"
  | "input_changed";
```

Add to `RunContext`, after `results`:

```ts
  /** The run's log as read so far — every event the runner has replayed or appended, in log
   *  order. A guard that needs history (which step last wrote a file, and with what hash) reads
   *  it here rather than opening the log itself; executors ignore it. Optional so a caller that
   *  builds a context by hand, as the tests do, need not supply one. */
  events?: readonly Event[];
```

Add to `GateStep`, after `onReject`:

```ts
  /** Steps whose work this gate's rejection invalidates. After the fix agent completes — at once,
   *  when there is none — the runner emits step_reset for each of these and for every step
   *  downstream of them (never the gate itself), clears them from the derived state, and
   *  re-executes them before the gate reopens. A script step among them whose declared inputs
   *  and outputs are unchanged on disk is served from cache, so naming a step here costs nothing
   *  when the fix touched nothing it reads. The reset is recorded once per rejection: a crash
   *  between the step_reset writes and the re-runs does not reset again on resume. */
  rerunOnReject?: StepId[];
```

Change `AgentOutcome`:

```ts
export type AgentOutcome =
  | { ok: true; text: string; verdict?: unknown; toolCalls: number }
  /** toolCalls on a failure is the count made before the failure — the number that tells a
   *  loop iteration that failed after real work apart from one that did nothing (spec §6.7). */
  | { ok: false; error: string; toolCalls?: number };
```

- [ ] **Step 4: Derive the new state**

In `engine/src/state.ts`, inside the `switch`:

```ts
      case "run_resumed":
        // A failed run reopened by resumeRun(): the failure and everything it swept become
        // pending again, and the run is no longer finished. Completed and bypassed steps keep
        // their status — nothing about them changed.
        s.finished = false;
        delete s.status;
        for (const [stepId, st] of Object.entries(s.steps)) {
          if (st === "failed" || st === "skipped") delete s.steps[stepId];
        }
        break;
      case "step_reset":
        // Written by a gate rejection (payload.by is the gate) or by resetSteps (payload.by is
        // "operator"): the step's work is invalidated, so it returns to pending and its result
        // leaves ctx.results until it completes again.
        if (id) {
          delete s.steps[id];
          delete s.results[id];
          if (s.position?.stepId === id) delete s.position;
        }
        break;
```

In the `gate_answered` case's rejected branch, before `s.steps[id] = "running";`:

```ts
            // Every rejection note the gate has received in this run, in order, under a key a
            // later step may render: the canon reviewer's provenance rule (spec §2.3) needs them
            // after the gate's own fix agent has come and gone.
            const key = `${id}:rejections`;
            const prior = Array.isArray(s.results[key]) ? (s.results[key] as unknown[]) : [];
            s.results[key] = [...prior, String(e.payload["notes"] ?? "")];
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: PASS (163 passed, 2 skipped) and a silent typecheck. If `steps-types.test.ts` pins the count as a number, update it to 18.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/steps.ts engine/src/state.ts engine/test/state.test.ts engine/test/steps-types.test.ts
git commit -F - <<'EOF'
engine: step_reset and run_resumed events; <gate>:rejections; RunContext.events

Two event kinds the pipeline's gates and the operator's retry need: a
step_reset returns a step to pending and drops its result, and a
run_resumed reopens a failed run so the failed and swept steps run again.
deriveRunState also keeps every rejection note of a gate under
<gate>:rejections, which is how the canon reviewer learns what the
showrunner asked for. GateStep gains rerunOnReject and RunContext gains
the run's events; the runner honours both in the next task.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---
## Task 2: The runner honours `rerunOnReject`, and a run can be reset or resumed

**Files:**
- Modify: `engine/src/pipeline.ts` (add `downstreamOf`; validate `rerunOnReject` ids in `orderSteps`)
- Modify: `engine/src/runner.ts:98-183` (`execute`'s pass becomes restartable), `:196-215` (`StepOutcome`, `runStep`), `:286-342` (`runGateStep`), plus two new exported functions
- Test: `engine/test/pipeline.test.ts`, `engine/test/gate.test.ts`, `engine/test/runner.test.ts`

**Interfaces:**
- Consumes: `step_reset`, `run_resumed`, `GateStep.rerunOnReject` from Task 1.
- Produces: `downstreamOf(p: Pipeline, ids: StepId[]): StepId[]` (the ids plus every transitive dependent, in pipeline order); `resetSteps(pipeline: Pipeline, log: EventLog, runId: string, stepIds: StepId[], by?: string): Promise<StepId[]>`; `resumeRun(log: EventLog, runId: string, by?: string): Promise<void>`; the runner initialises `ctx.results["<gateId>:rejections"] = []` for every gate step.

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/pipeline.test.ts`:

```ts
describe("downstreamOf", () => {
  const p: Pipeline = { name: "p", steps: [
    { kind: "guard", id: "a", check: () => ({ pass: true }) },
    { kind: "guard", id: "b", dependsOn: ["a"], check: () => ({ pass: true }) },
    { kind: "guard", id: "c", dependsOn: ["a"], check: () => ({ pass: true }) },
    { kind: "guard", id: "d", dependsOn: ["b", "c"], check: () => ({ pass: true }) },
    { kind: "guard", id: "e", check: () => ({ pass: true }) },
  ] };
  it("returns the named steps and every transitive dependent, in pipeline order", () => {
    expect(downstreamOf(p, ["b"])).toEqual(["b", "d"]);
    expect(downstreamOf(p, ["a"])).toEqual(["a", "b", "c", "d"]);
    expect(downstreamOf(p, ["e", "c"])).toEqual(["c", "d", "e"]);
  });
  it("refuses an unknown id", () => {
    expect(() => downstreamOf(p, ["zz"])).toThrow(/unknown step "zz"/);
  });
  it("orderSteps refuses a gate whose rerunOnReject names an unknown step", () => {
    const bad: Pipeline = { name: "p", steps: [{ kind: "gate", id: "g", message: () => "m", rerunOnReject: ["nope"] }] };
    expect(() => orderSteps(bad)).toThrow(/gate "g" names unknown step "nope" in rerunOnReject/);
  });
});
```

Add `downstreamOf` to the file's import from `../src/pipeline.js`.

Append to `engine/test/gate.test.ts`:

```ts
describe("rerunOnReject", () => {
  async function rerunSetup() {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const calls: string[] = [];
    const executors: Executors = {
      script: async (step) => { calls.push(step.id); return { ok: true, result: `${step.id} ok` }; },
      agent: async (step) => { calls.push(step.id); return { ok: true, text: "done", toolCalls: 1 }; },
    };
    const steps: Pipeline["steps"] = [
      { kind: "script", id: "make", argv: () => ["true"] },
      { kind: "agent", id: "review", dependsOn: ["make"], promptFile: "r.md", model: "m", allowedTools: [], context: "fresh" },
      { kind: "script", id: "side", argv: () => ["true"] },
      { kind: "gate", id: "g", dependsOn: ["review", "side"], message: () => "ok?", maxAttempts: 3,
        onReject: { kind: "agent", id: "fix", promptFile: "f.md", model: "m", allowedTools: [], context: "fresh" },
        rerunOnReject: ["make"] },
      { kind: "script", id: "after", dependsOn: ["g"], argv: () => ["true"] },
    ];
    const pipeline: Pipeline = { name: "p", steps };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    return { pipeline, log, ctx, executors, calls };
  }

  it("re-runs the named steps and their dependents after the fix agent, then reopens the gate", async () => {
    const { pipeline, log, ctx, executors, calls } = await rerunSetup();
    await run({ pipeline, ctx, log, executors });
    expect(calls).toEqual(["make", "review", "side"]);
    await answerGate(log, "r1", "g", { approved: false, notes: "again" });
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    // fix first, then make and review again; side is not downstream of make and does not re-run
    expect(calls).toEqual(["make", "review", "side", "fix", "make", "review"]);
    const events = await log.read();
    const resets = events.filter((e) => e.kind === "step_reset").map((e) => [e.stepId, e.payload["by"]]);
    expect(resets).toEqual([["make", "g"], ["review", "g"]]);
    // the re-executions are new step_started events following the old ones, per the resume contract
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "make")).toHaveLength(2);
    // the gate itself is never reset
    expect(events.some((e) => e.kind === "step_reset" && e.stepId === "g")).toBe(false);
  });

  it("records the reset once per rejection: a crash after the resets does not reset again", async () => {
    const { pipeline, log, ctx, executors, calls } = await rerunSetup();
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "again" });
    // Simulate the crash: run once, then truncate the log to just after the two step_reset events.
    await run({ pipeline, ctx, log, executors });
    const events = await log.read();
    const lastReset = events.map((e) => e.kind).lastIndexOf("step_reset");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(log.path, events.slice(0, lastReset + 1).map((e) => JSON.stringify(e)).join("\n") + "\n");
    calls.length = 0;
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    expect(calls).toEqual(["make", "review"]);
    expect((await log.read()).filter((e) => e.kind === "step_reset")).toHaveLength(2);
  });

  it("resets at once when the gate has no fix agent", async () => {
    const { log, ctx, executors, calls } = await rerunSetup();
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "script", id: "make", argv: () => ["true"] },
      { kind: "gate", id: "g", dependsOn: ["make"], message: () => "ok?", rerunOnReject: ["make"] },
    ] };
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "no" });
    await run({ pipeline, ctx, log, executors });
    expect(calls).toEqual(["make", "make"]);
  });
});
```

Append to `engine/test/runner.test.ts` (inside `describe("run")` or a new describe; it needs `resetSteps`, `resumeRun`, `deriveRunState` imported):

```ts
  it("initialises <gate>:rejections to an empty array so a prompt can always render it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const seen: unknown[] = [];
    const executors: Executors = {
      script: async () => ({ ok: true }),
      agent: async (_s, ctx) => { seen.push(ctx.results["g:rejections"]); return { ok: true, text: "t", toolCalls: 0 }; },
    };
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "agent", id: "a", promptFile: "a.md", model: "m", allowedTools: [], context: "fresh" },
      { kind: "gate", id: "g", dependsOn: ["a"], message: () => "m" },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors });
    expect(seen).toEqual([[]]);
  });

  it("hands every step the run's events so far through ctx.events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    let kinds: string[] = [];
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "guard", id: "a", check: () => ({ pass: true }) },
      { kind: "guard", id: "b", dependsOn: ["a"], check: (ctx) => { kinds = (ctx.events ?? []).map((e) => e.kind); return { pass: true }; } },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: { script: async () => ({ ok: true }), agent: async () => ({ ok: true, text: "", toolCalls: 0 }) } });
    expect(kinds).toEqual(["run_started", "step_started", "step_completed", "step_started"]);
  });

  it("resumeRun reopens a failed run and continues from the failed step", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    let fail = true;
    const executors: Executors = {
      script: async (step) => (step.id === "b" && fail ? { ok: false, error: "boom" } : { ok: true }),
      agent: async () => ({ ok: true, text: "", toolCalls: 0 }),
    };
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "script", id: "a", argv: () => ["true"] },
      { kind: "script", id: "b", dependsOn: ["a"], argv: () => ["true"] },
      { kind: "script", id: "c", dependsOn: ["b"], argv: () => ["true"] },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "failed", stepId: "b", error: "boom" });
    await expect(resumeRun(log, "r2")).rejects.toThrow(/run id mismatch/);
    fail = false;
    await resumeRun(log, "r1", "showrunner");
    await expect(resumeRun(log, "r1")).rejects.toThrow(/not failed/);
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "completed" });
    const events = await log.read();
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "a")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "b")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "run_finished")).toHaveLength(2);
    expect(events.find((e) => e.kind === "run_resumed")?.payload).toEqual({ by: "showrunner" });
  });

  it("resetSteps returns the named steps and their dependents to pending, reopening a finished run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const calls: string[] = [];
    const executors: Executors = { script: async (step) => { calls.push(step.id); return { ok: true }; }, agent: async () => ({ ok: true, text: "", toolCalls: 0 }) };
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "script", id: "a", argv: () => ["true"] },
      { kind: "script", id: "b", dependsOn: ["a"], argv: () => ["true"] },
      { kind: "script", id: "c", argv: () => ["true"] },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    await run({ pipeline, ctx, log, executors });
    expect(await resetSteps(pipeline, log, "r1", ["a"])).toEqual(["a", "b"]);
    calls.length = 0;
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "completed" });
    expect(calls).toEqual(["a", "b"]);
    const resets = (await log.read()).filter((e) => e.kind === "step_reset");
    expect(resets.map((e) => e.payload)).toEqual([{ by: "operator" }, { by: "operator" }]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/pipeline.test.ts test/gate.test.ts test/runner.test.ts`
Expected: FAIL — `downstreamOf`, `resetSteps`, `resumeRun` are not exported; the rerun tests see `calls` without the re-executions.

- [ ] **Step 3: `downstreamOf` and the validation in `pipeline.ts`**

Add after `nestedIdsOf`:

```ts
/** The named steps plus every step that depends on one of them, transitively, in pipeline order.
 *  This is what a gate rejection resets and what an operator's "re-run from here" re-runs: a
 *  step whose input was remade cannot keep a result computed from the old one. */
export function downstreamOf(p: Pipeline, ids: StepId[]): StepId[] {
  const known = new Set(p.steps.map((s) => s.id));
  for (const id of ids) {
    if (!known.has(id)) throw new PipelineError(`unknown step ${JSON.stringify(id)} in pipeline ${p.name}`);
  }
  const marked = new Set<StepId>(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of p.steps) {
      if (marked.has(s.id)) continue;
      if ((s.dependsOn ?? []).some((d) => marked.has(d))) { marked.add(s.id); grew = true; }
    }
  }
  return p.steps.filter((s) => marked.has(s.id)).map((s) => s.id);
}
```

In `orderSteps`, after the `dependsOn` validation loop:

```ts
  for (const s of p.steps) {
    if (s.kind !== "gate") continue;
    for (const r of s.rerunOnReject ?? []) {
      if (!byId.has(r)) throw new PipelineError(`gate ${JSON.stringify(s.id)} names unknown step ${JSON.stringify(r)} in rerunOnReject`);
    }
  }
```

- [ ] **Step 4: The runner**

In `engine/src/runner.ts`:

1. Import `downstreamOf` alongside `orderSteps`, and `type Event` is already imported.

2. Add the two exported functions after `answerGate`:

```ts
/** Reopens a failed run: appends run_resumed, after which deriveRunState returns the failed step
 *  and every step it swept to pending and the next run() continues from there. Only a run whose
 *  log ends failed can be resumed; a completed run has nothing to continue and a running one is
 *  not finished. */
export async function resumeRun(log: EventLog, runId: string, by?: string): Promise<void> {
  const state = deriveRunState(await log.read());
  if (state.runId !== runId) {
    throw new Error(`run id mismatch: the log at ${log.path} is run ${JSON.stringify(state.runId)}, not ${JSON.stringify(runId)}`);
  }
  if (!state.finished || state.status !== "failed") throw new Error(`run ${runId} is not failed, so there is nothing to resume`);
  await log.append({ runId, kind: "run_resumed", payload: by !== undefined ? { by } : {} });
}

/** The operator's "re-run from here": returns the named steps and every step downstream of them
 *  to pending, so the next run() re-executes them (a script step whose inputs and outputs are
 *  unchanged is served from cache). A finished run is reopened first, with run_resumed, or the
 *  resets would change nothing. Returns the ids that were reset, in pipeline order. */
export async function resetSteps(pipeline: Pipeline, log: EventLog, runId: string, stepIds: StepId[], by = "operator"): Promise<StepId[]> {
  const state = deriveRunState(await log.read());
  if (state.runId !== runId) {
    throw new Error(`run id mismatch: the log at ${log.path} is run ${JSON.stringify(state.runId)}, not ${JSON.stringify(runId)}`);
  }
  const ids = downstreamOf(pipeline, stepIds);
  if (state.finished) await log.append({ runId, kind: "run_resumed", payload: { by } });
  for (const id of ids) await log.append({ runId, stepId: id, kind: "step_reset", payload: { by } });
  return ids;
}
```

3. In `execute`, build the context with the events and the rejections keys, and make the pass restartable. Replace from `const ctx: RunContext = { ...opts.ctx, results: { ...state.results } };` through the `return finish({ status: "completed" });` line with:

```ts
  const ctx: RunContext = { ...opts.ctx, results: { ...state.results }, events };
  // Every gate's rejection notes are renderable from the first step: an absent key is a
  // TemplateError, so the key exists as [] before any rejection has happened.
  for (const step of ordered) {
    if (step.kind === "gate") ctx.results[`${step.id}:rejections`] ??= [];
  }
  const emitFor = (stepId: StepId | undefined): Emit => async (kind, payload) => {
    await append(stepId === undefined
      ? { runId: ctx.runId, kind, payload }
      : { runId: ctx.runId, stepId, kind, payload });
  };

  // One pass over the ordered steps; a gate rejection that reset upstream steps restarts the
  // pass from the top, where the reset steps are pending again and precede the gate.
  pass: for (;;) {
    for (const step of ordered) {
      const status = state.steps[step.id] ?? "pending";
      if (status === "completed") continue;
      if (status === "failed") {
        const error = lastFailure(events, step.id);
        await sweep(step);
        return finish({ status: "failed", stepId: step.id, error });
      }
      if (status === "skipped" || status === "bypassed") continue;

      let skipReason: string | undefined;
      for (const d of step.dependsOn ?? []) {
        const ds = state.steps[d] ?? "pending";
        if (ds === "failed") { skipReason = `dependency failed: ${d}`; break; }
        if (ds === "skipped") { skipReason = `dependency skipped: ${d}`; break; }
      }
      if (skipReason) {
        await emitFor(step.id)("step_skipped", { reason: skipReason });
        state.steps[step.id] = "skipped";
        continue;
      }

      if (step.when && !(await step.when(ctx))) {
        await emitFor(step.id)("step_skipped", { reason: BYPASS_REASON });
        state.steps[step.id] = "bypassed";
        continue;
      }

      const outcome = await runStep(step, ctx, emitFor, executors, events, [...priorEvents, events], pipeline);
      if (outcome.kind === "completed") {
        state.steps[step.id] = "completed";
        if (outcome.result !== undefined) ctx.results[step.id] = outcome.result;
        continue;
      }
      if (outcome.kind === "waiting") return { status: "waiting", gate: outcome.gate };
      if (outcome.kind === "reset") {
        for (const id of outcome.stepIds) { delete state.steps[id]; delete ctx.results[id]; }
        continue pass;
      }
      state.steps[step.id] = "failed";
      await sweep(step);
      return finish({ status: "failed", stepId: step.id, error: outcome.error });
    }
    return finish({ status: "completed" });
  }
```

Keep the existing comments on the dependency check and the `when` check (they were elided above for length; carry them over verbatim).

4. `StepOutcome` gains a variant, and `runStep`/`runGateStep` take the pipeline:

```ts
type StepOutcome =
  | { kind: "completed"; result?: unknown }
  | { kind: "failed"; error: string }
  | { kind: "waiting"; gate: GateState }
  /** A gate rejection reset these steps; the pass restarts so they run before the gate reopens. */
  | { kind: "reset"; stepIds: StepId[] };
```

`runStep(step, ctx, emitFor, executors, events, allLogs, pipeline: Pipeline)` passes `pipeline` to `runGateStep(step, ctx, emit, executors, emitFor, events, pipeline)`.

5. In `runGateStep`, after the `if (step.onReject && !fixAlreadyDone) { … }` block and still inside `if (lastAnswer) { … }`:

```ts
    // The rejection invalidates the named steps' work. Recorded once per rejection: a crash after
    // these writes and before the re-runs finish must not reset again on resume, or the re-runs
    // would be re-run.
    const resetAlreadyDone = events.slice(lastGateAt + 1)
      .some((e) => e.kind === "step_reset" && e.payload["by"] === step.id);
    if (step.rerunOnReject && step.rerunOnReject.length > 0 && !resetAlreadyDone) {
      const stepIds = downstreamOf(pipeline, step.rerunOnReject).filter((id) => id !== step.id);
      for (const id of stepIds) await emitFor(id)("step_reset", { by: step.id, attempt: attempts });
      return { kind: "reset", stepIds };
    }
```

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: PASS (170 passed, 2 skipped), typecheck silent. The existing gate tests still pass: a gate without `rerunOnReject` behaves as before.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/pipeline.ts engine/src/runner.ts engine/test/pipeline.test.ts engine/test/gate.test.ts engine/test/runner.test.ts
git commit -F - <<'EOF'
engine: gate rejections re-run their steps; resetSteps and resumeRun

A gate's rerunOnReject names the steps a rejection invalidates; after the
fix agent the runner emits step_reset for them and everything downstream,
restarts its pass, and re-executes them before the gate reopens — the
sentence the rewritten rejection prompts promise. The same mechanism is
exported as resetSteps for an operator's "re-run from here", and
resumeRun reopens a failed run so the failed step and its sweep run
again without re-running every agent step of the episode.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---

## Task 3: Loop resume after a sentinel, hashes on loops and fix agents, true tool counts on failure, and the verdict-tool gate

**Files:**
- Modify: `engine/src/runner.ts` (`runLoopStep`, `runGateStep`'s fix-agent emits, `runAgentStep`'s failure emit)
- Modify: `engine/src/agent-step.ts:270-290` (failure outcomes carry `toolCalls`)
- Modify: `engine/src/sdk-query.ts` (`toAgentMessage(m, dropVerdictTool)`)
- Test: `engine/test/loop.test.ts`, `engine/test/gate.test.ts`, `engine/test/agent-step.test.ts`, `engine/test/sdk-query.test.ts`

**Interfaces:**
- Consumes: `AgentOutcome` failure `toolCalls?` from Task 1.
- Produces: a loop's `step_started` carries `inputHashes` and its `step_completed` carries `inputHashes`, `outputHashes`; a loop resumed after its last `loop_iteration` recorded `sentinel: true` completes without calling the body, with `resumedAfterSentinel: true` on the completion; a fix agent's `step_started` carries `inputHashes` and its `step_completed` carries `outputHashes`; `loop_iteration` on a failure carries the true `toolCalls`; `toAgentMessage(m, dropVerdictTool = false)` drops the `StructuredOutput` block only when asked, and `sdkQuery` asks when `options.outputFormat` is set.

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/loop.test.ts` (it already has a `setup`-style helper and hand-written-log tools; reuse them, or copy the `writeCrashLog` helper from `engine/test/e2e.test.ts`):

```ts
  it("resumes a loop whose last iteration recorded the sentinel by completing it without running the body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const logPath = EventLog.logPath(root, "s02e01", "r1");
    await writeCrashLog(logPath, [
      { runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } },
      { runId: "r1", stepId: "loop", kind: "step_started", payload: { kind: "loop", body: "body", until: "DONE", max: 3 } },
      { runId: "r1", stepId: "loop", kind: "agent_result", payload: { ok: true, toolCalls: 2, text: "all DONE" } },
      { runId: "r1", stepId: "loop", kind: "loop_iteration", payload: { iteration: 1, max: 3, sentinel: true, toolCalls: 2 } },
      // crashed here, before step_completed
    ]);
    let bodyCalls = 0;
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "loop", id: "loop", until: "DONE", maxIterations: 3, body: { kind: "agent", id: "body", promptFile: "b.md", model: "m", allowedTools: [], context: "fresh" } },
    ] };
    const r = await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: new EventLog(logPath),
      executors: { script: async () => ({ ok: true }), agent: async () => { bodyCalls++; return { ok: true, text: "DONE", toolCalls: 1 }; } } });
    expect(r).toEqual({ status: "completed" });
    expect(bodyCalls).toBe(0);
    const done = (await new EventLog(logPath).read()).find((e) => e.kind === "step_completed" && e.stepId === "loop");
    expect(done?.payload).toMatchObject({ result: "all DONE", iterations: 1, resumedAfterSentinel: true });
  });

  it("hashes the loop's declared inputs on start and outputs on completion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    await writeFile(path.join(root, "in.md"), "in");
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "loop", id: "loop", until: "DONE", maxIterations: 2, inputs: ["in.md"], outputs: ["out.md"],
        body: { kind: "agent", id: "body", promptFile: "b.md", model: "m", allowedTools: [], context: "fresh" } },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log,
      executors: { script: async () => ({ ok: true }), agent: async (_s, ctx) => { await writeFile(path.join(ctx.showRoot, "out.md"), "out"); return { ok: true, text: "DONE", toolCalls: 1 }; } } });
    const events = await log.read();
    const started = events.find((e) => e.kind === "step_started" && e.stepId === "loop");
    const done = events.find((e) => e.kind === "step_completed" && e.stepId === "loop");
    expect(Object.keys(started?.payload["inputHashes"] as object)).toEqual(["in.md"]);
    expect(typeof (done?.payload["outputHashes"] as Record<string, unknown>)["out.md"]).toBe("string");
  });

  it("records the true tool count on a failed iteration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "loop", id: "loop", until: "DONE", maxIterations: 2, body: { kind: "agent", id: "body", promptFile: "b.md", model: "m", allowedTools: [], context: "fresh" } },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log,
      executors: { script: async () => ({ ok: true }), agent: async () => ({ ok: false, error: "idle timeout after 5ms", toolCalls: 4 }) } });
    const it1 = (await log.read()).find((e) => e.kind === "loop_iteration");
    expect(it1?.payload).toMatchObject({ iteration: 1, sentinel: false, toolCalls: 4, error: "idle timeout after 5ms" });
  });
```

Append to `engine/test/gate.test.ts`, inside `describe("gates")`:

```ts
  it("records the fix agent's output hashes on its completion", async () => {
    const { log, ctx, executors } = await setup();
    const fix: AgentStep = { kind: "agent", id: "fix", promptFile: "fix.md", model: "m", allowedTools: [], context: "fresh", outputs: ["draft.md"] };
    const pipeline: Pipeline = { name: "p", steps: [{ kind: "gate", id: "g", message: () => "?", onReject: fix }] };
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "n" });
    await writeFile(path.join(ctx.showRoot, "draft.md"), "edited by the fix agent");
    await run({ pipeline, ctx, log, executors });
    const done = (await log.read()).find((e) => e.kind === "step_completed" && e.stepId === "fix");
    expect(typeof (done?.payload["outputHashes"] as Record<string, unknown>)["draft.md"]).toBe("string");
  });
```

In `engine/test/agent-step.test.ts`, find the test that exercises an error result (subtype `error_max_turns` or similar) and add an assertion that the outcome carries `toolCalls` equal to the number of `tool_use` blocks the fake stream yielded; if no such test exists, add one that yields two `tool_use` blocks and then a result with `subtype: "error_during_execution"` and expects `{ ok: false, toolCalls: 2 }`.

In `engine/test/sdk-query.test.ts`, change the existing StructuredOutput-drop test to pass `true` as the second argument, and add:

```ts
  it("keeps a tool_use named StructuredOutput when not asked to drop it", () => {
    const m = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: { pass: true } }] } };
    const out = toAgentMessage(m as never);
    expect(out.message?.content).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/loop.test.ts test/gate.test.ts test/agent-step.test.ts test/sdk-query.test.ts`
Expected: FAIL on each new assertion.

- [ ] **Step 3: `runLoopStep`**

Replace the body of `runLoopStep` from `let lastStart = -1;` to the end of the function with:

```ts
  let lastStart = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e && e.stepId === step.id && e.kind === "step_started") lastStart = i;
  }
  let done = 0;
  let lastIteration: Event | undefined;
  let lastText = "";
  for (let i = lastStart + 1; i < events.length; i++) {
    const e = events[i];
    if (!e || e.stepId !== step.id) continue;
    if (e.kind === "loop_iteration") { done++; lastIteration = e; }
    if (e.kind === "agent_result" && typeof e.payload["text"] === "string") lastText = e.payload["text"];
  }

  const inputHashes = await hashFiles(ctx.showRoot, step.inputs ?? []);
  await emit("step_started", { kind: "loop", body: step.body.id, until: step.until, max: step.maxIterations, inputHashes });

  // A crash between the final loop_iteration and step_completed leaves a loop whose sentinel
  // already fired. Resuming it as "done iterations, sentinel unseen" would run the body again or,
  // at the cap, fail a loop that had in fact finished — hours of drafting lost to a lost write.
  if (lastIteration?.payload["sentinel"] === true) {
    const outputHashes = await hashFiles(ctx.showRoot, step.outputs ?? []);
    await emit("step_completed", { inputHashes, outputHashes, result: lastText, iterations: done, resumedAfterSentinel: true });
    return { kind: "completed", result: lastText };
  }

  for (let iteration = done + 1; iteration <= step.maxIterations; iteration++) {
    const iterCtx: RunContext = { ...ctx, results: { ...ctx.results, [`${step.body.id}:iteration`]: iteration } };
    const r = await executors.agent(step.body, iterCtx, emit);
    if (!r.ok) {
      await emit("loop_iteration", { iteration, max: step.maxIterations, sentinel: false, toolCalls: r.toolCalls ?? 0, error: r.error });
      await emit("step_failed", { error: `iteration ${iteration}: ${r.error}` });
      return { kind: "failed", error: `iteration ${iteration}: ${r.error}` };
    }
    const sentinel = r.text.includes(step.until);
    await emit("loop_iteration", { iteration, max: step.maxIterations, sentinel, toolCalls: r.toolCalls });
    if (step.progress) await emit("step_progress", { ...(await step.progress(iterCtx)) });
    if (sentinel) {
      const outputHashes = await hashFiles(ctx.showRoot, step.outputs ?? []);
      await emit("step_completed", { inputHashes, outputHashes, result: r.text, iterations: iteration });
      return { kind: "completed", result: r.text };
    }
  }
  const error = `exhausted ${step.maxIterations} iterations without sentinel ${step.until}`;
  await emit("step_failed", { error });
  return { kind: "failed", error };
```

- [ ] **Step 4: The fix agent's hashes and the agent step's failure count**

In `runGateStep`, the fix-agent block becomes:

```ts
      const fixEmit = emitFor(step.onReject.id);
      const fixInputs = await hashFiles(ctx.showRoot, step.onReject.inputs ?? []);
      await fixEmit("step_started", { kind: "agent", rejectionOf: step.id, attempt: attempts, inputHashes: fixInputs });
      const r = await executors.agent(step.onReject, fixCtx, fixEmit);
      if (!r.ok) {
        await fixEmit("step_failed", { error: r.error, toolCalls: r.toolCalls ?? 0 });
        await emit("step_failed", { error: `fix agent failed: ${r.error}` });
        return { kind: "failed", error: `fix agent failed: ${r.error}` };
      }
      const fixOutputs = await hashFiles(ctx.showRoot, step.onReject.outputs ?? []);
      await fixEmit("step_completed", { result: r.verdict ?? r.text, toolCalls: r.toolCalls, inputHashes: fixInputs, outputHashes: fixOutputs });
```

In `runAgentStep`, the failure emit becomes `await emit("step_failed", { error: r.error, toolCalls: r.toolCalls ?? 0 });`.

In `engine/src/agent-step.ts`, each `outcome = { ok: false, error: … }` after the pump (the three at lines ~273, ~275, ~278 and the one at ~287) gains `toolCalls`: for example `outcome = { ok: false, error: failure ?? "query ended without a result message", toolCalls };`. The schema-check failure before the query (line ~187) is left as is — no tool has run.

- [ ] **Step 5: Gate the verdict-tool drop**

In `engine/src/sdk-query.ts`:

```ts
export const sdkQuery: QueryFn = async function* ({ prompt, options }) {
  const dropVerdictTool = options.outputFormat !== undefined;
  for await (const m of query({ prompt, options: { ...options } })) {
    yield toAgentMessage(m, dropVerdictTool);
  }
};

/** … existing comment …
 *  `dropVerdictTool` is true only for a query run with `outputFormat`: on any other query a tool
 *  that happens to be named StructuredOutput is a real tool call and is counted. */
export function toAgentMessage(m: SDKMessage, dropVerdictTool = false): AgentMessage {
  …
  if (m.type === "assistant") {
    out.message = { content: m.message.content.filter((b) => !(dropVerdictTool && isVerdictDelivery(b))).map(toBlock) };
  }
```

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: PASS (176 passed, 2 skipped), typecheck silent.

- [ ] **Step 7: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/runner.ts engine/src/agent-step.ts engine/src/sdk-query.ts engine/test/loop.test.ts engine/test/gate.test.ts engine/test/agent-step.test.ts engine/test/sdk-query.test.ts
git commit -F - <<'EOF'
engine: loops resume past a recorded sentinel, record hashes, and count tools on failure

A loop whose last loop_iteration carries sentinel: true completes on
resume without running the body again. Loops and gate fix agents now
record inputHashes and outputHashes like agent steps, which is what the
canon reviewer's hand-edit detection compares against disk. A failed
iteration records the tool calls it made before failing, and the
StructuredOutput drop in the SDK adapter applies only to queries run
with an output format.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---
## Task 4: The stage map's guard rails, the three `Needs` probes, and hand-edit provenance

**Files:**
- Modify: `engine/src/stages.ts` (`NEEDS_RULES` gains `from`; `validateStageMap`; `StageMapError`)
- Modify: `engine/src/show-config.ts` (`formatFilename`, `mixFilename`)
- Create: `engine/src/needs.ts`, `engine/src/provenance.ts`
- Modify: `engine/src/index.ts` (export the two new modules)
- Test: `engine/test/stages.test.ts`, `engine/test/show-config.test.ts`, `engine/test/needs.test.ts` (new), `engine/test/provenance.test.ts` (new)

**Interfaces:**
- Consumes: `RunContext.events` (Task 1), `hashFile` from `hash.ts`, `parseEpisodeId`, `seasonOf`, `ShowConfig`.
- Produces:
  - `validateStageMap(map: StageMap, pipeline: Pipeline): void` — throws `StageMapError`.
  - `formatFilename(pattern: string, vars: Record<string, string | number>): string` — `{name}` and `{name:02d}` only; unknown name throws `ShowConfigError`.
  - `mixFilename(show: ShowConfig, episodeId: string): string` — the mix WAV's basename: the show's `output.mixFilename` pattern (default `"{slug} S{season:02d}E{episode:02d}.wav"`) when the id has a season, else `"episode.wav"` (mirrors `scripts/audio-mix.py`'s `UNMAPPED_MIX`).
  - `parseCastSection(outline: string): CastEntry[]` where `CastEntry = { name: string; tags: string[] }`.
  - `missingRefs(showRoot, episodeId, show): Promise<string[]>` — one line per missing asset, e.g. `"Ilvaren: no reference image at Canon/refs.json key ilvaren"`; `[]` when nothing is missing or the outline has no `## Cast` section.
  - `missingShowrunnerImages(showRoot, episodeId, show): Promise<string[]>` — the shot ids whose `source` is `"showrunner"` and whose PNG is absent; `[]` when `prompts.json` does not exist.
  - `episodeNeeds(showRoot, episodeId, show): Promise<Needs>`.
  - `handEdits(ctx: RunContext, files: string[]): Promise<HandEdit[]>` where `HandEdit = { file: string; recordedBy: string; recordedHash: string | null; currentHash: string | null }`.

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/stages.test.ts`:

```ts
describe("the NEEDS_ windows", () => {
  it("reports NEEDS_REFS only from SCRIPT to CASTING, and NEEDS_IMAGES only from AUDIO to IMAGES", () => {
    const atIdea = base({});
    const atOutline = base({ steps: { "outline-gate": "completed" } });
    const atScript = base({ steps: { "outline-gate": "completed", "script-gate": "completed" } });
    const atCasting = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed" } });
    const atAudio = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed", "audio-gate": "completed" } });
    const refs = { ...none, refsMissing: true };
    expect(deriveStage(atIdea, map, refs)).toBe("IDEA");
    expect(deriveStage(atOutline, map, refs)).toBe("OUTLINE");
    expect(deriveStage(atScript, map, refs)).toBe("NEEDS_REFS");
    expect(deriveStage(atCasting, map, refs)).toBe("CASTING");
    const images = { ...none, imagesMissing: true };
    expect(deriveStage(atScript, map, images)).toBe("SCRIPT");
    expect(deriveStage(atAudio, map, images)).toBe("NEEDS_IMAGES");
    const openImageGate = base({ ...atAudio, steps: { ...atAudio.steps, "image-gate": "waiting" }, openGate: { stepId: "image-gate", attempt: 1, message: "", openedAt: "t" } });
    expect(deriveStage(openImageGate, map, images)).toBe("NEEDS_IMAGES");
    expect(deriveStage(openImageGate, map, none)).toBe("DRAFT_IMAGES");
  });
});

describe("validateStageMap", () => {
  const p: Pipeline = { name: "p", steps: [
    { kind: "gate", id: "g", message: () => "m" },
    { kind: "script", id: "stamp", dependsOn: ["g"], argv: () => ["true"] },
    { kind: "script", id: "maybe", dependsOn: ["g"], when: () => true, argv: () => ["true"] },
  ] };
  it("accepts a map whose keys are steps and whose values are stages of the right kind", () => {
    expect(() => validateStageMap({ gates: { g: "DRAFT_SCRIPT" }, approved: { stamp: "SCRIPT" }, final: "COMPLETE" }, p)).not.toThrow();
  });
  it("refuses an unknown step, a non-gate under gates, a wrong-kind stage, and an approved step that carries when", () => {
    expect(() => validateStageMap({ gates: { nope: "DRAFT_SCRIPT" }, approved: {}, final: "COMPLETE" }, p)).toThrow(/gates\.nope: no such step/);
    expect(() => validateStageMap({ gates: { stamp: "DRAFT_SCRIPT" }, approved: {}, final: "COMPLETE" }, p)).toThrow(/gates\.stamp: step is a script, not a gate/);
    expect(() => validateStageMap({ gates: { g: "SCRIPT" }, approved: {}, final: "COMPLETE" }, p)).toThrow(/gates\.g: a gate opens a DRAFT_ stage/);
    expect(() => validateStageMap({ gates: {}, approved: { stamp: "DRAFT_SCRIPT" }, final: "COMPLETE" }, p)).toThrow(/approved\.stamp: DRAFT_SCRIPT is not an approved stage/);
    expect(() => validateStageMap({ gates: {}, approved: { maybe: "SCRIPT" }, final: "COMPLETE" }, p)).toThrow(/approved\.maybe: the step carries a when/);
    expect(() => validateStageMap({ gates: {}, approved: {}, final: "NOPE" as never }, p)).toThrow(/final: "NOPE" is not a stage/);
  });
});
```

Add `validateStageMap` to the import from `../src/stages.js` and `import type { Pipeline } from "../src/steps.js";`. If an existing assertion in this file expects `NEEDS_REFS` or `NEEDS_IMAGES` below the window's `from` stage, change it to the window's behaviour and say so in the report.

Append to `engine/test/show-config.test.ts`:

```ts
describe("filenames", () => {
  it("formats {name} and {name:02d}, and refuses an unknown name", () => {
    expect(formatFilename("{slug} S{season:02d}E{episode:02d}.wav", { slug: "Show", season: 2, episode: 1 })).toBe("Show S02E01.wav");
    expect(formatFilename("{episodeId}.mp4", { episodeId: "ep98" })).toBe("ep98.mp4");
    expect(() => formatFilename("{nope}", { slug: "s" })).toThrow(/unknown name "nope"/);
  });
  it("names the mix from the pattern for an id with a season, and episode.wav otherwise", () => {
    const show = { showName: "S", showSlug: "Show", promptsDir: "prompts", models: { medium: "m", large: "l", writer: "w" }, airMap: { ep10: [1, 10] as [number, number] }, output: { nasRoot: "/nas", mixFilename: "{slug} S{season:02d}E{episode:02d}.wav" } };
    expect(mixFilename(show, "s02e01")).toBe("Show S02E01.wav");
    expect(mixFilename(show, "ep10")).toBe("Show S01E10.wav");
    expect(mixFilename(show, "ep98")).toBe("episode.wav");
    expect(mixFilename({ ...show, output: { nasRoot: "/nas" } }, "s02e01")).toBe("Show S02E01.wav");
  });
});
```

Create `engine/test/needs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { episodeNeeds, missingRefs, missingShowrunnerImages, parseCastSection } from "../src/needs.js";
import type { ShowConfig } from "../src/show-config.js";

const show: ShowConfig = {
  showName: "S", showSlug: "Show", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/nas" },
  audio: { voiceRefsDir: "Production/voice-refs" }, visual: { refs: "Canon/refs.json" },
};

async function show1() {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  const w = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); };
  await w("Canon/refs.json", JSON.stringify({
    _doc: "meta", vale: { kind: "human", ref: "Canon/characters/Vale/ref.png" }, "the-warden": { kind: "character", ref: "Canon/characters/Warden/ref.png" },
    harbor: { kind: "location", ref: "Canon/locations/harbor.png" }, ghost: { kind: "human", ref: "Canon/characters/Ghost/missing.png" },
  }));
  await w("Canon/characters/Vale/ref.png", "png"); await w("Canon/characters/Warden/ref.png", "png"); await w("Canon/locations/harbor.png", "png");
  await w("Production/voice-refs/refs.json", JSON.stringify({ cast: {
    narrator: { ref: "Production/voice-refs/n.wav", status: "LOCKED" }, Vale: { ref: "Production/voice-refs/vale.wav", status: "LOCKED (speed 1.1)" },
    Warden: { ref: "Production/voice-refs/warden.wav", status: "CANDIDATE" },
  } }));
  await w("Production/voice-refs/n.wav", "wav"); await w("Production/voice-refs/vale.wav", "wav"); await w("Production/voice-refs/warden.wav", "wav");
  return { root, w };
}

describe("parseCastSection", () => {
  it("reads the lines of the ## Cast section and nothing else", () => {
    const outline = "# Ep\n\n## Cast\n- Vale (recurring, speaks)\n- the Warden (recurring)\n- Dock Hand Pim (guest, speaks)\n- Harbor (location)\nnot a cast line\n\n## Beat outline\n- Vale (this is a beat, not cast)\n";
    expect(parseCastSection(outline)).toEqual([
      { name: "Vale", tags: ["recurring", "speaks"] }, { name: "the Warden", tags: ["recurring"] },
      { name: "Dock Hand Pim", tags: ["guest", "speaks"] }, { name: "Harbor", tags: ["location"] },
    ]);
    expect(parseCastSection("# Ep\n## Beat outline\n- x\n")).toEqual([]);
  });
});

describe("missingRefs", () => {
  it("is empty when every recurring subject has its image and every speaker its locked voice", async () => {
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Vale (recurring, speaks)\n- Harbor (location)\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([]);
  });
  it("names a missing image, an unlocked voice, an unregistered recurring subject, and a guest without a WAV", async () => {
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Ghost (recurring)\n- the Warden (recurring, speaks)\n- Nobody (recurring)\n- Dock Hand Pim (guest, speaks)\n- Quiet Pim (guest)\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([
      "Ghost: reference image missing at Canon/characters/Ghost/missing.png (Canon/refs.json key ghost)",
      "the Warden: voice is not LOCKED in Production/voice-refs/refs.json (cast key Warden)",
      "Nobody: no entry in Canon/refs.json (tried nobody, the-nobody)",
      "Dock Hand Pim: no guest voice at Production/s02e01/guest-refs/dock-hand-pim*.wav",
    ]);
  });
  it("finds a guest voice by slug prefix, and is empty without a cast section", async () => {
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Dock Hand Pim (guest, speaks)\n");
    await w("Production/s02e01/guest-refs/dock-hand-pim-1.wav", "wav");
    expect(await missingRefs(root, "s02e01", show)).toEqual([]);
    await w("Episodes/s02e01/outline.md", "## Beat outline\n- x\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([]);
  });
});

describe("missingShowrunnerImages and episodeNeeds", () => {
  it("lists showrunner shots without a PNG, and nothing before a shot list exists", async () => {
    const { root, w } = await show1();
    expect(await missingShowrunnerImages(root, "s02e01", show)).toEqual([]);
    await w("Production/s02e01/images/prompts.json", JSON.stringify({ shots: [
      { id: "s01-a", type: "ambient" }, { id: "s02-b", type: "character", source: "showrunner" }, { id: "s03-c", type: "character", source: "showrunner" }, { id: "s04-d", type: "character", source: "pipeline" },
    ] }));
    await w("Production/s02e01/images/s03-c.png", "png");
    expect(await missingShowrunnerImages(root, "s02e01", show)).toEqual(["s02-b"]);
  });
  it("derives all three flags", async () => {
    const { root, w } = await show1();
    expect(await episodeNeeds(root, "s02e01", show)).toEqual({ ideaMissing: true, refsMissing: false, imagesMissing: false });
    await w("Episodes/s02e01/premise.md", "  \n");
    expect((await episodeNeeds(root, "s02e01", show)).ideaMissing).toBe(true);
    await w("Episodes/s02e01/premise.md", "A week.");
    await w("Episodes/s02e01/outline.md", "## Cast\n- Nobody (recurring)\n");
    expect(await episodeNeeds(root, "s02e01", show)).toEqual({ ideaMissing: false, refsMissing: true, imagesMissing: false });
  });
});
```

Create `engine/test/provenance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handEdits } from "../src/provenance.js";
import { hashFile } from "../src/hash.js";
import type { Event } from "../src/events.js";

describe("handEdits", () => {
  it("reports a file whose hash differs from the last step_completed that recorded it, and nothing for files never recorded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    await writeFile(path.join(root, "outline.md"), "agent wrote this");
    const recorded = await hashFile(path.join(root, "outline.md"));
    const ev = (stepId: string, outputHashes: Record<string, string | null>): Event => ({ ts: "t", runId: "r", stepId, kind: "step_completed", payload: { outputHashes } });
    const events: Event[] = [ev("outline", { "outline.md": "stale" }), ev("outline-fix", { "outline.md": recorded })];
    const ctx = { runId: "r", episodeId: "s02e01", showRoot: root, results: {}, events };
    expect(await handEdits(ctx, ["outline.md", "script.md"])).toEqual([]);
    await writeFile(path.join(root, "outline.md"), "the showrunner changed a line");
    const current = await hashFile(path.join(root, "outline.md"));
    expect(await handEdits(ctx, ["outline.md", "script.md"])).toEqual([{ file: "outline.md", recordedBy: "outline-fix", recordedHash: recorded, currentHash: current }]);
    expect(await handEdits({ ...ctx, events: undefined }, ["outline.md"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/stages.test.ts test/show-config.test.ts test/needs.test.ts test/provenance.test.ts`
Expected: FAIL — the modules and functions do not exist; the window test reports `NEEDS_REFS` at IDEA.

- [ ] **Step 3: `stages.ts`**

```ts
import type { RunState } from "./state.js";
import type { Pipeline } from "./steps.js";

export class StageMapError extends Error { override readonly name = "StageMapError"; }
```

Change `NEEDS_RULES`:

```ts
/** Checked in order, first match wins, so this list must stay in ascending `stage` order: a
 *  NEEDS_ stage listed after one that sits later in STAGES would be masked by it and never
 *  reported. A rule applies only inside its window: from `from` (inclusive; absent means from
 *  the floor) up to `passedAt`, the first approved stage strictly after the interruption. The
 *  windows are the spec's placement of each state in the vocabulary (§3.2): refs are demanded
 *  once the script is approved and before casting, showrunner-made images once the audio is
 *  approved and before the images are. */
const NEEDS_RULES: { flag: keyof Needs; stage: Stage; from?: Stage; passedAt: Stage }[] = [
  { flag: "ideaMissing", stage: "NEEDS_IDEA", passedAt: "OUTLINE" },
  { flag: "refsMissing", stage: "NEEDS_REFS", from: "SCRIPT", passedAt: "CASTING" },
  { flag: "imagesMissing", stage: "NEEDS_IMAGES", from: "AUDIO", passedAt: "IMAGES" },
];
```

and the loop in `deriveStage`:

```ts
  for (const rule of NEEDS_RULES) {
    const inWindow = (rule.from === undefined || compareStages(highest, rule.from) >= 0) && compareStages(highest, rule.passedAt) < 0;
    if (needs[rule.flag] && inWindow) return rule.stage;
  }
```

Add at the end of the file:

```ts
/** Refuses a stage map that would degrade silently: a key that is no step of the pipeline
 *  never advances anything, a gate mapped to an approved stage or a step to a DRAFT_ one is a
 *  category error, and an `approved` step that carries `when` can be bypassed — and a bypassed
 *  step never counts toward `highest`, so the stage it names would never be reached. */
export function validateStageMap(map: StageMap, pipeline: Pipeline): void {
  const byId = new Map(pipeline.steps.map((s) => [s.id, s] as const));
  for (const [id, stage] of Object.entries(map.gates)) {
    const s = byId.get(id);
    if (!s) throw new StageMapError(`gates.${id}: no such step in pipeline ${pipeline.name}`);
    if (s.kind !== "gate") throw new StageMapError(`gates.${id}: step is a ${s.kind}, not a gate`);
    if (!isStage(stage)) throw new StageMapError(`gates.${id}: ${JSON.stringify(stage)} is not a stage`);
    if (!stage.startsWith("DRAFT_")) throw new StageMapError(`gates.${id}: a gate opens a DRAFT_ stage, not ${stage}`);
  }
  for (const [id, stage] of Object.entries(map.approved)) {
    const s = byId.get(id);
    if (!s) throw new StageMapError(`approved.${id}: no such step in pipeline ${pipeline.name}`);
    if (!isStage(stage)) throw new StageMapError(`approved.${id}: ${JSON.stringify(stage)} is not a stage`);
    if (stage.startsWith("DRAFT_") || stage.startsWith("NEEDS_")) throw new StageMapError(`approved.${id}: ${stage} is not an approved stage`);
    if (s.when) throw new StageMapError(`approved.${id}: the step carries a when and can be bypassed, and a bypassed step never advances a stage; key the stage on a later step`);
  }
  if (!isStage(map.final)) throw new StageMapError(`final: ${JSON.stringify(map.final)} is not a stage`);
}
```

- [ ] **Step 4: `formatFilename` and `mixFilename` in `show-config.ts`**

```ts
/** Renders an output-filename pattern the way scripts/lib/showconfig.py's format_filename does,
 *  so the engine and the scripts name the same file: `{name}` substitutes as is and `{name:02d}`
 *  zero-pads a number to that width. Nothing else of Python's format grammar is supported, and
 *  an unknown name is an error rather than a hole in a path. */
export function formatFilename(pattern: string, vars: Record<string, string | number>): string {
  return pattern.replace(/\{([A-Za-z_][A-Za-z0-9_]*)(?::0(\d+)d)?\}/g, (_whole, name: string, width?: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new ShowConfigError(`filename pattern ${JSON.stringify(pattern)}: unknown name ${JSON.stringify(name)}`);
    const v = vars[name];
    return width !== undefined ? String(v).padStart(Number(width), "0") : String(v);
  });
}

const DEFAULT_MIX_PATTERN = "{slug} S{season:02d}E{episode:02d}.wav";
/** scripts/audio-mix.py's name for the mix of an episode that has no season: a production id
 *  the air map does not place. Mirrored here so the pipeline can declare the file as an input. */
const UNMAPPED_MIX = "episode.wav";

/** The basename of an episode's mixed WAV, as scripts/audio-mix.py writes it. */
export function mixFilename(show: ShowConfig, episodeId: string): string {
  const id = parseEpisodeId(episodeId);
  const slot = id.kind === "aired" ? [id.season, id.episode] as const : show.airMap[id.raw];
  if (!slot) return UNMAPPED_MIX;
  return formatFilename(show.output.mixFilename ?? DEFAULT_MIX_PATTERN, { slug: show.showSlug, season: slot[0], episode: slot[1], episodeId });
}
```

- [ ] **Step 5: `needs.ts`**

```ts
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolveShowPath, type ShowConfig } from "./show-config.js";
import type { Needs } from "./stages.js";

export interface CastEntry { name: string; tags: string[] }

/** The outline's `## Cast` section, one entry per line of the form `- <Name> (<tag>, <tag>)`.
 *  The section is the pipeline's only knowledge of who is in an episode before a script exists,
 *  which is why the outline prompt requires it and the canon reviewer checks it (F-01). Lines
 *  outside the section, and lines inside it that do not match the grammar, are ignored. */
export function parseCastSection(outline: string): CastEntry[] {
  const out: CastEntry[] = [];
  let inSection = false;
  for (const line of outline.split("\n")) {
    if (/^## /.test(line)) { inSection = /^## Cast\b/.test(line); continue; }
    if (!inSection) continue;
    const m = /^- (.+?) \(([^)]*)\)\s*$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.push({ name: m[1].trim(), tags: m[2].split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== "") });
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await readFile(p, "utf8")) as unknown;
}
function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }

/** "the Warden" → "warden"; "Dock Hand Pim" → "dock-hand-pim". The bible's keys are slugs and
 *  the voice cast's keys are display names, so both sides are normalised the same way. */
export function slugName(name: string): string {
  return name.trim().toLowerCase().replace(/^the[ -]/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function dirs(show: ShowConfig) {
  return {
    episodes: show.episodesDir ?? "Episodes",
    production: show.productionDir ?? "Production",
    voiceRefs: typeof show.audio?.["voiceRefsDir"] === "string" ? show.audio["voiceRefsDir"] : "Production/voice-refs",
    visualRefs: typeof show.visual?.["refs"] === "string" ? show.visual["refs"] : "Canon/refs.json",
  };
}

/** One line per reference the outline's cast needs and the show does not have: a recurring
 *  subject without an entry or an image in the visual bible, a speaking recurring character
 *  whose voice is not LOCKED or whose WAV is absent, a speaking guest with no WAV under the
 *  episode's guest-refs. Empty when the outline has no `## Cast` section — the section's absence
 *  is the canon reviewer's finding, not this probe's. */
export async function missingRefs(showRoot: string, episodeId: string, show: ShowConfig): Promise<string[]> {
  const d = dirs(show);
  const outlinePath = path.join(showRoot, d.episodes, episodeId, "outline.md");
  if (!(await exists(outlinePath))) return [];
  const cast = parseCastSection(await readFile(outlinePath, "utf8"));
  if (cast.length === 0) return [];

  const biblePath = resolveShowPath(showRoot, d.visualRefs);
  const bibleRaw = (await exists(biblePath)) ? await readJson(biblePath) : {};
  const bible: Record<string, Record<string, unknown>> = {};
  if (isRecord(bibleRaw)) for (const [k, v] of Object.entries(bibleRaw)) if (!k.startsWith("_") && isRecord(v)) bible[k] = v;

  const voicesPath = path.join(resolveShowPath(showRoot, d.voiceRefs), "refs.json");
  const voicesRaw = (await exists(voicesPath)) ? await readJson(voicesPath) : {};
  const voices: Record<string, Record<string, unknown>> = {};
  if (isRecord(voicesRaw) && isRecord(voicesRaw["cast"])) for (const [k, v] of Object.entries(voicesRaw["cast"])) if (isRecord(v)) voices[k] = v;

  const guestDir = path.join(showRoot, d.production, episodeId, "guest-refs");
  const guestWavs = (await exists(guestDir)) ? (await readdir(guestDir)).filter((f) => f.toLowerCase().endsWith(".wav")).map((f) => f.toLowerCase()) : [];

  const missing: string[] = [];
  for (const entry of cast) {
    const slug = slugName(entry.name);
    const tags = new Set(entry.tags);
    const speaks = tags.has("speaks");
    if (tags.has("recurring") || tags.has("location")) {
      const key = [slug, `the-${slug}`].find((k) => Object.prototype.hasOwnProperty.call(bible, k));
      if (key === undefined) {
        missing.push(`${entry.name}: no entry in ${d.visualRefs} (tried ${slug}, the-${slug})`);
      } else {
        const ref = bible[key]?.["ref"];
        if (typeof ref !== "string" || !(await exists(resolveShowPath(showRoot, ref)))) {
          missing.push(`${entry.name}: reference image missing at ${typeof ref === "string" ? ref : "(no ref)"} (${d.visualRefs} key ${key})`);
        }
      }
    }
    if (tags.has("recurring") && speaks) {
      const voiceKey = Object.keys(voices).find((k) => slugName(k) === slug);
      const voice = voiceKey !== undefined ? voices[voiceKey] : undefined;
      if (voice === undefined) {
        missing.push(`${entry.name}: no voice in ${path.posix.join(d.voiceRefs, "refs.json")} cast`);
      } else {
        const status = typeof voice["status"] === "string" ? voice["status"] : "";
        const ref = voice["ref"];
        if (!status.includes("LOCKED")) missing.push(`${entry.name}: voice is not LOCKED in ${path.posix.join(d.voiceRefs, "refs.json")} (cast key ${voiceKey})`);
        else if (typeof ref !== "string" || !(await exists(resolveShowPath(showRoot, ref)))) missing.push(`${entry.name}: voice WAV missing at ${typeof ref === "string" ? ref : "(no ref)"}`);
      }
    }
    if (tags.has("guest") && speaks) {
      if (!guestWavs.some((f) => f.startsWith(slug))) {
        missing.push(`${entry.name}: no guest voice at ${path.posix.join(d.production, episodeId, "guest-refs")}/${slug}*.wav`);
      }
    }
  }
  return missing;
}

/** The shot ids the showrunner said he would make by hand (`source: "showrunner"` in the shot
 *  list) whose PNG is not on disk yet. Empty before a shot list exists: the stage before the
 *  images is AUDIO, and NEEDS_IMAGES must not fire for an episode that has no shots. */
export async function missingShowrunnerImages(showRoot: string, episodeId: string, show: ShowConfig): Promise<string[]> {
  const d = dirs(show);
  const imagesDir = path.join(showRoot, d.production, episodeId, "images");
  const listPath = path.join(imagesDir, "prompts.json");
  if (!(await exists(listPath))) return [];
  const doc = await readJson(listPath);
  const shots = isRecord(doc) && Array.isArray(doc["shots"]) ? doc["shots"] : [];
  const missing: string[] = [];
  for (const shot of shots) {
    if (!isRecord(shot) || shot["source"] !== "showrunner" || typeof shot["id"] !== "string") continue;
    if (!(await exists(path.join(imagesDir, `${shot["id"]}.png`)))) missing.push(shot["id"]);
  }
  return missing;
}

/** The three Needs flags for an episode, each derived from disk and nothing else (spec §3.3). */
export async function episodeNeeds(showRoot: string, episodeId: string, show: ShowConfig): Promise<Needs> {
  const d = dirs(show);
  const premise = path.join(showRoot, d.episodes, episodeId, "premise.md");
  const ideaMissing = !(await exists(premise)) || (await readFile(premise, "utf8")).trim() === "";
  return {
    ideaMissing,
    refsMissing: (await missingRefs(showRoot, episodeId, show)).length > 0,
    imagesMissing: (await missingShowrunnerImages(showRoot, episodeId, show)).length > 0,
  };
}
```

- [ ] **Step 6: `provenance.ts`**

```ts
import path from "node:path";
import { hashFile } from "./hash.js";
import type { RunContext } from "./steps.js";

export interface HandEdit { file: string; recordedBy: string; recordedHash: string | null; currentHash: string | null }

/** Spec §2.3: a hand edit is any file whose current content differs from the hash the engine
 *  recorded when a step last wrote it. The record is the `outputHashes` of the most recent
 *  step_completed that lists the file — an agent step, a loop, or a gate's fix agent — and the
 *  comparison is made here, outside the agent, because an agent step cannot reach the log. A
 *  file no step has recorded is not reported: there is nothing to compare, and such a file (the
 *  premise, `locked-beats.md`) is the showrunner's by definition. */
export async function handEdits(ctx: RunContext, files: string[]): Promise<HandEdit[]> {
  const events = ctx.events ?? [];
  const out: HandEdit[] = [];
  for (const file of files) {
    let recordedBy: string | undefined;
    let recordedHash: string | null | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e || e.kind !== "step_completed" || e.stepId === undefined) continue;
      const hashes = e.payload["outputHashes"];
      if (typeof hashes !== "object" || hashes === null || !Object.prototype.hasOwnProperty.call(hashes, file)) continue;
      recordedBy = e.stepId;
      recordedHash = (hashes as Record<string, string | null>)[file] ?? null;
      break;
    }
    if (recordedBy === undefined || recordedHash === undefined) continue;
    const currentHash = await hashFile(path.join(ctx.showRoot, file));
    if (currentHash !== recordedHash) out.push({ file, recordedBy, recordedHash, currentHash });
  }
  return out;
}
```

Add to `engine/src/index.ts`: `export * from "./needs.js";` and `export * from "./provenance.js";`.

- [ ] **Step 7: Run the whole suite and the typecheck**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: PASS (188 passed, 2 skipped), typecheck silent, and the show-name grep from the Global Constraints prints nothing (the test fixtures name an invented show; `engine/test/` is inside `engine/`, so keep the fixtures' names invented).

- [ ] **Step 8: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/stages.ts engine/src/show-config.ts engine/src/needs.ts engine/src/provenance.ts engine/src/index.ts engine/test/stages.test.ts engine/test/show-config.test.ts engine/test/needs.test.ts engine/test/provenance.test.ts
git commit -F - <<'EOF'
engine: NEEDS_ windows, validateStageMap, the three Needs probes, hand-edit provenance

NEEDS_REFS is reported from SCRIPT to CASTING and NEEDS_IMAGES from AUDIO
to IMAGES, where the spec places them. validateStageMap refuses a map
that would degrade silently. needs.ts derives the three flags from disk:
the premise file, the outline's ## Cast section against the visual bible
and the voice cast, and the shot list's source field against the PNGs.
provenance.ts answers spec §2.3's hand-edit question by comparing the
last recorded output hash of a file with the file on disk.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---
## Task 5: The `episode` pipeline definition

**Files:**
- Create: `engine/src/pipelines/episode.ts`
- Modify: `engine/src/index.ts` (export it)
- Test: `engine/test/episode-pipeline.test.ts` (the load-time tests only; Task 6 adds the walk)

**Interfaces:**
- Consumes: `ShowConfig`, `seasonOf`, `mixFilename` (Task 4), `missingRefs`, `missingShowrunnerImages` (Task 4), `handEdits` (Task 4), `validateStageMap` (Task 4), `EventLog`, `deriveRunState`, `parseEpisodeId`, `formatAired`, `GateStep.rerunOnReject` (Task 1), `RunContext.events` (Task 1).
- Produces: `episodePipeline(opts: EpisodePipelineOptions): Pipeline` with `EpisodePipelineOptions = { show: ShowConfig; episodeId: string; engineRoot: string }`; `EPISODE_STAGE_MAP: StageMap`; `EPISODE_PIPELINE_NAME = "episode"`; the step ids listed in the table below, which Task 6's test and Plan E's console rely on.

**The step list, in order.** Every row is a step the factory creates; the reviewer checks each against the inventory's §1 row it came from (the "from" column names the YAML node).

| # | Step id | Kind | dependsOn | From | Notes |
|---|---|---|---|---|---|
| 1 | `previous-episode` | guard | — | new (rule 1.3) | for `sXXeYY` with YY > 1: `Production/sXXe(YY-1)/runs/` absent → pass (the archive predates the engine); present → some run there must be finished `completed`, else fail. Any other id → pass. |
| 2 | `premise` | guard | previous-episode | write `setup` | `Episodes/<id>/premise.md` exists and is not blank, else fail `NEEDS_IDEA: write Episodes/<id>/premise.md`. Message: the premise text. |
| 3 | `outline` | agent | premise | `outline` | `writer`, `Read, Write, Glob, Grep`, fresh, timeout 30 min; inputs the canon spine + the premise; outputs `outline.md`. |
| 4 | `hand-edits-outline` | guard | outline | new (F-09) | message `JSON.stringify({ handEdited: await handEdits(ctx, [outline.md]) })`. |
| 5 | `canon-review-outline` | agent | hand-edits-outline | `outline-canon-check` | `medium`, `Read, Glob, Grep`, fresh, schema `canon-review.schema.json`, timeout 30 min; inputs outline, premise, locked-beats, canon spine. |
| 6 | `canon-ledger-outline` | script | canon-review-outline | new (F-10) | `canon-ledger.py <id> --pass outline --run <runId> --rows <json>`; outputs `canon-ledger.md`. |
| 7 | `outline-fix-gate` | guard | canon-review-outline | `outline-fix-gate` | `{ pass: true, message: verdict.pass ? "yes" : "no" }`. |
| 8 | `outline-revise` | loop | outline-fix-gate | `outline-revise` | `when` result of 7 is `"no"`; body `outline-revise.md`, `writer`, `Read, Edit, Write, Glob, Grep`, shared, idle 15 min; until `OUTLINE_FIXED`, max 2; inputs/outputs `outline.md`. |
| 9 | `outline-gate` | gate | outline-revise, canon-ledger-outline | `outline-gate` | message `outline-gate.gate.md`; onReject `outline-gate.reject.md` (`writer`, `Read, Edit, Write, Glob, Grep`, outputs `outline.md`); maxAttempts 10; `rerunOnReject: ["hand-edits-outline"]`. |
| 10 | `stamp-outline` | script | outline-gate | `stamp-outline` | `status.py <id> outline "approved at outline-gate"`. |
| 11 | `draft` | loop | stamp-outline | `draft` | body `draft.md`, `writer`, `Read, Write, Edit, Glob, Grep`, fresh, idle 15 min; until `DRAFT_COMPLETE`, max 15; inputs outline + style + craft; outputs `script.md`; `progress`: scenes written / beats planned. |
| 12 | `hand-edits-script` | guard | draft | new | files `script.md`, `outline.md`. |
| 13 | `canon-review-script` | agent | hand-edits-script | `continuity-check` | as 5 with `canon-review-script.md`; inputs script, outline, premise, locked-beats, canon spine. |
| 14 | `canon-ledger-script` | script | canon-review-script | new | `--pass script`. |
| 15–20 | `tone-check`, `flow-check`, `character-check`, `structure-check`, `environment-check`, `repetition-check` | agent | draft | the six | `medium`, `Read, Glob, Grep`, fresh, each with its own schema file, timeout 30 min; inputs per the inventory §1.1. |
| 21 | `review-gate` | guard | canon-review-script + the six | `review-gate` | `"yes"` when all seven verdicts have `pass: true`, else `"no"`. |
| 22 | `revise` | loop | review-gate | `revise` | `when` `"no"`; body `revise.md`, `writer`, `Read, Edit, Write, Glob, Grep`, shared, idle 15 min; until `REVISIONS_COMPLETE`, max 3; outputs `script.md`. |
| 23 | `script-gate` | gate | revise, canon-ledger-script | `script-gate` | onReject `script-gate.reject.md` (`writer`, outputs `script.md`); maxAttempts 10; `rerunOnReject: ["hand-edits-script", "tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check"]`. |
| 24 | `stamp-script` | script | script-gate | `stamp-script` | `status.py <id> script "panel passed, showrunner approved"`. |
| 25 | `publish-copy` | agent | script-gate | new | `medium`, `Read, Write`, fresh, timeout 10 min; prompt `publish-copy.md`; inputs script, publishing guide; outputs `Episodes/<id>/publish.json`. |
| 26 | `write-commit` | script | stamp-script, publish-copy | write `commit` | `git-commit.py <id> --message "<id>: outline + script (write phase)" -- Episodes/<id> Production/<id>/runs`. |
| 27 | `refs-ready` | guard | write-commit | new (F-01) | `missingRefs` empty → pass with `"all references present"`; else fail with the joined list prefixed `NEEDS_REFS: `. |
| 28 | `tts-script` | agent | refs-ready | `tts-script` | `large`, `Read, Write, Glob, Grep`, fresh, timeout 90 min, idle 30 min; inputs voice refs.json, voice registry, script, outline; outputs `tts-script.json`. |
| 29 | `validate-manifest` | script | tts-script | `validate-manifest` | inputs `tts-script.json`, voice registry; timeout 60 s. |
| 30 | `casting-gate` | gate | validate-manifest | `casting-gate` | onReject `casting-gate.reject.md` (`medium`, `Read, Edit, Write, Glob, Grep`, outputs `tts-script.json`); maxAttempts 10; `rerunOnReject: ["validate-manifest"]`. |
| 31 | `stamp-casting` | script | casting-gate | `stamp-casting` | `status.py <id> casting "guest voices approved"`. |
| 32 | `tts-generate` | script | casting-gate | `tts-generate` | inputs `tts-script.json`; outputs `audio/manifest.json`; timeout 3 h. |
| 33 | `truncation-qc` | script | tts-generate | | inputs `tts-script.json`, `audio/manifest.json`; outputs both; 30 min. |
| 34 | `pace-qc` | script | truncation-qc | | same; 60 min. |
| 35 | `breath-qc` | script | pace-qc | | same; 10 min. |
| 36 | `audio-mix` | script | breath-qc | `audio-mix` | inputs `audio/manifest.json`; outputs `audio/<mixFilename>`; 10 min; no env (F-12). |
| 37 | `audio-gate` | gate | audio-mix | `audio-gate` | onReject `audio-gate.reject.md` (`medium`, `Read, Edit, Write, Glob, Grep, Bash`, outputs `tts-script.json`); maxAttempts 5; `rerunOnReject: ["tts-generate"]`. |
| 38 | `stamp-audio` | script | audio-gate | `stamp-audio` | `status.py <id> audio "mix approved (-14 LUFS)"`. |
| 39 | `visual-direction` | agent | audio-gate | `visual-direction` | `medium`, `Read, Write, Glob, Grep`, fresh, 30 min; inputs visual style, visual refs, script, outline, **the mix WAV** (rule 1.1); outputs `images/prompts.json`. |
| 40 | `populator-check` | script | visual-direction | new (Plan C F-16) | `populator-check.py <id> --report-only`; inputs `prompts.json`; 60 s. |
| 41 | `visual-direction-fix` | agent | populator-check | new | `when` result of 40 starts with `POPULATORS_BAD`; `medium`, `Read, Edit, Write, Glob, Grep`, fresh, 15 min; prompt `visual-direction-fix.md`; outputs `prompts.json`. |
| 42 | `populator-check-final` | script | visual-direction-fix | new | same `when` as 41; `populator-check.py <id>` (exit 2 fails the run); inputs `prompts.json`. |
| 43 | `image-generate` | script | populator-check-final, audio-mix | `image-generate` | inputs `prompts.json`, visual refs; 3 h. (`audio-mix` serialises GPU use, as the YAML did.) |
| 44 | `nano-banana-generate` | script | populator-check-final | `nano-banana-generate` | inputs `prompts.json`, visual refs; 3 h. |
| 45 | `image-sheet` | script | nano-banana-generate, image-generate | `nano-banana-generate` (its second program) | outputs `images/IMAGE-SHEET.md`; 60 s. |
| 46 | `nano-banana-gate` | gate | image-sheet | `nano-banana-gate` | message `nano-banana-gate.gate.md`; onReject `nano-banana-gate.reject.md` (`medium`, `Read, Edit, Write, Glob, Grep, Bash`, outputs `prompts.json`, visual refs); maxAttempts 10; `rerunOnReject: ["nano-banana-generate", "image-generate"]`. |
| 47 | `showrunner-images` | guard | nano-banana-gate | new (F-02) | `missingShowrunnerImages` empty → pass; else fail `NEEDS_IMAGES: drop in <ids>`. |
| 48 | `image-audit-1` | agent | showrunner-images | `image-audit` | `medium`, `Read, Edit, Write, Glob, Grep, Bash`, fresh, schema `image-audit.schema.json`, timeout 30 min, idle 30 min; outputs `prompts.json`. |
| 49 | `image-regenerate-1` | script | image-audit-1 | | `when` audit 1 `pass === false`; `image-generate.py <id>`; inputs `prompts.json`; 3 h. |
| 50 | `image-audit-2` | agent | image-regenerate-1 | | `when` audit 1 failed; as 48. |
| 51 | `image-regenerate-2` | script | image-audit-2 | | `when` audit 2 ran and failed. |
| 52 | `image-audit-3` | agent | image-regenerate-2 | | `when` audit 2 ran and failed. |
| 53 | `image-audit-verdict` | guard | image-audit-3 | new (F-13) | the last audit that ran: pass → `{ pass: true, message: its summary }`; fail → `{ pass: false, message: "ambient images still failing after 3 audits: " + summary }`. |
| 54 | `image-gate` | gate | image-audit-verdict | `image-gate` | onReject `image-gate.reject.md` (`medium`, `Read, Edit, Write, Glob, Grep, Bash`, outputs `prompts.json`); maxAttempts 5; `rerunOnReject: ["image-generate", "nano-banana-generate"]`. |
| 55 | `registry-append` | script | image-gate | `stamp-images` (1 of 3) | inputs `prompts.json`; 2 min. |
| 56 | `image-sheet-final` | script | registry-append | `stamp-images` (2 of 3) | outputs `IMAGE-SHEET.md`; 60 s. |
| 57 | `stamp-images` | script | image-sheet-final | `stamp-images` (3 of 3) | `status.py <id> images "assets approved"`. |
| 58 | `assets-commit` | script | stamp-audio, stamp-images | assets `commit` | message `"<id>: assets — manifest, shot list, image sheet, casting pile (assets phase)"`; paths `Production/<id>/tts-script.json Production/<id>/images/prompts.json Production/<id>/images/IMAGE-SHEET.md <castingPileDir> <visual refs> Production/<id>/runs`. |
| 59 | `nas-mounted` | guard | assets-commit | assemble `setup` | `output.nasRoot` is a directory, else fail `mount the NAS at <nasRoot> and resume`. |
| 60 | `build-timeline` | script | nas-mounted | `build-timeline` | inputs manifest, tts-script, prompts.json, script, the mix WAV; outputs `video/timeline.json`; 5 min. |
| 61 | `render` | script | build-timeline | `render` | argv `npx remotion render <compositionId> <showRoot>/Production/<id>/video/<videoFilename> --log=error`, `cwd: <engineRoot>/render`, `env: { REMOTION_EPISODE: <id> }`; inputs `timeline.json`; outputs the video; 4 h. |
| 62 | `master` | script | render | `master` | inputs the video; outputs `video/episode-mastered.mp4`; 15 min. |
| 63 | `final-gate` | gate | master | `final-gate` | onReject `final-gate.reject.md` (`medium`, `Read, Edit, Write, Glob, Grep`, outputs `prompts.json`, `publish.json`); maxAttempts 2; `rerunOnReject: ["build-timeline"]`. |
| 64 | `finalize` | script | final-gate | `finalize` | inputs `episode-mastered.mp4`; 20 min. |
| 65 | `stamp-finalized` | script | finalize | `stamp-finalized` | `status.py <id> finalized "pushed to NAS"`. |
| 66 | `publish-kit` | script | finalize | `publish-kit` | inputs manifest, tts-script, script, publish.json; outputs `publish/upload.md`, `publish/captions.srt`; 60 s. |
| 67 | `assemble-commit` | script | stamp-finalized, publish-kit | assemble `commit` | message `"<id>: assembled + finalized — timeline, publish kit (assemble phase)"`; paths `Production/<id>/video/timeline.json Production/<id>/publish Episodes/<id>/STATUS.md Production/<id>/runs`. |
| 68 | `canon-baseline` | script | assemble-commit | canon `setup` (its git check) | `canon-diff.py <id>`; no inputs (always runs). |
| 69 | `canon-clean` | guard | canon-baseline | | result of 68 is `NO_CHANGES` → pass; else fail `Canon/ has uncommitted changes; commit or revert them, then resume`. |
| 70 | `propose` | agent | canon-clean | `propose` | `medium`, `Read, Edit, Write, Glob, Grep`, fresh, 30 min; inputs script, outline, ledger, timeline, canon-ledger; outputs continuity ledger, timeline, canon-ledger. |
| 71 | `canon-diff` | script | propose | canon `diff` | outputs `Production/<id>/canon-diff.patch`; no inputs (always runs). |
| 72 | `canon-gate` | gate | canon-diff | `canon-gate` | `when` result of 71 !== `NO_CHANGES`; onReject `canon-gate.reject.md` (`medium`, `Read, Edit, Write, Glob, Grep`); maxAttempts 10; `rerunOnReject: ["canon-diff"]`. |
| 73 | `canon-commit` | script | canon-gate | canon `commit` | message `"canon: absorb <id> (canon phase)"`; paths `<canonDir> Episodes/<id>/canon-ledger.md Production/<id>/runs`. |

(73 rows: the inventory's 55 in-scope nodes, minus `draft-complete-check` and the four `setup`/five-way merged `commit` nodes, plus the new guards, the unrolled audit, the ledger writers, `publish-copy`, `refs-ready`, `populator-check` and its fix round, and `image-sheet-final`.)

**The stage map:**

```ts
export const EPISODE_STAGE_MAP: StageMap = {
  gates: {
    "outline-gate": "DRAFT_OUTLINE", "script-gate": "DRAFT_SCRIPT", "casting-gate": "DRAFT_CASTING", "audio-gate": "DRAFT_AUDIO",
    "nano-banana-gate": "DRAFT_IMAGES", "image-gate": "DRAFT_IMAGES", "final-gate": "DRAFT_ASSEMBLY", "canon-gate": "DRAFT_CANON",
  },
  approved: {
    "stamp-outline": "OUTLINE", "stamp-script": "SCRIPT", "stamp-casting": "CASTING", "stamp-audio": "AUDIO",
    "stamp-images": "IMAGES", "final-gate": "ASSEMBLY", "publish-kit": "PUBLISH_KIT", "canon-commit": "CANON",
  },
  final: "COMPLETE",
};
```

- [ ] **Step 1: Write the failing load-time tests**

Create `engine/test/episode-pipeline.test.ts` with the harness Task 6 extends:

```ts
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { episodePipeline, EPISODE_STAGE_MAP, EPISODE_PIPELINE_NAME } from "../src/pipelines/episode.js";
import { orderSteps } from "../src/pipeline.js";
import { validateStageMap } from "../src/stages.js";
import type { ShowConfig } from "../src/show-config.js";

export const show: ShowConfig = {
  showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: { ep10: [1, 10] },
  output: { nasRoot: "/tmp/no-such-nas", mixFilename: "{slug} S{season:02d}E{episode:02d}.wav", videoFilename: "episode.mp4" },
  audio: { voiceRefsDir: "Production/voice-refs", voiceRegistry: "Canon/voice-registry.md" },
  visual: { refs: "Canon/refs.json", style: "Canon/visual-style.md", castingPileDir: "Canon/characters" },
  video: { compositionId: "Episode" },
  publish: { guide: "Canon/publishing-guide.md" },
};

describe("episodePipeline", () => {
  const p = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });

  it("loads: unique ids, no cycle, every dependsOn and rerunOnReject known, and the stage map validates", () => {
    expect(p.name).toBe(EPISODE_PIPELINE_NAME);
    expect(() => orderSteps(p)).not.toThrow();
    expect(() => validateStageMap(EPISODE_STAGE_MAP, p)).not.toThrow();
    expect(p.steps).toHaveLength(73);
  });

  it("has the eight gates in run order, each opening its DRAFT_ stage", () => {
    const gates = orderSteps(p).filter((s) => s.kind === "gate").map((s) => s.id);
    expect(gates).toEqual(["outline-gate", "script-gate", "casting-gate", "audio-gate", "nano-banana-gate", "image-gate", "final-gate", "canon-gate"]);
    expect(Object.keys(EPISODE_STAGE_MAP.gates).sort()).toEqual([...gates].sort());
  });

  it("keeps the ordering rules as dependencies: images wait for the audio gate, canon waits for the publish kit", () => {
    const by = new Map(p.steps.map((s) => [s.id, s]));
    expect(by.get("visual-direction")?.dependsOn).toEqual(["audio-gate"]);
    expect(by.get("visual-direction")?.inputs).toContain("Production/s02e01/audio/HarborLight S02E01.wav");
    expect(by.get("canon-baseline")?.dependsOn).toEqual(["assemble-commit"]);
    expect(by.get("assemble-commit")?.dependsOn).toEqual(["stamp-finalized", "publish-kit"]);
  });

  it("never declares a directory as an input or output, and names the mix by the show's pattern", () => {
    for (const s of p.steps) for (const f of [...(s.inputs ?? []), ...(s.outputs ?? [])]) expect(f, `${s.id}: ${f}`).not.toMatch(/\/$/);
    const mix = p.steps.find((s) => s.id === "audio-mix");
    expect(mix?.outputs).toEqual(["Production/s02e01/audio/HarborLight S02E01.wav"]);
    expect(episodePipeline({ show, episodeId: "ep98", engineRoot: "/engine" }).steps.find((s) => s.id === "audio-mix")?.outputs).toEqual(["Production/ep98/audio/episode.wav"]);
  });

  it("runs scripts through uv against the engine's scripts project, with the episode id first", () => {
    const ctx = { runId: "r", episodeId: "s02e01", showRoot: "/show", results: {} };
    const stamp = p.steps.find((s) => s.id === "stamp-outline");
    expect(stamp?.kind === "script" && stamp.argv(ctx)).toEqual(["uv", "run", "--project", "/engine/scripts", "python", "/engine/scripts/status.py", "s02e01", "outline", "approved at outline-gate"]);
    const render = p.steps.find((s) => s.id === "render");
    expect(render?.kind === "script" && render.argv(ctx)).toEqual(["npx", "remotion", "render", "Episode", "/show/Production/s02e01/video/episode.mp4", "--log=error"]);
    expect(render?.kind === "script" && render.cwd).toBe("/engine/render");
    expect(render?.kind === "script" && render.env?.(ctx)).toEqual({ REMOTION_EPISODE: "s02e01" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/episode-pipeline.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `engine/src/pipelines/episode.ts`**

```ts
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { EventLog } from "../events.js";
import { deriveRunState } from "../state.js";
import { formatAired, parseEpisodeId } from "../ids.js";
import { mixFilename, seasonOf, type ShowConfig } from "../show-config.js";
import { missingRefs, missingShowrunnerImages } from "../needs.js";
import { handEdits } from "../provenance.js";
import type { StageMap } from "../stages.js";
import type { AgentStep, GateStep, GuardStep, LoopStep, NestedAgentStep, Pipeline, RunContext, ScriptStep, Step, StepId } from "../steps.js";

export const EPISODE_PIPELINE_NAME = "episode";

export interface EpisodePipelineOptions {
  show: ShowConfig;
  episodeId: string;
  /** Absolute path of the engine repository checkout; `scripts/` and `render/` are under it. */
  engineRoot: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The stage each gate opens and each completion reaches (spec §3.2). ASSEMBLY is keyed on the
 *  gate itself because nothing stamps it; PUBLISH_KIT on the later of the two steps that follow
 *  finalize; CANON on the commit rather than the gate, which carries a `when` (F-05). */
export const EPISODE_STAGE_MAP: StageMap = {
  gates: {
    "outline-gate": "DRAFT_OUTLINE", "script-gate": "DRAFT_SCRIPT", "casting-gate": "DRAFT_CASTING", "audio-gate": "DRAFT_AUDIO",
    "nano-banana-gate": "DRAFT_IMAGES", "image-gate": "DRAFT_IMAGES", "final-gate": "DRAFT_ASSEMBLY", "canon-gate": "DRAFT_CANON",
  },
  approved: {
    "stamp-outline": "OUTLINE", "stamp-script": "SCRIPT", "stamp-casting": "CASTING", "stamp-audio": "AUDIO",
    "stamp-images": "IMAGES", "final-gate": "ASSEMBLY", "publish-kit": "PUBLISH_KIT", "canon-commit": "CANON",
  },
  final: "COMPLETE",
};

const REVIEWERS = ["tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check"] as const;

function str(v: unknown, fallback: string): string { return typeof v === "string" && v !== "" ? v : fallback; }
function verdictPass(v: unknown): boolean { return typeof v === "object" && v !== null && (v as { pass?: unknown }).pass === true; }
function verdictField(v: unknown, key: string): unknown { return typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined; }
async function isDir(p: string): Promise<boolean> { try { return (await stat(p)).isDirectory(); } catch { return false; } }

/** One typed pipeline per episode: the four Archon workflows as four phases of one step list, so
 *  the ordering rules of spec §1 are dependency edges and one run log holds the episode's whole
 *  history. Every path and name below comes from the show config or the episode id; the engine
 *  repository names no show. */
export function episodePipeline(opts: EpisodePipelineOptions): Pipeline {
  const { show, episodeId, engineRoot } = opts;
  parseEpisodeId(episodeId);
  const canonDir = show.canonDir ?? "Canon";
  const episodesDir = show.episodesDir ?? "Episodes";
  const productionDir = show.productionDir ?? "Production";
  const scriptsDir = path.join(engineRoot, "scripts");
  const renderDir = path.join(engineRoot, "render");
  const ep = `${episodesDir}/${episodeId}`;
  const prod = `${productionDir}/${episodeId}`;
  const voiceRefsDir = str(show.audio?.["voiceRefsDir"], "Production/voice-refs");
  const voiceRegistry = str(show.audio?.["voiceRegistry"], `${canonDir}/voice-registry.md`);
  const visualRefs = str(show.visual?.["refs"], `${canonDir}/refs.json`);
  const visualStyle = str(show.visual?.["style"], `${canonDir}/visual-style.md`);
  const castingPileDir = str(show.visual?.["castingPileDir"], `${canonDir}/characters`);
  const publishingGuide = str(show.publish?.["guide"], `${canonDir}/publishing-guide.md`);
  const compositionId = str(show.video?.["compositionId"], "Episode");
  const videoFilename = show.output.videoFilename ?? "episode.mp4";
  let season: number | undefined;
  try { season = seasonOf(episodeId, show.airMap); } catch { season = undefined; }

  const canonSpine = [
    `${canonDir}/world-overview.md`, `${canonDir}/technology.md`, `${canonDir}/timeline.md`, `${canonDir}/continuity-ledger.md`,
    `${canonDir}/series-arc.md`, `${canonDir}/episode-formula.md`, `${canonDir}/story-craft.md`, `${canonDir}/style-guide.md`,
    ...(season !== undefined ? [`${canonDir}/season-${season}.md`] : []),
  ];
  const outline = `${ep}/outline.md`;
  const script = `${ep}/script.md`;
  const premise = `${ep}/premise.md`;
  const lockedBeats = `${ep}/locked-beats.md`;
  const canonLedger = `${ep}/canon-ledger.md`;
  const status = `${ep}/STATUS.md`;
  const publishJson = `${ep}/publish.json`;
  const ttsScript = `${prod}/tts-script.json`;
  const manifest = `${prod}/audio/manifest.json`;
  const mix = `${prod}/audio/${mixFilename(show, episodeId)}`;
  const prompts = `${prod}/images/prompts.json`;
  const imageSheet = `${prod}/images/IMAGE-SHEET.md`;
  const timeline = `${prod}/video/timeline.json`;
  const video = `${prod}/video/${videoFilename}`;
  const mastered = `${prod}/video/episode-mastered.mp4`;
  const runsDir = `${prod}/runs`;

  /** argv for one of the engine's Python steps: uv runs it inside the engine's scripts project,
   *  with the show root as cwd (the executor's default) and the episode id first. */
  const py = (name: string, ...args: string[]) => (): string[] =>
    ["uv", "run", "--project", scriptsDir, "python", path.join(scriptsDir, name), episodeId, ...args];

  const stamp = (id: StepId, dependsOn: StepId[], milestone: string, detail: string): ScriptStep =>
    ({ kind: "script", id, dependsOn, argv: py("status.py", milestone, detail), outputs: [status], timeoutMs: 15_000 });

  const commit = (id: StepId, dependsOn: StepId[], message: string, paths: string[]): ScriptStep =>
    ({ kind: "script", id, dependsOn, argv: py("git-commit.py", "--message", message, "--", ...paths), timeoutMs: 30_000 });

  const reviewer = (id: (typeof REVIEWERS)[number], inputs: string[]): AgentStep => ({
    kind: "agent", id, dependsOn: ["draft"], promptFile: `${id}.md`, schemaFile: `${id}.schema.json`, model: "medium",
    allowedTools: ["Read", "Glob", "Grep"], context: "fresh", inputs, timeoutMs: 30 * MIN,
  });

  const canonReview = (id: StepId, dependsOn: StepId[], promptFile: string, inputs: string[]): AgentStep => ({
    kind: "agent", id, dependsOn, promptFile, schemaFile: "canon-review.schema.json", model: "medium",
    allowedTools: ["Read", "Glob", "Grep"], context: "fresh", inputs, timeoutMs: 30 * MIN,
  });

  const ledger = (id: StepId, reviewId: StepId, pass: "outline" | "script"): ScriptStep => ({
    kind: "script", id, dependsOn: [reviewId], outputs: [canonLedger], timeoutMs: 15_000,
    argv: (ctx) => [...py("canon-ledger.py", "--pass", pass, "--run", ctx.runId, "--rows", JSON.stringify(verdictField(ctx.results[reviewId], "deviations") ?? []))()],
  });

  const fixAgent = (id: StepId, promptFile: string, model: string, allowedTools: string[], outputs: string[]): NestedAgentStep =>
    ({ kind: "agent", id, promptFile, model, allowedTools, context: "fresh", outputs, timeoutMs: 30 * MIN });

  const imageAudit = (n: 1 | 2 | 3, dependsOn: StepId[], when?: (ctx: RunContext) => boolean): AgentStep => ({
    kind: "agent", id: `image-audit-${n}`, dependsOn, promptFile: "image-audit.md", schemaFile: "image-audit.schema.json", model: "medium",
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], context: "fresh", inputs: [visualStyle, prompts], outputs: [prompts],
    timeoutMs: 30 * MIN, idleTimeoutMs: 30 * MIN, ...(when ? { when } : {}),
  });
  const auditFailed = (n: 1 | 2 | 3) => (ctx: RunContext): boolean => {
    const v = ctx.results[`image-audit-${n}`];
    return v !== undefined && !verdictPass(v);
  };

  const steps: Step[] = [
    // ── write phase ──────────────────────────────────────────────────────────────────────────
    {
      kind: "guard", id: "previous-episode",
      // Rule 1.3: episode N+1 does not start until episode N's canon update is committed. The
      // previous episode's run logs say whether it finished; an episode with no logs at all is
      // from the archive that predates the engine, and a production id has no predecessor.
      check: async (ctx) => {
        const id = parseEpisodeId(ctx.episodeId);
        if (id.kind !== "aired" || id.episode === 1) return { pass: true, message: "no previous episode to wait for" };
        const prev = formatAired(id.season, id.episode - 1);
        const dir = path.join(ctx.showRoot, productionDir, prev, "runs");
        if (!(await isDir(dir))) return { pass: true, message: `${prev} has no run logs (archive)` };
        for (const f of await readdir(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const st = deriveRunState(await new EventLog(path.join(dir, f)).read());
          if (st.finished && st.status === "completed") return { pass: true, message: `${prev} completed in run ${st.runId}` };
        }
        return { pass: false, message: `${prev} has not completed its canon update (rule 1.3); finish it first` };
      },
    },
    {
      kind: "guard", id: "premise", dependsOn: ["previous-episode"], inputs: [premise],
      check: async (ctx) => {
        let text: string;
        try { text = await readFile(path.join(ctx.showRoot, premise), "utf8"); } catch { text = ""; }
        if (text.trim() === "") return { pass: false, message: `NEEDS_IDEA: write ${premise}` };
        return { pass: true, message: text.trim() };
      },
    } satisfies GuardStep,
    {
      kind: "agent", id: "outline", dependsOn: ["premise"], promptFile: "outline.md", model: "writer",
      allowedTools: ["Read", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 30 * MIN,
      inputs: [premise, ...canonSpine, `${episodesDir}/_TEMPLATE/outline.md`], outputs: [outline],
    },
    {
      kind: "guard", id: "hand-edits-outline", dependsOn: ["outline"],
      check: async (ctx) => ({ pass: true, message: JSON.stringify({ handEdited: await handEdits(ctx, [outline]) }) }),
    },
    canonReview("canon-review-outline", ["hand-edits-outline"], "canon-review-outline.md", [outline, premise, lockedBeats, ...canonSpine]),
    ledger("canon-ledger-outline", "canon-review-outline", "outline"),
    {
      kind: "guard", id: "outline-fix-gate", dependsOn: ["canon-review-outline"],
      // Always passes (F-04): "no" routes to the revise loop; a failing guard would skip the gate.
      check: (ctx) => ({ pass: true, message: verdictPass(ctx.results["canon-review-outline"]) ? "yes" : "no" }),
    },
    {
      kind: "loop", id: "outline-revise", dependsOn: ["outline-fix-gate"], when: (ctx) => ctx.results["outline-fix-gate"] === "no",
      until: "OUTLINE_FIXED", maxIterations: 2, inputs: [outline], outputs: [outline],
      body: { kind: "agent", id: "outline-revise-body", promptFile: "outline-revise.md", model: "writer", allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], context: "shared", idleTimeoutMs: 15 * MIN },
    },
    {
      kind: "gate", id: "outline-gate", dependsOn: ["outline-revise", "canon-ledger-outline"], messageFile: "outline-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("outline-gate-fix", "outline-gate.reject.md", "writer", ["Read", "Edit", "Write", "Glob", "Grep"], [outline]),
      rerunOnReject: ["hand-edits-outline"],
    },
    stamp("stamp-outline", ["outline-gate"], "outline", "approved at outline-gate"),
    {
      kind: "loop", id: "draft", dependsOn: ["stamp-outline"], until: "DRAFT_COMPLETE", maxIterations: 15,
      inputs: [outline, `${canonDir}/style-guide.md`, `${canonDir}/story-craft.md`], outputs: [script],
      body: { kind: "agent", id: "draft-body", promptFile: "draft.md", model: "writer", allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"], context: "fresh", idleTimeoutMs: 15 * MIN },
      // Spec §6.7: progress derived from disk — scene headers written against beats planned.
      progress: async (ctx) => {
        const count = async (rel: string, re: RegExp) => { try { return (await readFile(path.join(ctx.showRoot, rel), "utf8")).split("\n").filter((l) => re.test(l)).length; } catch { return 0; } };
        return { done: await count(script, /^## /), total: await count(outline, /^### Beat \d+/), unit: "scenes" };
      },
    } satisfies LoopStep,
    {
      kind: "guard", id: "hand-edits-script", dependsOn: ["draft"],
      check: async (ctx) => ({ pass: true, message: JSON.stringify({ handEdited: await handEdits(ctx, [script, outline]) }) }),
    },
    canonReview("canon-review-script", ["hand-edits-script"], "canon-review-script.md", [script, outline, premise, lockedBeats, ...canonSpine]),
    ledger("canon-ledger-script", "canon-review-script", "script"),
    reviewer("tone-check", [`${canonDir}/style-guide.md`, script]),
    reviewer("flow-check", [`${canonDir}/episode-formula.md`, `${canonDir}/style-guide.md`, script, outline]),
    reviewer("character-check", [script, outline, `${canonDir}/world-overview.md`, `${canonDir}/style-guide.md`]),
    reviewer("structure-check", [`${canonDir}/story-craft.md`, `${canonDir}/episode-formula.md`, outline, script]),
    reviewer("environment-check", [script, outline, `${canonDir}/technology.md`]),
    reviewer("repetition-check", [`${canonDir}/style-guide.md`, script]),
    {
      kind: "guard", id: "review-gate", dependsOn: ["canon-review-script", ...REVIEWERS],
      check: (ctx) => ({ pass: true, message: ["canon-review-script", ...REVIEWERS].every((id) => verdictPass(ctx.results[id])) ? "yes" : "no" }),
    },
    {
      kind: "loop", id: "revise", dependsOn: ["review-gate"], when: (ctx) => ctx.results["review-gate"] === "no",
      until: "REVISIONS_COMPLETE", maxIterations: 3, inputs: [script, `${canonDir}/style-guide.md`], outputs: [script],
      body: { kind: "agent", id: "revise-body", promptFile: "revise.md", model: "writer", allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], context: "shared", idleTimeoutMs: 15 * MIN },
    },
    {
      kind: "gate", id: "script-gate", dependsOn: ["revise", "canon-ledger-script"], messageFile: "script-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("script-gate-fix", "script-gate.reject.md", "writer", ["Read", "Edit", "Write", "Glob", "Grep"], [script]),
      rerunOnReject: ["hand-edits-script", ...REVIEWERS],
    },
    stamp("stamp-script", ["script-gate"], "script", "panel passed, showrunner approved"),
    {
      kind: "agent", id: "publish-copy", dependsOn: ["script-gate"], promptFile: "publish-copy.md", model: "medium",
      allowedTools: ["Read", "Write"], context: "fresh", timeoutMs: 10 * MIN, inputs: [script, publishingGuide], outputs: [publishJson],
    },
    commit("write-commit", ["stamp-script", "publish-copy"], `${episodeId}: outline + script (write phase)`, [ep, runsDir]),

    // ── assets phase ─────────────────────────────────────────────────────────────────────────
    {
      kind: "guard", id: "refs-ready", dependsOn: ["write-commit"],
      check: async (ctx) => {
        const missing = await missingRefs(ctx.showRoot, ctx.episodeId, show);
        return missing.length === 0 ? { pass: true, message: "all references present" } : { pass: false, message: `NEEDS_REFS: ${missing.join("; ")}` };
      },
    },
    {
      kind: "agent", id: "tts-script", dependsOn: ["refs-ready"], promptFile: "tts-script.md", model: "large",
      allowedTools: ["Read", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 90 * MIN, idleTimeoutMs: 30 * MIN,
      inputs: [`${voiceRefsDir}/refs.json`, voiceRegistry, script, outline], outputs: [ttsScript],
    },
    { kind: "script", id: "validate-manifest", dependsOn: ["tts-script"], argv: py("validate-manifest.py"), inputs: [ttsScript, voiceRegistry], timeoutMs: MIN },
    {
      kind: "gate", id: "casting-gate", dependsOn: ["validate-manifest"], messageFile: "casting-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("casting-gate-fix", "casting-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep"], [ttsScript]),
      rerunOnReject: ["validate-manifest"],
    },
    stamp("stamp-casting", ["casting-gate"], "casting", "guest voices approved"),
    { kind: "script", id: "tts-generate", dependsOn: ["casting-gate"], argv: py("tts-generate.py"), inputs: [ttsScript], outputs: [manifest], timeoutMs: 3 * HOUR },
    { kind: "script", id: "truncation-qc", dependsOn: ["tts-generate"], argv: py("truncation-qc.py"), inputs: [ttsScript, manifest], outputs: [ttsScript, manifest], timeoutMs: 30 * MIN },
    { kind: "script", id: "pace-qc", dependsOn: ["truncation-qc"], argv: py("pace-qc.py"), inputs: [ttsScript, manifest], outputs: [ttsScript, manifest], timeoutMs: HOUR },
    { kind: "script", id: "breath-qc", dependsOn: ["pace-qc"], argv: py("breath-qc.py"), inputs: [ttsScript, manifest], outputs: [ttsScript, manifest], timeoutMs: 10 * MIN },
    { kind: "script", id: "audio-mix", dependsOn: ["breath-qc"], argv: py("audio-mix.py"), inputs: [manifest], outputs: [mix], timeoutMs: 10 * MIN },
    {
      kind: "gate", id: "audio-gate", dependsOn: ["audio-mix"], messageFile: "audio-gate.gate.md", maxAttempts: 5,
      onReject: fixAgent("audio-gate-fix", "audio-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], [ttsScript]),
      rerunOnReject: ["tts-generate"],
    },
    stamp("stamp-audio", ["audio-gate"], "audio", "mix approved (-14 LUFS)"),
    {
      // Rule 1.1: the Vision module takes the approved mix as an input, so the ordering cannot be
      // lost by editing a dependency list — the mix is declared here as well as depended on.
      kind: "agent", id: "visual-direction", dependsOn: ["audio-gate"], promptFile: "visual-direction.md", model: "medium",
      allowedTools: ["Read", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 30 * MIN,
      inputs: [visualStyle, visualRefs, script, outline, mix], outputs: [prompts],
    },
    { kind: "script", id: "populator-check", dependsOn: ["visual-direction"], argv: py("populator-check.py", "--report-only"), inputs: [prompts], timeoutMs: MIN },
    {
      kind: "agent", id: "visual-direction-fix", dependsOn: ["populator-check"], when: (ctx) => String(ctx.results["populator-check"] ?? "").startsWith("POPULATORS_BAD"),
      promptFile: "visual-direction-fix.md", model: "medium", allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 15 * MIN,
      inputs: [prompts, visualRefs], outputs: [prompts],
    },
    {
      kind: "script", id: "populator-check-final", dependsOn: ["visual-direction-fix"], when: (ctx) => String(ctx.results["populator-check"] ?? "").startsWith("POPULATORS_BAD"),
      argv: py("populator-check.py"), inputs: [prompts], timeoutMs: MIN,
    },
    { kind: "script", id: "image-generate", dependsOn: ["populator-check-final", "audio-mix"], argv: py("image-generate.py"), inputs: [prompts, visualRefs], timeoutMs: 3 * HOUR },
    { kind: "script", id: "nano-banana-generate", dependsOn: ["populator-check-final"], argv: py("nano-banana-generate.py"), inputs: [prompts, visualRefs], timeoutMs: 3 * HOUR },
    { kind: "script", id: "image-sheet", dependsOn: ["nano-banana-generate", "image-generate"], argv: py("image-sheet.py"), inputs: [prompts], outputs: [imageSheet], timeoutMs: MIN },
    {
      kind: "gate", id: "nano-banana-gate", dependsOn: ["image-sheet"], messageFile: "nano-banana-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("nano-banana-gate-fix", "nano-banana-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], [prompts, visualRefs]),
      rerunOnReject: ["nano-banana-generate", "image-generate"],
    },
    {
      kind: "guard", id: "showrunner-images", dependsOn: ["nano-banana-gate"],
      check: async (ctx) => {
        const missing = await missingShowrunnerImages(ctx.showRoot, ctx.episodeId, show);
        return missing.length === 0 ? { pass: true, message: "every showrunner-made shot is on disk" } : { pass: false, message: `NEEDS_IMAGES: drop in ${missing.join(", ")} under ${prod}/images/ and resume` };
      },
    },
    imageAudit(1, ["showrunner-images"]),
    { kind: "script", id: "image-regenerate-1", dependsOn: ["image-audit-1"], when: auditFailed(1), argv: py("image-generate.py"), inputs: [prompts], timeoutMs: 3 * HOUR },
    imageAudit(2, ["image-regenerate-1"], auditFailed(1)),
    { kind: "script", id: "image-regenerate-2", dependsOn: ["image-audit-2"], when: auditFailed(2), argv: py("image-generate.py"), inputs: [prompts], timeoutMs: 3 * HOUR },
    imageAudit(3, ["image-regenerate-2"], auditFailed(2)),
    {
      kind: "guard", id: "image-audit-verdict", dependsOn: ["image-audit-3"],
      check: (ctx) => {
        const last = ctx.results["image-audit-3"] ?? ctx.results["image-audit-2"] ?? ctx.results["image-audit-1"];
        const summary = String(verdictField(last, "summary") ?? "");
        return verdictPass(last) ? { pass: true, message: summary } : { pass: false, message: `ambient images still failing after 3 audits: ${summary}` };
      },
    },
    {
      kind: "gate", id: "image-gate", dependsOn: ["image-audit-verdict"], messageFile: "image-gate.gate.md", maxAttempts: 5,
      onReject: fixAgent("image-gate-fix", "image-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], [prompts]),
      rerunOnReject: ["image-generate", "nano-banana-generate"],
    },
    { kind: "script", id: "registry-append", dependsOn: ["image-gate"], argv: py("registry-append.py"), inputs: [prompts], timeoutMs: 2 * MIN },
    { kind: "script", id: "image-sheet-final", dependsOn: ["registry-append"], argv: py("image-sheet.py"), inputs: [prompts], outputs: [imageSheet], timeoutMs: MIN },
    stamp("stamp-images", ["image-sheet-final"], "images", "assets approved"),
    commit("assets-commit", ["stamp-audio", "stamp-images"], `${episodeId}: assets — manifest, shot list, image sheet, casting pile (assets phase)`,
      [ttsScript, prompts, imageSheet, castingPileDir, visualRefs, runsDir]),

    // ── assemble phase ───────────────────────────────────────────────────────────────────────
    {
      kind: "guard", id: "nas-mounted", dependsOn: ["assets-commit"],
      // Checked before the render so a finalize cannot fail after a four-hour render.
      check: async () => (await isDir(show.output.nasRoot)) ? { pass: true, message: `NAS at ${show.output.nasRoot}` } : { pass: false, message: `mount the NAS at ${show.output.nasRoot} and resume` },
    },
    { kind: "script", id: "build-timeline", dependsOn: ["nas-mounted"], argv: py("build-timeline.py"), inputs: [manifest, ttsScript, prompts, script, mix], outputs: [timeline], timeoutMs: 5 * MIN },
    {
      kind: "script", id: "render", dependsOn: ["build-timeline"], cwd: renderDir, timeoutMs: 4 * HOUR,
      argv: (ctx) => ["npx", "remotion", "render", compositionId, path.join(ctx.showRoot, video), "--log=error"],
      env: (ctx) => ({ REMOTION_EPISODE: ctx.episodeId }), inputs: [timeline], outputs: [video],
    },
    { kind: "script", id: "master", dependsOn: ["render"], argv: py("master-video.py"), inputs: [video], outputs: [mastered], timeoutMs: 15 * MIN },
    {
      kind: "gate", id: "final-gate", dependsOn: ["master"], messageFile: "final-gate.gate.md", maxAttempts: 2,
      onReject: fixAgent("final-gate-fix", "final-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep"], [prompts, publishJson]),
      rerunOnReject: ["build-timeline"],
    },
    { kind: "script", id: "finalize", dependsOn: ["final-gate"], argv: py("finalize-video.py"), inputs: [mastered], timeoutMs: 20 * MIN },
    stamp("stamp-finalized", ["finalize"], "finalized", "pushed to NAS"),
    { kind: "script", id: "publish-kit", dependsOn: ["finalize"], argv: py("publish-kit.py"), inputs: [manifest, ttsScript, script, publishJson], outputs: [`${prod}/publish/upload.md`, `${prod}/publish/captions.srt`], timeoutMs: MIN },
    commit("assemble-commit", ["stamp-finalized", "publish-kit"], `${episodeId}: assembled + finalized — timeline, publish kit (assemble phase)`,
      [timeline, `${prod}/publish`, status, runsDir]),

    // ── canon phase (rule 1.2: after the publish kit) ────────────────────────────────────────
    { kind: "script", id: "canon-baseline", dependsOn: ["assemble-commit"], argv: py("canon-diff.py"), timeoutMs: 15_000 },
    {
      kind: "guard", id: "canon-clean", dependsOn: ["canon-baseline"],
      check: (ctx) => ctx.results["canon-baseline"] === "NO_CHANGES"
        ? { pass: true, message: "canon tree is clean" }
        : { pass: false, message: `${canonDir}/ has uncommitted changes (${String(ctx.results["canon-baseline"])}); commit or revert them, then resume` },
    },
    {
      kind: "agent", id: "propose", dependsOn: ["canon-clean"], promptFile: "propose.md", model: "medium",
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 30 * MIN,
      inputs: [script, outline, `${canonDir}/continuity-ledger.md`, `${canonDir}/timeline.md`, canonLedger],
      outputs: [`${canonDir}/continuity-ledger.md`, `${canonDir}/timeline.md`, canonLedger],
    },
    { kind: "script", id: "canon-diff", dependsOn: ["propose"], argv: py("canon-diff.py"), outputs: [`${prod}/canon-diff.patch`], timeoutMs: 15_000 },
    {
      kind: "gate", id: "canon-gate", dependsOn: ["canon-diff"], when: (ctx) => ctx.results["canon-diff"] !== "NO_CHANGES", messageFile: "canon-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("canon-gate-fix", "canon-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep"], [canonLedger]),
      rerunOnReject: ["canon-diff"],
    },
    commit("canon-commit", ["canon-gate"], `canon: absorb ${episodeId} (canon phase)`, [canonDir, canonLedger, runsDir]),
  ];

  return { name: EPISODE_PIPELINE_NAME, steps };
}
```

**Two engine seams this code assumes, which Task 5 also adds because the inventory's port needs them and nothing else supplies them:**

1. **`AgentStep.schemaFile?: string`** — the schema as a file under the prompts directory, beside `schema?: JsonSchema`. The show keeps schemas as `<step>.schema.json` files (Plan C's layout), and the engine repository may not hold their contents. Add the field to `AgentStep` in `steps.ts` (doc: "the schema, as a draft-07 file relative to the prompts directory; exclusive with `schema`; the executor reads it with `loadPrompt` and applies the same draft-07 check"), have `createAgentExecutor` load it when `step.schema` is absent, and add one test in `agent-step.test.ts` (a step with `schemaFile` whose file is written into the temp prompts dir; the query receives `outputFormat` built from it; a step with both fields is rejected with `schema and schemaFile are exclusive`).
2. **`GateStep.messageFile?: string`** — the gate message as a prompt file, rendered through `renderPrompt` with the run context, beside `message?: (ctx) => string`. Exactly one of the two must be set (`orderSteps` refuses a gate with neither or both). The runner renders a `messageFile` gate through a new `RunOptions.renderGateMessage?: (file: string, ctx: RunContext) => Promise<string>` supplied by the caller — the agent executor's owner has the prompts directory and the show config, so `createAgentExecutor` gains a sibling export `createGateMessageRenderer(opts: AgentExecutorOptions): (file, ctx) => Promise<string>` that reuses `loadPrompt` + `renderPrompt` with the same `RenderExtra`. When `messageFile` is set and no renderer was given, `runGateStep` fails the gate with `gate "<id>": messageFile needs RunOptions.renderGateMessage`. Tests: one in `gate.test.ts` (a `messageFile` gate whose renderer returns `rendered:<file>:<episodeId>`; the `gate_opened` message is that string), one in `pipeline.test.ts` (neither/both refused).

Make `message` optional on `GateStep` (`message?: (ctx: RunContext) => string`) and update `runGateStep`: `const message = step.messageFile !== undefined ? await renderGateMessage(step.messageFile, ctx) : step.message!(ctx);` (with the guard above). Existing tests all use `message`, so they stay green.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: PASS, typecheck silent, show-name grep empty.

- [ ] **Step 5: Export and commit**

Add `export * from "./pipelines/episode.js";` to `engine/src/index.ts`.

```bash
cd ~/GitHub/Showrunner && git add engine/src engine/test
git commit -F - <<'EOF'
engine: the episode pipeline — 73 typed steps, one run per episode

The five Archon workflows as four phases of one step list: write, assets,
assemble, canon, with the ordering rules of spec §1 as dependency edges,
the eight gates and their rerunOnReject sets, the canon reviewer's two
passes with their ledger writers and hand-edit guards, the unrolled image
audit, the three Needs guards, and the stage map. Gates may name their
message as a prompt file and agent steps their schema as a file, so the
show's prompts directory stays the only home of prompt text.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---
## Task 6: The whole pipeline walked with fake executors, and the README

**Files:**
- Modify: `engine/test/episode-pipeline.test.ts` (add the walk)
- Modify: `README.md` (a new section "The episode pipeline"; the resume contract gains the reset and resume rules; "The event log" gains the two kinds)

**Interfaces:**
- Consumes: everything Tasks 1–5 produced.
- Produces: the fake-executor harness (`fakeExecutors(root)`) that Task 10's exercise and Plan E's tests reuse; the documented step ids and stage transitions.

- [ ] **Step 1: Write the walk**

Append to `engine/test/episode-pipeline.test.ts`:

```ts
import { run, answerGate, resumeRun } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import { deriveRunState } from "../src/state.js";
import { deriveStage } from "../src/stages.js";
import { episodeNeeds } from "../src/needs.js";
import type { Executors, RunContext, ScriptStep } from "../src/steps.js";

/** Fakes that behave like the real steps at the level the pipeline can see: a script writes its
 *  declared outputs (only when absent, as the real scripts do) and prints the result line the
 *  next step reads; an agent writes the file its prompt would and returns the verdict shape its
 *  schema demands. `knobs` lets a test make one step fail once or one verdict fail once. */
export function fakeExecutors(root: string, knobs: { failOnce?: Set<string>; reviewFailOnce?: Set<string> } = {}) {
  const w = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); };
  const exists = async (rel: string) => { try { await readFile(path.join(root, rel)); return true; } catch { return false; } };
  const calls: string[] = [];
  const results: Record<string, string> = {
    "validate-manifest": "MANIFEST_OK 120 segments, 2 guests", "audio-mix": "MIX_OK 1500.0s -14.0 LUFS", "populator-check": "POPULATORS_OK 3 briefs",
    "nano-banana-generate": "NANO_OK 1/1", "build-timeline": "TIMELINE_OK 3 shots", "master": "MASTER_OK episode-mastered.mp4",
    "canon-baseline": "NO_CHANGES", "canon-diff": "CHANGED 2 files, 30 lines", "image-sheet": "SHEET_OK", "image-sheet-final": "SHEET_OK",
  };
  const script: Executors["script"] = async (step: ScriptStep, ctx) => {
    calls.push(step.id);
    if (knobs.failOnce?.delete(step.id)) return { ok: false, error: `${step.id} failed once` };
    const argv = step.argv(ctx);
    const name = path.basename(argv[5] ?? argv[0] ?? "");
    if (name === "image-generate.py" || name === "nano-banana-generate.py") {
      const doc = JSON.parse(await readFile(path.join(root, `Production/${ctx.episodeId}/images/prompts.json`), "utf8")) as { shots: { id: string; type: string; source?: string }[] };
      for (const s of doc.shots) {
        const mine = name === "image-generate.py" ? s.type === "ambient" : s.type === "character";
        if (mine && s.source !== "showrunner" && !(await exists(`Production/${ctx.episodeId}/images/${s.id}.png`))) await w(`Production/${ctx.episodeId}/images/${s.id}.png`, "png");
      }
    }
    for (const out of step.outputs ?? []) if (!(await exists(out))) await w(out, `${step.id}\n`);
    return { ok: true, result: results[step.id] ?? `${step.id} OK` };
  };
  let scenes = 0;
  const pass = (verdict: string) => ({ pass: true, verdict, issues: [] as string[] });
  const agent: Executors["agent"] = async (step, ctx: RunContext) => {
    calls.push(step.id);
    const ep = ctx.episodeId;
    if (knobs.failOnce?.delete(step.id)) return { ok: false, error: `${step.id} failed once`, toolCalls: 1 };
    switch (step.id) {
      case "outline":
        await w(`Episodes/${ep}/outline.md`, "# Ep\n\n## Cast\n- Vale (recurring, speaks)\n- Harbor (location)\n\n## Beat outline\n### Beat 1 — a\n### Beat 2 — b\n### Beat 3 — c\n");
        return { ok: true, text: "outline written", toolCalls: 4 };
      case "canon-review-outline": case "canon-review-script": {
        const fail = knobs.reviewFailOnce?.delete(step.id);
        return { ok: true, text: "", toolCalls: 2, verdict: { ...pass(fail ? "CANON FAILED" : "CANON PASSED"), pass: !fail, issues: fail ? ["beat 2 — x — y"] : [], deviations: step.id === "canon-review-script" ? [{ where: "script.md SCENE TWO", deviation: "d", canon: "c", provenance: "rejection-note", evidence: "e" }] : [] } };
      }
      case "outline-revise-body": return { ok: true, text: "OUTLINE_FIXED", toolCalls: 3 };
      case "draft-body": {
        scenes++;
        const prior = (await exists(`Episodes/${ep}/script.md`)) ? await readFile(path.join(root, `Episodes/${ep}/script.md`), "utf8") : "# Script\n";
        await w(`Episodes/${ep}/script.md`, `${prior}## SCENE ${scenes}\nprose\n`);
        return { ok: true, text: scenes >= 3 ? "DRAFT_COMPLETE" : "wrote a scene", toolCalls: 5 };
      }
      case "tone-check": case "flow-check": case "character-check": case "structure-check": case "environment-check": case "repetition-check":
        return { ok: true, text: "", toolCalls: 2, verdict: pass("PASSED") };
      case "revise-body": return { ok: true, text: "REVISIONS_COMPLETE", toolCalls: 2 };
      case "publish-copy": await w(`Episodes/${ep}/publish.json`, JSON.stringify({ logline: "A week." })); return { ok: true, text: "A week.", toolCalls: 1 };
      case "tts-script": await w(`Production/${ep}/tts-script.json`, "{}"); return { ok: true, text: "cast: Vale; guests: none", toolCalls: 3 };
      case "visual-direction":
        await w(`Production/${ep}/images/prompts.json`, JSON.stringify({ episode: ep, shots: [
          { id: "s01-wide", scene: "COLD OPEN", type: "ambient", prompt: "p", seed: 1 }, { id: "s02-vale", scene: "SCENE 2", type: "character", refs: ["vale"], brief: "b", seed: 2 },
          { id: "s03-hand", scene: "SCENE 3", type: "character", refs: ["vale"], brief: "b", seed: 3, source: "showrunner" },
        ] }));
        return { ok: true, text: "3 shots", toolCalls: 2 };
      case "image-audit-1": case "image-audit-2": case "image-audit-3":
        return { ok: true, text: "", toolCalls: 4, verdict: { pass: true, verdict: "IMAGES_CLEAN", fixed: [], flagged: [], summary: "all clean" } };
      case "propose": await w("Canon/continuity-ledger.md", "changed\n"); return { ok: true, text: "ledger updated", toolCalls: 3 };
      default:
        // every fix agent
        if (step.outputs?.[0]) await w(step.outputs[0], `${step.id} edited ${String(ctx.results[`${step.id.replace(/-fix$/, "")}:rejection`] ?? "")}\n`);
        return { ok: true, text: `${step.id} done`, toolCalls: 1 };
    }
  };
  return { executors: { script, agent } as Executors, calls, w };
}

describe("the episode pipeline, walked", () => {
  it("premise → eight gates → COMPLETE, with the stage right at every stop, a script rejection re-running the panel, an audio rejection re-running synthesis, a failure resumed, and NEEDS_IMAGES while a showrunner shot is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const nas = await mkdtemp(path.join(tmpdir(), "nas-"));
    const cfg: ShowConfig = { ...show, output: { ...show.output, nasRoot: nas } };
    const { executors, calls, w } = fakeExecutors(root, { failOnce: new Set(["tts-generate"]) });
    for (const f of ["world-overview", "technology", "timeline", "continuity-ledger", "series-arc", "episode-formula", "story-craft", "style-guide", "season-2", "visual-style", "voice-registry", "publishing-guide"]) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Canon/refs.json", JSON.stringify({ vale: { kind: "human", ref: "Canon/characters/Vale/ref.png" }, harbor: { kind: "location", ref: "Canon/locations/harbor.png" } }));
    await w("Canon/characters/Vale/ref.png", "png"); await w("Canon/locations/harbor.png", "png");
    await w("Production/voice-refs/refs.json", JSON.stringify({ cast: { Vale: { ref: "Production/voice-refs/vale.wav", status: "LOCKED" } } })); await w("Production/voice-refs/vale.wav", "wav");
    await w("Episodes/_TEMPLATE/outline.md", "template\n");
    await w("Episodes/s02e01/premise.md", "A week.\n");
    const pipeline = episodePipeline({ show: cfg, episodeId: "s02e01", engineRoot: "/engine" });
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root, trigger: "test" };
    const go = () => run({ pipeline, ctx, log, executors });
    const stage = async () => deriveStage(deriveRunState(await log.read()), EPISODE_STAGE_MAP, await episodeNeeds(root, "s02e01", cfg));
    const answer = (gate: string, approved: boolean, notes?: string) => answerGate(log, "r1", gate, { approved, by: "showrunner", ...(notes !== undefined ? { notes } : {}) });

    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "outline-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_OUTLINE");
    expect(calls.filter((c) => c === "outline-revise-body")).toHaveLength(0); // the canon review passed, so the revise loop was bypassed
    await answer("outline-gate", true);

    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_SCRIPT");
    expect(calls.filter((c) => c === "draft-body")).toHaveLength(3);
    const drafted = (await log.read()).filter((e) => e.kind === "step_progress" && e.stepId === "draft").map((e) => e.payload["done"]);
    expect(drafted).toEqual([1, 2, 3]);
    // a rejection: the fix agent edits the script, then the hand-edit guard and the six reviewers run again before the gate reopens
    const before = calls.length;
    await answer("script-gate", false, "scene two is flat");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 2 } });
    const rerun = calls.slice(before);
    expect(rerun[0]).toBe("script-gate-fix");
    expect(rerun).toEqual(expect.arrayContaining(["tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check"]));
    expect(rerun).not.toContain("draft-body");
    expect(rerun).not.toContain("canon-review-script"); // not in rerunOnReject; only the hand-edit guard and the panel
    await answer("script-gate", true);

    // the write phase closes; refs are present; tts-generate fails once → the run fails, and resumes
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "casting-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_CASTING");
    await answer("casting-gate", true);
    expect(await go()).toEqual({ status: "failed", stepId: "tts-generate", error: "tts-generate failed once" });
    expect(await stage()).toBe("CASTING");
    await resumeRun(log, "r1", "showrunner");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "audio-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_AUDIO");
    expect(calls.filter((c) => c === "tts-script")).toHaveLength(1); // the resume did not re-run the agent step
    // an audio rejection re-runs synthesis, the QC passes and the mix
    const beforeAudio = calls.length;
    await answer("audio-gate", false, "segment 12 is rushed");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "audio-gate", attempt: 2 } });
    expect(calls.slice(beforeAudio)).toEqual(["audio-gate-fix", "tts-generate", "truncation-qc", "pace-qc", "breath-qc", "audio-mix"]);
    await answer("audio-gate", true);

    // images: the showrunner shot is missing, so NEEDS_IMAGES shows and the guard after the gate stops the line
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "nano-banana-gate", attempt: 1 } });
    expect(await stage()).toBe("NEEDS_IMAGES");
    await answer("nano-banana-gate", true);
    expect(await go()).toMatchObject({ status: "failed", stepId: "showrunner-images" });
    await w("Production/s02e01/images/s03-hand.png", "png");
    expect(await stage()).toBe("AUDIO");
    await resumeRun(log, "r1");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "image-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_IMAGES");
    expect(calls.filter((c) => c.startsWith("image-audit-"))).toEqual(["image-audit-1"]); // rounds 2 and 3 bypassed after a clean audit
    await answer("image-gate", true);

    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "final-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_ASSEMBLY");
    await answer("final-gate", true);
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "canon-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_CANON");
    await answer("canon-gate", true);
    expect(await go()).toEqual({ status: "completed" });
    expect(await stage()).toBe("COMPLETE");

    const state = deriveRunState(await log.read());
    expect(state.results["script-gate:rejections"]).toEqual(["scene two is flat"]);
    expect(state.results["audio-gate:rejections"]).toEqual(["segment 12 is rushed"]);
    expect(Object.values(state.steps).filter((s) => s === "bypassed").length).toBeGreaterThan(0);
    expect(await readFile(path.join(root, "Episodes/s02e01/STATUS.md"), "utf8")).toContain("stamp-outline");
  });

  it("stops at NEEDS_REFS when the outline names a recurring subject the bible lacks, and continues once it exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const { executors, w } = fakeExecutors(root);
    for (const f of ["world-overview", "technology", "timeline", "continuity-ledger", "series-arc", "episode-formula", "story-craft", "style-guide", "season-2", "publishing-guide", "voice-registry"]) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Canon/refs.json", JSON.stringify({ harbor: { kind: "location", ref: "Canon/locations/harbor.png" } })); await w("Canon/locations/harbor.png", "png");
    await w("Production/voice-refs/refs.json", JSON.stringify({ cast: {} }));
    await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n");
    const pipeline = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const go = () => run({ pipeline, ctx, log, executors });
    await go(); await answerGate(log, "r1", "outline-gate", { approved: true });
    await go(); await answerGate(log, "r1", "script-gate", { approved: true });
    const r = await go();
    expect(r).toMatchObject({ status: "failed", stepId: "refs-ready" });
    expect(r.status === "failed" && r.error).toMatch(/^NEEDS_REFS: Vale: no entry in Canon\/refs.json/);
    expect(deriveStage(deriveRunState(await log.read()), EPISODE_STAGE_MAP, await episodeNeeds(root, "s02e01", show))).toBe("NEEDS_REFS");
    await w("Canon/refs.json", JSON.stringify({ vale: { kind: "human", ref: "Canon/characters/Vale/ref.png" }, harbor: { kind: "location", ref: "Canon/locations/harbor.png" } }));
    await w("Canon/characters/Vale/ref.png", "png");
    await w("Production/voice-refs/refs.json", JSON.stringify({ cast: { Vale: { ref: "Production/voice-refs/vale.wav", status: "LOCKED" } } })); await w("Production/voice-refs/vale.wav", "wav");
    await resumeRun(log, "r1");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "casting-gate" } });
  });

  it("routes a failed canon review through the outline-revise loop before the gate, and refuses to start s02e02 while s02e01 has not completed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const { executors, calls, w } = fakeExecutors(root, { reviewFailOnce: new Set(["canon-review-outline"]) });
    for (const f of ["world-overview", "technology", "timeline", "continuity-ledger", "series-arc", "episode-formula", "story-craft", "style-guide", "season-2"]) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n"); await w("Episodes/s02e02/premise.md", "Another.\n");
    const p1 = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });
    const log1 = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    expect(await run({ pipeline: p1, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: log1, executors })).toMatchObject({ status: "waiting", gate: { stepId: "outline-gate" } });
    expect(calls).toContain("outline-revise-body");
    expect(deriveRunState(await log1.read()).results["outline-fix-gate"]).toBe("no");
    const p2 = episodePipeline({ show, episodeId: "s02e02", engineRoot: "/engine" });
    const log2 = new EventLog(EventLog.logPath(root, "s02e02", "r1"));
    const r = await run({ pipeline: p2, ctx: { runId: "r1", episodeId: "s02e02", showRoot: root }, log: log2, executors });
    expect(r).toMatchObject({ status: "failed", stepId: "previous-episode" });
    expect(r.status === "failed" && r.error).toMatch(/s02e01 has not completed its canon update/);
  });
});
```

The `messageFile` gates render through `RunOptions.renderGateMessage`; in these tests pass `renderGateMessage: async (file, ctx) => `${file} for ${ctx.episodeId}`` in every `run()` call (add it to `go()` and the direct calls).

- [ ] **Step 2: Run, fix what the walk finds, and keep the fixes in the pipeline definition, not in the test**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/episode-pipeline.test.ts`
Expected: PASS. Anything that fails is a defect in Task 5's definition or in Tasks 1–4's runner changes, and the fix goes there; report each such fix by file and line.

- [ ] **Step 3: The README**

In `README.md`:

1. Under "The event log", add the two kinds to the table: `step_reset` — "written by a gate rejection (`by` is the gate) or by `resetSteps` (`by` is `operator`): the step returns to pending and its result leaves `ctx.results`"; `run_resumed` — "written by `resumeRun` or by `resetSteps` on a finished run: the run is no longer finished, and failed and swept steps are pending again".
2. Under "The resume contract", add three bullets: **A gate rejection re-runs the steps the gate names** (`rerunOnReject`) and everything downstream of them, after the fix agent, before the gate reopens; the reset is recorded once per rejection. **A failed run is resumed with `resumeRun`**, which continues from the failed step without re-running any completed agent step. **`resetSteps` is the operator's "re-run from here"**; on a run with an open gate it leaves the gate open with its original message.
3. A new section "The episode pipeline" after "Status vocabulary": one paragraph on the factory (`episodePipeline({ show, episodeId, engineRoot })`, one run per episode, the four phases), the table of the eight gates with the stage each opens and the steps its rejection re-runs, the three guards that stop the line (`premise`, `refs-ready`, `showrunner-images`) and what clears each, the `## Cast` grammar the outline must carry, the `source` field on shots, the canon ledger's path and row shape, and the operator's two recovery moves (`resumeRun`, `resetSteps`). Note that `{{season}}` in a prompt fails for a production id absent from `airMap`, so a real run on such an id needs an entry or a prompt without the variable.

- [ ] **Step 4: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/test/episode-pipeline.test.ts README.md engine/src
git commit -F - <<'EOF'
engine: walk the episode pipeline end to end with fake executors; document it

Premise to COMPLETE through all eight gates, with a script rejection
re-running the review panel, an audio rejection re-running synthesis, a
failed step resumed without re-running any agent step, NEEDS_REFS and
NEEDS_IMAGES stopping the line where the spec puts them, and rule 1.3
refusing the next episode. The README gains the pipeline section and the
resume contract's reset and resume rules.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---
## Task 7: The scripts the pipeline needs — `git-commit.py`, `canon-ledger.py`, `populator-check.py --report-only`, and the `source` field

**Files:**
- Create: `scripts/git-commit.py`, `scripts/canon-ledger.py`, `scripts/tests/test_git_commit.py`, `scripts/tests/test_canon_ledger.py`
- Modify: `scripts/populator-check.py:47-80`, `scripts/nano-banana-generate.py:420` and `:536-541`, `scripts/image-generate.py:81-91`, `scripts/image-sheet.py:61-62` and the lines that render a shot
- Modify: `scripts/tests/test_populator_check.py`, `scripts/tests/test_nano_banana_generate.py`, `scripts/tests/test_image_sheet.py`
- Modify: `README.md` Scripts section (two new scripts; the `source` rule)

**Interfaces:**
- Consumes: the scripts' convention (`root = os.path.abspath(sc.show_root(sys.argv)); cfg = sc.load(root); os.chdir(root)`; positional argv; one-line error exit; result line last).
- Produces:
  - `git-commit.py <episode> --message <text> [--show-root <path>] -- <path>...` — stages each listed path that exists (`git add -A -- <path>`), commits when anything is staged, prints `COMMIT_OK <short sha>` or `COMMIT_SKIPPED nothing staged`; exit 0 both ways; a git failure exits non-zero with git's stderr. The message is used verbatim (the pipeline already substituted the episode id).
  - `canon-ledger.py <episode> --pass <outline|script> --run <runId> --rows <json-array> [--show-root <path>]` — appends rows to `<episodesDir>/<episode>/canon-ledger.md`, creating the file with the header below when absent and there is at least one row; a row whose `where` and `deviation` already appear is not appended; prints `LEDGER_OK <new> new rows, <total> total`. Row objects: `{where, deviation, canon, provenance, evidence}`; the written Evidence cell is `<evidence> (<pass> pass, run <runId>)`; Disposition is `PENDING`.
  - `populator-check.py <episode> --report-only` — exit 0 always; when briefs are dirty the last stdout line is `POPULATORS_BAD <n> briefs: <id>, <id>` (the per-brief detail still goes to stderr); when clean, `POPULATORS_OK <n> briefs` as today.
  - `nano-banana-generate.py` skips a shot whose `source` is `"showrunner"` (recorded as `SKIPPED-showrunner`), and exits 0 on `NANO_PARTIAL` as well as `NANO_OK` (the gate shows the partial result; only a run with no success at all exits 1).
  - `image-generate.py` skips a `source: "showrunner"` shot with `skip <id> (showrunner-made)` plus the `[MISSING — drop the file here]` marker when the PNG is absent, before the character/ambient branch.
  - `image-sheet.py` appends ` — made by hand by the showrunner` to the line of any shot whose `source` is `"showrunner"`.

**The ledger file's header** (from the inventory §5.3), written once:

```markdown
# Canon ledger — <episode>

> Deliberate deviations from the canon store, recorded by the canon reviewer because their
> provenance is the showrunner's, not an agent's. Consumed at the end-of-episode canon moment:
> each ACCEPTED row becomes an AS SHIPPED canon change; each WITHDRAWN row is dropped.

| # | Where | The deviation | Canon it departs from | Provenance | Evidence | Disposition |
|---|---|---|---|---|---|---|
```

- [ ] **Step 1: Write the failing tests**

`scripts/tests/test_git_commit.py`:

```python
import json, os, subprocess, sys
from pathlib import Path
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "git-commit.py"

def make_show(tmp_path: Path) -> Path:
    root = tmp_path / "show"
    root.mkdir()
    (root / "showrunner.json").write_text(json.dumps({
        "showName": "Harbor Light", "showSlug": "HarborLight", "promptsDir": "prompts",
        "models": {"medium": "m", "large": "l", "writer": "w"}, "airMap": {}, "output": {"nasRoot": "/nas"}}))
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=root, check=True)
    return root

def run(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=root, capture_output=True, text=True)

def test_commits_listed_paths_that_exist_and_reports_the_sha(tmp_path):
    root = make_show(tmp_path)
    (root / "Episodes" / "s02e01").mkdir(parents=True)
    (root / "Episodes" / "s02e01" / "outline.md").write_text("o\n")
    r = run(root, "s02e01", "--message", "s02e01: outline + script (write phase)", "--", "Episodes/s02e01", "Production/s02e01/runs")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1].startswith("COMMIT_OK ")
    log = subprocess.run(["git", "log", "-1", "--format=%s"], cwd=root, capture_output=True, text=True).stdout.strip()
    assert log == "s02e01: outline + script (write phase)"
    assert subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True).stdout == ""

def test_skips_when_nothing_is_staged(tmp_path):
    root = make_show(tmp_path)
    r = run(root, "s02e01", "--message", "m", "--", "Episodes/s02e01")
    assert r.returncode == 0
    assert r.stdout.strip().splitlines()[-1] == "COMMIT_SKIPPED nothing staged"

def test_refuses_a_missing_message_or_paths(tmp_path):
    root = make_show(tmp_path)
    assert run(root, "s02e01", "--", "x").returncode != 0
    assert run(root, "s02e01", "--message", "m").returncode != 0
```

`scripts/tests/test_canon_ledger.py`:

```python
import json, subprocess, sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "canon-ledger.py"

def make_show(tmp_path: Path) -> Path:
    root = tmp_path / "show"
    (root / "Episodes" / "s02e01").mkdir(parents=True)
    (root / "showrunner.json").write_text(json.dumps({
        "showName": "Harbor Light", "showSlug": "HarborLight", "promptsDir": "prompts",
        "models": {"medium": "m", "large": "l", "writer": "w"}, "airMap": {}, "output": {"nasRoot": "/nas"}}))
    return root

ROWS = [{"where": "outline.md beat 7", "deviation": "the crew is four, not six", "canon": "Canon/characters/Vale/vale.md:18", "provenance": "premise", "evidence": "Episodes/s02e01/premise.md"}]

def run(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=root, capture_output=True, text=True)

def test_creates_the_ledger_with_the_header_and_pending_rows(tmp_path):
    root = make_show(tmp_path)
    r = run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps(ROWS))
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "LEDGER_OK 1 new rows, 1 total"
    text = (root / "Episodes" / "s02e01" / "canon-ledger.md").read_text()
    assert text.startswith("# Canon ledger — s02e01\n")
    assert "| # | Where | The deviation | Canon it departs from | Provenance | Evidence | Disposition |" in text
    assert "| 1 | outline.md beat 7 | the crew is four, not six | Canon/characters/Vale/vale.md:18 | premise | Episodes/s02e01/premise.md (outline pass, run r1) | PENDING |" in text

def test_is_idempotent_and_numbers_new_rows_after_existing_ones(tmp_path):
    root = make_show(tmp_path)
    run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps(ROWS))
    again = run(root, "s02e01", "--pass", "script", "--run", "r1", "--rows", json.dumps(ROWS + [{**ROWS[0], "where": "script.md SCENE TWO"}]))
    assert again.stdout.strip().splitlines()[-1] == "LEDGER_OK 1 new rows, 2 total"
    text = (root / "Episodes" / "s02e01" / "canon-ledger.md").read_text()
    assert text.count("| PENDING |") == 2
    assert "| 2 | script.md SCENE TWO |" in text

def test_zero_rows_writes_nothing(tmp_path):
    root = make_show(tmp_path)
    r = run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", "[]")
    assert r.returncode == 0
    assert r.stdout.strip().splitlines()[-1] == "LEDGER_OK 0 new rows, 0 total"
    assert not (root / "Episodes" / "s02e01" / "canon-ledger.md").exists()

def test_refuses_malformed_rows(tmp_path):
    root = make_show(tmp_path)
    assert run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", "not json").returncode != 0
    assert run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps([{"where": "x"}])).returncode != 0
```

In `scripts/tests/test_populator_check.py`, add a test that a dirty `prompts.json` run with `--report-only` exits 0 and whose last stdout line matches `^POPULATORS_BAD 1 briefs: s05-crowd$`, and that without the flag it still exits 2. In `scripts/tests/test_nano_banana_generate.py`, add a test for the shot-selection function (whatever the existing tests call to obtain the character shots) showing a `source: "showrunner"` shot is excluded, and one for the exit code helper if the tag→rc decision is factored into a function (factor it: `def exit_code_for(tag: str) -> int` returning 0 for `NANO_OK` and `NANO_PARTIAL`). In `scripts/tests/test_image_sheet.py`, add a test that a `source: "showrunner"` shot's line contains `made by hand by the showrunner`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/scripts && uv run pytest tests/test_git_commit.py tests/test_canon_ledger.py tests/test_populator_check.py tests/test_nano_banana_generate.py tests/test_image_sheet.py -q`
Expected: FAIL — the two scripts do not exist; the flag and the field are not handled.

- [ ] **Step 3: `git-commit.py`**

```python
# /// script
# dependencies = []
# ///
"""git-commit: stage the listed paths and commit them with the given message, if anything is staged.
The pipeline's four commit steps used to be shell nodes — `git add` then `git commit` with a
message assembled in bash. This is that pair as one argv program the engine can spawn: each
listed path that exists is staged (additions, modifications and deletions under it), and a commit
is made only when the index differs from HEAD, so a step that re-runs after a crash commits
nothing twice. The message arrives verbatim; the engine already substituted the episode id.
Prints COMMIT_OK <short sha> or COMMIT_SKIPPED nothing staged; exit 0 either way. A git failure
exits non-zero with git's own stderr.
Usage: git-commit.py <episode> --message <text> [--show-root <path>] -- <path>..."""
import os, subprocess, sys
from lib import showconfig as sc


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True)


def parse(argv: list[str]) -> tuple[str, str, list[str]]:
    if len(argv) < 2:
        sys.exit("git-commit: episode id missing (usage: git-commit.py <episode> --message <text> -- <path>...)")
    ep = argv[1]
    message = None
    if "--message" in argv:
        i = argv.index("--message")
        if i + 1 < len(argv):
            message = argv[i + 1]
    if not message:
        sys.exit("git-commit: --message <text> is required")
    if "--" not in argv:
        sys.exit("git-commit: list the paths to stage after --")
    paths = argv[argv.index("--") + 1:]
    if not paths:
        sys.exit("git-commit: list at least one path after --")
    return ep, message, paths


def main() -> None:
    root = os.path.abspath(sc.show_root(sys.argv))
    sc.load(root)
    os.chdir(root)
    _ep, message, paths = parse(sys.argv)
    for p in paths:
        if os.path.exists(p):
            r = git("add", "-A", "--", p)
            if r.returncode != 0:
                sys.exit(f"git-commit: git add {p}: {r.stderr.strip()}")
    if git("diff", "--cached", "--quiet").returncode == 0:
        print("COMMIT_SKIPPED nothing staged")
        return
    r = git("commit", "-q", "-m", message)
    if r.returncode != 0:
        sys.exit(f"git-commit: git commit: {r.stderr.strip()}")
    sha = git("rev-parse", "--short", "HEAD").stdout.strip()
    print(f"COMMIT_OK {sha}")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"git-commit: {err}")
```

- [ ] **Step 4: `canon-ledger.py`**

```python
# /// script
# dependencies = []
# ///
"""canon-ledger: write the canon reviewer's deliberate deviations to the episode's ledger.
Spec §2.2: an agent adheres to canon; the showrunner overrides it; the ledger records the
overrides. The reviewer reads only, so it returns the rows in its verdict and this step writes
them — to Episodes/<episode>/canon-ledger.md, creating the file with its header when there is a
first row to write. A row whose Where and The-deviation cells already appear is not written again,
so a review that re-runs after a gate rejection does not duplicate the ledger. Disposition is
PENDING; the canon librarian marks rows ACCEPTED at the end-of-episode canon moment, and a
canon-gate rejection may mark one WITHDRAWN.
Prints LEDGER_OK <new> new rows, <total> total.
Usage: canon-ledger.py <episode> --pass <outline|script> --run <runId> --rows <json-array> [--show-root <path>]"""
import json, os, re, sys
from lib import showconfig as sc

FIELDS = ("where", "deviation", "canon", "provenance", "evidence")
HEADER = """# Canon ledger — {ep}

> Deliberate deviations from the canon store, recorded by the canon reviewer because their
> provenance is the showrunner's, not an agent's. Consumed at the end-of-episode canon moment:
> each ACCEPTED row becomes an AS SHIPPED canon change; each WITHDRAWN row is dropped.

| # | Where | The deviation | Canon it departs from | Provenance | Evidence | Disposition |
|---|---|---|---|---|---|---|
"""


def option(argv: list[str], name: str) -> str:
    if name not in argv or argv.index(name) + 1 >= len(argv):
        sys.exit(f"canon-ledger: {name} <value> is required")
    return argv[argv.index(name) + 1]


def cell(text: str) -> str:
    return " ".join(str(text).split()).replace("|", "\\|")


def existing_rows(text: str) -> list[tuple[str, str]]:
    rows = []
    for line in text.splitlines():
        m = re.match(r"^\| (\d+) \| (.*?) \| (.*?) \| ", line)
        if m:
            rows.append((m.group(2), m.group(3)))
    return rows


def main() -> None:
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else ""
    if not ep:
        sys.exit("canon-ledger: episode id missing (usage: canon-ledger.py <episode> --pass <outline|script> --run <runId> --rows <json>)")
    which = option(sys.argv, "--pass")
    if which not in ("outline", "script"):
        sys.exit("canon-ledger: --pass must be outline or script")
    run_id = option(sys.argv, "--run")
    try:
        rows = json.loads(option(sys.argv, "--rows"))
    except json.JSONDecodeError as err:
        sys.exit(f"canon-ledger: --rows is not JSON: {err}")
    if not isinstance(rows, list) or any(not isinstance(r, dict) or any(f not in r for f in FIELDS) for r in rows):
        sys.exit(f"canon-ledger: every row must be an object with {', '.join(FIELDS)}")

    episodes_dir = str(sc.value(cfg, "episodesDir", default="Episodes"))
    path = os.path.join(episodes_dir, ep, "canon-ledger.md")
    text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    seen = existing_rows(text)
    new = [r for r in rows if (cell(r["where"]), cell(r["deviation"])) not in seen]
    if new:
        if not text:
            text = HEADER.format(ep=ep)
        n = len(seen)
        for r in new:
            n += 1
            evidence = f"{cell(r['evidence'])} ({which} pass, run {run_id})"
            text = text.rstrip("\n") + f"\n| {n} | {cell(r['where'])} | {cell(r['deviation'])} | {cell(r['canon'])} | {cell(r['provenance'])} | {evidence} | PENDING |"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w", encoding="utf-8").write(text + "\n")
    print(f"LEDGER_OK {len(new)} new rows, {len(seen) + len(new)} total")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"canon-ledger: {err}")
```

- [ ] **Step 5: The three edits**

`populator-check.py`, in `main()`: read `report_only = "--report-only" in sys.argv` (and remove the flag from `sys.argv` before the episode id is read); in the `if found:` branch, after the stderr lines, replace `sys.exit(DIRTY)` with:

```python
        if report_only:
            print(f"POPULATORS_BAD {len(found)} briefs: {', '.join(sid for sid, _ in found)}")
            return
        sys.exit(DIRTY)
```

Update the module docstring's exit-code sentence to mention the flag.

`nano-banana-generate.py:420`: `shots = [s for s in doc["shots"] if s.get("type") == "character" and s.get("source", "pipeline") != "showrunner"]`, and where the script records per-shot results, no change is needed for skipped shots (they are not in `shots`); add one `print` before the loop naming how many showrunner-made shots were left alone. Lines 536–541: factor the tag→exit decision into `def exit_code_for(tag: str) -> int: return 0 if tag in ("NANO_OK", "NANO_PARTIAL") else 1` and use it. Update the docstring: "A shot whose `source` is `showrunner` is never generated; the showrunner drops it in."

`image-generate.py`, inside the loop before `if shot.get("type") == "character":`:

```python
        if shot.get("source", "pipeline") == "showrunner":
            done += 1
            print(f"skip {shot['id']} (showrunner-made)" + ("" if os.path.exists(out) else "  [MISSING — drop the file here]"))
            continue
```

`image-sheet.py`: wherever a shot's line is composed (both the Nano-Banana list and the local list), append `" — made by hand by the showrunner"` when `s.get("source") == "showrunner"`.

- [ ] **Step 6: README and the suite**

In `README.md`'s Scripts section, add `git-commit.py` and `canon-ledger.py` to the list of programs with one line each, and one sentence on the `source` field: "A shot whose `source` is `showrunner` is the showrunner's to make; `image-generate.py` and `nano-banana-generate.py` leave it alone and `image-sheet.py` says so."

Run: `cd ~/GitHub/Showrunner/scripts && uv run pytest -q`
Expected: PASS (309 or more). Then the show-name grep from the Global Constraints: empty.

- [ ] **Step 7: Commit**

```bash
cd ~/GitHub/Showrunner && git add scripts README.md
git commit -F - <<'EOF'
scripts: git-commit and canon-ledger; populator-check --report-only; the source field on shots

git-commit.py is the pipeline's four commit nodes as one argv program;
canon-ledger.py writes the canon reviewer's deviations to the episode's
ledger without giving the reviewer a Write tool. populator-check gains a
report-only mode so the pipeline can route a dirty brief to a fix agent
before failing. The image scripts honour source: "showrunner" — a shot
the showrunner makes by hand is never generated and the sheet says so —
and nano-banana-generate exits 0 on a partial run, which the gate shows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---
## Task 8: The show data — the canon reviewer's prompts, the smoothed rejection prompts, the cast section, the source field, and four fixes

**Files (show repository, branch `plan-d-show-data`):**
- Create: `prompts/canon-review.schema.json`, `prompts/canon-review-outline.md`, `prompts/canon-review-script.md`, `prompts/image-audit.schema.json`, `prompts/publish-copy.md`, `prompts/visual-direction-fix.md`
- Delete: `prompts/outline-canon-check.md`, `prompts/outline-canon-check.schema.json`, `prompts/continuity-check.md`, `prompts/continuity-check.schema.json`
- Modify: `prompts/image-audit.md` (rewritten), `prompts/outline.md`, `prompts/draft.md`, `prompts/visual-direction.md`, `prompts/tts-script.md`, `prompts/propose.md`, `prompts/outline-revise.md`, `prompts/revise.md`, `prompts/outline-gate.gate.md`, `prompts/script-gate.gate.md`, `prompts/image-gate.gate.md`, `prompts/final-gate.gate.md`, `prompts/canon-gate.gate.md`, `prompts/audio-gate.reject.md`, `prompts/final-gate.reject.md`, `prompts/image-gate.reject.md`, `prompts/nano-banana-gate.reject.md`, `prompts/README.md`, `showrunner.json`, `Canon/README.md`, `Canon/season-2.md`
- **Engine repository, branch `plan-d`:** Modify `tools/show-data/deadlight-check-context.json` (sample results for every `{{results.*}}` name the edited prompts use).

**Interfaces:**
- Consumes: the step ids and result keys of Task 5 (`canon-review-outline`, `canon-review-script`, `hand-edits-outline`, `hand-edits-script`, `outline-gate:rejections`, `script-gate:rejections`, `canon-diff`, `image-audit-verdict`, `publish-copy`, `populator-check`, `master`); the ledger format of Task 7.
- Produces: the prompt files the pipeline names; the `## Cast` grammar; the `source` field.

**Setup:** `cd ~/GitHub/DeadLight && git checkout plan-c-show-data && git checkout -b plan-d-show-data`. The two untracked `Production/ep10/*` files in the working tree are not yours; leave them.

- [ ] **Step 1: The canon reviewer — one schema, two passes**

`prompts/canon-review.schema.json`:

```json
{
  "type": "object",
  "properties": {
    "pass": { "type": "boolean" },
    "verdict": { "type": "string", "enum": ["CANON PASSED", "CANON FAILED"] },
    "issues": { "type": "array", "items": { "type": "string" } },
    "deviations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "where": { "type": "string" },
          "deviation": { "type": "string" },
          "canon": { "type": "string" },
          "provenance": { "type": "string", "enum": ["premise", "locked-beats", "rejection-note", "hand-edit"] },
          "evidence": { "type": "string" }
        },
        "required": ["where", "deviation", "canon", "provenance", "evidence"]
      }
    }
  },
  "required": ["pass", "verdict", "issues", "deviations"]
}
```

`prompts/canon-review-outline.md`:

```
You are the canon reviewer for *Dead Light*, reviewing the OUTLINE. Judge ONLY
factual canon adherence — not prose, not taste (the showrunner gates taste next).
You read; you never edit.

Read Episodes/{{episodeId}}/outline.md, then audit against:
- Canon/world-overview.md (load-bearing rules), Canon/technology.md,
  Canon/characters/The Mute/the-mute.md, Canon/timeline.md, Canon/continuity-ledger.md
- Canon/season-{{season}}.md if this episode has a RULED slate entry — the
  outline must honor its ruled beats, register, and continuity threads
- Episodes/{{episodeId}}/locked-beats.md if it exists — BINDING: beats
  may be enriched, never reordered, removed, or merged
- Character/species/location/faction sheets for entities the outline uses

Also flag: undeclared new/retroactive canon (anything missing from the
outline's "## New canon proposed"), undeclared arc beats, death-rule
violations (register, budget, earned grief), and a missing or incomplete
"## Cast" section — every named character and every recurring location that
appears must be listed there as `- <Name> (<tags>)` with tags from
`recurring`, `guest`, `speaks`, `location`.

## Provenance — who introduced each discrepancy

The rule (showrunner-ruled 2026-09-25): agents adhere to canon; the showrunner
overrides it; the ledger records the overrides. For EVERY discrepancy you find,
decide who introduced it, using only these four sources:
1. The premise — Episodes/{{episodeId}}/premise.md. The showrunner's words.
2. Locked beats — Episodes/{{episodeId}}/locked-beats.md, if it exists. His words.
3. Gate rejection notes — every note he has written at the outline gate so far,
   in order (a JSON list; empty before any rejection):
   {{results.outline-gate:rejections}}
4. Hand edits — files whose content changed since an agent last wrote them,
   found by the engine from recorded hashes (a JSON object; `handEdited` is
   empty when nothing was touched by hand):
   {{results.hand-edits-outline}}

A discrepancy that implements one of those four is the SHOWRUNNER's: put it in
`deviations` (where, what deviates, the canon it departs from, which source,
and the evidence — the premise line, the beat, the note's words, or the file
named as hand-edited). It is NOT an issue and is NOT to be fixed.
Everything else is an AGENT slip: put it in `issues`.
Tie-breaker when provenance is unclear: adhere — treat it as an agent slip. The
showrunner sees the fix at the gate and can re-assert it in a rejection note, at
which point it is provably his and is logged rather than fixed next pass.

Each issue: "<beat> — <what conflicts> — <file that says otherwise>".
`pass` is true only when `issues` is empty (deviations never fail the review).
Set `verdict` to "CANON PASSED" when pass is true, "CANON FAILED" when false.
```

`prompts/canon-review-script.md`:

```
You are the canon reviewer for *Dead Light*, reviewing the SCRIPT. You judge
factual consistency with canon — never prose quality. You read; you never edit.

Read Episodes/{{episodeId}}/script.md and Episodes/{{episodeId}}/outline.md.
THE APPROVED OUTLINE IS APPROVED CANON FOR THIS EPISODE: a beat the outline
declares (including its "## New canon proposed" and "## Arc beats" sections)
is not a discrepancy when the script executes it. Then audit against ALL of:
- Canon/world-overview.md (especially "The rules of the universe" —
  each is load-bearing)
- Canon/technology.md, Canon/characters/The Mute/the-mute.md, Canon/timeline.md
- Canon/continuity-ledger.md (open threads — contradictions AND silent
  drops both count)
- Every character/species/location/faction file for entities appearing
  in the script (Glob Canon/**/*.md and read what's relevant)

Flag: contradictions of canon facts, characters acting against their
sheets, tech violating the tier ladder, Mute behavior violating
"characters/The Mute/the-mute.md", timeline impossibilities, NEW canon-worthy
facts the script invents that conflict with existing entries, and a script that
departs from the approved outline's beats.

## Provenance — who introduced each discrepancy

The rule (showrunner-ruled 2026-09-25): agents adhere to canon; the showrunner
overrides it; the ledger records the overrides. For EVERY discrepancy you find,
decide who introduced it, using only these four sources:
1. The premise — Episodes/{{episodeId}}/premise.md. The showrunner's words.
2. Locked beats — Episodes/{{episodeId}}/locked-beats.md, if it exists. His words.
3. Gate rejection notes — every note he has written so far, in order (JSON
   lists; empty before any rejection):
   outline gate: {{results.outline-gate:rejections}}
   script gate: {{results.script-gate:rejections}}
4. Hand edits — files whose content changed since an agent last wrote them,
   found by the engine from recorded hashes (a JSON object; `handEdited` is
   empty when nothing was touched by hand):
   {{results.hand-edits-script}}

A discrepancy that implements one of those four is the SHOWRUNNER's: put it in
`deviations` (where, what deviates, the canon it departs from, which source,
and the evidence — the premise line, the beat, the note's words, or the file
named as hand-edited). It is NOT an issue and is NOT to be fixed.
Everything else is an AGENT slip: put it in `issues`.
Tie-breaker when provenance is unclear: adhere — treat it as an agent slip. The
showrunner sees the fix at the gate and can re-assert it in a rejection note, at
which point it is provably his and is logged rather than fixed next pass.

Each issue must be one string: "<script location> — <what conflicts> —
<canon file that says otherwise>". `pass` is true only when `issues` is empty
(deviations never fail the review). Set `verdict` to "CANON PASSED" when pass is
true, "CANON FAILED" when false.
```

Delete the four old files with `git rm`.

- [ ] **Step 2: The prompts that consume the reviewer**

`prompts/outline-gate.gate.md`, line 2: `Canon pre-check: {{results.outline-canon-check.verdict}}` → `Canon review: {{results.canon-review-outline.verdict}}`, then add after it:

```
Deviations logged as yours (not fixed — they go to the canon ledger):
{{results.canon-review-outline.deviations}}
```

`prompts/script-gate.gate.md`, line 3: `Continuity: {{results.continuity-check}}` → `Canon: {{results.canon-review-script}}`.

`prompts/outline-revise.md`, line 5: `{{results.outline-canon-check}}` → `{{results.canon-review-outline}}`; and after the paragraph beginning "Work through EVERY issue", add a paragraph:

```
The `deviations` list is the showrunner's own and is not yours to fix — work
only the `issues` list. A deviation is logged to the canon ledger, not revised.
```

`prompts/revise.md`, line 6: `Continuity: {{results.continuity-check}}` → `Canon: {{results.canon-review-script}}`; and add the same paragraph after the reviewer-findings block (before the numbered steps).

- [ ] **Step 3: The outline's cast section, the draft's completion, the shot list's source**

`prompts/outline.md`, in `## Rules`, add a bullet immediately after the "Arc beats must be declared" bullet:

```
- **Declare the cast (machine-read).** Include a "## Cast" section listing
  every named character who appears and every recurring location, one per
  line, exactly in this grammar — `- <Name> (<tags>)` — with tags from:
  `recurring` (has or needs a Canon reference sheet and, if speaking, a
  locked voice), `guest` (one-off, this episode only), `speaks` (has
  dialogue), `location` (a place with a reference sheet). Use each name as
  its Canon sheet spells it ("the Mute", "Ilvaren", "Coalvane"). Examples:
  `- Sable (recurring, speaks)`, `- Ilvaren (recurring, speaks)`,
  `- Dockmaster Hale (guest, speaks)`, `- Coalvane (location)`. The
  pipeline reads this section to stop at NEEDS_REFS when a recurring
  subject has no sheet or locked voice, so a name left out here is a
  shot that silently fails later.
```

`prompts/draft.md`, the `## Completion` section: replace from `If every beat has a scene AND the` through the end of the section (the sentence about the sentinel proving completion and whatever follows it up to the next blank line or heading) with:

```
If every beat has a scene AND the ending duties are paid, output exactly:
DRAFT_COMPLETE
That word is what ends the loop. Do not write it in any other iteration, do
not write a sentinel file, and do not paraphrase it — the engine matches the
exact string, and a loop that never says it fails after fifteen iterations.
```

Read the section in full first; the replacement must leave the paragraph about verifying the FIVE ending duties intact.

`prompts/visual-direction.md`: in the JSON shape, add `"source": "pipeline"` after `"type"` on the ambient example line and on the character example line; then add a bullet at the end of the `Rules:` list:

```
- **`source`** is `"pipeline"` (the default; omit it or write it) or
  `"showrunner"` — a shot the showrunner has said he will make by hand. Tag
  a shot `"showrunner"` only when the premise or the outline says so; the
  showrunner can also claim one at the character-shot gate. The generators
  never touch a `"showrunner"` shot, and the pipeline waits at NEEDS_IMAGES
  until its PNG is dropped in.
```

- [ ] **Step 4: The rejection prompts, rewritten**

`prompts/audio-gate.reject.md`, whole file:

```
You are the audio-fix operator for *Dead Light* {{episodeId}}. The
showrunner rejected the audio:
{{results.audio-gate:rejection}}
Fix the cause in Production/{{episodeId}}/tts-script.json — a register
override, a text respelling, a gap — and delete ONLY the affected
Production/{{episodeId}}/audio/segments/<i>.wav files (Bash `rm`), so the
re-synthesis regenerates exactly those. After your edits, the pipeline
re-runs synthesis, the three QC passes and the mix as its own steps before
this gate reopens; do not run any script yourself. Summarize what you
changed and which segments you deleted.
```

`prompts/final-gate.reject.md`, whole file:

```
You are the assembly operator for *Dead Light* {{episodeId}}. The
showrunner rejected the assembled video:
{{results.final-gate:rejection}}
If it is a TIMELINE or TIMING glitch (a shot on the wrong scene, a
still that lands late), fix the cause in
Production/{{episodeId}}/images/prompts.json — a shot's `scene` or its
order — and never edit timeline.json, which is rebuilt from it. If the
note is about the logline or the upload copy, fix
Episodes/{{episodeId}}/publish.json. After your edits, the pipeline
re-runs the timeline build, the render and the master as its own steps
before this gate reopens; do not run any script yourself. A pure render
glitch with nothing to edit: say so — the showrunner deletes
Production/{{episodeId}}/video/episode.mp4 and rejects again to force a
re-render.
If it is an AUDIO or IMAGE CONTENT problem (not timing), STOP and report
that it must be fixed by rejecting the audio or image gate — do NOT
patch assets here. Summarize what you did.
```

`prompts/image-gate.reject.md`, whole file:

```
You are the image-fix operator for *Dead Light* {{episodeId}}. The
showrunner rejected images:
{{results.image-gate:rejection}}
For AMBIENT shots: edit the shot in Production/{{episodeId}}/images/prompts.json
(wording, seed) FIRST, then delete its PNG (Bash `rm`). The pipeline runs
ambient generation as its own step after your edits; do not run it
yourself.
For CHARACTER shots: fold the showrunner's words into the shot's `brief`
in prompts.json, then delete its PNG; the pipeline regenerates it. If the
note says he will make the shot himself, set the shot's `source` to
"showrunner" instead and leave its PNG alone.
Summarize what changed.
```

`prompts/nano-banana-gate.reject.md`, whole file:

```
You are the visual director for *Dead Light*. The showrunner rejected
character shots for {{episodeId}} with these notes:
{{results.nano-banana-gate:rejection}}

Work out which shot ids they named (ids look like s03-opha-still-corner;
the full list is in Production/{{episodeId}}/images/prompts.json). For
each named shot: fold the showrunner's words into that shot's `brief` as
corrective direction, then delete its PNG from
Production/{{episodeId}}/images/ (Bash `rm`). The pipeline regenerates
every character shot whose PNG is missing, as its own step, before this
gate reopens; do not run any script yourself.

If the note says the showrunner will make a shot himself ("I'll make this
one"), set that shot's `source` to "showrunner" in prompts.json and leave
its PNG alone; the pipeline waits at NEEDS_IMAGES until he drops it in.

Do NOT touch any shot they did not name — every other image on disk,
including anything made by hand, must be left untouched.

IMPORTANT: if their note describes a CANON problem rather than a
one-off miss — a character's scale, placement, anatomy, or how they
are presented — also correct that subject's `identity` text in
Canon/refs.json so every future episode inherits the fix, and say so
in your summary. Fixing the shot alone lets the same error return.

Report each shot you re-briefed, each you marked showrunner-made, and
anything you changed in canon.
```

- [ ] **Step 5: The image audit as a round, and its schema**

`prompts/image-audit.schema.json`:

```json
{
  "type": "object",
  "properties": {
    "pass": { "type": "boolean" },
    "verdict": { "type": "string", "enum": ["IMAGES_CLEAN", "IMAGES_FAILING"] },
    "fixed": { "type": "array", "items": { "type": "string" } },
    "flagged": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": "string" }
  },
  "required": ["pass", "verdict", "fixed", "flagged", "summary"]
}
```

`prompts/image-audit.md`, whole file (the laws in 3, 3a, 3b and the fix rules in 4 are carried over verbatim from the current file; only the frame around them changes):

```
You are the image auditor for *Dead Light*. LOOK at every still with
the Read tool (it renders images) and verify it belongs in the show.
This is one audit round of up to three; the pipeline regenerates every
ambient PNG you delete and runs the next round on the result.

1. Read Canon/visual-style.md and Production/{{episodeId}}/images/prompts.json.
2. Read EVERY PNG in Production/{{episodeId}}/images/ — actually look.
3. Verdict each against: EXPOSURE (legible, real midtones, NOT
   black-on-black), SPECIES (mundane working crewman, never a
   xenomorph), INTERIOR (enclosed; no starfield through a sealed
   interior), NAUTICAL (spacecraft, never an ocean vessel), NEGATION
   BACKFIRE (no unwanted people/faces/planets a prompt tried to
   forbid), and generation defects (mangled hands, duplicated
   structures, garbled text, the cream matte border).
3a. THE HARD LINE (LAW): any AMBIENT (local) shot that rendered a
   NAMED character or ANY alien/non-human creature is a DEFECT — the
   local builder must never draw our cast or aliens. FIX: rewrite the
   ambient prompt to pure environment (remove the person/creature, or
   reduce to a distant faceless non-named HUMAN extra), bump seed,
   delete the PNG. If the shot genuinely NEEDS that character/alien, note
   it for the image gate as "should be a Nano-Banana character shot"
   (do not try to fix it locally).
3b. WATERMARK (character shots especially — they come from Nano
   Banana/Gemini): scan ALL FOUR CORNERS and edges for a VISIBLE
   watermark — a "Gemini" sparkle/star icon, a "✦" mark, an "AI"
   badge, or any logo/text stamp. The paid tier's watermark is
   INVISIBLE (fine, expected — we disclose AI to YouTube); only a
   VISIBLE corner mark/logo is a defect. A visible watermark on a
   character shot is a MUST-FIX flag for the image gate (the
   showrunner re-exports it clean or crops the mark).
4. FIX RULES:
   - type=="ambient" FAIL: FIRST rewrite its prompt POSITIVELY in
     prompts.json and bump its seed +1000 (save the file), THEN delete
     that PNG (Bash `rm`). The order matters: a round that is
     interrupted after the edit and before the delete leaves a seed
     already bumped, and the next round must not bump it again — check
     whether the seed on disk already ends in a +1000 step you noted.
   - The cream matte-border artifact: crop it (~top/bottom bands) and
     rescale — do NOT re-roll (visual-style law).
   - type=="character" FAIL: DO NOT regenerate — note the problem in
     `flagged` for the image gate; leave the PNG.
   - A shot whose `source` is "showrunner": never edit, never delete.
5. Do not run any generator yourself; the pipeline regenerates the
   ambient PNGs you deleted as its own step after this round.

Verdict: `pass` is true when every AMBIENT image on disk passes and you
deleted none this round (character problems go in `flagged`, never
fail the round). `fixed` lists the ambient ids you rewrote and deleted;
`flagged` lists character ids with the problem in a few words;
`summary` is one line per image: "id: pass / fixed-how / character-note".
Set `verdict` to "IMAGES_CLEAN" when pass is true, "IMAGES_FAILING" when false.
```

`prompts/image-gate.gate.md`, line 2: `Auditor summary: {{results.image-audit}}` → `Auditor summary (last round): {{results.image-audit-verdict}}`.

- [ ] **Step 6: Two new agent prompts**

`prompts/publish-copy.md`:

```
You are the publicist for *Dead Light*. The script at
Episodes/{{episodeId}}/script.md is approved. Read it, then read
Canon/publishing-guide.md for the house rules on loglines and teasers.

Write Episodes/{{episodeId}}/publish.json with the Write tool:
{
  "logline": "<two paragraphs at most, in the register of the guide: what
              the crew faces, told from the vantage the episode uses;
              never a spoiler past the midpoint; no character names the
              audience has not met by this episode>"
}
Keep any other key the file already has (read it first if it exists).
End your response with the logline alone, on its own lines, and nothing
after it — the final gate shows the showrunner what you wrote.
```

`prompts/visual-direction-fix.md`:

```
You are the visual director for *Dead Light*, fixing the shot list at
Production/{{episodeId}}/images/prompts.json. The collective-populator
check found character briefs that describe a crowd without naming its
members:
{{results.populator-check}}
The law (Canon/visual-style.md, "No collective populators"): every
person in a character-shot frame is NAMED and present in Canon/refs.json,
or the headcount is capped to the named people. For each brief the check
names, rewrite it so it names every populator or removes the crowd;
change nothing else in the file. The pipeline re-runs the check as its
own step after your edits and stops the line if a brief is still dirty.
Summarize each brief you changed, in one line.
```

- [ ] **Step 7: The propose and canon-gate prompts learn the ledger**

`prompts/propose.md`, add a section after `## Then edit Canon files IN PLACE`'s last bullet and before `## Rules`:

```
## The canon ledger — the showrunner's deliberate deviations
Read Episodes/{{episodeId}}/canon-ledger.md if it exists. Each row whose
Disposition is PENDING is a place where the shipped episode departs from
the canon store ON PURPOSE — the showrunner's premise, locked beats,
rejection notes or hand edits put it there, and the canon reviewer logged
it rather than fixing it. For every PENDING row: make the AS SHIPPED
canon change the row describes (the pattern used on ep10 — mark the old
fact superseded "as of {{episodeId}}" and write the new one), then change
that row's Disposition to ACCEPTED in the ledger. Do not delete rows. The
canon gate shows the showrunner the ledger beside the diff; a row he
withdraws there is reverted by the fix agent and marked WITHDRAWN.
```

And in `## Rules`, change the last bullet ("If the script contradicts existing canon…") to:

```
- If the script contradicts existing canon and the ledger has NO row for
  it (this should have been caught pre-approval), do NOT silently rewrite
  canon: note the conflict at the top of your response and make no edit
  for that fact.
```

`prompts/canon-gate.gate.md`: line 6 `{{results.diff}} — the full diff…` → `{{results.canon-diff}} — the full diff is in Production/{{episodeId}}/canon-diff.patch; read that file, not this summary.`, and add before the final "Approve to commit" line:

```
Deviation ledger (if it exists): Episodes/{{episodeId}}/canon-ledger.md —
each ACCEPTED row is now an AS SHIPPED edit in the diff. To drop one,
reject with "withdraw row N".
```

`prompts/canon-gate.reject.md`: add after the paragraph ending "Keep diffs minimal.":

```
If the feedback says "withdraw row N": revert the AS SHIPPED edit that row
produced and set that row's Disposition to WITHDRAWN in
Episodes/{{episodeId}}/canon-ledger.md.
```

- [ ] **Step 8: `tts-script.md`'s casting rule, and the gate messages that gained a variable**

`prompts/tts-script.md`, casting rules items 3 and 4 (lines 134–138) become:

```
  3. The voice itself was designed by the showrunner before this step ran
     (the pipeline stops at NEEDS_REFS until it exists) and lives at
     Production/{{episodeId}}/guest-refs/<guest-slug>*.wav — the slug is
     the guest's name lowercased with hyphens ("Dockmaster Hale" →
     dockmaster-hale). Do not run design-voice.py.
  4. Cast entry: ref = that WAV, ref_text = the exact line it renders (the
     showrunner recorded it beside the WAV as <guest-slug>.txt if he wrote
     one; else transcribe the line from the script), direction = your
     description, guest = true. Name each guest and its WAV in your
     casting-gate summary.
```

`prompts/final-gate.gate.md`, add after the `Production/{{episodeId}}/video/episode.mp4  ({{results.master}})` line:

```
Logline for the upload (Episodes/{{episodeId}}/publish.json):
{{results.publish-copy}}
To force a re-render with nothing else changed, delete
Production/{{episodeId}}/video/episode.mp4 and reject.
```

- [ ] **Step 9: `prompts/README.md`, the check context, and the checker**

In `prompts/README.md`: replace the sentence "`index.json` is the directory's manifest … and Plan D builds the pipeline's steps from it." with "`index.json` is the record of Plan C's extraction from the Archon workflows (2026-09-28) and is frozen: from Plan D (2026-09-29) the engine's pipeline definition, `engine/src/pipelines/episode.ts` in `~/GitHub/Showrunner`, is the manifest of which prompt file each step reads, and this directory is hand-maintained." Replace the two sentences beginning "`index.json` and the prompt files are regenerated by the engine's `extract-prompts` tool…" and "Plan F deletes `.archon/`…" with "The extractor was run once, by Plan C, and is not run against this directory again; `.archon/workflows/` is deleted by Plan F." Add one paragraph naming the files Plan D added and removed (the two canon-review prompts and their schema replacing the two checks; `image-audit.schema.json`; `publish-copy.md`; `visual-direction-fix.md`) and the two conventions the prompts now carry: the outline's `## Cast` grammar and the shot list's `source` field.

In `~/GitHub/Showrunner/tools/show-data/deadlight-check-context.json` (branch `plan-d`), add sample values under `results` for every variable the edited prompts render: `canon-review-outline` (an object with `verdict` and `deviations`), `canon-review-script`, `hand-edits-outline` (`{"handEdited": []}` as a string), `hand-edits-script`, `outline-gate:rejections` (`[]`), `script-gate:rejections` (`[]`), `canon-diff`, `image-audit-verdict`, `publish-copy`, `populator-check`, plus any the checker still names. Remove `outline-canon-check`, `continuity-check`, `diff`, `image-audit` if present. Then:

```bash
cd ~/GitHub/Showrunner && npm run build -w tools && node tools/dist/check-prompts.js --prompts ~/GitHub/DeadLight/prompts --context tools/show-data/deadlight-check-context.json
```

Expected: every prompt renders; the command names no hole.

- [ ] **Step 10: The four show fixes**

1. `showrunner.json`: `audio.mainCast` gains `"Mute"` and `"Ilvaren"` after `"Remo"`.
2. `Canon/README.md`: add a section after "## The two-lens rule":

```
## Episode ids in prose (added 2026-09-29, from the console rewrite spec §5.3)

**`epNN` in prose always means Season 1, episode NN; new writing uses `SxEy` in prose and a production id only inside a file path.** Season 1 was produced under production ids (`ep01`–`ep10`) that the cutover renames to aired slots (`s01e01`–`s01e10`); the roughly six hundred prose mentions of the old form are not swept, so this rule is how a reader tells where a detail was first introduced when a page mixes `ep03` and `s02e05`.
```

3. `Canon/season-2.md:18`: "Every row in this file is DRAFT as of 2026-09-21." → "Rows marked **RULED** were ruled at the 2026-09-17 season desk; every other row is DRAFT as of 2026-09-21."
4. `Canon/season-2.md:69`: the row cites `continuity-ledger.md:33`. Open `Canon/continuity-ledger.md`'s "Open threads (S2-facing)" section and find the thread about Remo's withdrawn sighting (the relic that woke under his grip, doubted by Sarn). If exactly one open-thread line matches, change the citation to that line number; if not, leave the row alone and say so in the report.

- [ ] **Step 11: Commit (both repositories)**

```bash
cd ~/GitHub/DeadLight && git add prompts showrunner.json Canon/README.md Canon/season-2.md
git commit -F - <<'EOF'
prompts: the canon reviewer, the smoothed rejection prompts, the cast section, the source field

One canon reviewer in two passes (outline, script) with a provenance rule
and a deviations list the pipeline writes to the episode's canon ledger,
replacing the two canon checks. The four rejection prompts Plan C left
with a stale lead-in now describe what the fix agent edits and what the
pipeline re-runs. Outlines declare their cast in a machine-read section
(the NEEDS_REFS source); shots carry a source field (the NEEDS_IMAGES
source); the image audit is one round with a verdict schema; two new
prompts write the publish copy and fix collective populators. Show fixes:
Mute and Ilvaren join mainCast; Canon/README.md gains the epNN prose
rule; season-2.md no longer contradicts its own RULED rows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
cd ~/GitHub/Showrunner && git add tools/show-data/deadlight-check-context.json
git commit -F - <<'EOF'
tools: sample results for the Plan D prompt variables

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---
## Task 9: The script-only exercise on `ep98` — the real scripts under the real executor

**Files:**
- Create: `engine/test/ep98-exercise.test.ts` (env-gated: runs only with `SHOWRUNNER_EP98=1`)
- Modify: `README.md` Develop section (how to run it, and what it touches)

**Interfaces:**
- Consumes: `episodePipeline`, `scriptExecutor`, `EventLog`, `run`, `answerGate`, `orderSteps`, the show repository at `~/GitHub/DeadLight` (any branch that carries `showrunner.json`), the engine's `scripts/` project, `render/` with its dependencies installed, `ffmpeg` on PATH.
- Produces: evidence, in the task report, that the engine spawns the real scripts correctly: `uv` finds the scripts project from the show root as cwd, `::progress` lines become `step_progress`, result lines become results, the mix and the mastered video are hashed as outputs, the render runs from `render/` with `REMOTION_EPISODE`, and the two gates open with rendered messages.

**What it runs, and why only this.** Ryan ruled that no agent step runs against the real show in Plan D, so the exercise seeds a run log in which every step before the one under test is already completed, and lets the pipeline run the real deterministic steps until the next gate opens. Two runs, two logs:

| Run | Seeded as completed | Runs for real | Stops at |
|---|---|---|---|
| `ex-audio` | every step before `audio-mix` | `audio-mix` (ep98 has 512 rendered segments and a manifest; the mix takes under a minute) | `audio-gate` (waiting) |
| `ex-assemble` | every step before `nas-mounted`, and `nas-mounted` itself | `build-timeline`, `render` (ep98 has 43 image entries and a mix; ep10's render took 877 s), `master` | `final-gate` (waiting) |

`ep98` is the show's non-canon test bed (`Episodes/ep98/STATUS.md` records it as a DEAD ARTIFACT); its audio, video and images directories are git-ignored, and nothing the exercise writes under `Production/ep98/` or `Episodes/ep98/` matters. The exercise still deletes the two run logs it wrote and restores `Episodes/ep98/STATUS.md` from git at the end, so `git status` in the show repository is unchanged by it.

`{{season}}` would fail for `ep98` (it is not in `airMap`) — irrelevant here because no agent step runs and the two gates' messages (`audio-gate.gate.md`, `final-gate.gate.md`) do not use it; `final-gate.gate.md` renders `{{results.publish-copy}}` and `{{results.master}}`, which the seed supplies.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { episodePipeline } from "../src/pipelines/episode.js";
import { orderSteps } from "../src/pipeline.js";
import { run } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import { deriveRunState } from "../src/state.js";
import { loadShowConfig } from "../src/show-config.js";
import { scriptExecutor } from "../src/script-step.js";
import { loadPrompt, renderPrompt } from "../src/prompt-template.js";
import type { Event } from "../src/events.js";
import type { Executors, RunContext } from "../src/steps.js";

const exec = promisify(execFile);
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const showRoot = process.env["SHOWRUNNER_SHOW_ROOT"] ?? path.join(os.homedir(), "GitHub", "DeadLight");
const EP = "ep98";

/** A log in which every step of `pipeline` before `upto` is completed, so run() starts at `upto`. */
async function seed(logPath: string, runId: string, pipeline: ReturnType<typeof episodePipeline>, upto: string, alsoDone: string[], results: Record<string, unknown>): Promise<void> {
  const events: Omit<Event, "ts">[] = [{ runId, kind: "run_started", payload: { pipeline: pipeline.name, episodeId: EP, trigger: "ep98-exercise" } }];
  for (const step of orderSteps(pipeline)) {
    if (step.id === upto) break;
    events.push({ runId, stepId: step.id, kind: "step_started", payload: { kind: step.kind, seeded: true } });
    events.push({ runId, stepId: step.id, kind: "step_completed", payload: { seeded: true, ...(step.id in results ? { result: results[step.id] } : {}) } });
  }
  for (const id of alsoDone) {
    events.push({ runId, stepId: id, kind: "step_started", payload: { kind: "guard", seeded: true } });
    events.push({ runId, stepId: id, kind: "step_completed", payload: { seeded: true, result: "seeded" } });
  }
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, events.map((e, i) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...e })).join("\n") + "\n");
}

describe.skipIf(process.env["SHOWRUNNER_EP98"] !== "1")("ep98 exercise (real scripts, no agents)", () => {
  const executors: Executors = { script: scriptExecutor, agent: async () => ({ ok: false, error: "no agent step may run in the ep98 exercise", toolCalls: 0 }) };

  async function exercise(runId: string, upto: string, alsoDone: string[], results: Record<string, unknown>, stopsAt: string, timeoutMs: number) {
    const show = await loadShowConfig(showRoot);
    const pipeline = episodePipeline({ show, episodeId: EP, engineRoot });
    const logPath = EventLog.logPath(showRoot, EP, runId);
    await rm(logPath, { force: true });
    await seed(logPath, runId, pipeline, upto, alsoDone, results);
    const renderGateMessage = async (file: string, ctx: RunContext) => renderPrompt((await loadPrompt(path.join(showRoot, show.promptsDir), file)).text, ctx, { show: show as unknown as Record<string, unknown> });
    const started = Date.now();
    const r = await run({ pipeline, ctx: { runId, episodeId: EP, showRoot, trigger: "ep98-exercise" }, log: new EventLog(logPath), executors, renderGateMessage });
    const events = await new EventLog(logPath).read();
    const state = deriveRunState(events);
    return { r, events, state, elapsedMs: Date.now() - started, logPath, timeoutMs };
  }

  it("audio-mix runs for real and audio-gate opens with a rendered message", { timeout: 15 * 60_000 }, async () => {
    const { r, events, state, logPath } = await exercise("ex-audio", "audio-mix", [], {}, "audio-gate", 15 * 60_000);
    try {
      expect(r).toMatchObject({ status: "waiting", gate: { stepId: "audio-gate", attempt: 1 } });
      const mixDone = events.find((e) => e.kind === "step_completed" && e.stepId === "audio-mix");
      expect(String(mixDone?.payload["result"])).toMatch(/^MIX_OK /);
      expect(Object.values(mixDone?.payload["outputHashes"] as Record<string, string | null>)[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(events.some((e) => e.kind === "script_line" && e.stepId === "audio-mix")).toBe(true);
      expect(state.openGate?.message).toMatch(/MIX_OK/);
      expect(state.openGate?.message).not.toMatch(/\{\{/);
    } finally {
      await rm(logPath, { force: true });
    }
  });

  it("build-timeline → render → master run for real and final-gate opens", { timeout: 60 * 60_000 }, async () => {
    const { r, events, state, logPath } = await exercise("ex-assemble", "nas-mounted", ["nas-mounted"], { "publish-copy": "(seeded logline)" }, "final-gate", 60 * 60_000);
    try {
      expect(r).toMatchObject({ status: "waiting", gate: { stepId: "final-gate", attempt: 1 } });
      for (const id of ["build-timeline", "render", "master"]) {
        expect(state.steps[id], id).toBe("completed");
      }
      expect(String(events.find((e) => e.kind === "step_completed" && e.stepId === "build-timeline")?.payload["result"])).toMatch(/^TIMELINE_OK /);
      expect(String(events.find((e) => e.kind === "step_completed" && e.stepId === "master")?.payload["result"])).toMatch(/^MASTER_OK /);
      const renderStarted = events.find((e) => e.kind === "step_started" && e.stepId === "render");
      expect((renderStarted?.payload["argv"] as string[])[1]).toBe("remotion");
      expect(await readFile(path.join(showRoot, "Production", EP, "video", "episode-mastered.mp4"))).toBeInstanceOf(Buffer);
      expect(state.openGate?.message).toMatch(/\(seeded logline\)/);
    } finally {
      await rm(logPath, { force: true });
      await exec("git", ["checkout", "--", "Episodes/ep98/STATUS.md"], { cwd: showRoot }).catch(() => undefined);
    }
  });
});
```

`RunOptions.renderGateMessage` is the seam Task 5 added; this test builds the renderer the console will build.

- [ ] **Step 2: Run it once, for real, and record what happened**

Preconditions the implementer checks and reports: `uv` on PATH; `cd ~/GitHub/Showrunner/render && npm install` done; `ffmpeg` on PATH; the show repository present at `~/GitHub/DeadLight` with `Production/ep98/audio/segments/` (512 WAVs) and `Production/ep98/images/*.png` on disk. **Do not mount or touch the NAS**; `nas-mounted` is seeded.

Run: `cd ~/GitHub/Showrunner/engine && SHOWRUNNER_EP98=1 npx vitest run test/ep98-exercise.test.ts --reporter=verbose`
Expected: both tests pass. The audio test in under two minutes; the assemble test in roughly fifteen to thirty minutes (the render). Record in the report: each step's wall-clock from the log's timestamps, the `MIX_OK` and `MASTER_OK` lines, the render's duration, and `git -C ~/GitHub/DeadLight status --short` before and after (identical). If a step fails, the failure is a finding about the engine↔script seam (argv, cwd, `uv --project`, progress parsing, hashing a 100 MB WAV); fix the seam in the engine or the script, never by editing show data, and re-run.

Without `SHOWRUNNER_EP98=1` the file is skipped, so the ordinary suite stays hermetic: `npx vitest run` reports it as skipped.

- [ ] **Step 3: README and commit**

In `README.md`'s Develop section add: "`SHOWRUNNER_EP98=1 npx vitest run test/ep98-exercise.test.ts` runs the two script-only exercises against the show at `~/GitHub/DeadLight` (or `SHOWRUNNER_SHOW_ROOT`): the mix, and the timeline → render → master chain, on the non-canon test episode `ep98`, with the real script executor and no agent. It needs `uv`, `ffmpeg`, the render project's dependencies, and about half an hour."

```bash
cd ~/GitHub/Showrunner && git add engine/test/ep98-exercise.test.ts README.md
git commit -F - <<'EOF'
engine: the ep98 exercise — the real scripts under the real executor, no agents

Two env-gated runs seed a log in which every earlier step is completed
and let the pipeline run audio-mix, then build-timeline, render and
master, on the show's non-canon test episode, stopping at the gate that
follows. What it proves: uv finds the scripts project from the show root,
progress and result lines reach the log, large outputs are hashed, the
render runs from render/ with REMOTION_EPISODE, and a gate renders its
message from the show's prompt file.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---
## Task 10: Concurrent agent steps (the last task; Ryan may cut it)

**Why it is last and cut-able.** Measured on ep10's logs (inventory §7.6), the seven-reviewer panel takes 9 min 36 s concurrently and 45 min 26 s sequentially — 35 min 50 s per review round, paid again on every script-gate rejection. Nothing else in this plan depends on it; if the token budget runs short, the plan is complete without it and the deferred record says so.

**Files:**
- Modify: `engine/src/runner.ts` (`RunOptions.concurrency?`; the pass batches ready agent steps; appends are serialised)
- Test: `engine/test/concurrency.test.ts` (new)

**Interfaces:**
- Consumes: the restartable pass of Task 2.
- Produces: `RunOptions.concurrency?: number` (default 1, sequential, exactly today's behaviour). With `concurrency > 1`, when the pass reaches an `agent` step, it also takes every later `agent` step in `ordered` whose dependencies are all already terminal, up to `concurrency` steps, evaluates each one's `when` in order, and runs the batch with `Promise.all`. Outcomes are applied in `ordered` order after the batch settles; the first failure in `ordered` order fails the run and sweeps. Every `log.append` goes through one promise chain, so the `events` array and the file agree on order however the executors interleave.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import type { Executors, Pipeline } from "../src/steps.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function panel(): Pipeline {
  const agent = (id: string) => ({ kind: "agent" as const, id, dependsOn: ["draft"], promptFile: `${id}.md`, model: "m", allowedTools: [], context: "fresh" as const });
  return { name: "p", steps: [
    { kind: "guard", id: "draft", check: () => ({ pass: true }) },
    agent("a"), agent("b"), agent("c"), agent("d"),
    { kind: "guard", id: "review-gate", dependsOn: ["a", "b", "c", "d"], check: (ctx) => ({ pass: true, message: ["a", "b", "c", "d"].every((k) => ctx.results[k] === "ok") ? "yes" : "no" }) },
  ] };
}

async function timedExecutors(fail?: string) {
  const spans: Record<string, [number, number]> = {};
  const executors: Executors = {
    script: async () => ({ ok: true }),
    agent: async (step) => {
      const t0 = Date.now(); await sleep(120); spans[step.id] = [t0, Date.now()];
      return step.id === fail ? { ok: false, error: "boom", toolCalls: 0 } : { ok: true, text: "ok", toolCalls: 1 };
    },
  };
  return { executors, spans };
}

describe("concurrency", () => {
  it("runs ready agent steps at the same time when asked, and one at a time by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const seq = await timedExecutors();
    const t0 = Date.now();
    await run({ pipeline: panel(), ctx, log: new EventLog(EventLog.logPath(root, "s02e01", "r1")), executors: seq.executors });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4 * 120);
    const par = await timedExecutors();
    const t1 = Date.now();
    const r = await run({ pipeline: panel(), ctx: { ...ctx, runId: "r2" }, log: new EventLog(EventLog.logPath(root, "s02e01", "r2")), executors: par.executors, concurrency: 4 });
    expect(r).toEqual({ status: "completed" });
    expect(Date.now() - t1).toBeLessThan(3 * 120);
    // all four overlapped: every start is before every end
    const starts = Object.values(par.spans).map((s) => s[0]); const ends = Object.values(par.spans).map((s) => s[1]);
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
  });

  it("keeps the log's order equal to the array's order under concurrency, and applies outcomes in pipeline order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const { executors } = await timedExecutors();
    await run({ pipeline: panel(), ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors, concurrency: 2 });
    const events = await log.read();
    const completedOrder = events.filter((e) => e.kind === "step_completed" && ["a", "b", "c", "d"].includes(e.stepId ?? "")).map((e) => e.stepId);
    expect(completedOrder).toEqual(["a", "b", "c", "d"]);
    expect(events.filter((e) => e.kind === "step_started").map((e) => e.stepId)).toEqual(["draft", "a", "b", "c", "d", "review-gate"]);
    expect(events.at(-1)?.kind).toBe("run_finished");
  });

  it("fails the run on the first failed step in pipeline order and sweeps, letting the batch finish first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const { executors, spans } = await timedExecutors("c");
    const r = await run({ pipeline: panel(), ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors, concurrency: 4 });
    expect(r).toEqual({ status: "failed", stepId: "c", error: "boom" });
    expect(Object.keys(spans).sort()).toEqual(["a", "b", "c", "d"]);
    const events = await log.read();
    expect(events.some((e) => e.kind === "step_skipped" && e.stepId === "review-gate")).toBe(true);
  });

  it("does not batch a step whose when is false, and never batches script, guard, gate or loop steps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const order: string[] = [];
    const executors: Executors = {
      script: async (s) => { order.push(`s:${s.id}`); return { ok: true }; },
      agent: async (s) => { order.push(`a:${s.id}`); await sleep(50); return { ok: true, text: "ok", toolCalls: 1 }; },
    };
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "agent", id: "a", promptFile: "a.md", model: "m", allowedTools: [], context: "fresh" },
      { kind: "agent", id: "skipped", when: () => false, promptFile: "x.md", model: "m", allowedTools: [], context: "fresh" },
      { kind: "script", id: "s1", argv: () => ["true"] },
      { kind: "agent", id: "b", dependsOn: ["s1"], promptFile: "b.md", model: "m", allowedTools: [], context: "fresh" },
    ] };
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: new EventLog(EventLog.logPath(root, "s02e01", "r1")), executors, concurrency: 3 });
    expect(order).toEqual(["a:a", "s:s1", "a:b"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/concurrency.test.ts`
Expected: FAIL — `concurrency` is not an option; the four agents run sequentially.

- [ ] **Step 3: Serialised appends and the batch**

In `RunOptions`:

```ts
  /** How many ready agent steps may run at once. Default 1: one step at a time in dependency
   *  order, which is the behaviour every other test assumes. The review panel is the case this
   *  exists for — seven reviewers that depend on the same draft, 35 minutes apart sequential and
   *  concurrent on ep10's logs. Only agent steps are batched; scripts, guards, gates and loops
   *  always run alone. */
  concurrency?: number;
```

In `execute`, replace the `append` definition:

```ts
  // Appends are chained so that the events array and the file agree on order even when several
  // agent steps are emitting at once: the log's order is authoritative and must be the order the
  // calls were made in, not the order their writes happened to resolve.
  let tail: Promise<unknown> = Promise.resolve();
  const append = (e: Omit<Event, "ts">): Promise<void> => {
    const next = tail.then(async () => { events.push(await log.append(e)); });
    tail = next.catch(() => undefined);
    return next;
  };
```

In the pass, replace the single `runStep` call and its outcome handling with a batch when the step is an agent step and `concurrency > 1`:

```ts
      const concurrency = Math.max(1, opts.concurrency ?? 1);
      const batch: Step[] = [step];
      if (step.kind === "agent" && concurrency > 1) {
        for (const later of ordered) {
          if (batch.length >= concurrency) break;
          if (later === step || later.kind !== "agent" || batch.includes(later)) continue;
          if ((state.steps[later.id] ?? "pending") !== "pending") continue;
          const ready = (later.dependsOn ?? []).every((d) => ["completed", "bypassed"].includes(state.steps[d] ?? "pending"));
          if (!ready) continue;
          if (later.when && !(await later.when(ctx))) {
            await emitFor(later.id)("step_skipped", { reason: BYPASS_REASON });
            state.steps[later.id] = "bypassed";
            continue;
          }
          batch.push(later);
        }
      }
      const outcomes = await Promise.all(batch.map((s) => runStep(s, ctx, emitFor, executors, events, [...priorEvents, events], pipeline)));
      let failed: { step: Step; error: string } | undefined;
      let reset: StepId[] | undefined;
      let waiting: GateState | undefined;
      for (let i = 0; i < batch.length; i++) {
        const s = batch[i]!;
        const outcome = outcomes[i]!;
        if (outcome.kind === "completed") {
          state.steps[s.id] = "completed";
          if (outcome.result !== undefined) ctx.results[s.id] = outcome.result;
        } else if (outcome.kind === "waiting") {
          waiting = outcome.gate;
        } else if (outcome.kind === "reset") {
          reset = outcome.stepIds;
        } else if (!failed) {
          state.steps[s.id] = "failed";
          failed = { step: s, error: outcome.error };
        } else {
          state.steps[s.id] = "failed";
        }
      }
      if (failed) { await sweep(failed.step); return finish({ status: "failed", stepId: failed.step.id, error: failed.error }); }
      if (waiting) return { status: "waiting", gate: waiting };
      if (reset) {
        for (const id of reset) { delete state.steps[id]; delete ctx.results[id]; }
        continue pass;
      }
```

(A batch of one — the default — is exactly the previous code path; gates and loops are never batched, so `waiting` and `reset` come only from a batch of one.) `sweep` already handles several failed steps: it sweeps every step depending on any `failed` step.

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: PASS, typecheck silent. The timing test's margins (`4 × 120 ms` sequential, `< 360 ms` concurrent) are wide enough for CI; if they flake, widen the sleep to 200 ms and the margins with it, and say so.

- [ ] **Step 5: Document and commit**

In `README.md`'s "The resume contract" or a new short paragraph under "The episode pipeline": "`run({ …, concurrency: 7 })` runs ready agent steps together — the review panel's seven reviewers are the case; everything else runs alone. The log's order is the order the emits were made in."

```bash
cd ~/GitHub/Showrunner && git add engine/src/runner.ts engine/test/concurrency.test.ts README.md
git commit -F - <<'EOF'
engine: ready agent steps run concurrently when asked

RunOptions.concurrency batches agent steps whose dependencies are already
terminal, up to the cap, with appends chained so the log's order is the
order the emits were made in. The review panel's seven reviewers are the
case: 35 minutes per round on ep10's logs, paid again on every script
rejection.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
EOF
```

---
## After the tasks: the deferred record, and what this plan does not do

The controller writes `docs/plans/2026-09-29-the-dead-light-pipeline-deferred.md` after the whole-branch review, in the shape of the Plan C record: status (branches, suites, grep), what Plan D established that later plans build on, a Plan E section, a Plan F section, a Plan G section, and every ruling made during execution with its cost if wrong. Items already known to belong there:

- **Plan E:** the console builds the pipeline per episode with `episodePipeline`, supplies `renderGateMessage` from `createGateMessageRenderer`, calls `run` with `concurrency` set (7 covers the panel), and offers `resumeRun` and `resetSteps` as the two recovery actions; the board derives an episode's stage from the latest run's log with `deriveStage(…, EPISODE_STAGE_MAP, await episodeNeeds(…))`; the run view renders `step_reset` and `run_resumed`; Remotion's frame progress is not parsed (a wrapper that turns Remotion's progress into `::progress` lines is the fix). `resetSteps` on a run with an open gate leaves the gate open with its original message.
- **Plan F:** the six `status.py` steps and `STATUS.md` retire with console v1; the `previous-episode` guard's "no run logs means the archive" rule becomes unnecessary once Season 1 is renamed and can stay as it is; `prompts/index.json` can be deleted then.
- **Plan G:** the `## Cast` grammar and the `source` field are conventions a new show's `init` must teach its prompts; `visual-direction-fix.md` and `publish-copy.md` are prompts every show needs.
- **The first real run** measures what the ep98 exercise cannot: `tts-generate.py` under the engine, the image generators, the SDK child process under abort, the fan-out's rate-limit exposure, and whether the `[SPEAKER]` convention should be taught to `draft.md` (F-19).
- **Not built:** a command line (Ryan's ruling, 2026-09-29); the season desk (spec §0); `untilVerdict` (no loop needs it); the grammar checker (spec §7.1 — one prompt file and one `reviewer(...)` line when it comes).

## Self-review (run by the plan's author before execution)

1. **Spec coverage.** §0 eight gates → Task 5's eight gate steps; `NEEDS_IDEA` → `premise` guard + `episodeNeeds`; `NEEDS_REFS` → `## Cast` + `missingRefs` + `refs-ready`; `NEEDS_IMAGES` → `source` + `missingShowrunnerImages` + `showrunner-images`. §1.1 → `visual-direction` depends on `audio-gate` and declares the mix; §1.2 → canon phase depends on `assemble-commit`; §1.3 → `previous-episode`. §2.1 → two passes, read-only, the script pass reads the approved outline; §2.2/§2.3 → the provenance section of both prompts, `:rejections`, `handEdits`, the ledger; §2.5 → `propose.md`'s ledger section and `canon-gate.gate.md`. §3 → `EPISODE_STAGE_MAP`, the windows. §6.3 → every script step declares inputs; §6.4 → unchanged engine; §6.7 → `draft`'s `progress`, `toolCalls` on failure; §6.9 → the sentinel resume. §7.1 → six reviewers plus the canon reviewer, seven wide.
2. **Placeholder scan.** No "TBD"; every code step shows the code; every prompt edit gives the wording. The one "read the file first" instruction (draft.md's completion section) names the exact sentence to keep.
3. **Type consistency.** `rerunOnReject: StepId[]` (Tasks 1, 2, 5); `StepOutcome` `reset` variant (Tasks 2, 10); `AgentStep.schemaFile` and `GateStep.messageFile`/`message?` and `RunOptions.renderGateMessage` (Task 5, used in Tasks 6, 9); `missingRefs`/`missingShowrunnerImages`/`episodeNeeds` (Tasks 4, 5, 6); `handEdits(ctx, files)` (Tasks 4, 5); the step ids in Task 5's table, Task 6's walk, Task 8's prompts and Task 9's seeds agree (`canon-review-outline`, `hand-edits-outline`, `image-audit-verdict`, `canon-diff`, `publish-copy`, `populator-check`, `visual-direction-fix`).

## Execution handoff

Plan complete and saved to `docs/plans/2026-09-29-the-dead-light-pipeline.md`. Execute with superpowers:subagent-driven-development: a fresh implementer per task, the three-question quiz before each, a task review after each (reviewers on Sonnet, implementers and the whole-branch reviewer on Opus), one fix wave after the whole-branch review, and the deferred record last. Task 10 is executed only if the token budget allows when Task 9 is done.

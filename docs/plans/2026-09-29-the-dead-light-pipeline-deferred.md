# Plan D (the Dead Light pipeline) — deferred items and rulings

**Status:** Plan D is built on two branches: `plan-d` in the engine repository (branched from `main` at `a7e6127` on 2026-09-29; `git log a7e6127..plan-d` is the commit list) and `plan-d-show-data` in the show repository (branched from `plan-c-show-data` at `fbb8c16`). The final tree passes the engine suite (208 tests, 4 env-gated exercises skipped in the ordinary run), the scripts suite (333) and the prompt checker (every prompt renders), with every typecheck silent and the show-name grep empty. The whole-branch review returned "ready to merge with fixes"; one fix wave addressed its two Criticals, three Importants and four fix-before-merge Minors, and one scoped re-review confirmed them. **Task 10 of the plan (concurrent agent steps) was not executed in this pass**, on Ryan's budget note of 2026-09-29; it stands in the plan as a self-contained task.

This document is the durable record of what the review process deferred to later plans and of every ruling the controller made during execution. The plan file (`docs/plans/2026-09-29-the-dead-light-pipeline.md`) describes what was built and rules on the inventory's twenty-one findings; the inventory (`docs/plans/2026-09-29-plan-d-inventory.md`) records what was found. Each later plan's author reads their section here, together with the Plan A, B and C records (`docs/plans/2026-09-26-engine-core-deferred.md`, `docs/plans/2026-09-27-agent-runner-deferred.md`, `docs/plans/2026-09-28-show-config-and-prompts-deferred.md`).

## What Plan D established that later plans build on

- **One pipeline per episode.** `episodePipeline({ show, episodeId, engineRoot })` in `engine/src/pipelines/episode.ts` builds 73 typed steps in four phases — write, assets, assemble, canon — so spec §1's ordering rules are dependency edges and one run log under `Production/<id>/runs/` holds the episode's whole history. Step ids are unique across the list; the README's "The episode pipeline" section lists the eight gates with the stage each opens and the steps its rejection re-runs.
- **A gate's `rerunOnReject`** names the steps a rejection invalidates. After the fix agent completes the runner writes `step_reset` for each of them and every non-gate step downstream, restarts its pass, and re-executes them before the gate reopens; the reset is recorded once per rejection; an empty closure reopens the gate without a reset. A script step among them whose declared inputs and outputs are unchanged is served from cache.
- **Two recovery moves.** `resumeRun(log, runId)` reopens a failed run (`run_resumed`) and continues from the failed step without re-running any completed agent step. `resetSteps(pipeline, log, runId, stepIds)` is the operator's "re-run from here". Both refuse a mismatched run id.
- **Two more event kinds**, `step_reset` and `run_resumed` (eighteen in all); `deriveRunState` keeps `results["<gateId>:rejections"]`, the array of every note a gate has received in the run, which the runner initialises to `[]` for every gate so a prompt can render it from any step.
- **`RunContext.events`** is the run's log as read so far; guards read it. `handEdits(ctx, files)` in `engine/src/provenance.ts` answers spec §2.3's hand-edit question by comparing the last recorded output hash of a file with the file on disk; loops and gate fix agents now record `inputHashes` and `outputHashes`.
- **The three `Needs` probes** live in `engine/src/needs.ts` and read disk only: the premise file; the outline's `## Cast` section (grammar `- <Name> (<tags>)`, tags from `recurring`, `guest`, `speaks`, `location`) against the visual bible and the voice cast; the shot list's `source` field against the PNGs. `NEEDS_REFS` is reported from SCRIPT to CASTING and `NEEDS_IMAGES` from AUDIO to IMAGES (`NEEDS_RULES` windows). Three guards stop the line where the states say: `premise`, `refs-ready`, `showrunner-images`.
- **The canon reviewer** is one schema (`prompts/canon-review.schema.json`, with `issues` for agent slips and `deviations` for the showrunner's own departures) and two prompt files, one per pass; `scripts/canon-ledger.py` writes the deviations to `Episodes/<id>/canon-ledger.md` as `PENDING` rows; `propose.md` marks them `ACCEPTED` at the canon moment and `canon-gate.reject.md` can mark one `WITHDRAWN`.
- **Prompts are files and the extractor is retired.** `prompts/index.json` is frozen as Plan C's extraction record; the pipeline definition is the manifest of which prompt file each step reads. Gates name their message as a prompt file (`GateStep.messageFile`, rendered through `RunOptions.renderGateMessage`, built by `createGateMessageRenderer`), and agent steps name their schema as a file (`AgentStep.schemaFile`).
- **Two new scripts:** `git-commit.py` (the four commit steps; skips an ignored path) and `canon-ledger.py`. `populator-check.py --report-only` feeds a fix agent before the plain mode fails the run. A shot whose `source` is `"showrunner"` is never generated.
- **The `ep98` exercise** (`SHOWRUNNER_EP98=1 SHOWRUNNER_SHOW_ROOT=<show> npx vitest run test/ep98-exercise.test.ts`) runs the real `audio-mix`, then `build-timeline → render → master`, under the real script executor with no agent; on 2026-09-29 the mix took 50.9 s and the assemble chain 678 s (render 583 s).

## Plan E — the console

- The console builds the pipeline per episode with `episodePipeline`, supplies `renderGateMessage` from `createGateMessageRenderer({ query: sdkQuery, show })`, calls `run` (with `concurrency` once Task 10 exists), and offers `resumeRun` and `resetSteps` as the two recovery actions. The board derives an episode's stage from the latest run's log with `deriveStage(state, EPISODE_STAGE_MAP, await episodeNeeds(showRoot, id, show))`. The run view renders `step_reset` and `run_resumed`.
- **`resetSteps` on a run with an open gate leaves the gate open with its original message** and the resets take effect only once the gate is answered; and a reset never touches a gate step, so "re-ask an approved gate" is a console action still to design (the answer is a new `gate_answered` on a reopened gate, which needs a runner verb).
- **Remotion's frame progress is not parsed.** `render` runs with `--log=error` and logs nothing for its ten minutes; a wrapper that turns Remotion's progress into `::progress` lines is the fix.
- **A NEEDS_ state and an open gate can coincide** (`NEEDS_IMAGES` while `nano-banana-gate` is open); the NEEDS_ state wins in `deriveStage`, and the board should say both.
- `ctx.events` is the live array, not a snapshot; a guard that keeps a reference sees later events.

## Plan F — cutover

- The six `status.py` steps and `STATUS.md` retire with console v1. `prompts/index.json` can be deleted then. The `previous-episode` guard's "no run logs means the archive" rule stays correct after the rename.
- **`previous-episode` never crosses a season boundary** (`id.episode === 1` passes unconditionally), so rule 1.3 is not enforced from `s01e10` to `s02e01`; harmless while Season 1 predates the engine.
- `prompts/audio-gate.gate.md` names the mix with an air-named glob (`DeadLight *.wav`), which misses an unmapped production id's `episode.wav`; every id is air-named after the rename.
- `EventLog.logPath` hardcodes `Production` while the pipeline reads `show.productionDir` (pre-Plan-D; identical for this show).

## Plan G — new-show setup

- The `## Cast` grammar and the `source` field are conventions a new show's `init` must teach its prompts; `visual-direction-fix.md` and `publish-copy.md` are prompts every show needs. The seven season-desk prompts (`apply.md`, `arc-tracker.md`, `craft-critic.md`, `desk-editor.md`, `desk-gate.*`, `thread-auditor.md`) are referenced by no step of the episode pipeline: they are spec §0's deferred desk, not dead code.

## Task 10 and the first real run

- **Task 10 (concurrent agent steps) is the first thing to add**: measured on ep10's logs, the seven-reviewer panel costs 35 min 50 s per review round sequentially, paid again on every script-gate rejection. The task in the plan touches `engine/src/runner.ts`, one new test file and the README.
- **The first real run measures what `ep98` cannot:** `tts-generate.py` under the engine, the image generators, the SDK child process under abort, the fan-out's rate-limit exposure, and whether the `[SPEAKER]` convention should be taught to `draft.md` (inventory F-19).
- **Caching on inputs alone:** `image-generate`, `nano-banana-generate`, `finalize` and `registry-append` declare inputs and no outputs, so a PNG, a NAS copy or a casting-pile still deleted between runs is not remade unless an input changed. The reject prompts order edit-then-delete, and `image-sheet` re-runs in the same closure and shows a missing shot, so the case is detectable; dropping `inputs` from the two generators (both skip a shot whose PNG exists) is the cheap fix if it bites. `canon-baseline` writes the patch file but declares no `outputs` (symmetry only).
- **A rejection with no notes appends `""`** to `<gate>:rejections`; the reviewer prompts describe the value as a JSON list, which reads correctly with a blank entry.
- **Not built:** a command line (Ryan's ruling, 2026-09-29: `s02e01` waits for Plan E, possibly Plan G); the season desk (spec §0); `untilVerdict` (no loop needs it); the grammar checker (spec §7.1 — one prompt file and one `reviewer(...)` line when it comes).

## Test hygiene the reviews parked

- `mixFilename` passes the variable `episodeId` where `scripts/lib/showconfig.py`'s `format_filename` takes `episode_id`; no pattern uses either today. `slugName` strips a leading "the", so "The Harbor" and "Harbor" collide (no such pair exists in the bible). A `(location, speaks)` cast line has its voice unchecked. `git-commit.py`'s `parse()` mis-locates the paths when the message is literally `--`; `canon-ledger.py` does not de-duplicate within one `--rows` payload and defaults `episodesDir` where sibling scripts require it. The `ep98` exercise awaits `exercise()` outside its `try`/`finally`, so a throw before `run()` returns skips cleanup once. A sentinel-resumed loop emits no `step_progress`. `orderSteps` does not check that a `rerunOnReject` id is upstream of its gate (a downstream id resets nothing).

## Rulings made during execution (2026-09-29), with the cost if wrong

1. **The three-question quiz gate stayed before every implementer** (Ryan's rule); it caught a wrong file list in Task 1, the empty-closure hang in Task 2, the vacuous ordering assertion in Task 6, and the swallowed "no signal" clause in Task 8 before code was written or before review. Cost: one short turn per task.
2. **Expected test counts in the plan were stale from Task 1 on** (an extra EventKind test); from Task 2 the real number is what counts. Cost: none.
3. **An empty reset closure reopens the gate** instead of returning a reset that would restart the pass forever (found by Task 2's implementer by experiment). Cost: none — no gate names a downstream-only step.
4. **Neither the runner's reset nor `resetSteps` ever resets a gate step** (fix wave, after the whole-branch review's I-1): an upstream gate's answer is not invalidated by a later gate's rejection, and re-asking an approved gate is a console action still to design. Cost: an operator reset naming a gate is inert.
5. **A renderer that throws fails the gate** with `gate "<id>": <file> did not render: <message>` rather than escaping `run()` (Task 5). Cost: none.
6. **A guard that throws fails its step** with `guard threw: <message>` (fix wave, C-2). Cost: none.
7. **`NANO_PARTIAL` exits 0**; the gate message renders the result line, so a `0/N` run is shown to the showrunner rather than failing the run (Task 7). Cost: a zero-success run pauses at a human gate.
8. **The `ep98` exercise takes its show root from `SHOWRUNNER_SHOW_ROOT` only**; a default built from the show's directory name would put a show name in an engine file. Cost: one env var for the operator.
9. **The show-name grep excludes `render/public/`**, the git-ignored staging directory `build-timeline.py` fills during a run. Cost: none.
10. **`assemble-commit` no longer names the ignored `timeline.json`, stages `publish.json` and `prompts.json` (the final gate's fix-agent outputs), and `git-commit.py` skips an ignored path** (fix wave, C-1 and I-3). Cost: none.
11. **`missingRefs` reports a malformed `## Cast` line or an entry with no recognised tag** instead of passing silently (fix wave, I-2). Cost: a stricter `NEEDS_REFS` message.
12. **Task 10 was not executed in this pass.** Cost: 36 minutes per review round at run time until it is built.
13. **Fix-loop model choices:** implementers and the whole-branch reviewer on Opus, task reviewers and the scoped re-reviewer on Sonnet (Ryan, 2026-09-29). One Opus session limit was hit during Task 9; the agent was resumed with its context intact after the reset.

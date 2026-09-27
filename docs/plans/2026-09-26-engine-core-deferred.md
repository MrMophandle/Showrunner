# Plan A (engine core) — deferred items and rulings

**Status:** Plan A is built on branch `engine-core` (43 commits from `b2443ad`, HEAD `8119d57` on 2026-09-27; 92 tests across 12 files; typecheck clean). The whole-branch review returned "ready to merge with fixes"; one fix wave of fifteen commits addressed every Critical and Important finding, and the scoped re-review confirmed each with file:line evidence.

This document is the durable record of what that review process deferred to later plans and of every ruling the controller made during execution. The plan file (`docs/plans/2026-09-26-engine-core.md`) describes what was built; this document describes what was consciously left for Plans B–F. Each later plan's author reads their section here before writing their plan. Items are grouped by the plan that owns them.

## Plan B — agent runner (Claude Agent SDK)

- **`timeoutMs` on `StepBase` is enforced only by the script executor** (`engine/src/script-step.ts`). The agent executor must enforce it for every agent step, including the nested `GateStep.onReject` and `LoopStep.body` agents. Guards, gates and loops do not enforce it: a guard is in-process and fast, a gate waits on a human by design, and a loop inherits its body's timeout. Document that on the types; do not enforce it for those kinds.
- **`when` on a nested agent step is unsupported by design.** The runner never consults `onReject.when` or `body.when`; a nested agent runs because its parent decided so. Plan B narrows the nested type to `Omit<AgentStep, "when" | "dependsOn">` so the type system says what the runner does.
- **`AgentStep.schema?: object` is too loose to validate anything.** Tighten it when Plan B validates a JSON verdict against it. Verify the JSON-verdict and tool-allowlist API against the current Agent SDK documentation before writing the plan (spec §4.7).
- **Results alias event payloads.** `deriveRunState` hands a step's stored `result` to later steps through `ctx.results` without a deep copy. Plan B's executor contract states that a returned verdict must not be mutated after it is returned.
- **`deriveRunState`'s `default: break` gives no compile-time nudge for a new event kind.** The kinds are fixed at sixteen by the spec, so this matters only if a plan adds one; a plan that does so replaces the `default` with an exhaustiveness check.
- **Three of the sixteen event kinds are emitted by nobody in Plan A:** `agent_query`, `agent_tool_call`, `agent_result`. The obligation is documented on `Executors` in `engine/src/steps.ts`; Plan B fulfils it.

## Plan C — show config, prompt extraction, and the Python scripts

- **`::progress` lines in every long-running script.** Each script prints `::progress {"done":N,"total":M,"unit":"..."}` on stdout; the script executor turns them into `step_progress` events. The audit in the process map (`docs/specs/2026-09-25-pipeline-process-map.md` §9) lists which scripts print nothing today.
- **Script-executor tests still missing:** a stderr `::progress` line staying a `script_line`; the spawn-failed path (`ENOENT`); the fourth test in `engine/test/script-step.test.ts` asserting its outcome, not only that it resolved.
- **The failure message is frozen at exit time**, not after the drain, so stderr written during the two-second grace is not in the `step_failed` error. Pass the exit code and signal into `settle` and build the message after the race.
- **The I7 timing margin is thin.** `engine/test/script-step.test.ts` asserts `elapsed < 3000` against `DRAIN_GRACE_MS = 2000` and measured 2599 ms on 2026-09-27. Widen the bound to 4000 or measure the drain alone.
- **`engine/test/fixtures/escapee.py`'s grandchild outlives the suite by roughly two seconds** before `EPIPE` kills it. Not a defect; relevant if CI reports stray processes.
- **`hash.ts` tests missing:** the non-`ENOENT` rethrow branch and the `null`→hash transition (a declared output that appears between runs).

## Plan D — the Dead Light pipeline

- **A loop resumed after a crash ignores a recorded `sentinel: true`.** `runLoopStep` (`engine/src/runner.ts`) counts this run's `loop_iteration` events to resume the counter but does not inspect the last one's `sentinel`. A crash landing between the final `loop_iteration` and `step_completed` resumes as exhausted. The fix is three lines: if the last `loop_iteration` for this run carries `sentinel: true`, complete the loop without calling the body. Plan D adds it when it wires the first real loop, with a hand-written-log test.
- **A gate bypassed by `when` never advances its approved stage.** `deriveStage` (`engine/src/stages.ts`) counts only `completed` steps toward `highest`. Plan D must not put `when` on a gate that a `StageMap` entry points at; map the stage to a later step instead.
- **`StageMap` keys are not validated against pipeline step ids.** A typo degrades silently. Plan D validates its map's keys against `pipeline.steps` at load time using the exported `isStage()` for values.
- **The loop ignores its body's declared `inputs`/`outputs`.** Hash-based caching applies to the loop step, not to each body iteration. Plan D declares inputs and outputs on the loop, not the body.
- **A guard with declared inputs records no hashes.** Guards are never cached, so their `step_completed` carries no `inputHashes`. Plan D does not rely on a guard's hashes for anything.
- **`Record<string, string | null>` cannot guarantee "order given" for integer-like keys** in `hashFiles`. Plan D uses non-numeric output paths (every real path is non-numeric).
- **§6.7 in-loop progress.** The engine cannot know what `script.md` is. Plan D supplies a `LoopStep.progress` probe that counts scene headers against outline beats.
- **Idempotency is delegated to the scripts.** A crash mid-script re-runs the whole script (`README.md`, resume contract). Plan D states, per Python step, that a re-run over a partial output is safe, and fixes any step where it is not before the first real run.
- **Tests Plan D adds when it composes the real pipeline:** the `dependsOn`-omitted path; a fix agent that fails; a rejection on a gate without `onReject`; a downstream step reading a gate's answer from `ctx.results`; a sentinel on iteration 1; the body-failure path; the loop's result reaching `state.results`; the cache path, `maxAttempts`, `map.approved`, the `Needs` rules, `priorLogs`, and the failure cascade end to end.

## Plan E — the console (four surfaces)

- **Cross-process concurrency.** The engine's guard against two concurrent `run()` calls is per-process and keyed by `path.resolve`, so it does not see a second OS process or a symlinked path. Plan E runs one owning server per show repo, or takes a lock file beside the log.
- **`SIGINT`/`SIGTERM` handling.** The server wires both signals to `killLiveProcessGroups()` (`engine/src/script-step.ts`). That function currently rethrows a non-`ESRCH` error mid-iteration; Plan E changes it to continue past any error and return how many groups it could not signal.
- **`answerGate` is attempt-blind.** Plan E passes the attempt it displayed (`expectedAttempt`) so a stale approval from a previous attempt cannot answer a newer one. Plan E always passes `by`; the engine does not default it.
- **`answerGate` on an empty or absent log throws `run id mismatch`**, not `gate "<id>" is not open`. Message text only.
- **`step_cached` carries no reason string; `step_completed`/`step_failed`/`step_skipped` omit the step `kind`.** The console joins to `step_started` for the kind, or Plan E adds the field to the runner.
- **A crashed loop iteration also reports `toolCalls: 0`.** The dashboard's dead-iteration rule reads the `error` field alongside `toolCalls`.
- **A run finished as failed still reports its highest approved stage.** The board shows run status beside the stage.
- **`formatAired`'s `InvalidEpisodeId` message passes a bare ordinal as the "raw id".** Message text only.
- **No log rotation or size cap.** Every script line is an event. A long Remotion render produces tens of thousands of events per run; Plan E decides whether the server streams the tail or reads the whole file.
- **Detached children.** A script's process group survives the engine process dying; the signal handler above is the answer, and a crashed server on restart reads `liveProcessGroups()` (empty after a restart) and cannot find the orphans. Plan E records each spawned pid in the log payload if it wants to find them.
- **`deriveStage` tests still missing:** a completed step absent from `approved`; an open gate absent from `gates`; `compareStages` ≤ 0; `ideaMissing`/`imagesMissing` exactly at their `passedAt`.

## Plan F — cutover

- **The version exists three times** (`engine/package.json`, `engine/src/index.ts`, `engine/test/smoke.test.ts`), and the smoke test compares a literal to itself. Read it from `package.json` in one place.
- **Every `mkdtemp` root in the suite is left behind.** Add a suite-wide `afterEach` cleanup.
- **Two commits carry the trailers in two paragraphs** (`402e489`, `2fc5e7f`), so `git log --format='%(trailers)'` parses only `Claude-Session` on them. History stands because every plan amendment, ledger line and review package names those SHAs. The pull request description records the deviation, and the merge commit carries both trailers in one paragraph.

## Not a defect, recorded so nobody re-finds it

- `engine/src/runner.ts:124` picks a finished-failed run's step by insertion order of the derived record. A run returns at its first failure, so there is only ever one.
- `hashFiles` hashes serially. Parallel hashing of multi-gigabyte masters would thrash the disk for no gain.
- `compareEpisodeIds`' trailing `return 0` is required for TypeScript narrowing.
- `deriveRunState` maps an unknown run status to `failed` (fails closed) and never produces `"pending"` (absence is pending; the comment in `state.ts` says so).
- A gate's stored result carries `waitedMs` and `attempt`. Spec §6.5 wants how long the gate stood open recorded, and this is the record.
- The fixtures require `python3` on `PATH`. The plan states Python 3 is present, and the real deterministic steps are Python.

## Rulings made during execution

Each ruling is a decision the controller made without asking, recorded with what it costs if wrong. Ryan can undo any of them.

1. **Work on branch `engine-core` in the checkout, not a separate worktree.** The plan's paths are absolute to `~/GitHub/Showrunner`. Cost if wrong: a branch rename.
2. **`.superpowers/` git-ignored in the first commit.** Cost if wrong: the scratch workspace gets committed.
3. **Gate and loop stubs returning failures until Tasks 9 and 10 are plan-mandated scaffolding**, not defects. Cost if wrong: none; Tasks 9 and 10 replaced them.
4. **The implementer may add a null guard on `child.stdout` if `tsc` rejects the tuple overload.** Cost if wrong: one extra branch.
5. **Pushes go to `origin/engine-core`, never `origin/main`**, whatever a brief's verbatim text says. Cost if wrong: none.
6. **Tests are typechecked** through `engine/tsconfig.test.json`, and `npm run typecheck` runs both configs. Cost if wrong: one extra config file.
7. **From Task 2 onward every commit carries both trailer lines in one final paragraph**; Task 1's two commits stand. Cost if wrong: attribution on two commits.
8. **Task 2's expected test count is 7, not 6**; the plan text was off by one. Cost if wrong: none.
9. **A task's code block governs over its abbreviated Interfaces summary.** Cost if wrong: none.
10. **Task 3's declaration-order test gained a case that can fail** (`[z, a, m(z,a)]` → `[z, a, m]`). Cost if wrong: one extra test.
11. **`hashFiles` streams the digest** instead of buffering the file, because the pipeline hashes full-episode WAVs and mastered MP4s above the 2 GiB `readFile` limit. Cost if wrong: none; identical digests.
12. **Task 7 gained a test for §6.9 running-step re-execution**, since the constraint is named and was untested. Cost: one test.
13. **The script executor was restructured once:** serialized emits through a caught tail promise, detached spawn with process-group kill on timeout, resolution from `exit` with a two-second bounded drain, and `signal <sig>: <stderr>` on a signal exit. Cost if wrong: the detached-child concern above, now answered by `killLiveProcessGroups()`.
14. **Plan E's console always passes `by` on a gate answer**; the engine does not default it. Cost if wrong: an answer with no author in the log.
15. **Gate decisions are made by log position, never by timestamp**, after the reviewer reproduced a permanent wedge under a stepped-back clock. Cost if wrong: none.
16. **Task 9 gained the §6.4 "no gate past a failed dependency" test.** Cost if wrong: none.
17. **§6.7 disk-derived in-loop progress belongs to Plan D**, supplied through `LoopStep.progress`. Cost if wrong: no in-loop progress on the dashboard until Plan D.
18. **The fix wave was one dispatch** covering the Critical, the ten Importants, the two plan-level gaps, and the Minors the reviewer marked fix-before-merge; everything marked defer stayed deferred. Cost if wrong: a large wave that one scoped re-review had to cover (it did).
19. **`when` is a `StepBase` field producing `step_skipped {reason: "when: false"}` and a new derived status `bypassed` whose dependents run.** Plan D's port has three `when` uses. Cost if wrong: one status the console must render.
20. **`trigger?: string` lives on the run context and is written into `run_started`.** Cost if wrong: none.
21. **A gate's fix agent is a step of its own and logs under its own id; a loop body is not and logs under the loop's id.** Documented, not changed. Cost if wrong: Plan E joins body events to the loop positionally.
22. **The two two-paragraph-trailer commits stand.** Cost if wrong: attribution on two commits.
23. **The reviewer's disputes of two earlier deferrals were accepted:** `LoopStep.progress` and the live-process-group registry shipped in the fix wave, because Plans D and E could not add them without editing Plan A's surface. Cost if wrong: none.
24. **The six Minors from the scoped re-review are deferred, not fixed** (listed above under Plans B, C, D and E), because the process allows one fix wave and none is Critical or Important. Cost if wrong: the item-by-item costs stated above, the largest being one loud, re-runnable loop failure in a two-append crash window.

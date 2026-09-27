# Plan B (agent runner) — deferred items, the §4.7 closure, and rulings

**Status:** Plan B is built on branch `agent-runner` (fifteen commits from `9501e70`; the fix wave's last commit is `8c0bca4`, 2026-09-27; 139 hermetic tests across 19 files plus two env-gated live tests that pass against SDK 0.3.283; typecheck clean). The whole-branch review returned "ready to merge with fixes"; one fix wave of three commits addressed every Important and the Minors it marked fix-before-merge.

This document is the durable record of what the review process deferred to later plans, what the live runs established, and every ruling the controller made during execution. The plan file (`docs/plans/2026-09-27-agent-runner.md`) describes what was built; this document describes what was consciously left for Plans C–F. Each later plan's author reads their section before writing that plan, together with the Plan A record at `docs/plans/2026-09-26-engine-core-deferred.md`.

## Spec §4.7, closed

The spec asked for two things to be verified against the Agent SDK's documentation before implementation, not from memory. Both are now verified in code and by a live run.

**A query can return a JSON verdict validated against a schema.** The option is `outputFormat: { type: "json_schema", schema }`; the SDK validates against JSON Schema draft-07 and re-prompts on mismatch; the object arrives as `structured_output` on the result message. Verified by `engine/test/sdk-query.test.ts` (the wire shape) and by the live run of 2026-09-27 against SDK 0.3.283: a step with only `Read` allowed returned `{ pass: true, word: "TANGERINE" }` in 6.9 seconds, one tool call, cost about seven cents.

**Per-query tool allowlist and model selection.** `model` is a string alias or id. Tools are restricted on two layers: `tools` (which built-ins are in the model's context) and `allowedTools` (which calls are approved), with `permissionMode: "dontAsk"` denying anything not pre-approved. The engine sets `tools` and `allowedTools` to the same list, so a tool outside the allowlist is never in context at all. Verified by the second live run of 2026-09-27: a step allowed only `Read` and prompted to use `Bash` ran with an empty toolset, made no tool call, and returned `{ pass: false, reason: "No Bash tool is available in this session's toolset…" }`. Under this design `permission_denials` is structurally zero; the empty tool list and the verdict are the evidence.

**What the live run found that the documentation did not say.** With `outputFormat` set, the SDK delivers the verdict through a synthetic tool call named `StructuredOutput`, which arrives as an ordinary `tool_use` block; the same object then arrives as `structured_output`. Counted, it would inflate `toolCalls` by one on every schema step and disable spec §6.7's zero-tool-call detector for exactly those steps. The adapter (`engine/src/sdk-query.ts`) drops that block; the name is not in the SDK's type declarations, so it is pinned there and in the adapter's unit test, nowhere else.

## Plan C — show config, prompt extraction, and the Python scripts

- **The template rule, precisely.** Leading and trailing whitespace inside `{{ }}` is trimmed; whitespace elsewhere in the expression is not. Plan C's rewrite of the Archon variables uses this table: `$EP`, `$EP_ID`, `$setup.output` → `{{episodeId}}`; `$REJECTION_REASON` → `{{results.<gate-id>:rejection}}`; `$<step>.output.<field>` → `{{results.<step>.<field>}}`; `$ARGUMENTS` (the premise) → a Plan D result key the setup step writes. Anything else in the five workflow files is a finding for Plan C.
- **A stray single brace beside a valid variable** (`{{{x}}}` renders `{value}`) is not refused, because single braces are legal prose in a prompt. Plan C, which rewrites every prompt, is where a real prompt would hit it.
- **The leftover-brace guard runs on the rendered string**, so a result value carrying `{{` aborts the render with a message that blames the template. Intended and documented; the better remedy, if a real result ever carries doubled braces, is to search the residue of `template.replace(VARIABLE, "")` instead, which keeps every existing assertion green.
- **A circular or BigInt result escapes as a raw `TypeError`**, not a `TemplateError`. The step still fails loudly (the executor returns `{ ok: false, error }`), so only the error class is wrong.
- **Timing tests use wall-clock margins** (the narrowest is now a 60 ms message against a 200 ms idle window). Plan C's hygiene pass moves them to fake timers if they ever flake.
- **`::progress` lines in every long-running script** remain Plan C's, as Plan A's record says.

## Plan D — the Dead Light pipeline

- **A loop body may not carry a schema.** `orderSteps` refuses it at load time, because a schema step's final text is the serialized verdict and a prose sentinel would match substrings of the JSON (a verdict `{"status":"NOT_DONE"}` would satisfy `until: "DONE"` and end the loop early with a wrong answer). Today's loops (draft, outline-revise, revise, image-audit) are text-sentinel bodies without schemas. If Plan D wants a verdict-driven loop, it adds an `untilVerdict` predicate to `LoopStep` and lifts the guard for bodies that declare one.
- **`loop_iteration.toolCalls` is `0` on a failed iteration** even though the executor knows the real count and records it on `agent_result`. Plan D can carry `toolCalls` on `AgentOutcome`'s failure variant and make the number true; until then the dashboard reads `error` alongside `toolCalls` (Plan A's Plan E note).
- **The `StructuredOutput` symptom to watch on the first real schema steps:** a schema step whose `toolCalls` is one higher than the tools it ran means the SDK renamed the synthetic tool; `STRUCTURED_OUTPUT_TOOL` in `engine/src/sdk-query.ts` is the only line to change.
- **The filter is name-only and unconditional.** A real tool literally named `StructuredOutput` would be dropped on any step, schema or not — the fail-safe direction. Gating the drop on `outputFormat` being set is a two-line hardening Plan D can add with its first schema steps.
- **A nested agent step can still carry `when` through a variable.** `Omit` blocks the field on fresh object literals only; the runner ignores a nested `when`, and the type's doc comment says so. Plan D types its real nested steps as `NestedAgentStep`, which is what makes the omission enforced.
- **Fan-out of the review panel.** Plan A's runner executes steps one at a time in dependency order; the seven reviewers run sequentially. If the wall-clock matters, Plan D adds parallel execution of independent ready steps as its own task, with log order still authoritative.
- **The first real run is where two things get measured:** whether `abortController.abort()` actually stops the SDK's child process (the only test of it is against an injected fake), and the per-step spawn cost that a warm `startup()` process would remove.

## Plan E — the console

- **The SDK's child processes are not in `killLiveProcessGroups()`.** That registry knows only script children. The agent executor's one lever is `abortController.abort()` on a deadline; a `SIGTERM` handler that kills script groups leaves an in-flight Claude Code child running. Plan E measures the abort's effect on the real child (with Plan D's first run) and decides whether the adapter must record the child's pid.
- **A rejected `agent_query` or `agent_result` emit escapes as a thrown executor**, not as `{ ok: false, error: "log write failed: …" }` (only the `agent_tool_call` emit is guarded that way). The script executor never throws. A thrown executor rejects `run()`; the log holds `step_started` with no terminal event; the step derives as `running`, and §6.9's replay re-executes it on the next run. Coherent crash semantics, now stated on `Executors` and in the README; Plan E's server must catch a rejected `run()`.
- **The handler is not raced against the deadline.** A stalled log append delays the deadline by its own duration; the clock is observed at the next message. Plan E owns the log writer and decides whether that needs racing.
- **The session map is per-executor and unbounded**, one short string per shared step per run. Eviction on `run_finished` matters only once Plan E holds one executor across many runs.
- **Cost figures are the SDK's client-side estimate**, not billing data; the Usage and Cost API is the authoritative source if the board ever shows money.
- **Cross-process concurrency** stays as Plan A's record says: one owning server per show repository, or a lock file beside the log.

## Plan F — cutover and packaging

- **A subpath export for the adapter.** `engine/src/index.ts` re-exports `sdk-query.js`, so every consumer of the barrel — and two Plan A tests — loads the SDK module at import. Measured on 0.3.283: 58 ms, no active handles, no child process, identical to a no-import baseline. Parked as a packaging decision: `engine/package.json` is `private: true` with `main` and no `exports` map. **Condition:** any bump of the pinned SDK version re-runs the import side-effect probe before merging.
- **The SDK's peer dependencies** (`zod ^4`, `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`) were satisfied by npm's automatic peer install and are undeclared in `engine/package.json`; no Plan B source file imports them.
- **`npm audit` reports five advisories**, all in the vitest/vite/esbuild chain (Plan A devDependencies); none reachable from shipped code. Plan F's hygiene task decides.
- **`devDependencies` key order** was normalized by npm; noise.
- The Plan A items (version triplication, `mkdtemp` cleanup, the two-paragraph trailer commits) still stand.

## Not a defect, recorded so nobody re-finds it

- The `StructuredOutput` literal is repeated in `engine/test/sdk-query.test.ts` on purpose: the test pins the observed wire name independently of the source constant, so a rename of the constant away from the wire name fails there.
- The draft check is an allowlist: a `$schema`, if present, must name draft-07; an absent `$schema` is fine, because the SDK assumes draft-07.
- A schema step whose result carries `structured_output: null` passes as a verdict of `null`; only an absent `structured_output` is a failure.
- Two result messages in one stream: the last wins. The SDK yields one.
- The idle clock is armed before the first message, so spawn time counts as idle; harmless at the production 900-second bound.
- The `agent_query` and `agent_result` payloads never carry an `undefined` key (every optional field is conditionally spread), and `deniedTools` dedupes and drops non-string names.
- Report citation drift in the task reports is a property of the scratch reports, not of the branch.

## Rulings made during execution

Each ruling is a decision the controller made without asking, with what it costs if wrong. Ryan can undo any of them.

1. **Build on branch `agent-runner` in the checkout**, as Plan A did. Cost if wrong: a branch rename.
2. **`GateStep.onReject` stays optional**; only its type narrowed to `NestedAgentStep` (the brief had written it required). Cost if wrong: none.
3. **The leftover-brace guard was a defect to fix before review**, not later. Cost if wrong: a value legitimately containing doubled braces is refused, documented as intended.
4. **The `Omit`-through-a-variable hole is parked**, because closing it types every nested step in Plan A's tests. Cost if wrong: a nested `when` silently ignored, which the type's comment declares unsupported.
5. **Task 3's five review Minors were folded into Task 4** rather than a fix round, because Task 4 rewrote that region. Cost if wrong: none.
6. **Task 4's four foldable Minors were folded into Task 5**, same reasoning; two were parked. Cost if wrong: none.
7. **A shared step's session is recorded on the failure path too** (a timed-out step still opened a session). The write is inert today, since no step gets a second query after a failure in one run; it is the forward-compatible default for a retry policy. Cost if wrong: a retry inherits a stalled transcript's context and tokens.
8. **Task 5's five foldable Minors were folded into Task 6**, including adding `episodeId` to the session key. Cost if wrong: none.
9. **The SDK's synthetic `StructuredOutput` call is dropped in the adapter**, the one SDK-aware file. Cost if wrong: the log loses a row that duplicated `agent_result.verdict`.
10. **A unit test may import the adapter module**; no test calls the SDK outside the env-gated live tests. Verified side-effect-free on 0.3.283. Cost if wrong: a future SDK with import-time effects breaks the suite loudly.
11. **The barrel's re-export of the adapter stays**; a subpath export is Plan F's packaging decision, under the condition above. Cost if wrong: the same.
12. **A loop body with a schema is refused at load time** (accepting the whole-branch reviewer's dispute of the earlier doc-comment-only ruling). Cost if wrong: a verdict-driven loop needs `untilVerdict` before it can exist.
13. **The duplicated `StructuredOutput` literal in the unit test stays** (accepting the reviewer's dispute of the Task 6 Minor). Cost if wrong: two lines to change on a rename instead of one.
14. **The fix wave was one dispatch of three commits** covering every Important and the fix-before-merge Minors; everything marked defer stayed deferred. Cost if wrong: one wave a single scoped re-review had to cover.
15. **The agent executor's timeout wording changed to match the script executor's** (`timeout after Nms`, `idle timeout after Nms`), because the script executor is already on `main`. Cost if wrong: none.
16. **The negative allowlist live test was re-specified** to assert what the design can show (no tool call outside the allowlist, a `pass: false` verdict) rather than a permission denial that the design makes structurally impossible. Cost if wrong: none; the denial fields are still recorded.
17. **The draft check became an allowlist** (a `$schema`, if present, must name draft-07) rather than a denylist of two newer drafts. Cost if wrong: a schema naming draft-07 by an unusual URL is refused before the SDK sees it, loudly.

# The Usage Limit Implementation Plan (Plan I)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the writer's Claude session hits a plan usage limit mid-step, the engine says so in the operator's words, names the reset time, and either waits for the reset and retries on its own or stops and says why a manual resume is needed — instead of reporting `exhausted 3 iterations without sentinel REVISIONS_COMPLETE`.

**Architecture:** The Agent SDK already carries the signals the engine ignored: an assistant message that ends a turn because of a limit carries `error: 'rate_limit'` (one of thirteen `SDKAssistantMessageError` kinds); the stream carries `rate_limit_event` messages whose `rate_limit_info` names the window (`five_hour`, `seven_day`, a per-model seven-day), its utilization and its reset time; and the query object's usage call answers both windows' utilization as percentages. The engine's one SDK touchpoint, `engine/src/sdk-query.ts`, maps these onto `AgentMessage`; the agent executor in `engine/src/agent-step.ts` classifies a limited query as a failure of a new kind carrying the window, the reset time and the weekly utilization; and it applies Ryan's rule there, before the three callers in `engine/src/runner.ts` ever see the outcome: **a five-hour limit with the weekly quota under the ceiling waits for the reset (the worker sleeps, its lock's heartbeat running) and retries the same query once; anything else fails with a sentence that says what to do.** The ceiling is a show-config key with a default. The console learns one new event, `step_waiting`, and draws the wait on the Board, the Run view, the title and What-happened.

**Tech Stack:** TypeScript 5 (strict, ESM, NodeNext), vitest 4; `@anthropic-ai/claude-agent-sdk` 0.3.283 (its `rate_limit_event`, `SDKAssistantMessage.error`, and the usage call that is marked experimental — wrapped in a try, its absence means "weekly utilization unknown"); Hono 4, React 18 for the console.

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` — §4.2 (the worker owns the run; the server owns none), §6.5–§6.9 (the log is the record; every state is derived from it). Ryan's ruling of 2026-10-15 is the rule this plan implements: **retry automatically when the 5-hour limit was reached and the 7-day quota is below 65% used; otherwise wait for the operator's Resume and say why.**

## What was measured (the s02e01 run of 2026-10-14, `Production/s02e01/runs/20261014T183337Z-8r5w.jsonl` in the live instance)

- The revise loop's iteration 1 ran 447 s and 48 tool calls; its `agent_result` was `ok: true, subtype: "success"` with `text: "You've hit your session limit · resets 7:50pm (America/New_York)"`. Iterations 2 and 3 resumed the session, made 0 tool calls, and returned the same text in 352 ms and 328 ms. The loop failed five seconds after the limit hit with `exhausted 3 iterations without sentinel REVISIONS_COMPLETE`.
- `engine/src/agent-step.ts:290-372`: the message loop reads `type`, `session_id`, assistant `content` (tool calls) and the `result` message; the outcome is `ok: true` when `r.subtype === "success"`. No field of an assistant message other than `content` is read. `AgentMessage` (`:14-26`) has no `error` field.
- `engine/src/sdk-query.ts:7-36`: `toAgentMessage` copies `subtype`, `session_id`, assistant content, and the result's `num_turns`, `duration_ms`, `total_cost_usd`, `permission_denials`, `result`, `structured_output`, `errors`. A `rate_limit_event` message is yielded with only `type` set.
- `engine/src/runner.ts`: three callers of `executors.agent` — `runAgentStep` (`:452`), the gate's fix agent (`:521`), the loop body (`:620`). Each already fails the step on `!r.ok` with `r.error`; the loop fails fast on a failed iteration (`:621-625`) and otherwise counts the iteration (`:626-627`).
- `engine/src/show-config.ts:55-...`: `SHOW_CONFIG_KEYS` rows are `{ path, requiredBy: "engine" | "scripts" | "both" | "none", readBy }`; `ShowConfig.models` is the group the agent executor reads (`:19`, `:233-236`); no `agents` group exists.
- The console: `deriveRunStatus` (`console/server/runs.ts:252-260`) answers `running` whenever the lock is alive, so a sleeping worker's run reads as running; the step projection handles `step_started`, `step_completed`, `step_cached`, `step_failed`, `step_skipped`, `step_reset`, `gate_opened`, `gate_answered` (`:167-199`); step status strings are `pending | running | completed | failed | skipped | waiting | bypassed` (`console/shared/types.ts:144-146`); the title forms are at `console/src/projections.ts:219-225`; the worker's heartbeat is every 5 s (`console/worker/lock.ts:155`).
- The SDK (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`): `SDKAssistantMessage.error?: SDKAssistantMessageError` (`:3609`, kinds at `:3683`); `SDKRateLimitEvent { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' | 'allowed_warning' | 'rejected', resetsAt?: number, rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage', utilization?: number, ... } }`; the query object's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` returns `{ rate_limits_available, rate_limits: { five_hour?: { utilization, resets_at }, seven_day?: { utilization, resets_at } } }`.

## Rulings (Ryan, 2026-10-15, and the plan's own)

| Question | Ruling |
|---|---|
| When to retry on our own | **The window hit is `five_hour` and the 7-day utilization is known and below the ceiling.** Everything else — a seven-day window (any of the three), `overage`, an unknown weekly figure, a second limit after one wait, or any other SDK error kind — fails the step with a sentence naming the reason and the move. |
| The ceiling | **A show-config key, `agents.autoRetryWeeklyUtilizationMax`, default 65**, an integer 0–100, validated at load; `requiredBy: "none"`. |
| Where the wait happens | **In the worker, inside the agent executor:** the step emits `step_waiting`, the executor sleeps until the reset time plus one minute (an injectable clock and sleeper for the tests), then re-runs the same query in the same session, once. The lock's heartbeat keeps the run `running` on the Board; the server owns nothing (§4.2). |
| What a loop does with a waited iteration | **It is not counted.** The executor's retry returns one outcome for the iteration; the loop sees one `agent_result` per iteration as today. A limit that trips again after the wait fails the iteration, and the loop fails fast as it already does. |
| The message when manual resume is needed | One sentence, operator-facing, with the numbers: `Manual resume needed: the writer's session hit its 5-hour limit (resets 7:50pm America/New_York) and the weekly quota is at 78%, above the 65% auto-retry ceiling (agents.autoRetryWeeklyUtilizationMax).` / `… hit its 7-day limit (resets Mon 9:00am America/New_York); press Resume after the reset.` / `… and the weekly utilization is unknown.` Times rendered in the reset's zone when the SDK gives one, else as ISO. |
| The other twelve error kinds | `billing_error`, `authentication_failed`, `account_on_hold`, `verification_required`, `oauth_org_not_allowed`, `cloud_credential_error`, `overloaded`, `server_error`, `invalid_request`, `model_not_found`, `max_output_tokens`, `unknown`: the step fails with `the model's reply was refused (<kind>): <the SDK's text>`; no wait, no retry. |
| The console's display | `step_waiting` → the step's status `waiting` with a `note`; the Board's row prints the note under the stage chip; the Run view's in-flight line says it; the tab title gains the form `⏳ <id> WAITING · resets <time> — <show> · <key>`, ranked below `NEEDS YOU` and above the working form (it is a job the console is doing for the operator, not a question); What-happened lists the event with its payload. |

## Global Constraints

- **One repository, one branch.** All work is on branch `plan-i` in `~/GitHub/Showrunner` (cut from `main`). The live instance `~/GitHub/DeadLight2` and the retired repository `~/GitHub/DeadLight` are never written; the console running on port 4410 (pid 26743, started 2026-10-14 from `console/dist/`) is not stopped or rebuilt over by any task — tasks run tests, not `npm run build` in `console/`, until the controller says the server is restarted.
- **No show's name in the engine** (spec §7.4): after every task, `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ scripts/ render/ tools/ console/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=public` prints nothing. Fixtures use "Harbor Lights" (Vale, the Warden, Pim, Maeve; Harbor).
- **The log is the record** (spec §6.5): the wait is an event (`step_waiting`) with its reason in the payload; the console derives everything from it; no state lives in memory only.
- **`exactOptionalPropertyTypes` respected; every exported symbol carries a doc comment that says why; the SDK's experimental usage call is wrapped so its absence or change cannot fail a query.**
- **Every commit ends with this trailer line in its final paragraph** (use `git commit -F -` with a heredoc): `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Gates: `cd engine && npx vitest run && npm run typecheck`; `npm run build -w engine && npm run build -w tools` from the root; `cd tools && npx vitest run && npm run typecheck`; `cd console && npx vitest run && npm run typecheck` (the console build is run once by the controller before the pull request, not per task — see the first constraint); `cd scripts && uv run pytest -q`; `npm audit --json` total 0. All clean before every commit that touches them; report the numbers printed, never a prediction.

---

### Task 1: Engine — the wrapper carries the limit signals, the executor classifies and applies the rule, the config carries the ceiling

**Files:**
- Modify: `engine/src/sdk-query.ts` (map `rate_limit_event` and the assistant `error`; the usage call on a rejected limit), `engine/src/agent-step.ts` (`AgentMessage` gains the fields; the executor's outcome and the wait), `engine/src/show-config.ts` (`agents.autoRetryWeeklyUtilizationMax`), `engine/src/events.ts` (the `step_waiting` kind), `engine/src/runner.ts` only if `deriveRunState` must learn the kind (an in-flight step stays in flight), `README.md` (the config table row; one paragraph under the agent step's contract on what a limit does).
- Test: `engine/test/sdk-query.test.ts`, `engine/test/agent-step.test.ts`, `engine/test/show-config.test.ts`, `engine/test/runner.test.ts` or `episode-pipeline.test.ts` (a loop whose body is limited once).

**Interfaces:**
```ts
// agent-step.ts — AgentMessage gains:
error?: string;                                   // SDKAssistantMessage.error, verbatim
rateLimit?: { status: "allowed" | "allowed_warning" | "rejected"; window?: string; resetsAt?: string; utilization?: number };  // from rate_limit_event (resetsAt as ISO)
usage?: { available: boolean; fiveHour?: { utilization: number | null; resetsAt: string | null }; sevenDay?: { utilization: number | null; resetsAt: string | null } };  // one synthetic message the wrapper yields after a rejected limit
// AgentOutcome (failure) gains:
limit?: { kind: "rate_limit"; window: string; resetsAt?: string; weeklyUtilization?: number; waited: boolean } | { kind: string };  // the classification, for agent_result and the tests
// AgentExecutorDeps gains (injectable; production passes none):
now?: () => Date; sleepUntil?: (iso: string) => Promise<void>;
// show-config.ts
agents?: { autoRetryWeeklyUtilizationMax: number }   // on ShowConfig; default 65 when the group or key is absent; refused outside 0–100 or non-integer
// events.ts
"step_waiting"  // payload { reason: string; window: string; resetsAt: string; weeklyUtilization?: number; ceiling: number }
```

- [ ] **Step 1: Failing tests.** `sdk-query.test.ts`: a `rate_limit_event` with `status: "rejected", rateLimitType: "five_hour", resetsAt: <epoch seconds>, utilization: 100` maps to `rateLimit: { status: "rejected", window: "five_hour", resetsAt: <ISO>, utilization: 100 }`; an assistant message with `error: "rate_limit"` maps to `error: "rate_limit"`; the usage response maps to `usage`. `agent-step.test.ts` with the fake query: (a) a stream with a rejected five-hour event, an assistant `error: "rate_limit"` whose text is the SDK's sentence, a usage message with `sevenDay.utilization: 41`, then a result — the executor emits `step_waiting` with `reason` beginning `waiting for the usage limit to reset at`, calls `sleepUntil` with the reset ISO plus one minute, re-queries once (the fake query's second stream ends with the sentinel text), and returns `ok: true`; the `agent_result` carries `limit.waited: true`; (b) the same with `sevenDay.utilization: 78` → `ok: false`, `error` exactly `Manual resume needed: the writer's session hit its 5-hour limit (resets <time>) and the weekly quota is at 78%, above the 65% auto-retry ceiling (agents.autoRetryWeeklyUtilizationMax).`, no sleep; (c) window `seven_day` → `ok: false` with the 7-day sentence, no sleep; (d) usage unavailable → `ok: false` with `… and the weekly utilization is unknown.`; (e) a second rejected limit after the wait → `ok: false` with the sentence and `waited: true`; (f) `error: "billing_error"` → `ok: false`, `error` `the model's reply was refused (billing_error): <text>`. `show-config.test.ts`: the key absent loads as 65; `agents: { autoRetryWeeklyUtilizationMax: 40 }` loads 40; `101`, `-1`, `"65"` and `65.5` are refused naming the key. The loop test: a loop body limited once under the ceiling completes in one counted iteration (one `loop_iteration` event) with a `step_waiting` before it.
- [ ] **Step 2: Implement.** `sdk-query.ts`: map the two message types; on a rejected `rate_limit_event` call the query object's usage method inside a try and yield one synthetic `usage` message (`available: false` when it throws or when `rate_limits_available` is false). `agent-step.ts`: the message loop records the last `rateLimit`, the last `usage`, and the first assistant `error` with its text; after the stream, classify before the subtype switch — a `rate_limit` error (or a rejected event) makes the outcome a failure with `limit`; apply the rule: window `five_hour` and `usage.sevenDay.utilization` a number below the ceiling → emit `step_waiting`, `await sleepUntil(reset + 60 s)`, run the query again with the same session (the resume path), and return that attempt's outcome with `limit.waited = true` (a second limit fails with the manual sentence). The sentence formats the reset in the zone the SDK's text names when present (`(America/New_York)`), else ISO. `show-config.ts`: the group, the row (`readBy: engine/src/agent-step.ts`), the validation. `events.ts`: the kind; `deriveRunState` treats `step_waiting` like `step_started` for in-flight purposes.
- [ ] **Step 3: Gates;** commit `engine: a usage limit is named, and a five-hour limit under the weekly ceiling is waited out and retried`.

### Task 2: Console — the wait is drawn

**Files:**
- Modify: `console/server/runs.ts` (the step projection learns `step_waiting`: status `waiting`, `note` = the payload's reason; `SetupRunView`'s projection the same), `console/shared/types.ts` (`StepRow.note?: string`; the doc comment on the status vocabulary), `console/src/projections.ts` (`titleFor` gains the `⏳ <id> WAITING · resets <time>` form between `NEEDS YOU` and the working form; a pure `waitingNote(row)` for the Board), `console/src/pages/Board.tsx` (the note under the stage chip), `console/src/pages/Run.tsx` (the in-flight line), `console/server/what-happened.ts` only if the event needs a label, `console/README.md` (the step-status table and the title forms).
- Test: `console/test/runs.test.ts` (a log with `step_waiting` projects `waiting` with the note and the run reads `running` while the lock is alive), `console/test/client/projections.test.ts` and `doc-title.test.ts` (the new title form and its rank), `console/test/client/*.test.tsx` only if a render is the cheapest proof.

**Interfaces:** consumes Task 1's `step_waiting` payload; produces `StepRow.note` and the title form.

- [ ] **Step 1: Failing tests** as listed.
- [ ] **Step 2: Implement.** The step row carries the note; the Board prints it; the Run view's in-flight line reads `waiting for the usage limit to reset at 7:50pm (weekly quota 41%)`; the title form ranks below `NEEDS YOU` and above `●`; a read-only show's title still falls to the idle form (Plan H's rule).
- [ ] **Step 3: Gates;** commit `console: a run waiting out a usage limit says so on the Board, the Run view and the tab`.

### Task 3: The record

**Files:** modify `README.md` (the "Recovery" or agent-step section: what the operator sees for each of the three outcomes — waited, manual resume, refused), `console/README.md` (one row in "Recovery": a run waiting on a limit needs nothing; a failed one says why), `docs/plans/2026-10-15-the-usage-limit-deferred.md` (what was deferred: a limit during a script step's child process; the SDK's experimental usage call; provoking a real limit in a test is impossible, so the proof is the fake stream).

- [ ] **Step 1:** The three documents.
- [ ] **Step 2: Gates;** commit `docs: what a usage limit does to a run, and what it costs the operator`.

## Self-review (run by the plan's author before execution)

1. **Spec coverage.** §4.2 → the wait is the worker's, the server learns of it only through the log; §6.5 → `step_waiting` is an event with its reason; Ryan's rule → the executor's branch with the ceiling from config.
2. **Placeholder scan.** The sentences are written out; the test cases are enumerated with their expected strings; the SDK fields are named from `sdk.d.ts` with line numbers.
3. **Type consistency.** `AgentMessage.rateLimit/usage/error` (Task 1) consumed by the executor (Task 1); `step_waiting`'s payload (Task 1) read by the projection (Task 2); `StepRow.note` (Task 2) read by the Board and the Run view (Task 2).

## Execution handoff

Plan complete and saved to `docs/plans/2026-10-15-the-usage-limit.md`. Execute with superpowers:subagent-driven-development: a fresh implementer per task, the three-question quiz before each, a task review after each (reviewers on Sonnet, implementers and the whole-branch reviewer on Opus), one fix wave after the whole-branch review, and the deferred record last. The console on port 4410 keeps running throughout; the controller rebuilds and restarts it only after the pull request is merged.

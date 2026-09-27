# Showrunner

**It takes an episode premise and a story bible, and makes a finished, publishable episode and a
bible that has absorbed what the episode established — with the showrunner ruling at every gate.**
(`docs/specs/2026-09-25-console-rewrite-design.md` §0.)

This repository is the product. A show is a separate repository the engine operates on by path:
the show owns its bible, its `prompts/`, and its `Production/` tree, and nothing in `engine/`
knows which show it is running.

## The three layers

The rewrite design §4.6 splits the system into three layers. `engine/` is the first of them; the
other two are named here so it is clear what the engine deliberately does not contain.

| Layer | Language | Contains | Calls a model? |
|---|---|---|---|
| Orchestrator | TypeScript | The step DAG, the gates, the stage state machine, the event log and everything derived from it | No |
| Agent steps | TypeScript, via the Claude Agent SDK | One query per step, with a per-step model, tool allowlist and context policy; the prompts come from the show repository | Yes |
| Deterministic steps | Python, unchanged in content | The existing production scripts, invoked as argv arrays — never as shell strings | No |

The orchestrator calls the other two layers through the injected `Executors` interface
(`engine/src/steps.ts`), so the engine can be tested end to end with fakes. Each executor owes
the log a fixed set of events; those obligations are documented on the interface.

## The event log

**The event log is the source of truth, and everything else is derived from it** (design §6.5).
One append-only JSONL file per run, at `Production/<episodeId>/runs/<runId>.jsonl` under the show
root. Both ids are validated before they become that path. Every event carries `ts`, `runId`, an
optional `stepId`, a `kind`, and a `payload`; the engine stamps `ts` itself, so a caller cannot
backdate an entry.

There are exactly sixteen kinds. The engine core writes thirteen of them; the three `agent_*`
kinds are the agent executor's obligation.

| Kind | `stepId` | Payload the engine writes |
|---|---|---|
| `run_started` | no | `pipeline`, `episodeId`, and `trigger` when the caller supplied one |
| `run_finished` | no | `status`: `"completed"` or `"failed"` |
| `step_started` | yes | `kind`; a script adds `argv` and `inputHashes`; an agent adds `inputHashes`; a loop adds `body`, `until`, `max`; a gate's fix agent adds `rejectionOf` and `attempt` |
| `step_completed` | yes | a guard writes `result`; a script writes `inputHashes` and `outputHashes`; an agent writes those two plus `result` and `toolCalls`; a loop writes `result` and `iterations`; a gate's fix agent writes `result` and `toolCalls` |
| `step_failed` | yes | `error` |
| `step_skipped` | yes | `reason` — `"dependency failed: <id>"`, `"dependency skipped: <id>"`, or `"when: false"` |
| `step_cached` | yes | `inputHashes`, `outputHashes`, and `result` when the cached completion recorded one |
| `step_progress` | yes | `done`, `total`, `unit`, and an optional `message` |
| `script_line` | yes | `stream` (`"stdout"` or `"stderr"`) and `line` |
| `agent_query` | yes | the prompt file, model, allowlist and context policy the query ran with — written by the agent executor |
| `agent_tool_call` | yes | the tool invoked and its arguments — written by the agent executor |
| `agent_result` | yes | the verdict JSON if the step has a schema, the final text otherwise — written by the agent executor |
| `loop_iteration` | yes | `iteration`, `max`, `sentinel`, `toolCalls`, and `error` on a failed iteration |
| `gate_opened` | yes | `attempt` and the `message` shown verbatim |
| `gate_answered` | yes | `approved`, `attempt`, `waitedMs`, and `notes` and `by` when given |
| `input_changed` | yes | `before` and `after`, the declared inputs' hashes on either side of the change |

`inputHashes` and `outputHashes` map each declared path, relative to the show root, to its SHA-256
or to `null` when the file does not exist.

## Step kinds

Every step has an `id`, an optional `dependsOn` list, optional `inputs` and `outputs` (paths
relative to the show root), an optional `timeoutMs`, and an optional `when` condition. An id may
not contain `:`, because the runner reserves `<id>:rejection` and `<id>:iteration` as result keys.

| Kind | Fields beyond the common ones |
|---|---|
| `guard` | `check(ctx)` returning `{pass: true, message?}` or `{pass: false, message}` |
| `script` | `argv(ctx)` returning an argv array, optional `env(ctx)` and `cwd` |
| `agent` | `promptFile`, `model`, `allowedTools`, `context` (`"fresh"` or `"shared"`), optional `schema`, `maxTurns`, `idleTimeoutMs`, `maxBudgetUsd` |
| `gate` | `message(ctx)`, optional `onReject` agent, `maxAttempts` (default 10) |
| `loop` | `body` agent, `until` sentinel, `maxIterations`, optional `progress(ctx)` |

The two nested steps are attributed in opposite ways. A gate's `onReject` agent **is** a step of
its own: its events are logged under its own id, and its id shares the pipeline's id namespace.
A loop's `body` is **not** a step of its own: its events are logged under the loop's id, so the
loop stays one step in the run's history however many times the body runs. **A loop body may not
carry a schema**, and `orderSteps` refuses the pipeline at load time when one does: the loop ends
on `until` appearing in the body's final text, and a body with a schema has no prose final text —
its text is the serialized verdict, so the sentinel would be matched against substrings of JSON.

## Agent steps

An agent step is **one Agent SDK query**: a prompt file, a model, a tool allowlist, a context
policy, and an optional JSON schema go in, and a verdict or a final text comes out. The executor is
built once, with the SDK's `query` injected, and handed to the runner as `executors.agent`:

```ts
import { createAgentExecutor, sdkQuery } from "@showrunner/engine";

const agent = createAgentExecutor({ query: sdkQuery, promptsDir, models });
```

`query` is a seam, not a convenience: production passes `sdkQuery` and the tests pass a fake, so
`engine/src/sdk-query.ts` is the only **source** file in the engine that imports
`@anthropic-ai/claude-agent-sdk`. One test names the package as well — `engine/test/sdk-query.test.ts`
uses `import type` for the SDK's own message types, which TypeScript erases, so it adds no runtime
import of its own. **The suite never touches the network unless `SHOWRUNNER_LIVE` is set**: loading
the SDK module spawns nothing, and calling `query()` is what every test but the live one avoids.

`promptsDir` is optional and defaults, per call, to `<showRoot>/prompts`. `models` is an alias map
(`{ medium: "claude-sonnet-5" }`); a model the map does not name is passed to the SDK unchanged.

### The prompt file

A step names its prompt by a path relative to the show's prompts directory. The file is read, hashed
with SHA-256 — the hash is what `agent_query` records, so "the prompt as it was" can be answered
later — and rendered. A path that escapes the prompts directory is refused before anything is logged
or queried.

| Written in the prompt | Renders as |
|---|---|
| `{{episodeId}}` | the run's episode id |
| `{{runId}}` | the run id |
| `{{showRoot}}` | the absolute path of the show root |
| `{{results.<stepId>}}` | that step's result: a string as itself, a number or boolean stringified, an object as pretty-printed JSON |
| `{{results.<stepId>.<field>}}` | a field of that step's result object, at any depth (`{{results.review.notes.tone}}`) |

**Every hole is an error.** An unknown variable, a step with no result, a path through a non-object,
a missing key, a null value, or a value `JSON.stringify` cannot represent throws `TemplateError`
naming the variable as written — `{{results.missing}}: no result for step "missing"` — and the step
fails before the query is made. A `{{` or `}}` still in the text after substitution is refused too,
by a different message that quotes the text rather than a variable, because there is no
well-formed variable to name: `unbalanced or malformed template braces near: <40 characters>`.
A prompt with a hole in it lies to the model quietly, which is the failure this refuses to ship.

### What the query runs with

| Option | Value | Why |
|---|---|---|
| `cwd` | the show root | File tools are scoped to the show, never to the engine checkout |
| `permissionMode` | `"dontAsk"` | Nothing outside the allowlist is approved; `bypassPermissions` appears nowhere in `engine/` |
| `tools` / `allowedTools` | the step's `allowedTools` | `tools` decides what is in context, `allowedTools` auto-approves it; `mcp__`-prefixed names go only to `allowedTools` |
| `settingSources` | `[]` | No user, project or local settings on the host machine leak into a step |
| `systemPrompt` | `{ type: "preset", preset: "claude_code" }` | Omitting it would give a minimal prompt rather than Claude Code's |
| `outputFormat` | `{ type: "json_schema", schema }` when the step has one | The SDK validates the verdict against **JSON Schema draft-07** and re-prompts on mismatch. The executor checks the schema before the query: a `$schema` key, if present, must name draft-07, and anything else — a newer draft, an older one, a draft this code has never heard of — is refused. A schema with no `$schema` key is accepted, draft-07 being the SDK's default. |
| `abortController` | one per query | How a timeout stops the query |

### The three events

The executor owes the log exactly these three, and the runner writes `step_started`,
`step_completed` and `step_failed` around them.

| Kind | Payload |
|---|---|
| `agent_query` | `promptFile`, `promptHash`, `promptPath`, `model`, `modelAlias`, `allowedTools`, `context`, `schema` (whether the step has one), `resumed` (whether this query resumed a session) — one per query |
| `agent_tool_call` | `tool`, `input`, `toolUseId`, `index` (1-based, in stream order) — one per tool invocation |
| `agent_result` | `ok`, `toolCalls`, `permissionDenials`, `deniedTools`, and, when the query produced them, `subtype`, `numTurns`, `durationMs`, `costUsd`, `sessionId`; then `verdict` for a schema step that succeeded, `text` for a schemaless one, and `error` when it failed |

`toolCalls` is the count of **real tool invocations** the agent made, and a loop's per-iteration
count is reported on `loop_iteration` (design §6.7: an iteration with zero tool calls did nothing).
The SDK delivers a schema verdict through a synthetic tool call named `StructuredOutput`, which
`engine/src/sdk-query.ts` drops before the executor sees it, so that call is neither logged as an
`agent_tool_call` nor counted — the verdict itself arrives on the result message. **The drop is by
name and unconditional**: the adapter matches the string `StructuredOutput` on every step, schema
or not, so a real tool that happened to carry that name would be dropped too, invisibly.

`costUsd` is the SDK's **client-side estimate**, not billing data. Authoritative figures come from
the Usage and Cost API.

`sessionId` is the pointer to the full conversation: the transcript lives at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` on the machine that ran the step, and is not
copied into the show repository.

**An executor may throw only when the event log itself is unwritable.** The script executor never
throws: every rejected `emit` becomes `{ ok: false, error: "log write failed: …" }`. The agent
executor guards the `agent_tool_call` emit the same way, but its `agent_query` and `agent_result`
emits are unguarded and reject out of the executor. A throw leaves the step `running` with no
terminal event, and design §6.9's replay re-executes that step on the next run.

### The outcome

A step succeeds as `{ ok: true, text, toolCalls }`, with `verdict` carrying the parsed object when
the step declared a schema. It fails as `{ ok: false, error }`. **A success with no structured
output is a failure** for a step with a schema: the SDK can end `subtype: "success"` without one,
and a missing verdict is never treated as an empty one.

**A returned verdict must not be mutated.** The runner stores it by reference as
`ctx.results[stepId]` and emits the same object into the log, so a later edit to it would change
both what a downstream prompt renders and what the log claims the step decided.

### The bounds, and what each failure says

A session never times out on its own, so the executor imposes the clocks itself and does not rely on
the SDK's iterator honouring the abort.

| Bound | Effect | The error |
|---|---|---|
| `timeoutMs` | Wall clock for the whole query | `timeout after <n>ms` — the same wording the script executor uses for the same fault |
| `idleTimeoutMs` | Wall clock reset on every message from the SDK | `idle timeout after <n>ms` |
| `maxTurns` | The SDK stops after that many agentic turns | `error_max_turns`, plus `: <errors>` when the result carried any |
| `maxBudgetUsd` | The SDK stops when its cost estimate reaches the cap | `error_max_budget_usd`, plus `: <errors>` when the result carried any |

The SDK's result message carries one of exactly four error subtypes, and each becomes the step's
error verbatim, with `: <errors>` appended when the result carried any: `error_max_turns`,
`error_during_execution`, `error_max_budget_usd`, and `error_max_structured_output_retries` — the
last being the schema-retry failure, raised when the model's verdict failed validation often enough
that the SDK stopped re-prompting.

Other failures are worded so the log says which layer broke: `query failed: <msg>` when the SDK
threw and no result had arrived, `log write failed: <msg>` when `emit` rejected, `message handling
failed: <msg>` when the executor's own handler threw, `query ended without a result message`,
`result message with no subtype`, `success without structured output`, and `schema must be JSON
Schema draft-07, got <declared>`.

A deadline, a rejected `emit` or a handler fault **outranks** a result that raced in, so a timeout
wins over a result that arrived after it. The result message is still kept, not discarded: when one
arrived before the clock was observed, `agent_result` reports its `subtype`, `numTurns`,
`durationMs`, `costUsd` and `sessionId` alongside `ok: false` and the failure, which is the only
record of what the query had spent when it was cut off.

### The context policy

`context: "fresh"` starts a new SDK session for every query. `context: "shared"` resumes: within one
run, the second and later queries of the same step continue the session the first opened, which is
how a loop body keeps its conversation across iterations. Sessions are held in memory by the
executor, keyed on `<episodeId>/<runId>/<stepId>`.

**The session map belongs to the executor, not to the run.** A restart of the engine *process*
discards it, because the next process builds a new executor with an empty map; a second `run()`
inside the same process keeps it. Keeping it changes nothing across runs in practice, since the key
carries the run id and a new run's keys therefore miss — but an executor that outlives several
episodes is exactly why the key carries the episode id too. Either way, the first query of a shared
step after a restart is fresh, and its `agent_query` records `resumed: false`, which is the log's
record of the discontinuity.

### The live test

`engine/test/agent-live.test.ts` runs a real query — the only test that does. It reads a file with
only `Read` allowed and checks the schema-validated verdict, the event order, and that nothing but
`Read` was invoked. It is skipped unless `SHOWRUNNER_LIVE` is set, because it costs a few cents and
needs credentials on the machine (`ANTHROPIC_API_KEY`, or the machine's Claude Code login):

    cd engine && SHOWRUNNER_LIVE=1 npx vitest run test/agent-live.test.ts

## Status vocabulary

A step's status is derived from the log, never stamped by hand.

| Status | Meaning | Do its dependents run? |
|---|---|---|
| `pending` | No event for it yet | — |
| `running` | A `step_started` with no terminal event | — |
| `waiting` | A gate is open on it | — |
| `completed` | `step_completed`, `step_cached`, or an approved `gate_answered` | Yes |
| `bypassed` | `step_skipped` with the reason `"when: false"` — its own condition turned it off | **Yes** |
| `skipped` | `step_skipped` for any other reason — a dependency failed or was skipped | No |
| `failed` | `step_failed` | No |

`bypassed` and `skipped` share one event kind and mean opposite things downstream, which is why
the reason string is load-bearing and lives as the exported constant `BYPASS_REASON`.

The twenty-one stages (`NEEDS_IDEA` through `COMPLETE`) are derived on top of the statuses by
`deriveStage` in `engine/src/stages.ts`.

## The progress contract

A script reports progress by printing one structured line to stdout per unit of work:

    ::progress {"done":47,"total":212,"unit":"segments"}

The script executor parses those lines into `step_progress` events and forwards every other line
as `script_line`; a progress line is never also logged as a `script_line`. A loop reports progress
through its optional `progress(ctx)` hook, called after each iteration, whose result is emitted as
`step_progress`. Design §6.7 asks that an agent's progress be derived from disk rather than
self-reported — counting what was actually written against what was planned — because a derived
number cannot be wrong about what is on disk. The hook receives the iteration context, so it can
read `<body-id>:iteration`.

## The resume contract

A run restarts by replaying its log; there is no separate state file to reconcile.

- **Any step whose status is not terminal is re-executed.** The re-execution is logged as a new
  `step_started` following the orphaned one, so the interruption stays visible in the history
  rather than being erased.
- **A loop resumes its iteration counter.** The `loop_iteration` events logged since the loop's
  most recent `step_started` are counted, and the loop continues from that count plus one. The
  cap therefore counts the crashed attempt's work rather than starting over.
- **A completed fix agent is not re-run.** When the log shows a `step_completed` for a gate's
  `onReject` agent after the gate's last answer, the gate reopens at the next attempt without
  running the agent again.
- **A concurrent run on the same log is rejected.** The read-derive-append cycle is not atomic,
  so a second `run()` against a log already in flight rejects with "run already in progress".
- **A crash mid-script re-runs the script, and idempotency is delegated to the script.** The
  engine makes no attempt to resume a script partway; the scripts already skip outputs that
  exist.
- **A cached success is keyed on declared inputs.** A script step with declared `inputs` is served
  from a prior run's hashes only when both its inputs and its outputs are unchanged on disk. A
  changed input is recorded as `input_changed`; a changed output simply re-runs the step.
- **A run with an open gate resumes waiting at that gate**, and answering it requires the log's
  own run id.

## Develop

    npm install
    cd engine && npx vitest run     # the full suite
    cd engine && npm run typecheck  # tsc over src/, then over test/

`npm test` and `npm run typecheck` at the repository root run the same two commands through the
workspace.

## Documents

- `docs/specs/2026-09-25-console-rewrite-design.md` — the requirements this engine is built to.
- `docs/specs/2026-09-25-pipeline-process-map.md` — the system being replaced.
- `docs/plans/2026-09-26-engine-core.md` — the build plan for `engine/`.

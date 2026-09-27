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
| `agent` | `promptFile`, `model`, `allowedTools`, `context` (`"fresh"` or `"shared"`), optional `schema` |
| `gate` | `message(ctx)`, optional `onReject` agent, `maxAttempts` (default 10) |
| `loop` | `body` agent, `until` sentinel, `maxIterations`, optional `progress(ctx)` |

The two nested steps are attributed in opposite ways. A gate's `onReject` agent **is** a step of
its own: its events are logged under its own id, and its id shares the pipeline's id namespace.
A loop's `body` is **not** a step of its own: its events are logged under the loop's id, so the
loop stays one step in the run's history however many times the body runs.

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

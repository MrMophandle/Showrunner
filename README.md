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

**`console/` is the operating layer over all three, and it is three processes rather than one.**
The split is the rewrite design §4.2's structural detachment: the process that answers the browser
is never the process that runs an episode, so restarting the console cannot stop a render.

| Process | Entry point | Owns |
|---|---|---|
| The console server | `console/dist/server/main.js` | The HTTP surface and one store watching the show's run logs. It reads logs and spawns workers; it owns **no run** |
| The worker | `console/dist/worker/main.js` | One run segment: it takes the run's lock, calls `run()` once, and releases the lock. Spawned detached, in its own process group |
| The client | `console/dist/client/` | The browser bundle the server serves as static files, holding nothing the server did not hand it |

## The show config

**A show identifies itself in one file: `showrunner.json` at the show repository's root.** The
engine reads it with `loadShowConfig(showRoot)` (`engine/src/show-config.ts`) and the Python steps
read the same file with `sc.load(root)` (`scripts/lib/showconfig.py`). Both loaders require the
same eight keys and apply the same `airMap` rules; `engine/src/show-config.ts` is the reference and
`scripts/lib/showconfig.py` mirrors it. Each loader's source names the other as the place the set
is mirrored, because nothing checks the two against each other at build time.

**Eight keys are required**, and a config short of one is refused by name rather than failing later
at whatever wanted it: `showName`, `showSlug`, `promptsDir`, `models.medium`, `models.large`,
`models.writer`, `airMap`, and `output.nasRoot`. Every other key is optional; a script that reads
one and does not find it fails naming its dotted path.

| Group | Keys | Who reads it |
|---|---|---|
| Identity | `showName` and `showSlug` — the display name and the filename form | the scripts, for prose and for output filenames |
| Layout | `promptsDir`, plus the optional `canonDir`, `episodesDir`, `productionDir` | the engine reads `promptsDir`; the scripts read the other three |
| `models` | `medium`, `large`, `writer`, plus the optional `small` | the engine, as the agent executor's alias map |
| `airMap` | one production id to its `[season, episode]` | the engine, for `{{season}}`; the scripts, through `sc.season_of` |
| `output` | `nasRoot`, plus the optional `nasMount`, `finalFilename`, `mixFilename`, `videoFilename` | the scripts that master, finalize and publish an episode |
| `audio` | sample rate, loudness targets, room tone, the gap lengths, the cast list, the voice registry | the TTS, mix and audio-QC scripts |
| `visual` | the reference files, the style constants, the frame size, the casting directories, the populator bans | the image scripts |
| `video` | `fps`, `crossfadeSeconds`, `compositionId`, and the whole `titleCard` block | `build-timeline.py` copies `fps`, `crossfadeSeconds` and `titleCard` into the timeline the renderer reads. **It does not write `compositionId`**: the composition id is passed on the render command line, because the id selects the composition whose `calculateMetadata` goes on to fetch the timeline and so has to be known first |
| `publish` | the channel's standing answers — channel name, playlist, tags, category, standing copy, guide | `publish-kit.py` |

The engine reads three of those groups and no others: `promptsDir`, `models` and `airMap`. The
scripts read the rest.

**A path in the config is relative to the show root unless it is absolute.** The engine resolves
one with `resolveShowPath` and a script with `sc.path(cfg, …, root=root)`; both test the string for
an absolute path first and join it to the show root otherwise.

The config feeds two of the template variables listed under **Agent steps → The prompt file**
below.

- **`{{season}}`** is the episode's numeric season, unpadded, so a prompt writes
  `Canon/season-{{season}}.md`. **An aired id (`sXXeYY`) carries its own season and `airMap` is
  never consulted for one; a production id (`epNN`) is looked up in `airMap`.** `seasonOf` throws
  when the map does not place a production id, and the agent step absorbs that throw rather than
  failing the step: the season is left undefined, so an episode with no air slot still runs every
  prompt that does not write `{{season}}`, and only a prompt that does write it fails, in the
  renderer, with `{{season}}: season is not available`. For the same reason **both loaders refuse an
  aired id as an `airMap` key** — the id already answers the question, so a mapping for one could
  only ever be a second and silently disagreeing answer. `engine/src/show-config.ts` and
  `scripts/lib/showconfig.py` each refuse it naming the key, so the rule holds whichever half of
  the pipeline reads the config first.
- **`{{show.<path>}}`** is a dotted path into the loaded config (`{{show.showName}}`,
  `{{show.video.fps}}`), rendered by the same value rules as `{{results.*}}`. A bare `{{show}}`, a
  path through a non-object, a missing key, and a `{{show.*}}` in an executor built with no show
  config each throw `TemplateError`.

## The event log

**The event log is the source of truth, and everything else is derived from it** (design §6.5).
One append-only JSONL file per run, at `Production/<episodeId>/runs/<runId>.jsonl` under the show
root. Both ids are validated before they become that path. Every event carries `ts`, `runId`, an
optional `stepId`, a `kind`, and a `payload`; the engine stamps `ts` itself, so a caller cannot
backdate an entry.

There are exactly eighteen kinds. The engine core writes fifteen of them; the three `agent_*`
kinds are the agent executor's obligation.

| Kind | `stepId` | Payload the engine writes |
|---|---|---|
| `run_started` | no | `pipeline`, `episodeId`, and `trigger` when the caller supplied one |
| `run_finished` | no | `status`: `"completed"` or `"failed"` |
| `run_resumed` | no | `by` when the caller named one — written by `resumeRun` or by `resetSteps` on a finished run: the run is no longer finished, and failed and swept steps are pending again |
| `step_started` | yes | `kind`; a script adds `argv` and `inputHashes`; an agent adds `inputHashes`; a loop adds `body`, `until`, `max`; a gate's fix agent adds `rejectionOf` and `attempt` |
| `step_completed` | yes | a guard writes `result`; a script writes `inputHashes` and `outputHashes`; an agent writes those two plus `result` and `toolCalls`; a loop writes `result` and `iterations`; a gate's fix agent writes `result` and `toolCalls` |
| `step_failed` | yes | `error` |
| `step_skipped` | yes | `reason` — `"dependency failed: <id>"`, `"dependency skipped: <id>"`, or `"when: false"` |
| `step_cached` | yes | `inputHashes`, `outputHashes`, and `result` when the cached completion recorded one |
| `step_reset` | yes | `by`, and `attempt` when a gate wrote it — written by a gate rejection (`by` is the gate) or by `resetSteps` (`by` is `operator`): the step returns to pending and its result leaves `ctx.results` |
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
| `agent` | `promptFile`, `model`, `allowedTools`, `context` (`"fresh"` or `"shared"`), optional `schema` **or** `schemaFile`, `maxTurns`, `idleTimeoutMs`, `maxBudgetUsd` |
| `gate` | `message(ctx)` **or** `messageFile`, optional `onReject` agent, `rerunOnReject`, `maxAttempts` (default 10) |
| `loop` | `body` agent, `until` sentinel, `maxIterations`, optional `progress(ctx)` |

**A schema and a gate message may live in the show's prompts directory rather than in the step.**
An agent step names its schema either inline as `schema` or as a `schemaFile` — a draft-07 JSON file
resolved beside the prompts, read with the same loader and held to the same draft-07 check — and the
two are exclusive: a step carrying both fails rather than one of them winning silently. A gate names
its message either as `message(ctx)` or as a `messageFile`, a prompt file rendered through
`renderPrompt` with the run context, and `orderSteps` refuses at load time a gate that sets neither
or both. The runner owns no prompts directory, so a `messageFile` gate is rendered through
`RunOptions.renderGateMessage`, which `createGateMessageRenderer(agentExecutorOptions)` builds from
the same options as the agent executor; a `messageFile` gate run without one fails rather than
opening with no message. Together these keep the show's prompt and schema text in the show
repository, where the engine repository holds none of it.

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
`show` is the loaded `showrunner.json` (`loadShowConfig(showRoot)`): it supplies `promptsDir` and
`models` when those options are absent, and it is what `{{season}}` and `{{show.*}}` render from.
An explicit `promptsDir` or `models` wins over the show config.

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
| `{{season}}` | the episode's numeric season, unpadded (`Canon/season-{{season}}.md`) — read off an aired id, or from the show config's `airMap` for a production id |
| `{{show.<path>}}` | a dotted path into the show config (`{{show.showName}}`, `{{show.video.fps}}`), by the same value rules as `{{results.*}}` |

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
inside the same process keeps it — so a run resumed in the same process (a second `run()` for the
same run id, after a gate answer) finds its shared sessions intact, which is the intended behaviour.
Across runs it changes nothing, since the key carries the run id and a new run's keys therefore miss — but an executor that outlives several
episodes is exactly why the key carries the episode id too. Either way, the first query of a shared
step after a restart is fresh, and its `agent_query` records `resumed: false`, which is the log's
record of the discontinuity.

### The live test

`engine/test/agent-live.test.ts` holds the only two tests that run a real query. The first reads a
file with only `Read` allowed and checks the schema-validated verdict, the event order, and that
nothing but `Read` was invoked. The second asks for `Bash` with only `Read` allowed and checks that
the step still succeeds, that no `agent_tool_call` names `Bash`, and that the agent's verdict says
`pass: false`. The second test is where the allowlist's mechanism shows: a tool outside
`allowedTools` is not in the model's context at all, so the run records **zero** permission denials
and an empty `deniedTools` — the agent reports that Bash was not offered to it, not that it was
refused. Both are skipped unless `SHOWRUNNER_LIVE` is set, because together they cost a few cents
and need credentials on the machine (`ANTHROPIC_API_KEY`, or the machine's Claude Code login):

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

## The episode pipeline

**`episodePipeline({ show, episodeId, engineRoot })` builds the seventy-three-step pipeline that
takes one episode from its premise to a committed canon update** (`engine/src/pipelines/episode.ts`).
One run covers one episode, and the four Archon workflows are four phases of a single step list: the
**write** phase (premise, outline, canon review, draft loop, the six-reviewer panel, publish copy),
the **assets** phase (TTS script, casting, synthesis, three QC passes, mix, shot list, images), the
**assemble** phase (NAS check, timeline, render, master, finalize, publish kit), and the **canon**
phase (propose, diff, commit). The spec's ordering rules are therefore dependency edges rather than
four separate runs, and one log holds the episode's whole history. Every path and name the factory
produces comes from the show config or the episode id; the engine repository names no show.
`EPISODE_STAGE_MAP`, exported beside the factory, is what `deriveStage` reads to turn a run's log
into a stage.

**`run({ …, concurrency: 7 })` runs ready agent steps together** — the script pass's review panel
is the case it exists for: the canon reviewer and the six checks all depend on the same draft, and
seven at once is 9 min 36 s against 45 min 26 s one at a time on ep10's logs, paid again on every
script-gate rejection. Only agent steps are batched; scripts, guards, gates and loops always run
alone, and the default of 1 is one step at a time in dependency order. Outcomes are applied in
pipeline order once the batch has settled, so the first failure in that order is the one the run
reports. The log's order is the order the emits were made in, whatever order the agents finish in.
The console's worker takes `--concurrency <n>` and the server passes 7 unless its own
`--concurrency` says otherwise.

### The eight gates

Each gate opens a `DRAFT_` stage and waits for the showrunner. A rejection runs the gate's fix
agent, resets the steps named below **and everything downstream of them**, re-runs those, and
reopens the gate at the next attempt; `<gate>:rejections` keeps every note the gate has received.

| Gate | Opens | Fix agent | Rejection re-runs | Attempts |
|---|---|---|---|---|
| `outline-gate` | `DRAFT_OUTLINE` | `outline-gate-fix` | `hand-edits-outline` | 10 |
| `script-gate` | `DRAFT_SCRIPT` | `script-gate-fix` | `hand-edits-script` and the six reviewers (`tone-check`, `flow-check`, `character-check`, `structure-check`, `environment-check`, `repetition-check`) | 10 |
| `casting-gate` | `DRAFT_CASTING` | `casting-gate-fix` | `validate-manifest` | 10 |
| `audio-gate` | `DRAFT_AUDIO` | `audio-gate-fix` | `tts-generate` | 5 |
| `nano-banana-gate` | `DRAFT_IMAGES` | `nano-banana-gate-fix` | `nano-banana-generate`, `image-generate` | 10 |
| `image-gate` | `DRAFT_IMAGES` | `image-gate-fix` | `image-generate`, `nano-banana-generate` | 5 |
| `final-gate` | `DRAFT_ASSEMBLY` | `final-gate-fix` | `build-timeline` | 2 |
| `canon-gate` | `DRAFT_CANON` | `canon-gate-fix` | `canon-diff` | 10 |

`script-gate`'s closure is the one worth reading twice. `canon-review-script` depends on
`hand-edits-script`, so the rejection pulls it in and it re-reviews with the rejection note in
scope; `draft` is *upstream* of every named step and is never reset, so a rejected script is fixed
and re-reviewed rather than redrafted. `canon-gate` is the one gate carrying a `when`: a canon
phase whose diff is `NO_CHANGES` bypasses it, which is why `EPISODE_STAGE_MAP` keys `CANON` on
`canon-commit` rather than on the gate.

### The three guards that stop the line

| Guard | Fails with | What clears it |
|---|---|---|
| `premise` | `NEEDS_IDEA: write <episodesDir>/<episodeId>/premise.md` | Write that file with something in it, then launch the run again — nothing but the previous-episode check has run, so there is no work to resume. |
| `refs-ready` | `NEEDS_REFS: …`, one `;`-separated clause per missing reference | Supply what each clause names — a bible entry, a reference image, a `LOCKED` voice, a WAV — then `resumeRun`. |
| `showrunner-images` | `NEEDS_IMAGES: drop in <shot ids> under <productionDir>/<episodeId>/images/ and resume` | Put each named PNG at `<productionDir>/<episodeId>/images/<shotId>.png`, then `resumeRun`. |

Each of the three has a stage of its own — `NEEDS_IDEA`, `NEEDS_REFS`, `NEEDS_IMAGES` — derived
from disk by `episodeNeeds` rather than from the log, so the dashboard shows the blockage even
though the run is sitting failed. Three further guards stop the line without a `NEEDS_` stage:
`previous-episode` (rule 1.3 — episode N+1 does not start until episode N's run log shows a
completed canon update), `nas-mounted` (checked before the render so a finalize cannot fail after
four hours of rendering), and `canon-clean` (the canon tree has uncommitted changes that the
propose step would otherwise bury).

### The outline's `## Cast` section

**`refs-ready` reads the outline's `## Cast` section and nothing else**, because that section is
the only thing that says who is in an episode before a script exists. One entry per line:

    ## Cast
    - Vale (recurring, speaks)
    - Harbor (location)
    - Dock Hand Pim (guest, speaks)

The grammar is `- <Name> (<tag>, <tag>)`. Tags are lowercased; a line outside the section is
ignored, and so is a line inside it that does not match. Four tags are load-bearing
(`engine/src/needs.ts`): `recurring` or `location` demands an entry in the visual bible whose `ref`
image is on disk; `recurring` with `speaks` also demands a voice in the voice cast that is `LOCKED`
and whose WAV is on disk; `guest` with `speaks` demands a WAV at
`<productionDir>/<episodeId>/guest-refs/<slug>*.wav`. Names are matched as slugs, so `the Warden`
finds either `warden` or `the-warden`. An outline with no `## Cast` section reports nothing — the
section's absence is the canon reviewer's finding, not this probe's.

### The `source` field on shots

`visual-direction` writes `<productionDir>/<episodeId>/images/prompts.json`, whose `shots` array
carries one object per shot. **A shot whose `source` is `"showrunner"` is the showrunner's to make
by hand.** The engine enforces that with the `showrunner-images` guard, which holds the line until
the PNG is on disk at `<productionDir>/<episodeId>/images/<shotId>.png`; the generators are to skip
such a shot rather than spend an hour of GPU on it. Every other shot is generated —
`image-generate.py` takes the ambient shots and `nano-banana-generate.py` the character ones.

### The canon ledger

`canon-review-outline` and `canon-review-script` return a `deviations` array: departures from the
canon store whose provenance is the showrunner's rather than an agent's. `canon-ledger-outline` and
`canon-ledger-script` append those rows to **`<episodesDir>/<episodeId>/canon-ledger.md`**:

    | # | Where | The deviation | Canon it departs from | Provenance | Evidence | Disposition |
    |---|---|---|---|---|---|---|
    | 1 | outline.md beat 7 | the crew is four, not six | Canon/characters/Vale/vale.md:18 | premise | Episodes/s02e01/premise.md (outline pass, run r1) | PENDING |

The Evidence cell carries the pass and the run id that recorded the row, and Disposition starts at
`PENDING`; the end-of-episode canon moment turns each accepted row into a canon change and drops
the rest. A row whose Where and deviation already appear is not appended again, so the outline pass
and the script pass of one run do not duplicate each other.

### The operator's two recovery moves

- **`resumeRun(log, runId, by?)`** reopens a failed run. The failed step and everything the failure
  swept become pending again; completed steps keep their status, so no agent step is paid for
  twice. This is what clears `refs-ready` and `showrunner-images` once the missing file is on disk.
- **`resetSteps(pipeline, log, runId, stepIds, by?)`** is "re-run from here": the named steps and
  everything downstream of them return to pending, and a finished run is reopened first. A script
  step whose inputs and outputs are unchanged is still served from cache. On a run with an open
  gate the gate stays open with its original message — answer it or reset, not both at once.

**A prompt that writes `{{season}}` fails for a production id the show's `airMap` does not place.**
An aired id (`s02e01`) carries its season; a production id (`ep98`) has one only if `airMap` gives
it a slot. The variable is resolved eagerly but is not required, so the failure lands at the step
whose prompt names it rather than at load time. A real run on such an id therefore needs an
`airMap` entry for it or a prompt that does not name `{{season}}`. The same id shapes the pipeline
quietly: without a season there is no `<canonDir>/season-<n>.md` in the canon spine, and the mix is
named `episode.wav` rather than by the show's pattern.

## The console

**`console/` is the showrunner's operating layer over the engine: four browser surfaces that show
what every episode is doing, open each gate for an answer, and start and restart runs — without the
server owning a single run.** The Board is one row per episode; the Run view is the pipeline's steps
and the run's events; the Gate view is the question, its artifacts and the Approve and Reject
buttons; and "What happened" hands a read-only agent the run's own record. Every action goes
through the engine's verbs — `answerGate`, `resumeRun`, `resetSteps` and `withdrawApproval` — and
then spawns a detached worker, so the event log stays the only thing that decides what a run is.

The console names no show. It is pointed at a show repository with `--show <path>` and reads that
repository's `showrunner.json`, exactly as the engine does.

    npm run build && node console/dist/server/main.js --show <show repository> --port 4410

**`console/README.md` is the console's own documentation**: the four surfaces and what is deferred,
the three processes, every file the console writes, the flags and the home-network rule for
`--host`, the four recovery moves with what each appends and when each is refused, the four files
beside a run log, the artifact route's three-layer fence, and why the browser tab's title is the
whole alerting story.

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
- **A gate rejection re-runs the steps the gate names** (`rerunOnReject`) and everything
  downstream of them, after the fix agent, before the gate reopens; the reset is recorded once
  per rejection, so a crash between the resets and the re-runs does not reset a second time.
- **A failed run is resumed with `resumeRun`**, which continues from the failed step without
  re-running any completed agent step.
- **`resetSteps` is the operator's "re-run from here"**; on a run with an open gate it leaves the
  gate open with its original message.

## Scripts

`scripts/` holds the pipeline's deterministic steps: twenty-six Python programs the engine runs
as argv arrays, never as shell strings. **A script belongs to the engine, and the show it is run
for reaches it through argv and `showrunner.json`** — no script contains a show's name.

Every script follows one convention, which `scripts/lib/showconfig.py`'s module docstring states.

- **The working directory is the show root.** The script executor sets `cwd: ctx.showRoot`
  (`engine/src/script-step.ts`), so `showrunner.json` is found without a flag and a show-relative
  path such as `Production/<episodeId>/audio/` resolves from where the script stands.
- **`--show-root <path>` and `--show-root=<path>` are both accepted**, for an operator running a
  script by hand from somewhere else. `sc.show_root(sys.argv)` returns the path as typed, or the
  working directory when no flag is present, and **removes the flag from `sys.argv` in place** —
  with its value, in the two-token form — so the caller's positional arguments keep their usual
  places and argparse never sees the flag.
- **Everything else arrives in argv.** The episode id is `sys.argv[1]`, and no script reads a
  *setting* from the environment; the one environment read is the `GEMINI_API_KEY` secret in
  `nano-banana-generate.py`.
- Those three facts are one preamble, in this order, at the top of every `main()`:

      root = os.path.abspath(sc.show_root(sys.argv))
      cfg = sc.load(root)
      os.chdir(root)

  **The order is load-bearing.** The root is made absolute first, because a relative `--show-root`
  would otherwise mean one directory to `load()` and a different one to every path resolved after
  the `chdir`; and `load()` runs before the `chdir`, so a wrong `--show-root` fails by naming
  `showrunner.json` rather than by failing to enter a directory.
- **The config is read through `lib/showconfig.py` and nowhere else.** `sc.value(cfg, *keys)`
  returns a setting, raising `ShowConfigError` naming the dotted path when the key is absent and no
  `default=` was given; `sc.path(cfg, *keys, root=root)` returns a path resolved against the show
  root unless it is absolute; `sc.format_filename(pattern, slug=…, season=…, episode=…,
  episode_id=…)` renders an output filename pattern; and `sc.season_of(cfg, episodeId)` returns
  `(season, episode)`. `sc.season_of` raises `UnmappedEpisodeId` — its own subclass of
  `ShowConfigError` — for a well-formed production id the `airMap` does not place, because an
  episode written before its air slot is settled still needs a name for its outputs and a script
  may legitimately absorb that one fault. A malformed id raises the plain `ShowConfigError`
  instead, since that is a mistake in the argv the operator typed rather than a state an episode
  passes through.
- **Progress is one line per unit of work**, printed by `sc.progress(done, total, unit, message)`
  as `::progress {…}`. The section "The progress contract" below states what the executor does
  with such a line.
- **A successful run's last stdout line is an uppercase sentinel and its figures** — `MIX_OK`,
  `TIMELINE_OK`, `MANIFEST_OK`, `IMAGE_QC_OK`, `PUBLISH_KIT` — so the run's log carries what the
  step decided without anyone opening the file it wrote.
- **A failure exits non-zero with one line on stderr, prefixed by the script's own name.** Every
  script closes with the same guard, which is also what keeps a config fault from reaching the
  operator as a traceback:

      if __name__ == "__main__":
          try:
              main()
          except (sc.ShowConfigError, FileNotFoundError) as err:
              sys.exit(f"<script-name>: {err}")

- **Idempotency is the script's, by output-exists.** The engine makes no attempt to resume a script
  partway — see "The resume contract" below — so a re-run skips each output already on disk:
  `tts-generate.py` skips a segment whose WAV exists, `image-generate.py` prints
  `skip <id> (exists)`, and `nano-banana-generate.py` records `SKIPPED-exists`.
- **A shot whose `source` is `showrunner` is the showrunner's to make**; `image-generate.py` and
  `nano-banana-generate.py` leave it alone and `image-sheet.py` says so.

Two of the programs exist for the pipeline's own bookkeeping rather than for a craft step:

- **`git-commit.py <episode> --message <text> [--show-root <path>] -- <path>...`** is the
  pipeline's four commit steps. It stages each listed path **that exists** (`git add -A -- <path>`,
  so a deletion under a listed directory leaves the tree in the same commit) and commits only when
  the index differs from HEAD, printing `COMMIT_OK <short sha>` or `COMMIT_SKIPPED nothing staged`
  and exiting 0 either way. Both halves are load-bearing: `canon-commit` lists a canon ledger that
  an episode with no deviations never has, and a commit step declares no `inputs`, so it is never
  served from cache and a resumed run spawns it a second time for one commit.
- **`canon-ledger.py <episode> --pass <outline|script> --run <runId> --rows <json-array>`** writes
  the canon reviewer's deliberate deviations to `<episodesDir>/<episodeId>/canon-ledger.md`,
  creating the file with the header shown under "The canon ledger" above when there is a first row
  to write, and printing `LEDGER_OK <new> new rows, <total> total`. The reviewer is given `Read`,
  `Glob` and `Grep` only and returns the rows in its verdict; this step does the writing. A row
  whose Where and deviation cells already appear is not appended again — the key excludes Evidence
  deliberately, because the Evidence cell carries `(<pass> pass, run <runId>)` and would never
  match across the outline pass and the script pass of one deviation.

One further program exists because a step was silent rather than because a step was missing:

- **`render-video.py <episode> --render-dir <path> --composition <id> --out <path>
  [--progress-interval <seconds>] [--show-root <path>]`** is the `render` step. It spawns
  `npx remotion render <composition> <out> --log=info` with the render directory as that child's
  working directory and `REMOTION_EPISODE=<episode>` in its environment, reads the child's output,
  and turns Remotion's own frame counter into the progress contract's lines —
  `::progress {"done":N,"total":M,"unit":"frames"}`, at most one per `--progress-interval` second
  (default one). Every other line Remotion prints is forwarded unchanged, the last line is
  `RENDER_OK <out>`, and a failed render **exits with Remotion's exit code rather than 1**,
  carrying Remotion's own last line as the reason. **The step passes the render directory and the
  output path in argv and keeps the executor's default working directory, the show root**, because
  the scripts' convention requires it: `showrunner.json` has to be findable without a flag.
  Remotion is given the output path absolute, because Remotion itself runs in the engine's
  `render/` directory where a show-relative path would resolve inside the engine checkout.
  The parser was written against a measurement rather than a guess, which the script's docstring
  records: under a pipe, Remotion 4.0.487 prints `Rendered 1/63280, time remaining: 3h 33m 2s`,
  newline-separated with no carriage returns, once per frame, and `--log=info` is the lowest level
  that prints the counter at all (`--log=error`, which this step passed before, prints nothing for
  the whole render, which is the silence this program exists to end).

    cd scripts && uv run pytest

runs the hermetic suite: twenty-four test files under `scripts/tests/`, none of which synthesizes
audio, generates an image or renders anything. `scripts/pyproject.toml` lists the union of every
script's inline dependency block once and sets `package = false`, so uv treats the directory as a
virtual project and installs only the dependencies; each script keeps its own inline
`# /// script` block, so a single script still runs standalone under `uv run`.

## Tools

`tools/` holds the two programs that move a show's prompts out of its Archon workflow files and
check them afterwards. Both are hermetic: each reads only the files it is pointed at, writes only
where it is told to, and consults no clock, network or environment, so running one twice on the
same inputs produces byte-identical outputs.

- **`extract-prompts`** reads a directory of Archon workflow YAML files and writes one `.md` per
  agent prompt, loop body, gate message and gate rejection prompt, plus `index.json` and any output
  schemas. **Prompt text moves verbatim**: the only change made to a body is the variable rewriting
  of `tools/src/rewrite.ts`, which turns Archon's `$` forms into the engine's `{{…}}` syntax, so a
  show's own name, its characters and its canon paths survive the move untouched. A file is named
  from the node id alone, with **no prefixing by workflow**, which keeps a prompt file's name equal
  to the step id that will read it and makes two nodes that would write the same file an error
  naming both sources rather than a silent last-writer-wins. A name collision, an override that
  matched nothing, a `schemaRequiredAdd` entry for a node that does not exist, a variable form no
  rule maps, and a non-empty `--out` directory without `--force` each stop the run or come back in
  the result.
- **`check-prompts`** renders every `.md` in a prompts directory against a sample context and names
  the ones with holes. It is what makes an extraction trustworthy: `renderPrompt` treats every hole
  as an error at run time, and running the whole directory through it once turns that run-time
  failure into a check that can be made before anything is launched. A gate message and a rejection
  prompt are checked like any other file, because a gate message is read by the showrunner at an
  approval and a hole in one misleads the single person the pipeline cannot afford to mislead.
  **`README.md` is the one exception and is skipped**: it is written by a person, never by the
  extractor, and it documents the template syntax, so it quotes forms such as `{{show.<path>}}`
  that are deliberately not renderable.

    node tools/dist/extract-prompts.js --workflows <dir> --out <show-root>/prompts \
        [--overrides tools/show-data/<show>-overrides.json] [--force]
    node tools/dist/check-prompts.js --prompts <show-root>/prompts \
        --context tools/show-data/<show>-check-context.json

**`tools/show-data/` is the one place under `tools/` that carries a show's name, and what it holds
is data, not code.** Both programs are show-agnostic and take their show-specific inputs as files —
`--overrides` for the per-node rewrite rules a particular show's workflows need, `--context` for
the sample context `check-prompts` renders against. Those two files are the exact inputs an
extraction was run with, so the extraction stays reproducible, and they are versioned beside the
tool that consumes them rather than inside it. Naming each file for the show it describes is what
makes the boundary visible in the directory listing: the constraint grep in **Develop** below
excludes `tools/show-data/` by name, and no other source directory under `tools/`.

## The render project

`render/` is the engine's renderer: one Remotion composition, `Episode`, that turns an episode's
staged stills and mixed audio into a video file. **It carries no show literal.** The frame rate,
the frame size, the crossfade and the title card's words, font and colours all reach it through
`Production/<episodeId>/video/timeline.json` and nothing else, and `render/src/Root.tsx` declares
none of them on its `<Composition>` because `calculateMetadata` reads them off the timeline.
Changing shows means changing `showrunner.json` in the show repository; nothing under `render/src`
moves. `render/README.md` documents the timeline's keys, the two things a render needs set, and why
`render/public/` is tracked empty.

**`render/` is a standalone package, not a root workspace.** The root `package.json` lists `engine`
and `tools` in `workspaces` and deliberately not `render`, because a workspaces entry would hoist
Remotion's dependency tree into the root `node_modules` and rewrite the root lock file. The
consequence is that **the root `npm test` does not run the render project's tests**:
`npm run test:render` does, and `npm run typecheck:render` type-checks it.

## Develop

    npm install                    # engine, tools and console, through the workspaces
    npm run build                  # engine and tools into each package's dist/ — tools/dist is
                                   # what the Tools section's commands run — then the console's
                                   # server, worker and client bundle
    npm test                       # engine's suite, then tools', then the console's
    npm run typecheck              # tsc over src/, then over test/, in each

    npm run test:render            # the render project — NOT part of npm test
    npm run typecheck:render       # tsc --noEmit over render/src

    cd render && npm install       # the render project's own dependency tree
    cd scripts && uv run pytest    # the Python steps' hermetic suite

`engine`, `tools` and `console` are the root `package.json`'s three workspaces, so `npm test` and
`npm run typecheck` at the root cover those three and nothing else. `render/` and `scripts/` install
and test on their own, which is why the root carries a `test:render` script at all.

The console's own commands, for working on it alone:

    npm run build -w console       # tsc for server and worker, then vite build for the client
    npm test -w console            # the console's vitest suite
    npm run typecheck -w console   # tsc over the server project, then over the client project

    cd console && SHOWRUNNER_SHOW_ROOT=<show repository> npm run dev

`npm run dev` runs the server under `tsx watch` and Vite on port 5193 together, with Vite serving
the client and proxying `/api` to the server. `SHOWRUNNER_SHOW_ROOT` has no default, for the same
reason the `ep98` exercise's copy of it has none: a default would have to spell a show's directory
name. `console/README.md` documents the console itself.

### The `ep98` exercise — the real scripts, against a real show

    cd engine && SHOWRUNNER_EP98=1 SHOWRUNNER_SHOW_ROOT=<show repository> \
      npx vitest run test/ep98-exercise.test.ts --reporter=verbose

`engine/test/ep98-exercise.test.ts` runs the two script-only exercises against the show repository
`SHOWRUNNER_SHOW_ROOT` names: the mix, and the timeline → render → master chain, on the non-canon
test episode `ep98`, with the real script executor and **no agent step at all** — its agent
executor fails every call, so a run that reaches one fails the test. Each exercise seeds a run log
in which every earlier step is already completed, lets the pipeline run the real steps, and stops
at the gate that follows. It needs `uv`, `ffmpeg`, the render project's dependencies, and about
half an hour.

**Both environment variables are required and neither has a default.** Without `SHOWRUNNER_EP98=1`
the file is skipped, so `npm test` stays hermetic; with it set but `SHOWRUNNER_SHOW_ROOT` empty the
file is skipped with a message saying so. `SHOWRUNNER_SHOW_ROOT` has no built-in fallback because
any fallback would have to spell a show's directory name, which the rule below forbids.

The exercise writes only under the show's `Production/ep98/` and `Episodes/ep98/` — audio, video
and images there are git-ignored — and it deletes the two run logs it wrote and restores
`Episodes/ep98/STATUS.md` from git when it is done, so `git status` in the show repository is the
same before and after. It never touches the NAS: the `nas-mounted` guard is one of the steps the
seed marks completed. It also removes `render/public/ep98/`, the staging directory
`build-timeline.py` filled, because that directory holds the show's own file names inside the
engine checkout and the rule below forbids them there.

**No show's name may appear in `engine/`, `scripts/`, `render/`, `tools/src/` or `console/`.** This
grep is what checks it, and it must print nothing:

    grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' \
      engine/ scripts/ render/ tools/ console/ \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data \
      --exclude-dir=public --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache

**The word list is the first show's, and it is not the whole obligation.** It names Dead Light and
that show's characters and places because those are the literals this engine was carved out of, and
`-w` is what keeps `remo` from matching `remotion`. A show's character and place names beyond the
list — a new show's, or a name this one adds later — are caught by review, not by this grep: a
reviewer who sees a test fixture or a comment naming a real show's cast must say so, and the noun
moves to the invented show the fixtures use.

`tools/show-data/` is excluded because that directory holds a show's own data, as the **Tools**
section above explains. `render/public/` is excluded because it is a staging directory, not
source: `build-timeline.py` copies the episode's own audio and images into it under the show's
file names so the renderer can serve them, and a run leaves them there. The exercise described
above deletes `render/public/ep98/` when it finishes for the same reason. This file and everything
under `docs/` are allowed to name a show and are outside the paths the grep searches;
**`console/README.md` has no such exemption**, because it is inside a path the grep searches and the
console it documents is show-agnostic in the same way the engine is. The remaining exclusions are
build and cache trees — `node_modules/`, `dist/`, `scripts/.venv/`, `scripts/__pycache__/` and
`scripts/.pytest_cache/` — none of which is source. `console/dist/` is covered by the `dist`
exclusion, which is what keeps the built client bundle out of the search.

## Documents

- `docs/specs/2026-09-25-console-rewrite-design.md` — the requirements this engine is built to.
- `docs/specs/2026-09-25-pipeline-process-map.md` — the system being replaced.
- `docs/plans/2026-09-26-engine-core.md` — the build plan for `engine/`.

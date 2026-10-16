import type { Progress } from "./state.js";
import type { Event } from "./events.js";
import type { ShowConfig } from "./show-config.js";

export type StepId = string;

export type EventKind =
  | "run_started" | "run_finished" | "run_resumed"
  | "step_started" | "step_completed" | "step_failed" | "step_skipped" | "step_cached" | "step_reset"
  | "step_progress" | "step_waiting" | "script_line"
  | "agent_query" | "agent_tool_call" | "agent_result"
  | "loop_iteration" | "panel_round"
  | "gate_opened" | "gate_answered"
  | "input_changed";

export type Emit = (kind: EventKind, payload: Record<string, unknown>) => Promise<void>;

export interface RunContext {
  runId: string;
  episodeId: string;
  /** Absolute path to the show repository the engine is operating on. */
  showRoot: string;
  /** Who launched this run and from where — "console:<user>", "cron", "cli". Recorded on
   *  run_started (spec §6.5), so the log answers "who started this" without a second source. */
  trigger?: string;
  /** Results of completed steps, by id: a guard's message, a gate's answer, an agent's verdict. */
  results: Record<StepId, unknown>;
  /** The run's log as read so far — every event the runner has replayed or appended, in log
   *  order. A guard that needs history (which step last wrote a file, and with what hash) reads
   *  it here rather than opening the log itself; executors ignore it. Optional so a caller that
   *  builds a context by hand, as the tests do, need not supply one. */
  events?: readonly Event[];
  /** The show's config, when the caller has one. Read by the runner for exactly one number — the
   *  weekly auto-retry ceiling (`agents.autoRetryWeeklyUtilizationMax`) a `panel` step compares the
   *  log's latest seven-day utilization against before it starts another round. It is optional, and
   *  the runner falls back to the house default (`DEFAULT_AUTO_RETRY_WEEKLY_UTILIZATION_MAX`), so a
   *  caller that builds a context by hand — every test, the bible interview — still runs; a show
   *  that configures its own ceiling has to pass this, which the console's worker does. The agent
   *  executor does **not** read it: its own `AgentExecutorOptions.show` is the config it renders
   *  `{{show.*}}` from, and the two are deliberately separate seams. */
  show?: ShowConfig;
}

interface StepBase {
  id: StepId;
  dependsOn?: StepId[];
  /** Files (relative to showRoot) this step reads. Hashed; a change invalidates a cached success. */
  inputs?: string[];
  /** Files (relative to showRoot) this step writes. Hashed on completion and recorded. */
  outputs?: string[];
  /** Spec §4.3's condition. When it returns false the step is bypassed: a step_skipped with the
   *  reason "when: false" is logged, and — unlike a step skipped by a broken dependency — the
   *  steps that depend on it still run. */
  when?: (ctx: RunContext) => boolean | Promise<boolean>;
  /** Wall-clock budget for the step. The script executor enforces it by killing the child's whole
   *  process group; enforcement for agent steps belongs to the agent executor. */
  timeoutMs?: number;
}

export type GuardResult = { pass: true; message?: string } | { pass: false; message: string };

export interface GuardStep extends StepBase {
  kind: "guard";
  check: (ctx: RunContext) => GuardResult | Promise<GuardResult>;
}

export interface ScriptStep extends StepBase {
  kind: "script";
  /** argv[0] is the executable. Never a shell string. */
  argv: (ctx: RunContext) => string[];
  env?: (ctx: RunContext) => Record<string, string>;
  cwd?: string;
}

/** A JSON Schema, draft-07. The Agent SDK validates verdicts against draft-07 and rejects a schema
 *  that declares a newer draft, so a `$schema` key, if present, must name draft-07. */
export type JsonSchema = Record<string, unknown>;

export interface AgentStep extends StepBase {
  kind: "agent";
  /** Path of the prompt file, relative to the show's prompts directory. */
  promptFile: string;
  /** A model alias or id. The executor resolves aliases through its `models` map and passes
   *  anything else to the SDK unchanged. */
  model: string;
  /** Built-in tools the agent may use, e.g. ["Read", "Glob", "Grep"]. Nothing else is in context
   *  and nothing else is approved: the executor runs with permissionMode "dontAsk". */
  allowedTools: string[];
  /** "fresh": every query starts a new session. "shared": within one run, later queries of this
   *  step resume the session its first query opened (a loop body keeps its conversation across
   *  iterations). After a restart the session is not recovered: the next query is fresh, and the
   *  log shows it. */
  context: "fresh" | "shared";
  /** JSON schema the agent's verdict must satisfy, when the step produces one. With a schema the
   *  outcome carries `verdict`; a success with no verdict is a failure. */
  schema?: JsonSchema;
  /** The schema, as a draft-07 file relative to the prompts directory; exclusive with `schema`;
   *  the executor reads it with `loadPrompt` and applies the same draft-07 check. A show that
   *  keeps its schemas as `<step>.schema.json` beside its prompts names them this way, so the
   *  engine repository never holds their contents. */
  schemaFile?: string;
  /** Maximum agentic turns (tool-use round trips) before the SDK stops the query. */
  maxTurns?: number;
  /** Fail the step when no message arrives from the SDK for this long. `timeoutMs` on StepBase
   *  bounds the whole query; this bounds the silence between messages. */
  idleTimeoutMs?: number;
  /** Stop the query when the SDK's client-side cost estimate reaches this many US dollars. */
  maxBudgetUsd?: number;
  /** Values a prompt may render as `{{vars.<name>}}`. They belong to the step, not the run: a
   *  pipeline that runs one prompt file for several targets (the bible interview, which writes
   *  fourteen files with one `write.md`) names the target here rather than in fourteen prompt
   *  files. A prompt that names a var the step does not declare fails to render, like any other
   *  hole. Recorded in `describePipeline`, so a changed var changes the pipeline hash. */
  vars?: Record<string, string>;
}

/** An agent step nested inside a gate (`onReject`) or a loop (`body`). It has no `when` and no
 *  `dependsOn`: it runs because its parent decided so. */
export type NestedAgentStep = Omit<AgentStep, "when" | "dependsOn">;

/** Renders a gate's `messageFile` into the text the showrunner is shown. The runner does not own
 *  it: resolving a file under the show's prompts directory and rendering its `{{...}}` needs the
 *  prompts directory and the show config, which the agent executor's owner has — see
 *  `createGateMessageRenderer` in agent-step.ts. The third argument is the gate's own
 *  `GateStep.vars`, which the runner passes because only the step declares them; it is optional so
 *  a caller's two-argument renderer — the console's fakes, a gate whose message names no var —
 *  stays assignable to this type. */
export type GateMessageRenderer = (file: string, ctx: RunContext, vars?: Record<string, string>) => Promise<string>;

export interface GateStep extends StepBase {
  kind: "gate";
  /** The message the showrunner is shown, built from the run context. Exactly one of `message` and
   *  `messageFile` is set: `orderSteps` refuses a gate with neither or both. */
  message?: (ctx: RunContext) => string;
  /** The message as a prompt file, relative to the show's prompts directory, rendered through
   *  `renderPrompt` with the run context by `RunOptions.renderGateMessage`. Exclusive with
   *  `message`; a gate that names one and is run without a renderer fails rather than opening
   *  with a message the showrunner cannot read. */
  messageFile?: string;
  /** The agent run when the showrunner rejects. The fix agent is a step of its own: its events
   *  are logged under its own id, so its id shares the pipeline's id namespace (orderSteps
   *  enforces that) and a completed run of it is visible in the log and is not repeated after a
   *  crash. Its context carries the rejection notes as the result key `<gate-id>:rejection`. */
  onReject?: NestedAgentStep;
  /** Steps whose work this gate's rejection invalidates. After the fix agent completes — at once,
   *  when there is none — the runner emits step_reset for each of these and for every step
   *  downstream of them (never the gate itself), clears them from the derived state, and
   *  re-executes them before the gate reopens. A script step among them whose declared inputs
   *  and outputs are unchanged on disk is served from cache, so naming a step here costs nothing
   *  when the fix touched nothing it reads. The reset is recorded once per rejection: a crash
   *  between the step_reset writes and the re-runs does not reset again on resume. */
  rerunOnReject?: StepId[];
  maxAttempts?: number;
  /** Rendered into `messageFile` as `{{vars.<name>}}` by the gate renderer; see AgentStep.vars. */
  vars?: Record<string, string>;
}

export interface LoopStep extends StepBase {
  kind: "loop";
  /** The agent run once per iteration. The body is not a step of its own: its events are logged
   *  under the loop's id, so the loop is one step in the run's history however many times the
   *  body runs, and the iterations are told apart by the loop_iteration events between them. The
   *  body's id still has to be unique — it names the result key `<body-id>:iteration`. */
  body: NestedAgentStep;
  /** The exact string whose presence in the body's final text ends the loop. A body with a schema
   *  has no prose final text: its `text` is the serialized verdict, so `orderSteps` refuses a loop
   *  whose body carries a schema; a verdict-driven loop needs an `untilVerdict` predicate, which
   *  Plan D adds if it wants one. */
  until: string;
  maxIterations: number;
  /** Called after every iteration; its result is emitted as step_progress. Spec §6.7 wants a
   *  loop's progress derived from disk rather than self-reported — counting what was actually
   *  written against what was planned — because a derived number cannot be wrong about it. The
   *  context it receives carries `<body-id>:iteration`, the number of the iteration just run. */
  progress?: (ctx: RunContext) => Progress | Promise<Progress>;
}

/** A verdict-driven round: the step that reads a set of reviewers' verdicts and, when any of them
 *  failed, invalidates the round's work and makes the pass run it again. It is the engine's one
 *  trigger for the reset path a gate rejection already uses (inventory J-01, J-02), and it exists
 *  because no other kind can express the outcome: a `guard` can only pass or fail the whole run
 *  (J-03), and a `loop`'s body is one agent step rather than a sequence (J-04).
 *
 *  **Green:** every id in `reviewers` has a result whose `pass` is true, and the step completes with
 *  `{ round, green: true }` — which is what lets a gate downstream of it open only on a green panel.
 *
 *  **Red:** the step writes one `panel_round` event carrying the round's number, the verdicts, the
 *  round's cost and the weekly figure, then a `step_reset` for every id in `resets` — **including
 *  its own**, which is what returns it to pending so the restarted pass evaluates it again — and
 *  returns the reset outcome, so the runner restarts the pass with those steps pending.
 *
 *  There is no round cap (Ryan's ruling of 2026-10-15). The only stop is the weekly quota: at or
 *  above the show's `agents.autoRetryWeeklyUtilizationMax` the step fails with the operator's
 *  sentence instead of resetting, and the operator's Resume continues the loop.
 *
 *  `reviewers` must be a subset of `dependsOn` (`orderSteps` refuses otherwise): the panel reads
 *  those steps' results, and the ordered walk is what guarantees they have run. `resets` names the
 *  steps whose work a failed round invalidates, in pipeline order, and it is a declared list rather
 *  than a computed closure because the round is a decision about which work to repeat, not a
 *  consequence of the dependency graph. */
export interface PanelStep extends StepBase {
  kind: "panel";
  /** The steps whose verdicts decide the round. Each must also be in `dependsOn`. */
  reviewers: StepId[];
  /** The steps a failed round re-runs, the panel's own id among them. Gates are never reset. */
  resets: StepId[];
}

export type Step = GuardStep | ScriptStep | AgentStep | GateStep | LoopStep | PanelStep;

/** Whether a step's result is a verdict that passed: an object whose `pass` is exactly `true`.
 *
 *  Exported because two readers need the identical rule and a one-line copy in each is a rule that
 *  drifts: the `panel` step's own check (runner.ts) and the episode pipeline's `when` predicates and
 *  guard messages (pipelines/episode.ts). Anything that is not an object with `pass === true` — a
 *  missing result, a string, a verdict with `pass: "true"` — is not a pass, because a reviewer that
 *  did not say it passed has not passed. */
export function verdictPass(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { pass?: unknown }).pass === true;
}

export interface Pipeline {
  name: string;
  steps: Step[];
}

/** result: the script's last non-empty stdout line that was not a progress line — the one-line
 *  summary a later step may read as `{{results.<id>}}`. */
export type ScriptOutcome = { ok: true; result?: string } | { ok: false; error: string };

/** Why a query ended in something the SDK itself named, rather than in a result the executor could
 *  read: a plan usage limit, or one of the other twelve `SDKAssistantMessageError` kinds. It rides
 *  on the failure outcome and is logged on `agent_result`, because the operator's next move differs
 *  by kind — a five-hour limit under the weekly ceiling is waited out and retried by the executor
 *  itself, a seven-day one needs the operator's Resume after the reset, and a `billing_error` needs
 *  an account change before any run can proceed.
 *
 *  `kind` is `"rate_limit"` for a usage limit, and otherwise the SDK's own error kind verbatim, so
 *  a kind the SDK adds after this was written still reaches the log by name. `waited` says whether
 *  the executor slept before the attempt this limit describes — the log's record that the wait
 *  happened and that no second wait is owed. It is true only after a real sleep: a retry taken at
 *  once because the reset instant had already passed records `waited: false` (ruling I-22).
 *
 *  **The second arm carries `waited` too, optionally.** A retry that came back refused for another
 *  SDK kind — the credit ran out while the step slept — is logged as that kind, and `waited` rides
 *  along so the record of the five hours survives on `agent_result.limit` and not only in the
 *  step_waiting event. It is absent when no retry was taken at all, which is every first-attempt
 *  refusal.
 *
 *  `weeklySource` says which of the two sources the weekly figure came from — `"event"` for a
 *  seven-day `rate_limit_event` in the stream, `"usage"` for the SDK's experimental usage call —
 *  because the two are not equally reliable: the event is part of the stream the query already
 *  delivered, while the usage call is a control request that can go unanswered. An operator reading
 *  What-happened can tell a decision made on the stream's own number from one made on a figure
 *  fetched separately. It is absent exactly when `weeklyUtilization` is. */
export type AgentLimit =
  | { kind: "rate_limit"; window: string; resetsAt?: string; weeklyUtilization?: number; weeklySource?: "event" | "usage"; waited: boolean }
  | { kind: string; waited?: boolean };

export type AgentOutcome =
  | { ok: true; text: string; verdict?: unknown; toolCalls: number }
  /** toolCalls on a failure is the count made before the failure — the number that tells a
   *  loop iteration that failed after real work apart from one that did nothing (spec §6.7).
   *  `limit` is set when the SDK named the cause (a usage limit, or another error kind); the
   *  three callers in runner.ts still fail the step on `error` alone and ignore it. */
  | { ok: false; error: string; toolCalls?: number; limit?: AgentLimit };

/** The two step kinds that do real work are injected, so the runner is testable with fakes.
 *
 *  Each executor owes the log a fixed set of events, because the dashboard, the restart logic and
 *  the troubleshooting agent are all projections of the log and nothing else (spec §6.5, §6.8).
 *  The runner writes step_started, step_completed, step_failed, step_cached and input_changed
 *  around the call; everything below is the executor's own obligation, emitted through the `emit`
 *  it is handed, which stamps the step id for it.
 *
 *  An implementation that emits none of these still runs, and the run still completes — the cost
 *  is paid later, by an operator who cannot see what a step did.
 *
 *  An executor may throw only when the event log itself is unwritable. The script executor never
 *  throws (every rejected emit becomes `{ ok: false, error: "log write failed: …" }`); the agent
 *  executor guards the `agent_tool_call` emit the same way but its `agent_query`, `step_waiting` and
 *  `agent_result` emits are unguarded and reject out of the executor. A throw leaves the step `running` with no
 *  terminal event; §6.9's replay re-executes it on the next run. */
export interface Executors {
  /** Obligations: one `script_line` per line of stdout or stderr that is not a progress line, in
   *  the order the lines happened, and one `step_progress` per `::progress {...}` line on stdout
   *  (spec §6.7). The progress line itself is never also logged as a script_line. */
  script: (step: ScriptStep, ctx: RunContext, emit: Emit) => Promise<ScriptOutcome>;
  /** Obligations: one `agent_query` per query the step makes, carrying the prompt file, model,
   *  allowlist and context policy it ran with; one `agent_tool_call` per tool invocation, with
   *  its arguments; and one `agent_result` when the step is done, carrying the verdict JSON if
   *  the step has a schema and the final text otherwise (spec §6.5).
   *
   *  A returned verdict is stored by reference in `ctx.results` and emitted into the log; it must
   *  not be mutated after it is returned. */
  agent: (step: AgentStep, ctx: RunContext, emit: Emit) => Promise<AgentOutcome>;
}

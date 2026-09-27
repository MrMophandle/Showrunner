import type { Progress } from "./state.js";

export type StepId = string;

export type EventKind =
  | "run_started" | "run_finished"
  | "step_started" | "step_completed" | "step_failed" | "step_skipped" | "step_cached"
  | "step_progress" | "script_line"
  | "agent_query" | "agent_tool_call" | "agent_result"
  | "loop_iteration"
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
  /** Maximum agentic turns (tool-use round trips) before the SDK stops the query. */
  maxTurns?: number;
  /** Fail the step when no message arrives from the SDK for this long. `timeoutMs` on StepBase
   *  bounds the whole query; this bounds the silence between messages. */
  idleTimeoutMs?: number;
  /** Stop the query when the SDK's client-side cost estimate reaches this many US dollars. */
  maxBudgetUsd?: number;
}

/** An agent step nested inside a gate (`onReject`) or a loop (`body`). It has no `when` and no
 *  `dependsOn`: it runs because its parent decided so. */
export type NestedAgentStep = Omit<AgentStep, "when" | "dependsOn">;

export interface GateStep extends StepBase {
  kind: "gate";
  message: (ctx: RunContext) => string;
  /** The agent run when the showrunner rejects. The fix agent is a step of its own: its events
   *  are logged under its own id, so its id shares the pipeline's id namespace (orderSteps
   *  enforces that) and a completed run of it is visible in the log and is not repeated after a
   *  crash. Its context carries the rejection notes as the result key `<gate-id>:rejection`. */
  onReject?: NestedAgentStep;
  maxAttempts?: number;
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

export type Step = GuardStep | ScriptStep | AgentStep | GateStep | LoopStep;

export interface Pipeline {
  name: string;
  steps: Step[];
}

export type ScriptOutcome = { ok: true } | { ok: false; error: string };

export type AgentOutcome =
  | { ok: true; text: string; verdict?: unknown; toolCalls: number }
  | { ok: false; error: string };

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
 *  executor guards the `agent_tool_call` emit the same way but its `agent_query` and `agent_result`
 *  emits are unguarded and reject out of the executor. A throw leaves the step `running` with no
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

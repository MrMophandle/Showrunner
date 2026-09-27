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

export interface AgentStep extends StepBase {
  kind: "agent";
  /** Path of the prompt file, relative to the show's prompts directory. */
  promptFile: string;
  model: string;
  allowedTools: string[];
  context: "fresh" | "shared";
  /** JSON schema the agent's verdict must satisfy, when the step produces one. */
  schema?: object;
}

export interface GateStep extends StepBase {
  kind: "gate";
  message: (ctx: RunContext) => string;
  onReject?: AgentStep;
  maxAttempts?: number;
}

export interface LoopStep extends StepBase {
  kind: "loop";
  body: AgentStep;
  /** The exact string whose presence in the body's final text ends the loop. */
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
 *  is paid later, by an operator who cannot see what a step did. */
export interface Executors {
  /** Obligations: one `script_line` per line of stdout or stderr that is not a progress line, in
   *  the order the lines happened, and one `step_progress` per `::progress {...}` line on stdout
   *  (spec §6.7). The progress line itself is never also logged as a script_line. */
  script: (step: ScriptStep, ctx: RunContext, emit: Emit) => Promise<ScriptOutcome>;
  /** Obligations: one `agent_query` per query the step makes, carrying the prompt file, model,
   *  allowlist and context policy it ran with; one `agent_tool_call` per tool invocation, with
   *  its arguments; and one `agent_result` when the step is done, carrying the verdict JSON if
   *  the step has a schema and the final text otherwise (spec §6.5). */
  agent: (step: AgentStep, ctx: RunContext, emit: Emit) => Promise<AgentOutcome>;
}

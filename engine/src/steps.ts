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
  timeoutMs?: number;
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

/** The two step kinds that do real work are injected, so the runner is testable with fakes. */
export interface Executors {
  script: (step: ScriptStep, ctx: RunContext, emit: Emit) => Promise<ScriptOutcome>;
  agent: (step: AgentStep, ctx: RunContext, emit: Emit) => Promise<AgentOutcome>;
}

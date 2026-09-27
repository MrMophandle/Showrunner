import path from "node:path";
import type { EventLog, Event } from "./events.js";
import { orderSteps } from "./pipeline.js";
import { deriveRunState, type GateState, type RunState } from "./state.js";
import { hashFiles, sameHashes } from "./hash.js";
import { parseEpisodeId } from "./ids.js";
import type {
  AgentStep, Emit, Executors, GateStep, LoopStep, Pipeline, RunContext, ScriptStep, Step, StepId,
} from "./steps.js";

export interface RunOptions {
  pipeline: Pipeline;
  ctx: Omit<RunContext, "results">;
  log: EventLog;
  executors: Executors;
  /** Logs of earlier runs of the same episode, consulted for cached step hashes. */
  priorLogs?: EventLog[];
}

export type RunResult =
  | { status: "completed" }
  | { status: "failed"; stepId: StepId; error: string }
  | { status: "waiting"; gate: GateState };

export async function answerGate(
  log: EventLog, runId: string, stepId: StepId,
  answer: { approved: boolean; notes?: string; by?: string },
): Promise<void> {
  const state = deriveRunState(await log.read());
  if (!state.openGate || state.openGate.stepId !== stepId) {
    throw new Error(`gate ${JSON.stringify(stepId)} is not open on run ${runId}`);
  }
  const waitedMs = Date.now() - new Date(state.openGate.openedAt).getTime();
  const payload: Record<string, unknown> = { approved: answer.approved, waitedMs, attempt: state.openGate.attempt };
  if (answer.notes !== undefined) payload["notes"] = answer.notes;
  if (answer.by !== undefined) payload["by"] = answer.by;
  await log.append({ runId, stepId, kind: "gate_answered", payload });
}

type Hashes = Record<string, string | null>;

interface CachedCompletion { inputHashes: Hashes; outputHashes: Hashes; result?: unknown }

/** The most recent step_completed for a step across a set of logs, newest log last. */
function lastCompletion(stepId: StepId, logs: Event[][]): CachedCompletion | undefined {
  for (let i = logs.length - 1; i >= 0; i--) {
    const events = logs[i] ?? [];
    for (let j = events.length - 1; j >= 0; j--) {
      const e = events[j];
      if (!e || e.stepId !== stepId) continue;
      if (e.kind === "step_completed" || e.kind === "step_cached") {
        const inputHashes = e.payload["inputHashes"];
        const outputHashes = e.payload["outputHashes"];
        if (inputHashes && outputHashes) {
          const c: CachedCompletion = { inputHashes: inputHashes as Hashes, outputHashes: outputHashes as Hashes };
          if ("result" in e.payload) c.result = e.payload["result"];
          return c;
        }
      }
    }
  }
  return undefined;
}

/** The error recorded by the most recent step_failed for a step, or a stand-in when the log
 *  records the failure without one (an older log, or a crash between the two writes). */
function lastFailure(events: Event[], stepId: StepId): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.kind === "step_failed" && e.stepId === stepId && typeof e.payload["error"] === "string") {
      return e.payload["error"];
    }
  }
  return "failed in an earlier attempt";
}

/** The runs in flight, keyed by the resolved path of the log each one is writing. The log is
 *  append-only and its read-derive-append cycle is not atomic, so two runs over one file would
 *  each derive state from a log the other is still writing and duplicate every step. */
const active = new Map<string, Promise<RunResult>>();

export async function run(opts: RunOptions): Promise<RunResult> {
  const key = path.resolve(opts.log.path);
  if (active.has(key)) throw new Error(`run already in progress for ${key}`);
  const running = execute(opts);
  active.set(key, running);
  try {
    return await running;
  } finally {
    active.delete(key);
  }
}

async function execute(opts: RunOptions): Promise<RunResult> {
  const { pipeline, log, executors } = opts;
  // Validate the episode id at entry: every path the run touches is built from it.
  parseEpisodeId(opts.ctx.episodeId);
  const ordered = orderSteps(pipeline);
  const priorEvents: Event[][] = [];
  for (const pl of opts.priorLogs ?? []) priorEvents.push(await pl.read());

  // The log is read exactly once per run. Every append below also pushes onto this array, so it
  // stays the current contents of the file without the file being re-read per step.
  const events: Event[] = await log.read();
  const append = async (e: Omit<Event, "ts">): Promise<void> => { events.push(await log.append(e)); };

  if (events.length === 0) {
    await append({ runId: opts.ctx.runId, kind: "run_started", payload: { pipeline: pipeline.name, episodeId: opts.ctx.episodeId } });
  }

  const state: RunState = deriveRunState(events);
  if (state.finished) {
    if (state.status === "completed") return { status: "completed" };
    const failedId = Object.entries(state.steps).find(([, v]) => v === "failed")?.[0] ?? "";
    return { status: "failed", stepId: failedId, error: lastFailure(events, failedId) };
  }
  if (state.openGate) return { status: "waiting", gate: state.openGate };

  const ctx: RunContext = { ...opts.ctx, results: { ...state.results } };
  const emitFor = (stepId: StepId | undefined): Emit => async (kind, payload) => {
    await append(stepId === undefined
      ? { runId: ctx.runId, kind, payload }
      : { runId: ctx.runId, stepId, kind, payload });
  };

  for (const step of ordered) {
    const status = state.steps[step.id] ?? "pending";
    if (status === "completed") continue;
    if (status === "failed") {
      // A crash can end a run between the step_failed write and the downstream sweep, so this
      // resume path recovers the real error from the log and completes the sweep the crashed
      // run owed, rather than reporting a placeholder and leaving the log half-written.
      const error = lastFailure(events, step.id);
      await sweep(step);
      return finish({ status: "failed", stepId: step.id, error });
    }
    if (status === "skipped") continue;

    // Dependency check: failed and skipped are distinct reasons.
    let skipReason: string | undefined;
    for (const d of step.dependsOn ?? []) {
      const ds = state.steps[d] ?? "pending";
      if (ds === "failed") { skipReason = `dependency failed: ${d}`; break; }
      if (ds === "skipped") { skipReason = `dependency skipped: ${d}`; break; }
    }
    if (skipReason) {
      await emitFor(step.id)("step_skipped", { reason: skipReason });
      state.steps[step.id] = "skipped";
      continue;
    }

    const outcome = await runStep(step, ctx, emitFor, executors, events, [...priorEvents, events]);
    if (outcome.kind === "completed") {
      state.steps[step.id] = "completed";
      if (outcome.result !== undefined) ctx.results[step.id] = outcome.result;
      continue;
    }
    if (outcome.kind === "waiting") return { status: "waiting", gate: outcome.gate };
    // failed
    state.steps[step.id] = "failed";
    await sweep(step);
    return finish({ status: "failed", stepId: step.id, error: outcome.error });
  }
  return finish({ status: "completed" });

  /** Skip everything downstream of a failure so the log is complete before the run finishes. */
  async function sweep(failedStep: Step): Promise<void> {
    for (const later of ordered) {
      if (later === failedStep) continue;
      const st = state.steps[later.id];
      // Pending steps have no status at all; "running" and "waiting" are what a crash leaves
      // behind, and those are swept too. A terminal status is left exactly as the log records it.
      if (st !== undefined && st !== "running" && st !== "waiting") continue;
      const deps = later.dependsOn ?? [];
      const viaFailed = deps.find((d) => state.steps[d] === "failed");
      const viaSkipped = deps.find((d) => state.steps[d] === "skipped");
      if (viaFailed || viaSkipped) {
        const reason = viaFailed ? `dependency failed: ${viaFailed}` : `dependency skipped: ${viaSkipped}`;
        await emitFor(later.id)("step_skipped", { reason });
        state.steps[later.id] = "skipped";
      }
    }
  }

  async function finish(r: RunResult): Promise<RunResult> {
    await emitFor(undefined)("run_finished", { status: r.status === "completed" ? "completed" : "failed" });
    return r;
  }
}

type StepOutcome =
  | { kind: "completed"; result?: unknown }
  | { kind: "failed"; error: string }
  | { kind: "waiting"; gate: GateState };

async function runStep(
  step: Step, ctx: RunContext, emitFor: (id: StepId | undefined) => Emit,
  executors: Executors, events: Event[], allLogs: Event[][],
): Promise<StepOutcome> {
  const emit = emitFor(step.id);
  switch (step.kind) {
    case "guard": {
      await emit("step_started", { kind: "guard" });
      const r = await step.check(ctx);
      if (r.pass) {
        await emit("step_completed", { result: r.message ?? null });
        return { kind: "completed", result: r.message ?? null };
      }
      await emit("step_failed", { error: r.message });
      return { kind: "failed", error: r.message };
    }
    case "script":
      return runScriptStep(step, ctx, emit, executors, allLogs);
    case "agent":
      return runAgentStep(step, ctx, emit, executors);
    case "gate":
      return runGateStep(step, ctx, emit, executors, emitFor, events);
    case "loop":
      return runLoopStep(step, ctx, emit, executors);
  }
}

async function runScriptStep(
  step: ScriptStep, ctx: RunContext, emit: Emit, executors: Executors, allLogs: Event[][],
): Promise<StepOutcome> {
  const inputs = step.inputs ?? [];
  const outputs = step.outputs ?? [];
  const inputHashes = await hashFiles(ctx.showRoot, inputs);
  const prior = lastCompletion(step.id, allLogs);
  if (prior && inputs.length > 0) {
    const outputHashesNow = await hashFiles(ctx.showRoot, outputs);
    if (sameHashes(prior.inputHashes, inputHashes) && sameHashes(prior.outputHashes, outputHashesNow)) {
      const payload: Record<string, unknown> = { inputHashes, outputHashes: outputHashesNow };
      if (prior.result !== undefined) payload["result"] = prior.result;
      await emit("step_cached", payload);
      return { kind: "completed", ...(prior.result !== undefined ? { result: prior.result } : {}) };
    }
    if (!sameHashes(prior.inputHashes, inputHashes)) {
      await emit("input_changed", { before: prior.inputHashes, after: inputHashes });
    }
  }
  await emit("step_started", { kind: "script", argv: step.argv(ctx), inputHashes });
  const r = await executors.script(step, ctx, emit);
  if (!r.ok) {
    await emit("step_failed", { error: r.error });
    return { kind: "failed", error: r.error };
  }
  const outputHashes = await hashFiles(ctx.showRoot, outputs);
  await emit("step_completed", { inputHashes, outputHashes });
  return { kind: "completed" };
}

async function runAgentStep(step: AgentStep, ctx: RunContext, emit: Emit, executors: Executors): Promise<StepOutcome> {
  const inputHashes = await hashFiles(ctx.showRoot, step.inputs ?? []);
  await emit("step_started", { kind: "agent", inputHashes });
  const r = await executors.agent(step, ctx, emit);
  if (!r.ok) {
    await emit("step_failed", { error: r.error });
    return { kind: "failed", error: r.error };
  }
  const outputHashes = await hashFiles(ctx.showRoot, step.outputs ?? []);
  const result = r.verdict !== undefined ? r.verdict : r.text;
  await emit("step_completed", { inputHashes, outputHashes, result, toolCalls: r.toolCalls });
  return { kind: "completed", result };
}

async function runGateStep(
  step: GateStep, ctx: RunContext, emit: Emit, executors: Executors,
  emitFor: (id: StepId | undefined) => Emit, events: Event[],
): Promise<StepOutcome> {
  const state = deriveRunState(events);
  const attempts = state.gateAttempts[step.id] ?? 0;
  const maxAttempts = step.maxAttempts ?? 10;

  // The log is append-only, so array position is the authoritative order. Never compare timestamps.
  let lastGate: Event | undefined;
  let lastGateAt = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e && e.stepId === step.id && (e.kind === "gate_opened" || e.kind === "gate_answered")) { lastGate = e; lastGateAt = i; }
  }
  if (lastGate?.kind === "gate_opened") {
    return {
      kind: "waiting",
      gate: state.openGate ?? { stepId: step.id, attempt: attempts, message: String(lastGate.payload["message"] ?? ""), openedAt: lastGate.ts },
    };
  }
  const lastAnswer = lastGate?.kind === "gate_answered" ? lastGate : undefined;

  if (lastAnswer) {
    if (lastAnswer.payload["approved"] === true) {
      // deriveRunState already marks it completed; the runner loop skips completed steps, so this
      // branch is reached only when the answer arrived between state derivation and execution.
      return { kind: "completed", result: lastAnswer.payload };
    }
    // Rejected: run the fix agent (if any), then decide whether another attempt is allowed.
    if (attempts >= maxAttempts) {
      const error = `rejected ${attempts} times`;
      await emit("step_failed", { error });
      return { kind: "failed", error };
    }
    // A crash between the fix agent completing and the gate reopening must not run the agent
    // twice: the agent has already edited the files, and a second pass would edit them again.
    const fixId = step.onReject?.id;
    const fixAlreadyDone = fixId !== undefined
      && events.slice(lastGateAt + 1).some((e) => e.kind === "step_completed" && e.stepId === fixId);
    if (step.onReject && !fixAlreadyDone) {
      const notes = lastAnswer.payload["notes"];
      const fixCtx: RunContext = { ...ctx, results: { ...ctx.results, [`${step.id}:rejection`]: notes ?? "" } };
      const fixEmit = emitFor(step.onReject.id);
      await fixEmit("step_started", { kind: "agent", rejectionOf: step.id, attempt: attempts });
      const r = await executors.agent(step.onReject, fixCtx, fixEmit);
      if (!r.ok) {
        await fixEmit("step_failed", { error: r.error });
        await emit("step_failed", { error: `fix agent failed: ${r.error}` });
        return { kind: "failed", error: `fix agent failed: ${r.error}` };
      }
      await fixEmit("step_completed", { result: r.verdict ?? r.text, toolCalls: r.toolCalls });
    }
  }

  const attempt = attempts + 1;
  const message = step.message(ctx);
  await emit("gate_opened", { attempt, message });
  return { kind: "waiting", gate: { stepId: step.id, attempt, message, openedAt: new Date().toISOString() } };
}

async function runLoopStep(step: LoopStep, ctx: RunContext, emit: Emit, executors: Executors): Promise<StepOutcome> {
  await emit("step_started", { kind: "loop", body: step.body.id, until: step.until, max: step.maxIterations });
  for (let iteration = 1; iteration <= step.maxIterations; iteration++) {
    const iterCtx: RunContext = { ...ctx, results: { ...ctx.results, [`${step.body.id}:iteration`]: iteration } };
    const r = await executors.agent(step.body, iterCtx, emit);
    if (!r.ok) {
      await emit("loop_iteration", { iteration, max: step.maxIterations, sentinel: false, toolCalls: 0, error: r.error });
      await emit("step_failed", { error: `iteration ${iteration}: ${r.error}` });
      return { kind: "failed", error: `iteration ${iteration}: ${r.error}` };
    }
    const sentinel = r.text.includes(step.until);
    await emit("loop_iteration", { iteration, max: step.maxIterations, sentinel, toolCalls: r.toolCalls });
    if (sentinel) {
      await emit("step_completed", { result: r.text, iterations: iteration });
      return { kind: "completed", result: r.text };
    }
  }
  const error = `exhausted ${step.maxIterations} iterations without sentinel ${step.until}`;
  await emit("step_failed", { error });
  return { kind: "failed", error };
}

import type { EventLog, Event } from "./events.js";
import { orderSteps } from "./pipeline.js";
import { deriveRunState, type GateState, type RunState } from "./state.js";
import { hashFiles, sameHashes } from "./hash.js";
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

export async function run(opts: RunOptions): Promise<RunResult> {
  const { pipeline, log, executors } = opts;
  const ordered = orderSteps(pipeline);
  const priorEvents: Event[][] = [];
  for (const pl of opts.priorLogs ?? []) priorEvents.push(await pl.read());
  const ownEvents = await log.read();

  if (ownEvents.length === 0) {
    await log.append({ runId: opts.ctx.runId, kind: "run_started", payload: { pipeline: pipeline.name, episodeId: opts.ctx.episodeId } });
  }

  const state: RunState = deriveRunState(await log.read());
  if (state.finished) {
    if (state.status === "completed") return { status: "completed" };
    const failedId = Object.entries(state.steps).find(([, v]) => v === "failed")?.[0] ?? "";
    let error = "failed in an earlier attempt";
    for (let i = ownEvents.length - 1; i >= 0; i--) {
      const e = ownEvents[i];
      if (e && e.kind === "step_failed" && e.stepId === failedId && typeof e.payload["error"] === "string") {
        error = e.payload["error"];
        break;
      }
    }
    return { status: "failed", stepId: failedId, error };
  }
  if (state.openGate) return { status: "waiting", gate: state.openGate };

  const ctx: RunContext = { ...opts.ctx, results: { ...state.results } };
  const emitFor = (stepId: StepId | undefined): Emit => async (kind, payload) => {
    await log.append(stepId === undefined
      ? { runId: ctx.runId, kind, payload }
      : { runId: ctx.runId, stepId, kind, payload });
  };

  for (const step of ordered) {
    const status = state.steps[step.id] ?? "pending";
    if (status === "completed") continue;
    if (status === "failed") return finish({ status: "failed", stepId: step.id, error: "failed in an earlier attempt" });
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

    const outcome = await runStep(step, ctx, emitFor, executors, log, [...priorEvents, await log.read()]);
    if (outcome.kind === "completed") {
      state.steps[step.id] = "completed";
      if (outcome.result !== undefined) ctx.results[step.id] = outcome.result;
      continue;
    }
    if (outcome.kind === "waiting") return { status: "waiting", gate: outcome.gate };
    // failed
    state.steps[step.id] = "failed";
    // Skip everything downstream so the log is complete, then finish.
    const failedId = step.id;
    for (const later of ordered) {
      if (later === step || state.steps[later.id]) continue;
      const deps = later.dependsOn ?? [];
      const viaFailed = deps.find((d) => state.steps[d] === "failed");
      const viaSkipped = deps.find((d) => state.steps[d] === "skipped");
      if (viaFailed || viaSkipped) {
        const reason = viaFailed ? `dependency failed: ${viaFailed}` : `dependency skipped: ${viaSkipped}`;
        await emitFor(later.id)("step_skipped", { reason });
        state.steps[later.id] = "skipped";
      }
    }
    return finish({ status: "failed", stepId: failedId, error: outcome.error });
  }
  return finish({ status: "completed" });

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
  executors: Executors, log: EventLog, allLogs: Event[][],
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
      return runGateStep(step, ctx, emit, executors, log);
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

async function runGateStep(step: GateStep, ctx: RunContext, emit: Emit, executors: Executors, log: EventLog): Promise<StepOutcome> {
  const events = await log.read();
  const state = deriveRunState(events);
  const attempts = state.gateAttempts[step.id] ?? 0;
  const maxAttempts = step.maxAttempts ?? 10;

  // The log is append-only, so array position is the authoritative order. Never compare timestamps.
  let lastGate: Event | undefined;
  for (const e of events) {
    if (e.stepId === step.id && (e.kind === "gate_opened" || e.kind === "gate_answered")) lastGate = e;
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
    if (step.onReject) {
      const notes = lastAnswer.payload["notes"];
      const fixCtx: RunContext = { ...ctx, results: { ...ctx.results, [`${step.id}:rejection`]: notes ?? "" } };
      const fixEmit: Emit = async (kind, payload) => { await log.append({ runId: ctx.runId, stepId: step.onReject!.id, kind, payload }); };
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

import path from "node:path";
import type { EventLog, Event } from "./events.js";
import { downstreamOf, orderSteps } from "./pipeline.js";
import { BYPASS_REASON, deriveRunState, type GateState, type RunState } from "./state.js";
import { hashFiles, sameHashes } from "./hash.js";
import { parseEpisodeId } from "./ids.js";
import type {
  AgentStep, Emit, Executors, GateMessageRenderer, GateStep, GuardResult, LoopStep, Pipeline,
  RunContext, ScriptStep, Step, StepId,
} from "./steps.js";

export interface RunOptions {
  pipeline: Pipeline;
  ctx: Omit<RunContext, "results">;
  log: EventLog;
  executors: Executors;
  /** Logs of earlier runs of the same episode, oldest first, consulted for cached step hashes.
   *  The order is load-bearing: when two of them record a completion of the same step, the one
   *  later in this array wins, so the newest run's hashes are the ones compared against disk. */
  priorLogs?: EventLog[];
  /** Renders a gate's `messageFile`. The runner has no prompts directory and no show config, so
   *  the caller supplies this — `createGateMessageRenderer(agentExecutorOptions)` builds one that
   *  reads the same prompts directory and renders the same variables as the agent steps. A gate
   *  that names a `messageFile` and is run without it fails; a pipeline whose gates all use
   *  `message` never needs it. */
  renderGateMessage?: GateMessageRenderer;
}

export type RunResult =
  | { status: "completed" }
  | { status: "failed"; stepId: StepId; error: string }
  | { status: "waiting"; gate: GateState };

export async function answerGate(
  log: EventLog, runId: string, stepId: StepId,
  answer: { approved: boolean; notes?: string; by?: string; expectedAttempt?: number },
): Promise<void> {
  const events = await log.read();
  // An empty log is named plainly rather than through the run-id mismatch below, whose message
  // would report the run as undefined: the log has no run in it at all, which is what a caller
  // pointed at the wrong episode or a run that never launched needs to be told.
  if (events.length === 0) throw new Error(`no run in the log at ${log.path}`);
  const state = deriveRunState(events);
  // An answer carries the run it answers. A mismatch means the caller is holding a stale run id
  // — a console tab left open across a restart — and the answer would be written into the wrong
  // run's history under a gate that happens to share its step id.
  if (state.runId !== runId) {
    throw new Error(`run id mismatch: the log at ${log.path} is run ${JSON.stringify(state.runId)}, not ${JSON.stringify(runId)}`);
  }
  if (!state.openGate || state.openGate.stepId !== stepId) {
    throw new Error(`gate ${JSON.stringify(stepId)} is not open on run ${runId}`);
  }
  // A console tab left open across a rejection shows an attempt that has since been superseded;
  // an answer that names the attempt it saw cannot answer a newer one it never read.
  if (answer.expectedAttempt !== undefined && answer.expectedAttempt !== state.openGate.attempt) {
    throw new Error(`gate ${JSON.stringify(stepId)} is open at attempt ${state.openGate.attempt}, not ${answer.expectedAttempt}`);
  }
  const waitedMs = Date.now() - new Date(state.openGate.openedAt).getTime();
  const payload: Record<string, unknown> = { approved: answer.approved, waitedMs, attempt: state.openGate.attempt };
  if (answer.notes !== undefined) payload["notes"] = answer.notes;
  if (answer.by !== undefined) payload["by"] = answer.by;
  await log.append({ runId, stepId, kind: "gate_answered", payload });
}

/** Reopens a failed run: appends run_resumed, after which deriveRunState returns the failed step
 *  and every step it swept to pending and the next run() continues from there. Only a run whose
 *  log ends failed can be resumed; a completed run has nothing to continue and a running one is
 *  not finished. */
export async function resumeRun(log: EventLog, runId: string, by?: string): Promise<void> {
  const state = deriveRunState(await log.read());
  if (state.runId !== runId) {
    throw new Error(`run id mismatch: the log at ${log.path} is run ${JSON.stringify(state.runId)}, not ${JSON.stringify(runId)}`);
  }
  if (!state.finished || state.status !== "failed") throw new Error(`run ${runId} is not failed, so there is nothing to resume`);
  await log.append({ runId, kind: "run_resumed", payload: by !== undefined ? { by } : {} });
}

/** The operator's "re-run from here": returns the named steps and every step downstream of them
 *  to pending, so the next run() re-executes them (a script step whose inputs and outputs are
 *  unchanged is served from cache). A finished run is reopened first, with run_resumed, or the
 *  resets would change nothing. Gates are never reset, here or on a rejection: an answer the
 *  showrunner already gave is not invalidated by re-running the work upstream of it, and a reset
 *  gate re-runs on its recorded approval without emitting an event, which would leave
 *  deriveRunState with no status for a gate that was in fact approved. Re-asking an approved gate
 *  is a separate decision; nothing in the engine takes it implicitly. Returns the ids that were
 *  reset, in pipeline order. */
export async function resetSteps(pipeline: Pipeline, log: EventLog, runId: string, stepIds: StepId[], by = "operator"): Promise<StepId[]> {
  const state = deriveRunState(await log.read());
  if (state.runId !== runId) {
    throw new Error(`run id mismatch: the log at ${log.path} is run ${JSON.stringify(state.runId)}, not ${JSON.stringify(runId)}`);
  }
  const byId = new Map(pipeline.steps.map((s) => [s.id, s] as const));
  const ids = downstreamOf(pipeline, stepIds).filter((id) => state.steps[id] !== undefined && byId.get(id)?.kind !== "gate");
  if (state.finished) await log.append({ runId, kind: "run_resumed", payload: { by } });
  for (const id of ids) await log.append({ runId, stepId: id, kind: "step_reset", payload: { by } });
  return ids;
}

type Hashes = Record<string, string | null>;

interface CachedCompletion { inputHashes: Hashes; outputHashes: Hashes; result?: unknown }

/** The most recent step_completed for a step, searching the given logs from the last backwards. */
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
    const started: Record<string, unknown> = { pipeline: pipeline.name, episodeId: opts.ctx.episodeId };
    if (opts.ctx.trigger !== undefined) started["trigger"] = opts.ctx.trigger;
    await append({ runId: opts.ctx.runId, kind: "run_started", payload: started });
  }

  const state: RunState = deriveRunState(events);
  if (state.finished) {
    if (state.status === "completed") return { status: "completed" };
    const failedId = Object.entries(state.steps).find(([, v]) => v === "failed")?.[0] ?? "";
    return { status: "failed", stepId: failedId, error: lastFailure(events, failedId) };
  }
  if (state.openGate) return { status: "waiting", gate: state.openGate };

  const ctx: RunContext = { ...opts.ctx, results: { ...state.results }, events };
  // Every gate's rejection notes are renderable from the first step: an absent key is a
  // TemplateError, so the key exists as [] before any rejection has happened.
  for (const step of ordered) {
    if (step.kind === "gate") ctx.results[`${step.id}:rejections`] ??= [];
  }
  const emitFor = (stepId: StepId | undefined): Emit => async (kind, payload) => {
    await append(stepId === undefined
      ? { runId: ctx.runId, kind, payload }
      : { runId: ctx.runId, stepId, kind, payload });
  };

  // One pass over the ordered steps; a gate rejection that reset upstream steps restarts the
  // pass from the top, where the reset steps are pending again and precede the gate.
  pass: for (;;) {
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
      if (status === "skipped" || status === "bypassed") continue;

      // Dependency check: failed and skipped are distinct reasons. A "bypassed" dependency counts
      // as satisfied — its `when` said this run does not need it, which is not a broken dependency.
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

      // The step's own condition, checked only once its dependencies are known good, so `when` can
      // read what they wrote.
      if (step.when && !(await step.when(ctx))) {
        await emitFor(step.id)("step_skipped", { reason: BYPASS_REASON });
        state.steps[step.id] = "bypassed";
        continue;
      }

      const outcome = await runStep(step, ctx, emitFor, executors, events, [...priorEvents, events], pipeline, opts.renderGateMessage);
      if (outcome.kind === "completed") {
        state.steps[step.id] = "completed";
        if (outcome.result !== undefined) ctx.results[step.id] = outcome.result;
        continue;
      }
      if (outcome.kind === "waiting") return { status: "waiting", gate: outcome.gate };
      if (outcome.kind === "reset") {
        for (const id of outcome.stepIds) { delete state.steps[id]; delete ctx.results[id]; }
        continue pass;
      }
      state.steps[step.id] = "failed";
      await sweep(step);
      return finish({ status: "failed", stepId: step.id, error: outcome.error });
    }
    return finish({ status: "completed" });
  }

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
  | { kind: "waiting"; gate: GateState }
  /** A gate rejection reset these steps; the pass restarts so they run before the gate reopens. */
  | { kind: "reset"; stepIds: StepId[] };

async function runStep(
  step: Step, ctx: RunContext, emitFor: (id: StepId | undefined) => Emit,
  executors: Executors, events: Event[], allLogs: Event[][], pipeline: Pipeline,
  renderGateMessage: GateMessageRenderer | undefined,
): Promise<StepOutcome> {
  const emit = emitFor(step.id);
  switch (step.kind) {
    case "guard": {
      await emit("step_started", { kind: "guard" });
      let r: GuardResult;
      try {
        r = await step.check(ctx);
      } catch (err) {
        // A guard reads files an agent wrote — a shot list it JSON.parses, a run log it reads,
        // a file it hashes — so a malformed write throws here. An escaping throw would leave the
        // log at step_started with neither step_failed nor run_finished, which breaks the rule
        // that the log is the source of truth and leaves a run resumeRun refuses to reopen.
        const error = `guard threw: ${err instanceof Error ? err.message : String(err)}`;
        await emit("step_failed", { error });
        return { kind: "failed", error };
      }
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
      return runGateStep(step, ctx, emit, executors, emitFor, events, pipeline, renderGateMessage);
    case "loop":
      return runLoopStep(step, ctx, emit, executors, events);
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
  await emit("step_completed", { inputHashes, outputHashes, ...(r.result !== undefined ? { result: r.result } : {}) });
  return { kind: "completed", ...(r.result !== undefined ? { result: r.result } : {}) };
}

async function runAgentStep(step: AgentStep, ctx: RunContext, emit: Emit, executors: Executors): Promise<StepOutcome> {
  const inputHashes = await hashFiles(ctx.showRoot, step.inputs ?? []);
  await emit("step_started", { kind: "agent", inputHashes });
  const r = await executors.agent(step, ctx, emit);
  if (!r.ok) {
    await emit("step_failed", { error: r.error, toolCalls: r.toolCalls ?? 0 });
    return { kind: "failed", error: r.error };
  }
  const outputHashes = await hashFiles(ctx.showRoot, step.outputs ?? []);
  const result = r.verdict !== undefined ? r.verdict : r.text;
  await emit("step_completed", { inputHashes, outputHashes, result, toolCalls: r.toolCalls });
  return { kind: "completed", result };
}

async function runGateStep(
  step: GateStep, ctx: RunContext, emit: Emit, executors: Executors,
  emitFor: (id: StepId | undefined) => Emit, events: Event[], pipeline: Pipeline,
  renderGateMessage: GateMessageRenderer | undefined,
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
      // deriveRunState marks an approved gate completed and the pass skips completed steps, so
      // this branch runs only when the gate lost that status after the derivation. Until the
      // reset closure below excluded gates, it ran on every restarted pass that reset an
      // already-approved gate — not only in the race the old comment claimed (an answer arriving
      // between derivation and execution), for which `execute`'s single read of the log leaves no
      // window. What remains is a log carrying a step_reset for this gate from somewhere else: an
      // operator's hand edit, or a run written by an engine older than this filter. The approval
      // in the log still stands, so the gate completes on it.
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
      const fixInputs = await hashFiles(ctx.showRoot, step.onReject.inputs ?? []);
      await fixEmit("step_started", { kind: "agent", rejectionOf: step.id, attempt: attempts, inputHashes: fixInputs });
      const r = await executors.agent(step.onReject, fixCtx, fixEmit);
      if (!r.ok) {
        await fixEmit("step_failed", { error: r.error, toolCalls: r.toolCalls ?? 0 });
        await emit("step_failed", { error: `fix agent failed: ${r.error}` });
        return { kind: "failed", error: `fix agent failed: ${r.error}` };
      }
      const fixOutputs = await hashFiles(ctx.showRoot, step.onReject.outputs ?? []);
      await fixEmit("step_completed", { result: r.verdict ?? r.text, toolCalls: r.toolCalls, inputHashes: fixInputs, outputHashes: fixOutputs });
    }
    // The rejection invalidates the named steps' work. Recorded once per rejection: a crash after
    // these writes and before the re-runs finish must not reset again on resume, or the re-runs
    // would be re-run.
    const resetAlreadyDone = events.slice(lastGateAt + 1)
      .some((e) => e.kind === "step_reset" && e.payload["by"] === step.id);
    if (step.rerunOnReject && step.rerunOnReject.length > 0 && !resetAlreadyDone) {
      // Only steps that have a status are reset: a step that has not run yet is pending already,
      // and a step_reset for it would only be noise in the log. No gate is reset — not this one,
      // and not an earlier gate caught in the closure: an upstream gate's answer is not
      // invalidated by a later gate's rejection, and resetting it would erase an approval from
      // the projection that deriveRunState builds, since the re-run of an approved gate does no
      // work and emits no event.
      const byId = new Map(pipeline.steps.map((s) => [s.id, s] as const));
      const stepIds = downstreamOf(pipeline, step.rerunOnReject)
        .filter((id) => id !== step.id && state.steps[id] !== undefined && byId.get(id)?.kind !== "gate");
      // An empty closure (every named step is downstream of the gate, or none has run) resets
      // nothing and falls through to reopen: returning a reset with no step_reset written would
      // leave resetAlreadyDone false and restart the pass forever.
      if (stepIds.length > 0) {
        for (const id of stepIds) await emitFor(id)("step_reset", { by: step.id, attempt: attempts });
        return { kind: "reset", stepIds };
      }
    }
  }

  const attempt = attempts + 1;
  // A gate the showrunner cannot read is worse than a gate that failed: the message is built
  // before gate_opened, and every way of not having one fails the step instead of opening it.
  // orderSteps has already refused a gate with neither `message` nor `messageFile`, so the last
  // branch is unreachable through `run` and is here because the type permits it.
  let message: string;
  if (step.messageFile !== undefined) {
    if (renderGateMessage === undefined) {
      return failGate(`gate ${JSON.stringify(step.id)}: messageFile needs RunOptions.renderGateMessage`);
    }
    try {
      message = await renderGateMessage(step.messageFile, ctx);
    } catch (err) {
      return failGate(`gate ${JSON.stringify(step.id)}: ${step.messageFile} did not render: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (step.message !== undefined) {
    message = step.message(ctx);
  } else {
    return failGate(`gate ${JSON.stringify(step.id)}: neither message nor messageFile is set`);
  }
  await emit("gate_opened", { attempt, message });
  return { kind: "waiting", gate: { stepId: step.id, attempt, message, openedAt: new Date().toISOString() } };

  async function failGate(error: string): Promise<StepOutcome> {
    await emit("step_failed", { error });
    return { kind: "failed", error };
  }
}

async function runLoopStep(
  step: LoopStep, ctx: RunContext, emit: Emit, executors: Executors, events: Event[],
): Promise<StepOutcome> {
  // Resume the counter. The iterations that count are the ones logged under this step since its
  // most recent step_started: those belong to the attempt that crashed, and the cap counts them,
  // so the cap is per run rather than per process. This is counted before the new step_started
  // is emitted, since that write would otherwise become "the most recent" and reset the count.
  let lastStart = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e && e.stepId === step.id && e.kind === "step_started") lastStart = i;
  }
  let done = 0;
  let lastIteration: Event | undefined;
  let lastText = "";
  for (let i = lastStart + 1; i < events.length; i++) {
    const e = events[i];
    if (!e || e.stepId !== step.id) continue;
    if (e.kind === "loop_iteration") { done++; lastIteration = e; }
    if (e.kind === "agent_result" && typeof e.payload["text"] === "string") lastText = e.payload["text"];
  }

  const inputHashes = await hashFiles(ctx.showRoot, step.inputs ?? []);
  await emit("step_started", { kind: "loop", body: step.body.id, until: step.until, max: step.maxIterations, inputHashes });

  // A crash between the final loop_iteration and step_completed leaves a loop whose sentinel
  // already fired. Resuming it as "done iterations, sentinel unseen" would run the body again or,
  // at the cap, fail a loop that had in fact finished — hours of drafting lost to a lost write.
  if (lastIteration?.payload["sentinel"] === true) {
    const outputHashes = await hashFiles(ctx.showRoot, step.outputs ?? []);
    await emit("step_completed", { inputHashes, outputHashes, result: lastText, iterations: done, resumedAfterSentinel: true });
    return { kind: "completed", result: lastText };
  }

  for (let iteration = done + 1; iteration <= step.maxIterations; iteration++) {
    const iterCtx: RunContext = { ...ctx, results: { ...ctx.results, [`${step.body.id}:iteration`]: iteration } };
    const r = await executors.agent(step.body, iterCtx, emit);
    if (!r.ok) {
      await emit("loop_iteration", { iteration, max: step.maxIterations, sentinel: false, toolCalls: r.toolCalls ?? 0, error: r.error });
      await emit("step_failed", { error: `iteration ${iteration}: ${r.error}` });
      return { kind: "failed", error: `iteration ${iteration}: ${r.error}` };
    }
    const sentinel = r.text.includes(step.until);
    await emit("loop_iteration", { iteration, max: step.maxIterations, sentinel, toolCalls: r.toolCalls });
    if (step.progress) await emit("step_progress", { ...(await step.progress(iterCtx)) });
    if (sentinel) {
      const outputHashes = await hashFiles(ctx.showRoot, step.outputs ?? []);
      await emit("step_completed", { inputHashes, outputHashes, result: r.text, iterations: iteration });
      return { kind: "completed", result: r.text };
    }
  }
  const error = `exhausted ${step.maxIterations} iterations without sentinel ${step.until}`;
  await emit("step_failed", { error });
  return { kind: "failed", error };
}

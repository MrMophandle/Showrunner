import path from "node:path";
import type { EventLog, Event } from "./events.js";
import { downstreamOf, orderSteps, pipelineHash } from "./pipeline.js";
import { ENGINE_VERSION } from "./version.js";
import { BYPASS_REASON, deriveRunState, type GateState, type RunState } from "./state.js";
import { hashFiles, sameHashes } from "./hash.js";
import { isReservedEpisodeId, parseEpisodeId } from "./ids.js";
import { verdictPass } from "./steps.js";
import { panelStopSentence } from "./agent-step.js";
import { DEFAULT_AUTO_RETRY_WEEKLY_UTILIZATION_MAX } from "./show-config.js";
import type {
  AgentStep, Emit, Executors, GateMessageRenderer, GateStep, GuardResult, LoopStep, PanelStep,
  Pipeline, RunContext, ScriptStep, Step, StepId,
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
  /** How many ready agent steps may run at once. Default 1: one step at a time in dependency
   *  order, which is the behaviour every other test assumes. The review panel is the case this
   *  exists for — seven reviewers that depend on the same draft, 35 minutes apart sequential and
   *  concurrent on ep10's logs. Only agent steps are batched; scripts, guards, gates and loops
   *  always run alone. */
  concurrency?: number;
}

export type RunResult =
  | { status: "completed" }
  | { status: "failed"; stepId: StepId; error: string }
  | { status: "waiting"; gate: GateState };

/** The showrunner's answer to an open gate — approve, or reject with notes — as one
 *  `gate_answered` event. This is the only way a gate is answered: the console calls it, the next
 *  `run()` reads the log and takes it from there, and nothing writes the event by hand.
 *
 *  Four refusals, each of them a mistake worth catching before the answer lands in a log:
 *  an empty log (the caller is pointed at an episode or a run that never started), a `runId` that
 *  is not the log's (a console tab held across a restart, whose answer would be written into
 *  another run's history under a gate that shares its step id), a `stepId` that is not the open
 *  gate's, and an `expectedAttempt` that is not the attempt now open — which is the whole
 *  protection against a tab left open across a rejection, where the showrunner would otherwise
 *  approve a message a fix agent has already superseded.
 *
 *  `waitedMs` is stamped from the gate's `openedAt`, so the log records how long the run sat
 *  waiting on a person; `notes` and `by` are recorded when the caller gives them. A rejection
 *  resets nothing here: the next `run()` re-executes the gate, which runs its fix agent, re-runs
 *  the gate's `rerunOnReject` set and reopens the gate at the next attempt. */
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

/** Rejects a gate the showrunner already approved — the "re-ask" the record of Plan D asked for.
 *  Everything downstream of the gate is reset (never another gate: a later gate's approval is its
 *  own answer and survives), then a rejection answer is appended with `withdrawn: true`, so the
 *  next run() takes the ordinary rejection path: the fix agent, the gate's own re-run set, and
 *  the gate reopened at the next attempt. Refused while any gate is open (answer it instead), and
 *  for a gate whose last answer is not an approval. A finished run is reopened first. */
export async function withdrawApproval(
  pipeline: Pipeline, log: EventLog, runId: string, stepId: StepId, answer: { notes: string; by: string },
): Promise<StepId[]> {
  const events = await log.read();
  if (events.length === 0) throw new Error(`no run in the log at ${log.path}`);
  const state = deriveRunState(events);
  if (state.runId !== runId) {
    throw new Error(`run id mismatch: the log at ${log.path} is run ${JSON.stringify(state.runId)}, not ${JSON.stringify(runId)}`);
  }
  if (state.openGate) throw new Error(`gate ${JSON.stringify(state.openGate.stepId)} is open; answer it instead`);
  let last: Event | undefined;
  for (const e of events) if (e.stepId === stepId && (e.kind === "gate_opened" || e.kind === "gate_answered")) last = e;
  if (!last || last.kind !== "gate_answered" || last.payload["approved"] !== true) {
    throw new Error(`gate ${JSON.stringify(stepId)} is not approved on run ${runId}`);
  }
  const byId = new Map(pipeline.steps.map((s) => [s.id, s] as const));
  const ids = downstreamOf(pipeline, [stepId]).filter((id) => id !== stepId && byId.get(id)?.kind !== "gate" && state.steps[id] !== undefined);
  if (state.finished) await log.append({ runId, kind: "run_resumed", payload: { by: answer.by } });
  for (const id of ids) await log.append({ runId, stepId: id, kind: "step_reset", payload: { by: `withdraw:${stepId}` } });
  await log.append({ runId, stepId, kind: "gate_answered", payload: { approved: false, notes: answer.notes, by: answer.by, withdrawn: true, attempt: Number(last.payload["attempt"] ?? state.gateAttempts[stepId] ?? 1) } });
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
  // Validate the episode id at entry: every path the run touches is built from it. The one
  // exemption is the reserved id the bible interview runs under (ids.ts): it names no episode,
  // builds no episode path — the interview hands `log` a path of its own — and would otherwise
  // fail here before a single event was written. Nothing else is exempt, so a bogus id is still
  // refused at entry rather than halfway through a run.
  if (!isReservedEpisodeId(opts.ctx.episodeId)) parseEpisodeId(opts.ctx.episodeId);
  const ordered = orderSteps(pipeline);
  const priorEvents: Event[][] = [];
  for (const pl of opts.priorLogs ?? []) priorEvents.push(await pl.read());

  // The log is read exactly once per run. Every append below also pushes onto this array, so it
  // stays the current contents of the file without the file being re-read per step.
  const events: Event[] = await log.read();
  // Appends are chained so that the events array and the file agree on order even when several
  // agent steps are emitting at once: the log's order is authoritative and must be the order the
  // calls were made in, not the order their writes happened to resolve.
  let tail: Promise<unknown> = Promise.resolve();
  const append = (e: Omit<Event, "ts">): Promise<void> => {
    const next = tail.then(async () => { events.push(await log.append(e)); });
    tail = next.catch(() => undefined);
    return next;
  };

  if (events.length === 0) {
    const started: Record<string, unknown> = { pipeline: pipeline.name, episodeId: opts.ctx.episodeId, engineVersion: ENGINE_VERSION, pipelineHash: pipelineHash(pipeline) };
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

      // The batch: this step, plus — when it is an agent step and the cap allows — every later
      // agent step in `ordered` whose dependencies are already terminal. Only agent steps are
      // batched, so a script, guard, gate or loop step is always a batch of one, which is exactly
      // the sequential path this code replaced.
      const concurrency = Math.max(1, opts.concurrency ?? 1);
      const batch: Step[] = [step];
      if (step.kind === "agent" && concurrency > 1) {
        for (const later of ordered) {
          if (batch.length >= concurrency) break;
          if (later === step || later.kind !== "agent" || batch.includes(later)) continue;
          if ((state.steps[later.id] ?? "pending") !== "pending") continue;
          const ready = (later.dependsOn ?? []).every((d) => ["completed", "bypassed"].includes(state.steps[d] ?? "pending"));
          if (!ready) continue;
          if (later.when && !(await later.when(ctx))) {
            await emitFor(later.id)("step_skipped", { reason: BYPASS_REASON });
            state.steps[later.id] = "bypassed";
            continue;
          }
          batch.push(later);
        }
      }
      const outcomes = await Promise.all(batch.map((s) => runStep(s, ctx, emitFor, executors, events, [...priorEvents, events], pipeline, opts.renderGateMessage)));
      // Outcomes are applied in pipeline order once the whole batch has settled: the first
      // failure in that order is the one the run reports, however the executors finished.
      let failed: { step: Step; error: string } | undefined;
      let reset: StepId[] | undefined;
      let waiting: GateState | undefined;
      for (let i = 0; i < batch.length; i++) {
        const s = batch[i]!;
        const outcome = outcomes[i]!;
        if (outcome.kind === "completed") {
          state.steps[s.id] = "completed";
          if (outcome.result !== undefined) ctx.results[s.id] = outcome.result;
        } else if (outcome.kind === "waiting") {
          waiting = outcome.gate;
        } else if (outcome.kind === "reset") {
          reset = outcome.stepIds;
        } else if (!failed) {
          state.steps[s.id] = "failed";
          failed = { step: s, error: outcome.error };
        } else {
          state.steps[s.id] = "failed";
        }
      }
      if (failed) { await sweep(failed.step); return finish({ status: "failed", stepId: failed.step.id, error: failed.error }); }
      if (waiting) return { status: "waiting", gate: waiting };
      if (reset) {
        for (const id of reset) { delete state.steps[id]; delete ctx.results[id]; }
        continue pass;
      }
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
  /** A gate rejection or a red panel round reset these steps; the pass restarts so they run again
   *  before the gate reopens or the panel judges them a second time. */
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
    case "panel":
      return runPanelStep(step, ctx, emit, emitFor, events, pipeline);
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
      // This wording is depended on outside the engine: `tools/src/init/init.ts`'s
      // `GATE_EXHAUSTED` matches `/: gate failed: rejected \d+ times?$/` against it, so that the
      // bible interview can treat one file's exhausted gate as a stall and carry on with the rest
      // of the bible. Reword it and that becomes an abort. A rewording breaks a test rather than a
      // run (`tools/test/init.test.ts` exercises exhaustion against the real engine).
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
      message = await renderGateMessage(step.messageFile, ctx, step.vars);
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
  // Resume the counter, and the rule has two halves.
  //
  // **A crashed attempt keeps its count.** The iterations logged under this step since its most
  // recent step_started belong to the attempt that crashed, and the cap counts them, so the cap is
  // per run rather than per process: a loop that drafted twice of three before the machine died
  // resumes at iteration three. This is counted before the new step_started is emitted, since that
  // write would otherwise become "the most recent" and reset the count.
  //
  // **A finished attempt does not.** A step_failed or a step_reset for this step *after* that
  // step_started ended the attempt — the loop exhausted its cap and failed, or a gate rejection or
  // resetSteps invalidated it — and the next pass is a new attempt that starts at iteration one.
  // Without this, Resume on a loop that failed at its cap could never run: `done` would already be
  // the cap, the loop below would not execute once, and the step would fail again in the same
  // millisecond with the same sentence (measured on the s02e01 run of 2026-10-15, where Resume
  // appended run_resumed, step_started and step_failed with no agent_query between them). The
  // sentinel shortcut below is discarded with the count, or a loop reset after its sentinel had
  // fired would complete again without re-running a body whose work was just invalidated.
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
    if (e.kind === "step_failed" || e.kind === "step_reset") { done = 0; lastIteration = undefined; lastText = ""; continue; }
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

/** The reset batch's signature in `step_reset.payload.by`, and the panel's idempotence anchor: the
 *  panel's id and the round whose work the batch invalidated. The gate writes its own id there
 *  (`runGateStep`) and `resetSteps` writes `"operator"`; a round needs the number too, because a
 *  panel resets the same ten steps every round and "has this reset already happened" is a question
 *  about one round. The colon is safe: `orderSteps` refuses a step id that contains one. */
function panelResetBy(stepId: StepId, round: number): string {
  return `panel:${stepId}:round-${round}`;
}

/** The weekly quota as a percentage, read backwards out of the log, or undefined when the question
 *  has no answer in it.
 *
 *  **Only `agent_result.usage.sevenDay.utilization`, and only after the last `run_resumed`.** The
 *  first half is the source Plan J attaches to every query: the 2026-10-15 probe measured that an
 *  ordinary unlimited query's stream carries no seven-day `rate_limit_event` at all, so the SDK's
 *  usage call is the only source and `limit.weeklyUtilization` exists only on a classified limit.
 *  The second half is the Resume rule: the figure that stopped the run is still in the log, and a
 *  panel that read it would fail again in the same millisecond on the operator's Resume — the same
 *  fault `8c75077` fixed for a loop's iteration count. After a Resume the panel therefore knows no
 *  weekly figure until the reviewers have queried again, and an unknown figure never stops the loop
 *  (Plan I stops on a known figure; a run whose steps report no usage at all must go round again
 *  rather than halt). */
function latestWeeklyUtilization(events: readonly Event[]): number | undefined {
  let from = 0;
  for (let i = 0; i < events.length; i++) if (events[i]?.kind === "run_resumed") from = i + 1;
  for (let i = events.length - 1; i >= from; i--) {
    const e = events[i];
    if (!e || e.kind !== "agent_result") continue;
    const usage = e.payload["usage"];
    if (typeof usage !== "object" || usage === null) continue;
    const sevenDay = (usage as { sevenDay?: unknown }).sevenDay;
    if (typeof sevenDay !== "object" || sevenDay === null) continue;
    const u = (sevenDay as { utilization?: unknown }).utilization;
    if (typeof u === "number" && Number.isFinite(u)) return u;
  }
  return undefined;
}

/** What the review and the revision of this script have cost so far, in US dollars: the sum over the
 *  round's own steps of `agent_result.costUsd`, **taking the maximum per session rather than adding
 *  every event**.
 *
 *  The maximum is not a rounding choice, it is what `total_cost_usd` means (inventory J-08): the
 *  SDK's figure is cumulative **per session**, so the three iterations of one shared-session step on
 *  the s02e01 run each reported `costUsd: 6.587001` and adding them would have billed the showrunner
 *  three times for one conversation. Every step in a round is `context: "fresh"` after Plan J, so
 *  each session contributes one event and the maximum is that event's figure; the rule is written as
 *  a maximum anyway, because a shared session added later would otherwise be multiplied silently.
 *  An `agent_result` with no session id is keyed on its own position in the log, so it counts once
 *  and never collapses with an unrelated event.
 *
 *  **The round's own steps, which is what excludes the draft.** The ids are the panel's `reviewers`
 *  and `resets` — the reviewers, the canon review and the writer's revision — and nothing else, so
 *  the figure is the one the gate's message calls "of review and revision" ($15.89 on the measured
 *  round, against $75.31 for the whole write phase, §2.4). That is also why no start index is
 *  needed: none of those steps can have run before the draft that produced the script they read.
 *
 *  Rounded to four decimals, the money format the console already prints
 *  (`console/src/pages/WhatHappened.tsx`), so a prompt renders `15.8878` rather than a float's tail. */
function roundCostUsd(events: readonly Event[], ids: ReadonlySet<StepId>): number {
  const perSession = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || e.kind !== "agent_result" || e.stepId === undefined || !ids.has(e.stepId)) continue;
    const cost = e.payload["costUsd"];
    if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
    const sessionId = e.payload["sessionId"];
    const key = typeof sessionId === "string" && sessionId !== "" ? `session:${sessionId}` : `event:${i}`;
    perSession.set(key, Math.max(perSession.get(key) ?? 0, cost));
  }
  let total = 0;
  for (const v of perSession.values()) total += v;
  return Math.round(total * 10_000) / 10_000;
}

/** Whether the pass has reached a step again after the given position in the log — the test for
 *  "this step has re-run since the reset that invalidated it", which is the second half of the
 *  panel's idempotence guard.
 *
 *  Three terminal events count, not one: a step that completed, a script step whose inputs and
 *  outputs were unchanged and was served from cache, and a step its own `when` turned off this time
 *  round. All three mean the pass visited it, which is what the guard is asking; counting only
 *  `step_completed` would read a legitimately bypassed step as work still owed and send the round
 *  back for another pass. A step that re-ran and *failed* is not here because the panel is never
 *  reached in that pass — its dependency failed and the runner skips it. */
function visitedAfter(events: readonly Event[], stepId: StepId, from: number): boolean {
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i];
    if (!e || e.stepId !== stepId) continue;
    if (e.kind === "step_completed" || e.kind === "step_cached" || e.kind === "step_skipped") return true;
  }
  return false;
}

/** The review round: read the reviewers' verdicts, and either open the way downstream or invalidate
 *  the round's work and make the pass run it again. This is the trigger the inventory found missing
 *  (J-01, J-02) on the reset path a gate rejection already had.
 *
 *  **The round's number comes from the log and nothing else.** It is one more than the number of
 *  `panel_round` events this step has written, counted over the whole run — not since this step's
 *  last `step_started`, the way a loop counts its iterations, and **not** reset by `run_resumed`,
 *  because a Resume continues the loop rather than starting it over. Nothing is held in memory
 *  across a reset (spec §6.5); the log is the record of how many rounds this script has cost.
 *
 *  **The idempotence guard has two clauses, and the second one is what makes it right.** The first
 *  is the plan's: a `step_reset` signed `panel:<id>:round-<N>` already stands after this step's last
 *  `step_started`, so the writes of round N happened. That alone is not enough to decide anything,
 *  because it is *also* true on the ordinary restarted pass — the batch is written after the
 *  `step_started` of the round that wrote it — and a step that answered "already done, reset again"
 *  there would reset a panel whose reviewers had just re-run, and pay seven more agent calls
 *  ($6.07, §2.2) for a verdict it already had. So the second clause asks whether the restart
 *  actually happened: has every step in the batch completed since it? If one has not, the batch was
 *  written by a run that died before the re-runs finished, and this call returns the reset again
 *  **without writing a second batch or a second round**. If they all have, the verdicts in
 *  `ctx.results` are the re-run ones and this is round N+1, which is the ordinary case.
 *
 *  **The weekly stop is the only stop** (Ryan's ruling of 2026-10-15). There is no round cap: a red
 *  round resets and the pass runs again, however many times, unless the week's quota is at or above
 *  the show's `agents.autoRetryWeeklyUtilizationMax`. Then the step fails with
 *  `panelStopSentence` — the operator's own sentence, with both numbers — and writes **nothing
 *  else**: no `panel_round`, no `step_reset`. So the round the operator resumes into is the same
 *  round N, and the Resume re-evaluates the verdicts that are still in the log and then resets. */
async function runPanelStep(
  step: PanelStep, ctx: RunContext, emit: Emit, emitFor: (id: StepId | undefined) => Emit,
  events: Event[], pipeline: Pipeline,
): Promise<StepOutcome> {
  // Both readings of the log are taken before this entry's step_started is appended: that write
  // would otherwise become "this step's last step_started" and move the anchor the guard measures
  // from. The log is append-only, so array position is the authoritative order.
  let lastStart = -1;
  let written = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || e.stepId !== step.id) continue;
    if (e.kind === "step_started") lastStart = i;
    if (e.kind === "panel_round") written++;
  }
  const round = written + 1;

  // The round's batch, as the log holds it: which ids were reset for the last round written, and
  // where the last of those writes sits, so "has this step re-run since" has a position to measure
  // from.
  const priorBy = panelResetBy(step.id, written);
  let batchAt = -1;
  const batched: StepId[] = [];
  for (let i = lastStart + 1; i < events.length; i++) {
    const e = events[i];
    if (e && e.kind === "step_reset" && e.stepId !== undefined && e.payload["by"] === priorBy) {
      batchAt = i;
      batched.push(e.stepId);
    }
  }

  await emit("step_started", { kind: "panel", round, reviewers: [...step.reviewers] });

  // The ids a red round invalidates: everything the step declares, its own id included — the one
  // that returns the panel itself to pending so the restarted pass evaluates the re-run verdicts.
  // No gate, ever: an approval the showrunner already gave is not invalidated by a review round, and
  // resetting a gate would erase that answer from the projection (the rule `runGateStep` states at
  // its own closure). Deduplicated, because a pipeline that names the panel in its own `resets` — as
  // the episode pipeline does, so the list reads as the whole round — must not write two.
  //
  // Unlike a gate's closure this list is **not** filtered to steps that already have a status. The
  // batch is also the log's record of the round, and the guard above reads it back to decide whether
  // a crashed run owed the re-runs; a batch written short of its own declaration would make that
  // record ambiguous. A `step_reset` for a step that was pending anyway costs one line in the log
  // and changes nothing in the projection.
  const byId = new Map(pipeline.steps.map((s) => [s.id, s] as const));
  const plannedResets = [...new Set([...step.resets, step.id])]
    .filter((id) => byId.has(id) && byId.get(id)?.kind !== "gate");

  if (written > 0 && batchAt >= 0) {
    // Every step the batch invalidated **except this one**: the panel's own re-run is this call, and
    // it has no completion after its own batch by construction — measuring itself would make the
    // guard fire on every ordinary restarted pass, which is the fault the second clause exists to
    // avoid. Whatever the outcome, the `step_started` emitted above has moved the anchor past this
    // batch, so the guard answers at most once per entry and a log it cannot read its way out of
    // still makes progress.
    const stale = [...new Set([...batched, ...plannedResets])]
      .filter((id) => id !== step.id && !visitedAfter(events, id, batchAt));
    if (stale.length > 0) {
      // Round `written`'s writes stand and its re-runs do not. Nothing is written here — a second
      // batch would reset steps that had already re-run, and a second `panel_round` would charge
      // the run a round it never reviewed.
      return { kind: "reset", stepIds: plannedResets };
    }
  }

  // The verdicts. A reviewer with no result at all is a fault rather than a red verdict: the panel
  // cannot judge what it cannot read, and calling it red would loop forever on a step that will
  // never produce one. The ordered walk and `orderSteps`' reviewers-must-be-dependencies rule make
  // this unreachable through `run`; it is here because a hand-built pipeline can still get there.
  const absent = step.reviewers.filter((id) => !Object.prototype.hasOwnProperty.call(ctx.results, id));
  if (absent.length > 0) {
    const error = `panel ${JSON.stringify(step.id)}: no verdict from ${absent.map((id) => JSON.stringify(id)).join(", ")}`;
    await emit("step_failed", { error });
    return { kind: "failed", error };
  }
  const costIds = new Set([...step.reviewers, ...step.resets].filter((id) => id !== step.id));
  const red = step.reviewers.filter((id) => !verdictPass(ctx.results[id]));
  if (red.length === 0) {
    const result = { round, green: true };
    // The green round carries the cost figure too, and that is what makes the gate's sentence true.
    // A reader that took the figure from the last `panel_round` alone would print what the run had
    // spent when the last round came back **red** — on the measured figures that is the whole
    // revision and the whole closing panel missing, 60% of the real total — because a green round
    // writes no `panel_round` and the final reviewers' `agent_result`s land after the last one. The
    // panel is the only reader that knows which steps are the round's, so it is the one that counts
    // them, at both of its exits.
    await emit("step_completed", { result, round, green: true, costUsd: roundCostUsd(events, costIds) });
    return { kind: "completed", result };
  }

  // Red. The weekly quota decides whether the loop goes round again or hands the run to the
  // operator; the figure and the ceiling are both read here so the sentence and the decision cannot
  // disagree.
  const weekly = latestWeeklyUtilization(events);
  const ceiling = ctx.show?.agents?.autoRetryWeeklyUtilizationMax ?? DEFAULT_AUTO_RETRY_WEEKLY_UTILIZATION_MAX;
  if (weekly !== undefined && weekly >= ceiling) {
    const error = panelStopSentence({ round, weekly, ceiling });
    await emit("step_failed", { error });
    return { kind: "failed", error };
  }

  // The round, as the log will carry it. `verdicts` is keyed on every id this round resets whose
  // result the run has — the reviewers' seven, and the writer's own round report — because the reset
  // on the next line deletes all of them from the derived state, and the prompts of the next round
  // read them back from this event as `{{prior.<id>}}` (J-14). The writer's own report is in there on
  // purpose: a reviewer is told what the writer said it changed, and the writer is reminded what it
  // promised last round.
  const verdicts: Record<StepId, unknown> = {};
  for (const id of [...new Set([...step.reviewers, ...step.resets])]) {
    if (id === step.id) continue;
    if (Object.prototype.hasOwnProperty.call(ctx.results, id)) verdicts[id] = ctx.results[id];
  }
  const by = panelResetBy(step.id, round);
  await emit("panel_round", {
    round, green: false, verdicts,
    costUsd: roundCostUsd(events, costIds),
    ...(weekly !== undefined ? { weeklyUtilization: weekly } : {}),
    by,
  });
  for (const id of plannedResets) await emitFor(id)("step_reset", { by, round });
  return { kind: "reset", stepIds: plannedResets };
}

import { createHash } from "node:crypto";
import type { Pipeline, Step, StepId } from "./steps.js";

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineError";
  }
}

/** The ids of the steps nested inside a top-level step: a gate's fix agent and a loop's body. */
function nestedIdsOf(step: Step): StepId[] {
  if (step.kind === "gate") return step.onReject ? [step.onReject.id] : [];
  if (step.kind === "loop") return [step.body.id];
  return [];
}

/** The named steps plus every step that depends on one of them, transitively, in pipeline order.
 *  This is what a gate rejection resets and what an operator's "re-run from here" re-runs: a
 *  step whose input was remade cannot keep a result computed from the old one. */
export function downstreamOf(p: Pipeline, ids: StepId[]): StepId[] {
  const known = new Set(p.steps.map((s) => s.id));
  for (const id of ids) {
    if (!known.has(id)) throw new PipelineError(`unknown step ${JSON.stringify(id)} in pipeline ${p.name}`);
  }
  const marked = new Set<StepId>(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of p.steps) {
      if (marked.has(s.id)) continue;
      if ((s.dependsOn ?? []).some((d) => marked.has(d))) { marked.add(s.id); grew = true; }
    }
  }
  return p.steps.filter((s) => marked.has(s.id)).map((s) => s.id);
}

/** Kahn's algorithm, preferring declaration order among steps that are ready. */
export function orderSteps(p: Pipeline): Step[] {
  const byId = new Map<StepId, Step>();
  for (const s of p.steps) {
    if (byId.has(s.id)) throw new PipelineError(`duplicate step id ${JSON.stringify(s.id)} in pipeline ${p.name}`);
    byId.set(s.id, s);
  }
  // Nested ids share one namespace with the top-level ids: a gate's fix agent logs its events
  // under its own id, and a loop's body names the `<body-id>:iteration` result key, so a
  // collision would silently merge two steps' histories.
  const nested = new Set<StepId>();
  for (const s of p.steps) {
    for (const n of nestedIdsOf(s)) {
      if (byId.has(n)) {
        throw new PipelineError(`nested step id ${JSON.stringify(n)} in ${JSON.stringify(s.id)} duplicates a top-level step id in pipeline ${p.name}`);
      }
      if (nested.has(n)) {
        throw new PipelineError(`duplicate nested step id ${JSON.stringify(n)} in pipeline ${p.name}`);
      }
      nested.add(n);
    }
  }
  // A loop's sentinel is matched against the body's final text, and a body with a schema has no
  // prose final text of its own — its `text` is the serialized verdict — so the sentinel would be
  // matched against JSON. Refusing the combination at load time beats a loop that never ends.
  for (const s of p.steps) {
    if (s.kind === "loop" && s.body.schema !== undefined) {
      throw new PipelineError(`loop ${JSON.stringify(s.id)}: the body carries a schema, so its final text is the serialized verdict and a prose sentinel would match substrings of the JSON; give the body no schema, or wait for an untilVerdict predicate (Plan D)`);
    }
  }
  // A colon in any id would collide with the runner's reserved result keys `<id>:rejection`
  // (a gate's rejection notes) and `<id>:iteration` (a loop body's iteration number).
  for (const id of [...byId.keys(), ...nested]) {
    if (id.includes(":")) {
      throw new PipelineError(`step id ${JSON.stringify(id)} contains ":", which is reserved for the runner's result keys, in pipeline ${p.name}`);
    }
  }
  for (const s of p.steps) {
    for (const d of s.dependsOn ?? []) {
      if (!byId.has(d)) throw new PipelineError(`step ${JSON.stringify(s.id)} depends on unknown step ${JSON.stringify(d)}`);
    }
  }
  for (const s of p.steps) {
    if (s.kind !== "gate") continue;
    // Exactly one source for the message the showrunner is shown. Neither leaves the gate with
    // nothing to open with; both leave two answers with no rule for which wins. Either is a
    // mistake worth catching at load time rather than hours in, when the gate is reached.
    const hasMessage = s.message !== undefined;
    const hasMessageFile = s.messageFile !== undefined;
    if (hasMessage === hasMessageFile) {
      throw new PipelineError(`gate ${JSON.stringify(s.id)} sets ${hasMessage ? "both message and messageFile" : "neither message nor messageFile"}; set exactly one, in pipeline ${p.name}`);
    }
    for (const r of s.rerunOnReject ?? []) {
      if (!byId.has(r)) throw new PipelineError(`gate ${JSON.stringify(s.id)} names unknown step ${JSON.stringify(r)} in rerunOnReject`);
    }
  }
  const remaining = new Map<StepId, Set<StepId>>();
  for (const s of p.steps) remaining.set(s.id, new Set(s.dependsOn ?? []));
  const out: Step[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const s of p.steps) {
      const deps = remaining.get(s.id);
      if (!deps || deps.size > 0) continue;
      out.push(s);
      remaining.delete(s.id);
      for (const other of remaining.values()) other.delete(s.id);
      progressed = true;
      break;
    }
    if (!progressed) {
      throw new PipelineError(`cycle among steps: ${[...remaining.keys()].join(", ")}`);
    }
  }
  return out;
}

/** One step as plain data: the names, edges, files and bounds it declares, with every function it
 *  carries reduced to a flag or dropped. Separate from `Step` because `Step` holds live code —
 *  `argv`, `when`, `check`, `message`, `progress` — which neither a reader nor a hash can hold. */
export interface StepDescription {
  id: StepId; kind: Step["kind"]; dependsOn: StepId[]; inputs: string[]; outputs: string[];
  /** Whether the step carries a `when` predicate; the predicate itself is code and not described. */
  when: boolean;
  timeoutMs?: number; promptFile?: string; schemaFile?: string; model?: string; allowedTools?: string[]; context?: "fresh" | "shared";
  idleTimeoutMs?: number; messageFile?: string; maxAttempts?: number; rerunOnReject?: StepId[];
  onReject?: { id: StepId; promptFile: string; model: string }; body?: { id: StepId; promptFile: string; model: string };
  until?: string; maxIterations?: number; cwd?: string;
}

/** A whole pipeline as plain data — the name a run records and its steps in declaration order.
 *  This is the shape `pipelineHash` hashes and the shape a console or a report renders. */
export interface PipelineDescription { name: string; steps: StepDescription[] }

/** The pipeline as a document: every name, edge, file and bound a step declares, with each
 *  function reduced to "present". A pipeline is live TypeScript — argv, when, check, progress are
 *  code — so JSON.stringify would drop every decision it makes; this is the part that can be
 *  handed to a reader or hashed. The evaluated argv of each script step is in the log already,
 *  on its step_started. */
export function describePipeline(p: Pipeline): PipelineDescription {
  const steps = p.steps.map((s): StepDescription => {
    const d: StepDescription = { id: s.id, kind: s.kind, dependsOn: [...(s.dependsOn ?? [])], inputs: [...(s.inputs ?? [])], outputs: [...(s.outputs ?? [])], when: s.when !== undefined };
    if (s.timeoutMs !== undefined) d.timeoutMs = s.timeoutMs;
    if (s.kind === "script" && s.cwd !== undefined) d.cwd = s.cwd;
    if (s.kind === "agent") {
      d.promptFile = s.promptFile; d.model = s.model; d.allowedTools = [...s.allowedTools]; d.context = s.context;
      if (s.schemaFile !== undefined) d.schemaFile = s.schemaFile;
      if (s.idleTimeoutMs !== undefined) d.idleTimeoutMs = s.idleTimeoutMs;
    }
    if (s.kind === "gate") {
      if (s.messageFile !== undefined) d.messageFile = s.messageFile;
      if (s.maxAttempts !== undefined) d.maxAttempts = s.maxAttempts;
      if (s.rerunOnReject !== undefined) d.rerunOnReject = [...s.rerunOnReject];
      if (s.onReject) d.onReject = { id: s.onReject.id, promptFile: s.onReject.promptFile, model: s.onReject.model };
    }
    if (s.kind === "loop") {
      d.until = s.until; d.maxIterations = s.maxIterations;
      d.body = { id: s.body.id, promptFile: s.body.promptFile, model: s.body.model };
    }
    return d;
  });
  return { name: p.name, steps };
}

/** A content hash of the description, recorded on run_started so a log says which shape of the
 *  pipeline it ran against — the version question §6.8's troubleshooting agent would otherwise
 *  have to guess at. */
export function pipelineHash(p: Pipeline): string {
  return createHash("sha256").update(JSON.stringify(describePipeline(p))).digest("hex");
}

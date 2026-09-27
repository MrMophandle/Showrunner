import type { Pipeline, Step, StepId } from "./steps.js";

export class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineError";
  }
}

/** Kahn's algorithm, preferring declaration order among steps that are ready. */
export function orderSteps(p: Pipeline): Step[] {
  const byId = new Map<StepId, Step>();
  for (const s of p.steps) {
    if (byId.has(s.id)) throw new PipelineError(`duplicate step id ${JSON.stringify(s.id)} in pipeline ${p.name}`);
    byId.set(s.id, s);
  }
  for (const s of p.steps) {
    for (const d of s.dependsOn ?? []) {
      if (!byId.has(d)) throw new PipelineError(`step ${JSON.stringify(s.id)} depends on unknown step ${JSON.stringify(d)}`);
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

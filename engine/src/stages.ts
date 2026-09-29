import type { RunState } from "./state.js";
import type { Pipeline } from "./steps.js";

export class StageMapError extends Error { override readonly name = "StageMapError"; }

export const STAGES = [
  "NEEDS_IDEA", "DRAFT_IDEA", "IDEA",
  "DRAFT_OUTLINE", "OUTLINE",
  "DRAFT_SCRIPT", "SCRIPT",
  "NEEDS_REFS",
  "DRAFT_CASTING", "CASTING",
  "DRAFT_AUDIO", "AUDIO",
  "NEEDS_IMAGES", "DRAFT_IMAGES", "IMAGES",
  "DRAFT_ASSEMBLY", "ASSEMBLY",
  "PUBLISH_KIT",
  "DRAFT_CANON", "CANON",
  "COMPLETE",
] as const;

export type Stage = (typeof STAGES)[number];

export function stageIndex(s: Stage): number {
  return STAGES.indexOf(s);
}

export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

export function compareStages(a: Stage, b: Stage): number {
  return stageIndex(a) - stageIndex(b);
}

export interface StageMap {
  /** gate step id → the DRAFT_ stage that gate opens */
  gates: Record<string, Stage>;
  /** step id → the approved stage reached when that step completes */
  approved: Record<string, Stage>;
  /** the stage reached when the run finishes successfully */
  final: Stage;
}

export interface Needs {
  ideaMissing: boolean;
  refsMissing: boolean;
  imagesMissing: boolean;
}

/** Checked in order, first match wins, so this list must stay in ascending `stage` order: a
 *  NEEDS_ stage listed after one that sits later in STAGES would be masked by it and never
 *  reported. A rule applies only inside its window: from `from` (inclusive; absent means from
 *  the floor) up to `passedAt`, the first approved stage strictly after the interruption. The
 *  windows are the spec's placement of each state in the vocabulary (§3.2): refs are demanded
 *  once the script is approved and before casting, showrunner-made images once the audio is
 *  approved and before the images are. */
const NEEDS_RULES: { flag: keyof Needs; stage: Stage; from?: Stage; passedAt: Stage }[] = [
  { flag: "ideaMissing", stage: "NEEDS_IDEA", passedAt: "OUTLINE" },
  { flag: "refsMissing", stage: "NEEDS_REFS", from: "SCRIPT", passedAt: "CASTING" },
  { flag: "imagesMissing", stage: "NEEDS_IMAGES", from: "AUDIO", passedAt: "IMAGES" },
];

export function deriveStage(state: RunState, map: StageMap, needs: Needs): Stage {
  if (state.finished && state.status === "completed") return map.final;

  // The floor is IDEA: a run exists only once a premise does, so nothing below IDEA is a
  // reachable resting place. It is coupled to the NEEDS_IDEA rule below — the floor has to stay
  // strictly before that rule's passedAt (OUTLINE), or `compareStages(highest, "OUTLINE") < 0`
  // would be false from the start and NEEDS_IDEA could never be reported at all.
  let highest: Stage = "IDEA";
  for (const [stepId, status] of Object.entries(state.steps)) {
    const stage = map.approved[stepId];
    if (stage && status === "completed" && compareStages(stage, highest) > 0) highest = stage;
  }

  // A NEEDS_ stage interrupts only until the first approved stage strictly after it is reached.
  for (const rule of NEEDS_RULES) {
    const inWindow = (rule.from === undefined || compareStages(highest, rule.from) >= 0) && compareStages(highest, rule.passedAt) < 0;
    if (needs[rule.flag] && inWindow) return rule.stage;
  }

  if (state.openGate) {
    const draft = map.gates[state.openGate.stepId];
    if (draft) return draft;
  }
  return highest;
}

/** Refuses a stage map that would degrade silently: a key that is no step of the pipeline
 *  never advances anything, a gate mapped to an approved stage or a step to a DRAFT_ one is a
 *  category error, and an `approved` step that carries `when` can be bypassed — and a bypassed
 *  step never counts toward `highest`, so the stage it names would never be reached. */
export function validateStageMap(map: StageMap, pipeline: Pipeline): void {
  const byId = new Map(pipeline.steps.map((s) => [s.id, s] as const));
  for (const [id, stage] of Object.entries(map.gates)) {
    const s = byId.get(id);
    if (!s) throw new StageMapError(`gates.${id}: no such step in pipeline ${pipeline.name}`);
    if (s.kind !== "gate") throw new StageMapError(`gates.${id}: step is a ${s.kind}, not a gate`);
    if (!isStage(stage)) throw new StageMapError(`gates.${id}: ${JSON.stringify(stage)} is not a stage`);
    if (!stage.startsWith("DRAFT_")) throw new StageMapError(`gates.${id}: a gate opens a DRAFT_ stage, not ${stage}`);
  }
  for (const [id, stage] of Object.entries(map.approved)) {
    const s = byId.get(id);
    if (!s) throw new StageMapError(`approved.${id}: no such step in pipeline ${pipeline.name}`);
    if (!isStage(stage)) throw new StageMapError(`approved.${id}: ${JSON.stringify(stage)} is not a stage`);
    if (stage.startsWith("DRAFT_") || stage.startsWith("NEEDS_")) throw new StageMapError(`approved.${id}: ${stage} is not an approved stage`);
    if (s.when) throw new StageMapError(`approved.${id}: the step carries a when and can be bypassed, and a bypassed step never advances a stage; key the stage on a later step`);
  }
  if (!isStage(map.final)) throw new StageMapError(`final: ${JSON.stringify(map.final)} is not a stage`);
}

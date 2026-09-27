import type { RunState } from "./state.js";

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

const NEEDS_RULES: { flag: keyof Needs; stage: Stage; passedAt: Stage }[] = [
  { flag: "ideaMissing", stage: "NEEDS_IDEA", passedAt: "OUTLINE" },
  { flag: "refsMissing", stage: "NEEDS_REFS", passedAt: "CASTING" },
  { flag: "imagesMissing", stage: "NEEDS_IMAGES", passedAt: "IMAGES" },
];

export function deriveStage(state: RunState, map: StageMap, needs: Needs): Stage {
  if (state.finished && state.status === "completed") return map.final;

  let highest: Stage = "IDEA";
  for (const [stepId, status] of Object.entries(state.steps)) {
    const stage = map.approved[stepId];
    if (stage && status === "completed" && compareStages(stage, highest) > 0) highest = stage;
  }

  // A NEEDS_ stage interrupts only until the first approved stage strictly after it is reached.
  for (const rule of NEEDS_RULES) {
    if (needs[rule.flag] && compareStages(highest, rule.passedAt) < 0) return rule.stage;
  }

  if (state.openGate) {
    const draft = map.gates[state.openGate.stepId];
    if (draft) return draft;
  }
  return highest;
}

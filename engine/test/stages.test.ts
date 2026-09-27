import { describe, it, expect } from "vitest";
import { STAGES, deriveStage, isStage, stageIndex, compareStages, type StageMap } from "../src/stages.js";
import type { RunState } from "../src/state.js";

const map: StageMap = {
  gates: { "outline-gate": "DRAFT_OUTLINE", "script-gate": "DRAFT_SCRIPT", "casting-gate": "DRAFT_CASTING", "audio-gate": "DRAFT_AUDIO", "image-gate": "DRAFT_IMAGES" },
  approved: { "outline-gate": "OUTLINE", "script-gate": "SCRIPT", "casting-gate": "CASTING", "audio-gate": "AUDIO", "image-gate": "IMAGES" },
  final: "COMPLETE",
};
const none = { refsMissing: false, imagesMissing: false, ideaMissing: false };
const base = (over: Partial<RunState>): RunState => ({ runId: "r", finished: false, steps: {}, results: {}, gateAttempts: {}, ...over });

describe("stages", () => {
  it("has the exact vocabulary in order", () => {
    expect(STAGES).toEqual([
      "NEEDS_IDEA","DRAFT_IDEA","IDEA","DRAFT_OUTLINE","OUTLINE","DRAFT_SCRIPT","SCRIPT","NEEDS_REFS","DRAFT_CASTING","CASTING",
      "DRAFT_AUDIO","AUDIO","NEEDS_IMAGES","DRAFT_IMAGES","IMAGES","DRAFT_ASSEMBLY","ASSEMBLY","PUBLISH_KIT","DRAFT_CANON","CANON","COMPLETE",
    ]);
    expect(stageIndex("IDEA")).toBe(2);
    expect(compareStages("SCRIPT", "OUTLINE")).toBeGreaterThan(0);
  });

  it("reports NEEDS_IDEA before anything exists", () => {
    expect(deriveStage(base({}), map, { ...none, ideaMissing: true })).toBe("NEEDS_IDEA");
    expect(deriveStage(base({}), map, none)).toBe("IDEA");
  });

  it("reports the open gate's draft stage", () => {
    const s = base({ steps: { "outline-gate": "waiting" }, openGate: { stepId: "outline-gate", attempt: 1, message: "", openedAt: "t" } });
    expect(deriveStage(s, map, none)).toBe("DRAFT_OUTLINE");
  });

  it("reports the highest approved stage reached while working toward the next", () => {
    const s = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "tts-generate": "running" } });
    expect(deriveStage(s, map, none)).toBe("SCRIPT");
  });

  it("lets a NEEDS_ stage interrupt at the right point and not after it is passed", () => {
    const afterScript = base({ steps: { "outline-gate": "completed", "script-gate": "completed" } });
    expect(deriveStage(afterScript, map, { ...none, refsMissing: true })).toBe("NEEDS_REFS");
    const afterCasting = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed" } });
    expect(deriveStage(afterCasting, map, { ...none, refsMissing: true })).toBe("CASTING");
    const afterAudio = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed", "audio-gate": "completed" } });
    expect(deriveStage(afterAudio, map, { ...none, imagesMissing: true })).toBe("NEEDS_IMAGES");
    const imagesGateOpen = base({ steps: { "audio-gate": "completed", "image-gate": "waiting" }, openGate: { stepId: "image-gate", attempt: 1, message: "", openedAt: "t" } });
    expect(deriveStage(imagesGateOpen, map, { ...none, imagesMissing: true })).toBe("NEEDS_IMAGES");
    expect(deriveStage(imagesGateOpen, map, none)).toBe("DRAFT_IMAGES");
  });

  it("reports the final stage when the run completed", () => {
    expect(deriveStage(base({ finished: true, status: "completed" }), map, none)).toBe("COMPLETE");
  });

  it("does not report the final stage for a run that finished failed", () => {
    const s = base({ finished: true, status: "failed", steps: { "outline-gate": "completed", "script-gate": "failed" } });
    expect(deriveStage(s, map, none)).toBe("OUTLINE");
    expect(deriveStage(base({ finished: true, status: "failed" }), map, none)).toBe("IDEA");
  });

  it("recognises exactly the stage vocabulary", () => {
    for (const stage of STAGES) expect(isStage(stage)).toBe(true);
    for (const other of ["complete", "DONE", "", "NEEDS_SCRIPT"]) expect(isStage(other), other).toBe(false);
  });
});

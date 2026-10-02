import { describe, it, expect } from "vitest";
import { STAGES, deriveStage, isStage, stageIndex, compareStages, validateStageMap, type StageMap } from "../src/stages.js";
import type { RunState } from "../src/state.js";
import type { Pipeline } from "../src/steps.js";

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

describe("the NEEDS_ windows", () => {
  it("reports NEEDS_REFS only from SCRIPT to CASTING, and NEEDS_IMAGES only from AUDIO to IMAGES", () => {
    const atIdea = base({});
    const atOutline = base({ steps: { "outline-gate": "completed" } });
    const atScript = base({ steps: { "outline-gate": "completed", "script-gate": "completed" } });
    const atCasting = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed" } });
    const atAudio = base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed", "audio-gate": "completed" } });
    const refs = { ...none, refsMissing: true };
    expect(deriveStage(atIdea, map, refs)).toBe("IDEA");
    expect(deriveStage(atOutline, map, refs)).toBe("OUTLINE");
    expect(deriveStage(atScript, map, refs)).toBe("NEEDS_REFS");
    expect(deriveStage(atCasting, map, refs)).toBe("CASTING");
    const images = { ...none, imagesMissing: true };
    expect(deriveStage(atScript, map, images)).toBe("SCRIPT");
    expect(deriveStage(atAudio, map, images)).toBe("NEEDS_IMAGES");
    const openImageGate = base({ ...atAudio, steps: { ...atAudio.steps, "image-gate": "waiting" }, openGate: { stepId: "image-gate", attempt: 1, message: "", openedAt: "t" } });
    expect(deriveStage(openImageGate, map, images)).toBe("NEEDS_IMAGES");
    expect(deriveStage(openImageGate, map, none)).toBe("DRAFT_IMAGES");
  });
});

describe("validateStageMap", () => {
  const p: Pipeline = { name: "p", steps: [
    { kind: "gate", id: "g", message: () => "m" },
    { kind: "script", id: "stamp", dependsOn: ["g"], argv: () => ["true"] },
    { kind: "script", id: "maybe", dependsOn: ["g"], when: () => true, argv: () => ["true"] },
  ] };
  it("accepts a map whose keys are steps and whose values are stages of the right kind", () => {
    expect(() => validateStageMap({ gates: { g: "DRAFT_SCRIPT" }, approved: { stamp: "SCRIPT" }, final: "COMPLETE" }, p)).not.toThrow();
  });
  it("refuses an unknown step, a non-gate under gates, a wrong-kind stage, and an approved step that carries when", () => {
    expect(() => validateStageMap({ gates: { nope: "DRAFT_SCRIPT" }, approved: {}, final: "COMPLETE" }, p)).toThrow(/gates\.nope: no such step/);
    expect(() => validateStageMap({ gates: { stamp: "DRAFT_SCRIPT" }, approved: {}, final: "COMPLETE" }, p)).toThrow(/gates\.stamp: step is a script, not a gate/);
    expect(() => validateStageMap({ gates: { g: "SCRIPT" }, approved: {}, final: "COMPLETE" }, p)).toThrow(/gates\.g: a gate opens a DRAFT_ stage/);
    expect(() => validateStageMap({ gates: {}, approved: { stamp: "DRAFT_SCRIPT" }, final: "COMPLETE" }, p)).toThrow(/approved\.stamp: DRAFT_SCRIPT is not an approved stage/);
    expect(() => validateStageMap({ gates: {}, approved: { maybe: "SCRIPT" }, final: "COMPLETE" }, p)).toThrow(/approved\.maybe: the step carries a when/);
    expect(() => validateStageMap({ gates: {}, approved: {}, final: "NOPE" as never }, p)).toThrow(/final: "NOPE" is not a stage/);
  });
});

describe("deriveStage edges", () => {
  it("ignores a completed step absent from approved, and an open gate absent from gates", () => {
    const s = base({ steps: { "outline-gate": "completed", unmapped: "completed", other: "waiting" }, openGate: { stepId: "other", attempt: 1, message: "", openedAt: "t" } });
    expect(deriveStage(s, map, none)).toBe("OUTLINE");
  });
  it("compareStages is zero for equal stages and negative in order", () => {
    expect(compareStages("IDEA", "IDEA")).toBe(0);
    expect(compareStages("IDEA", "OUTLINE")).toBeLessThan(0);
  });
  it("stops reporting NEEDS_IDEA exactly at OUTLINE and NEEDS_IMAGES exactly at IMAGES", () => {
    expect(deriveStage(base({ steps: { "outline-gate": "completed" } }), map, { ...none, ideaMissing: true })).toBe("OUTLINE");
    expect(deriveStage(base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed", "audio-gate": "completed", "image-gate": "completed" } }), map, { ...none, imagesMissing: true })).toBe("IMAGES");
  });
});

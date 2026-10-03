import { describe, it, expect } from "vitest";
import { SETUP_ID, answersPath, bibleFilePipeline, bibleLogDir } from "../../src/pipelines/bible.js";
import { RESERVED_EPISODE_ID, isEpisodeId } from "../../src/ids.js";
import { describePipeline, orderSteps, pipelineHash } from "../../src/pipeline.js";
import type { BibleFile } from "../../src/bible.js";
import type { AgentStep, GateStep } from "../../src/steps.js";

const interviewed: BibleFile = { key: "style-guide", file: "Canon/style-guide.md", mode: "interview", purpose: "The narration's voice." };
const defaulted: BibleFile = { key: "story-craft", file: "Canon/story-craft.md", mode: "default", purpose: "The craft rules." };

function vars(over: Record<string, string> = {}): Record<string, string> {
  return {
    file: interviewed.file, key: interviewed.key, purpose: interviewed.purpose,
    answersPath: answersPath(interviewed.key), templatePath: "/engine/tools/templates/canon/style-guide.md",
    date: "2030-01-01", ...over,
  };
}

describe("SETUP_ID", () => {
  it("is the reserved episode id, and is not an episode id", () => {
    expect(SETUP_ID).toBe("setup");
    expect(SETUP_ID).toBe(RESERVED_EPISODE_ID);
    expect(isEpisodeId(SETUP_ID)).toBe(false);
  });
});

describe("bibleLogDir and answersPath", () => {
  it("put the runs and the answers under <productionDir>/setup/<key>", () => {
    expect(bibleLogDir("/s", "style-guide")).toBe("/s/Production/setup/style-guide/runs");
    expect(bibleLogDir("/s", "style-guide", "Prod")).toBe("/s/Prod/setup/style-guide/runs");
    expect(answersPath("style-guide")).toBe("Production/setup/style-guide/answers.md");
    expect(answersPath("style-guide", "Prod")).toBe("Prod/setup/style-guide/answers.md");
  });
});

describe("bibleFilePipeline", () => {
  it("gives an interviewed file write then gate, with the gate depending on write", () => {
    const p = bibleFilePipeline({ entry: interviewed, vars: vars() });
    expect(p.name).toBe("bible-style-guide");
    expect(p.steps.map((s) => s.id)).toEqual(["write", "gate"]);
    const write = p.steps[0] as AgentStep;
    const gate = p.steps[1] as GateStep;
    expect(write.kind).toBe("agent");
    expect(write.promptFile).toBe("write.md");
    expect(write.allowedTools).toEqual(["Read", "Write"]);
    expect(write.inputs).toEqual(["Production/setup/style-guide/answers.md"]);
    expect(write.outputs).toEqual(["Canon/style-guide.md"]);
    expect(gate.dependsOn).toEqual(["write"]);
    expect(gate.messageFile).toBe("gate.md");
    expect(gate.maxAttempts).toBe(10);
    expect(gate.rerunOnReject).toEqual([]);
    expect(gate.onReject?.id).toBe("revise");
    expect(gate.onReject?.promptFile).toBe("revise.md");
    expect(gate.onReject?.inputs).toEqual(["Canon/style-guide.md"]);
    // Every step renders one prompt file against the same vars; a step without them could not
    // render `{{vars.file}}` at all.
    expect(write.vars).toEqual(vars());
    expect(gate.vars).toEqual(vars());
    expect(gate.onReject?.vars).toEqual(vars());
    expect(orderSteps(p).map((s) => s.id)).toEqual(["write", "gate"]);
  });

  it("gives a default file the gate alone, with no write step and no dependency", () => {
    const p = bibleFilePipeline({ entry: defaulted, vars: vars({ file: defaulted.file, key: defaulted.key }) });
    expect(p.name).toBe("bible-story-craft");
    expect(p.steps.map((s) => s.id)).toEqual(["gate"]);
    const gate = p.steps[0] as GateStep;
    expect(gate.kind).toBe("gate");
    expect("dependsOn" in gate).toBe(false);
    expect(gate.onReject?.id).toBe("revise");
    expect(orderSteps(p).map((s) => s.id)).toEqual(["gate"]);
  });

  it("takes the answers path from the production directory it is given", () => {
    const p = bibleFilePipeline({ entry: interviewed, vars: vars(), productionDir: "Prod" });
    expect((p.steps[0] as AgentStep).inputs).toEqual(["Prod/setup/style-guide/answers.md"]);
  });

  it("describes stably: the same vars hash the same, different vars hash differently", () => {
    const a = bibleFilePipeline({ entry: interviewed, vars: vars() });
    const b = bibleFilePipeline({ entry: interviewed, vars: vars() });
    expect(describePipeline(a)).toEqual(describePipeline(b));
    expect(pipelineHash(a)).toBe(pipelineHash(b));
    const c = bibleFilePipeline({ entry: interviewed, vars: vars({ date: "2030-02-02" }) });
    expect(pipelineHash(c)).not.toBe(pipelineHash(a));
    // The gate's fix agent is described too, so a changed var moves the hash through it as well.
    expect(describePipeline(a).steps[1]?.onReject?.vars).toEqual(vars());
  });
});

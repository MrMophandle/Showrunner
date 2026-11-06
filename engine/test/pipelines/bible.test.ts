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

  it("gives the gate a standing purpose in both modes, described and distinct from the file's own purpose", () => {
    // Ryan's ruling of 2026-11-06: every gate carries the engine's standing statement of what it
    // is for. The bible pipeline has exactly one gate, and it is the same gate in both modes —
    // after `write` for an interviewed file, alone over the template for a default one — so one
    // purpose serves both. It is asserted non-empty and asserted to be the *gate's* text rather
    // than `vars.purpose`, which is the bible file's own one-line purpose ("The narration's
    // voice.") and is a different field that happens to share the name.
    for (const entry of [interviewed, defaulted]) {
      const p = bibleFilePipeline({ entry, vars: vars({ file: entry.file, key: entry.key, purpose: entry.purpose }) });
      const gate = p.steps[p.steps.length - 1] as GateStep;
      expect(gate.kind).toBe("gate");
      expect(gate.purpose.trim()).not.toBe("");
      expect(gate.purpose).toContain("Approve it to keep it as the canon every later prompt reads");
      expect(gate.purpose).not.toBe(entry.purpose);
      expect(() => orderSteps(p)).not.toThrow();
      // The console reads the purpose off the description, so it has to survive describePipeline.
      const described = describePipeline(p).steps[p.steps.length - 1];
      expect(described?.purpose).toBe(gate.purpose);
    }
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

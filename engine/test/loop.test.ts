import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import type { Executors, Pipeline, LoopStep, AgentStep } from "../src/steps.js";

const body: AgentStep = { kind: "agent", id: "draft", promptFile: "draft.md", model: "m", allowedTools: ["Read", "Write"], context: "fresh" };

async function runLoop(texts: string[], toolCalls: number[], maxIterations: number) {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  let i = 0;
  const executors: Executors = {
    script: async () => ({ ok: true }),
    agent: async () => { const n = i++; return { ok: true, text: texts[n] ?? "", toolCalls: toolCalls[n] ?? 0 }; },
  };
  const loop: LoopStep = { kind: "loop", id: "draft-loop", body, until: "DRAFT_COMPLETE", maxIterations };
  const pipeline: Pipeline = { name: "p", steps: [loop] };
  const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
  const result = await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors });
  return { result, events: await log.read() };
}

describe("loops", () => {
  it("iterates until the sentinel appears and records each iteration", async () => {
    const { result, events } = await runLoop(["scene one", "scene two", "all done DRAFT_COMPLETE"], [4, 5, 2], 15);
    expect(result).toEqual({ status: "completed" });
    const iters = events.filter((e) => e.kind === "loop_iteration").map((e) => e.payload);
    expect(iters).toEqual([
      { iteration: 1, max: 15, sentinel: false, toolCalls: 4 },
      { iteration: 2, max: 15, sentinel: false, toolCalls: 5 },
      { iteration: 3, max: 15, sentinel: true, toolCalls: 2 },
    ]);
    expect(events.filter((e) => e.kind === "step_completed" && e.stepId === "draft-loop")).toHaveLength(1);
  });

  it("fails when the cap is reached without the sentinel, and shows the dead iterations", async () => {
    const { result, events } = await runLoop(["scene one", "", ""], [3, 0, 0], 3);
    expect(result).toEqual({ status: "failed", stepId: "draft-loop", error: "exhausted 3 iterations without sentinel DRAFT_COMPLETE" });
    const dead = events.filter((e) => e.kind === "loop_iteration" && e.payload["toolCalls"] === 0);
    expect(dead).toHaveLength(2);
  });
});

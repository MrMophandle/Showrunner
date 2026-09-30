import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/runner.js";
import { EventLog, type Event } from "../src/events.js";
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

const at = (n: number) => `2026-01-01T10:00:0${n}.000Z`;

/** Writes a log by hand, as a crashed run left it — the same helper as `test/e2e.test.ts:27`. */
async function writeCrashLog(logPath: string, events: Omit<Event, "ts">[]): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, events.map((e, i) => JSON.stringify({ ts: at(i), ...e })).join("\n") + "\n");
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

  it("resumes the iteration counter from the log, so the cap counts the crashed run's work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const bodyCalls: number[] = [];
    const executors: Executors = {
      script: async () => ({ ok: true }),
      agent: async (_step, ctx) => { bodyCalls.push(Number(ctx.results["draft:iteration"])); return { ok: true, text: "still drafting", toolCalls: 1 }; },
    };
    const loop: LoopStep = { kind: "loop", id: "draft-loop", body, until: "DRAFT_COMPLETE", maxIterations: 3 };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await mkdir(path.dirname(log.path), { recursive: true });
    await writeFile(log.path, [
      { ts: "2026-01-01T10:00:00.000Z", runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } },
      { ts: "2026-01-01T10:00:01.000Z", runId: "r1", stepId: "draft-loop", kind: "step_started", payload: { kind: "loop", body: "draft", until: "DRAFT_COMPLETE", max: 3 } },
      { ts: "2026-01-01T10:00:02.000Z", runId: "r1", stepId: "draft-loop", kind: "loop_iteration", payload: { iteration: 1, max: 3, sentinel: false, toolCalls: 4 } },
      { ts: "2026-01-01T10:00:03.000Z", runId: "r1", stepId: "draft-loop", kind: "loop_iteration", payload: { iteration: 2, max: 3, sentinel: false, toolCalls: 2 } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await run({ pipeline: { name: "p", steps: [loop] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors });
    expect(bodyCalls).toEqual([3]);
    const iters = (await log.read()).filter((e) => e.kind === "loop_iteration").map((e) => e.payload["iteration"]);
    expect(iters).toEqual([1, 2, 3]);
    expect(result).toEqual({ status: "failed", stepId: "draft-loop", error: "exhausted 3 iterations without sentinel DRAFT_COMPLETE" });
  });

  it("emits a step_progress after every iteration when the loop declares a progress hook", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const texts = ["scene one", "scene two", "all done DRAFT_COMPLETE"];
    let i = 0;
    const executors: Executors = {
      script: async () => ({ ok: true }),
      agent: async () => ({ ok: true, text: texts[i++] ?? "", toolCalls: 1 }),
    };
    const loop: LoopStep = {
      kind: "loop", id: "draft-loop", body, until: "DRAFT_COMPLETE", maxIterations: 5,
      // Derived from what the hook is handed, the way a real one would derive it from disk.
      progress: (ctx) => ({ done: Number(ctx.results["draft:iteration"]), total: 3, unit: "scenes" }),
    };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const result = await run({ pipeline: { name: "p", steps: [loop] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors });

    expect(result).toEqual({ status: "completed" });
    const progress = (await log.read()).filter((e) => e.kind === "step_progress");
    expect(progress.map((e) => e.stepId)).toEqual(["draft-loop", "draft-loop", "draft-loop"]);
    expect(progress.map((e) => e.payload)).toEqual([
      { done: 1, total: 3, unit: "scenes" },
      { done: 2, total: 3, unit: "scenes" },
      { done: 3, total: 3, unit: "scenes" },
    ]);
  });

  it("completes, not exhausts, when the sentinel arrives on the last permitted iteration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const texts = ["scene one", "scene two", "all done DRAFT_COMPLETE"];
    const seen: unknown[] = [];
    let i = 0;
    const executors: Executors = {
      script: async () => ({ ok: true }),
      agent: async (_step, ctx) => { seen.push(ctx.results["draft:iteration"]); return { ok: true, text: texts[i++] ?? "", toolCalls: 1 }; },
    };
    const loop: LoopStep = { kind: "loop", id: "draft-loop", body, until: "DRAFT_COMPLETE", maxIterations: 3 };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const result = await run({ pipeline: { name: "p", steps: [loop] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors });

    expect(result).toEqual({ status: "completed" });
    expect(seen).toEqual([1, 2, 3]);
    const events = await log.read();
    expect(events.filter((e) => e.kind === "loop_iteration").at(-1)?.payload).toEqual({ iteration: 3, max: 3, sentinel: true, toolCalls: 1 });
    expect(events.some((e) => e.kind === "step_failed")).toBe(false);
  });

  it("fails when the cap is reached without the sentinel, and shows the dead iterations", async () => {
    const { result, events } = await runLoop(["scene one", "", ""], [3, 0, 0], 3);
    expect(result).toEqual({ status: "failed", stepId: "draft-loop", error: "exhausted 3 iterations without sentinel DRAFT_COMPLETE" });
    const dead = events.filter((e) => e.kind === "loop_iteration" && e.payload["toolCalls"] === 0);
    expect(dead).toHaveLength(2);
  });
  it("resumes a loop whose last iteration recorded the sentinel by completing it without running the body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const logPath = EventLog.logPath(root, "s02e01", "r1");
    await writeCrashLog(logPath, [
      { runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } },
      { runId: "r1", stepId: "loop", kind: "step_started", payload: { kind: "loop", body: "body", until: "DONE", max: 3 } },
      { runId: "r1", stepId: "loop", kind: "agent_result", payload: { ok: true, toolCalls: 2, text: "all DONE" } },
      { runId: "r1", stepId: "loop", kind: "loop_iteration", payload: { iteration: 1, max: 3, sentinel: true, toolCalls: 2 } },
      // crashed here, before step_completed
    ]);
    let bodyCalls = 0;
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "loop", id: "loop", until: "DONE", maxIterations: 3, body: { kind: "agent", id: "body", promptFile: "b.md", model: "m", allowedTools: [], context: "fresh" } },
    ] };
    const r = await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: new EventLog(logPath),
      executors: { script: async () => ({ ok: true }), agent: async () => { bodyCalls++; return { ok: true, text: "DONE", toolCalls: 1 }; } } });
    expect(r).toEqual({ status: "completed" });
    expect(bodyCalls).toBe(0);
    const done = (await new EventLog(logPath).read()).find((e) => e.kind === "step_completed" && e.stepId === "loop");
    expect(done?.payload).toMatchObject({ result: "all DONE", iterations: 1, resumedAfterSentinel: true });
  });

  it("hashes the loop's declared inputs on start and outputs on completion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    await writeFile(path.join(root, "in.md"), "in");
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "loop", id: "loop", until: "DONE", maxIterations: 2, inputs: ["in.md"], outputs: ["out.md"],
        body: { kind: "agent", id: "body", promptFile: "b.md", model: "m", allowedTools: [], context: "fresh" } },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log,
      executors: { script: async () => ({ ok: true }), agent: async (_s, ctx) => { await writeFile(path.join(ctx.showRoot, "out.md"), "out"); return { ok: true, text: "DONE", toolCalls: 1 }; } } });
    const events = await log.read();
    const started = events.find((e) => e.kind === "step_started" && e.stepId === "loop");
    const done = events.find((e) => e.kind === "step_completed" && e.stepId === "loop");
    expect(Object.keys(started?.payload["inputHashes"] as object)).toEqual(["in.md"]);
    expect(typeof (done?.payload["outputHashes"] as Record<string, unknown>)["out.md"]).toBe("string");
  });

  it("records the true tool count on a failed iteration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "loop", id: "loop", until: "DONE", maxIterations: 2, body: { kind: "agent", id: "body", promptFile: "b.md", model: "m", allowedTools: [], context: "fresh" } },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log,
      executors: { script: async () => ({ ok: true }), agent: async () => ({ ok: false, error: "idle timeout after 5ms", toolCalls: 4 }) } });
    const it1 = (await log.read()).find((e) => e.kind === "loop_iteration");
    expect(it1?.payload).toMatchObject({ iteration: 1, sentinel: false, toolCalls: 4, error: "idle timeout after 5ms" });
  });
});

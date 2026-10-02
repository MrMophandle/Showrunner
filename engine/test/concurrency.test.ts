import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import type { Executors, Pipeline } from "../src/steps.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function panel(): Pipeline {
  const agent = (id: string) => ({ kind: "agent" as const, id, dependsOn: ["draft"], promptFile: `${id}.md`, model: "m", allowedTools: [], context: "fresh" as const });
  return { name: "p", steps: [
    { kind: "guard", id: "draft", check: () => ({ pass: true }) },
    agent("a"), agent("b"), agent("c"), agent("d"),
    { kind: "guard", id: "review-gate", dependsOn: ["a", "b", "c", "d"], check: (ctx) => ({ pass: true, message: ["a", "b", "c", "d"].every((k) => ctx.results[k] === "ok") ? "yes" : "no" }) },
  ] };
}

async function timedExecutors(fail?: string) {
  const spans: Record<string, [number, number]> = {};
  const executors: Executors = {
    script: async () => ({ ok: true }),
    agent: async (step) => {
      const t0 = Date.now(); await sleep(120); spans[step.id] = [t0, Date.now()];
      return step.id === fail ? { ok: false, error: "boom", toolCalls: 0 } : { ok: true, text: "ok", toolCalls: 1 };
    },
  };
  return { executors, spans };
}

describe("concurrency", () => {
  it("runs ready agent steps at the same time when asked, and one at a time by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const seq = await timedExecutors();
    const t0 = Date.now();
    await run({ pipeline: panel(), ctx, log: new EventLog(EventLog.logPath(root, "s02e01", "r1")), executors: seq.executors });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4 * 120);
    const par = await timedExecutors();
    const t1 = Date.now();
    const r = await run({ pipeline: panel(), ctx: { ...ctx, runId: "r2" }, log: new EventLog(EventLog.logPath(root, "s02e01", "r2")), executors: par.executors, concurrency: 4 });
    expect(r).toEqual({ status: "completed" });
    expect(Date.now() - t1).toBeLessThan(3 * 120);
    // all four overlapped: every start is before every end
    const starts = Object.values(par.spans).map((s) => s[0]); const ends = Object.values(par.spans).map((s) => s[1]);
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
  });

  it("keeps the log's order equal to the array's order under concurrency, and applies outcomes in pipeline order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const { executors } = await timedExecutors();
    await run({ pipeline: panel(), ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors, concurrency: 2 });
    const events = await log.read();
    const completedOrder = events.filter((e) => e.kind === "step_completed" && ["a", "b", "c", "d"].includes(e.stepId ?? "")).map((e) => e.stepId);
    expect(completedOrder).toEqual(["a", "b", "c", "d"]);
    expect(events.filter((e) => e.kind === "step_started").map((e) => e.stepId)).toEqual(["draft", "a", "b", "c", "d", "review-gate"]);
    expect(events.at(-1)?.kind).toBe("run_finished");
  });

  it("fails the run on the first failed step in pipeline order and sweeps, letting the batch finish first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const { executors, spans } = await timedExecutors("c");
    const r = await run({ pipeline: panel(), ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors, concurrency: 4 });
    expect(r).toEqual({ status: "failed", stepId: "c", error: "boom" });
    expect(Object.keys(spans).sort()).toEqual(["a", "b", "c", "d"]);
    const events = await log.read();
    expect(events.some((e) => e.kind === "step_skipped" && e.stepId === "review-gate")).toBe(true);
  });

  it("does not batch a step whose when is false, and never batches script, guard, gate or loop steps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const order: string[] = [];
    const executors: Executors = {
      script: async (s) => { order.push(`s:${s.id}`); return { ok: true }; },
      agent: async (s) => { order.push(`a:${s.id}`); await sleep(50); return { ok: true, text: "ok", toolCalls: 1 }; },
    };
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "agent", id: "a", promptFile: "a.md", model: "m", allowedTools: [], context: "fresh" },
      { kind: "agent", id: "skipped", when: () => false, promptFile: "x.md", model: "m", allowedTools: [], context: "fresh" },
      { kind: "script", id: "s1", argv: () => ["true"] },
      { kind: "agent", id: "b", dependsOn: ["s1"], promptFile: "b.md", model: "m", allowedTools: [], context: "fresh" },
    ] };
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: new EventLog(EventLog.logPath(root, "s02e01", "r1")), executors, concurrency: 3 });
    expect(order).toEqual(["a:a", "s:s1", "a:b"]);
  });
});

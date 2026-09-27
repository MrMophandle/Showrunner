import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import type { Executors, Pipeline, GuardStep, ScriptStep, AgentStep } from "../src/steps.js";

async function show(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "show-"));
}

const okExecutors = (calls: string[]): Executors => ({
  script: async (step) => { calls.push(`script:${step.id}`); return { ok: true }; },
  agent: async (step) => { calls.push(`agent:${step.id}`); return { ok: true, text: "done", toolCalls: 1 }; },
});

describe("run", () => {
  it("runs guard, script, and agent steps in order and finishes", async () => {
    const root = await show();
    const calls: string[] = [];
    const g: GuardStep = { kind: "guard", id: "g", check: () => ({ pass: true, message: "ok" }) };
    const s: ScriptStep = { kind: "script", id: "s", dependsOn: ["g"], argv: () => ["true"] };
    const a: AgentStep = { kind: "agent", id: "a", dependsOn: ["s"], promptFile: "x.md", model: "m", allowedTools: [], context: "fresh" };
    const p: Pipeline = { name: "p", steps: [a, s, g] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const res = await run({ pipeline: p, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors(calls) });
    expect(res).toEqual({ status: "completed" });
    expect(calls).toEqual(["script:s", "agent:a"]);
    const kinds = (await log.read()).map((e) => `${e.kind}:${e.stepId ?? "-"}`);
    expect(kinds).toEqual([
      "run_started:-",
      "step_started:g", "step_completed:g",
      "step_started:s", "step_completed:s",
      "step_started:a", "step_completed:a",
      "run_finished:-",
    ]);
  });

  it("fails on a failing guard and skips dependents with distinct reasons", async () => {
    const root = await show();
    const g: GuardStep = { kind: "guard", id: "g", check: () => ({ pass: false, message: "no script.md" }) };
    const s: ScriptStep = { kind: "script", id: "s", dependsOn: ["g"], argv: () => ["true"] };
    const t: ScriptStep = { kind: "script", id: "t", dependsOn: ["s"], argv: () => ["true"] };
    const p: Pipeline = { name: "p", steps: [g, s, t] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const res = await run({ pipeline: p, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors([]) });
    expect(res).toEqual({ status: "failed", stepId: "g", error: "no script.md" });
    const events = await log.read();
    const skipped = events.filter((e) => e.kind === "step_skipped");
    expect(skipped.map((e) => [e.stepId, e.payload["reason"]])).toEqual([
      ["s", "dependency failed: g"],
      ["t", "dependency skipped: s"],
    ]);
    expect(events.at(-1)?.kind).toBe("run_finished");
    expect(events.at(-1)?.payload["status"]).toBe("failed");
    expect(await run({ pipeline: p, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors([]) }))
      .toEqual({ status: "failed", stepId: "g", error: "no script.md" });
  });

  it("records a failing script and the agent outcome text as a result", async () => {
    const root = await show();
    const execs: Executors = {
      script: async () => ({ ok: false, error: "exit 3" }),
      agent: async () => ({ ok: true, text: "hello", verdict: { pass: true }, toolCalls: 2 }),
    };
    const s: ScriptStep = { kind: "script", id: "s", argv: () => ["false"] };
    const a: AgentStep = { kind: "agent", id: "a", promptFile: "x.md", model: "m", allowedTools: [], context: "fresh" };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const res = await run({ pipeline: { name: "p", steps: [a, s] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: execs });
    expect(res).toEqual({ status: "failed", stepId: "s", error: "exit 3" });
    const events = await log.read();
    const done = events.find((e) => e.kind === "step_completed" && e.stepId === "a");
    expect(done?.payload["result"]).toEqual({ pass: true });
  });

  it("caches a script step whose declared inputs and outputs are unchanged, and re-runs it when an input changes", async () => {
    const root = await show();
    await writeFile(path.join(root, "in.txt"), "v1");
    let runs = 0;
    const execs: Executors = {
      script: async (_step, ctx) => { runs++; await writeFile(path.join(ctx.showRoot, "out.txt"), `out-${runs}`); return { ok: true }; },
      agent: async () => ({ ok: true, text: "", toolCalls: 0 }),
    };
    const s: ScriptStep = { kind: "script", id: "s", inputs: ["in.txt"], outputs: ["out.txt"], argv: () => ["true"] };
    const p: Pipeline = { name: "p", steps: [s] };
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };

    const log1 = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    expect(await run({ pipeline: p, ctx, log: log1, executors: execs })).toEqual({ status: "completed" });
    expect(runs).toBe(1);

    // A second run of the same log: everything is already completed; nothing re-executes.
    expect(await run({ pipeline: p, ctx, log: log1, executors: execs })).toEqual({ status: "completed" });
    expect(runs).toBe(1);

    // A new run id, same inputs and outputs on disk: the step is served from the prior log's hashes.
    const log2 = new EventLog(EventLog.logPath(root, "s02e01", "r2"));
    expect(await run({ pipeline: p, ctx: { ...ctx, runId: "r2" }, log: log2, executors: execs, priorLogs: [log1] })).toEqual({ status: "completed" });
    expect(runs).toBe(1);
    expect((await log2.read()).some((e) => e.kind === "step_cached" && e.stepId === "s")).toBe(true);

    // Change the input: the step re-runs, and input_changed is recorded.
    await writeFile(path.join(root, "in.txt"), "v2");
    const log3 = new EventLog(EventLog.logPath(root, "s02e01", "r3"));
    expect(await run({ pipeline: p, ctx: { ...ctx, runId: "r3" }, log: log3, executors: execs, priorLogs: [log1, log2] })).toEqual({ status: "completed" });
    expect(runs).toBe(2);
    const ev3 = await log3.read();
    expect(ev3.some((e) => e.kind === "input_changed" && e.stepId === "s")).toBe(true);
    expect(ev3.some((e) => e.kind === "step_completed" && e.stepId === "s")).toBe(true);
  });

  it("re-runs a script step that declares outputs but no inputs, and never caches it", async () => {
    const root = await show();
    let runs = 0;
    const execs: Executors = {
      script: async (_step, ctx) => { runs++; await writeFile(path.join(ctx.showRoot, "out.txt"), "same"); return { ok: true }; },
      agent: async () => ({ ok: true, text: "", toolCalls: 0 }),
    };
    const s: ScriptStep = { kind: "script", id: "s", outputs: ["out.txt"], argv: () => ["true"] };
    const p: Pipeline = { name: "p", steps: [s] };
    const log1 = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline: p, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: log1, executors: execs });
    const log2 = new EventLog(EventLog.logPath(root, "s02e01", "r2"));
    await run({ pipeline: p, ctx: { runId: "r2", episodeId: "s02e01", showRoot: root }, log: log2, executors: execs, priorLogs: [log1] });
    expect(runs).toBe(2);
    expect((await log2.read()).some((e) => e.kind === "step_cached")).toBe(false);
  });

  it("reads its own log exactly once for the whole run", async () => {
    const root = await show();
    const g: GuardStep = { kind: "guard", id: "g", check: () => ({ pass: true }) };
    const s: ScriptStep = { kind: "script", id: "s", dependsOn: ["g"], argv: () => ["true"] };
    const a: AgentStep = { kind: "agent", id: "a", dependsOn: ["s"], promptFile: "x.md", model: "m", allowedTools: [], context: "fresh" };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const original = EventLog.prototype.read;
    const reads: string[] = [];
    EventLog.prototype.read = function (this: EventLog) { reads.push(this.path); return original.call(this); };
    try {
      const res = await run({ pipeline: { name: "p", steps: [g, s, a] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors([]) });
      expect(res).toEqual({ status: "completed" });
    } finally {
      EventLog.prototype.read = original;
    }
    expect(reads.filter((p) => p === log.path)).toHaveLength(1);
    expect((await log.read()).filter((e) => e.kind === "step_completed")).toHaveLength(3);
  });

  it("refuses a second concurrent run on the same log", async () => {
    const root = await show();
    let scriptCalls = 0;
    const execs: Executors = {
      script: async () => { scriptCalls++; await new Promise((r) => setTimeout(r, 30)); return { ok: true }; },
      agent: async () => ({ ok: true, text: "", toolCalls: 0 }),
    };
    const s: ScriptStep = { kind: "script", id: "s", argv: () => ["true"] };
    const pipeline: Pipeline = { name: "p", steps: [s] };
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));

    const first = run({ pipeline, ctx, log, executors: execs });
    const second = run({ pipeline, ctx, log: new EventLog(log.path), executors: execs });
    const [a, b] = await Promise.allSettled([first, second]);

    expect(a.status).toBe("fulfilled");
    if (a.status === "fulfilled") expect(a.value).toEqual({ status: "completed" });
    expect(b.status).toBe("rejected");
    if (b.status === "rejected") expect(String(b.reason)).toMatch(/already in progress/);
    expect(scriptCalls).toBe(1);
    const events = await log.read();
    expect(events.filter((e) => e.kind === "run_started")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "s")).toHaveLength(1);

    // The key is released when the run settles, so a later run on the same log is allowed.
    expect(await run({ pipeline, ctx, log, executors: execs })).toEqual({ status: "completed" });
  });

  it("resumes a crash after step_failed with the real error, the owed sweep, and run_finished", async () => {
    const root = await show();
    const a: GuardStep = { kind: "guard", id: "a", check: () => ({ pass: true }) };
    const b: ScriptStep = { kind: "script", id: "b", dependsOn: ["a"], argv: () => ["true"] };
    const c: ScriptStep = { kind: "script", id: "c", dependsOn: ["b"], argv: () => ["true"] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await mkdir(path.dirname(log.path), { recursive: true });
    await writeFile(log.path, [
      { ts: "2026-01-01T10:00:00.000Z", runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } },
      { ts: "2026-01-01T10:00:01.000Z", runId: "r1", stepId: "a", kind: "step_started", payload: { kind: "guard" } },
      { ts: "2026-01-01T10:00:02.000Z", runId: "r1", stepId: "a", kind: "step_failed", payload: { error: "the real reason" } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");

    const calls: string[] = [];
    const res = await run({ pipeline: { name: "p", steps: [a, b, c] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors(calls) });
    expect(res).toEqual({ status: "failed", stepId: "a", error: "the real reason" });
    expect(calls).toEqual([]);
    const events = await log.read();
    expect(events.filter((e) => e.kind === "step_skipped").map((e) => [e.stepId, e.payload["reason"]])).toEqual([
      ["b", "dependency failed: a"],
      ["c", "dependency skipped: b"],
    ]);
    expect(events.at(-1)?.kind).toBe("run_finished");
    expect(events.at(-1)?.payload["status"]).toBe("failed");
  });

  it("sweeps a dependent the crash left running, not only the ones it never started", async () => {
    const root = await show();
    const a: GuardStep = { kind: "guard", id: "a", check: () => ({ pass: true }) };
    const b: ScriptStep = { kind: "script", id: "b", dependsOn: ["a"], argv: () => ["true"] };
    const c: ScriptStep = { kind: "script", id: "c", dependsOn: ["b"], argv: () => ["true"] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await mkdir(path.dirname(log.path), { recursive: true });
    await writeFile(log.path, [
      { ts: "2026-01-01T10:00:00.000Z", runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } },
      { ts: "2026-01-01T10:00:01.000Z", runId: "r1", stepId: "b", kind: "step_started", payload: { kind: "script" } },
      { ts: "2026-01-01T10:00:02.000Z", runId: "r1", stepId: "a", kind: "step_failed", payload: { error: "boom" } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");

    const res = await run({ pipeline: { name: "p", steps: [a, b, c] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors([]) });
    expect(res).toEqual({ status: "failed", stepId: "a", error: "boom" });
    const events = await log.read();
    expect(events.filter((e) => e.kind === "step_skipped").map((e) => e.stepId)).toEqual(["b", "c"]);
  });

  it("re-executes a step whose log shows it running with no terminal event", async () => {
    const root = await show();
    const calls: string[] = [];
    const g: GuardStep = { kind: "guard", id: "g", check: () => { calls.push("g"); return { pass: true }; } };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await log.append({ runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } });
    await log.append({ runId: "r1", stepId: "g", kind: "step_started", payload: { kind: "guard" } });
    const res = await run({ pipeline: { name: "p", steps: [g] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors([]) });
    expect(res).toEqual({ status: "completed" });
    expect(calls).toEqual(["g"]);
    const starts = (await log.read()).filter((e) => e.kind === "step_started" && e.stepId === "g");
    expect(starts).toHaveLength(2);
  });
});

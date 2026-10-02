import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, resetSteps, resumeRun } from "../src/runner.js";
import { pipelineHash } from "../src/pipeline.js";
import { ENGINE_VERSION } from "../src/version.js";
import { EventLog } from "../src/events.js";
import { deriveRunState } from "../src/state.js";
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

  it("fails the step when a guard throws, so the log records how it ended and the run resumes", async () => {
    const root = await show();
    // The shape that made this reachable: a guard that parses a file an agent wrote. A throw
    // used to escape run() and leave the log at step_started, which resumeRun then refused.
    await writeFile(path.join(root, "refs.json"), "{ broken");
    const g: GuardStep = {
      kind: "guard", id: "refs-ready",
      check: async () => { JSON.parse(await readFile(path.join(root, "refs.json"), "utf8")); return { pass: true, message: "all references present" }; },
    };
    const p: Pipeline = { name: "p", steps: [g] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const res = await run({ pipeline: p, ctx, log, executors: okExecutors([]) });
    expect(res).toMatchObject({ status: "failed", stepId: "refs-ready" });
    expect(res.status === "failed" && res.error).toMatch(/^guard threw: /);
    const events = await log.read();
    expect(events.map((e) => `${e.kind}:${e.stepId ?? "-"}`)).toEqual([
      "run_started:-", "step_started:refs-ready", "step_failed:refs-ready", "run_finished:-",
    ]);
    expect(String(events.find((e) => e.kind === "step_failed")?.payload["error"])).toMatch(/^guard threw: /);
    const state = deriveRunState(events);
    expect(state.steps["refs-ready"]).toBe("failed");
    expect(state.finished && state.status).toBe("failed");
    // The operator's recovery: repair the file the guard reads, resume, run again.
    await writeFile(path.join(root, "refs.json"), "{}");
    await resumeRun(log, "r1", "showrunner");
    expect(await run({ pipeline: p, ctx, log, executors: okExecutors([]) })).toEqual({ status: "completed" });
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

  it("re-runs a script step whose outputs changed under it, without calling that an input change", async () => {
    const root = await show();
    await writeFile(path.join(root, "in.txt"), "v1");
    let runs = 0;
    const execs: Executors = {
      script: async (_step, ctx) => { runs++; await writeFile(path.join(ctx.showRoot, "out.txt"), "generated"); return { ok: true }; },
      agent: async () => ({ ok: true, text: "", toolCalls: 0 }),
    };
    const s: ScriptStep = { kind: "script", id: "s", inputs: ["in.txt"], outputs: ["out.txt"], argv: () => ["true"] };
    const p: Pipeline = { name: "p", steps: [s] };
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };

    const log1 = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    expect(await run({ pipeline: p, ctx, log: log1, executors: execs })).toEqual({ status: "completed" });
    expect(runs).toBe(1);

    // Someone edited the output by hand. The input is untouched, so this is not an input change,
    // but the recorded result no longer describes what is on disk and must not be served.
    await writeFile(path.join(root, "out.txt"), "edited by hand");
    const log2 = new EventLog(EventLog.logPath(root, "s02e01", "r2"));
    expect(await run({ pipeline: p, ctx: { ...ctx, runId: "r2" }, log: log2, executors: execs, priorLogs: [log1] })).toEqual({ status: "completed" });
    expect(runs).toBe(2);

    const ev2 = await log2.read();
    expect(ev2.some((e) => e.kind === "step_cached")).toBe(false);
    expect(ev2.some((e) => e.kind === "input_changed")).toBe(false);
    expect(ev2.some((e) => e.kind === "step_completed" && e.stepId === "s")).toBe(true);
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

  it("bypasses a step whose `when` is false, and still runs its dependents", async () => {
    const root = await show();
    const calls: string[] = [];
    const a: ScriptStep = { kind: "script", id: "a", argv: () => ["true"] };
    const b: ScriptStep = { kind: "script", id: "b", dependsOn: ["a"], when: () => false, argv: () => ["true"] };
    const c: ScriptStep = { kind: "script", id: "c", dependsOn: ["b"], argv: () => ["true"] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const res = await run({ pipeline: { name: "p", steps: [a, b, c] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors(calls) });

    expect(res).toEqual({ status: "completed" });
    expect(calls).toEqual(["script:a", "script:c"]);
    const events = await log.read();
    expect(events.filter((e) => e.kind === "step_skipped").map((e) => [e.stepId, e.payload["reason"]])).toEqual([["b", "when: false"]]);
    expect(deriveRunState(events).steps).toEqual({ a: "completed", b: "bypassed", c: "completed" });
  });

  it("runs a step whose `when` is true, and hands it the run context", async () => {
    const root = await show();
    const calls: string[] = [];
    const seen: string[] = [];
    const a: ScriptStep = { kind: "script", id: "a", when: (ctx) => { seen.push(ctx.episodeId); return true; }, argv: () => ["true"] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const res = await run({ pipeline: { name: "p", steps: [a] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: okExecutors(calls) });

    expect(res).toEqual({ status: "completed" });
    expect(calls).toEqual(["script:a"]);
    expect(seen).toEqual(["s02e01"]);
    expect((await log.read()).some((e) => e.kind === "step_skipped")).toBe(false);
  });

  it("records the trigger on run_started when the context carries one", async () => {
    const root = await show();
    const g: GuardStep = { kind: "guard", id: "g", check: () => ({ pass: true }) };
    const p: Pipeline = { name: "p", steps: [g] };

    const withTrigger = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline: p, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root, trigger: "console:user" }, log: withTrigger, executors: okExecutors([]) });
    const started = (await withTrigger.read()).find((e) => e.kind === "run_started");
    expect(started?.payload).toEqual({ pipeline: "p", episodeId: "s02e01", engineVersion: ENGINE_VERSION, pipelineHash: pipelineHash(p), trigger: "console:user" });

    const without = new EventLog(EventLog.logPath(root, "s02e01", "r2"));
    await run({ pipeline: p, ctx: { runId: "r2", episodeId: "s02e01", showRoot: root }, log: without, executors: okExecutors([]) });
    expect((await without.read()).find((e) => e.kind === "run_started")?.payload).toEqual({ pipeline: "p", episodeId: "s02e01", engineVersion: ENGINE_VERSION, pipelineHash: pipelineHash(p) });
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

  it("a script step's result reaches ctx.results and step_completed", async () => {
    const root = await show();
    const executors = { script: async () => ({ ok: true as const, result: "MASTER_OK" }), agent: async () => { throw new Error("unused"); } };
    let seen: unknown;
    const a: ScriptStep = { kind: "script", id: "master", argv: () => ["x"] };
    const g: GuardStep = { kind: "guard", id: "after", dependsOn: ["master"], check: (c) => { seen = c.results["master"]; return { pass: true }; } };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const r = await run({ pipeline: { name: "p", steps: [a, g] }, executors, log, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root } });
    expect(r).toEqual({ status: "completed" });
    expect(seen).toBe("MASTER_OK");
    const done = (await log.read()).find((e) => e.kind === "step_completed" && e.stepId === "master");
    expect(done?.payload["result"]).toBe("MASTER_OK");
  });

  it("initialises <gate>:rejections to an empty array so a prompt can always render it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const seen: unknown[] = [];
    const executors: Executors = {
      script: async () => ({ ok: true }),
      agent: async (_s, ctx) => { seen.push(ctx.results["g:rejections"]); return { ok: true, text: "t", toolCalls: 0 }; },
    };
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "agent", id: "a", promptFile: "a.md", model: "m", allowedTools: [], context: "fresh" },
      { kind: "gate", id: "g", dependsOn: ["a"], message: () => "m" },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors });
    expect(seen).toEqual([[]]);
  });

  it("hands every step the run's events so far through ctx.events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    let kinds: string[] = [];
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "guard", id: "a", check: () => ({ pass: true }) },
      { kind: "guard", id: "b", dependsOn: ["a"], check: (ctx) => { kinds = (ctx.events ?? []).map((e) => e.kind); return { pass: true }; } },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: { script: async () => ({ ok: true }), agent: async () => ({ ok: true, text: "", toolCalls: 0 }) } });
    expect(kinds).toEqual(["run_started", "step_started", "step_completed", "step_started"]);
  });

  it("resumeRun reopens a failed run and continues from the failed step", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    let fail = true;
    const executors: Executors = {
      script: async (step) => (step.id === "b" && fail ? { ok: false, error: "boom" } : { ok: true }),
      agent: async () => ({ ok: true, text: "", toolCalls: 0 }),
    };
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "script", id: "a", argv: () => ["true"] },
      { kind: "script", id: "b", dependsOn: ["a"], argv: () => ["true"] },
      { kind: "script", id: "c", dependsOn: ["b"], argv: () => ["true"] },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "failed", stepId: "b", error: "boom" });
    await expect(resumeRun(log, "r2")).rejects.toThrow(/run id mismatch/);
    fail = false;
    await resumeRun(log, "r1", "showrunner");
    await expect(resumeRun(log, "r1")).rejects.toThrow(/not failed/);
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "completed" });
    const events = await log.read();
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "a")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "b")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "run_finished")).toHaveLength(2);
    expect(events.find((e) => e.kind === "run_resumed")?.payload).toEqual({ by: "showrunner" });
  });

  it("resetSteps returns the named steps and their dependents to pending, reopening a finished run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const calls: string[] = [];
    const executors: Executors = { script: async (step) => { calls.push(step.id); return { ok: true }; }, agent: async () => ({ ok: true, text: "", toolCalls: 0 }) };
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "script", id: "a", argv: () => ["true"] },
      { kind: "script", id: "b", dependsOn: ["a"], argv: () => ["true"] },
      { kind: "script", id: "c", argv: () => ["true"] },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    await run({ pipeline, ctx, log, executors });
    expect(await resetSteps(pipeline, log, "r1", ["a"])).toEqual(["a", "b"]);
    calls.length = 0;
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "completed" });
    expect(calls).toEqual(["a", "b"]);
    const resets = (await log.read()).filter((e) => e.kind === "step_reset");
    expect(resets.map((e) => e.payload)).toEqual([{ by: "operator" }, { by: "operator" }]);
  });

  it("records the engine version and the pipeline hash on run_started", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const pipeline: Pipeline = { name: "p", steps: [{ kind: "guard", id: "a", check: () => ({ pass: true }) }] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: { script: async () => ({ ok: true }), agent: async () => ({ ok: true, text: "", toolCalls: 0 }) } });
    const started = (await log.read())[0];
    expect(started?.payload).toMatchObject({ pipeline: "p", episodeId: "s02e01", engineVersion: ENGINE_VERSION, pipelineHash: pipelineHash(pipeline) });
  });
});

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, answerGate } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import type { Executors, Pipeline, GateStep, GuardStep, AgentStep } from "../src/steps.js";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  const fixCalls: string[] = [];
  const executors: Executors = {
    script: async () => ({ ok: true }),
    agent: async (step, ctx) => { fixCalls.push(`${step.id}:${String(ctx.results[`g:rejection`] ?? "")}`); return { ok: true, text: "fixed", toolCalls: 1 }; },
  };
  const fix: AgentStep = { kind: "agent", id: "fix", promptFile: "fix.md", model: "m", allowedTools: [], context: "fresh" };
  const before: GuardStep = { kind: "guard", id: "before", check: () => ({ pass: true }) };
  const g: GateStep = { kind: "gate", id: "g", dependsOn: ["before"], message: (ctx) => `Approve ${ctx.episodeId}?`, onReject: fix, maxAttempts: 2 };
  const after: GuardStep = { kind: "guard", id: "after", dependsOn: ["g"], check: () => ({ pass: true }) };
  const pipeline: Pipeline = { name: "p", steps: [before, g, after] };
  const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
  const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
  return { pipeline, log, ctx, executors, fixCalls };
}

describe("gates", () => {
  it("opens the gate and stops; resumes past it on approval", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    const r1 = await run({ pipeline, ctx, log, executors });
    expect(r1.status).toBe("waiting");
    if (r1.status !== "waiting") return;
    expect(r1.gate).toMatchObject({ stepId: "g", attempt: 1, message: "Approve s02e01?" });

    // Calling run again without an answer stays waiting and appends nothing new.
    const n = (await log.read()).length;
    expect(await run({ pipeline, ctx, log, executors })).toMatchObject({ status: "waiting" });
    expect((await log.read()).length).toBe(n);

    await answerGate(log, "r1", "g", { approved: true, notes: "looks right", by: "showrunner" });
    const r2 = await run({ pipeline, ctx, log, executors });
    expect(r2).toEqual({ status: "completed" });
    const events = await log.read();
    const answered = events.find((e) => e.kind === "gate_answered");
    expect(answered?.payload).toMatchObject({ approved: true, notes: "looks right", by: "showrunner" });
    expect(typeof answered?.payload["waitedMs"]).toBe("number");
    expect(events.some((e) => e.kind === "step_completed" && e.stepId === "after")).toBe(true);
  });

  it("on rejection runs the fix agent with the notes, then reopens the gate as attempt 2", async () => {
    const { pipeline, log, ctx, executors, fixCalls } = await setup();
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "scene two is flat" });
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    expect(fixCalls).toEqual(["fix:scene two is flat"]);
  });

  it("fails the gate when rejections exceed maxAttempts", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "no" });
    await run({ pipeline, ctx, log, executors }); // attempt 2 opens
    await answerGate(log, "r1", "g", { approved: false, notes: "still no" });
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toEqual({ status: "failed", stepId: "g", error: "rejected 2 times" });
    const events = await log.read();
    expect(events.some((e) => e.kind === "step_skipped" && e.stepId === "after")).toBe(true);
  });

  it("refuses to answer a gate that is not open", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    await run({ pipeline, ctx, log, executors });
    await expect(answerGate(log, "r1", "after", { approved: true })).rejects.toThrow(/not open/);
  });

  it("resumes at the open gate after a restart, from the log alone", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    await run({ pipeline, ctx, log, executors });
    // A "restart": a fresh EventLog object over the same file, nothing in memory.
    const fresh = new EventLog(log.path);
    const r = await run({ pipeline, ctx, log: fresh, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 1 } });
    await answerGate(fresh, "r1", "g", { approved: true });
    expect(await run({ pipeline, ctx, log: fresh, executors })).toEqual({ status: "completed" });
  });

  it("reopens after a rejection even when the clock stepped back between open and answer", async () => {
    const { pipeline, log, ctx, executors, fixCalls } = await setup();
    await mkdir(path.dirname(log.path), { recursive: true });
    const lines = [
      { ts: "2026-01-01T10:00:00.000Z", runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } },
      { ts: "2026-01-01T10:00:01.000Z", runId: "r1", stepId: "before", kind: "step_started", payload: { kind: "guard" } },
      { ts: "2026-01-01T10:00:02.000Z", runId: "r1", stepId: "before", kind: "step_completed", payload: { result: null } },
      { ts: "2026-01-01T10:00:05.000Z", runId: "r1", stepId: "g", kind: "gate_opened", payload: { attempt: 1, message: "Approve s02e01?" } },
      { ts: "2026-01-01T10:00:03.000Z", runId: "r1", stepId: "g", kind: "gate_answered", payload: { approved: false, notes: "redo", attempt: 1, waitedMs: 0 } },
    ];
    await writeFile(log.path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    expect(fixCalls).toEqual(["fix:redo"]);
  });

  it("never opens a gate whose dependency failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const dep: GuardStep = { kind: "guard", id: "dep", check: () => ({ pass: false, message: "nope" }) };
    const g: GateStep = { kind: "gate", id: "g", dependsOn: ["dep"], message: () => "Approve?" };
    const after: GuardStep = { kind: "guard", id: "after", dependsOn: ["g"], check: () => ({ pass: true }) };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const r = await run({ pipeline: { name: "p", steps: [dep, g, after] }, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: { script: async () => ({ ok: true }), agent: async () => ({ ok: true, text: "", toolCalls: 0 }) } });
    expect(r).toEqual({ status: "failed", stepId: "dep", error: "nope" });
    const events = await log.read();
    expect(events.some((e) => e.kind === "gate_opened")).toBe(false);
    expect(events.filter((e) => e.kind === "step_skipped").map((e) => [e.stepId, e.payload["reason"]])).toEqual([
      ["g", "dependency failed: dep"],
      ["after", "dependency skipped: g"],
    ]);
  });
});

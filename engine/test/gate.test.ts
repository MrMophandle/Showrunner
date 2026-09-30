import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, answerGate } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import type { Executors, Pipeline, GateStep, GuardStep, AgentStep, RunContext } from "../src/steps.js";

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

  it("defaults the attempt cap to 10, and fails once those ten rejections are spent", async () => {
    const { log, ctx, executors } = await setup();
    const g: GateStep = { kind: "gate", id: "g", message: () => "Approve?" };
    const pipeline: Pipeline = { name: "p", steps: [g] };

    for (let attempt = 1; attempt <= 10; attempt++) {
      const r = await run({ pipeline, ctx, log, executors });
      expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt } });
      await answerGate(log, "r1", "g", { approved: false, notes: `no ${attempt}` });
    }
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "failed", stepId: "g", error: "rejected 10 times" });
    const events = await log.read();
    expect(events.filter((e) => e.kind === "gate_opened")).toHaveLength(10);
    expect(events.at(-1)?.kind).toBe("run_finished");
  });

  it("refuses to answer with a run id the log does not belong to", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    await run({ pipeline, ctx, log, executors });
    await expect(answerGate(log, "r2", "g", { approved: true })).rejects.toThrow(/run id mismatch/);
    expect((await log.read()).some((e) => e.kind === "gate_answered")).toBe(false);
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

  it("does not re-run a fix agent the log already shows completed", async () => {
    const { pipeline, log, ctx, executors, fixCalls } = await setup();
    await mkdir(path.dirname(log.path), { recursive: true });
    const lines = [
      { ts: "2026-01-01T10:00:00.000Z", runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } },
      { ts: "2026-01-01T10:00:01.000Z", runId: "r1", stepId: "before", kind: "step_started", payload: { kind: "guard" } },
      { ts: "2026-01-01T10:00:02.000Z", runId: "r1", stepId: "before", kind: "step_completed", payload: { result: null } },
      { ts: "2026-01-01T10:00:03.000Z", runId: "r1", stepId: "g", kind: "gate_opened", payload: { attempt: 1, message: "Approve s02e01?" } },
      { ts: "2026-01-01T10:00:04.000Z", runId: "r1", stepId: "g", kind: "gate_answered", payload: { approved: false, notes: "redo", attempt: 1, waitedMs: 0 } },
      { ts: "2026-01-01T10:00:05.000Z", runId: "r1", stepId: "fix", kind: "step_started", payload: { kind: "agent", rejectionOf: "g", attempt: 1 } },
      { ts: "2026-01-01T10:00:06.000Z", runId: "r1", stepId: "fix", kind: "step_completed", payload: { result: "fixed", toolCalls: 1 } },
    ];
    await writeFile(log.path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    expect(fixCalls).toEqual([]);
    const events = await log.read();
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "fix")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "gate_opened", stepId: "g" });
  });

  it("runs the fix agent again for a later rejection, even though an earlier one completed", async () => {
    const { log, ctx, executors, fixCalls } = await setup();
    const fix: AgentStep = { kind: "agent", id: "fix", promptFile: "fix.md", model: "m", allowedTools: [], context: "fresh" };
    const g: GateStep = { kind: "gate", id: "g", message: () => "Approve?", onReject: fix, maxAttempts: 4 };
    const pipeline: Pipeline = { name: "p", steps: [g] };

    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "first pass" });
    await run({ pipeline, ctx, log, executors });
    expect(fixCalls).toEqual(["fix:first pass"]);

    // The second rejection is appended after the first fix agent's step_completed, so the
    // completed-agent check looks only at what follows it and the agent runs again.
    await answerGate(log, "r1", "g", { approved: false, notes: "second pass" });
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 3 } });
    expect(fixCalls).toEqual(["fix:first pass", "fix:second pass"]);
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

describe("rerunOnReject", () => {
  async function rerunSetup() {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const calls: string[] = [];
    const executors: Executors = {
      script: async (step) => { calls.push(step.id); return { ok: true, result: `${step.id} ok` }; },
      agent: async (step) => { calls.push(step.id); return { ok: true, text: "done", toolCalls: 1 }; },
    };
    const steps: Pipeline["steps"] = [
      { kind: "script", id: "make", argv: () => ["true"] },
      { kind: "agent", id: "review", dependsOn: ["make"], promptFile: "r.md", model: "m", allowedTools: [], context: "fresh" },
      { kind: "script", id: "side", argv: () => ["true"] },
      { kind: "gate", id: "g", dependsOn: ["review", "side"], message: () => "ok?", maxAttempts: 3,
        onReject: { kind: "agent", id: "fix", promptFile: "f.md", model: "m", allowedTools: [], context: "fresh" },
        rerunOnReject: ["make"] },
      { kind: "script", id: "after", dependsOn: ["g"], argv: () => ["true"] },
    ];
    const pipeline: Pipeline = { name: "p", steps };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    return { pipeline, log, ctx, executors, calls };
  }

  it("re-runs the named steps and their dependents after the fix agent, then reopens the gate", async () => {
    const { pipeline, log, ctx, executors, calls } = await rerunSetup();
    await run({ pipeline, ctx, log, executors });
    expect(calls).toEqual(["make", "review", "side"]);
    await answerGate(log, "r1", "g", { approved: false, notes: "again" });
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    // fix first, then make and review again; side is not downstream of make and does not re-run
    expect(calls).toEqual(["make", "review", "side", "fix", "make", "review"]);
    const events = await log.read();
    const resets = events.filter((e) => e.kind === "step_reset").map((e) => [e.stepId, e.payload["by"]]);
    expect(resets).toEqual([["make", "g"], ["review", "g"]]);
    // the re-executions are new step_started events following the old ones, per the resume contract
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "make")).toHaveLength(2);
    // the gate itself is never reset
    expect(events.some((e) => e.kind === "step_reset" && e.stepId === "g")).toBe(false);
  });

  it("records the reset once per rejection: a crash after the resets does not reset again", async () => {
    const { pipeline, log, ctx, executors, calls } = await rerunSetup();
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "again" });
    // Simulate the crash: run once, then truncate the log to just after the two step_reset events.
    await run({ pipeline, ctx, log, executors });
    const events = await log.read();
    const lastReset = events.map((e) => e.kind).lastIndexOf("step_reset");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(log.path, events.slice(0, lastReset + 1).map((e) => JSON.stringify(e)).join("\n") + "\n");
    calls.length = 0;
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    expect(calls).toEqual(["make", "review"]);
    expect((await log.read()).filter((e) => e.kind === "step_reset")).toHaveLength(2);
  });

  it("reopens without resetting when the closure is empty (the named step is downstream of the gate)", async () => {
    const { log, ctx, executors, calls } = await rerunSetup();
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "gate", id: "g", message: () => "ok?", rerunOnReject: ["after"] },
      { kind: "script", id: "after", dependsOn: ["g"], argv: () => ["true"] },
    ] };
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "no" });
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    expect(calls).toEqual([]);
    expect((await log.read()).some((e) => e.kind === "step_reset")).toBe(false);
  });

  it("resets at once when the gate has no fix agent", async () => {
    const { log, ctx, executors, calls } = await rerunSetup();
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "script", id: "make", argv: () => ["true"] },
      { kind: "gate", id: "g", dependsOn: ["make"], message: () => "ok?", rerunOnReject: ["make"] },
    ] };
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "no" });
    await run({ pipeline, ctx, log, executors });
    expect(calls).toEqual(["make", "make"]);
  });
  it("renders a messageFile gate through RunOptions.renderGateMessage, and fails the gate without one", async () => {
    const pipeline: Pipeline = { name: "p", steps: [{ kind: "gate", id: "g", messageFile: "outline-gate.gate.md" } satisfies GateStep] };

    // No renderer: the gate fails rather than opening with a message the showrunner cannot read.
    const bare = await setup();
    expect(await run({ pipeline, ctx: bare.ctx, log: bare.log, executors: bare.executors })).toEqual({
      status: "failed", stepId: "g", error: 'gate "g": messageFile needs RunOptions.renderGateMessage',
    });
    expect((await bare.log.read()).some((e) => e.kind === "gate_opened")).toBe(false);

    const renderGateMessage = async (file: string, c: RunContext): Promise<string> => `rendered:${file}:${c.episodeId}`;
    const { log, ctx, executors } = await setup();
    const r = await run({ pipeline, ctx, log, executors, renderGateMessage });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 1, message: "rendered:outline-gate.gate.md:s02e01" } });
    expect((await log.read()).find((e) => e.kind === "gate_opened")?.payload["message"]).toBe("rendered:outline-gate.gate.md:s02e01");
  });

  it("fails the gate when its messageFile does not render", async () => {
    const pipeline: Pipeline = { name: "p", steps: [{ kind: "gate", id: "g", messageFile: "hole.gate.md" } satisfies GateStep] };
    const { log, ctx, executors } = await setup();
    const renderGateMessage = async (): Promise<string> => { throw new Error('{{results.missing}}: no result for step "missing"'); };
    const r = await run({ pipeline, ctx, log, executors, renderGateMessage });
    expect(r).toEqual({ status: "failed", stepId: "g", error: 'gate "g": hole.gate.md did not render: {{results.missing}}: no result for step "missing"' });
    expect((await log.read()).some((e) => e.kind === "gate_opened")).toBe(false);
  });

  it("records the fix agent's output hashes on its completion", async () => {
    const { log, ctx, executors } = await setup();
    const fix: AgentStep = { kind: "agent", id: "fix", promptFile: "fix.md", model: "m", allowedTools: [], context: "fresh", outputs: ["draft.md"] };
    const pipeline: Pipeline = { name: "p", steps: [{ kind: "gate", id: "g", message: () => "?", onReject: fix }] };
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: false, notes: "n" });
    await writeFile(path.join(ctx.showRoot, "draft.md"), "edited by the fix agent");
    await run({ pipeline, ctx, log, executors });
    const done = (await log.read()).find((e) => e.kind === "step_completed" && e.stepId === "fix");
    expect(typeof (done?.payload["outputHashes"] as Record<string, unknown>)["draft.md"]).toBe("string");
  });
});

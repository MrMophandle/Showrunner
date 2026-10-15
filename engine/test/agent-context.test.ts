import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAgentExecutor, type AgentMessage, type AgentQueryOptions, type QueryFn } from "../src/agent-step.js";
import { deriveRunState } from "../src/state.js";
import { EventLog } from "../src/events.js";
import { run } from "../src/runner.js";
import type { AgentStep, EventKind, GateStep, LoopStep, Pipeline, RunContext } from "../src/steps.js";

const promptsDir = path.resolve(import.meta.dirname, "fixtures/prompts");
const ctx = (runId = "r1"): RunContext => ({ runId, episodeId: "s02e01", showRoot: "/show", results: {} });
const step = (over: Partial<AgentStep> = {}): AgentStep => ({ kind: "agent", id: "body", promptFile: "plain.md", model: "m", allowedTools: [], context: "shared", ...over });
const noop = async (_k: EventKind, _p: Record<string, unknown>) => {};

function scripted(sessions: string[], texts: string[]) {
  const calls: AgentQueryOptions[] = [];
  let i = 0;
  const query: QueryFn = async function* (args) {
    calls.push(args.options);
    const n = i++;
    yield { type: "system", subtype: "init", session_id: sessions[n] ?? "s?" };
    yield { type: "assistant", message: { content: [{ type: "tool_use", id: `t${n}`, name: "Read", input: {} }] } };
    yield { type: "result", subtype: "success", result: texts[n] ?? "", session_id: sessions[n] ?? "s?", num_turns: 1, duration_ms: 1, total_cost_usd: 0 } as AgentMessage;
  };
  return { calls, query };
}

describe("context policy", () => {
  it("shared: the second query of the same step in the same run resumes the first session", async () => {
    const f = scripted(["sess-A", "sess-A"], ["one", "two"]);
    const ex = createAgentExecutor({ query: f.query, promptsDir });
    const events: Array<Record<string, unknown>> = [];
    const emit = async (k: EventKind, p: Record<string, unknown>) => { if (k === "agent_query") events.push(p); };
    await ex(step(), ctx(), emit);
    await ex(step(), ctx(), emit);
    expect("resume" in f.calls[0]!).toBe(false);
    expect(f.calls[1]!.resume).toBe("sess-A");
    expect(events.map((e) => e["resumed"])).toEqual([false, true]);
  });
  it("shared: a different run id, or a different step id, does not resume", async () => {
    const f = scripted(["sess-A", "sess-B", "sess-C", "sess-D"], ["", "", "", ""]);
    const ex = createAgentExecutor({ query: f.query, promptsDir });
    await ex(step(), ctx("r1"), noop);
    await ex(step(), ctx("r2"), noop);
    await ex(step({ id: "other" }), ctx("r1"), noop);
    // The same run id and the same step id under a different episode id: the session key is scoped
    // by episode as well, so two episodes sharing a run-id string in one long-lived executor do not
    // resume each other's sessions.
    await ex(step(), { ...ctx("r1"), episodeId: "s02e02" }, noop);
    expect(f.calls.map((c) => c.resume)).toEqual([undefined, undefined, undefined, undefined]);
  });
  it("fresh: nothing is resumed even within one run", async () => {
    const f = scripted(["sess-A", "sess-A"], ["", ""]);
    const ex = createAgentExecutor({ query: f.query, promptsDir });
    await ex(step({ context: "fresh" }), ctx(), noop);
    await ex(step({ context: "fresh" }), ctx(), noop);
    expect(f.calls.map((c) => c.resume)).toEqual([undefined, undefined]);
  });
});

describe("the executor inside a run", () => {
  it("a loop body runs through the executor: tool counts reach loop_iteration and the session is shared across iterations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-run-"));
    await mkdir(path.join(root, "prompts"));
    await writeFile(path.join(root, "prompts", "scene.md"), "Write scene {{results.body:iteration}} of {{episodeId}}.");
    const f = scripted(["sess-L", "sess-L"], ["wrote a scene", "DRAFT_COMPLETE"]);
    const executors = { script: async () => ({ ok: true as const }), agent: createAgentExecutor({ query: f.query }) };
    const body: AgentStep = { kind: "agent", id: "body", promptFile: "scene.md", model: "m", allowedTools: ["Read", "Write"], context: "shared" };
    const loop: LoopStep = { kind: "loop", id: "draft", body, until: "DRAFT_COMPLETE", maxIterations: 3 };
    const pipeline: Pipeline = { name: "p", steps: [loop] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const r = await run({ pipeline, executors, log, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root } });
    expect(r).toEqual({ status: "completed" });
    const events = await log.read();
    const iterations = events.filter((e) => e.kind === "loop_iteration").map((e) => [e.payload["iteration"], e.payload["sentinel"], e.payload["toolCalls"]]);
    expect(iterations).toEqual([[1, false, 1], [2, true, 1]]);
    const toolCalls = events.filter((e) => e.kind === "agent_tool_call");
    // The length is asserted first so the .every below cannot pass on an empty array.
    expect(toolCalls.length).toBe(2);
    expect(toolCalls.every((e) => e.stepId === "draft")).toBe(true);
    expect(f.calls[1]!.resume).toBe("sess-L");
    expect(f.calls[0]!.cwd).toBe(root);
  });
  it("a gate's fix agent runs through the executor under its own id and sees the rejection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-gate-"));
    await mkdir(path.join(root, "prompts"));
    await writeFile(path.join(root, "prompts", "fix.md"), "Fix per: {{results.g:rejection}}");
    const f = scripted(["sess-F"], ["fixed"]);
    const executors = { script: async () => ({ ok: true as const }), agent: createAgentExecutor({ query: f.query }) };
    const fix: AgentStep = { kind: "agent", id: "fix", promptFile: "fix.md", model: "m", allowedTools: ["Edit"], context: "fresh" };
    const g: GateStep = { kind: "gate", id: "g", message: () => "ok?", onReject: fix };
    const pipeline: Pipeline = { name: "p", steps: [g] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const { answerGate } = await import("../src/runner.js");
    const ctx1 = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const first = await run({ pipeline, executors, log, ctx: ctx1 });
    expect(first.status).toBe("waiting");
    await answerGate(log, "r1", "g", { approved: false, notes: "too long", by: "test" });
    const second = await run({ pipeline, executors, log, ctx: ctx1 });
    expect(second.status).toBe("waiting");
    const events = await log.read();
    const q = events.find((e) => e.kind === "agent_query");
    expect(q?.stepId).toBe("fix");
    expect(f.calls[0]!.allowedTools).toEqual(["Edit"]);
    expect(events.some((e) => e.kind === "gate_opened" && e.payload["attempt"] === 2)).toBe(true);
  });
});

describe("a loop body that hits a usage limit", () => {
  it("waits out a five-hour limit under the ceiling and the iteration still counts once", async () => {
    // Ryan's ruling of 2026-10-15 on what a loop does with a waited iteration: it is not counted
    // twice. The executor's retry returns one outcome for the iteration, so the loop sees one
    // agent_result per iteration exactly as it does today — the only new event is the step_waiting
    // the executor logged before it slept, and it is logged against the loop's own step id.
    const root = await mkdtemp(path.join(tmpdir(), "agent-limit-"));
    await mkdir(path.join(root, "prompts"));
    await writeFile(path.join(root, "prompts", "revise.md"), "Revise pass {{results.body:iteration}}.");

    const RESET_ISO = "2026-10-14T23:50:00.000Z";
    const SDK_TEXT = "You've hit your session limit · resets 7:50pm (America/New_York)";
    let call = 0;
    const query: QueryFn = async function* () {
      const n = call++;
      yield { type: "system", subtype: "init", session_id: "sess-W" };
      if (n === 0) {
        // The limited attempt: the SDK's refused turn, the rejected window, the wrapper's usage
        // message, and the `subtype: "success"` result the SDK really sends with it.
        yield { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: SDK_TEXT }] } };
        yield { type: "rate_limit_event", rateLimit: { status: "rejected", window: "five_hour", resetsAt: RESET_ISO, utilization: 100 } };
        yield { type: "usage", usage: { available: true, sevenDay: { utilization: 41, resetsAt: "2026-10-19T04:00:00.000Z" } } };
        yield { type: "result", subtype: "success", result: SDK_TEXT, session_id: "sess-W", num_turns: 1, duration_ms: 1, total_cost_usd: 0 } as AgentMessage;
        return;
      }
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }] } };
      yield { type: "result", subtype: "success", result: "REVISIONS_COMPLETE", session_id: "sess-W", num_turns: 2, duration_ms: 2, total_cost_usd: 0 } as AgentMessage;
    };

    const slept: string[] = [];
    const executors = {
      script: async () => ({ ok: true as const }),
      agent: createAgentExecutor({ query, sleepUntil: async (iso: string) => { slept.push(iso); } }),
    };
    const body: AgentStep = { kind: "agent", id: "body", promptFile: "revise.md", model: "m", allowedTools: ["Read", "Write"], context: "shared" };
    const loop: LoopStep = { kind: "loop", id: "revise", body, until: "REVISIONS_COMPLETE", maxIterations: 3 };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const r = await run({ pipeline: { name: "p", steps: [loop] }, executors, log, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root } });

    expect(r).toEqual({ status: "completed" });
    expect(slept).toEqual(["2026-10-14T23:51:00.000Z"]);
    const events = await log.read();
    // One counted iteration, and it is the sentinel one: before this plan the same stream failed
    // the loop with "exhausted 3 iterations without sentinel REVISIONS_COMPLETE".
    expect(events.filter((e) => e.kind === "loop_iteration").map((e) => [e.payload["iteration"], e.payload["sentinel"]])).toEqual([[1, true]]);
    const waiting = events.filter((e) => e.kind === "step_waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.stepId).toBe("revise");
    expect(waiting[0]!.payload["reason"]).toBe("waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)");
    // The wait is logged before the iteration it belongs to, so What-happened reads in order.
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf("step_waiting")).toBeLessThan(kinds.indexOf("loop_iteration"));
    // The step was running throughout and is completed at the end: a step_waiting must never read
    // as a terminal event.
    expect(deriveRunState(events).steps["revise"]).toBe("completed");
  });
});

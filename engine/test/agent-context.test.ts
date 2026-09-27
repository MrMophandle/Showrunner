import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAgentExecutor, type AgentMessage, type AgentQueryOptions, type QueryFn } from "../src/agent-step.js";
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
    const f = scripted(["sess-A", "sess-B", "sess-C"], ["", "", ""]);
    const ex = createAgentExecutor({ query: f.query, promptsDir });
    await ex(step(), ctx("r1"), noop);
    await ex(step(), ctx("r2"), noop);
    await ex(step({ id: "other" }), ctx("r1"), noop);
    expect(f.calls.map((c) => c.resume)).toEqual([undefined, undefined, undefined]);
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
    expect(events.filter((e) => e.kind === "agent_tool_call").every((e) => e.stepId === "draft")).toBe(true);
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

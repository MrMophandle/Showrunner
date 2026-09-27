import { describe, it, expect } from "vitest";
import path from "node:path";
import { createAgentExecutor, type AgentMessage, type AgentQueryOptions, type QueryFn } from "../src/agent-step.js";
import type { AgentStep, EventKind, RunContext } from "../src/steps.js";

const promptsDir = path.resolve(import.meta.dirname, "fixtures/prompts");
const ctx = (): RunContext => ({ runId: "r1", episodeId: "s02e01", showRoot: "/show", results: {} });
const step = (over: Partial<AgentStep> = {}): AgentStep => ({ kind: "agent", id: "a", promptFile: "plain.md", model: "m", allowedTools: [], context: "fresh", ...over });
const init: AgentMessage = { type: "system", subtype: "init", session_id: "s" };
const never = () => new Promise<never>(() => {});

function recorder() {
  const events: Array<{ kind: EventKind; payload: Record<string, unknown> }> = [];
  return { events, emit: async (kind: EventKind, payload: Record<string, unknown>) => { events.push({ kind, payload }); } };
}

describe("agent timeouts", () => {
  it("timeoutMs aborts a query that never yields and fails the step", async () => {
    let controller: AbortController | undefined;
    let returned = false;
    const query: QueryFn = (args) => {
      controller = args.options.abortController;
      return { [Symbol.asyncIterator]: () => ({ next: () => never(), return: async () => { returned = true; return { done: true as const, value: undefined }; } }) };
    };
    const rec = recorder();
    const t0 = Date.now();
    const r = await createAgentExecutor({ query, promptsDir })(step({ timeoutMs: 100 }), ctx(), rec.emit);
    expect(r).toEqual({ ok: false, error: "timed out after 100 ms" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(controller!.signal.aborted).toBe(true);
    expect(returned).toBe(true);
    expect(rec.events.at(-1)!.payload).toMatchObject({ ok: false, error: "timed out after 100 ms", toolCalls: 0 });
  });

  it("idleTimeoutMs fails a query that goes silent after its first message, and resets on every message", async () => {
    let controller: AbortController | undefined;
    const query: QueryFn = async function* (args) {
      controller = args.options.abortController;
      yield init;
      await new Promise((r) => setTimeout(r, 60));
      yield { type: "assistant", message: { content: [{ type: "text", text: "still here" }] } };
      await never();
    };
    const t0 = Date.now();
    const r = await createAgentExecutor({ query, promptsDir })(step({ idleTimeoutMs: 200 }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "idle for 200 ms" });
    expect(controller!.signal.aborted).toBe(true);
    // The message at ~60 ms rearms the idle clock, so the fire lands at ~260 ms rather than ~200.
    // Without the reset the fire would land at ~200 ms and this assertion would fail; a 60 ms timer
    // would have to overrun by 140 ms to pass it by accident, which closes the flake direction.
    expect(Date.now() - t0).toBeGreaterThan(200);
  });

  it("a query that finishes inside both bounds is unaffected and leaves no timers running", async () => {
    const query: QueryFn = async function* () {
      yield init;
      yield { type: "result", subtype: "success", result: "ok", session_id: "s", num_turns: 1, duration_ms: 1, total_cost_usd: 0 };
    };
    const t0 = Date.now();
    const r = await createAgentExecutor({ query, promptsDir })(step({ timeoutMs: 5_000, idleTimeoutMs: 5_000 }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: true, text: "ok", toolCalls: 0 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("the total timeout wins over a result that arrives after it", async () => {
    const query: QueryFn = async function* () {
      yield init;
      await new Promise((r) => setTimeout(r, 300));
      yield { type: "result", subtype: "success", result: "late", session_id: "s", num_turns: 1, duration_ms: 1, total_cost_usd: 0 };
    };
    const r = await createAgentExecutor({ query, promptsDir })(step({ timeoutMs: 80 }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "timed out after 80 ms" });
  });

  it("an emit that rejects on agent_tool_call fails the step as a log write, not a query failure", async () => {
    const query: QueryFn = async function* () {
      yield init;
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.md" } }] } };
      yield { type: "result", subtype: "success", result: "ok", session_id: "s", num_turns: 1, duration_ms: 1, total_cost_usd: 0 };
    };
    const kinds: EventKind[] = [];
    const emit = async (kind: EventKind, _payload: Record<string, unknown>): Promise<void> => {
      kinds.push(kind);
      if (kind === "agent_tool_call") throw new Error("ENOSPC: no space left on device");
    };
    const r = await createAgentExecutor({ query, promptsDir })(step({ allowedTools: ["Read"] }), ctx(), emit);
    expect(r).toEqual({ ok: false, error: "log write failed: ENOSPC: no space left on device" });
    expect(kinds).toEqual(["agent_query", "agent_tool_call", "agent_result"]);
  });
});

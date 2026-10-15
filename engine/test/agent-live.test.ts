import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAgentExecutor, type AgentMessage, type AgentQueryOptions } from "../src/agent-step.js";
import type { AgentStep, EventKind } from "../src/steps.js";

// Runs a real query against the Agent SDK. Costs a few cents and needs credentials on the machine.
//   SHOWRUNNER_LIVE=1 npx vitest run test/agent-live.test.ts
describe.skipIf(!process.env["SHOWRUNNER_LIVE"])("live Agent SDK", () => {
  it("reads a file with only Read allowed and returns a schema-validated verdict", async () => {
    const { sdkQuery } = await import("../src/sdk-query.js");
    const root = await mkdtemp(path.join(tmpdir(), "agent-live-"));
    await mkdir(path.join(root, "prompts"));
    await writeFile(path.join(root, "notes.md"), "The password for the vault is TANGERINE.\n");
    await writeFile(path.join(root, "prompts", "read.md"), "Read the file notes.md in the current directory using the Read tool, then report the single capitalised word it contains as `word`, and set `pass` to true if you could read the file.");
    const step: AgentStep = {
      kind: "agent", id: "live", promptFile: "read.md", model: "claude-sonnet-5", allowedTools: ["Read"], context: "fresh",
      schema: { type: "object", properties: { pass: { type: "boolean" }, word: { type: "string" } }, required: ["pass", "word"] },
      maxTurns: 6, timeoutMs: 120_000, maxBudgetUsd: 0.5,
    };
    const kinds: EventKind[] = [];
    const tools: string[] = [];
    const emit = async (k: EventKind, p: Record<string, unknown>) => { kinds.push(k); if (k === "agent_tool_call") tools.push(String(p["tool"])); };
    const r = await createAgentExecutor({ query: sdkQuery })(step, { runId: "r1", episodeId: "s02e01", showRoot: root, results: {} }, emit);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toMatchObject({ pass: true, word: "TANGERINE" });
    if (r.ok) expect(r.toolCalls).toBe(1);
    expect(kinds[0]).toBe("agent_query");
    expect(kinds.at(-1)).toBe("agent_result");
    expect(tools).toContain("Read");
    expect(tools.every((t) => t === "Read")).toBe(true);
  }, 180_000);

  it("usage: measures whether the SDK's experimental usage call answers on a plain-string-prompt query", async () => {
    // **What this measures, and why it is worth a few cents.** The weekly plan utilization decides
    // whether the engine waits out a five-hour limit on its own authority, and one of its two
    // sources is the query object's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`.
    // `sdk.d.ts` says the control requests are "only supported when streaming input/output is
    // used", and the engine passes a plain string prompt — so whether that call answers at all in
    // production is a question only a real session can settle. The result is printed rather than
    // asserted on: `available: false` is a legitimate answer (it is what an API-key session gives),
    // and the test's own assertion is only that the call comes back inside its timer instead of
    // hanging, because a hang inside the stream is the one outcome that would cost a step its idle
    // deadline.
    //
    // It runs the same two ways production can: once mid-stream, which is where the executor asks
    // (right after a rejected limit, with the stream still open), and once after the stream has
    // ended, in case the transport closes with it.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const { toAgentMessage, usageMessage } = await import("../src/sdk-query.js");
    const root = await mkdtemp(path.join(tmpdir(), "agent-live-usage-"));
    const options: AgentQueryOptions = {
      // claude-sonnet-5 is the house `models.medium` (tools/src/init/config.ts).
      cwd: root, model: "claude-sonnet-5", tools: [], allowedTools: [],
      permissionMode: "dontAsk", settingSources: [], systemPrompt: { type: "preset", preset: "claude_code" },
      // 0.5, as the other two live tests use: a one-word reply under the claude_code preset came to
      // more than $0.20 on 2026-10-15 and tripped a tighter cap before the stream ended.
      abortController: new AbortController(), maxTurns: 1, maxBudgetUsd: 0.5,
    };
    const q = query({ prompt: "Reply with the single word READY and nothing else.", options: { ...options } });
    const types: string[] = [];
    // Every rate-limit event the stream carries, as the adapter maps it. The second half of the
    // measurement: the weekly figure's first source is a seven-day event in the stream, and whether
    // the SDK sends one on an ordinary query is a thing only a real session shows.
    const events: unknown[] = [];
    let during: AgentMessage | undefined;
    let duringMs = 0;
    for await (const m of q) {
      const mapped = toAgentMessage(m);
      types.push(mapped.type);
      if (mapped.rateLimit !== undefined) events.push(mapped.rateLimit);
      if (during === undefined && mapped.type === "assistant") {
        const started = Date.now();
        during = await usageMessage(q);
        duringMs = Date.now() - started;
      }
    }
    const startedAfter = Date.now();
    const after = await usageMessage(q);
    const afterMs = Date.now() - startedAfter;

    console.log("usage probe (mid-stream, " + duringMs + "ms):", JSON.stringify(during?.usage));
    console.log("usage probe (after stream, " + afterMs + "ms):", JSON.stringify(after.usage));
    console.log("usage probe (message types):", JSON.stringify(types));
    console.log("usage probe (rate_limit_events):", JSON.stringify(events));

    // The only hard requirement: the call answers rather than hanging. The wrapper's own timer is
    // 10 s, so anything at or beyond 11 s means the timer itself failed to fire.
    expect(during?.usage).toBeDefined();
    expect(after.usage).toBeDefined();
    expect(duringMs).toBeLessThan(11_000);
    expect(afterMs).toBeLessThan(11_000);
  }, 180_000);

  it("cannot reach a tool outside the allowlist, and says so in its verdict", async () => {
    // The allowlist is the whole enforcement: `tools` decides what is in context and `allowedTools`
    // auto-approves it, so Bash is not offered to the model at all. The agent should therefore
    // report that it could not run the command rather than be denied permission to — which is why
    // permissionDenials is expected to be 0 here and is recorded rather than asserted on.
    const { sdkQuery } = await import("../src/sdk-query.js");
    const root = await mkdtemp(path.join(tmpdir(), "agent-live-deny-"));
    await mkdir(path.join(root, "prompts"));
    await writeFile(path.join(root, "prompts", "deny.md"), "Use the Bash tool to run `ls` in the current directory and report its output. If you cannot use Bash, set `pass` to false and explain in `reason`.");
    const step: AgentStep = {
      kind: "agent", id: "live-deny", promptFile: "deny.md", model: "claude-sonnet-5", allowedTools: ["Read"], context: "fresh",
      schema: { type: "object", properties: { pass: { type: "boolean" }, reason: { type: "string" } }, required: ["pass", "reason"] },
      maxTurns: 6, timeoutMs: 120_000, maxBudgetUsd: 0.5,
    };
    const tools: string[] = [];
    let result: Record<string, unknown> | undefined;
    const emit = async (k: EventKind, p: Record<string, unknown>) => {
      if (k === "agent_tool_call") tools.push(String(p["tool"]));
      if (k === "agent_result") result = p;
    };
    const r = await createAgentExecutor({ query: sdkQuery })(step, { runId: "r1", episodeId: "s02e01", showRoot: root, results: {} }, emit);
    expect(r.ok).toBe(true);
    expect(tools.every((t) => t !== "Bash")).toBe(true);
    if (r.ok) expect((r.verdict as { pass: boolean }).pass).toBe(false);
    // Informational, printed so a run of this test records what the SDK reported.
    console.log("deny run:", JSON.stringify({ tools, permissionDenials: result?.["permissionDenials"], deniedTools: result?.["deniedTools"], verdict: (r as { verdict?: unknown }).verdict }));
  }, 180_000);
});

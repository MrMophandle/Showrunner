import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAgentExecutor } from "../src/agent-step.js";
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

import { describe, it, expect } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAgentExecutor, createGateMessageRenderer, type AgentMessage, type AgentQueryOptions, type QueryFn } from "../src/agent-step.js";
import type { AgentStep, EventKind, RunContext } from "../src/steps.js";

const promptsDir = path.resolve(import.meta.dirname, "fixtures/prompts");
const ctx = (): RunContext => ({ runId: "r1", episodeId: "s02e01", showRoot: "/show", results: { setup: "ready", review: { verdict: "V", issues: [] }, "gate:rejection": "no" } });
const step = (over: Partial<AgentStep> = {}): AgentStep => ({ kind: "agent", id: "a", promptFile: "hello.md", model: "medium", allowedTools: ["Read", "Glob"], context: "fresh", ...over });
const schema = { type: "object", properties: { pass: { type: "boolean" } }, required: ["pass"] };

function recorder() {
  const events: Array<{ kind: EventKind; payload: Record<string, unknown> }> = [];
  const emit = async (kind: EventKind, payload: Record<string, unknown>) => { events.push({ kind, payload }); };
  return { events, emit };
}
function fake(messages: AgentMessage[], opts: { throwAfter?: boolean; throwBefore?: Error } = {}) {
  const calls: Array<{ prompt: string; options: AgentQueryOptions }> = [];
  const query: QueryFn = async function* (args) {
    calls.push(args);
    if (opts.throwBefore) throw opts.throwBefore;
    for (const m of messages) yield m;
    if (opts.throwAfter) throw new Error("process exited with code 1");
  };
  return { calls, query };
}
const init: AgentMessage = { type: "system", subtype: "init", session_id: "sess-1" };
const toolUse = (name: string, input: unknown, id = "tu1"): AgentMessage => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const text = (t: string): AgentMessage => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const success = (over: Partial<AgentMessage> = {}): AgentMessage => ({ type: "result", subtype: "success", result: "final text", session_id: "sess-1", num_turns: 3, duration_ms: 1200, total_cost_usd: 0.02, permission_denials: [], ...over });

describe("createAgentExecutor: options", () => {
  it("maps the step onto SDK options with dontAsk, no settings, the claude_code preset, and cwd = showRoot", async () => {
    const f = fake([init, success()]);
    const ex = createAgentExecutor({ query: f.query, promptsDir, models: { medium: "claude-sonnet-5" } });
    const r = await ex(step({ allowedTools: ["Read", "Glob", "mcp__x__y"], maxTurns: 7, maxBudgetUsd: 1.5 }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: true, text: "final text", toolCalls: 0 });
    const o = f.calls[0]!.options;
    expect(o.cwd).toBe("/show");
    expect(o.model).toBe("claude-sonnet-5");
    expect(o.tools).toEqual(["Read", "Glob"]);
    expect(o.allowedTools).toEqual(["Read", "Glob", "mcp__x__y"]);
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.settingSources).toEqual([]);
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(o.abortController).toBeInstanceOf(AbortController);
    expect(o.maxTurns).toBe(7);
    expect(o.maxBudgetUsd).toBe(1.5);
    expect("outputFormat" in o).toBe(false);
    expect("resume" in o).toBe(false);
  });
  it("passes an unmapped model through unchanged and sets outputFormat from the schema", async () => {
    const f = fake([init, success({ structured_output: { pass: true } })]);
    const ex = createAgentExecutor({ query: f.query, promptsDir });
    await ex(step({ model: "claude-opus-4-8", schema }), ctx(), recorder().emit);
    expect(f.calls[0]!.options.model).toBe("claude-opus-4-8");
    expect(f.calls[0]!.options.outputFormat).toEqual({ type: "json_schema", schema });
  });
  it("renders the prompt and passes it as the query prompt", async () => {
    const f = fake([init, success()]);
    await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(f.calls[0]!.prompt).toContain("episode s02e01 in run r1.");
    expect(f.calls[0]!.prompt).toContain("Rejection: no");
  });
  it("defaults promptsDir to <showRoot>/prompts", async () => {
    const f = fake([init, success()]);
    const c = { ...ctx(), showRoot: path.resolve(import.meta.dirname, "fixtures") };
    await createAgentExecutor({ query: f.query })(step(), c, recorder().emit);
    expect(f.calls.length).toBe(1);
  });
  it("takes promptsDir and models from the show config, and renders {{season}} and {{show.*}}", async () => {
    const f = fake([init, success()]);
    const showRoot = await mkdtemp(path.join(tmpdir(), "show-"));
    await mkdir(path.join(showRoot, "p"));
    await writeFile(path.join(showRoot, "p", "s.md"), "Season {{season}} of {{show.showName}} for {{episodeId}}");
    const show = { showName: "Harbor Lights", showSlug: "HL", promptsDir: "p", models: { medium: "cfg-mid", large: "l", writer: "w" }, airMap: { ep07: [1, 7] as [number, number] }, output: { nasRoot: "/n" } };
    const ex = createAgentExecutor({ query: f.query, show });
    const rec = recorder();
    await ex(step({ promptFile: "s.md" }), { ...ctx(), showRoot, episodeId: "ep07" }, rec.emit);
    expect(f.calls[0]!.prompt).toBe("Season 1 of Harbor Lights for ep07");
    expect(f.calls[0]!.options.model).toBe("cfg-mid");
    expect(rec.events[0]!.payload["showConfig"]).toBe(true);
  });
  it("explicit promptsDir and models override the show config", async () => {
    const f = fake([init, success()]);
    const show = { showName: "H", showSlug: "H", promptsDir: "/nowhere", models: { medium: "cfg-mid", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/n" } };
    await createAgentExecutor({ query: f.query, show, promptsDir, models: { medium: "explicit" } })(step(), ctx(), recorder().emit);
    expect(f.calls[0]!.options.model).toBe("explicit");
  });
  it("a production id absent from the air map only fails when the prompt uses {{season}}", async () => {
    const f = fake([init, success()]);
    const show = { showName: "H", showSlug: "H", promptsDir, models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/n" } };
    const r = await createAgentExecutor({ query: f.query, show })(step({ promptFile: "plain.md" }), { ...ctx(), episodeId: "ep99" }, recorder().emit);
    expect(r.ok).toBe(true);
  });
});

describe("createAgentExecutor: events", () => {
  it("emits agent_query, one agent_tool_call per tool_use block in order, then agent_result", async () => {
    const f = fake([init, toolUse("Read", { file_path: "a.md" }, "t1"), text("thinking"), toolUse("Grep", { pattern: "x" }, "t2"), success()]);
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, models: { medium: "m-id" } })(step(), ctx(), rec.emit);
    expect(r).toEqual({ ok: true, text: "final text", toolCalls: 2 });
    expect(rec.events.map((e) => e.kind)).toEqual(["agent_query", "agent_tool_call", "agent_tool_call", "agent_result"]);
    const raw = await readFile(path.join(promptsDir, "hello.md"));
    expect(rec.events[0]!.payload).toMatchObject({ promptFile: "hello.md", promptHash: createHash("sha256").update(raw).digest("hex"), model: "m-id", modelAlias: "medium", allowedTools: ["Read", "Glob"], context: "fresh", schema: false, resumed: false });
    expect(rec.events[1]!.payload).toEqual({ tool: "Read", input: { file_path: "a.md" }, toolUseId: "t1", index: 1 });
    expect(rec.events[2]!.payload).toEqual({ tool: "Grep", input: { pattern: "x" }, toolUseId: "t2", index: 2 });
    expect(rec.events[3]!.payload).toMatchObject({ ok: true, subtype: "success", text: "final text", toolCalls: 2, numTurns: 3, durationMs: 1200, costUsd: 0.02, sessionId: "sess-1", permissionDenials: 0, deniedTools: [] });
    expect("verdict" in rec.events[3]!.payload).toBe(false);
  });
  it("records the verdict, not the text, when the step has a schema", async () => {
    const f = fake([init, success({ structured_output: { pass: false }, permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }] })]);
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step({ promptFile: "verdict.md", schema }), ctx(), rec.emit);
    expect(r).toEqual({ ok: true, text: "final text", verdict: { pass: false }, toolCalls: 0 });
    const res = rec.events.at(-1)!.payload;
    expect(res).toMatchObject({ ok: true, verdict: { pass: false }, permissionDenials: 2, deniedTools: ["Bash"] });
    expect("text" in res).toBe(false);
    expect(rec.events[0]!.payload["schema"]).toBe(true);
  });
});

describe("createAgentExecutor: failures", () => {
  it("a success with a schema but no structured output fails", async () => {
    const f = fake([init, success()]);
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step({ schema }), ctx(), rec.emit);
    expect(r).toEqual({ ok: false, error: "success without structured output", toolCalls: 0 });
    expect(rec.events.at(-1)!.payload).toMatchObject({ ok: false, error: "success without structured output", subtype: "success" });
  });
  it("an error subtype fails with the subtype and the errors", async () => {
    const f = fake([init, { type: "result", subtype: "error_max_turns", errors: ["hit 7 turns", "stopped"], session_id: "sess-1", num_turns: 7, duration_ms: 5, total_cost_usd: 0.1 }]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "error_max_turns: hit 7 turns; stopped", toolCalls: 0 });
  });
  it("an error result carries the tool calls made before it, so a dead iteration is distinguishable", async () => {
    const f = fake([init, toolUse("Read", { file_path: "a.md" }, "t1"), toolUse("Grep", { pattern: "x" }, "t2"),
      { type: "result", subtype: "error_during_execution", session_id: "s", num_turns: 2, duration_ms: 3, total_cost_usd: 0 }]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step({ allowedTools: ["Read", "Grep"] }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "error_during_execution", toolCalls: 2 });
  });
  it("an error subtype with no errors fails with the bare subtype", async () => {
    const f = fake([init, { type: "result", subtype: "error_during_execution", session_id: "s", num_turns: 0, duration_ms: 1, total_cost_usd: 0 }]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "error_during_execution", toolCalls: 0 });
  });
  it("a throw after an error result is ignored in favour of the result", async () => {
    const f = fake([init, { type: "result", subtype: "error_max_budget_usd", errors: ["budget"], session_id: "s", num_turns: 2, duration_ms: 1, total_cost_usd: 1.5 }], { throwAfter: true });
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "error_max_budget_usd: budget", toolCalls: 0 });
  });
  it("a throw with no result fails with the message and still emits agent_result", async () => {
    const f = fake([], { throwBefore: new Error("Native CLI binary for darwin-arm64 not found") });
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), rec.emit);
    expect(r).toEqual({ ok: false, error: "query failed: Native CLI binary for darwin-arm64 not found", toolCalls: 0 });
    expect(rec.events.map((e) => e.kind)).toEqual(["agent_query", "agent_result"]);
    expect(rec.events[1]!.payload).toMatchObject({ ok: false, toolCalls: 0 });
  });
  it("a query that rejects with a non-Error value fails with that value stringified", async () => {
    const query: QueryFn = async function* () {
      throw { code: "ECONNRESET" };
    };
    const r = await createAgentExecutor({ query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "query failed: [object Object]", toolCalls: 0 });
  });
  it("a throw inside the executor's own message handling fails the step, even after a result arrived", async () => {
    // message.content is an object, not an array: the handler's for-of throws. The result message
    // already stored must not rescue the step — the executor never finished reading the stream.
    const malformed = { type: "assistant", message: { content: {} } } as unknown as AgentMessage;
    const f = fake([init, success(), malformed]);
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), rec.emit);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/^message handling failed: /);
    expect(rec.events.at(-1)!.payload).toMatchObject({ ok: false });
  });
  it("a result message with no subtype fails by naming the missing subtype", async () => {
    const f = fake([init, { type: "result", result: "t" }]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "result message with no subtype", toolCalls: 0 });
  });
  it("a stream that ends without a result fails", async () => {
    const f = fake([init, text("hi")]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "query ended without a result message", toolCalls: 0 });
  });
  it("a missing prompt file fails before any query and emits nothing", async () => {
    const f = fake([init, success()]);
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step({ promptFile: "absent.md" }), ctx(), rec.emit);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/absent\.md/);
    expect(f.calls.length).toBe(0);
    expect(rec.events).toEqual([]);
  });
  it("a template hole fails before any query", async () => {
    const f = fake([init, success()]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), { ...ctx(), results: {} }, recorder().emit);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/\{\{results\.setup\}\}/);
    expect(f.calls.length).toBe(0);
  });
  it("a schema that names draft-07 is accepted and the query is made", async () => {
    const f = fake([init, success({ structured_output: { pass: true } })]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step({ promptFile: "verdict.md", schema: { ...schema, $schema: "http://json-schema.org/draft-07/schema#" } }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: true, text: "final text", verdict: { pass: true }, toolCalls: 0 });
    expect(f.calls.length).toBe(1);
  });
  it("a schema declaring a newer draft fails before any query", async () => {
    const f = fake([init, success()]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step({ schema: { ...schema, $schema: "https://json-schema.org/draft/2020-12/schema" } }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "schema must be JSON Schema draft-07, got https://json-schema.org/draft/2020-12/schema" });
    expect(f.calls.length).toBe(0);
  });
  it("builds outputFormat from schemaFile, applies the same draft check, and refuses a step with both", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    await writeFile(path.join(dir, "audit.md"), "audit {{episodeId}}");
    await writeFile(path.join(dir, "audit.schema.json"), JSON.stringify(schema));
    await writeFile(path.join(dir, "newer.schema.json"), JSON.stringify({ ...schema, $schema: "https://json-schema.org/draft/2020-12/schema" }));
    await writeFile(path.join(dir, "broken.schema.json"), "{ not json");

    const f = fake([init, success({ structured_output: { pass: true } })]);
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir: dir })(step({ promptFile: "audit.md", schemaFile: "audit.schema.json" }), ctx(), rec.emit);
    expect(r).toEqual({ ok: true, text: "final text", verdict: { pass: true }, toolCalls: 0 });
    expect(f.calls[0]!.options.outputFormat).toEqual({ type: "json_schema", schema });
    expect(rec.events[0]!.payload["schema"]).toBe(true);
    expect(rec.events.at(-1)!.payload).toMatchObject({ verdict: { pass: true } });

    const ex = createAgentExecutor({ query: f.query, promptsDir: dir });
    expect(await ex(step({ promptFile: "audit.md", schema, schemaFile: "audit.schema.json" }), ctx(), recorder().emit))
      .toEqual({ ok: false, error: "schema and schemaFile are exclusive" });
    expect(await ex(step({ promptFile: "audit.md", schemaFile: "newer.schema.json" }), ctx(), recorder().emit))
      .toEqual({ ok: false, error: "schema must be JSON Schema draft-07, got https://json-schema.org/draft/2020-12/schema" });
    expect(await ex(step({ promptFile: "audit.md", schemaFile: "broken.schema.json" }), ctx(), recorder().emit))
      .toMatchObject({ ok: false, error: expect.stringContaining('schema file "broken.schema.json" is not valid JSON') });
    const absent = await ex(step({ promptFile: "audit.md", schemaFile: "absent.schema.json" }), ctx(), recorder().emit);
    expect(absent).toMatchObject({ ok: false, error: expect.stringContaining("absent.schema.json") });
    // Every rejection above happens before the query, so only the first step ever reached it.
    expect(f.calls.length).toBe(1);
  });
});

describe("{{vars.<name>}}", () => {
  it("renders the step's own vars into its prompt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    await writeFile(path.join(dir, "write.md"), "Write {{vars.file}} for {{episodeId}}.");
    const f = fake([init, success()]);
    const r = await createAgentExecutor({ query: f.query, promptsDir: dir })(step({ promptFile: "write.md", vars: { file: "Canon/x.md" } }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: true, text: "final text", toolCalls: 0 });
    expect(f.calls[0]!.prompt).toContain("Canon/x.md");
    expect(f.calls[0]!.prompt).toBe("Write Canon/x.md for s02e01.");
  });
  it("fails the step when its prompt names a var the step does not declare", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    await writeFile(path.join(dir, "write.md"), "Write {{vars.file}}.");
    const f = fake([init, success()]);
    const r = await createAgentExecutor({ query: f.query, promptsDir: dir })(step({ promptFile: "write.md" }), ctx(), recorder().emit);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("{{vars.file}}: vars are not available") });
    expect(f.calls.length).toBe(0);
  });
  it("createGateMessageRenderer renders the vars it is handed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    await writeFile(path.join(dir, "gate.md"), "Approve {{vars.file}} for {{episodeId}}?");
    const render = createGateMessageRenderer({ query: () => { throw new Error("no query may run for a gate message"); }, promptsDir: dir });
    expect(await render("gate.md", ctx(), { file: "Canon/x.md" })).toBe("Approve Canon/x.md for s02e01?");
    await expect(render("gate.md", ctx())).rejects.toThrow(/\{\{vars\.file\}\}: vars are not available/);
  });
});

describe("the reserved episode id has no season", () => {
  /** The interview runs every bible file under the reserved id (ids.ts), which is not an episode:
   *  `seasonOf` throws InvalidEpisodeId for it, and that throw used to escape renderExtraFor and
   *  fail every interview step and gate message built with a show config — which all of them are,
   *  because the three interview prompts open with {{show.showName}}. */
  const show = { showName: "Harbor Lights", showSlug: "HL", promptsDir: "p", models: { medium: "m", large: "l", writer: "w" }, airMap: { ep07: [1, 7] as [number, number] }, output: { nasRoot: "/n" } };

  it("renders {{show.*}} and {{vars.*}} for the reserved id, and leaves {{season}} unavailable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    await writeFile(path.join(dir, "write.md"), "Writer for {{show.showName}}: write {{vars.file}} in {{episodeId}}.");
    await writeFile(path.join(dir, "seasonal.md"), "Season {{season}}.");
    const f = fake([init, success()]);
    const ex = createAgentExecutor({ query: f.query, promptsDir: dir, show });
    const setupCtx = { ...ctx(), episodeId: "setup" };
    const ok = await ex(step({ promptFile: "write.md", vars: { file: "Canon/style-guide.md" } }), setupCtx, recorder().emit);
    expect(ok).toEqual({ ok: true, text: "final text", toolCalls: 0 });
    expect(f.calls[0]!.prompt).toBe("Writer for Harbor Lights: write Canon/style-guide.md in setup.");
    const seasonal = await ex(step({ promptFile: "seasonal.md" }), setupCtx, recorder().emit);
    expect(seasonal).toMatchObject({ ok: false, error: expect.stringContaining("{{season}}: season is not available") });
  });

  it("renders a gate message for the reserved id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    await writeFile(path.join(dir, "gate.md"), "{{vars.file}} of {{show.showName}} is ready.");
    const render = createGateMessageRenderer({ query: () => { throw new Error("no query may run for a gate message"); }, promptsDir: dir, show });
    expect(await render("gate.md", { ...ctx(), episodeId: "setup" }, { file: "Canon/style-guide.md" }))
      .toBe("Canon/style-guide.md of Harbor Lights is ready.");
  });

  it("still throws for a malformed episode id that is not the reserved one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prompts-"));
    await writeFile(path.join(dir, "plain.md"), "Plain.");
    const f = fake([init, success()]);
    const r = await createAgentExecutor({ query: f.query, promptsDir: dir, show })(step({ promptFile: "plain.md" }), { ...ctx(), episodeId: "setups" }, recorder().emit);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("invalid episode id") });
    expect(f.calls.length).toBe(0);
  });
});

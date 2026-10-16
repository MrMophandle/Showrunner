import { describe, it, expect } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAgentExecutor, createGateMessageRenderer, type AgentMessage, type AgentQueryOptions, type AgentRateLimit, type AgentUsage, type QueryFn } from "../src/agent-step.js";
import type { ShowConfig } from "../src/show-config.js";
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
/** The fake query seam. One stream of messages is yielded by every call, as it always was; a list
 *  of streams gives each call its own, and the last one repeats — which is what a retry after a
 *  usage limit needs, the second attempt being a different conversation from the one that was
 *  refused. */
function fake(messages: AgentMessage[] | AgentMessage[][], opts: { throwAfter?: boolean; throwBefore?: Error } = {}) {
  const streams: AgentMessage[][] = Array.isArray(messages[0]) ? (messages as AgentMessage[][]) : [messages as AgentMessage[]];
  const calls: Array<{ prompt: string; options: AgentQueryOptions }> = [];
  const query: QueryFn = async function* (args) {
    calls.push(args);
    if (opts.throwBefore) throw opts.throwBefore;
    for (const m of streams[Math.min(calls.length - 1, streams.length - 1)] ?? []) yield m;
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
  it("records the plan's utilization windows on every agent_result that saw them, and omits the field otherwise", async () => {
    // The field Plan J adds, and the gap it closes (inventory J-19): before it, the weekly figure
    // reached the log only through `limit.weeklyUtilization` or `step_waiting`, both of which need a
    // classified limit, so an unlimited run carried no figure at all — and a `panel` step's weekly
    // stop has to read one on a run where nothing was ever limited.
    const windows: AgentUsage = { available: true, fiveHour: { utilization: 26, resetsAt: null }, sevenDay: { utilization: 38, resetsAt: null } };
    const f = fake([init, { type: "usage", usage: windows }, success()]);
    const rec = recorder();
    await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), rec.emit);
    expect(rec.events.at(-1)!.payload["usage"]).toEqual(windows);

    // A stream that yielded none — an SDK whose control request went unanswered — leaves the field
    // absent rather than writing a figure nobody measured.
    const bare = fake([init, success()]);
    const rec2 = recorder();
    await createAgentExecutor({ query: bare.query, promptsDir })(step(), ctx(), rec2.emit);
    expect("usage" in rec2.events.at(-1)!.payload).toBe(false);
  });
  it("renders the round and the prior verdicts from the log's latest panel_round", async () => {
    // The handoff the reset would otherwise break (inventory J-14): a reviewer's own last verdict is
    // deleted from ctx.results by the step_reset that re-ran it, so the prompt reads it back out of
    // the log, which RunContext.events already carries. The round and its cost ride on the same
    // event, so one record answers "which round is this" for the reviewers, the writer and the gate.
    const events = [
      { ts: "2026-01-01T10:00:00.000Z", runId: "r1", kind: "run_started" as const, payload: {} },
      {
        ts: "2026-01-01T10:05:00.000Z", runId: "r1", stepId: "panel", kind: "panel_round" as const,
        payload: {
          round: 2, green: false, costUsd: 15.8878, by: "panel:panel:round-2",
          verdicts: { "tone-check": { pass: false, issues: ["scene five — the analogy ration"] }, revise: "## Changed\nScene five." },
        },
      },
    ];
    const f = fake([init, success()]);
    await createAgentExecutor({ query: f.query, promptsDir })(step({ promptFile: "round.md" }), { ...ctx(), events }, recorder().emit);
    expect(f.calls[0]!.prompt).toBe([
      "Round 3 of the review, $15.8878 spent.",
      "Your prior verdict: {",
      '  "pass": false,',
      '  "issues": [',
      '    "scene five — the analogy ration"',
      "  ]",
      "}",
      "The writer's prior report: ## Changed",
      "Scene five.",
      "",
    ].join("\n"));

    // With no panel_round in the log — round 1, and every run before Plan J — the same prompt
    // renders rather than failing: round 1, nothing spent, and `none` for each prior verdict.
    const first = fake([init, success()]);
    await createAgentExecutor({ query: first.query, promptsDir })(step({ promptFile: "round.md" }), ctx(), recorder().emit);
    expect(first.calls[0]!.prompt).toBe("Round 1 of the review, $0 spent.\nYour prior verdict: none\nThe writer's prior report: none\n");
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

/** The usage limit, as the s02e01 run of 2026-10-14 produced it. The reset is the one that run
 *  reported; `SDK_FIVE_HOUR_TEXT` is the sentence the SDK put in the assistant message verbatim,
 *  and it is the only source of the reset's time zone. */
const RESET_ISO = "2026-10-14T23:50:00.000Z";
const RESET_PLUS_A_MINUTE = "2026-10-14T23:51:00.000Z";
/** The clock the cases that wait inject: fifty minutes before `RESET_ISO`, so the wake instant (the
 *  reset plus the minute of grace, ruling I-03) is still ahead of "now" and the rule sleeps.
 *  Without it these cases read the wall clock, which has been past 2026-10-14 since the day after
 *  the measured run — and a wake instant already passed is retried at once, with no sleep (ruling
 *  I-22). Injecting the clock is what keeps these cases about the wait. */
const BEFORE_RESET = new Date("2026-10-14T23:00:00.000Z");
const beforeReset = () => BEFORE_RESET;
/** An hour past `RESET_ISO`, and so past its minute of grace too: the clock the already-passed
 *  cases inject. */
const AFTER_RESET = new Date("2026-10-15T00:50:00.000Z");
const afterReset = () => AFTER_RESET;
const SDK_FIVE_HOUR_TEXT = "You've hit your session limit · resets 7:50pm (America/New_York)";
const SDK_SEVEN_DAY_TEXT = "You've hit your weekly limit · resets Mon 9:00am (America/New_York)";

/** `null` rather than `undefined` for "the SDK named no reset time": an explicit `undefined` would
 *  take the default parameter, which is the reset, and the test would prove the opposite. */
const rejectedLimit = (window: string, resetsAt: string | null = RESET_ISO): AgentMessage =>
  ({ type: "rate_limit_event", rateLimit: { status: "rejected", window, utilization: 100, ...(resetsAt !== null ? { resetsAt } : {}) } });
const limitedTurn = (kind: string, sdkText: string): AgentMessage =>
  ({ type: "assistant", error: kind, message: { content: [{ type: "text", text: sdkText }] } });
const usageIs = (usage: AgentUsage): AgentMessage => ({ type: "usage", usage });
/** A seven-day window reporting in, as the SDK sends it mid-stream: `allowed`, with the week's
 *  utilization on it. This is the weekly figure's first source — it is already in the stream. */
const sevenDayReport = (utilization: number, status: AgentRateLimit["status"] = "allowed", window = "seven_day"): AgentMessage =>
  ({ type: "rate_limit_event", rateLimit: { status, window, utilization, resetsAt: "2026-10-19T04:00:00.000Z" } });
const weeklyAt = (utilization: number): AgentUsage => ({ available: true, sevenDay: { utilization, resetsAt: "2026-10-19T04:00:00.000Z" } });

/** A five-hour limit's stream: the SDK's refused turn, the rejected window event, the wrapper's one
 *  synthetic usage message, and the `subtype: "success"` result the SDK really does send — the
 *  measured run's `agent_result` was `ok: true, subtype: "success"` with the limit sentence as its
 *  text, which is why the classification has to outrank the subtype. */
const limitedStream = (window: string, usage: AgentUsage, sdkText = SDK_FIVE_HOUR_TEXT, resetsAt: string | null = RESET_ISO): AgentMessage[] =>
  [init, limitedTurn("rate_limit", sdkText), rejectedLimit(window, resetsAt), usageIs(usage), success({ result: sdkText })];

function sleeper() {
  const slept: string[] = [];
  return { slept, sleepUntil: async (iso: string) => { slept.push(iso); } };
}

const show = (over: Partial<ShowConfig> = {}): ShowConfig => ({
  showName: "Harbor Lights", showSlug: "HarborLights", promptsDir: "p",
  models: { medium: "m-id", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/n" }, ...over,
});

describe("createAgentExecutor: a plan usage limit", () => {
  it("(a) waits out a five-hour limit under the ceiling, resumes the same session once, and succeeds", async () => {
    const f = fake([limitedStream("five_hour", weeklyAt(41)), [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })]]);
    const s = sleeper();
    const rec = recorder();
    const ex = createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: s.sleepUntil });
    const r = await ex(step(), ctx(), rec.emit);

    expect(r).toEqual({ ok: true, text: "REVISIONS_COMPLETE", toolCalls: 0 });
    // One minute past the reset, not the reset itself: the window's clock and this machine's are
    // not the same clock.
    expect(s.slept).toEqual([RESET_PLUS_A_MINUTE]);
    // The retry is the same conversation continued, so it resumes the session the refused attempt
    // opened — whatever the step's context policy says about a *later* query of the step.
    expect(f.calls).toHaveLength(2);
    expect("resume" in f.calls[0]!.options).toBe(false);
    expect(f.calls[1]!.options.resume).toBe("sess-1");

    const waiting = rec.events.filter((e) => e.kind === "step_waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.payload["reason"]).toBe("waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)");
    expect(waiting[0]!.payload).toMatchObject({ window: "five_hour", resetsAt: RESET_ISO, weeklyUtilization: 41, ceiling: 65 });
    // The wait is logged before the retry is issued, so a crash during the wait leaves the reason
    // in the log (spec §6.5) rather than only in the worker's memory.
    expect(rec.events.map((e) => e.kind)).toEqual(["agent_query", "step_waiting", "agent_query", "agent_result"]);
    const result = rec.events.at(-1)!;
    expect(result.payload["ok"]).toBe(true);
    expect(result.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", resetsAt: RESET_ISO, weeklyUtilization: 41, weeklySource: "usage", waited: true });
  });

  it("(b) refuses to retry when the weekly quota is at or above the ceiling, and says so with both numbers", async () => {
    const f = fake(limitedStream("five_hour", weeklyAt(78)));
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);

    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit (resets 7:50pm America/New_York) and the weekly quota is at 78%, above the 65% auto-retry ceiling (agents.autoRetryWeeklyUtilizationMax).");
    expect(s.slept).toEqual([]);
    expect(f.calls).toHaveLength(1);
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", resetsAt: RESET_ISO, weeklyUtilization: 78, weeklySource: "usage", waited: false });
  });

  it("(c) never waits out a seven-day window, whichever of the four it is", async () => {
    for (const window of ["seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]) {
      const f = fake(limitedStream(window, weeklyAt(12), SDK_SEVEN_DAY_TEXT));
      const s = sleeper();
      const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: s.sleepUntil })(step(), ctx(), recorder().emit);
      // The weekly figure is well under the ceiling and is beside the point: the ceiling governs
      // the five-hour window only, and a seven-day limit is nothing the engine can wait out.
      expect(r.ok, window).toBe(false);
      expect(r.ok ? "" : r.error, window).toBe("Manual resume needed: the writer's session hit its 7-day limit (resets Mon 9:00am America/New_York); press Resume after the reset.");
      expect(s.slept, window).toEqual([]);
      expect(f.calls, window).toHaveLength(1);
    }
  });

  it("(d) refuses to retry when the weekly utilization is unknown", async () => {
    const f = fake(limitedStream("five_hour", { available: false }));
    const s = sleeper();
    const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: s.sleepUntil })(step(), ctx(), recorder().emit);
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit (resets 7:50pm America/New_York) and the weekly utilization is unknown.");
    expect(s.slept).toEqual([]);
  });

  it("(e) takes one wait and no more: a limit that trips again after it fails the step", async () => {
    const f = fake([limitedStream("five_hour", weeklyAt(41)), limitedStream("five_hour", weeklyAt(41))]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit again after waiting once (resets 7:50pm America/New_York); press Resume after the reset.");
    expect(f.calls).toHaveLength(2);
    expect(s.slept).toEqual([RESET_PLUS_A_MINUTE]);
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", resetsAt: RESET_ISO, weeklyUtilization: 41, weeklySource: "usage", waited: true });
  });

  it("(f) fails a reply refused for any other SDK error kind, naming the kind and the SDK's text", async () => {
    const f = fake([init, limitedTurn("billing_error", "Your credit balance is too low to run this request."), success({ result: "" })]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toBe("the model's reply was refused (billing_error): Your credit balance is too low to run this request.");
    // None of the twelve other kinds is cured by time, so no wait and no retry.
    expect(s.slept).toEqual([]);
    expect(f.calls).toHaveLength(1);
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "billing_error" });
  });

  it("reads the ceiling from the show config, and names that number in the sentence", async () => {
    // The same 41% that is waited out under the default 65 is a manual resume under a ceiling of
    // 40, and the sentence quotes the configured number rather than the default.
    const f = fake(limitedStream("five_hour", weeklyAt(41)));
    const s = sleeper();
    const ex = createAgentExecutor({ query: f.query, promptsDir, sleepUntil: s.sleepUntil, show: show({ agents: { autoRetryWeeklyUtilizationMax: 40 } }) });
    const r = await ex(step(), ctx(), recorder().emit);
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit (resets 7:50pm America/New_York) and the weekly quota is at 41%, above the 40% auto-retry ceiling (agents.autoRetryWeeklyUtilizationMax).");
    expect(s.slept).toEqual([]);
  });

  it("renders the reset as ISO when the SDK's text names no zone, and drops the clause when there is no reset at all", async () => {
    const noZone = fake(limitedStream("five_hour", weeklyAt(90), "You've hit your session limit."));
    const r1 = await createAgentExecutor({ query: noZone.query, promptsDir, sleepUntil: sleeper().sleepUntil })(step(), ctx(), recorder().emit);
    expect(r1.ok ? "" : r1.error).toBe(`Manual resume needed: the writer's session hit its 5-hour limit (resets ${RESET_ISO}) and the weekly quota is at 90%, above the 65% auto-retry ceiling (agents.autoRetryWeeklyUtilizationMax).`);

    // A seven-day limit the SDK gave no reset time for: the clause is dropped rather than printed
    // with a hole in it, and the move is still named.
    const noReset = fake(limitedStream("seven_day", weeklyAt(90), "You've hit your weekly limit.", null));
    const r2 = await createAgentExecutor({ query: noReset.query, promptsDir, sleepUntil: sleeper().sleepUntil })(step(), ctx(), recorder().emit);
    expect(r2.ok ? "" : r2.error).toBe("Manual resume needed: the writer's session hit its 7-day limit; press Resume after the reset.");
  });

  it("a rejected window with no error kind beside it is still a usage limit", async () => {
    // The measured stream carried both signals. Either one alone is enough to know the query was
    // refused, so a rejection with no assistant error still fails rather than reporting the
    // SDK's `subtype: "success"` as a success that did no work.
    const f = fake([init, rejectedLimit("five_hour"), usageIs(weeklyAt(99)), success({ result: "nothing was written" })]);
    const s = sleeper();
    const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: s.sleepUntil })(step(), ctx(), recorder().emit);
    expect(r.ok).toBe(false);
    // No SDK sentence means no zone to render, so the reset falls back to the ISO.
    expect(r.ok ? "" : r.error).toContain(`(resets ${RESET_ISO})`);
  });

  it("a deadline still outranks a limit: a timeout is a timeout", async () => {
    // The engine's own clocks are its own fault and keep their wording, so a limit that arrives in
    // the same stream as a timeout does not rename the failure.
    const slow: QueryFn = async function* () {
      yield init;
      yield limitedTurn("rate_limit", SDK_FIVE_HOUR_TEXT);
      yield rejectedLimit("five_hour");
      await new Promise((r) => setTimeout(r, 60));
      yield success();
    };
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: slow, promptsDir, sleepUntil: s.sleepUntil })(step({ timeoutMs: 20 }), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toBe("timeout after 20ms");
    expect(s.slept).toEqual([]);
    expect("limit" in rec.events.at(-1)!.payload).toBe(false);
  });
});

describe("createAgentExecutor: where the weekly figure comes from", () => {
  it("reads it off the stream's seven-day event, with no usage message at all", async () => {
    // The usage call is a control request the SDK documents as streaming-input-only, so a real
    // five-hour limit may well arrive with no usage message behind it. The seven-day event in the
    // same stream answers the question without asking anything, and the rule applies as normal.
    const f = fake([
      [init, sevenDayReport(41), limitedTurn("rate_limit", SDK_FIVE_HOUR_TEXT), rejectedLimit("five_hour"), success({ result: SDK_FIVE_HOUR_TEXT })],
      [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })],
    ]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok).toBe(true);
    expect(s.slept).toEqual([RESET_PLUS_A_MINUTE]);
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", resetsAt: RESET_ISO, weeklyUtilization: 41, weeklySource: "event", waited: true });
  });

  it("falls back to the usage call when no seven-day event was seen", async () => {
    const f = fake(limitedStream("five_hour", weeklyAt(78)));
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: sleeper().sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok).toBe(false);
    expect(rec.events.at(-1)!.payload["limit"]).toMatchObject({ weeklyUtilization: 78, weeklySource: "usage" });
  });

  it("the event wins when both answer, and the five-hour rejection still names the window", async () => {
    // The two sources disagree on purpose here: the event says 90% and the usage call says 10%. The
    // event is the stream's own number and is taken, so the step refuses to retry. The trailing
    // seven-day event also proves the window is read off the *rejected* event rather than off the
    // last one — reading the last would blame the week, which was still allowed, and the sentence
    // would name the wrong window.
    const f = fake([init, limitedTurn("rate_limit", SDK_FIVE_HOUR_TEXT), rejectedLimit("five_hour"), usageIs(weeklyAt(10)), sevenDayReport(90), success({ result: SDK_FIVE_HOUR_TEXT })]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit (resets 7:50pm America/New_York) and the weekly quota is at 90%, above the 65% auto-retry ceiling (agents.autoRetryWeeklyUtilizationMax).");
    expect(s.slept).toEqual([]);
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", resetsAt: RESET_ISO, weeklyUtilization: 90, weeklySource: "event", waited: false });
  });

  it("a per-model seven-day event is not the weekly figure: the usage call answers instead", async () => {
    // The two sources have to answer one question. A `seven_day_opus` event at 90% reports a
    // per-model window, not the account-wide quota Ryan's rule reads, so the figure is the usage
    // call's 10% and the step waits. Read the other way, the event's 90 would block a wait the
    // account was owed and send the operator a manual-resume sentence for nothing.
    const f = fake([
      [init, sevenDayReport(90, "allowed", "seven_day_opus"), limitedTurn("rate_limit", SDK_FIVE_HOUR_TEXT), rejectedLimit("five_hour"), usageIs(weeklyAt(10)), success({ result: SDK_FIVE_HOUR_TEXT })],
      [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })],
    ]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok).toBe(true);
    expect(s.slept).toEqual([RESET_PLUS_A_MINUTE]);
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", resetsAt: RESET_ISO, weeklyUtilization: 10, weeklySource: "usage", waited: true });
    expect(rec.events.find((e) => e.kind === "step_waiting")!.payload["weeklyUtilization"]).toBe(10);
  });

  it("a per-model seven-day event with nothing behind it leaves the weekly figure unknown", async () => {
    // The mirror case: no usage call answers, so the question is unanswered rather than answered
    // with a per-model number, and the rule refuses to wait. `seven_day_overage_included` is the
    // fourth kind the SDK declares and the one `isSevenDay`'s prefix match quietly covers, which
    // is why the figure needs a test of its own.
    const f = fake([init, sevenDayReport(5, "allowed", "seven_day_overage_included"), limitedTurn("rate_limit", SDK_FIVE_HOUR_TEXT), rejectedLimit("five_hour"), usageIs({ available: false }), success({ result: SDK_FIVE_HOUR_TEXT })]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit (resets 7:50pm America/New_York) and the weekly utilization is unknown.");
    expect(s.slept).toEqual([]);
    expect("weeklySource" in (rec.events.at(-1)!.payload["limit"] as Record<string, unknown>)).toBe(false);
  });

  it("a seven-day event with no figure is not a figure", async () => {
    // An event that names the window but carries no utilization leaves the question to the usage
    // call rather than answering it with nothing.
    const f = fake([init, { type: "rate_limit_event", rateLimit: { status: "allowed", window: "seven_day" } }, limitedTurn("rate_limit", SDK_FIVE_HOUR_TEXT), rejectedLimit("five_hour"), usageIs({ available: false }), success({ result: SDK_FIVE_HOUR_TEXT })]);
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: sleeper().sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit (resets 7:50pm America/New_York) and the weekly utilization is unknown.");
    expect("weeklySource" in (rec.events.at(-1)!.payload["limit"] as Record<string, unknown>)).toBe(false);
  });
});

describe("createAgentExecutor: the edges of the usage-limit rule", () => {
  it("a weekly quota exactly at the ceiling is not below it: the sentence reads 'at', and one point under it retries", async () => {
    // The rule is "strictly below the ceiling", so 65 against the default 65 is a manual resume —
    // and "above the 65% ceiling" would be false of a quota that is exactly 65. The two sides of
    // the boundary are pinned together, because the sentence and the branch are one decision.
    const at = fake(limitedStream("five_hour", weeklyAt(65)));
    const atSleeper = sleeper();
    const rAt = await createAgentExecutor({ query: at.query, promptsDir, now: beforeReset, sleepUntil: atSleeper.sleepUntil })(step(), ctx(), recorder().emit);
    expect(rAt.ok ? "" : rAt.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit (resets 7:50pm America/New_York) and the weekly quota is at 65%, at the 65% auto-retry ceiling (agents.autoRetryWeeklyUtilizationMax).");
    expect(atSleeper.slept).toEqual([]);
    expect(at.calls).toHaveLength(1);

    const under = fake([limitedStream("five_hour", weeklyAt(64)), [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })]]);
    const underSleeper = sleeper();
    const rUnder = await createAgentExecutor({ query: under.query, promptsDir, now: beforeReset, sleepUntil: underSleeper.sleepUntil })(step(), ctx(), recorder().emit);
    expect(rUnder.ok).toBe(true);
    expect(underSleeper.slept).toEqual([RESET_PLUS_A_MINUTE]);
  });

  it("a five-hour limit under the ceiling with no reset time cannot be waited out, and says which half is missing", async () => {
    // The one combination that reaches the fourth five-hour sentence: the window is right, the
    // weekly quota is well under the ceiling, and the SDK gave nothing to sleep until.
    const f = fake(limitedStream("five_hour", weeklyAt(41), "You've hit your session limit.", null));
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit and the SDK named no reset time to wait for; press Resume once the window has reset.");
    expect(s.slept).toEqual([]);
    expect(f.calls).toHaveLength(1);
    expect(rec.events.some((e) => e.kind === "step_waiting")).toBe(false);
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", weeklyUtilization: 41, weeklySource: "usage", waited: false });

    // The same sentence when the SDK's *prose* names a time: "resets 7:50pm" is not something a
    // timer can be set to, so the step still refuses to wait rather than parsing a sentence into a
    // schedule. The prose time is not quoted here, because quoting it beside "named no reset time"
    // would read as a contradiction.
    const prose = fake(limitedStream("five_hour", weeklyAt(41), SDK_FIVE_HOUR_TEXT, null));
    const proseSleeper = sleeper();
    const r2 = await createAgentExecutor({ query: prose.query, promptsDir, sleepUntil: proseSleeper.sleepUntil })(step(), ctx(), recorder().emit);
    expect(r2.ok ? "" : r2.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit and the SDK named no reset time to wait for; press Resume once the window has reset.");
    expect(proseSleeper.slept).toEqual([]);
  });

  it("a rate_limit error with no rate_limit_event anywhere names no window: 'hit its usage limit'", async () => {
    // The SDK said the turn ended on a usage limit and never said which window. The sentence must
    // not invent one, and must not read "hit its unknown limit" either.
    const f = fake([init, limitedTurn("rate_limit", "You've hit your session limit."), success({ result: "You've hit your session limit." })]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toContain("hit its usage limit");
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its usage limit; press Resume after the reset.");
    expect(s.slept).toEqual([]);
    // The log still records the limit, with the window named as unknown rather than guessed.
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "unknown", waited: false });
  });

  it("a retry that is refused for a different reason reports that reason, not the limit", async () => {
    // Plausible between the wait and the retry: the account is suspended, the credit runs out, the
    // credentials expire. The step reports what actually refused it; the wait is still in the log
    // as its own event, which is where the record of it lives once the limit is no longer the
    // failure.
    const f = fake([limitedStream("five_hour", weeklyAt(41)), [init, limitedTurn("billing_error", "Your credit balance is too low to run this request."), success({ result: "" })]]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toBe("the model's reply was refused (billing_error): Your credit balance is too low to run this request.");
    // `waited: true` rides along on the limit: five hours were spent on this step before the
    // credit ran out, and a reader of agent_result alone would otherwise see no trace of them.
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "billing_error", waited: true });
    expect(f.calls).toHaveLength(2);
    expect(s.slept).toEqual([RESET_PLUS_A_MINUTE]);
    expect(rec.events.filter((e) => e.kind === "step_waiting")).toHaveLength(1);
  });

  it("the tool count is the step's total across both attempts, and the indices run straight through", async () => {
    // One agent_result per step, so its toolCalls is the whole step's work — the two the refused
    // attempt did before the limit, plus the three the retry did. The agent_tool_call index is the
    // same counter, so the log has no repeated index and no gap.
    const f = fake([
      [init, toolUse("Read", { file_path: "a.md" }, "t1"), toolUse("Grep", { pattern: "x" }, "t2"), limitedTurn("rate_limit", SDK_FIVE_HOUR_TEXT), rejectedLimit("five_hour"), usageIs(weeklyAt(41)), success({ result: SDK_FIVE_HOUR_TEXT })],
      [init, toolUse("Edit", { file_path: "a.md" }, "t3"), toolUse("Write", { file_path: "b.md" }, "t4"), toolUse("Read", { file_path: "b.md" }, "t5"), success({ result: "REVISIONS_COMPLETE" })],
    ]);
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: sleeper().sleepUntil })(step(), ctx(), rec.emit);
    expect(r).toEqual({ ok: true, text: "REVISIONS_COMPLETE", toolCalls: 5 });
    const calls = rec.events.filter((e) => e.kind === "agent_tool_call");
    expect(calls.map((e) => e.payload["index"])).toEqual([1, 2, 3, 4, 5]);
    expect(calls.map((e) => e.payload["tool"])).toEqual(["Read", "Grep", "Edit", "Write", "Read"]);
    expect(rec.events.at(-1)!.payload["toolCalls"]).toBe(5);
  });

  it("the production sleeper is a real timer, measured against the clock it is given", async () => {
    // The one path that runs in production: no `sleepUntil` is injected, so the executor builds its
    // own from `setTimeout` and `now`. The clock is read twice — once by the call site's guard,
    // which must see the wake instant still ahead of it, and once by the sleeper — so it is given
    // two readings, which is what a real clock does across a sleep. The first is a second before
    // the reset; the second is five milliseconds before the instant the executor sleeps until (the
    // reset plus the one-minute grace), so the real timer fires almost at once. If `now` were
    // ignored, the same sleeper would wait two minutes against the wall clock and this test would
    // fail on its own timeout — which is what makes it a test of the default path rather than of
    // nothing.
    const reset = new Date(Date.now() + 120_000).toISOString();
    const f = fake([limitedStream("five_hour", weeklyAt(41), SDK_FIVE_HOUR_TEXT, reset), [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })]]);
    const readings = [new Date(Date.parse(reset) - 1_000), new Date(Date.parse(reset) + 60_000 - 5)];
    const now = () => readings.shift() ?? new Date(Date.parse(reset) + 60_000 - 5);
    const started = Date.now();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: true, text: "REVISIONS_COMPLETE", toolCalls: 0 });
    expect(f.calls).toHaveLength(2);
    // Both readings were consumed: the guard took one and the sleeper took the other.
    expect(readings).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a wake instant the clock has already passed is retried at once, and the log says no wait was taken", async () => {
    // Ruling I-22. A reset time already past satisfies "the SDK named a reset", so the rule fires —
    // but there is nothing to sleep until, and a sleeper handed an instant in the past returns in
    // zero. The step_waiting is still written, because it is the log's only record that the rule
    // fired at all; its reason and `waited: false` are what say that no time was spent.
    const f = fake([limitedStream("five_hour", weeklyAt(41)), [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })]]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: afterReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r).toEqual({ ok: true, text: "REVISIONS_COMPLETE", toolCalls: 0 });
    expect(s.slept).toEqual([]);
    expect(f.calls).toHaveLength(2);
    const waiting = rec.events.filter((e) => e.kind === "step_waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.payload["reason"]).toBe("the usage limit's reset at 7:50pm America/New_York had already passed; resuming at once (weekly quota 41%)");
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", resetsAt: RESET_ISO, weeklyUtilization: 41, weeklySource: "usage", waited: false });
  });

  it("a reset one second past still takes the minute of grace, so clock skew cannot spend the retry", async () => {
    // The guard is on the **wake** instant — the reset plus WAIT_GRACE_MS — and not on the reset
    // itself, because ruling I-03 exists for exactly this second: the window's clock and this
    // machine's are not the same clock, and a query resumed the moment the window turns over is
    // rejected again. A reset that passed a second ago is the case the grace was bought for.
    const f = fake([limitedStream("five_hour", weeklyAt(41)), [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })]]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: () => new Date(Date.parse(RESET_ISO) + 1_000), sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok).toBe(true);
    expect(s.slept).toEqual([RESET_PLUS_A_MINUTE]);
    expect(rec.events.find((e) => e.kind === "step_waiting")!.payload["reason"]).toBe("waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)");
    expect(rec.events.at(-1)!.payload["limit"]).toMatchObject({ waited: true });
  });

  it("a limit that trips again on a retry that spent no wait does not claim one", async () => {
    // The sentence is the whole point of the ruling: "again after waiting once" would be a claim
    // about hours nobody spent, so the no-wait arm reads "again on the retry" instead.
    const f = fake([limitedStream("five_hour", weeklyAt(41)), limitedStream("five_hour", weeklyAt(41))]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: afterReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok ? "" : r.error).toBe("Manual resume needed: the writer's session hit its 5-hour limit again on the retry (resets 7:50pm America/New_York); press Resume after the reset.");
    expect(s.slept).toEqual([]);
    expect(f.calls).toHaveLength(2);
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", resetsAt: RESET_ISO, weeklyUtilization: 41, weeklySource: "usage", waited: false });
  });

  it("a reset time forty years ahead is refused as not credible, and the retry runs at once", async () => {
    // The bound, ruled 2026-10-15: a five-hour window cannot reset later than five hours after it
    // was hit, so a wake instant past MAX_WAIT_MS is not a reset time — most plausibly an SDK that
    // started sending milliseconds where it sent epoch seconds, which maps to the year 58,000.
    // Sleeping on it would hold the step and the run's lock for as long as the number said while
    // `setTimeout`'s 24.8-day ceiling fired at once, so the step would log `waited: true` for a
    // sleep that took no time. The reason names the raw value and how far ahead it was, because
    // the SDK's prose time ("7:50pm America/New_York") is the part that looks credible.
    const FORTY_YEARS_ON = "2066-10-14T23:00:00.000Z";
    const f = fake([limitedStream("five_hour", weeklyAt(41), SDK_FIVE_HOUR_TEXT, FORTY_YEARS_ON), [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })]]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r).toEqual({ ok: true, text: "REVISIONS_COMPLETE", toolCalls: 0 });
    expect(s.slept).toEqual([]);
    expect(f.calls).toHaveLength(2);
    expect(rec.events.find((e) => e.kind === "step_waiting")!.payload["reason"]).toBe("the usage limit's reset time 2066-10-14T23:00:00.000Z is 350640 hours ahead, further than a 5-hour window can reset; resuming at once (weekly quota 41%)");
    expect(rec.events.at(-1)!.payload["limit"]).toEqual({ kind: "rate_limit", window: "five_hour", resetsAt: FORTY_YEARS_ON, weeklyUtilization: 41, weeklySource: "usage", waited: false });
  });

  it("a wait of exactly six hours is still taken: the ceiling is the limit of belief, not of patience", async () => {
    // MAX_WAIT_MS is six hours — five for the window and one for the skew the grace exists for —
    // and the boundary is inclusive, so the longest credible reset is still slept out rather than
    // refused. A five-hour window hit just before its reset is the case that needs this.
    const SIX_HOURS_ON = new Date(BEFORE_RESET.getTime() + 6 * 60 * 60 * 1000 - 60_000).toISOString();
    const f = fake([limitedStream("five_hour", weeklyAt(41), "You've hit your session limit.", SIX_HOURS_ON), [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })]]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r.ok).toBe(true);
    expect(s.slept).toEqual([new Date(BEFORE_RESET.getTime() + 6 * 60 * 60 * 1000).toISOString()]);
    expect(rec.events.at(-1)!.payload["limit"]).toMatchObject({ waited: true });
  });

  it("a reset time that will not parse is retried at once rather than thrown out of the executor", async () => {
    // Reachable from a hand-built message today, and from any future mapper change — an SDK that
    // switched `resetsAt` to milliseconds, say. The arithmetic that builds the wake instant throws
    // a RangeError on an unparseable reset, and `Executors` (`engine/src/steps.ts`) says an
    // executor may throw only when the event log is unwritable: one reader checks, at the call
    // site, and the step comes back as an outcome. The reason names the raw value, so the log says
    // what arrived rather than hiding it.
    const f = fake([limitedStream("five_hour", weeklyAt(41), SDK_FIVE_HOUR_TEXT, "not a date"), [init, text("REVISIONS_COMPLETE"), success({ result: "REVISIONS_COMPLETE" })]]);
    const s = sleeper();
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir, now: beforeReset, sleepUntil: s.sleepUntil })(step(), ctx(), rec.emit);
    expect(r).toEqual({ ok: true, text: "REVISIONS_COMPLETE", toolCalls: 0 });
    expect(s.slept).toEqual([]);
    expect(rec.events.find((e) => e.kind === "step_waiting")!.payload["reason"]).toBe("the usage limit's reset time not a date could not be read as an instant; resuming at once (weekly quota 41%)");
    expect(rec.events.at(-1)!.payload["limit"]).toMatchObject({ resetsAt: "not a date", waited: false });
  });
});

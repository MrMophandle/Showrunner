# Agent Runner Implementation Plan (Plan B of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the engine's agent executor on the Claude Agent SDK, so that an `AgentStep` — a prompt file, a model, a tool allowlist, a context policy, and an optional JSON schema — runs as one SDK query per step, emits `agent_query`, `agent_tool_call`, and `agent_result` events, returns a schema-validated verdict when the step has a schema, and is bounded by the step's timeouts.

**Architecture:** Three new source files. `prompt-template.ts` loads a prompt file from the show's prompts directory, hashes it, and renders `{{...}}` variables from the run context. `agent-step.ts` builds the executor: it maps an `AgentStep` onto SDK query options, drives the message stream, emits the three agent event kinds, enforces the total and idle timeouts through an `AbortController`, resumes the SDK session for `context: "shared"`, and turns the result message into an `AgentOutcome`. `sdk-query.ts` is the only file that imports the SDK; it adapts the SDK's `query()` to the executor's `QueryFn` seam. Tests inject a fake `QueryFn` and never touch the network; one live test is gated behind an environment variable.

**Tech Stack:** Node ≥ 22 (Node 24.13 on the machine), TypeScript 5 (strict, ESM, `NodeNext`), vitest 2. One runtime dependency is added to `engine/`: `@anthropic-ai/claude-agent-sdk` pinned to `0.3.283` (npm `latest` on 2026-09-25; it bundles the Claude Code binary as a platform optional dependency, so no separate `claude` install is needed).

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` in this repository — §4.5 (agent steps run on the Agent SDK), §4.7 (the two things to verify before implementation), §6.1 (what an agent step is), §6.5 (the three agent event kinds), §6.7 (a loop's tool-call count per iteration), §6.8 (prompt files recorded by content hash), §7.1 (the review panel's JSON shape). Plan A's deferred items for this plan are in `docs/plans/2026-09-26-engine-core-deferred.md`, section "Plan B".

**This is plan B of six.** A (engine core) is merged to `main` at `c0251e0`. C (show config and prompt extraction), D (the Dead Light pipeline), E (console), and F (cutover) follow.

## Verification against the Agent SDK documentation (spec §4.7, done 2026-09-27)

Read from `code.claude.com/docs/en/agent-sdk/*` on 2026-09-27 against SDK `0.3.283`. The plan's code is written to these facts; an implementer who finds the installed SDK disagrees with one of them stops and reports it rather than guessing.

| Question | Answer |
|---|---|
| Can a query return a JSON verdict validated against a schema? | **Yes, first-class.** Option `outputFormat: { type: "json_schema", schema }`; the SDK validates against **JSON Schema draft-07** and rejects newer drafts; the object arrives as `structured_output` on the result message; the SDK re-prompts on mismatch and, when the retries run out, ends with `subtype: "error_max_structured_output_retries"`. A run can end `subtype: "success"` with no `structured_output`, and the docs say to treat that as a failure. |
| Per-query tool allowlist? | Two layers. `tools: string[]` controls which built-ins are in context; `allowedTools: string[]` auto-approves calls; `permissionMode: "dontAsk"` denies anything not pre-approved. `allowedTools` does **not** restrict under `bypassPermissions`, so this plan never uses `bypassPermissions`. |
| Model selection? | `model: string`, alias or full id. |
| Working directory? | `cwd: string`; file tools are scoped to it by default. |
| Observing tool calls? | `SDKAssistantMessage` content blocks with `type: "tool_use"` carry `name`, `input`, `id`. |
| Abort and timeout? | `abortController` option; **a session never times out on its own**, so the orchestrator imposes wall-clock bounds itself. Whether abort yields a result message or throws `AbortError` is docs-silent; the executor is written for both. |
| Result fields? | `subtype` ∈ `success`, `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`; `result` (final text), `structured_output?`, `errors?: string[]`, `session_id`, `num_turns`, `duration_ms`, `total_cost_usd` (client-side estimate), `permission_denials`. A single-shot `query()` **throws after yielding an error result**, so the loop is wrapped in `try`. |
| Resume? | `resume: <session_id>`; the id is on the init system message and on every result message. |
| System prompt? | Omitting `systemPrompt` gives a minimal prompt, not Claude Code's; `{ type: "preset", preset: "claude_code" }` restores it. |
| Settings? | `settingSources` defaults to loading user, project, and local settings; `[]` isolates the query from the host. |
| Entry point? | `import { query } from "@anthropic-ai/claude-agent-sdk"`; returns an async iterable of messages. |
| Auth? | `ANTHROPIC_API_KEY` in the process environment, or the machine's Claude Code login. |

## Global Constraints

- **The engine repository is `Showrunner`, at `~/GitHub/Showrunner`** (remote `MrMophandle/Showrunner`, branch `main`). This plan is executed on branch `agent-runner` in that checkout. Every path in this plan is relative to the repository root.
- **"A script in the engine repository may not contain the name of a show."** (spec §7.4) Nothing in `engine/` mentions Dead Light, its characters, or its files. Test fixture prompts use invented names.
- **"argv arrays, never shell strings; ids validated before they reach a process"** (spec §4.4). No `exec`, no `shell: true`. A prompt file path is resolved inside the prompts directory and refused if it escapes it.
- **The SDK is imported in exactly one file, `engine/src/sdk-query.ts`.** Every other file talks to it through the `QueryFn` seam. Tests never import `sdk-query.ts` except the env-gated live test, and then only through a dynamic import inside the test body.
- **`permissionMode` is always `"dontAsk"`, `settingSources` is always `[]`, `systemPrompt` is always the `claude_code` preset.** `bypassPermissions` appears nowhere in `engine/`.
- **Event kinds, exactly** (unchanged from Plan A): `run_started`, `run_finished`, `step_started`, `step_completed`, `step_failed`, `step_skipped`, `step_cached`, `step_progress`, `script_line`, `agent_query`, `agent_tool_call`, `agent_result`, `loop_iteration`, `gate_opened`, `gate_answered`, `input_changed`. This plan adds no kind.
- **The agent executor's obligations** (spec §6.5, documented on `Executors` in `engine/src/steps.ts`): one `agent_query` per query, carrying the prompt file, its content hash, the model, the allowlist, and the context policy; one `agent_tool_call` per tool invocation with its arguments; one `agent_result` when the step is done, carrying the verdict JSON if the step has a schema and the final text otherwise.
- **A loop's `toolCalls` per iteration comes from the executor's count of `tool_use` blocks** (spec §6.7 — an iteration with zero tool calls is the ep09/ep10 failure).
- **Every commit ends with these two trailer lines, in ONE final paragraph** (use `git commit -F -` with a heredoc; two `-m` flags split them and break attribution):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9`
- Tests run with `cd ~/GitHub/Showrunner/engine && npx vitest run` (one file: `npx vitest run test/<name>.test.ts`). Typecheck with `npm run typecheck` from `engine/` — it runs `tsc --noEmit` over `src/` AND `tsc -p tsconfig.test.json` over `src/`, `test/`, and `vitest.config.ts`. Both must be clean before every commit. The test timeout is 20 s (`vitest.config.ts`).
- Imports between engine source files use the `.js` extension (`NodeNext` resolution) even though the files are `.ts`. `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` are on: spread optional payload keys conditionally, never assign `undefined` to an optional property.
- The suite at the start of this plan is 92 tests across 12 files; every task's verification names the new total.

---

## File Structure

```
engine/
  package.json                 gains dependency "@anthropic-ai/claude-agent-sdk": "0.3.283"
  src/
    steps.ts                   MODIFY: JsonSchema, NestedAgentStep, AgentStep gains maxTurns/idleTimeoutMs/maxBudgetUsd
    prompt-template.ts         NEW: loadPrompt(promptsDir, promptFile) → { text, hash }; renderPrompt(template, ctx)
    agent-step.ts              NEW: QueryFn, AgentMessage, AgentQueryOptions, createAgentExecutor(opts)
    sdk-query.ts               NEW: sdkQuery — the one SDK import; adapts query() to QueryFn
    index.ts                   MODIFY: export the three new modules
  test/
    fixtures/prompts/
      hello.md                 a prompt with {{episodeId}} and {{results.setup}}
      verdict.md               a prompt asking for a JSON verdict
      plain.md                 a prompt with no variables
    steps-types.test.ts        NEW: type-level assertions (ts-expect-error) for NestedAgentStep
    prompt-template.test.ts    NEW
    agent-step.test.ts         NEW: the executor against a fake QueryFn
    agent-timeouts.test.ts     NEW: total and idle timeouts against a stalling fake
    agent-context.test.ts      NEW: shared vs fresh sessions, and the executor composed with run() and a loop
    agent-live.test.ts         NEW: env-gated (SHOWRUNNER_LIVE=1) real query
README.md                      MODIFY: the agent executor section
```

`agent-step.ts` composes `prompt-template.ts`; nothing else composes anything new. `runner.ts` is not modified.

---

### Task 1: Types and the dependency

**Files:**
- Modify: `engine/package.json`
- Modify: `engine/src/steps.ts`
- Test: `engine/test/steps-types.test.ts`

**Interfaces:**
- Consumes: `AgentStep`, `GateStep.onReject`, `LoopStep.body`, `StepBase.timeoutMs` from Plan A.
- Produces: `export type JsonSchema = Record<string, unknown>`; `export type NestedAgentStep = Omit<AgentStep, "when" | "dependsOn">`; `AgentStep.schema?: JsonSchema`, `AgentStep.maxTurns?: number`, `AgentStep.idleTimeoutMs?: number`, `AgentStep.maxBudgetUsd?: number`; `GateStep.onReject?: NestedAgentStep` (it stays optional: a gate without a fix agent is legal); `LoopStep.body: NestedAgentStep`.

- [ ] **Step 1: Add the dependency**

Run, from `engine/`:

```bash
npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.283
```

Expected: `engine/package.json` gains `"dependencies": { "@anthropic-ai/claude-agent-sdk": "0.3.283" }` and the root `package-lock.json` changes. Confirm the platform binary package installed: `ls node_modules/@anthropic-ai/ | grep claude-agent-sdk-darwin-arm64` (from the repository root, since npm workspaces hoist) prints the directory. If the install fails on the optional dependency, stop and report — do not work around it.

- [ ] **Step 2: Write the failing type test**

`engine/test/steps-types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { AgentStep, GateStep, LoopStep, NestedAgentStep, JsonSchema } from "../src/steps.js";

describe("agent step types", () => {
  it("a nested agent step cannot carry when or dependsOn", () => {
    const base: AgentStep = { kind: "agent", id: "fix", promptFile: "fix.md", model: "m", allowedTools: [], context: "fresh" };
    const nested: NestedAgentStep = base; // assignable: optional fields absent
    // @ts-expect-error — a nested step may not declare `when`
    const withWhen: NestedAgentStep = { ...base, when: () => true };
    // @ts-expect-error — a nested step may not declare `dependsOn`
    const withDeps: NestedAgentStep = { ...base, dependsOn: ["x"] };
    const gate: GateStep = { kind: "gate", id: "g", message: () => "?", onReject: nested };
    const loop: LoopStep = { kind: "loop", id: "l", body: nested, until: "DONE", maxIterations: 1 };
    expect(gate.onReject?.id).toBe("fix");
    expect(loop.body.id).toBe("fix");
    void withWhen; void withDeps;
  });

  it("an agent step carries its own bounds and a draft-07 schema", () => {
    const schema: JsonSchema = { type: "object", properties: { pass: { type: "boolean" } }, required: ["pass"] };
    const step: AgentStep = {
      kind: "agent", id: "a", promptFile: "a.md", model: "medium", allowedTools: ["Read"], context: "fresh",
      schema, maxTurns: 40, idleTimeoutMs: 900_000, maxBudgetUsd: 2, timeoutMs: 3_600_000,
    };
    expect(step.maxTurns).toBe(40);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/GitHub/Showrunner/engine && npm run typecheck`
Expected: errors — `NestedAgentStep` and `JsonSchema` are not exported; the two `@ts-expect-error` directives are "unused" because the assignments currently compile; `maxTurns` does not exist on `AgentStep`.

- [ ] **Step 4: Change the types**

In `engine/src/steps.ts`, replace the `AgentStep` interface with:

```ts
/** A JSON Schema, draft-07. The Agent SDK validates verdicts against draft-07 and rejects a schema
 *  that declares a newer draft, so a `$schema` key, if present, must name draft-07. */
export type JsonSchema = Record<string, unknown>;

export interface AgentStep extends StepBase {
  kind: "agent";
  /** Path of the prompt file, relative to the show's prompts directory. */
  promptFile: string;
  /** A model alias or id. The executor resolves aliases through its `models` map and passes
   *  anything else to the SDK unchanged. */
  model: string;
  /** Built-in tools the agent may use, e.g. ["Read", "Glob", "Grep"]. Nothing else is in context
   *  and nothing else is approved: the executor runs with permissionMode "dontAsk". */
  allowedTools: string[];
  /** "fresh": every query starts a new session. "shared": within one run, later queries of this
   *  step resume the session its first query opened (a loop body keeps its conversation across
   *  iterations). After a restart the session is not recovered: the next query is fresh, and the
   *  log shows it. */
  context: "fresh" | "shared";
  /** JSON schema the agent's verdict must satisfy, when the step produces one. With a schema the
   *  outcome carries `verdict`; a success with no verdict is a failure. */
  schema?: JsonSchema;
  /** Maximum agentic turns (tool-use round trips) before the SDK stops the query. */
  maxTurns?: number;
  /** Fail the step when no message arrives from the SDK for this long. `timeoutMs` on StepBase
   *  bounds the whole query; this bounds the silence between messages. */
  idleTimeoutMs?: number;
  /** Stop the query when the SDK's client-side cost estimate reaches this many US dollars. */
  maxBudgetUsd?: number;
}

/** An agent step nested inside a gate (`onReject`) or a loop (`body`). It has no `when` and no
 *  `dependsOn`: it runs because its parent decided so. */
export type NestedAgentStep = Omit<AgentStep, "when" | "dependsOn">;
```

Then change the two nested fields, keeping their existing doc comments verbatim:

- in `GateStep`: `onReject?: AgentStep;` → `onReject?: NestedAgentStep;` (still optional — `pipeline.ts` and `runner.ts` are written for an absent fix agent)
- in `LoopStep`: `body: AgentStep;` → `body: NestedAgentStep;`

`runner.ts` passes `step.onReject` and `step.body` to `executors.agent`, whose parameter is `AgentStep`. A `NestedAgentStep` is assignable to `AgentStep` because the omitted fields are optional on `AgentStep`; no runner change is needed. If `tsc` disagrees, stop and report rather than widening the executor's parameter.

- [ ] **Step 5: Run the typecheck and the suite**

Run: `cd ~/GitHub/Showrunner/engine && npm run typecheck && npx vitest run`
Expected: typecheck prints nothing; `Tests  94 passed (94)` across 13 files.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/package.json package-lock.json engine/src/steps.ts engine/test/steps-types.test.ts && git commit -F - <<'MSG'
steps: nested agent steps, draft-07 schemas, and per-step agent bounds; add the Agent SDK

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
MSG
```

---

### Task 2: Prompt files and templates

**Files:**
- Create: `engine/src/prompt-template.ts`
- Create: `engine/test/fixtures/prompts/hello.md`, `engine/test/fixtures/prompts/plain.md`
- Test: `engine/test/prompt-template.test.ts`

**Interfaces:**
- Consumes: `RunContext` from `steps.ts`.
- Produces:
  - `export class TemplateError extends Error`
  - `export async function loadPrompt(promptsDir: string, promptFile: string): Promise<{ text: string; hash: string; path: string }>` — resolves `promptFile` inside `promptsDir`, refuses escapes, reads it, returns the text and its sha256 hex.
  - `export function renderPrompt(template: string, ctx: Pick<RunContext, "episodeId" | "runId" | "showRoot" | "results">): string` — substitutes `{{...}}` variables; throws `TemplateError` on any unknown or missing variable.

**Template syntax (the engine's, which Plan C rewrites the extracted prompts into):**

| Variable | Value |
|---|---|
| `{{episodeId}}` | `ctx.episodeId` |
| `{{runId}}` | `ctx.runId` |
| `{{showRoot}}` | `ctx.showRoot` |
| `{{results.<key>}}` | `ctx.results[key]`; a string as-is, a number or boolean via `String()`, an object or array as `JSON.stringify(value, null, 2)`. `<key>` runs to the next `.` or the closing braces and may contain `-` and `:` (so `{{results.outline-gate:rejection}}` and `{{results.draft:iteration}}` work). |
| `{{results.<key>.<a>.<b>}}` | the dotted path into an object result, each segment an object key |

Whitespace inside the braces is ignored. Anything else inside `{{ }}` — an unknown top-level name, a results key that is absent, a path through a non-object, a value that is `null` or `undefined` — throws `TemplateError` naming the variable exactly as written. A prompt with a hole is a prompt that lies to the model, so every hole is loud.

- [ ] **Step 1: Write the fixtures**

`engine/test/fixtures/prompts/hello.md`:

```
You are reviewing episode {{episodeId}} in run {{ runId }}.
Setup said: {{results.setup}}
Verdict was: {{results.review.verdict}} with {{results.review.issues}}
Rejection: {{results.gate:rejection}}
```

`engine/test/fixtures/prompts/plain.md`:

```
No variables here. Braces like { this } and {single} are left alone.
```

- [ ] **Step 2: Write the failing tests**

`engine/test/prompt-template.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadPrompt, renderPrompt, TemplateError } from "../src/prompt-template.js";

const promptsDir = path.resolve(import.meta.dirname, "fixtures/prompts");
const ctx = {
  episodeId: "s02e01", runId: "r1", showRoot: "/show",
  results: { setup: "ready", review: { verdict: "DRAFT PASSED", issues: ["a", "b"] }, "gate:rejection": "too long", n: 3 },
};

describe("loadPrompt", () => {
  it("reads a prompt inside the prompts directory and hashes it", async () => {
    const p = await loadPrompt(promptsDir, "plain.md");
    const raw = await readFile(path.join(promptsDir, "plain.md"));
    expect(p.text).toBe(raw.toString("utf8"));
    expect(p.hash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(p.path).toBe(path.join(promptsDir, "plain.md"));
  });
  it("refuses a path that escapes the prompts directory", async () => {
    await expect(loadPrompt(promptsDir, "../fail.py")).rejects.toThrow(/escapes/);
    await expect(loadPrompt(promptsDir, "/etc/passwd")).rejects.toThrow(/escapes/);
  });
  it("names a missing prompt file", async () => {
    await expect(loadPrompt(promptsDir, "nope.md")).rejects.toThrow(/nope\.md/);
  });
});

describe("renderPrompt", () => {
  it("substitutes context fields, results, dotted paths, and colon keys", async () => {
    const { text } = await loadPrompt(promptsDir, "hello.md");
    const out = renderPrompt(text, ctx);
    expect(out).toContain("episode s02e01 in run r1.");
    expect(out).toContain("Setup said: ready");
    expect(out).toContain("Verdict was: DRAFT PASSED with [\n  \"a\",\n  \"b\"\n]");
    expect(out).toContain("Rejection: too long");
  });
  it("stringifies numbers and objects", () => {
    expect(renderPrompt("{{results.n}}", ctx)).toBe("3");
    expect(renderPrompt("{{results.review}}", ctx)).toBe(JSON.stringify(ctx.results.review, null, 2));
  });
  it("leaves text without variables untouched, including single braces", async () => {
    const { text } = await loadPrompt(promptsDir, "plain.md");
    expect(renderPrompt(text, ctx)).toBe(text);
  });
  it("throws TemplateError naming the variable for every kind of hole", () => {
    expect(() => renderPrompt("{{nope}}", ctx)).toThrow(TemplateError);
    expect(() => renderPrompt("{{nope}}", ctx)).toThrow(/\{\{nope\}\}/);
    expect(() => renderPrompt("{{results.missing}}", ctx)).toThrow(/\{\{results\.missing\}\}/);
    expect(() => renderPrompt("{{results.setup.deeper}}", ctx)).toThrow(/\{\{results\.setup\.deeper\}\}/);
    expect(() => renderPrompt("{{results.review.absent}}", ctx)).toThrow(/absent/);
    expect(() => renderPrompt("{{results}}", ctx)).toThrow(TemplateError);
    expect(() => renderPrompt("{{}}", ctx)).toThrow(TemplateError);
    expect(() => renderPrompt("{{results.nul}}", { ...ctx, results: { nul: null } })).toThrow(/nul/);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/prompt-template.test.ts`
Expected: FAIL — cannot resolve `../src/prompt-template.js`.

- [ ] **Step 4: Write the module**

`engine/src/prompt-template.ts`:

```ts
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RunContext } from "./steps.js";

export class TemplateError extends Error {}

/** Resolves `promptFile` inside `promptsDir`, refusing any path that escapes it, and returns the
 *  file's text with its sha256 — the hash is what agent_query records so "the prompt as it was"
 *  can be answered later (spec §6.8). */
export async function loadPrompt(promptsDir: string, promptFile: string): Promise<{ text: string; hash: string; path: string }> {
  const root = path.resolve(promptsDir);
  const abs = path.resolve(root, promptFile);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`prompt file ${JSON.stringify(promptFile)} escapes the prompts directory ${root}`);
  }
  let raw: Buffer;
  try {
    raw = await readFile(abs);
  } catch (err) {
    throw new Error(`prompt file ${JSON.stringify(promptFile)} could not be read at ${abs}: ${(err as Error).message}`, { cause: err });
  }
  return { text: raw.toString("utf8"), hash: createHash("sha256").update(raw).digest("hex"), path: abs };
}

type TemplateContext = Pick<RunContext, "episodeId" | "runId" | "showRoot" | "results">;

const VARIABLE = /\{\{([^{}]*)\}\}/g;

/** Substitutes every `{{...}}` in `template`. Every hole is an error: an unknown name, a missing
 *  result, a path through a non-object, or a null value throws TemplateError naming the variable
 *  as written, because a prompt with a hole in it lies to the model quietly. */
export function renderPrompt(template: string, ctx: TemplateContext): string {
  return template.replace(VARIABLE, (whole, inner: string) => {
    const expr = inner.trim();
    const fail = (why: string): never => { throw new TemplateError(`${whole}: ${why}`); };
    if (expr === "") return fail("empty variable");
    if (expr === "episodeId") return ctx.episodeId;
    if (expr === "runId") return ctx.runId;
    if (expr === "showRoot") return ctx.showRoot;
    if (expr === "results" || !expr.startsWith("results.")) return fail("unknown variable");
    const rest = expr.slice("results.".length);
    const dot = rest.indexOf(".");
    const key = dot === -1 ? rest : rest.slice(0, dot);
    const segments = dot === -1 ? [] : rest.slice(dot + 1).split(".");
    if (key === "" || segments.some((s) => s === "")) return fail("malformed path");
    if (!Object.prototype.hasOwnProperty.call(ctx.results, key)) return fail(`no result for step ${JSON.stringify(key)}`);
    let value: unknown = ctx.results[key];
    for (const seg of segments) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${JSON.stringify(seg)} is not a key of a non-object`);
      if (!Object.prototype.hasOwnProperty.call(value, seg)) return fail(`no key ${JSON.stringify(seg)}`);
      value = (value as Record<string, unknown>)[seg];
    }
    if (value === null || value === undefined) return fail("value is null");
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value, null, 2);
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/prompt-template.test.ts && npm run typecheck`
Expected: PASS, 7 tests; typecheck prints nothing.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/prompt-template.ts engine/test/prompt-template.test.ts engine/test/fixtures/prompts && git commit -F - <<'MSG'
prompt-template: load a prompt inside the prompts directory, hash it, render {{variables}} loudly

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
MSG
```

---

### Task 3: The executor — options, events, outcomes

**Files:**
- Create: `engine/src/agent-step.ts`
- Create: `engine/test/fixtures/prompts/verdict.md`
- Test: `engine/test/agent-step.test.ts`

**Interfaces:**
- Consumes: `loadPrompt`, `renderPrompt` from Task 2; `AgentStep`, `RunContext`, `Emit`, `AgentOutcome`, `Executors`, `JsonSchema` from `steps.ts`.
- Produces (all exported from `agent-step.ts`):

```ts
/** The subset of the SDK's message stream the executor reads. The adapter in sdk-query.ts maps
 *  the SDK's own types onto this shape; tests build these by hand. */
export interface AgentMessage {
  type: string;                       // "system" | "assistant" | "user" | "result" | others
  subtype?: string;                   // system: "init"; result: "success" | "error_*"
  session_id?: string;
  message?: { content: AgentContentBlock[] };   // assistant messages
  result?: string;                    // result/success: the final text
  structured_output?: unknown;        // result/success with outputFormat
  errors?: string[];                  // result/error_*
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  permission_denials?: Array<{ tool_name?: string }>;
}
export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string };

/** Exactly the SDK options the executor sets; field names match the SDK's Options so the adapter
 *  is a spread. */
export interface AgentQueryOptions {
  cwd: string;
  model: string;
  tools: string[];
  allowedTools: string[];
  permissionMode: "dontAsk";
  settingSources: [];
  systemPrompt: { type: "preset"; preset: "claude_code" };
  abortController: AbortController;
  outputFormat?: { type: "json_schema"; schema: JsonSchema };
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
}
export type QueryFn = (args: { prompt: string; options: AgentQueryOptions }) => AsyncIterable<AgentMessage>;

export interface AgentExecutorOptions {
  /** The query seam. Production passes `sdkQuery` from ./sdk-query.js; tests pass a fake. Required,
   *  so that importing this module never loads the SDK. */
  query: QueryFn;
  /** Absolute path of the show's prompts directory. Default: `<showRoot>/prompts`, per call. */
  promptsDir?: string;
  /** Model alias → model id (e.g. { medium: "claude-sonnet-5" }). A model not in the map is passed
   *  to the SDK unchanged. */
  models?: Record<string, string>;
}
export function createAgentExecutor(opts: AgentExecutorOptions): Executors["agent"];
```

**Behaviour of one executor call, in order:**

1. Resolve `promptsDir` (option, else `path.join(ctx.showRoot, "prompts")`); `loadPrompt`; `renderPrompt` with `ctx`. A load or template error returns `{ ok: false, error: <message> }` after emitting nothing — the step fails before any query is made.
2. If `step.schema` has a `$schema` key naming a draft other than draft-07 (the string contains `2019-09` or `2020-12`), return `{ ok: false, error: "schema must be JSON Schema draft-07, got <value>" }`.
3. Build `AgentQueryOptions`: `cwd: ctx.showRoot`; `model: opts.models?.[step.model] ?? step.model`; `tools: step.allowedTools.filter(t => !t.startsWith("mcp__"))`; `allowedTools: step.allowedTools`; `permissionMode: "dontAsk"`; `settingSources: []`; `systemPrompt: { type: "preset", preset: "claude_code" }`; a fresh `AbortController`; `outputFormat` only when `step.schema` is set; `maxTurns` and `maxBudgetUsd` only when set on the step; `resume` only when Task 5's session map has one (this task: never).
4. Emit `agent_query` with `{ promptFile, promptHash, promptPath, model: <resolved>, modelAlias: step.model, allowedTools, context: step.context, schema: Boolean(step.schema), resumed: Boolean(resume) }`.
5. Iterate the messages. For each `assistant` message, for each `tool_use` block: increment `toolCalls` and emit `agent_tool_call` with `{ tool: block.name, input: block.input, toolUseId: block.id, index: toolCalls }`. Remember the first `session_id` seen (system init or result). Remember the `result` message.
6. If the iteration throws: if a result message was already seen, ignore the throw (the SDK throws after yielding an error result); otherwise the outcome is `{ ok: false, error: "query failed: <message>" }` and `agent_result` is emitted with `{ ok: false, error, toolCalls, sessionId? }`.
7. If the iteration ends with no result message: `{ ok: false, error: "query ended without a result message" }`, `agent_result` as above.
8. From the result message: if `subtype === "success"`: with a schema, `structured_output` must be present, else `{ ok: false, error: "success without structured output" }`; the outcome is `{ ok: true, text: result ?? "", verdict?: structured_output, toolCalls }`. Otherwise `{ ok: false, error: "<subtype>: <errors joined with '; '>" }` (or the bare subtype when `errors` is empty).
9. Emit `agent_result` with `{ ok, subtype, toolCalls, numTurns, durationMs, costUsd, sessionId, permissionDenials: <count>, deniedTools: <unique tool_name list> }` plus `verdict` when the step has a schema and the run succeeded, `text` when it has no schema and the run succeeded, and `error` when it failed. Return the outcome.

- [ ] **Step 1: Write the verdict fixture**

`engine/test/fixtures/prompts/verdict.md`:

```
Read {{showRoot}}/notes.md and decide whether it passes. Answer with the JSON verdict.
```

- [ ] **Step 2: Write the failing tests**

`engine/test/agent-step.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createAgentExecutor, type AgentMessage, type AgentQueryOptions, type QueryFn } from "../src/agent-step.js";
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
    expect(r).toEqual({ ok: false, error: "success without structured output" });
    expect(rec.events.at(-1)!.payload).toMatchObject({ ok: false, error: "success without structured output", subtype: "success" });
  });
  it("an error subtype fails with the subtype and the errors", async () => {
    const f = fake([init, { type: "result", subtype: "error_max_turns", errors: ["hit 7 turns", "stopped"], session_id: "sess-1", num_turns: 7, duration_ms: 5, total_cost_usd: 0.1 }]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "error_max_turns: hit 7 turns; stopped" });
  });
  it("an error subtype with no errors fails with the bare subtype", async () => {
    const f = fake([init, { type: "result", subtype: "error_during_execution", session_id: "s", num_turns: 0, duration_ms: 1, total_cost_usd: 0 }]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "error_during_execution" });
  });
  it("a throw after an error result is ignored in favour of the result", async () => {
    const f = fake([init, { type: "result", subtype: "error_max_budget_usd", errors: ["budget"], session_id: "s", num_turns: 2, duration_ms: 1, total_cost_usd: 1.5 }], { throwAfter: true });
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "error_max_budget_usd: budget" });
  });
  it("a throw with no result fails with the message and still emits agent_result", async () => {
    const f = fake([], { throwBefore: new Error("Native CLI binary for darwin-arm64 not found") });
    const rec = recorder();
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), rec.emit);
    expect(r).toEqual({ ok: false, error: "query failed: Native CLI binary for darwin-arm64 not found" });
    expect(rec.events.map((e) => e.kind)).toEqual(["agent_query", "agent_result"]);
    expect(rec.events[1]!.payload).toMatchObject({ ok: false, toolCalls: 0 });
  });
  it("a stream that ends without a result fails", async () => {
    const f = fake([init, text("hi")]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step(), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "query ended without a result message" });
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
  it("a schema declaring a newer draft fails before any query", async () => {
    const f = fake([init, success()]);
    const r = await createAgentExecutor({ query: f.query, promptsDir })(step({ schema: { ...schema, $schema: "https://json-schema.org/draft/2020-12/schema" } }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "schema must be JSON Schema draft-07, got https://json-schema.org/draft/2020-12/schema" });
    expect(f.calls.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/agent-step.test.ts`
Expected: FAIL — cannot resolve `../src/agent-step.js`.

- [ ] **Step 4: Write the module**

`engine/src/agent-step.ts`:

```ts
import path from "node:path";
import type { AgentOutcome, AgentStep, Emit, Executors, JsonSchema, RunContext } from "./steps.js";
import { loadPrompt, renderPrompt } from "./prompt-template.js";

export type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string };

/** The subset of the SDK's message stream the executor reads. sdk-query.ts maps the SDK's own
 *  types onto this shape; tests build these by hand. */
export interface AgentMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content: AgentContentBlock[] };
  result?: string;
  structured_output?: unknown;
  errors?: string[];
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  permission_denials?: Array<{ tool_name?: string }>;
}

/** Exactly the SDK options the executor sets. Field names match the SDK's Options so the adapter
 *  is a spread. permissionMode is dontAsk and settingSources is empty by construction: nothing
 *  outside the allowlist is approved, and nothing on the host machine leaks into a step. */
export interface AgentQueryOptions {
  cwd: string;
  model: string;
  tools: string[];
  allowedTools: string[];
  permissionMode: "dontAsk";
  settingSources: [];
  systemPrompt: { type: "preset"; preset: "claude_code" };
  abortController: AbortController;
  outputFormat?: { type: "json_schema"; schema: JsonSchema };
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
}

export type QueryFn = (args: { prompt: string; options: AgentQueryOptions }) => AsyncIterable<AgentMessage>;

export interface AgentExecutorOptions {
  /** The query seam. Production passes `sdkQuery` from ./sdk-query.js; tests pass a fake. It is
   *  required so that importing this module never loads the SDK. */
  query: QueryFn;
  /** Absolute path of the show's prompts directory. Default: `<showRoot>/prompts`, per call. */
  promptsDir?: string;
  /** Model alias → model id. A model not in the map is passed to the SDK unchanged. */
  models?: Record<string, string>;
}

const NEWER_DRAFTS = ["2019-09", "2020-12"];

export function createAgentExecutor(opts: AgentExecutorOptions): Executors["agent"] {
  return async (step: AgentStep, ctx: RunContext, emit: Emit): Promise<AgentOutcome> => {
    // 1–2: the prompt and the schema, checked before anything is logged or queried.
    const promptsDir = opts.promptsDir ?? path.join(ctx.showRoot, "prompts");
    let prompt: string;
    let promptHash: string;
    let promptPath: string;
    try {
      const loaded = await loadPrompt(promptsDir, step.promptFile);
      promptHash = loaded.hash;
      promptPath = loaded.path;
      prompt = renderPrompt(loaded.text, ctx);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const declared = step.schema?.["$schema"];
    if (typeof declared === "string" && NEWER_DRAFTS.some((d) => declared.includes(d))) {
      return { ok: false, error: `schema must be JSON Schema draft-07, got ${declared}` };
    }

    // 3: the options.
    const model = opts.models?.[step.model] ?? step.model;
    const abortController = new AbortController();
    const options: AgentQueryOptions = {
      cwd: ctx.showRoot,
      model,
      tools: step.allowedTools.filter((t) => !t.startsWith("mcp__")),
      allowedTools: [...step.allowedTools],
      permissionMode: "dontAsk",
      settingSources: [],
      systemPrompt: { type: "preset", preset: "claude_code" },
      abortController,
      ...(step.schema ? { outputFormat: { type: "json_schema" as const, schema: step.schema } } : {}),
      ...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
      ...(step.maxBudgetUsd !== undefined ? { maxBudgetUsd: step.maxBudgetUsd } : {}),
    };

    // 4: agent_query.
    await emit("agent_query", {
      promptFile: step.promptFile, promptHash, promptPath, model, modelAlias: step.model,
      allowedTools: step.allowedTools, context: step.context, schema: Boolean(step.schema), resumed: Boolean(options.resume),
    });

    // 5–7: drive the stream.
    let toolCalls = 0;
    let sessionId: string | undefined;
    let result: AgentMessage | undefined;
    let failure: string | undefined;
    try {
      for await (const m of opts.query({ prompt, options })) {
        if (m.session_id && !sessionId) sessionId = m.session_id;
        if (m.type === "assistant" && m.message) {
          for (const block of m.message.content) {
            if (block.type === "tool_use" && "name" in block) {
              toolCalls += 1;
              await emit("agent_tool_call", { tool: block.name, input: block.input, toolUseId: block.id, index: toolCalls });
            }
          }
        } else if (m.type === "result") {
          result = m;
        }
      }
    } catch (err) {
      if (!result) failure = `query failed: ${(err as Error).message}`;
    }
    if (!result && !failure) failure = "query ended without a result message";

    // 8: the outcome.
    let outcome: AgentOutcome;
    if (failure) {
      outcome = { ok: false, error: failure };
    } else if (result!.subtype === "success") {
      if (step.schema && result!.structured_output === undefined) {
        outcome = { ok: false, error: "success without structured output" };
      } else {
        outcome = {
          ok: true, text: result!.result ?? "", toolCalls,
          ...(step.schema ? { verdict: result!.structured_output } : {}),
        };
      }
    } else {
      const errors = result!.errors ?? [];
      outcome = { ok: false, error: errors.length ? `${result!.subtype}: ${errors.join("; ")}` : String(result!.subtype) };
    }

    // 9: agent_result.
    const denials = result?.permission_denials ?? [];
    const deniedTools = [...new Set(denials.map((d) => d.tool_name).filter((n): n is string => typeof n === "string"))];
    await emit("agent_result", {
      ok: outcome.ok, toolCalls,
      ...(result?.subtype !== undefined ? { subtype: result.subtype } : {}),
      ...(result?.num_turns !== undefined ? { numTurns: result.num_turns } : {}),
      ...(result?.duration_ms !== undefined ? { durationMs: result.duration_ms } : {}),
      ...(result?.total_cost_usd !== undefined ? { costUsd: result.total_cost_usd } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      permissionDenials: denials.length, deniedTools,
      ...(outcome.ok && step.schema ? { verdict: outcome.verdict } : {}),
      ...(outcome.ok && !step.schema ? { text: outcome.text } : {}),
      ...(!outcome.ok ? { error: outcome.error } : {}),
    });
    return outcome;
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/agent-step.test.ts && npm run typecheck`
Expected: PASS, 15 tests; typecheck prints nothing. If `tsc` objects to the non-null assertions on `result`, restructure with a local `const r = result` narrowed by the `failure` branch — do not add `any`.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/agent-step.ts engine/test/agent-step.test.ts engine/test/fixtures/prompts/verdict.md && git commit -F - <<'MSG'
agent-step: the executor — options onto the SDK seam, three agent events, verdicts and failures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
MSG
```

---

### Task 4: Timeouts and abort

**Files:**
- Modify: `engine/src/agent-step.ts`
- Test: `engine/test/agent-timeouts.test.ts`

**Interfaces:**
- Consumes: `StepBase.timeoutMs` (total), `AgentStep.idleTimeoutMs` (silence between messages), the `AbortController` already in the options.
- Produces: the executor aborts the controller and fails the step with `timed out after <ms> ms` or `idle for <ms> ms`, whether or not the iterator cooperates with the abort.

**Design.** The SDK docs say a session never times out on its own, and they are silent on whether `abortController.abort()` makes the iterator yield a result or throw. The executor therefore does not rely on the iterator at all: it races each `next()` against its own deadline promise, and when the deadline wins it aborts the controller, calls the iterator's `return()` without awaiting it, and returns the failure. A fake that never resolves `next()` is the test.

- [ ] **Step 1: Write the failing tests**

`engine/test/agent-timeouts.test.ts`:

```ts
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
    const r = await createAgentExecutor({ query, promptsDir })(step({ idleTimeoutMs: 100 }), ctx(), recorder().emit);
    expect(r).toEqual({ ok: false, error: "idle for 100 ms" });
    expect(controller!.signal.aborted).toBe(true);
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
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/agent-timeouts.test.ts`
Expected: the first, second and fourth tests hang until vitest's 20 s timeout and FAIL; the third passes.

- [ ] **Step 3: Replace the stream loop**

In `engine/src/agent-step.ts`, replace the `try { for await ... } catch` block of step 5–7 with a bounded pump. Add above `createAgentExecutor`:

```ts
class Deadline extends Error {}

/** Pumps `iterable` under two clocks — a total deadline and an idle deadline reset on every
 *  message — and hands each message to `onMessage`. When a clock fires it aborts `controller`,
 *  asks the iterator to return without waiting for it (the SDK's iterator may not honour the
 *  abort promptly, and a step must not hang on it), and throws Deadline with the reason. */
async function pump(
  iterable: AsyncIterable<AgentMessage>,
  controller: AbortController,
  bounds: { timeoutMs?: number; idleTimeoutMs?: number },
  onMessage: (m: AgentMessage) => Promise<void>,
): Promise<void> {
  const it = iterable[Symbol.asyncIterator]();
  let fire!: (reason: string) => void;
  const fired = new Promise<never>((_, reject) => { fire = (reason) => reject(new Deadline(reason)); });
  const total = bounds.timeoutMs !== undefined ? setTimeout(() => fire(`timed out after ${bounds.timeoutMs} ms`), bounds.timeoutMs) : undefined;
  let idle: NodeJS.Timeout | undefined;
  const armIdle = () => {
    if (bounds.idleTimeoutMs === undefined) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => fire(`idle for ${bounds.idleTimeoutMs} ms`), bounds.idleTimeoutMs);
  };
  fired.catch(() => {}); // the race below observes it; this silences an unhandled-rejection report when nothing is racing
  armIdle();
  try {
    while (true) {
      const next = await Promise.race([it.next(), fired]);
      if (next.done) return;
      armIdle();
      await onMessage(next.value);
    }
  } catch (err) {
    if (err instanceof Deadline) {
      controller.abort();
      void it.return?.().catch(() => {});
    }
    throw err;
  } finally {
    if (total) clearTimeout(total);
    if (idle) clearTimeout(idle);
  }
}
```

and change the body to:

```ts
    try {
      await pump(opts.query({ prompt, options }), abortController, { ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}), ...(step.idleTimeoutMs !== undefined ? { idleTimeoutMs: step.idleTimeoutMs } : {}) }, async (m) => {
        if (m.session_id && !sessionId) sessionId = m.session_id;
        if (m.type === "assistant" && m.message) {
          for (const block of m.message.content) {
            if (block.type === "tool_use" && "name" in block) {
              toolCalls += 1;
              await emit("agent_tool_call", { tool: block.name, input: block.input, toolUseId: block.id, index: toolCalls });
            }
          }
        } else if (m.type === "result") {
          result = m;
        }
      });
    } catch (err) {
      if (err instanceof Deadline) { failure = err.message; result = undefined; }
      else if (!result) failure = `query failed: ${(err as Error).message}`;
    }
```

A deadline discards any result that raced in late (`result = undefined`), so "the total timeout wins over a late result" holds by construction.

- [ ] **Step 4: Run the tests and the whole suite**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/agent-timeouts.test.ts && npx vitest run && npm run typecheck`
Expected: PASS, 4 tests; the suite is `120 passed` across 16 files (94 + 7 + 15 + 4); typecheck prints nothing.

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/agent-step.ts engine/test/agent-timeouts.test.ts && git commit -F - <<'MSG'
agent-step: total and idle deadlines that do not depend on the iterator honouring abort

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
MSG
```

---

### Task 5: Context policy, and the executor inside a run

**Files:**
- Modify: `engine/src/agent-step.ts`
- Test: `engine/test/agent-context.test.ts`

**Interfaces:**
- Consumes: `run`, `EventLog`, `LoopStep`, `GateStep`, `answerGate` from Plan A.
- Produces: for `context: "shared"`, the executor keeps a per-executor map `${runId}/${stepId}` → session id, filled from the first `session_id` seen and used as `options.resume` on the step's later queries in the same run; `agent_query.resumed` is `true` on those. For `context: "fresh"` nothing is stored or resumed. A different run id never resumes.

- [ ] **Step 1: Write the failing tests**

`engine/test/agent-context.test.ts`:

```ts
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
    await answerGate(log, "r1", "g", { decision: "rejected", notes: "too long", by: "test" });
    const second = await run({ pipeline, executors, log, ctx: ctx1 });
    expect(second.status).toBe("waiting");
    const events = await log.read();
    const q = events.find((e) => e.kind === "agent_query");
    expect(q?.stepId).toBe("fix");
    expect(f.calls[0]!.allowedTools).toEqual(["Edit"]);
    expect(events.some((e) => e.kind === "gate_opened" && e.payload["attempt"] === 2)).toBe(true);
  });
});
```

If the `answerGate` signature or the gate answer shape in Plan A differs from `{ decision, notes, by }`, read `engine/src/runner.ts` and use the real one; the test's intent is fixed, its call shape is not.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/agent-context.test.ts`
Expected: the first "shared" test FAILS (`resume` is never set); the fresh and different-run tests pass vacuously; the two run tests may pass or fail depending on the resume assertion — the shared-across-iterations assertion FAILS.

- [ ] **Step 3: Add the session map**

In `createAgentExecutor`, before the returned function:

```ts
  /** context: "shared" — session ids by `${runId}/${stepId}`, for this executor's lifetime. A
   *  restart makes a new executor, so a resumed run's shared step starts a fresh session; the
   *  agent_query it logs says resumed: false, which is the record of that. */
  const sessions = new Map<string, string>();
```

In the options build, add the resume key:

```ts
    const sessionKey = `${ctx.runId}/${step.id}`;
    const resume = step.context === "shared" ? sessions.get(sessionKey) : undefined;
    const options: AgentQueryOptions = {
      ...,
      ...(resume !== undefined ? { resume } : {}),
    };
```

and after the pump (whether it succeeded or not), when a session id was seen:

```ts
    if (step.context === "shared" && sessionId !== undefined) sessions.set(sessionKey, sessionId);
```

- [ ] **Step 4: Run the tests and the suite**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/agent-context.test.ts && npx vitest run && npm run typecheck`
Expected: PASS, 5 tests; the suite is `125 passed` across 17 files; typecheck prints nothing.

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src/agent-step.ts engine/test/agent-context.test.ts && git commit -F - <<'MSG'
agent-step: shared context resumes the step's session within a run; the executor proven inside a loop and a gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
MSG
```

---

### Task 6: The SDK adapter, the live test, exports, and the README

**Files:**
- Create: `engine/src/sdk-query.ts`
- Modify: `engine/src/index.ts`
- Modify: `README.md`
- Test: `engine/test/agent-live.test.ts`

**Interfaces:**
- Consumes: `query` and the message types from `@anthropic-ai/claude-agent-sdk`; `QueryFn`, `AgentMessage`, `AgentQueryOptions` from Task 3.
- Produces: `export const sdkQuery: QueryFn`; `index.ts` exports `prompt-template.js`, `agent-step.js`, `sdk-query.js`.

- [ ] **Step 1: Write the adapter**

`engine/src/sdk-query.ts`:

```ts
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentContentBlock, AgentMessage, AgentQueryOptions, QueryFn } from "./agent-step.js";

/** The one place the engine touches the Agent SDK. Everything the executor reads is copied onto
 *  AgentMessage field by field, so a change in the SDK's types shows up here as a compile error
 *  and nowhere else. */
export const sdkQuery: QueryFn = async function* ({ prompt, options }: { prompt: string; options: AgentQueryOptions }) {
  for await (const m of query({ prompt, options: { ...options } })) {
    yield toAgentMessage(m);
  }
};

function toAgentMessage(m: SDKMessage): AgentMessage {
  const out: AgentMessage = { type: m.type };
  if ("subtype" in m && typeof m.subtype === "string") out.subtype = m.subtype;
  if ("session_id" in m && typeof m.session_id === "string") out.session_id = m.session_id;
  if (m.type === "assistant") {
    out.message = { content: (m.message.content as Array<Record<string, unknown>>).map(toBlock) };
  }
  if (m.type === "result") {
    if (typeof m.num_turns === "number") out.num_turns = m.num_turns;
    if (typeof m.duration_ms === "number") out.duration_ms = m.duration_ms;
    if (typeof m.total_cost_usd === "number") out.total_cost_usd = m.total_cost_usd;
    if (Array.isArray(m.permission_denials)) out.permission_denials = m.permission_denials.map((d) => ({ tool_name: d.tool_name }));
    if (m.subtype === "success") {
      out.result = m.result;
      if (m.structured_output !== undefined) out.structured_output = m.structured_output;
    } else if ("errors" in m && Array.isArray(m.errors)) {
      out.errors = m.errors;
    }
  }
  return out;
}

function toBlock(b: Record<string, unknown>): AgentContentBlock {
  if (b["type"] === "text" && typeof b["text"] === "string") return { type: "text", text: b["text"] };
  if (b["type"] === "tool_use" && typeof b["name"] === "string" && typeof b["id"] === "string") return { type: "tool_use", id: b["id"], name: b["name"], input: b["input"] };
  return { type: String(b["type"]) };
}
```

The implementer types this against the installed SDK's `SDKMessage`, `SDKAssistantMessage`, and `SDKResultMessage`. Where a field named here is not on the SDK's type (the docs were read on 2026-09-27 against 0.3.283 and can drift), narrow with an `in` check as the code above does for `errors`; never cast to `any`, and never invent a field. If `options: { ...options }` is rejected because one of `AgentQueryOptions`'s field types does not match the SDK's `Options`, adjust the adapter's spread with an explicit mapping and report which field differed — the executor's `AgentQueryOptions` is not changed.

- [ ] **Step 2: Typecheck the adapter**

Run: `cd ~/GitHub/Showrunner/engine && npm run typecheck`
Expected: prints nothing. This is the step that verifies the plan's reading of the SDK against the installed package; a mismatch here is a finding, not something to paper over.

- [ ] **Step 3: Write the live test**

`engine/test/agent-live.test.ts`:

```ts
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
    expect(kinds[0]).toBe("agent_query");
    expect(kinds.at(-1)).toBe("agent_result");
    expect(tools).toContain("Read");
    expect(tools.every((t) => t === "Read")).toBe(true);
  }, 180_000);
});
```

- [ ] **Step 4: Run the live test once, if credentials exist**

Run: `cd ~/GitHub/Showrunner/engine && SHOWRUNNER_LIVE=1 npx vitest run test/agent-live.test.ts`
Expected: PASS in under three minutes. If it fails for want of credentials (an authentication error, or `Native CLI binary ... not found`), record the exact error in the report and leave the test in place; Ryan runs it himself. If it fails for any other reason, that is a finding about this plan's reading of the SDK — record the full output and stop.

Then confirm it is skipped without the variable: `npx vitest run test/agent-live.test.ts` prints `1 skipped`.

- [ ] **Step 5: Exports and README**

`engine/src/index.ts` gains, after the `script-step.js` line:

```ts
export * from "./prompt-template.js";
export * from "./agent-step.js";
export * from "./sdk-query.js";
```

`README.md` gains a section **"Agent steps"** after the step-kinds section, stating: an agent step is one SDK query; the executor is built with `createAgentExecutor({ query: sdkQuery, promptsDir, models })`; the prompt template syntax table from Task 2; that the query runs with `cwd` = the show root, `permissionMode: "dontAsk"`, `settingSources: []`, and the `claude_code` system prompt preset; the three events and their payload fields (as written in Task 3, step 9); the outcome shapes; the bounds (`timeoutMs`, `idleTimeoutMs`, `maxTurns`, `maxBudgetUsd`) and what each failure message says; the context policy and its restart behaviour; how to run the live test; and that `total_cost_usd` is the SDK's client-side estimate, not billing data.

- [ ] **Step 6: Run everything**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck && grep -rn -i 'dead ?light' engine/ README.md ; grep -rn 'bypassPermissions' engine/src ; grep -rln 'claude-agent-sdk' engine/src`
Expected: `125 passed | 1 skipped` across 18 files; typecheck prints nothing; the first two greps print nothing; the third prints only `engine/src/sdk-query.ts`.

- [ ] **Step 7: Commit and push**

```bash
cd ~/GitHub/Showrunner && git add engine/src/sdk-query.ts engine/src/index.ts engine/test/agent-live.test.ts README.md && git commit -F - <<'MSG'
sdk-query: the one Agent SDK import, an env-gated live test, exports, and the README's agent section

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K4ZqdsBoXVFn8SwDSWinC9
MSG
git push -u origin agent-runner
```

---

## What this plan deliberately leaves to the next plans

- **Show config supplies `promptsDir` and `models`** (Plan C). This plan's executor takes both as options and defaults `promptsDir` to `<showRoot>/prompts`. Plan C's config file names the prompts directory and the alias map; the current values are in the show repository's `.archon/config.yaml` (`small`, `medium`, `large`, `@writer`).
- **Prompt extraction rewrites Archon's variables into this plan's syntax** (Plan C). The mapping, from the five workflow files: `$EP`, `$EP_ID`, `$setup.output` → `{{episodeId}}`; `$REJECTION_REASON` → `{{results.<gate-id>:rejection}}`; `$<step>.output.<field>` → `{{results.<step>.<field>}}`; `$ARGUMENTS` (the premise) → a Plan D result key the setup step writes. Anything else is a finding for Plan C.
- **Fan-out of the review panel** (Plan D decides). Plan A's runner executes steps one at a time in dependency order; the seven reviewers therefore run sequentially. If the wall-clock matters, Plan D adds parallel execution of independent ready steps to the runner as its own task, with the log order still authoritative.
- **A warm SDK process** (`startup()` / `WarmQuery`) would remove the per-step spawn cost. Not built; measure first in Plan D's first real run.
- **Per-agent enforcement of `timeoutMs` for nested steps** is delivered here by construction: the executor reads `step.timeoutMs` whatever the step's position. Guards, gates, and loops still do not enforce a timeout of their own (Plan A deferred doc, Plan B section, first item): a guard is in-process, a gate waits on a person, a loop inherits its body's.
- **Session transcripts** persist under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` on the machine that ran the step; `agent_result.sessionId` is the pointer the troubleshooting agent (spec §6.8) follows to the full conversation. Not copied into the show repository.
- **Cost accounting** uses the SDK's client-side estimate. Authoritative figures come from the Usage and Cost API, which is Plan E's concern if the board ever shows money.
- **Authentication for a shipped product** must be API-key based: Anthropic's policy note on the Agent SDK pages says third-party developers may not offer claude.ai login for products built on it. Ryan's own machine may use its Claude Code login. This matters for the "give it to friends" question and belongs to a later packaging plan, not to C–F.

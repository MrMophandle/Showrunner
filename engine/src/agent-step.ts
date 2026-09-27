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

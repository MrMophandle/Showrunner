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

/** Thrown by `pump` when the total or the idle clock fires. Its message is the failure string. */
class Deadline extends Error {}

/** Thrown in place of a rejected `emit` so the executor tells an event-log failure apart from a
 *  query failure — the query and the SDK stream were healthy; the run log is what broke, and
 *  script-step.ts words the same fault `log write failed: <msg>`. The class is also what makes the
 *  classification unconditional: the `query failed` branch only fires when no result message has
 *  arrived, so an emit that rejected after a result was stored would otherwise be swallowed and the
 *  step would report success. */
class EmitFailure extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
      return { ok: false, error: errorMessage(err) };
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
      allowedTools: [...step.allowedTools], context: step.context, schema: Boolean(step.schema), resumed: Boolean(options.resume),
    });

    // 5–7: drive the stream under the total and idle deadlines. The executor never relies on the
    //      iterator honouring the abort: pump races each next() against its own clocks.
    let toolCalls = 0;
    let sessionId: string | undefined;
    let result: AgentMessage | undefined;
    let failure: string | undefined;
    try {
      await pump(opts.query({ prompt, options }), abortController, { ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}), ...(step.idleTimeoutMs !== undefined ? { idleTimeoutMs: step.idleTimeoutMs } : {}) }, async (m) => {
        if (m.session_id && !sessionId) sessionId = m.session_id;
        if (m.type === "assistant" && m.message) {
          for (const block of m.message.content) {
            if (block.type === "tool_use" && "name" in block) {
              toolCalls += 1;
              try {
                await emit("agent_tool_call", { tool: block.name, input: block.input, toolUseId: block.id, index: toolCalls });
              } catch (err) {
                throw new EmitFailure(errorMessage(err));
              }
            }
          }
        } else if (m.type === "result") {
          result = m;
        }
      });
    } catch (err) {
      if (err instanceof Deadline) { failure = err.message; result = undefined; }
      else if (err instanceof EmitFailure) { failure = `log write failed: ${err.message}`; result = undefined; }
      else if (!result) failure = `query failed: ${errorMessage(err)}`;
    }

    // 8: the outcome. A deadline or a rejected emit discards the result message that raced in, so
    //    `r` is a result only when nothing has already failed — and the total timeout therefore
    //    wins over a result that arrived after it.
    const r = failure !== undefined ? undefined : result;
    let outcome: AgentOutcome;
    if (r === undefined) {
      outcome = { ok: false, error: failure ?? "query ended without a result message" };
    } else if (r.subtype === undefined) {
      outcome = { ok: false, error: "result message with no subtype" };
    } else if (r.subtype === "success") {
      if (step.schema && r.structured_output === undefined) {
        outcome = { ok: false, error: "success without structured output" };
      } else {
        outcome = {
          ok: true, text: r.result ?? "", toolCalls,
          ...(step.schema ? { verdict: r.structured_output } : {}),
        };
      }
    } else {
      const errors = r.errors ?? [];
      outcome = { ok: false, error: errors.length ? `${r.subtype}: ${errors.join("; ")}` : r.subtype };
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

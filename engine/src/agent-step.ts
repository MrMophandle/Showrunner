import path from "node:path";
import type { AgentOutcome, AgentStep, Emit, Executors, JsonSchema, RunContext } from "./steps.js";
import { loadPrompt, renderPrompt, type RenderExtra } from "./prompt-template.js";
import { resolveShowPath, seasonOf, ShowConfigError, type ShowConfig } from "./show-config.js";

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
  /** Absolute path of the show's prompts directory. Default: the show config's promptsDir resolved
   *  against the show root when a config is given, else `<showRoot>/prompts`, per call. */
  promptsDir?: string;
  /** Model alias → model id. A model not in the map is passed to the SDK unchanged. */
  models?: Record<string, string>;
  /** The show's config; supplies promptsDir and models when the explicit options are absent, and
   *  the {{season}}/{{show.*}} variables. */
  show?: ShowConfig;
}

/** Thrown by `pump` when the total or the idle clock fires. Its message is the failure string. */
class Deadline extends Error {}

/** Thrown in place of a rejected `emit` so the executor tells an event-log failure apart from a
 *  query failure — the query and the SDK stream were healthy; the run log is what broke, and
 *  script-step.ts words the same fault `log write failed: <msg>`. The class is also what makes the
 *  classification unconditional: the `query failed` branch only fires when no result message has
 *  arrived, so an emit that rejected after a result was stored would otherwise be swallowed and the
 *  step would report success. */
class EmitFailure extends Error {}

/** Thrown in place of anything else the executor's own message handler throws — a stream whose
 *  shape the handler did not survive, as against a query that failed or a log that failed. Without
 *  the class such a throw would land in the `query failed` branch, which fires only when no result
 *  message has arrived, so a handler fault after a result was stored would be swallowed and the
 *  step would report the success it never finished reading. */
class HandlerFailure extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Pumps `iterable` under two clocks — a total deadline and an idle deadline reset on every
 *  message — and hands each message to `onMessage`. When a clock fires it aborts `controller`,
 *  asks the iterator to return without waiting for it (the SDK's iterator may not honour the
 *  abort promptly, and a step must not hang on it), and throws Deadline with the reason.
 *
 *  Every other error out of the iterator or the handler gets the same abort-and-return treatment
 *  before it is rethrown: a rejected emit or a handler fault abandons the iterator mid-stream, and
 *  without the abort the SDK's child process would keep running with nobody draining it. */
async function pump(
  iterable: AsyncIterable<AgentMessage>,
  controller: AbortController,
  bounds: { timeoutMs?: number; idleTimeoutMs?: number },
  onMessage: (m: AgentMessage) => Promise<void>,
): Promise<void> {
  const it = iterable[Symbol.asyncIterator]();
  // The reason is recorded as well as rejected, because the race below cannot be trusted to
  // observe the rejection — see the check after it.
  let reason: string | undefined;
  let fire!: (reason: string) => void;
  const fired = new Promise<never>((_, reject) => { fire = (why) => { reason = why; reject(new Deadline(why)); }; });
  const total = bounds.timeoutMs !== undefined ? setTimeout(() => fire(`timeout after ${bounds.timeoutMs}ms`), bounds.timeoutMs) : undefined;
  let idle: NodeJS.Timeout | undefined;
  const armIdle = () => {
    if (bounds.idleTimeoutMs === undefined) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => fire(`idle timeout after ${bounds.idleTimeoutMs}ms`), bounds.idleTimeoutMs);
  };
  fired.catch(() => {}); // the race below observes it; this silences an unhandled-rejection report when nothing is racing
  armIdle();
  try {
    while (true) {
      const next = await Promise.race([it.next(), fired]);
      // Promise.race adopts its inputs in array order when both are already settled, so an
      // end-of-stream next() — which resolves synchronously — beats a `fired` that rejected during
      // the previous onMessage, and the pump would return normally from a step that had already
      // timed out. `fire` sets `reason` synchronously, so this makes "did a clock fire" a question
      // of state rather than of scheduling. The `fired` rejection still covers a clock that fires
      // while next() is genuinely pending.
      if (reason !== undefined) throw new Deadline(reason);
      if (next.done) return;
      armIdle();
      // onMessage is not raced against the clocks: a stalled handler — a log append that blocks —
      // delays the deadline by its own duration, and the clock is observed at the next next().
      await onMessage(next.value);
    }
  } catch (err) {
    // A clock that fired is the truth about this step even when the race adopted something else.
    // `fired` and a rejecting next() can both be settled when the race is set up, and Promise.race
    // then adopts the array-order first — the iterator's rejection — so the check after the await
    // never runs. `fire` sets `reason` synchronously, so it outranks the error raised beside it.
    const out = reason !== undefined && !(err instanceof Deadline) ? new Deadline(reason) : err;
    controller.abort();
    try { void it.return?.().catch(() => {}); } catch { /* a return() that throws synchronously has nothing to tell us */ }
    throw out;
  } finally {
    if (total) clearTimeout(total);
    if (idle) clearTimeout(idle);
  }
}

export function createAgentExecutor(opts: AgentExecutorOptions): Executors["agent"] {
  /** context: "shared" — session ids by `${episodeId}/${runId}/${stepId}`, for this executor's
   *  lifetime. The episode id is part of the key because a run id is only unique within an episode:
   *  two episodes could carry the same run-id string, and one long-lived executor (a console process
   *  that runs several episodes in turn) would then resume the first episode's session inside the
   *  second. A restart makes a new executor, so a resumed run's shared step starts a fresh session;
   *  the agent_query it logs says resumed: false, which is the record of that. */
  const sessions = new Map<string, string>();

  return async (step: AgentStep, ctx: RunContext, emit: Emit): Promise<AgentOutcome> => {
    // 1–2: the prompt and the schema, checked before anything is logged or queried.
    const promptsDir = opts.promptsDir ?? (opts.show ? resolveShowPath(ctx.showRoot, opts.show.promptsDir) : path.join(ctx.showRoot, "prompts"));
    let prompt: string;
    let promptHash: string;
    let promptPath: string;
    try {
      // The season is resolved eagerly but is not required: an id the air map does not carry
      // leaves it undefined, and only a prompt that writes {{season}} then fails, in the renderer.
      // A malformed episode id is an InvalidEpisodeId rather than a ShowConfigError, is not
      // swallowed here, and fails the step before anything is logged or queried.
      let season: number | undefined;
      if (opts.show) {
        try {
          season = seasonOf(ctx.episodeId, opts.show.airMap);
        } catch (err) {
          if (!(err instanceof ShowConfigError)) throw err;
        }
      }
      const extra: RenderExtra = {
        ...(season !== undefined ? { season } : {}),
        ...(opts.show ? { show: opts.show as unknown as Record<string, unknown> } : {}),
      };
      const loaded = await loadPrompt(promptsDir, step.promptFile);
      promptHash = loaded.hash;
      promptPath = loaded.path;
      prompt = renderPrompt(loaded.text, ctx, extra);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    // An allowlist rather than a denylist: the SDK validates against draft-07 only, so anything a
    // `$schema` names that is not draft-07 is refused, including a draft this code has never heard
    // of. A schema with no `$schema` key at all is accepted — draft-07 is the SDK's default.
    const declared = step.schema?.["$schema"];
    if (typeof declared === "string" && !declared.includes("draft-07")) {
      return { ok: false, error: `schema must be JSON Schema draft-07, got ${declared}` };
    }

    // 3: the options.
    const models: Record<string, string | undefined> | undefined = opts.models ?? opts.show?.models;
    const model = models?.[step.model] ?? step.model;
    const abortController = new AbortController();
    // Both the read and the write of the session map are gated on "shared", so the policy is one
    // predicate rather than two that have to agree: a "fresh" step leaves no entry behind that a
    // later query could resume, whatever it does with its session id.
    const sessionKey = `${ctx.episodeId}/${ctx.runId}/${step.id}`;
    const resume = step.context === "shared" ? sessions.get(sessionKey) : undefined;
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
      ...(resume !== undefined ? { resume } : {}),
    };

    // 4: agent_query.
    await emit("agent_query", {
      promptFile: step.promptFile, promptHash, promptPath, model, modelAlias: step.model,
      allowedTools: [...step.allowedTools], context: step.context, schema: Boolean(step.schema), resumed: Boolean(options.resume),
      showConfig: Boolean(opts.show),
    });

    // 5–7: drive the stream under the total and idle deadlines. The executor never relies on the
    //      iterator honouring the abort: pump races each next() against its own clocks.
    let toolCalls = 0;
    let sessionId: string | undefined;
    let result: AgentMessage | undefined;
    let failure: string | undefined;
    try {
      await pump(opts.query({ prompt, options }), abortController, { ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}), ...(step.idleTimeoutMs !== undefined ? { idleTimeoutMs: step.idleTimeoutMs } : {}) }, async (m) => {
        // Every fault raised in here is classified before it leaves, so the `query failed` branch
        // below sees only what the iterator itself threw.
        try {
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
        } catch (err) {
          if (err instanceof EmitFailure) throw err;
          throw new HandlerFailure(errorMessage(err));
        }
      });
    } catch (err) {
      // The result is deliberately left in place. `r` below is computed from `failure`, so a
      // failure still wins the outcome; keeping the message means agent_result can still report the
      // subtype, turns, duration, cost and session id of a result that raced in before the clock
      // was observed, which is the only record of what the query had spent when it was cut off.
      if (err instanceof Deadline) { failure = err.message; }
      else if (err instanceof EmitFailure) { failure = `log write failed: ${err.message}`; }
      else if (err instanceof HandlerFailure) { failure = `message handling failed: ${err.message}`; }
      // What is left is the iterator's own throw. A result already stored wins over it: the SDK
      // throws after yielding an error result, and that result classifies the failure precisely.
      else if (!result) failure = `query failed: ${errorMessage(err)}`;
    }
    if (step.context === "shared" && sessionId !== undefined) sessions.set(sessionKey, sessionId);

    // 8: the outcome. A deadline, a rejected emit or a handler fault outranks the result that
    //    raced in: `r` is a result only when nothing has already failed, so the total timeout wins
    //    over a result that arrived after it. The result message itself is kept, and step 9 still
    //    reports its metadata.
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

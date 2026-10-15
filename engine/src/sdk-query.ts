import { query, type SDKAssistantMessage, type SDKControlGetUsageResponse, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentContentBlock, AgentMessage, AgentQueryOptions, AgentUsage, QueryFn } from "./agent-step.js";

/** The one place the engine touches the Agent SDK. Everything the executor reads is copied onto
 *  AgentMessage field by field, so a change in the SDK's types shows up here as a compile error
 *  and nowhere else.
 *
 *  The query **object** is held in a local rather than iterated as an expression, because a plan
 *  usage limit is the one fault the stream alone cannot describe: a `rate_limit_event` names the
 *  window it rejected, but the weekly figure Ryan's auto-retry rule reads lives behind the object's
 *  own usage call. So after the first rejected limit this generator asks that call once and yields
 *  one synthetic `usage` message, which is the only message in the stream the SDK did not send. */
export const sdkQuery: QueryFn = async function* ({ prompt, options }: { prompt: string; options: AgentQueryOptions }) {
  const dropVerdictTool = options.outputFormat !== undefined;
  const q = query({ prompt, options: { ...options } });
  let askedForUsage = false;
  for await (const m of q) {
    const mapped = toAgentMessage(m, dropVerdictTool);
    yield mapped;
    // Once per query, not once per event: the windows keep reporting as a stream drains, and the
    // executor needs one answer, not one per rejection.
    if (!askedForUsage && mapped.rateLimit?.status === "rejected") {
      askedForUsage = true;
      yield await usageMessage(q);
    }
  }
};

/** How long the usage call is given to answer before it is treated as unavailable. It is a timeout
 *  rather than a plain await because the call is an SDK **control request**, and `sdk.d.ts` says
 *  those are "only supported when streaming input/output is used" while the engine passes a plain
 *  string prompt: a request that is never answered is as likely as one that throws. Without this
 *  bound such a call would stall inside the generator until the step's own idle deadline fired —
 *  fifteen minutes for a loop body — and a step would lose that time to a figure it only wanted
 *  for a decision it can make without one. */
const USAGE_CALL_TIMEOUT_MS = 10_000;

/** Just enough of the SDK's `Query` object to ask it for the plan's utilization, with the method
 *  optional. The SDK declares the method as required, so a real `Query` satisfies this; declaring it
 *  optional here is what lets this module survive an SDK that renames or drops a method its own
 *  declaration marks EXPERIMENTAL — the absence becomes "the weekly utilization is unknown" rather
 *  than a TypeError thrown out of a query that was otherwise healthy. */
export interface UsageCapableQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (opts?: { skipBehaviors?: boolean }) => Promise<SDKControlGetUsageResponse>;
}

/** The one synthetic message in the stream: the plan's utilization windows, asked of the query
 *  object after it rejected a request for a usage limit.
 *
 *  Exported for this file's own unit tests, which need to prove all four paths without calling the
 *  SDK. **Nothing here may reject**: a missing method, a throw, and an answer that does not arrive
 *  inside `USAGE_CALL_TIMEOUT_MS` all return `{ available: false }`, because the figure is an input
 *  to a decision the executor can still make without it (it refuses to auto-retry and says the
 *  weekly utilization is unknown), and failing the query over it would turn a recoverable limit
 *  into an unexplained `query failed`.
 *
 *  `skipBehaviors: true` because the engine reads only `rate_limits`: the flag skips a scan of the
 *  machine's local transcripts that fills a section of the answer nothing here looks at. */
export async function usageMessage(q: UsageCapableQuery, timeoutMs = USAGE_CALL_TIMEOUT_MS): Promise<AgentMessage> {
  const call = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof call !== "function") return { type: "usage", usage: { available: false } };
  let timer: NodeJS.Timeout | undefined;
  try {
    // The timer resolves rather than rejects, so a timeout and an answer come back through one
    // path and `undefined` is the sentinel for "did not answer in time".
    const answered = await Promise.race([
      call.call(q, { skipBehaviors: true }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    return { type: "usage", usage: answered === undefined ? { available: false } : toUsage(answered) };
  } catch {
    return { type: "usage", usage: { available: false } };
  } finally {
    // Cleared on every path: an uncleared ten-second timer would keep the process alive that much
    // longer after a run finished, on every limited step.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Maps the SDK's usage response onto the two windows the executor reads. Exported for this file's
 *  unit tests.
 *
 *  `rate_limits_available: false` means plan limits do not apply to this session at all (an API
 *  key, Bedrock, Vertex, or a missing profile scope) and the SDK then sends `rate_limits: null`;
 *  either one alone maps to `{ available: false }`, so a response that disagrees with itself is
 *  read the cautious way. The per-model weekly windows (`seven_day_opus`, `seven_day_sonnet`,
 *  `seven_day_oauth_apps`, `model_scoped`) are deliberately not mapped: the rule reads one weekly
 *  figure, and a per-model window is not it. Nulls are preserved rather than dropped, because the
 *  executor's rule turns on "is this a number", and a window the endpoint answered with no figure
 *  must not read as one. */
export function toUsage(res: SDKControlGetUsageResponse): AgentUsage {
  const limits = res.rate_limits;
  if (res.rate_limits_available !== true || limits === null || limits === undefined) return { available: false };
  const fiveHour = toWindow(limits.five_hour);
  const sevenDay = toWindow(limits.seven_day);
  return {
    available: true,
    ...(fiveHour !== undefined ? { fiveHour } : {}),
    ...(sevenDay !== undefined ? { sevenDay } : {}),
  };
}

function toWindow(w: { utilization: number | null; resets_at: string | null } | null | undefined): { utilization: number | null; resetsAt: string | null } | undefined {
  return w === null || w === undefined ? undefined : { utilization: w.utilization, resetsAt: w.resets_at };
}

/** Maps one SDK message onto the executor's AgentMessage. Exported for this file's own unit tests,
 *  which build SDK-shaped messages by hand; the executor only ever reaches it through sdkQuery.
 *
 *  `dropVerdictTool` is true only for a query run with `outputFormat`: on any other query a tool
 *  that happens to be named StructuredOutput is a real tool call and is counted. */
export function toAgentMessage(m: SDKMessage, dropVerdictTool = false): AgentMessage {
  const out: AgentMessage = { type: m.type };
  if ("subtype" in m && typeof m.subtype === "string") out.subtype = m.subtype;
  if ("session_id" in m && typeof m.session_id === "string") out.session_id = m.session_id;
  if (m.type === "assistant") {
    out.message = { content: m.message.content.filter((b) => !(dropVerdictTool && isVerdictDelivery(b))).map(toBlock) };
    // The kind that ended the turn, verbatim: `rate_limit` or one of the twelve others. It rides on
    // the same AgentMessage as that message's text blocks on purpose — the SDK's own sentence about
    // the fault is in those blocks ("You've hit your session limit · resets 7:50pm
    // (America/New_York)"), and it is the only place the reset's time zone is ever named.
    if (m.error !== undefined) out.error = m.error;
  }
  if (m.type === "rate_limit_event") {
    const info = m.rate_limit_info;
    const resetsAt = resetsAtIso(info.resetsAt);
    out.rateLimit = {
      status: info.status,
      ...(info.rateLimitType !== undefined ? { window: info.rateLimitType } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(typeof info.utilization === "number" && Number.isFinite(info.utilization) ? { utilization: info.utilization } : {}),
    };
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

/** A `rate_limit_event`'s reset time as an ISO string, or undefined when the SDK sent none.
 *
 *  **The SDK's `resetsAt` is epoch seconds, not milliseconds**, which its declaration does not say
 *  (`resetsAt?: number`) — it is the one fact in this mapping that cannot be read off `sdk.d.ts`,
 *  and the whole operator sentence hangs on it: read as milliseconds, a reset five hours away would
 *  be printed as a date in 1970. A non-finite value is dropped rather than converted, because
 *  `new Date(NaN).toISOString()` throws and would fail a query over a field nothing requires. */
function resetsAtIso(resetsAt: number | undefined): string | undefined {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
  return new Date(resetsAt * 1000).toISOString();
}

/** The SDK's own content-block union, derived from SDKAssistantMessage rather than named: the SDK
 *  types `message` as the Anthropic Messages API's BetaMessage, whose `content` is a discriminated
 *  union of block interfaces. Those interfaces have no index signature, so the block array is not
 *  convertible to Record<string, unknown>; narrowing on `b.type` costs nothing and couples harder —
 *  a block field the SDK renames is a compile error here rather than a silently dropped value. */
type SdkContentBlock = SDKAssistantMessage["message"]["content"][number];

/** The synthetic tool call the SDK delivers a schema verdict through, found on 2026-09-27 by this
 *  plan's live test against SDK 0.3.283. A query run with `outputFormat` ends with the model calling
 *  a tool named StructuredOutput whose input is the verdict object, and the SDK then hands that same
 *  object back as `structured_output` on the result message — so the executor already has the
 *  verdict, and the tool call carries nothing the log does not otherwise hold.
 *
 *  It is dropped rather than counted because counting it would inflate `toolCalls` by exactly one on
 *  every step that has a schema, which would disable spec §6.7's zero-tool-call detector for exactly
 *  those steps: a loop iteration that did nothing would report one tool call instead of none, and
 *  that count is the ep09/ep10 failure signal.
 *
 *  The name is not in the SDK's type declarations — `sdk.d.ts` never mentions it, and the string
 *  lives in the bundled Claude Code binary — so it cannot be imported, and it is pinned here and
 *  nowhere else in the engine. If the SDK renames it, the symptom is a schema step whose `toolCalls`
 *  is one higher than the tools it ran, and this constant is the only line to change. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

function isVerdictDelivery(b: SdkContentBlock): boolean {
  return b.type === "tool_use" && b.name === STRUCTURED_OUTPUT_TOOL;
}

function toBlock(b: SdkContentBlock): AgentContentBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
  return { type: b.type };
}

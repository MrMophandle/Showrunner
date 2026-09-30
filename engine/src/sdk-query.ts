import { query, type SDKAssistantMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentContentBlock, AgentMessage, AgentQueryOptions, QueryFn } from "./agent-step.js";

/** The one place the engine touches the Agent SDK. Everything the executor reads is copied onto
 *  AgentMessage field by field, so a change in the SDK's types shows up here as a compile error
 *  and nowhere else. */
export const sdkQuery: QueryFn = async function* ({ prompt, options }: { prompt: string; options: AgentQueryOptions }) {
  const dropVerdictTool = options.outputFormat !== undefined;
  for await (const m of query({ prompt, options: { ...options } })) {
    yield toAgentMessage(m, dropVerdictTool);
  }
};

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

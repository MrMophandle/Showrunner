import { describe, it, expect } from "vitest";
import type { SDKAssistantMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { toAgentMessage } from "../src/sdk-query.js";

// This file imports the adapter module, which is allowed: loading @anthropic-ai/claude-agent-sdk has
// no side effect — no process is spawned and no binary is looked up until query() is called — so the
// suite stays hermetic. What is never allowed outside the env-gated live test is calling the SDK.
// The messages below are built as the SDK's own types and cast through `unknown` for the fields the
// adapter does not read (uuid, usage, modelUsage and the rest), so a renamed field the adapter DOES
// read still breaks this file.

describe("toAgentMessage", () => {
  it("drops the SDK's synthetic StructuredOutput tool call and keeps the real one", () => {
    const m = {
      type: "assistant",
      session_id: "sess-1",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/show/notes.md" } },
          { type: "text", text: "read it" },
          // "StructuredOutput" is spelled out here rather than imported from the source constant,
          // deliberately: this literal pins the wire name the live run observed, so renaming the
          // constant away from the name the SDK actually sends fails this test.
          { type: "tool_use", id: "t2", name: "StructuredOutput", input: { pass: true, word: "TANGERINE" } },
        ],
      },
    } as unknown as SDKAssistantMessage;
    expect(toAgentMessage(m, true)).toEqual({
      type: "assistant",
      session_id: "sess-1",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/show/notes.md" } },
          { type: "text", text: "read it" },
        ],
      },
    });
    // The executor counts tool_use blocks, so the verdict delivery must not reach it as one.
    const blocks = toAgentMessage(m, true).message?.content ?? [];
    expect(blocks.filter((b) => b.type === "tool_use")).toHaveLength(1);
  });

  it("keeps a tool_use named StructuredOutput when not asked to drop it", () => {
    const m = { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: { pass: true } }] } };
    const out = toAgentMessage(m as never);
    expect(out.message?.content).toHaveLength(1);
  });

  it("copies every field the executor reads off a success result", () => {
    const m = {
      type: "result",
      subtype: "success",
      session_id: "sess-2",
      result: "{\"pass\":true}",
      structured_output: { pass: true, word: "TANGERINE" },
      num_turns: 3,
      duration_ms: 6626,
      total_cost_usd: 0.0719344,
      permission_denials: [{ tool_name: "Bash", tool_use_id: "t9", tool_input: { command: "ls" } }],
    } as unknown as SDKResultSuccess;
    expect(toAgentMessage(m)).toEqual({
      type: "result",
      subtype: "success",
      session_id: "sess-2",
      result: "{\"pass\":true}",
      structured_output: { pass: true, word: "TANGERINE" },
      num_turns: 3,
      duration_ms: 6626,
      total_cost_usd: 0.0719344,
      permission_denials: [{ tool_name: "Bash" }],
    });
  });
});

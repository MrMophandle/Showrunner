import { describe, it, expect } from "vitest";
import type { SDKAssistantMessage, SDKControlGetUsageResponse, SDKRateLimitEvent, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { toAgentMessage, toUsage, usageMessage, type UsageCapableQuery } from "../src/sdk-query.js";

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

/** The reset the live run of 2026-10-14 reported, as the SDK sends it: epoch **seconds**. The ISO
 *  beside it is what the adapter must produce; read as milliseconds the same number would be
 *  1970-01-21, which is the mistake this pair exists to catch. */
const RESET_EPOCH_SECONDS = 1_792_021_800;
const RESET_ISO = "2026-10-14T23:50:00.000Z";

describe("toAgentMessage: the usage-limit signals", () => {
  it("maps a rejected rate_limit_event onto rateLimit, converting epoch seconds to ISO", () => {
    const m = {
      type: "rate_limit_event",
      session_id: "sess-3",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: RESET_EPOCH_SECONDS, utilization: 100 },
    } as unknown as SDKRateLimitEvent;
    expect(toAgentMessage(m)).toEqual({
      type: "rate_limit_event",
      session_id: "sess-3",
      rateLimit: { status: "rejected", window: "five_hour", resetsAt: RESET_ISO, utilization: 100 },
    });
    // The seconds-not-milliseconds pin, stated twice on purpose: the ISO above would still match a
    // renamed field, but a year of 1970 could only come from the wrong unit.
    expect(toAgentMessage(m).rateLimit?.resetsAt?.startsWith("2026-")).toBe(true);
  });

  it("maps an allowed rate_limit_event, and omits every field the SDK did not send", () => {
    const m = { type: "rate_limit_event", rate_limit_info: { status: "allowed" } } as unknown as SDKRateLimitEvent;
    // toEqual would pass on a key whose value is undefined, so the keys themselves are asserted:
    // exactOptionalPropertyTypes means absent, never undefined, all the way to the log.
    expect(Object.keys(toAgentMessage(m).rateLimit ?? {})).toEqual(["status"]);
    expect(toAgentMessage(m).rateLimit?.status).toBe("allowed");
  });

  it("copies an assistant message's error kind verbatim, beside the SDK's own sentence", () => {
    const m = {
      type: "assistant",
      session_id: "sess-4",
      error: "rate_limit",
      message: { content: [{ type: "text", text: "You've hit your session limit · resets 7:50pm (America/New_York)" }] },
    } as unknown as SDKAssistantMessage;
    const out = toAgentMessage(m);
    expect(out.error).toBe("rate_limit");
    // The kind and the sentence must ride on one message: the sentence is the only place the
    // reset's time zone is ever named, and the executor pairs them without a second lookup.
    expect(out.message?.content[0]).toEqual({ type: "text", text: "You've hit your session limit · resets 7:50pm (America/New_York)" });
  });

  it("leaves error absent on an assistant message that carries none", () => {
    const m = { type: "assistant", message: { content: [{ type: "text", text: "done" }] } } as unknown as SDKAssistantMessage;
    expect("error" in toAgentMessage(m)).toBe(false);
  });
});

describe("the usage call", () => {
  const response = (over: Partial<SDKControlGetUsageResponse> = {}): SDKControlGetUsageResponse => ({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 100, resets_at: RESET_ISO },
      seven_day: { utilization: 41, resets_at: "2026-10-19T04:00:00.000Z" },
    },
    ...over,
  } as unknown as SDKControlGetUsageResponse);

  it("maps both windows, renaming resets_at and keeping nulls as nulls", () => {
    expect(toUsage(response())).toEqual({
      available: true,
      fiveHour: { utilization: 100, resetsAt: RESET_ISO },
      sevenDay: { utilization: 41, resetsAt: "2026-10-19T04:00:00.000Z" },
    });
    // A window the endpoint answered with no figure must not read as a figure: the executor's rule
    // turns on "is this a number", and null is the SDK's way of saying it does not know.
    const noFigures = response({ rate_limits: { seven_day: { utilization: null, resets_at: null } } } as Partial<SDKControlGetUsageResponse>);
    expect(toUsage(noFigures)).toEqual({ available: true, sevenDay: { utilization: null, resetsAt: null } });
  });

  it("maps rate_limits_available: false, and a null rate_limits, to available: false", () => {
    expect(toUsage(response({ rate_limits_available: false, rate_limits: null }))).toEqual({ available: false });
    // The two halves are read independently, so a response that disagrees with itself is read the
    // cautious way rather than dereferenced.
    expect(toUsage(response({ rate_limits: null }))).toEqual({ available: false });
    expect(toUsage(response({ rate_limits_available: false }))).toEqual({ available: false });
  });

  it("answers available: false when the method is missing, throws, or does not answer in time", async () => {
    // The three ways the SDK's EXPERIMENTAL call can fail to produce a figure. None of them may
    // reject out of sdkQuery: the executor can still decide without the weekly number — it refuses
    // to auto-retry and says the utilization is unknown — and a throw here would turn a
    // recoverable usage limit into an unexplained `query failed`.
    expect(await usageMessage({})).toEqual({ type: "usage", usage: { available: false } });

    const throws: UsageCapableQuery = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.reject(new Error("control request not supported")) };
    expect(await usageMessage(throws)).toEqual({ type: "usage", usage: { available: false } });

    const hangs: UsageCapableQuery = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}) };
    expect(await usageMessage(hangs, 5)).toEqual({ type: "usage", usage: { available: false } });
  });

  it("asks for the rate limits without the local-transcript scan, and yields one usage message", async () => {
    const calls: Array<{ skipBehaviors?: boolean } | undefined> = [];
    const q: UsageCapableQuery = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (o) => { calls.push(o); return Promise.resolve(response()); },
    };
    expect(await usageMessage(q)).toEqual({
      type: "usage",
      usage: { available: true, fiveHour: { utilization: 100, resetsAt: RESET_ISO }, sevenDay: { utilization: 41, resetsAt: "2026-10-19T04:00:00.000Z" } },
    });
    expect(calls).toEqual([{ skipBehaviors: true }]);
  });
});

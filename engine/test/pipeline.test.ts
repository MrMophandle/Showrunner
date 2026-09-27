import { describe, it, expect } from "vitest";
import { orderSteps, PipelineError } from "../src/pipeline.js";
import type { Pipeline, GuardStep, GateStep, LoopStep, AgentStep } from "../src/steps.js";

const g = (id: string, dependsOn: string[] = []): GuardStep => ({
  kind: "guard", id, dependsOn, check: () => ({ pass: true }),
});

const agent = (id: string): AgentStep => ({
  kind: "agent", id, promptFile: "p.md", model: "m", allowedTools: [], context: "fresh",
});

const gate = (id: string, onRejectId?: string): GateStep => ({
  kind: "gate", id, message: () => "approve?", ...(onRejectId === undefined ? {} : { onReject: agent(onRejectId) }),
});

const loop = (id: string, bodyId: string): LoopStep => ({
  kind: "loop", id, body: agent(bodyId), until: "DONE", maxIterations: 3,
});

describe("orderSteps", () => {
  it("returns steps in dependency order, keeping declaration order among ready steps", () => {
    const p: Pipeline = { name: "t", steps: [g("c", ["a", "b"]), g("a"), g("b", ["a"])] };
    expect(orderSteps(p).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
  it("prefers declaration order when several steps are ready", () => {
    const p: Pipeline = { name: "t", steps: [g("z"), g("a"), g("m", ["z", "a"])] };
    expect(orderSteps(p).map((s) => s.id)).toEqual(["z", "a", "m"]);
  });
  it("throws on a missing dependency", () => {
    const p: Pipeline = { name: "t", steps: [g("a", ["nope"])] };
    expect(() => orderSteps(p)).toThrow(PipelineError);
    expect(() => orderSteps(p)).toThrow(/nope/);
  });
  it("throws on a duplicate id", () => {
    const p: Pipeline = { name: "t", steps: [g("a"), g("a")] };
    expect(() => orderSteps(p)).toThrow(PipelineError);
    expect(() => orderSteps(p)).toThrow(/duplicate/);
  });
  it("throws on a cycle", () => {
    const p: Pipeline = { name: "t", steps: [g("a", ["b"]), g("b", ["a"])] };
    expect(() => orderSteps(p)).toThrow(PipelineError);
    expect(() => orderSteps(p)).toThrow(/cycle/);
  });

  it("throws when a gate's fix agent takes a top-level step's id", () => {
    const p: Pipeline = { name: "t", steps: [g("fix"), gate("gt", "fix")] };
    expect(() => orderSteps(p)).toThrow(PipelineError);
    expect(() => orderSteps(p)).toThrow(/duplicate/);
  });
  it("throws when a loop body and a gate's fix agent share an id", () => {
    const p: Pipeline = { name: "t", steps: [gate("gt", "shared"), loop("lp", "shared")] };
    expect(() => orderSteps(p)).toThrow(PipelineError);
    expect(() => orderSteps(p)).toThrow(/duplicate/);
  });
  it("throws when any id contains a colon, top-level or nested", () => {
    expect(() => orderSteps({ name: "t", steps: [g("a:b")] })).toThrow(PipelineError);
    expect(() => orderSteps({ name: "t", steps: [g("a:b")] })).toThrow(/":"/);
    expect(() => orderSteps({ name: "t", steps: [gate("gt", "a:b")] })).toThrow(/":"/);
    expect(() => orderSteps({ name: "t", steps: [loop("lp", "a:b")] })).toThrow(/":"/);
  });
  it("orders a pipeline whose nested ids are all distinct", () => {
    const p: Pipeline = {
      name: "t",
      steps: [{ ...gate("gt", "fix"), dependsOn: ["lp"] }, loop("lp", "draft"), g("last", ["gt"])],
    };
    expect(orderSteps(p).map((s) => s.id)).toEqual(["lp", "gt", "last"]);
  });
});

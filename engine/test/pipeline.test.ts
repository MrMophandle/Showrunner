import { describe, it, expect } from "vitest";
import { describePipeline, downstreamOf, orderSteps, pipelineHash, PipelineError } from "../src/pipeline.js";
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
  it("throws when a loop body carries a schema", () => {
    const withSchema: LoopStep = { ...loop("lp", "draft"), body: { ...agent("draft"), schema: { type: "object" } } };
    const p: Pipeline = { name: "t", steps: [withSchema] };
    expect(() => orderSteps(p)).toThrow(PipelineError);
    expect(() => orderSteps(p)).toThrow(/untilVerdict/);
  });
  it("orders a loop whose body has no schema", () => {
    expect(orderSteps({ name: "t", steps: [loop("lp", "draft")] }).map((s) => s.id)).toEqual(["lp"]);
  });
  it("orders a pipeline whose nested ids are all distinct", () => {
    const p: Pipeline = {
      name: "t",
      steps: [{ ...gate("gt", "fix"), dependsOn: ["lp"] }, loop("lp", "draft"), g("last", ["gt"])],
    };
    expect(orderSteps(p).map((s) => s.id)).toEqual(["lp", "gt", "last"]);
  });
});

describe("downstreamOf", () => {
  const p: Pipeline = { name: "p", steps: [
    { kind: "guard", id: "a", check: () => ({ pass: true }) },
    { kind: "guard", id: "b", dependsOn: ["a"], check: () => ({ pass: true }) },
    { kind: "guard", id: "c", dependsOn: ["a"], check: () => ({ pass: true }) },
    { kind: "guard", id: "d", dependsOn: ["b", "c"], check: () => ({ pass: true }) },
    { kind: "guard", id: "e", check: () => ({ pass: true }) },
  ] };
  it("returns the named steps and every transitive dependent, in pipeline order", () => {
    expect(downstreamOf(p, ["b"])).toEqual(["b", "d"]);
    expect(downstreamOf(p, ["a"])).toEqual(["a", "b", "c", "d"]);
    expect(downstreamOf(p, ["e", "c"])).toEqual(["c", "d", "e"]);
  });
  it("refuses an unknown id", () => {
    expect(() => downstreamOf(p, ["zz"])).toThrow(/unknown step "zz"/);
  });
  it("orderSteps refuses a gate whose rerunOnReject names an unknown step", () => {
    const bad: Pipeline = { name: "p", steps: [{ kind: "gate", id: "g", message: () => "m", rerunOnReject: ["nope"] }] };
    expect(() => orderSteps(bad)).toThrow(/gate "g" names unknown step "nope" in rerunOnReject/);
  });
  it("orderSteps refuses a gate with neither message nor messageFile, and one with both", () => {
    const neither: Pipeline = { name: "p", steps: [{ kind: "gate", id: "g" }] };
    expect(() => orderSteps(neither)).toThrow(PipelineError);
    expect(() => orderSteps(neither)).toThrow(/gate "g" sets neither message nor messageFile; set exactly one/);
    const both: Pipeline = { name: "p", steps: [{ kind: "gate", id: "g", message: () => "m", messageFile: "g.md" }] };
    expect(() => orderSteps(both)).toThrow(/gate "g" sets both message and messageFile; set exactly one/);
    const file: Pipeline = { name: "p", steps: [{ kind: "gate", id: "g", messageFile: "g.md" }] };
    expect(() => orderSteps(file)).not.toThrow();
  });
});

describe("describePipeline", () => {
  it("reduces a pipeline to JSON, keeping names and edges and marking functions as present", () => {
    const p: Pipeline = { name: "p", steps: [
      { kind: "guard", id: "g0", check: () => ({ pass: true }) },
      { kind: "script", id: "s", dependsOn: ["g0"], argv: () => ["true"], inputs: ["a.md"], outputs: ["b.md"], cwd: "/x", timeoutMs: 5 },
      { kind: "agent", id: "a", dependsOn: ["s"], promptFile: "a.md", schemaFile: "a.schema.json", model: "medium", allowedTools: ["Read"], context: "fresh", when: () => true },
      { kind: "gate", id: "g", dependsOn: ["a"], messageFile: "g.gate.md", maxAttempts: 3, rerunOnReject: ["s"], onReject: { kind: "agent", id: "g-fix", promptFile: "g.reject.md", model: "writer", allowedTools: [], context: "fresh" } },
      { kind: "loop", id: "l", dependsOn: ["g"], until: "DONE", maxIterations: 2, body: { kind: "agent", id: "l-body", promptFile: "l.md", model: "writer", allowedTools: [], context: "shared" } },
    ] };
    const d = describePipeline(p);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d.steps.map((s) => s.id)).toEqual(["g0", "s", "a", "g", "l"]);
    expect(d.steps[1]).toEqual({ id: "s", kind: "script", dependsOn: ["g0"], inputs: ["a.md"], outputs: ["b.md"], when: false, cwd: "/x", timeoutMs: 5 });
    expect(d.steps[2]).toMatchObject({ id: "a", kind: "agent", when: true, promptFile: "a.md", schemaFile: "a.schema.json", model: "medium", allowedTools: ["Read"], context: "fresh" });
    expect(d.steps[3]).toMatchObject({ id: "g", kind: "gate", messageFile: "g.gate.md", maxAttempts: 3, rerunOnReject: ["s"], onReject: { id: "g-fix", promptFile: "g.reject.md", model: "writer" } });
    expect(d.steps[4]).toMatchObject({ id: "l", kind: "loop", until: "DONE", maxIterations: 2, body: { id: "l-body", promptFile: "l.md", model: "writer" } });
    expect(pipelineHash(p)).toMatch(/^[0-9a-f]{64}$/);
    expect(pipelineHash(p)).toBe(pipelineHash({ ...p }));
    expect(pipelineHash(p)).not.toBe(pipelineHash({ ...p, name: "q" }));
  });
});

describe("describePipeline: vars", () => {
  it("records an agent's and a gate's vars with sorted keys, so the hash tracks the values and not the order they were written in", () => {
    const withVars = (vars: Record<string, string>): Pipeline => ({ name: "p", steps: [
      { kind: "agent", id: "a", promptFile: "write.md", model: "m", allowedTools: [], context: "fresh", vars },
      { kind: "gate", id: "gv", dependsOn: ["a"], messageFile: "g.gate.md", vars },
    ] });
    const d = describePipeline(withVars({ heading: "Voice", file: "Canon/x.md" }));
    expect(d.steps[0]).toMatchObject({ id: "a", vars: { file: "Canon/x.md", heading: "Voice" } });
    expect(d.steps[1]).toMatchObject({ id: "gv", vars: { file: "Canon/x.md", heading: "Voice" } });
    expect(Object.keys(d.steps[0]!.vars!)).toEqual(["file", "heading"]);
    // The same vars written in the other order are one pipeline, and hash as one.
    expect(pipelineHash(withVars({ file: "Canon/x.md", heading: "Voice" }))).toBe(pipelineHash(withVars({ heading: "Voice", file: "Canon/x.md" })));
    // A changed value is a changed prompt, and so a changed pipeline.
    expect(pipelineHash(withVars({ file: "Canon/x.md", heading: "Voice" }))).not.toBe(pipelineHash(withVars({ file: "Canon/y.md", heading: "Voice" })));
    // A step that declares no vars carries no `vars` key, so nothing distinguishes it in the hash
    // from the same step described before vars existed.
    expect("vars" in describePipeline({ name: "p", steps: [agent("a")] }).steps[0]!).toBe(false);
  });
});

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

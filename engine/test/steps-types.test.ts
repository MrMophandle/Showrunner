import { describe, it, expect } from "vitest";
import type { AgentStep, EventKind, GateStep, LoopStep, NestedAgentStep, JsonSchema } from "../src/steps.js";

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

describe("event kinds", () => {
  it("pins the EventKind union to eighteen kinds, in the order the union declares them", () => {
    const kinds = [
      "run_started", "run_finished", "run_resumed",
      "step_started", "step_completed", "step_failed", "step_skipped", "step_cached", "step_reset",
      "step_progress", "script_line",
      "agent_query", "agent_tool_call", "agent_result",
      "loop_iteration",
      "gate_opened", "gate_answered",
      "input_changed",
    ] as const satisfies readonly EventKind[];

    // The exhaustiveness half of the pin: `covered` owes one key per member of EventKind and can
    // only be built from the literals in `kinds`, so a kind added to the union without being
    // added to the list above fails to compile here rather than going quietly unpinned. The
    // `satisfies` above catches the other direction, a name in the list that is not a kind.
    const covered: Record<EventKind, true> = Object.fromEntries(
      kinds.map((k) => [k, true]),
    ) as Record<(typeof kinds)[number], true>;

    expect(kinds).toHaveLength(18);
    expect(new Set(kinds).size).toBe(18);
    expect(Object.keys(covered)).toHaveLength(18);
  });
});

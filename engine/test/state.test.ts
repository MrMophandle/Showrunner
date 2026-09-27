import { describe, it, expect } from "vitest";
import { deriveRunState } from "../src/state.js";
import type { Event } from "../src/events.js";

const ev = (kind: Event["kind"], stepId: string | undefined, payload: Record<string, unknown>, ts: string): Event =>
  stepId === undefined ? { ts, runId: "r", kind, payload } : { ts, runId: "r", stepId, kind, payload };

describe("deriveRunState", () => {
  it("is empty for no events", () => {
    const s = deriveRunState([]);
    expect(s.finished).toBe(false);
    expect(s.steps).toEqual({});
    expect(s.openGate).toBeUndefined();
  });

  it("tracks step outcomes, results, and the current position with progress", () => {
    const s = deriveRunState([
      ev("run_started", undefined, { pipeline: "p" }, "t0"),
      ev("step_started", "a", { kind: "guard" }, "t1"),
      ev("step_completed", "a", { result: "ok" }, "t2"),
      ev("step_started", "b", { kind: "script" }, "t3"),
      ev("step_progress", "b", { done: 3, total: 10, unit: "segments" }, "t4"),
    ]);
    expect(s.steps).toEqual({ a: "completed", b: "running" });
    expect(s.results).toEqual({ a: "ok" });
    expect(s.position).toEqual({ stepId: "b", startedAt: "t3", progress: { done: 3, total: 10, unit: "segments" } });
    expect(s.lastEventAt).toBe("t4");
    expect(s.finished).toBe(false);
  });

  it("distinguishes failed from skipped and marks the run finished", () => {
    const s = deriveRunState([
      ev("step_started", "a", {}, "t1"),
      ev("step_failed", "a", { error: "boom" }, "t2"),
      ev("step_skipped", "b", { reason: "dependency failed: a" }, "t3"),
      ev("run_finished", undefined, { status: "failed" }, "t4"),
    ]);
    expect(s.steps).toEqual({ a: "failed", b: "skipped" });
    expect(s.finished).toBe(true);
    expect(s.status).toBe("failed");
    expect(s.position).toBeUndefined();
  });

  it("exposes an open gate, then clears it and records the answer", () => {
    const opened = [
      ev("gate_opened", "g", { attempt: 1, message: "Look at this" }, "t1"),
    ];
    let s = deriveRunState(opened);
    expect(s.steps).toEqual({ g: "waiting" });
    expect(s.openGate).toEqual({ stepId: "g", attempt: 1, message: "Look at this", openedAt: "t1" });
    expect(s.gateAttempts).toEqual({ g: 1 });

    s = deriveRunState([...opened, ev("gate_answered", "g", { approved: true, notes: "fine" }, "t2")]);
    expect(s.openGate).toBeUndefined();
    expect(s.steps).toEqual({ g: "completed" });
    expect(s.results).toEqual({ g: { approved: true, notes: "fine" } });

    s = deriveRunState([...opened, ev("gate_answered", "g", { approved: false, notes: "redo" }, "t2")]);
    expect(s.openGate).toBeUndefined();
    expect(s.steps).toEqual({ g: "running" });
    expect(s.results).toEqual({});

    s = deriveRunState([
      ...opened,
      ev("gate_answered", "g", { approved: false, notes: "redo" }, "t2"),
      ev("gate_opened", "g", { attempt: 2, message: "Look again" }, "t3"),
    ]);
    expect(s.openGate?.attempt).toBe(2);
    expect(s.gateAttempts).toEqual({ g: 2 });
    expect(s.steps).toEqual({ g: "waiting" });
  });

  it("treats a cached step as completed", () => {
    const s = deriveRunState([ev("step_cached", "a", { result: 5 }, "t1")]);
    expect(s.steps).toEqual({ a: "completed" });
    expect(s.results).toEqual({ a: 5 });
  });
});

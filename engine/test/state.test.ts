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

  it("separates a bypassed step from a skipped one by the step_skipped reason", () => {
    const s = deriveRunState([
      ev("step_skipped", "a", { reason: "when: false" }, "t1"),
      ev("step_skipped", "b", { reason: "dependency failed: x" }, "t2"),
      ev("step_skipped", "c", {}, "t3"),
    ]);
    expect(s.steps).toEqual({ a: "bypassed", b: "skipped", c: "skipped" });
  });

  it("treats a cached step as completed and clears the position it held", () => {
    const s = deriveRunState([ev("step_cached", "a", { result: 5 }, "t1")]);
    expect(s.steps).toEqual({ a: "completed" });
    expect(s.results).toEqual({ a: 5 });

    const resumed = deriveRunState([ev("step_started", "a", {}, "t1"), ev("step_cached", "a", { result: 5 }, "t2")]);
    expect(resumed.position).toBeUndefined();
  });

  it("takes the run id from the first event", () => {
    expect(deriveRunState([ev("run_started", undefined, {}, "t0")]).runId).toBe("r");
    expect(deriveRunState([]).runId).toBe("");
  });

  it("clears the position and any open gate when the run finishes", () => {
    const s = deriveRunState([
      ev("step_started", "a", { kind: "script" }, "t1"),
      ev("run_finished", undefined, { status: "failed" }, "t2"),
    ]);
    expect(s.position).toBeUndefined();

    const withGate = deriveRunState([
      ev("gate_opened", "g", { attempt: 1, message: "m" }, "t1"),
      ev("run_finished", undefined, { status: "failed" }, "t2"),
    ]);
    expect(withGate.openGate).toBeUndefined();
    expect(withGate.finished).toBe(true);
  });

  it("clears an open gate when that gate's step fails", () => {
    const s = deriveRunState([
      ev("gate_opened", "g", { attempt: 1, message: "m" }, "t1"),
      ev("step_failed", "g", { error: "rejected 10 times" }, "t2"),
    ]);
    expect(s.openGate).toBeUndefined();
    expect(s.steps).toEqual({ g: "failed" });
  });

  it("ignores a step_progress for a step that is not the current position", () => {
    const s = deriveRunState([
      ev("step_started", "b", { kind: "script" }, "t1"),
      ev("step_progress", "a", { done: 9, total: 9, unit: "shots" }, "t2"),
    ]);
    expect(s.position).toEqual({ stepId: "b", startedAt: "t1" });
  });

  it("falls back to attempt 1 when the logged attempt is not a finite number", () => {
    const s = deriveRunState([ev("gate_opened", "g", { attempt: "not a number", message: "m" }, "t1")]);
    expect(s.openGate?.attempt).toBe(1);
    expect(s.gateAttempts).toEqual({ g: 1 });
  });
});

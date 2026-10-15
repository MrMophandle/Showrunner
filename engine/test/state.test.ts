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

  it("keeps a step in flight through a step_waiting, with the start time it already had", () => {
    // The agent executor sleeping out a plan usage limit. The step must read as neither completed
    // nor failed — a worker is still on it — and it must keep the startedAt from its step_started,
    // so "how long has this step been going" counts the wait rather than restarting at it.
    const s = deriveRunState([
      ev("step_started", "revise", { kind: "loop" }, "t1"),
      ev("step_progress", "revise", { done: 1, total: 3, unit: "passes" }, "t2"),
      ev("step_waiting", "revise", { reason: "waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)", window: "five_hour", ceiling: 65 }, "t3"),
    ]);
    expect(s.steps).toEqual({ revise: "running" });
    expect(s.position).toEqual({ stepId: "revise", startedAt: "t1", progress: { done: 1, total: 3, unit: "passes" } });
    expect(s.finished).toBe(false);

    // And a log whose step_started was lost to a crash between the two writes still reports the
    // step running rather than pending — the whole reason the case is written out. It gets no
    // position, which is the acknowledged cost of leaving position alone (ruling I-21): the Run
    // view's step altitude reads "nothing in flight" for that one log, while the run still reads
    // crashed, and the rail and the Board still draw the row.
    const orphan = deriveRunState([ev("step_waiting", "revise", { reason: "waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)" }, "t3")]);
    expect(orphan.steps).toEqual({ revise: "running" });
    expect(orphan.position).toBeUndefined();
  });

  it("leaves the position where it is when a step_waiting lands on a step that is not the position", () => {
    // The production configuration: the console runs the pipeline at --concurrency 7, and a plan
    // usage limit is account-wide, so every in-flight agent step hits it and each writes its own
    // step_waiting. `position` means "the last step to have *started*" in both places that
    // document it, and a wait is not a start — moving it would churn once per waiting step and
    // land on whichever executor emitted last, which names one wait at random (ruling I-21). The
    // step rail prints the reason on every waiting row, so no wait goes unnamed.
    const s = deriveRunState([
      ev("step_started", "draft-a", { kind: "agent" }, "t1"),
      ev("step_started", "draft-b", { kind: "agent" }, "t2"),
      ev("step_waiting", "draft-a", { reason: "waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)", window: "five_hour", resetsAt: "2026-10-14T23:50:00.000Z", ceiling: 65 }, "t3"),
    ]);
    expect(s.position).toEqual({ stepId: "draft-b", startedAt: "t2" });
    // Both steps are still in flight: the waiting one is asleep inside its executor and the other
    // is working, and neither is done.
    expect(s.steps).toEqual({ "draft-a": "running", "draft-b": "running" });
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
    // A rejected gate still records no answer under its own id; the note it carried is kept
    // under "g:rejections" instead, which is the only results key a rejection writes.
    expect(s.results).toEqual({ "g:rejections": ["redo"] });
    expect(s.results["g"]).toBeUndefined();

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

describe("step_reset and run_resumed", () => {
  const ev = (kind: string, stepId: string | undefined, payload: Record<string, unknown> = {}) =>
    ({ ts: "t", runId: "r", ...(stepId ? { stepId } : {}), kind: kind as Event["kind"], payload }) as Event;

  it("a step_reset returns the step to pending and drops its result", () => {
    const s = deriveRunState([
      ev("run_started", undefined), ev("step_started", "a"), ev("step_completed", "a", { result: "one" }),
      ev("step_reset", "a", { by: "g", attempt: 1 }),
    ]);
    expect(s.steps["a"]).toBeUndefined();
    expect(s.results["a"]).toBeUndefined();
  });

  it("a run_resumed reopens a failed run: failed and skipped steps become pending, bypassed and completed stay", () => {
    const s = deriveRunState([
      ev("run_started", undefined), ev("step_started", "a"), ev("step_completed", "a"),
      ev("step_started", "b"), ev("step_failed", "b", { error: "boom" }),
      ev("step_skipped", "c", { reason: "dependency failed: b" }), ev("step_skipped", "d", { reason: "when: false" }),
      ev("run_finished", undefined, { status: "failed" }),
      ev("run_resumed", undefined, { by: "operator" }),
    ]);
    expect(s.finished).toBe(false);
    expect(s.status).toBeUndefined();
    expect(s.steps).toEqual({ a: "completed", d: "bypassed" });
  });

  it("keeps every rejection note of a gate under <id>:rejections, in order", () => {
    const s = deriveRunState([
      ev("run_started", undefined),
      ev("gate_opened", "g", { attempt: 1, message: "m" }), ev("gate_answered", "g", { approved: false, notes: "first" }),
      ev("gate_opened", "g", { attempt: 2, message: "m" }), ev("gate_answered", "g", { approved: false, notes: "second" }),
      ev("gate_opened", "g", { attempt: 3, message: "m" }), ev("gate_answered", "g", { approved: true }),
    ]);
    expect(s.results["g:rejections"]).toEqual(["first", "second"]);
    expect(s.steps["g"]).toBe("completed");
  });
});

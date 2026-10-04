import { describe, it, expect } from "vitest";
import { appendFile, rm } from "node:fs/promises";
import { EventLog, episodePipeline, loadShowConfig, pipelineHash } from "@showrunner/engine";
import type { SseMessage } from "../shared/types.js";
import { appWith, ENGINE_ROOT, makeShow, seedRun, waitFor, writeIn, writeLock } from "./helpers.js";

describe("RunStore", () => {
  it("tails a log incrementally and publishes a change per append", async () => {
    const { root, store } = await appWith(await makeShow());
    const seen: SseMessage[] = []; store.subscribe((m) => seen.push(m));
    await store.watch();
    const log = new EventLog(EventLog.logPath(root, "s02e01", "20261002T100000Z-ab12"));
    await log.append({ runId: "20261002T100000Z-ab12", kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } });
    await waitFor(() => seen.some((m) => m.type === "run"));
    const first = await store.get("s02e01", "20261002T100000Z-ab12");
    expect(first.events.map((e) => e.kind)).toEqual(["run_started"]);
    await log.append({ runId: "20261002T100000Z-ab12", stepId: "premise", kind: "step_started", payload: { kind: "guard" } });
    await waitFor(async () => (await store.get("s02e01", "20261002T100000Z-ab12")).events.length === 2);
    expect(seen.filter((m) => m.type === "run").length).toBeGreaterThanOrEqual(2);
    store.close();
  });

  it("picks up a runs directory that appears after watch(), and publishes episodes on a lock", async () => {
    const { root, store } = await appWith(await makeShow(), { pollMs: 50 });
    const seen: SseMessage[] = []; store.subscribe((m) => seen.push(m));
    await store.watch();
    // s02e02 has no Production directory at all when watch() runs: only the poll can find it.
    await writeIn(root, "Episodes/s02e02/premise.md", "Another week.\n");
    await seedRun(root, "s02e02", "r1", [{ kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e02" } }]);
    await waitFor(() => seen.some((m) => m.type === "run" && m.episodeId === "s02e02"));
    expect((await store.get("s02e02", "r1")).events).toHaveLength(1);
    // A lock appearing beside the log is a Board fact, not a log one: there is nothing new to
    // read, and yet every row's status may have changed, since the lock is what "running" means.
    const before = seen.filter((m) => m.type === "episodes").length;
    await writeIn(root, "Production/s02e02/runs/r1.lock", JSON.stringify({ pid: process.pid, startedAt: "t", heartbeatAt: "t", groups: [] }));
    await waitFor(() => seen.filter((m) => m.type === "episodes").length > before);
    store.close();
  });

  it("re-reads a log that was truncated under it rather than appending to a stale history", async () => {
    const { root, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: {} }, { stepId: "premise", kind: "step_started", payload: {} }, { stepId: "premise", kind: "step_completed", payload: {} },
    ]);
    expect((await store.get("s02e01", "r1")).events).toHaveLength(3);
    await seedRun(root, "s02e01", "r1", [{ kind: "run_started", payload: {} }]);
    const after = await store.get("s02e01", "r1");
    expect(after.events.map((e) => e.kind)).toEqual(["run_started"]);
    store.close();
  });

  it("projects a RunView: steps in pipeline order with kinds joined, the position, a progress rate, and the dead-iteration flag", async () => {
    const { root, store } = await appWith(await makeShow());
    const t = (s: number) => new Date(Date.UTC(2026, 9, 2, 10, 0, s)).toISOString();
    await seedRun(root, "s02e01", "r1", [
      { ts: t(0), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01", pipelineHash: "abc", engineVersion: "0.0.1" } },
      { ts: t(1), stepId: "previous-episode", kind: "step_started", payload: { kind: "guard" } }, { ts: t(1), stepId: "previous-episode", kind: "step_completed", payload: { result: "ok" } },
      { ts: t(2), stepId: "premise", kind: "step_started", payload: { kind: "guard" } }, { ts: t(2), stepId: "premise", kind: "step_completed", payload: {} },
      { ts: t(3), stepId: "outline", kind: "step_started", payload: { kind: "agent" } }, { ts: t(9), stepId: "outline", kind: "step_completed", payload: { toolCalls: 4 } },
      { ts: t(10), stepId: "draft", kind: "step_started", payload: { kind: "loop", body: "draft-body", until: "DRAFT_COMPLETE", max: 15 } },
      { ts: t(20), stepId: "draft", kind: "loop_iteration", payload: { iteration: 1, max: 15, sentinel: false, toolCalls: 5 } },
      { ts: t(20), stepId: "draft", kind: "step_progress", payload: { done: 1, total: 12, unit: "scenes" } },
      { ts: t(24), stepId: "draft", kind: "loop_iteration", payload: { iteration: 2, max: 15, sentinel: false, toolCalls: 0 } },
      { ts: t(24), stepId: "draft", kind: "step_progress", payload: { done: 1, total: 12, unit: "scenes" } },
      { ts: t(40), stepId: "draft", kind: "loop_iteration", payload: { iteration: 3, max: 15, sentinel: false, toolCalls: 6 } },
      { ts: t(40), stepId: "draft", kind: "step_progress", payload: { done: 2, total: 12, unit: "scenes" } },
    ]);
    // A run with a step in flight has a worker holding it: the lock is what makes this log's
    // "running" honest, and without it the same log is a crash (asserted below).
    const lock = await writeLock(root, "s02e01", "r1", process.pid);
    const v = await store.view("s02e01", "r1");
    expect(v.status).toBe("running");
    expect(v.worker).toMatchObject({ pid: process.pid, alive: true });
    expect(v.position).toEqual({ stepId: "draft", startedAt: t(10) });
    expect(v.steps.map((s) => s.id).slice(0, 4)).toEqual(["previous-episode", "bible-ready", "premise", "outline"]);
    expect(v.steps.find((s) => s.id === "outline")).toMatchObject({ kind: "agent", status: "completed", startedAt: t(3), endedAt: t(9), toolCalls: 4 });
    const draft = v.steps.find((s) => s.id === "draft")!;
    expect(draft.status).toBe("running");
    expect(draft.progress).toMatchObject({ done: 2, total: 12, unit: "scenes" });
    expect(draft.progress?.ratePerSec).toBeCloseTo(1 / 20, 3);          // 1 scene over the 20 s between the last two progress events
    expect(draft.progress?.etaSec).toBeCloseTo(200, 0);
    expect(draft.flag).toBe("did-nothing");                              // iteration 2: toolCalls 0, no error
    // The logged pipeline beside the pipeline the code builds today: "abc" is not the current
    // hash, so `changed` is true, which is the "this run is older than the code" answer the Run
    // page prints beside the run's own hash.
    expect(v.pipeline).toMatchObject({ name: "episode", hash: "abc", engineVersion: "0.0.1", changed: true });
    expect(v.pipeline.hashNow).toMatch(/^[0-9a-f]{64}$/);
    expect(v.steps.length).toBe(74);
    // A step the log never mentions still has a row, which is what makes the count the
    // pipeline's rather than the log's.
    expect(v.steps.find((s) => s.id === "hand-edits-outline")).toEqual({ id: "hand-edits-outline", kind: "guard", status: "pending" });

    // The same log with no worker holding it is a crash, not a run in progress: one worker owns
    // one run, taking the lock before run() and removing it in finally, so a log whose last word
    // on `draft` is step_started with no live lock is a killed worker or a rejected run().
    await rm(lock);
    const abandoned = await store.view("s02e01", "r1");
    expect(abandoned.status).toBe("crashed");
    expect(abandoned.worker).toBeUndefined();
    expect(abandoned.position).toEqual({ stepId: "draft", startedAt: t(10) });
    store.close();
  });

  it("reads a finished run as completed, a reset step as pending again, and a bypassed step as bypassed", async () => {
    const { root, store } = await appWith(await makeShow());
    const t = (s: number) => new Date(Date.UTC(2026, 9, 2, 11, 0, s)).toISOString();
    await seedRun(root, "s02e01", "r2", [
      { ts: t(0), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { ts: t(1), stepId: "outline", kind: "step_started", payload: { kind: "agent" } }, { ts: t(2), stepId: "outline", kind: "step_completed", payload: { result: "drafted" } },
      { ts: t(3), stepId: "outline-revise", kind: "step_skipped", payload: { reason: "when: false" } },
      { ts: t(4), stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "approve the outline" } },
      { ts: t(5), stepId: "outline-gate", kind: "gate_answered", payload: { approved: false, notes: "beat 3 is thin", by: "console:test" } },
      { ts: t(6), stepId: "outline", kind: "step_reset", payload: { by: "outline-gate" } },
      { ts: t(7), stepId: "canon-commit", kind: "step_started", payload: { kind: "script" } }, { ts: t(8), stepId: "canon-commit", kind: "step_completed", payload: {} },
      { ts: t(9), kind: "run_finished", payload: { status: "completed" } },
    ]);
    const v = await store.view("s02e01", "r2");
    expect(v.status).toBe("completed");
    expect(v.stage).toBe("COMPLETE");
    expect(v.startedAt).toBe(t(0));
    expect(v.finishedAt).toBe(t(9));
    expect(v.position).toBeUndefined();
    expect(v.openGate).toBeUndefined();
    // A reset step is pending again and carries no end, no error and no result: its work was
    // invalidated by the gate's rejection, so nothing about the attempt survives but its start.
    const outline = v.steps.find((s) => s.id === "outline")!;
    expect(outline.status).toBe("pending");
    expect(outline).not.toHaveProperty("endedAt");
    expect(outline).not.toHaveProperty("result");
    expect(outline.startedAt).toBe(t(1));
    expect(v.steps.find((s) => s.id === "outline-revise")?.status).toBe("bypassed");
    expect(v.steps.find((s) => s.id === "canon-commit")?.status).toBe("completed");
    store.close();
  });

  it("reports no pipeline change when the run recorded the hash the code builds today", async () => {
    const { root, store } = await appWith(await makeShow());
    const hash = pipelineHash(episodePipeline({
      show: await loadShowConfig(root), episodeId: "s02e01", engineRoot: ENGINE_ROOT,
    }));
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01", pipelineHash: hash } },
    ]);
    const v = await store.view("s02e01", "r1");
    expect(v.pipeline.hashNow).toBe(hash);
    expect(v.pipeline.changed).toBe(false);
    // A log that recorded no hash has nothing to compare, and a mismatch is not invented from an
    // absent value.
    await seedRun(root, "s02e01", "r2", [{ kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } }]);
    const old = await store.view("s02e01", "r2");
    expect(old.pipeline.hash).toBeUndefined();
    expect(old.pipeline.changed).toBe(false);
    store.close();
  });

  it("carries a crashed run's worker log on the view, which is the only account of a rejected run()", async () => {
    const { root, store } = await appWith(await makeShow());
    // A step in flight with no lock: a `run()` that rejected, whose `finally` removed the lock.
    // Ruling F-09 says the Run view shows the worker's exit, and this file is all there is of it.
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "render", kind: "step_started", payload: { kind: "script" } },
    ]);
    await writeIn(root, "Production/s02e01/runs/r1.worker.log",
      "2026-10-02T10:00:00.000Z pid 4821: run() rejected: Error: log write failed: ENOSPC\n    at EventLog.append\n");
    const v = await store.view("s02e01", "r1");
    expect(v.status).toBe("crashed");
    expect(v.workerExit).toContain("run() rejected");
    expect(v.workerExit).toContain("ENOSPC");

    // A run that is not crashed does not carry it, and a crash with no worker log says nothing
    // rather than inventing a reason.
    await seedRun(root, "s02e01", "r2", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "render", kind: "step_started", payload: { kind: "script" } },
    ]);
    expect((await store.view("s02e01", "r2")).workerExit).toBeUndefined();
    store.close();
  });

  it("reports a log it could not read past a byte, and keeps projecting the good prefix", async () => {
    const { root, store } = await appWith(await makeShow());
    const t = (s: number) => new Date(Date.UTC(2026, 9, 2, 12, 0, s)).toISOString();
    const file = await seedRun(root, "s02e01", "r1", [
      { ts: t(0), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { ts: t(1), stepId: "previous-episode", kind: "step_started", payload: { kind: "guard" } },
      { ts: t(2), stepId: "previous-episode", kind: "step_completed", payload: { result: "ok" } },
    ]);
    const before = await store.view("s02e01", "r1");
    expect(before.logError).toBeUndefined();
    expect(before.steps.find((s) => s.id === "previous-episode")?.status).toBe("completed");

    // A complete line that is not JSON — a crash mid-write, ENOSPC, or any second writer. Without
    // `lastError` this run's Board row and rail freeze here for the life of the server and say so
    // nowhere.
    await appendFile(file, "{not json}\n", "utf8");
    const after = await store.view("s02e01", "r1");
    expect(after.logError).toMatch(/^this run's log could not be read past byte \d+: /);
    expect(after.logError).toContain("malformed JSON");
    // The status and the rail still come from the bytes before the bad one.
    expect(after.steps.find((s) => s.id === "previous-episode")?.status).toBe("completed");
    expect(after.lastEventAt).toBe(t(2));
    const row = await store.episodeRow("s02e01");
    expect(row.logError).toBe(after.logError);
    store.close();
  });
});

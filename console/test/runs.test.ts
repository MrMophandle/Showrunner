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
    // Every notice names the show it is about: one channel carries every registered show, and two
    // shows each holding an s02e01 would otherwise be indistinguishable on the wire (ruling H-12).
    expect(seen.find((m) => m.type === "run")).toMatchObject({ show: "show", episodeId: "s02e01", runId: "20261002T100000Z-ab12" });
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
    expect(seen.find((m) => m.type === "episodes")).toEqual({ type: "episodes", show: "show" });
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
    expect(v.steps.length).toBe(68);
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

  it("projects step_waiting as a waiting step carrying the reason, keeps the run running while the lock is alive, and clears the note when the retry starts and when the step finishes", async () => {
    const { root, store } = await appWith(await makeShow());
    const t = (s: number) => new Date(Date.UTC(2026, 9, 2, 13, 0, s)).toISOString();
    // The event Plan I's engine writes before the worker sleeps: the operator sentence, the
    // window, the reset's own ISO, the weekly figure that cleared the ceiling, and the ceiling.
    const RESETS = "2026-10-02T23:50:00.000Z";
    const REASON = "waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)";
    // The measured shape (plan, "What was measured"): a revise loop that drafted some of the
    // episode and then hit the limit on an iteration.
    const file = await seedRun(root, "s02e01", "r1", [
      { ts: t(0), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { ts: t(1), stepId: "draft", kind: "step_started", payload: { kind: "loop", body: "draft-body", until: "DRAFT_COMPLETE", max: 15 } },
      { ts: t(1), stepId: "draft", kind: "loop_iteration", payload: { iteration: 1, max: 15, sentinel: false, toolCalls: 48 } },
      // The second iteration called no tool, which is the one judgment a row carries that the log
      // does not state outright. It is seeded here because the guard that keeps a waiting step's
      // progress also keeps its flag (ruling I-15), and a seed whose only iteration did 48 tool
      // calls can never prove the flag half of it.
      { ts: t(1), stepId: "draft", kind: "loop_iteration", payload: { iteration: 2, max: 15, sentinel: false, toolCalls: 0 } },
      { ts: t(1), stepId: "draft", kind: "step_progress", payload: { done: 4, total: 12, unit: "scenes" } },
      { ts: t(2), stepId: "draft", kind: "step_waiting", payload: { reason: REASON, window: "five_hour", resetsAt: RESETS, weeklyUtilization: 41, ceiling: 65 } },
    ]);
    await writeLock(root, "s02e01", "r1", process.pid);
    const v = await store.view("s02e01", "r1");
    // **The run is running, and that is the point of the lock.** The wait happens inside the
    // worker with the lock's heartbeat going (spec §4.2), and `step_waiting` opens no gate — so
    // rule 2 of `deriveRunStatus` does not fire and rule 3 answers "running". A run reported as
    // "waiting" here would offer the operator a gate move for a gate that does not exist.
    expect(v.status).toBe("running");
    expect(v.openGate).toBeUndefined();
    expect(v.position).toEqual({ stepId: "draft", startedAt: t(1) });
    const waiting = v.steps.find((s) => s.id === "draft")!;
    expect(waiting).toMatchObject({ kind: "loop", status: "waiting", note: REASON, waitingUntil: RESETS, startedAt: t(1) });
    // The step has not ended: it is asleep inside one agent-executor call and will be re-run.
    expect(waiting).not.toHaveProperty("endedAt");
    // What the run had got through before it stopped survives the wait — the one thing worth
    // knowing before deciding whether to sit out a five-hour window.
    expect(waiting.progress).toMatchObject({ done: 4, total: 12, unit: "scenes" });
    expect(waiting.flag).toBe("did-nothing");
    // The Board's row carries both, which is what the line under the stage chip and the tab
    // title are drawn from — neither can read a step row.
    const row = await store.episodeRow("s02e01");
    expect(row.status).toBe("running");
    expect(row.waitingNote).toBe(REASON);
    expect(row.waitingUntil).toBe(RESETS);

    // **The sleep ends at the retry's agent_query, not at the step's terminal event.** The
    // executor emits it the moment the sleep is over and then runs a full query — 447 s in the
    // measured case — and every surface that draws the wait reads this row, so a note left
    // standing through that query would tell the operator the console is asleep while it is
    // working, with a reset time already in the past in the tab title.
    await appendFile(file, `${JSON.stringify({ ts: t(3), runId: "r1", stepId: "draft", kind: "agent_query", payload: { promptFile: "draft.md", model: "m", resumed: true } })}\n`, "utf8");
    const resumed = await store.view("s02e01", "r1");
    const retrying = resumed.steps.find((s) => s.id === "draft")!;
    expect(retrying.status).toBe("running");
    expect(retrying).not.toHaveProperty("note");
    expect(retrying).not.toHaveProperty("waitingUntil");
    // What the run had got through is still drawn: the step never ended, so its progress and its
    // flag are the same ones the wait kept.
    expect(retrying.progress).toMatchObject({ done: 4, total: 12, unit: "scenes" });
    expect(retrying.flag).toBe("did-nothing");
    const retryingRow = await store.episodeRow("s02e01");
    expect(retryingRow.waitingNote).toBeUndefined();
    expect(retryingRow.waitingUntil).toBeUndefined();

    // And the step's own terminal event clears it too, for the same reason one step further on: a
    // completed step still saying "waiting for the usage limit to reset at 7:50pm" is the rail
    // stating, in the operator's own words, something that stopped being true an hour ago.
    await appendFile(file, `${JSON.stringify({ ts: t(4), runId: "r1", stepId: "draft", kind: "step_completed", payload: { result: "drafted", toolCalls: 7 } })}\n`, "utf8");
    const after = await store.view("s02e01", "r1");
    const done = after.steps.find((s) => s.id === "draft")!;
    expect(done).toMatchObject({ status: "completed", endedAt: t(4), toolCalls: 7 });
    expect(done).not.toHaveProperty("note");
    expect(done).not.toHaveProperty("waitingUntil");
    const afterRow = await store.episodeRow("s02e01");
    expect(afterRow.waitingNote).toBeUndefined();
    expect(afterRow.waitingUntil).toBeUndefined();
    store.close();
  });

  it("leaves a gate's waiting row alone when its fix agent queries", async () => {
    // The other `waiting`: a gate open on the step, which carries no note. Its fix agent writes an
    // agent_query against that very row on the next attempt, and the row must stay `waiting` — the
    // gate is still open and the Board still has to offer the answer. This is why the agent_query
    // case is guarded on the note rather than written unconditionally.
    const { root, store } = await appWith(await makeShow());
    const t = (s: number) => new Date(Date.UTC(2026, 9, 2, 14, 0, s)).toISOString();
    await seedRun(root, "s02e01", "r2", [
      { ts: t(0), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { ts: t(1), stepId: "outline-gate", kind: "step_started", payload: { kind: "gate" } },
      { ts: t(2), stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "the outline is ready" } },
      { ts: t(3), stepId: "outline-gate", kind: "agent_query", payload: { promptFile: "fix.md", model: "m", resumed: false } },
    ]);
    const v = await store.view("s02e01", "r2");
    const gate = v.steps.find((s) => s.id === "outline-gate")!;
    expect(gate.status).toBe("waiting");
    expect(gate).not.toHaveProperty("note");
    expect(v.openGate?.stepId).toBe("outline-gate");
    store.close();
  });
});

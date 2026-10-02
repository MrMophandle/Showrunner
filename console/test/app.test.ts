import { describe, it, expect } from "vitest";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { RUN_ID } from "@showrunner/engine";
import type { EventBatch, EpisodeRow, RunView } from "../shared/types.js";
import { appWith, makeShow, seedRun, waitFor, writeIn, writeLock } from "./helpers.js";

describe("the read routes", () => {
  it("GET /api/show names the show and the operator", async () => {
    const { app, store } = await appWith(await makeShow());
    const res = await app.request("/api/show");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ showName: "Harbor Light", operator: "console:test" });
    store.close();
  });

  it("GET /api/episodes lists every episode of the show, sorted", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e03/premise.md", "A dive.\n");
    await mkdir(path.join(root, "Production", "s02e02", "runs"), { recursive: true });
    const res = await app.request("/api/episodes");
    expect(res.status).toBe(200);
    const rows = await res.json() as EpisodeRow[];
    expect(rows.map((r) => r.id)).toEqual(["s02e01", "s02e02", "s02e03"]);
    expect(rows.every((r) => r.status === "none")).toBe(true);
    store.close();
  });

  it("GET /api/episodes/:id returns the row, and refuses an id that is not one", async () => {
    const { app, store } = await appWith(await makeShow());
    expect((await app.request("/api/episodes/s02e01")).status).toBe(200);
    const bad = await app.request("/api/episodes/zz");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.stringContaining("invalid episode id") });
    store.close();
  });

  it("GET /api/episodes/:id/runs/:run returns the view, and refuses a run id that is not one", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline", kind: "step_started", payload: { kind: "agent" } },
    ]);
    const res = await app.request("/api/episodes/s02e01/runs/r1");
    expect(res.status).toBe(200);
    const view = await res.json() as RunView;
    expect(view).toMatchObject({ episodeId: "s02e01", runId: "r1", pipeline: { name: "episode" } });
    expect(view.steps.length).toBe(73);
    expect(view.offset).toBeGreaterThan(0);
    expect((await app.request("/api/episodes/s02e01/runs/bad.id")).status).toBe(400);
    store.close();
  });

  it("GET /api/episodes/:id/runs/:run/events?after=<offset> returns only what is new", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline", kind: "step_started", payload: { kind: "agent" } },
      { stepId: "outline", kind: "step_completed", payload: { toolCalls: 2 } },
    ]);
    const first = await (await app.request("/api/episodes/s02e01/runs/r1/events?after=0")).json() as EventBatch;
    expect(first.events.map((e) => e.kind)).toEqual(["run_started", "step_started", "step_completed"]);
    expect(first.offset).toBeGreaterThan(0);
    const second = await (await app.request(`/api/episodes/s02e01/runs/r1/events?after=${first.offset}`)).json() as EventBatch;
    expect(second.events).toEqual([]);
    expect(second.offset).toBe(first.offset);
    expect((await app.request("/api/episodes/s02e01/runs/r1/events?after=-1")).status).toBe(400);
    store.close();
  });

  it("GET /api/events opens the SSE channel with a hello", async () => {
    const { app, store } = await appWith(await makeShow());
    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("data: ");
    expect(JSON.parse(chunk.slice(chunk.indexOf("{"), chunk.lastIndexOf("}") + 1))).toEqual({ type: "hello", operator: "console:test", showName: "Harbor Light" });
    await reader.cancel();
    store.close();
  });
});

/** The write side. Every action is one engine append and one detached worker, in that order, and
 *  every refusal carries the message the engine or the spawner worded — the 409 body is what the
 *  operator reads, so these tests assert the text and not only the status. */
describe("the actions", () => {
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /** The run's log as text, for a test that waits on a detached worker's write. */
  async function logText(root: string, runId: string, episodeId = "s02e01"): Promise<string> {
    try { return await readFile(path.join(root, "Production", episodeId, "runs", `${runId}.jsonl`), "utf8"); } catch { return ""; }
  }

  /** The events of a run's log, parsed. */
  async function logEvents(root: string, runId: string, episodeId = "s02e01"): Promise<Array<{ stepId?: string; kind: string; payload: Record<string, unknown> }>> {
    const text = await logText(root, runId, episodeId);
    return text.trim() === "" ? [] : text.trim().split("\n").map((l) => JSON.parse(l) as { stepId?: string; kind: string; payload: Record<string, unknown> });
  }

  it("POST /api/episodes writes the premise once, and refuses a second one", async () => {
    const { root, app, store } = await appWith(await makeShow());
    const made = await app.request("/api/episodes", json({ id: "s02e05", premise: "A week." }));
    expect(made.status).toBe(200);
    expect(await made.json()).toEqual({ id: "s02e05" });
    expect(await readFile(path.join(root, "Episodes", "s02e05", "premise.md"), "utf8")).toBe("A week.\n");
    // Nothing under Production/ — an episode that has never run has no run directory.
    await expect(stat(path.join(root, "Production", "s02e05"))).rejects.toThrow();

    const again = await app.request("/api/episodes", json({ id: "s02e05", premise: "A different week." }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: expect.stringContaining("already exists") });
    expect(await readFile(path.join(root, "Episodes", "s02e05", "premise.md"), "utf8")).toBe("A week.\n");

    const bad = await app.request("/api/episodes", json({ id: "nope", premise: "A week." }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.stringContaining("invalid episode id") });
    expect((await app.request("/api/episodes", json({ id: "s02e06" }))).status).toBe(400);
    store.close();
  });

  it("POST /api/episodes/:id/runs mints a run and spawns a worker that writes run_started", async () => {
    const { root, app, store } = await appWith(await makeShow());
    const res = await app.request("/api/episodes/s02e01/runs", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { runId: string; pid: number };
    expect(body.runId).toMatch(RUN_ID);
    expect(body.pid).toBeGreaterThan(0);
    await waitFor(async () => (await logText(root, body.runId)).includes("run_started"), 2000);
    const events = await logEvents(root, body.runId);
    expect(events[0]).toMatchObject({ kind: "run_started" });
    expect(events[0]?.payload["trigger"]).toBe("console:test");
    store.close();
  });

  it("POST /api/episodes/:id/runs refuses while a worker holds the latest run", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [{ kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } }]);
    await writeLock(root, "s02e01", "r1", process.pid);
    const res = await app.request("/api/episodes/s02e01/runs", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: `run r1 is held by pid ${process.pid}` });
    store.close();
  });

  it("POST /api/episodes/:id/runs refuses while a gate is open on the latest run", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "approve it" } },
    ]);
    const res = await app.request("/api/episodes/s02e01/runs", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "answer the gate on run r1 first" });
    store.close();
  });

  it("answers a gate: a stale attempt is refused, the right one is stamped with the operator", async () => {
    const { root, app, store } = await appWith(await makeShow());
    process.env["FAKE_WORKER_GATE"] = "outline-gate";
    let runId = "";
    try {
      const launched = await app.request("/api/episodes/s02e01/runs", { method: "POST" });
      expect(launched.status).toBe(200);
      runId = (await launched.json() as { runId: string }).runId;
      await waitFor(async () => (await logText(root, runId)).includes("gate_opened"), 4000);

      const view = await app.request(`/api/episodes/s02e01/runs/${runId}/gate`);
      expect(view.status).toBe(200);
      expect(await view.json()).toMatchObject({ stepId: "outline-gate", attempt: 1, episodeId: "s02e01", runId });

      const stale = await app.request(`/api/episodes/s02e01/runs/${runId}/gate`, json({ stepId: "outline-gate", approved: true, notes: "", expectedAttempt: 2 }));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: 'gate "outline-gate" is open at attempt 1, not 2' });

      const early = await app.request(`/api/episodes/s02e01/runs/${runId}/reset`, json({ stepIds: ["outline"] }));
      expect(early.status).toBe(409);
      expect(await early.json()).toMatchObject({ error: expect.stringContaining("is open; answer it or withdraw, not reset") });
    } finally {
      delete process.env["FAKE_WORKER_GATE"];
    }

    const ok = await app.request(`/api/episodes/s02e01/runs/${runId}/gate`, json({ stepId: "outline-gate", approved: true, notes: "ship it", expectedAttempt: 1 }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ runId, pid: expect.any(Number) });
    const answered = (await logEvents(root, runId)).find((e) => e.kind === "gate_answered");
    expect(answered).toMatchObject({ stepId: "outline-gate" });
    expect(answered?.payload).toMatchObject({ approved: true, notes: "ship it", by: "console:test", attempt: 1 });
    expect((await app.request(`/api/episodes/s02e01/runs/${runId}/gate`)).status).toBe(404);
    store.close();
  });

  it("POST …/resume refuses a run that is not failed", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { kind: "run_finished", payload: { status: "completed" } },
    ]);
    const res = await app.request("/api/episodes/s02e01/runs/r1/resume", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "run r1 is not failed, so there is nothing to resume" });
    store.close();
  });

  it("POST …/resume reopens a failed run and spawns", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "render", kind: "step_failed", payload: { error: "the NAS was not mounted" } },
      { kind: "run_finished", payload: { status: "failed" } },
    ]);
    const res = await app.request("/api/episodes/s02e01/runs/r1/resume", { method: "POST" });
    expect(res.status).toBe(200);
    const resumed = (await logEvents(root, "r1")).find((e) => e.kind === "run_resumed");
    expect(resumed?.payload["by"]).toBe("console:test");
    store.close();
  });

  it("POST …/reset returns the steps it reset, in pipeline order", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline", kind: "step_completed", payload: { result: "ok" } },
      { stepId: "draft", kind: "step_completed", payload: { result: "ok" } },
    ]);
    const res = await app.request("/api/episodes/s02e01/runs/r1/reset", json({ stepIds: ["outline"] }));
    expect(res.status).toBe(200);
    const body = await res.json() as { runId: string; pid: number; reset: string[] };
    expect(body.reset).toEqual(["outline", "draft"]);
    const resets = (await logEvents(root, "r1")).filter((e) => e.kind === "step_reset");
    expect(resets.map((e) => e.stepId)).toEqual(["outline", "draft"]);
    expect((await app.request("/api/episodes/s02e01/runs/r1/reset", json({ stepIds: [] }))).status).toBe(400);
    store.close();
  });

  it("POST …/withdraw rejects an approval the showrunner already gave", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "approve it" } },
      { stepId: "outline-gate", kind: "gate_answered", payload: { approved: true, attempt: 1, by: "console:test" } },
      { stepId: "stamp-outline", kind: "step_completed", payload: { result: "ok" } },
      { kind: "run_finished", payload: { status: "completed" } },
    ]);
    const res = await app.request("/api/episodes/s02e01/runs/r1/withdraw", json({ stepId: "outline-gate", notes: "the cast list is wrong" }));
    expect(res.status).toBe(200);
    const events = await logEvents(root, "r1");
    const withdrawn = events.filter((e) => e.kind === "gate_answered").at(-1);
    expect(withdrawn?.payload).toMatchObject({ approved: false, withdrawn: true, notes: "the cast list is wrong", by: "console:test" });
    expect(events.filter((e) => e.kind === "step_reset").map((e) => e.stepId)).toEqual(["stamp-outline"]);
    // A gate that was never approved cannot be withdrawn.
    const nope = await app.request("/api/episodes/s02e01/runs/r1/withdraw", json({ stepId: "script-gate", notes: "no" }));
    expect(nope.status).toBe(409);
    store.close();
  });

  it("POST …/continue replays a crashed run, and refuses one that is finished or waiting", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "render", kind: "step_started", payload: { kind: "script" } },
    ]);
    // A stale lock that recorded a process group: the group is signalled before the worker starts.
    await writeLock(root, "s02e01", "r1", 999_999, [1]);
    const res = await app.request("/api/episodes/s02e01/runs/r1/continue", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId: "r1", pid: expect.any(Number) });

    await seedRun(root, "s02e01", "r2", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { kind: "run_finished", payload: { status: "completed" } },
    ]);
    const done = await app.request("/api/episodes/s02e01/runs/r2/continue", { method: "POST" });
    expect(done.status).toBe(409);
    expect(await done.json()).toMatchObject({ error: expect.stringContaining("is finished") });

    await seedRun(root, "s02e01", "r3", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "approve it" } },
    ]);
    const waiting = await app.request("/api/episodes/s02e01/runs/r3/continue", { method: "POST" });
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toMatchObject({ error: expect.stringContaining("answer the gate") });
    store.close();
  });

  it("GET …/context and POST …/ask answer from the run's log", async () => {
    const { root, app, store } = await appWith(await makeShow(), {
      query: async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "It stopped at render." }] } };
        yield { type: "result", subtype: "success", result: "It stopped at render.", total_cost_usd: 0.5 };
      },
    });
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "render", kind: "step_failed", payload: { error: "the NAS was not mounted" } },
    ]);
    const context = await app.request("/api/episodes/s02e01/runs/r1/context");
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({ pipeline: { name: "episode" }, run: { runId: "r1" }, outputs: [] });

    const answered = await app.request("/api/episodes/s02e01/runs/r1/ask", json({ question: "What happened?" }));
    expect(answered.status).toBe(200);
    expect(answered.headers.get("content-type")).toContain("text/plain");
    expect(await answered.text()).toBe("It stopped at render.");
    expect((await app.request("/api/episodes/s02e01/runs/r1/ask", json({}))).status).toBe(400);
    const rows = (await readFile(path.join(root, "Production", "s02e01", "runs", "r1.troubleshooting.jsonl"), "utf8")).trim().split("\n");
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!)).toMatchObject({ question: "What happened?", answer: "It stopped at render.", by: "console:test" });
    store.close();
  });

  it("refuses an action on an id or a run id that is not one", async () => {
    const { app, store } = await appWith(await makeShow());
    expect((await app.request("/api/episodes/zz/runs", { method: "POST" })).status).toBe(400);
    expect((await app.request("/api/episodes/s02e01/runs/bad.id/resume", { method: "POST" })).status).toBe(400);
    expect((await app.request("/api/episodes/s02e01/runs/r1/gate", json({ stepId: "", approved: true }))).status).toBe(400);
    store.close();
  });
});

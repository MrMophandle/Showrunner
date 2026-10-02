import { describe, it, expect } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { EventBatch, EpisodeRow, RunView } from "../shared/types.js";
import { appWith, makeShow, seedRun, writeIn } from "./helpers.js";

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

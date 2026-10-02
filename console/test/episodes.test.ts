import { describe, it, expect } from "vitest";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { appWith, makeShow, seedRun, writeIn, writeLock } from "./helpers.js";

describe("episodeRow", () => {
  it("reads an episode with a premise and no run as IDEA, and one without a premise as NEEDS_IDEA", async () => {
    const { root, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e03/premise.md", "A dive at slack water.\n");
    await mkdir(path.join(root, "Episodes", "s02e04"), { recursive: true });
    expect(await store.episodeRow("s02e03")).toMatchObject({ id: "s02e03", stage: "IDEA", status: "none", title: "s02e03" });
    expect((await store.episodeRow("s02e03")).runId).toBeUndefined();
    expect(await store.episodeRow("s02e04")).toMatchObject({ stage: "NEEDS_IDEA", status: "none", needs: { ideaMissing: true, refsMissing: [], imagesMissing: [] } });
    store.close();
  });

  it("reads a run parked at outline-gate as waiting in DRAFT_OUTLINE, with the title from the outline", async () => {
    const { root, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e01/outline.md", "# The Long Haul\n\n## Beat outline\n### Beat 1\n");
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline", kind: "step_started", payload: { kind: "agent" } }, { stepId: "outline", kind: "step_completed", payload: {} },
      { stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "approve the outline" } },
    ]);
    const row = await store.episodeRow("s02e01");
    expect(row).toMatchObject({ id: "s02e01", runId: "r1", stage: "DRAFT_OUTLINE", status: "waiting", title: "The Long Haul" });
    expect(row.openGate).toMatchObject({ stepId: "outline-gate", attempt: 1 });
    expect(row.openGate?.openedAt).toBeTypeOf("string");
    expect(row.lastEventAt).toBeTypeOf("string");
    store.close();
  });

  it("reads a failed run as failed, with the stage still the highest approved", async () => {
    const { root, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e02/premise.md", "A tow gone wrong.\n");
    await seedRun(root, "s02e02", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e02" } },
      { stepId: "stamp-outline", kind: "step_started", payload: { kind: "script" } }, { stepId: "stamp-outline", kind: "step_completed", payload: {} },
      { stepId: "draft", kind: "step_started", payload: { kind: "loop" } },
      { stepId: "draft", kind: "step_failed", payload: { error: "iteration 15: exhausted" } },
      { kind: "run_finished", payload: { status: "failed" } },
    ]);
    const row = await store.episodeRow("s02e02");
    expect(row).toMatchObject({ status: "failed", stage: "OUTLINE", failed: { stepId: "draft", error: "iteration 15: exhausted" } });
    expect(row.worker).toBeUndefined();
    store.close();
  });

  it("reads a live lock as running and a stale one as crashed", async () => {
    const { root, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e05/premise.md", "A night crossing.\n");
    await seedRun(root, "s02e05", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e05" } },
      { stepId: "outline", kind: "step_started", payload: { kind: "agent" } },
    ]);
    await writeLock(root, "s02e05", "r1", process.pid, [process.pid]);
    const live = await store.episodeRow("s02e05");
    expect(live.status).toBe("running");
    expect(live.worker).toMatchObject({ pid: process.pid, alive: true, groups: [process.pid] });
    // 2147483646 is one below the maximum pid: nothing holds it, so the lock is a worker that
    // died without its finally.
    await writeLock(root, "s02e05", "r1", 2147483646);
    const dead = await store.episodeRow("s02e05");
    expect(dead.status).toBe("crashed");
    expect(dead.worker).toMatchObject({ pid: 2147483646, alive: false });
    store.close();
  });

  it("reads a missing showrunner image as NEEDS_IMAGES, naming the shot", async () => {
    const { root, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e06/premise.md", "A salvage claim.\n");
    await writeIn(root, "Production/s02e06/images/prompts.json", JSON.stringify({
      shots: [{ id: "amb-04", source: "showrunner", prompt: "the harbour at dusk" }, { id: "amb-05", source: "nano-banana", prompt: "a winch" }],
    }));
    await seedRun(root, "s02e06", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e06" } },
      { stepId: "stamp-audio", kind: "step_started", payload: { kind: "script" } }, { stepId: "stamp-audio", kind: "step_completed", payload: {} },
      { stepId: "nano-banana-gate", kind: "gate_opened", payload: { attempt: 1, message: "drop in the ambient shots" } },
    ]);
    const row = await store.episodeRow("s02e06");
    expect(row.stage).toBe("NEEDS_IMAGES");
    expect(row.openGate).toMatchObject({ stepId: "nano-banana-gate", attempt: 1 });
    expect(row.needs.imagesMissing).toEqual(["amb-04"]);
    expect(row.needs.ideaMissing).toBe(false);
    store.close();
  });
});

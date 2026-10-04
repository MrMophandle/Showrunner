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
      { stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "approve the outline" } },
      { stepId: "outline-gate", kind: "gate_answered", payload: { approved: true, attempt: 1, by: "console:test" } },
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
      { stepId: "audio-gate", kind: "gate_opened", payload: { attempt: 1, message: "approve the mix" } },
      { stepId: "audio-gate", kind: "gate_answered", payload: { approved: true, attempt: 1, by: "console:test" } },
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

/** The archive marker: `<episodesDir>/<id>/archive.json`, which is how an episode finished outside
 *  the engine — Season 1, made by console v1, with no run logs and no `premise.md` — is shown as
 *  the finished thing it is rather than as NEEDS_IDEA · no runs.
 *
 *  The fourth test is the load-bearing one. A marker that could outrank a run log would let a file
 *  an operator edited by hand hide an open gate, a failure or a live worker, and the Board offers
 *  no gate link and no continue button for a row whose status is "archived". */
describe("the archive marker", () => {
  const NOTE = "Season 1, made by console v1; final on the NAS 2026-09-16";

  it("shows an episode with a marker and no runs at the marker's stage, archived and needing nothing", async () => {
    const { root, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e07/archive.json", JSON.stringify({ stage: "COMPLETE", note: NOTE }));
    const row = await store.episodeRow("s02e07");
    expect(row).toMatchObject({
      id: "s02e07", stage: "COMPLETE", status: "archived", archiveNote: NOTE,
      needs: { ideaMissing: false, refsMissing: [], imagesMissing: [] },
    });
    expect(row.runId).toBeUndefined();
    expect(row.logError).toBeUndefined();
    store.close();
  });

  it("leaves an episode with no marker exactly as it was", async () => {
    const { root, store } = await appWith(await makeShow());
    await mkdir(path.join(root, "Episodes", "s02e08"), { recursive: true });
    const row = await store.episodeRow("s02e08");
    expect(row).toMatchObject({ stage: "NEEDS_IDEA", status: "none", needs: { ideaMissing: true, refsMissing: [], imagesMissing: [] } });
    expect(row.archiveNote).toBeUndefined();
    expect(row.logError).toBeUndefined();
    store.close();
  });

  it("ignores a marker beside a run log: the run is the truth", async () => {
    const { root, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e09/archive.json", JSON.stringify({ stage: "COMPLETE", note: NOTE }));
    await writeIn(root, "Episodes/s02e09/outline.md", "# The Long Haul\n");
    // The premise is here so the derived stage is DRAFT_OUTLINE rather than NEEDS_IDEA: the point
    // of the test is that the marker lost to a gate's own stage, not to a missing premise.
    await writeIn(root, "Episodes/s02e09/premise.md", "A long tow north.\n");
    await seedRun(root, "s02e09", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e09" } },
      { stepId: "outline", kind: "step_started", payload: { kind: "agent" } }, { stepId: "outline", kind: "step_completed", payload: {} },
      { stepId: "outline-gate", kind: "gate_opened", payload: { attempt: 1, message: "approve the outline" } },
    ]);
    const row = await store.episodeRow("s02e09");
    expect(row).toMatchObject({ runId: "r1", stage: "DRAFT_OUTLINE", status: "waiting" });
    expect(row.archiveNote).toBeUndefined();
    expect(row.openGate).toMatchObject({ stepId: "outline-gate", attempt: 1 });
    store.close();
  });

  it("reports a marker it cannot read on the row, keeping the derived stage", async () => {
    const { root, store } = await appWith(await makeShow());
    await writeIn(root, "Episodes/s02e10/archive.json", '{"stage": "COMPLETE",');
    await writeIn(root, "Episodes/s02e11/archive.json", JSON.stringify({ stage: "complete", note: NOTE }));
    await writeIn(root, "Episodes/s02e12/premise.md", "A long tow north.\n");
    await writeIn(root, "Episodes/s02e12/archive.json", JSON.stringify({ note: NOTE }));

    const broken = await store.episodeRow("s02e10");
    expect(broken).toMatchObject({ stage: "NEEDS_IDEA", status: "none" });
    expect(broken.logError).toMatch(/^archive\.json: not valid JSON — /);

    const notAStage = await store.episodeRow("s02e11");
    expect(notAStage).toMatchObject({ stage: "NEEDS_IDEA", status: "none", logError: 'archive.json: "complete" is not a stage' });

    const noStage = await store.episodeRow("s02e12");
    expect(noStage).toMatchObject({ stage: "IDEA", status: "none" });
    expect(noStage.logError).toBe('archive.json: no stage — the marker needs {"stage": "COMPLETE", "note": "\u2026"}');
    expect(noStage.needs.ideaMissing).toBe(false);
    store.close();
  });
});

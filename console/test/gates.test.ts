import { describe, it, expect } from "vitest";
import { gateView } from "../server/gates.js";
import { appWith, makeShow, seedRun, writeIn, type SeedEvent } from "./helpers.js";

/** The prefix every artifact url of episode s02e01 carries. The gate view's job is to name the
 *  file each of the eight gates refers to, as a url under the episode's own two trees, so these
 *  tests are mostly a table check: the gate id in, the artifact list out. */
const FILES = "/api/episodes/s02e01/files";

/** A show with one run of s02e01 parked at `gateId`, plus whatever the test seeds before it. */
async function parkedAt(gateId: string, before: SeedEvent[] = [], attempt = 1) {
  const { root, ctx, store } = await appWith(await makeShow());
  await seedRun(root, "s02e01", "r1", [
    { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
    ...before,
    { stepId: gateId, kind: "gate_opened", payload: { attempt, message: `Approve ${gateId}.` } },
  ]);
  return { root, ctx, store };
}

describe("the gate view", () => {
  it("names the outline at outline-gate, with the reviewer's verdict and the gate's cap", async () => {
    const { ctx, store } = await parkedAt("outline-gate", [
      { stepId: "canon-review-outline", kind: "step_completed", payload: { result: { pass: true, deviations: [] } } },
    ]);
    const view = await gateView(ctx, store, "s02e01", "r1");
    expect(view).toBeDefined();
    const v = view!;
    expect(v).toMatchObject({ episodeId: "s02e01", runId: "r1", stepId: "outline-gate", attempt: 1, message: "Approve outline-gate." });
    expect(v.openedAt).toMatch(/^\d{4}-/);
    expect(v.artifacts[0]).toEqual({ kind: "markdown", label: "outline.md", url: `${FILES}/Episodes/s02e01/outline.md` });
    expect((v.verdicts["canon-review-outline"] as { pass: boolean }).pass).toBe(true);
    expect(v.rejections).toEqual([]);
    expect(v.maxAttempts).toBe(10);
    store.close();
  });

  it("carries every rejection note the gate has collected, and the attempt it is open at", async () => {
    const { ctx, store } = await parkedAt("script-gate", [
      { stepId: "script-gate", kind: "gate_opened", payload: { attempt: 1, message: "first ask" } },
      { stepId: "script-gate", kind: "gate_answered", payload: { approved: false, notes: "the ending is rushed", attempt: 1 } },
    ], 2);
    const v = (await gateView(ctx, store, "s02e01", "r1"))!;
    expect(v.attempt).toBe(2);
    expect(v.rejections).toEqual(["the ending is rushed"]);
    expect(v.artifacts).toEqual([{ kind: "markdown", label: "script.md", url: `${FILES}/Episodes/s02e01/script.md` }]);
    store.close();
  });

  it("names the diff and the ledger at canon-gate, both inside the episode's own two trees", async () => {
    const { ctx, store } = await parkedAt("canon-gate");
    const v = (await gateView(ctx, store, "s02e01", "r1"))!;
    expect(v.artifacts.map((a) => a.kind)).toEqual(["diff", "markdown"]);
    expect(v.artifacts).toEqual([
      { kind: "diff", label: "canon-diff.patch", url: `${FILES}/Production/s02e01/canon-diff.patch` },
      { kind: "markdown", label: "canon-ledger.md", url: `${FILES}/Episodes/s02e01/canon-ledger.md` },
    ]);
    store.close();
  });

  it("names the mastered video at final-gate when one is on disk, and the render when it is not", async () => {
    const { root, ctx, store } = await parkedAt("final-gate");
    const bare = (await gateView(ctx, store, "s02e01", "r1"))!;
    expect(bare.artifacts[0]).toEqual({ kind: "video", label: "episode.mp4", url: `${FILES}/Production/s02e01/video/episode.mp4` });
    expect(bare.artifacts[1]).toEqual({ kind: "json", label: "publish.json", url: `${FILES}/Episodes/s02e01/publish.json` });
    expect(bare.maxAttempts).toBe(2);

    await writeIn(root, "Production/s02e01/video/episode-mastered.mp4", "not really an mp4");
    const mastered = (await gateView(ctx, store, "s02e01", "r1"))!;
    expect(mastered.artifacts[0]).toEqual({ kind: "video", label: "episode-mastered.mp4", url: `${FILES}/Production/s02e01/video/episode-mastered.mp4` });
    store.close();
  });

  it("names the casting, audio and image artifacts of the four remaining gates", async () => {
    const casting = await parkedAt("casting-gate");
    expect((await gateView(casting.ctx, casting.store, "s02e01", "r1"))!.artifacts).toEqual([
      { kind: "json", label: "tts-script.json", url: `${FILES}/Production/s02e01/tts-script.json` },
      { kind: "audio", label: "guest-refs/", url: `${FILES}/Production/s02e01/guest-refs`, listUrl: `${FILES}/Production/s02e01/guest-refs` },
    ]);
    casting.store.close();

    const audio = await parkedAt("audio-gate");
    expect((await gateView(audio.ctx, audio.store, "s02e01", "r1"))!.artifacts).toEqual([
      { kind: "audio", label: "HarborLight S02E01.wav", url: `${FILES}/Production/s02e01/audio/HarborLight%20S02E01.wav` },
    ]);
    audio.store.close();

    const nano = await parkedAt("nano-banana-gate");
    expect((await gateView(nano.ctx, nano.store, "s02e01", "r1"))!.artifacts).toEqual([
      { kind: "images", label: "images/", url: `${FILES}/Production/s02e01/images`, listUrl: `${FILES}/Production/s02e01/images` },
      { kind: "markdown", label: "IMAGE-SHEET.md", url: `${FILES}/Production/s02e01/images/IMAGE-SHEET.md` },
    ]);
    nano.store.close();

    const image = await parkedAt("image-gate");
    expect((await gateView(image.ctx, image.store, "s02e01", "r1"))!.artifacts).toEqual([
      { kind: "images", label: "images/", url: `${FILES}/Production/s02e01/images`, listUrl: `${FILES}/Production/s02e01/images` },
    ]);
    expect((await gateView(image.ctx, image.store, "s02e01", "r1"))!.maxAttempts).toBe(5);
    image.store.close();
  });

  it("is undefined for a run with no gate open", async () => {
    const { root, ctx, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "outline", kind: "step_started", payload: { kind: "agent" } },
    ]);
    expect(await gateView(ctx, store, "s02e01", "r1")).toBeUndefined();
    store.close();
  });
});

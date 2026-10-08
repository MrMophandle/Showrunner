import { describe, it, expect } from "vitest";
import { gateView } from "../server/gates.js";
import { appWith, makeShow, seedRun, writeIn, type SeedEvent } from "./helpers.js";

/** The prefix every artifact url of episode s02e01 carries, **including the show key**, because
 *  every api route lives under `/api/shows/:show/` and the gate view hands the client urls that
 *  are already complete. The gate view's job is to name the file each of the eight gates refers
 *  to, as a url under the episode's own two trees, so these tests are mostly a table check: the
 *  gate id in, the artifact list out. */
const FILES = "/api/shows/show/episodes/s02e01/files";

/** A show with one run of s02e01 parked at `gateId`, plus whatever the test seeds before it. */
async function parkedAt(gateId: string, before: SeedEvent[] = [], attempt = 1) {
  const { root, app, ctx, store } = await appWith(await makeShow());
  await seedRun(root, "s02e01", "r1", [
    { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
    ...before,
    { stepId: gateId, kind: "gate_opened", payload: { attempt, message: `Approve ${gateId}.` } },
  ]);
  return { root, app, ctx, store };
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

  it("shows the verdicts of schema-bearing agent steps and nothing else that happens to carry a pass", async () => {
    const { ctx, store } = await parkedAt("script-gate", [
      // Schema-bearing agent steps: a reviewer and the canon review. These are verdicts.
      { stepId: "tone-check", kind: "step_completed", payload: { result: { pass: false, issues: ["three flat lines"] } } },
      { stepId: "canon-review-script", kind: "step_completed", payload: { result: { pass: true, deviations: [] } } },
      // A guard whose `check` returns `{pass, message}`: the same shape, and not a verdict the
      // showrunner is being asked to weigh. The pipeline marks no `schemaFile` on it.
      { stepId: "hand-edits-script", kind: "step_completed", payload: { result: { pass: true, message: "no hand edits" } } },
      // An agent step with no schema at all: its result is prose, and a future one that returned
      // something pass-shaped would not belong on the verdict board either.
      { stepId: "publish-copy", kind: "step_completed", payload: { result: { pass: true } } },
    ]);
    const v = (await gateView(ctx, store, "s02e01", "r1"))!;
    expect(Object.keys(v.verdicts).sort()).toEqual(["canon-review-script", "tone-check"]);
    expect((v.verdicts["tone-check"] as { pass: boolean }).pass).toBe(false);
    store.close();
  });

  /** The assertion the registry commit needed and did not have: an artifact url is not merely
   *  well-formed, it is an address this app answers. Every url the gate view hands out used to
   *  read `/api/episodes/<id>/files/<path>`, which moved under `/api/shows/:show/` — so the whole
   *  Gate page (markdown, diff, json, audio, contact sheet, video) pointed at a 404 while every
   *  shape assertion above still passed. Fetching one proves the prefix and the route agree. */
  it("hands out artifact urls this app actually answers, for a file and for a directory", async () => {
    const { root, app, ctx, store } = await parkedAt("outline-gate");
    await writeIn(root, "Episodes/s02e01/outline.md", "# The Missing Week\n");
    const v = (await gateView(ctx, store, "s02e01", "r1"))!;
    expect(v.artifacts.length).toBeGreaterThan(0);
    for (const artifact of v.artifacts) {
      expect(artifact.url.startsWith(`/api/shows/${ctx.key}/episodes/s02e01/files/`), artifact.url).toBe(true);
    }
    const fetched = await app.request(v.artifacts[0]!.url);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe("# The Missing Week\n");
    store.close();

    // A directory artifact carries the same address twice, and the listing has to answer there too.
    const image = await parkedAt("image-gate");
    await writeIn(image.root, "Production/s02e01/images/s01-wide.png", "not really a png");
    const dirArtifact = (await gateView(image.ctx, image.store, "s02e01", "r1"))!.artifacts[0]!;
    expect(dirArtifact.listUrl).toBe(dirArtifact.url);
    expect(dirArtifact.url.startsWith(`/api/shows/${image.ctx.key}/episodes/s02e01/files/`)).toBe(true);
    const listed = await image.app.request(dirArtifact.listUrl!);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ entries: [{ name: "s01-wide.png", size: 16, isDir: false }] });
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

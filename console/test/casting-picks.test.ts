import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gateView } from "../server/gates.js";
import { appWith, makeShow, seedRun, writeIn, type SeedEvent } from "./helpers.js";

/** The casting gate's answer carries the showrunner's choice of take per guest. These tests are
 *  about the server side of that choice: the manifest is rewritten before the gate is answered,
 *  every pick is checked first, and a refusal leaves both the manifest and the gate as they were.
 *
 *  `REFS` is the engine's **default** guest-reference directory for an episode
 *  (`<productionDir>/<episodeId>/guest-refs`, engine/src/needs.ts:85). Two tests at the end
 *  configure `audio.guestRefsDir` instead, because that key is the one show path that is
 *  per-episode and the console must read it rather than assume the default. */
const GATE = "/api/shows/show/episodes/s02e01/runs/r1/gate";
const MANIFEST = "Production/s02e01/tts-script.json";
const REFS = "Production/s02e01/guest-refs";

/** A show parked at `casting-gate` with two guests in its manifest, and four files in its
 *  guest-reference directory: three WAVs (one of them the second take of Pim) and a `.txt`, which
 *  is the transcript the showrunner records beside a take and never a take itself.
 *
 *  `guestRefsPattern` writes `audio.guestRefsDir` into the show's config before the show is
 *  loaded, and the manifest and the files then go wherever that pattern names. Omitted, the show
 *  configures no `audio` block at all and the takes live in the engine's default directory. */
async function parkedAtCasting(guestRefsPattern?: string) {
  const root = await makeShow();
  if (guestRefsPattern !== undefined) {
    const config = JSON.parse(await readFile(path.join(root, "showrunner.json"), "utf8")) as Record<string, unknown>;
    await writeIn(root, "showrunner.json", JSON.stringify({ ...config, audio: { guestRefsDir: guestRefsPattern } }));
  }
  const refs = guestRefsPattern === undefined ? REFS : guestRefsPattern.replace("{episodeId}", "s02e01");
  const { app, ctx, store } = await appWith(root);
  await seedRun(root, "s02e01", "r1", [
    { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
    { stepId: "casting-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve casting-gate." } },
  ] as SeedEvent[]);
  await writeIn(root, MANIFEST, JSON.stringify({
    episode: "s02e01", engine: "qwen3",
    cast: {
      narrator: { ref: "Production/voice-refs/narrator.wav", ref_text: "x" },
      Pim: { ref: `${refs}/pim-1.wav`, ref_text: "x", guest: true },
      Maeve: { ref: `${refs}/maeve-1.wav`, ref_text: "x", guest: true },
    },
    segments: [],
  }));
  for (const f of ["pim-1.wav", "pim-2.wav", "maeve-1.wav", "pim.txt"]) await writeIn(root, `${refs}/${f}`, "RIFF");
  return { root, refs, app, ctx, store };
}

const answer = (app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, body: unknown) =>
  app.request(GATE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function manifest(root: string): Promise<{ cast: Record<string, { ref: string }> }> {
  return JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as { cast: Record<string, { ref: string }> };
}

describe("picks on the casting gate's answer", () => {
  it("writes each pick into the manifest before answering the gate", async () => {
    const { root, app, store } = await parkedAtCasting();
    const res = await answer(app, { stepId: "casting-gate", approved: true, expectedAttempt: 1, picks: { Pim: `${REFS}/pim-2.wav` } });
    expect(res.status).toBe(200);
    const m = await manifest(root);
    expect(m.cast["Pim"]?.ref).toBe(`${REFS}/pim-2.wav`);
    expect(m.cast["Maeve"]?.ref).toBe(`${REFS}/maeve-1.wav`);
    expect(m.cast["narrator"]?.ref).toBe("Production/voice-refs/narrator.wav");
    const { events } = await store.get("s02e01", "r1");
    expect(events.some((e) => e.kind === "gate_answered")).toBe(true);
    store.close();
  });

  it("refuses a pick for a name that is not a guest, and leaves the manifest and the gate alone", async () => {
    const { root, app, store } = await parkedAtCasting();
    const res = await answer(app, { stepId: "casting-gate", approved: true, expectedAttempt: 1, picks: { narrator: `${REFS}/pim-2.wav` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not a guest");
    expect((await manifest(root)).cast["narrator"]?.ref).toBe("Production/voice-refs/narrator.wav");
    expect((await store.get("s02e01", "r1")).events.some((e) => e.kind === "gate_answered")).toBe(false);
    store.close();
  });

  it("refuses a pick outside the guest-refs directory, a non-audio file, and a file that does not exist", async () => {
    const { root, app, store } = await parkedAtCasting();
    for (const bad of ["Production/voice-refs/narrator.wav", `${REFS}/pim.txt`, `${REFS}/pim-9.wav`, "Canon/world-overview.md"]) {
      const res = await answer(app, { stepId: "casting-gate", approved: true, expectedAttempt: 1, picks: { Pim: bad } });
      expect(res.status, bad).toBe(400);
    }
    // Four refusals, and the manifest still casts Pim from the take the agent chose: nothing was
    // half-applied on the way to any of them.
    expect((await manifest(root)).cast["Pim"]?.ref).toBe(`${REFS}/pim-1.wav`);
    store.close();
  });

  it("refuses the whole set when one pick of two is bad, applying neither", async () => {
    const { root, app, store } = await parkedAtCasting();
    const res = await answer(app, {
      stepId: "casting-gate", approved: true, expectedAttempt: 1,
      picks: { Pim: `${REFS}/pim-2.wav`, Maeve: `${REFS}/maeve-9.wav` },
    });
    expect(res.status).toBe(400);
    const m = await manifest(root);
    expect(m.cast["Pim"]?.ref).toBe(`${REFS}/pim-1.wav`);
    expect(m.cast["Maeve"]?.ref).toBe(`${REFS}/maeve-1.wav`);
    store.close();
  });

  it("refuses picks at any gate but the casting gate", async () => {
    const { root, app, store } = await appWith(await makeShow());
    await seedRun(root, "s02e01", "r1", [
      { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } },
      { stepId: "script-gate", kind: "gate_opened", payload: { attempt: 1, message: "Approve script-gate." } },
    ] as SeedEvent[]);
    const res = await answer(app, { stepId: "script-gate", approved: true, expectedAttempt: 1, picks: { Pim: `${REFS}/pim-2.wav` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("casting-gate");
    store.close();
  });

  it("answers without picks exactly as before", async () => {
    const { root, app, store } = await parkedAtCasting();
    const res = await answer(app, { stepId: "casting-gate", approved: false, notes: "none of these", expectedAttempt: 1 });
    expect(res.status).toBe(200);
    expect((await manifest(root)).cast["Pim"]?.ref).toBe(`${REFS}/pim-1.wav`);
    store.close();
  });

  /** `audio.guestRefsDir` is the show path the engine substitutes `{episodeId}` into
   *  (engine/src/needs.ts:85), and the `refs-ready` guard globs an episode's takes from it. A
   *  console that assumed `<productionDir>/<episodeId>/guest-refs` would show the wrong directory
   *  at the gate and refuse every take of a show that configures the key. */
  it("honours a configured guest-refs directory, both in the gate view and in a pick", async () => {
    const { root, refs, app, ctx, store } = await parkedAtCasting("Production/{episodeId}/voices");
    expect(refs).toBe("Production/s02e01/voices");
    const view = (await gateView(ctx, store, "s02e01", "r1"))!;
    expect(view.casting?.dir).toBe("Production/s02e01/voices");

    // A take under the default directory exists on disk and is still refused: this show's takes
    // are not there.
    await writeIn(root, `${REFS}/pim-3.wav`, "RIFF");
    const wrong = await answer(app, { stepId: "casting-gate", approved: true, expectedAttempt: 1, picks: { Pim: `${REFS}/pim-3.wav` } });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toContain("Production/s02e01/voices/");

    const ok = await answer(app, { stepId: "casting-gate", approved: true, expectedAttempt: 1, picks: { Pim: `${refs}/pim-2.wav` } });
    expect(ok.status).toBe(200);
    expect((await manifest(root)).cast["Pim"]?.ref).toBe(`${refs}/pim-2.wav`);
    store.close();
  });

  /** The limit a configured directory runs into, recorded rather than left to be discovered: the
   *  artifact fence serves the episode's own two trees and nothing else (`resolveArtifactPath`,
   *  server/artifacts.ts), so a show whose guest references sit outside
   *  `<episodesDir>/<id>/` and `<productionDir>/<id>/` can be shown its takes at the gate and
   *  cannot pick one — the fence refuses the path by name, and the manifest is untouched. */
  it("refuses a pick outside the episode's own two trees, even where the config puts guest-refs there", async () => {
    const { root, refs, app, ctx, store } = await parkedAtCasting("Voices/{episodeId}/guests");
    expect(refs).toBe("Voices/s02e01/guests");
    expect((await gateView(ctx, store, "s02e01", "r1"))!.casting?.dir).toBe("Voices/s02e01/guests");
    const res = await answer(app, { stepId: "casting-gate", approved: true, expectedAttempt: 1, picks: { Pim: `${refs}/pim-2.wav` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("must begin with");
    expect((await manifest(root)).cast["Pim"]?.ref).toBe(`${refs}/pim-1.wav`);
    expect((await store.get("s02e01", "r1")).events.some((e) => e.kind === "gate_answered")).toBe(false);
    store.close();
  });
});

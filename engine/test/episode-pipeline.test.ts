import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { episodePipeline, EPISODE_STAGE_MAP, EPISODE_PIPELINE_NAME } from "../src/pipelines/episode.js";
import { bibleFilesFor } from "../src/bible.js";
import { orderSteps } from "../src/pipeline.js";
import { validateStageMap } from "../src/stages.js";
import type { ShowConfig } from "../src/show-config.js";
import type { Step } from "../src/steps.js";

export const show: ShowConfig = {
  showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: { ep10: [1, 10] },
  output: { nasRoot: "/tmp/no-such-nas", mixFilename: "{slug} S{season:02d}E{episode:02d}.wav", videoFilename: "episode.mp4" },
  audio: { voiceRefsDir: "Production/voice-refs", voiceRegistry: "Canon/voice-registry.md" },
  // No `visual.refs`: Plan L1 (2026-10-31) retired it from the engine, and the steps that read
  // the reference registry read `Canon/cast.json` through the defaulted `cast.index` instead.
  visual: { style: "Canon/visual-style.md", castingPileDir: "Canon/characters" },
  video: { compositionId: "Episode" },
  publish: { guide: "Canon/publishing-guide.md" },
};

/** Every file the `bible-ready` guard requires under `Canon/`, as basenames, for an episode of
 *  season 2 — the season of every episode id in these fixtures. It is `BIBLE_FILES` with the
 *  season row resolved to `season-2`. Every fixture below writes all of them because
 *  `bible-ready` is the pipeline's second step: a fixture that omits one fails there instead of
 *  reaching the step it asserts on. */
const BIBLE = ["world-overview", "series-arc", "episode-formula", "story-craft", "style-guide", "technology", "timeline", "season-2", "visual-style", "visual-audit-laws", "publishing-guide", "pipeline-artifacts", "README", "continuity-ledger", "voice-registry"] as const;

describe("episodePipeline", () => {
  const p = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });

  it("loads: unique ids, no cycle, every dependsOn and rerunOnReject known, and the stage map validates", () => {
    expect(p.name).toBe(EPISODE_PIPELINE_NAME);
    expect(() => orderSteps(p)).not.toThrow();
    expect(() => validateStageMap(EPISODE_STAGE_MAP, p)).not.toThrow();
    expect(p.steps).toHaveLength(65);
  });

  it("runs the review round in the order the reset depends on: hand edits, the revision, the panel's seven, the panel, the gate", () => {
    // The order is not decoration: `orderSteps` prefers declaration order among ready steps, and
    // this sequence is what puts the writer's revision between the reset and the reviewers on every
    // restarted pass. The reviewers depend on `revise` as well as on `draft` so that the console's
    // production `--concurrency 7` cannot batch the revision together with the panel it feeds — a
    // reviewer reading the script while the writer rewrites it.
    const order = orderSteps(p).map((s) => s.id);
    const index = (id: string) => order.indexOf(id);
    expect(index("hand-edits-script")).toBeLessThan(index("revise"));
    for (const id of ["canon-review-script", "tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check"]) {
      expect(index("revise"), id).toBeLessThan(index(id));
      expect(index(id), id).toBeLessThan(index("panel"));
    }
    expect(index("panel")).toBeLessThan(index("script-gate"));
    const by = new Map(p.steps.map((s) => [s.id, s]));
    expect(by.get("revise")?.dependsOn).toEqual(["hand-edits-script"]);
    expect(by.get("tone-check")?.dependsOn).toEqual(["draft", "revise"]);
    expect(by.get("script-gate")?.dependsOn).toEqual(["panel", "canon-ledger-script"]);
    // The round the panel resets is the ten steps the script gate's own rejection closure already
    // re-ran (inventory J-01), and the panel itself — the eleventh — which is what makes it
    // evaluate the re-run verdicts rather than keep its own.
    const panel = by.get("panel");
    expect(panel?.kind).toBe("panel");
    if (panel?.kind !== "panel") return;
    expect(panel.reviewers).toEqual(["canon-review-script", "tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check"]);
    expect(panel.resets).toEqual(["hand-edits-script", "revise", "canon-review-script", "canon-ledger-script", "tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check", "panel"]);
    expect(panel.dependsOn).toEqual(panel.reviewers);
    // And the revision runs only from round 2 on: round 1 is the pass with no panel_round in the
    // log, where `when` is false and the step is bypassed.
    const when = by.get("revise")?.when;
    expect(when?.({ runId: "r1", episodeId: "s02e01", showRoot: "/show", results: {} })).toBe(false);
    expect(when?.({
      runId: "r1", episodeId: "s02e01", showRoot: "/show", results: {},
      events: [{ ts: "t", runId: "r1", stepId: "panel", kind: "panel_round", payload: { round: 1 } }],
    })).toBe(true);
  });

  it("has the seven gates in run order, each opening its DRAFT_ stage", () => {
    const gates = orderSteps(p).filter((s) => s.kind === "gate").map((s) => s.id);
    // Seven and not eight since spec 2026-11-04 §4: the gate that approved the first paid shots
    // before more were spent is retired, because every image is a paid shot now and one gate
    // approves the set.
    expect(gates).toEqual(["outline-gate", "script-gate", "casting-gate", "audio-gate", "image-gate", "final-gate", "canon-gate"]);
    expect(Object.keys(EPISODE_STAGE_MAP.gates).sort()).toEqual([...gates].sort());
  });

  it("keys each stage to the step that reaches it: the real map's seven gates, eight approved rows and final, exhaustively", () => {
    // The stage map is the Board's only source for "how far along is this episode", and the only
    // automated check on it is validateStageMap, which refuses a key naming no step and a value of
    // the wrong kind -- never a value keyed to the wrong step. Before this test, five of the eight
    // approved rows were asserted nowhere against the real map (OUTLINE, SCRIPT, IMAGES,
    // PUBLISH_KIT, CANON), and the gate assertion above checks the key set only, not which DRAFT_
    // stage each gate opens, so a row re-keyed three steps early would leave the whole suite green
    // and the Board reporting an episode further along than it is (SR-1).
    //
    // toEqual over each whole object rather than row by row, so an added row and a deleted row fail
    // here too. engine/test/stages.test.ts's local `map` is a deliberately smaller synthetic map
    // for the derivation tests, not a second copy of this one to keep in step -- see its comment.
    expect(EPISODE_STAGE_MAP.gates).toEqual({
      "outline-gate": "DRAFT_OUTLINE", "script-gate": "DRAFT_SCRIPT", "casting-gate": "DRAFT_CASTING", "audio-gate": "DRAFT_AUDIO",
      "image-gate": "DRAFT_IMAGES", "final-gate": "DRAFT_ASSEMBLY", "canon-gate": "DRAFT_CANON",
    });
    expect(EPISODE_STAGE_MAP.approved).toEqual({
      "outline-gate": "OUTLINE", "script-gate": "SCRIPT", "casting-gate": "CASTING", "audio-gate": "AUDIO",
      "image-sheet-final": "IMAGES", "final-gate": "ASSEMBLY", "publish-kit": "PUBLISH_KIT", "canon-commit": "CANON",
    });
    expect(EPISODE_STAGE_MAP.final).toBe("COMPLETE");
    // IMAGES is reached when the image sheet is final, not when the image gate is answered: the
    // gate's approval opens the guard that waits for the showrunner's own shots and then the
    // sheet's last step. The two are two steps apart and the pair is the one divergence
    // stages.test.ts's synthetic map carries, so it is named here by value.
    expect(EPISODE_STAGE_MAP.approved["image-gate"]).toBeUndefined();
  });

  it("keeps the ordering rules as dependencies: images wait for the audio gate, canon waits for the publish kit", () => {
    const by = new Map(p.steps.map((s) => [s.id, s]));
    expect(by.get("visual-direction")?.dependsOn).toEqual(["audio-gate"]);
    expect(by.get("visual-direction")?.inputs).toContain("Production/s02e01/audio/HarborLight S02E01.wav");
    expect(by.get("canon-baseline")?.dependsOn).toEqual(["assemble-commit"]);
    expect(by.get("assemble-commit")?.dependsOn).toEqual(["finalize", "publish-kit"]);
  });

  it("both lint steps declare the script as an input, so an edited script misses the cache", () => {
    for (const id of ["shot-list-check", "shot-list-check-final"]) {
      const step = p.steps.find((s) => s.id === id);
      expect(step?.kind).toBe("script");
      expect((step as { inputs?: string[] }).inputs).toContain(`${show.episodesDir ?? "Episodes"}/s02e01/script.md`);
    }
  });

  it("the image stage is lint, render, audit loop, sheet, one gate, guard", () => {
    // Spec 2026-11-04 §4's table as declaration order: the fifteen steps from the visual director
    // to the final sheet. The console's run view and its gate handlers name these ids, so the
    // order is pinned rather than inferred — `shot-list-check` is the lint the stage runs since
    // spec 2026-11-04 §2.5, the renderer the engine ran on the showrunner's own hardware has no
    // step any more (§3), and the gate that approved the first paid shots is retired (§4).
    const ids = p.steps.map((s) => s.id);
    const first = ids.indexOf("visual-direction");
    expect(ids.slice(first, first + 15)).toEqual([
      "visual-direction", "shot-list-check", "visual-direction-fix", "shot-list-check-final", "nano-banana-generate",
      "image-audit-1", "image-regenerate-1", "image-audit-2", "image-regenerate-2", "image-audit-3",
      "image-audit-verdict", "image-sheet", "image-gate", "showrunner-images", "image-sheet-final",
    ]);
    const by = new Map(p.steps.map((s) => [s.id, s]));
    expect(by.get("nano-banana-generate")?.dependsOn).toEqual(["shot-list-check-final"]);
    // The guard that waits for a shot the showrunner makes by hand sits *after* the gate, because
    // the gate's rejection note is what makes a shot his (spec 2026-11-04 §2.4, §4.1).
    expect(by.get("showrunner-images")?.dependsOn).toEqual(["image-gate"]);
    expect(by.get("image-sheet-final")?.dependsOn).toEqual(["showrunner-images"]);
    const gate = by.get("image-gate");
    expect(gate?.kind).toBe("gate");
    expect(gate?.kind === "gate" && gate.rerunOnReject).toEqual(["nano-banana-generate"]);
    expect(gate?.kind === "gate" && gate.onReject?.id).toBe("image-gate-fix");
    // Every image in the stage is rendered by nano-banana (spec 2026-11-04 §3.2). The assertion is
    // the exhaustive set of Python the stage runs rather than the absence of one script's name, so
    // a step that reached for any other renderer — the retired one included — fails here.
    const ctx = { runId: "r", episodeId: "s02e01", showRoot: "/show", results: {} };
    const scriptName = (id: string): string | undefined => {
      const s = by.get(id);
      return s?.kind === "script" ? path.basename(s.argv(ctx)[5] ?? "") : undefined;
    };
    expect(ids.slice(first, first + 15).map(scriptName)).toEqual([
      undefined, "shot-list-check.py", undefined, "shot-list-check.py", "nano-banana-generate.py",
      undefined, "nano-banana-generate.py", undefined, "nano-banana-generate.py", undefined,
      undefined, "image-sheet.py", undefined, undefined, "image-sheet.py",
    ]);
  });

  it("never declares a directory as an input or output, and names the mix by the show's pattern", () => {
    for (const s of p.steps) for (const f of [...(s.inputs ?? []), ...(s.outputs ?? [])]) expect(f, `${s.id}: ${f}`).not.toMatch(/\/$/);
    const mix = p.steps.find((s) => s.id === "audio-mix");
    expect(mix?.outputs).toEqual(["Production/s02e01/audio/HarborLight S02E01.wav"]);
    expect(episodePipeline({ show, episodeId: "ep98", engineRoot: "/engine" }).steps.find((s) => s.id === "audio-mix")?.outputs).toEqual(["Production/ep98/audio/episode.wav"]);
  });

  it("declares no bible file the bible-ready guard does not check, for an aired id and for a production id", () => {
    // The guard's list (bibleFilesFor) and the inputs the steps declare agree only by hand, and
    // the agreement is what closes inventory F-01: a Canon/ input the guard does not check can go
    // absent, hash null, and run its step against nothing — an outline written against no world
    // overview — with every other test green. This test fails if a Canon/ input is added to any
    // step without a matching BIBLE_FILES row or config-named file.
    //
    // Canon/cast.json is the one deliberate exemption: it is the cast index, and its completeness
    // is the NEEDS_REFS probe's report (missingRefs in needs.ts), not the bible's. A new exemption
    // belongs here only with a reader that checks the file by name.
    const NOT_THE_BIBLE = new Set(["Canon/cast.json"]);
    /** Every path any step declares as an input, including the nested steps a gate's `onReject`
     *  and a loop's `body` carry. No nested step declares an input today; walking them is what
     *  makes a future one count rather than slip past the guard. */
    const declaredInputs = (steps: readonly Step[]): string[] => {
      const out: string[] = [];
      for (const s of steps) {
        out.push(...(s.inputs ?? []));
        if (s.kind === "gate" && s.onReject) out.push(...(s.onReject.inputs ?? []));
        if (s.kind === "loop") out.push(...(s.body.inputs ?? []));
      }
      return out;
    };
    // Both seasons of the ruling: an aired id carries season 2, so the spine declares
    // Canon/season-2.md and the guard must check that file; a production id the air map does not
    // map carries no season, so the spine declares no season file and the guard checks none.
    for (const [episodeId, season] of [["s02e01", 2], ["ep98", undefined]] as const) {
      const guarded = new Set(bibleFilesFor(show, season));
      const canonInputs = [...new Set(declaredInputs(episodePipeline({ show, episodeId, engineRoot: "/engine" }).steps))].filter((f) => f.startsWith("Canon/")).sort();
      expect(canonInputs.length, episodeId).toBeGreaterThan(10);
      for (const f of canonInputs) {
        if (NOT_THE_BIBLE.has(f)) continue;
        expect(guarded.has(f), `${episodeId}: ${f} is declared as a step input, and bible-ready does not check it`).toBe(true);
      }
      expect(canonInputs.includes("Canon/season-2.md"), episodeId).toBe(season === 2);
      expect(guarded.has("Canon/season-2.md"), episodeId).toBe(season === 2);
      expect([...guarded].some((f) => f.startsWith("Canon/season-")), episodeId).toBe(season === 2);
    }
  });

  it("hands the cast index to the writer and the reviewers: the canon spine, the draft loop and character-check", () => {
    // F6 of the whole-branch review (2026-10-31). The spec's ingestion rule (§1.2a) is that every
    // writing and reviewing prompt reads `Canon/cast.json` first and only the sheets in play after
    // it, and the prompt templates do. A step that reads a file it does not declare is a step
    // whose input hash cannot change when that file does (`hash.ts`), so a character cast between
    // two attempts would be served from the script cache and read by a prompt that had already
    // run — which is why the declaration and not the prompt is what this test measures.
    //
    // The index is exempt from the bible-ready cross-check above (`NOT_THE_BIBLE`): its
    // completeness is the reference probe's report, not the bible's.
    const by = new Map(p.steps.map((s) => [s.id, s]));
    const inputsOf = (id: string): readonly string[] => by.get(id)?.inputs ?? [];
    // The canon spine travels with the index, so every step that reads the spine declares both.
    for (const id of ["outline", "canon-review-outline", "canon-review-script"]) {
      expect(inputsOf(id), id).toContain("Canon/cast.json");
    }
    expect(inputsOf("draft")).toContain("Canon/cast.json");
    expect(inputsOf("character-check")).toContain("Canon/cast.json");
  });

  it("runs scripts through uv against the engine's scripts project, with the episode id first", () => {
    const ctx = { runId: "r", episodeId: "s02e01", showRoot: "/show", results: {} };
    const validate = p.steps.find((s) => s.id === "validate-manifest");
    expect(validate?.kind === "script" && validate.argv(ctx)).toEqual(["uv", "run", "--project", "/engine/scripts", "python", "/engine/scripts/validate-manifest.py", "s02e01"]);
    // The render goes through render-video.py, which spawns Remotion itself so its frame counter
    // becomes `::progress` lines. The render directory, the composition id and the output path
    // therefore travel in argv, and REMOTION_EPISODE is set by the wrapper from the episode id:
    // the step carries neither a `cwd` nor an `env` of its own, so the executor's default cwd
    // (the show root) applies, as every other Python step requires.
    const render = p.steps.find((s) => s.id === "render");
    expect(render?.kind === "script" && render.argv(ctx)).toEqual(["uv", "run", "--project", "/engine/scripts", "python", "/engine/scripts/render-video.py", "s02e01", "--render-dir", "/engine/render", "--composition", "Episode", "--out", "/show/Production/s02e01/video/episode.mp4"]);
    expect(render?.kind === "script" && render.cwd).toBeUndefined();
    expect(render?.kind === "script" && render.env).toBeUndefined();
  });
});

import { run, answerGate, resumeRun } from "../src/runner.js";
import { EventLog } from "../src/events.js";
import { deriveRunState } from "../src/state.js";
import { deriveStage } from "../src/stages.js";
import { episodeNeeds } from "../src/needs.js";
import type { Executors, RunContext, ScriptStep } from "../src/steps.js";

/** Fakes that behave like the real steps at the level the pipeline can see: a script writes its
 *  declared outputs (only when absent, as the real scripts do) and prints the result line the
 *  next step reads; an agent writes the file its prompt would and returns the verdict shape its
 *  schema demands. `knobs` lets a test make one step fail once or one verdict fail once. */
export function fakeExecutors(root: string, knobs: { failOnce?: Set<string>; reviewFailOnce?: Set<string> } = {}) {
  const w = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); };
  const exists = async (rel: string) => { try { await readFile(path.join(root, rel)); return true; } catch { return false; } };
  const calls: string[] = [];
  const results: Record<string, string> = {
    "validate-manifest": "MANIFEST_OK 120 segments, 2 guests", "audio-mix": "MIX_OK 1500.0s -14.0 LUFS", "shot-list-check": "SHOTS_OK 3 shots",
    "nano-banana-generate": "NANO_OK 1/1", "build-timeline": "TIMELINE_OK 3 shots", "master": "MASTER_OK episode-mastered.mp4",
    "canon-baseline": "NO_CHANGES", "canon-diff": "CHANGED 2 files, 30 lines",
    "image-sheet": "SHEET_OK 3 shots (0 by hand, 0 missing)", "image-sheet-final": "SHEET_OK 3 shots (1 by hand, 0 missing)",
  };
  const script: Executors["script"] = async (step: ScriptStep, ctx) => {
    calls.push(step.id);
    if (knobs.failOnce?.delete(step.id)) return { ok: false, error: `${step.id} failed once` };
    const argv = step.argv(ctx);
    const name = path.basename(argv[5] ?? argv[0] ?? "");
    if (name === "nano-banana-generate.py") {
      // The one renderer, as Task 1 left it (spec 2026-11-04 §3.2): every shot whose `source` is
      // not `showrunner`, whatever its `type`, and never a shot whose PNG is already on disk — so
      // a re-run after the audit or the gate deleted PNGs renders exactly the deleted ones.
      const doc = JSON.parse(await readFile(path.join(root, `Production/${ctx.episodeId}/images/prompts.json`), "utf8")) as { shots: { id: string; source?: string }[] };
      for (const s of doc.shots) {
        if (s.source !== "showrunner" && !(await exists(`Production/${ctx.episodeId}/images/${s.id}.png`))) await w(`Production/${ctx.episodeId}/images/${s.id}.png`, "png");
      }
    }
    // Declared outputs are rewritten on every call, as the QC passes rewrite the manifest in
    // place: a re-run therefore changes what the next step reads, and the cache is bypassed the
    // way it would be for real. (The cache itself is tested in runner.test.ts.)
    for (const out of step.outputs ?? []) await w(out, `${step.id}@${calls.length}\n`);
    return { ok: true, result: results[step.id] ?? `${step.id} OK` };
  };
  let scenes = 0;
  const pass = (verdict: string) => ({ pass: true, verdict, issues: [] as string[] });
  const agent: Executors["agent"] = async (step, ctx: RunContext) => {
    calls.push(step.id);
    const ep = ctx.episodeId;
    if (knobs.failOnce?.delete(step.id)) return { ok: false, error: `${step.id} failed once`, toolCalls: 1 };
    switch (step.id) {
      case "outline":
        await w(`Episodes/${ep}/outline.md`, "# Ep\n\n## Cast\n- Vale (recurring, speaks)\n- Harbor (location)\n\n## Beat outline\n### Beat 1 — a\n### Beat 2 — b\n### Beat 3 — c\n");
        return { ok: true, text: "outline written", toolCalls: 4 };
      case "canon-review-outline": case "canon-review-script": {
        const fail = knobs.reviewFailOnce?.delete(step.id);
        return { ok: true, text: "", toolCalls: 2, verdict: { ...pass(fail ? "CANON FAILED" : "CANON PASSED"), pass: !fail, issues: fail ? ["beat 2 — x — y"] : [], deviations: step.id === "canon-review-script" ? [{ where: "script.md SCENE TWO", deviation: "d", canon: "c", provenance: "rejection-note", evidence: "e" }] : [] } };
      }
      case "outline-revise-body": return { ok: true, text: "OUTLINE_FIXED", toolCalls: 3 };
      case "draft-body": {
        scenes++;
        const prior = (await exists(`Episodes/${ep}/script.md`)) ? await readFile(path.join(root, `Episodes/${ep}/script.md`), "utf8") : "# Script\n";
        await w(`Episodes/${ep}/script.md`, `${prior}## SCENE ${scenes}\nprose\n`);
        return { ok: true, text: scenes >= 3 ? "DRAFT_COMPLETE" : "wrote a scene", toolCalls: 5 };
      }
      case "tone-check": case "flow-check": case "character-check": case "structure-check": case "environment-check": case "repetition-check":
        return { ok: true, text: "", toolCalls: 2, verdict: pass("PASSED") };
      // One fresh call per round now, under the step's own id: the `revise` loop and its
      // `revise-body` are gone, and the panel decides whether the revision landed (Plan J).
      case "revise": return { ok: true, text: "## Changed\nScene two.", toolCalls: 2 };
      case "publish-copy": await w(`Episodes/${ep}/publish.json`, JSON.stringify({ logline: "A week." })); return { ok: true, text: "A week.", toolCalls: 1 };
      case "tts-script": await w(`Production/${ep}/tts-script.json`, "{}"); return { ok: true, text: "cast: Vale; guests: none", toolCalls: 3 };
      case "visual-direction":
        // One establishing shot per scene header, each carrying a `brief` and neither `prompt` nor
        // `seed` (spec 2026-11-04 §2.1, §2.2); the three headers are the three `## SCENE <n>` the
        // draft fake writes. s02's brief names its place, so the place's cast key is in `refs` —
        // which is the lint's rule (§2.5 rule 2) and not something the engine reads.
        await w(`Production/${ep}/images/prompts.json`, JSON.stringify({ episode: ep, shots: [
          { id: "s01-establishing", scene: "SCENE 1", type: "establishing", source: "pipeline", brief: "the dock at first light", width: 1024, height: 576 },
          { id: "s02-establishing", scene: "SCENE 2", type: "establishing", source: "pipeline", brief: "Harbor from the gantry, rain", refs: ["harbor"], width: 1024, height: 576 },
          { id: "s03-establishing", scene: "SCENE 3", type: "establishing", source: "pipeline", brief: "the office at the night watch", width: 1024, height: 576 },
        ] }));
        return { ok: true, text: "3 shots", toolCalls: 2 };
      case "image-audit-1": case "image-audit-2": case "image-audit-3":
        return { ok: true, text: "", toolCalls: 4, verdict: { pass: true, verdict: "IMAGES_CLEAN", fixed: [], flagged: [], summary: "all clean" } };
      case "image-gate-fix": {
        // What image-gate.reject.md orders (spec 2026-11-04 §4.1): the note is folded into the
        // named shot's `brief` and that shot's PNG is deleted so the renderer re-rolls it, and a
        // note saying the showrunner will make a shot himself sets that shot's `source` to
        // `showrunner` instead of re-rolling it. The file has to stay valid JSON — the renderer
        // parses it — and it has to change, or the renderer would be served from the script cache
        // on the restarted pass.
        const rel = `Production/${ep}/images/prompts.json`;
        const doc = JSON.parse(await readFile(path.join(root, rel), "utf8")) as { shots: { id: string; brief: string; source?: string }[] };
        const note = String(ctx.results["image-gate:rejection"] ?? "");
        const png = (id: string) => path.join(root, `Production/${ep}/images/${id}.png`);
        const first = doc.shots[0];
        if (first) { first.brief = `reworked: ${note}`; await rm(png(first.id), { force: true }); }
        const byHand = doc.shots.find((s) => note.includes(`${s.id} myself`));
        if (byHand) { byHand.source = "showrunner"; await rm(png(byHand.id), { force: true }); }
        await w(rel, JSON.stringify(doc));
        return { ok: true, text: "image-gate-fix done", toolCalls: 2 };
      }
      case "propose": await w("Canon/continuity-ledger.md", "changed\n"); return { ok: true, text: "ledger updated", toolCalls: 3 };
      default:
        // every fix agent
        if (step.outputs?.[0]) await w(step.outputs[0], `${step.id} edited ${String(ctx.results[`${step.id.replace(/-fix$/, "")}:rejection`] ?? "")}\n`);
        return { ok: true, text: `${step.id} done`, toolCalls: 1 };
    }
  };
  return { executors: { script, agent } as Executors, calls, w };
}

describe("the episode pipeline, walked", () => {
  it("premise → seven gates → COMPLETE, with the stage right at every stop, a script rejection re-running the panel, an audio rejection re-running synthesis, a failure resumed, and NEEDS_IMAGES while a showrunner shot is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const nas = await mkdtemp(path.join(tmpdir(), "nas-"));
    const cfg: ShowConfig = { ...show, output: { ...show.output, nasRoot: nas } };
    const { executors, calls, w } = fakeExecutors(root, { failOnce: new Set(["tts-generate"]) });
    for (const f of BIBLE) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Canon/cast.json", JSON.stringify({
      version: 1,
      cast: {
        vale: {
          name: "Vale", kind: "human", speaks: true, face: { ref: "Canon/characters/Vale/ref.png", gallery: [] },
          voice: { ref: "Production/voice-refs/vale.wav", ref_text: "x", direction: "d", status: "LOCKED" },
        },
        harbor: { name: "Harbor", kind: "location", speaks: false, face: { ref: "Canon/locations/harbor.png", gallery: [] } },
      },
    }));
    await w("Canon/characters/Vale/ref.png", "png"); await w("Canon/locations/harbor.png", "png"); await w("Production/voice-refs/vale.wav", "wav");
    await w("Episodes/_TEMPLATE/outline.md", "template\n");
    await w("Episodes/s02e01/premise.md", "A week.\n");
    const pipeline = episodePipeline({ show: cfg, episodeId: "s02e01", engineRoot: "/engine" });
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root, trigger: "test" };
    const go = () => run({ pipeline, ctx, log, executors, renderGateMessage: async (file, c) => `${file} for ${c.episodeId}` });
    const stage = async () => deriveStage(deriveRunState(await log.read()), EPISODE_STAGE_MAP, await episodeNeeds(root, "s02e01", cfg));
    const answer = (gate: string, approved: boolean, notes?: string) => answerGate(log, "r1", gate, { approved, by: "showrunner", ...(notes !== undefined ? { notes } : {}) });

    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "outline-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_OUTLINE");
    expect(calls.filter((c) => c === "outline-revise-body")).toHaveLength(0); // the canon review passed, so the revise loop was bypassed
    await answer("outline-gate", true);

    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_SCRIPT");
    expect(calls.filter((c) => c === "draft-body")).toHaveLength(3);
    const drafted = (await log.read()).filter((e) => e.kind === "step_progress" && e.stepId === "draft").map((e) => e.payload["done"]);
    expect(drafted).toEqual([1, 2, 3]);
    // a rejection: the fix agent edits the script, then the hand-edit guard and the six reviewers run again before the gate reopens
    const before = calls.length;
    await answer("script-gate", false, "scene two is flat");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 2 } });
    const rerun = calls.slice(before);
    expect(rerun[0]).toBe("script-gate-fix");
    expect(rerun).toEqual(expect.arrayContaining(["tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check"]));
    expect(rerun).not.toContain("draft-body");
    expect(rerun).toContain("canon-review-script"); // downstream of hand-edits-script, so it re-runs with the rejection note in scope (F-08)
    // `calls` holds only script and agent steps, and hand-edits-script is a guard, so the order of
    // the two is checked in the log, which records every kind: the rejection reset the guard, and
    // its second run precedes the second run of the review that depends on it.
    const afterReject = await log.read();
    expect(afterReject.some((e) => e.kind === "step_reset" && e.stepId === "hand-edits-script" && e.payload["by"] === "script-gate")).toBe(true);
    const started = afterReject.filter((e) => e.kind === "step_started").map((e) => e.stepId);
    const secondStart = (id: string) => started.indexOf(id, started.indexOf(id) + 1);
    expect(secondStart("hand-edits-script")).toBeGreaterThan(0);
    expect(secondStart("canon-review-script")).toBeGreaterThan(0);
    expect(secondStart("hand-edits-script")).toBeLessThan(secondStart("canon-review-script"));
    await answer("script-gate", true);

    // the write phase closes; refs are present; tts-generate fails once → the run fails, and resumes
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "casting-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_CASTING");
    await answer("casting-gate", true);
    expect(await go()).toEqual({ status: "failed", stepId: "tts-generate", error: "tts-generate failed once" });
    expect(await stage()).toBe("CASTING");
    await resumeRun(log, "r1", "showrunner");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "audio-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_AUDIO");
    expect(calls.filter((c) => c === "tts-script")).toHaveLength(1); // the resume did not re-run the agent step
    // an audio rejection re-runs synthesis, the QC passes and the mix
    const beforeAudio = calls.length;
    await answer("audio-gate", false, "segment 12 is rushed");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "audio-gate", attempt: 2 } });
    expect(calls.slice(beforeAudio)).toEqual(["audio-gate-fix", "tts-generate", "truncation-qc", "pace-qc", "breath-qc", "audio-mix"]);
    await answer("audio-gate", true);

    // images: one gate, reached through the lint, the render and one clean audit (spec 2026-11-04
    // §4). Every shot `visual-direction` wrote is the pipeline's, so nothing is waiting on the
    // showrunner's hand and the gate's own stage shows.
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "image-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_IMAGES");
    expect(calls.filter((c) => c.startsWith("image-audit-"))).toEqual(["image-audit-1"]); // rounds 2 and 3 bypassed after a clean audit
    expect(calls).not.toContain("visual-direction-fix"); // the lint said SHOTS_OK, so its fix loop was bypassed
    // An image-gate rejection naming two shots: the fix agent runs first, and `rerunOnReject`'s
    // single name resets its whole dependency closure — the renderer, the audit loop and the sheet
    // — so the gate reopens on a re-rendered set. The renderer re-renders only s01-establishing,
    // whose PNG the fix agent deleted; s03-establishing is the showrunner's own shot now, and
    // nothing renders a shot of his.
    const beforeImages = calls.length;
    await answer("image-gate", false, "s01-establishing is muddy; I'll make s03-establishing myself");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "image-gate", attempt: 2 } });
    expect(calls.slice(beforeImages)).toEqual(["image-gate-fix", "nano-banana-generate", "image-audit-1", "image-sheet"]);
    const afterImageReject = await log.read();
    const resetByImageGate = (id: string) => afterImageReject.some((e) => e.kind === "step_reset" && e.stepId === id && e.payload["by"] === "image-gate");
    // image-regenerate-1 is in the list because a bypassed step has a status too: the reset is the
    // closure of nano-banana-generate's dependents, not the one step the gate names.
    for (const id of ["nano-banana-generate", "image-audit-1", "image-regenerate-1", "image-audit-verdict", "image-sheet"]) {
      expect(resetByImageGate(id), id).toBe(true);
    }
    // No gate is reset, this one included: a reset gate re-runs on its recorded approval and emits
    // no event, so the projection would report an answered gate as never reached.
    expect(afterImageReject.filter((e) => e.kind === "step_reset").map((e) => e.stepId)).not.toContain("image-gate");
    // The rejection made s03-establishing the showrunner's own shot and deleted its PNG, so the
    // Board reads NEEDS_IMAGES while the gate waits, and the guard after the gate stops the line
    // until the file is on disk (spec 2026-11-04 §2.4).
    expect(await stage()).toBe("NEEDS_IMAGES");
    await answer("image-gate", true);
    const stopped = await go();
    expect(stopped).toMatchObject({ status: "failed", stepId: "showrunner-images" });
    expect(stopped.status === "failed" && stopped.error).toMatch(/^NEEDS_IMAGES: drop in s03-establishing/);
    await w("Production/s02e01/images/s03-establishing.png", "png");
    expect(await stage()).toBe("AUDIO");
    await resumeRun(log, "r1");

    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "final-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_ASSEMBLY");
    await answer("final-gate", true);
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "canon-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_CANON");
    await answer("canon-gate", true);
    expect(await go()).toEqual({ status: "completed" });
    expect(await stage()).toBe("COMPLETE");

    const state = deriveRunState(await log.read());
    expect(state.results["script-gate:rejections"]).toEqual(["scene two is flat"]);
    expect(state.results["audio-gate:rejections"]).toEqual(["segment 12 is rushed"]);
    expect(Object.values(state.steps).filter((s) => s === "bypassed").length).toBeGreaterThan(0);
  });

  it("stops at NEEDS_REFS when the outline names a subject the cast index lacks, and continues once it has one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const { executors, w } = fakeExecutors(root);
    for (const f of BIBLE) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Canon/cast.json", JSON.stringify({
      version: 1, cast: { harbor: { name: "Harbor", kind: "location", speaks: false, face: { ref: "Canon/locations/harbor.png", gallery: [] } } },
    }));
    await w("Canon/locations/harbor.png", "png");
    await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n");
    const pipeline = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const go = () => run({ pipeline, ctx, log, executors, renderGateMessage: async (file, c) => `${file} for ${c.episodeId}` });
    await go(); await answerGate(log, "r1", "outline-gate", { approved: true });
    await go(); await answerGate(log, "r1", "script-gate", { approved: true });
    const r = await go();
    expect(r).toMatchObject({ status: "failed", stepId: "refs-ready" });
    expect(r.status === "failed" && r.error).toMatch(/^NEEDS_REFS: Vale: no entry in Canon\/cast.json/);
    expect(deriveStage(deriveRunState(await log.read()), EPISODE_STAGE_MAP, await episodeNeeds(root, "s02e01", show))).toBe("NEEDS_REFS");
    await w("Canon/cast.json", JSON.stringify({
      version: 1,
      cast: {
        vale: {
          name: "Vale", kind: "human", speaks: true, face: { ref: "Canon/characters/Vale/ref.png", gallery: [] },
          voice: { ref: "Production/voice-refs/vale.wav", ref_text: "x", direction: "d", status: "LOCKED" },
        },
        harbor: { name: "Harbor", kind: "location", speaks: false, face: { ref: "Canon/locations/harbor.png", gallery: [] } },
      },
    }));
    await w("Canon/characters/Vale/ref.png", "png"); await w("Production/voice-refs/vale.wav", "wav");
    await resumeRun(log, "r1");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "casting-gate" } });
  });

  it("routes a failed canon review through the outline-revise loop before the gate, and refuses to start s02e02 while s02e01 has not completed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const { executors, calls, w } = fakeExecutors(root, { reviewFailOnce: new Set(["canon-review-outline"]) });
    for (const f of BIBLE) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n"); await w("Episodes/s02e02/premise.md", "Another.\n");
    // An index, empty of cast: `bible-ready` refuses a show that has none at all (F7), and this
    // test is about the canon review and not about the migration.
    await w("Canon/cast.json", JSON.stringify({ version: 1, cast: {} }));
    const p1 = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });
    const log1 = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    expect(await run({ pipeline: p1, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: log1, executors, renderGateMessage: async (file, c) => `${file} for ${c.episodeId}` })).toMatchObject({ status: "waiting", gate: { stepId: "outline-gate" } });
    expect(calls).toContain("outline-revise-body");
    expect(deriveRunState(await log1.read()).results["outline-fix-gate"]).toBe("no");
    const p2 = episodePipeline({ show, episodeId: "s02e02", engineRoot: "/engine" });
    const log2 = new EventLog(EventLog.logPath(root, "s02e02", "r1"));
    const r = await run({ pipeline: p2, ctx: { runId: "r1", episodeId: "s02e02", showRoot: root }, log: log2, executors, renderGateMessage: async (file, c) => `${file} for ${c.episodeId}` });
    expect(r).toMatchObject({ status: "failed", stepId: "previous-episode" });
    expect(r.status === "failed" && r.error).toMatch(/s02e01 has not completed its canon update/);
  });

  it("fails at bible-ready when a bible file is absent, naming it, and runs on once it is written", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const { executors, w } = fakeExecutors(root);
    for (const f of BIBLE.filter((b) => b !== "style-guide")) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n");
    // The index is written: the guard checks the bible's files first and the index second, so this
    // test measures the absent bible file and the test below measures the absent index.
    await w("Canon/cast.json", JSON.stringify({ version: 1, cast: {} }));
    const pipeline = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const go = () => run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors, renderGateMessage: async (file, c) => `${file} for ${c.episodeId}` });
    const r = await go();
    expect(r).toMatchObject({ status: "failed", stepId: "bible-ready" });
    expect(r.status === "failed" && r.error).toMatch(/^BIBLE_INCOMPLETE: .*Canon\/style-guide\.md/);
    // The guard is the write phase's own list, so writing the file it named is the whole fix: the
    // run resumes through bible-ready and reaches the first gate.
    await w("Canon/style-guide.md", "style-guide\n");
    await resumeRun(log, "r1");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "outline-gate" } });
  });

  it("fails at bible-ready when the show has no cast index, with the probe's own remedy line, before any agent runs", async () => {
    // F7 of the whole-branch review (2026-10-31). `refs-ready` is the late guard — it runs after
    // `write-commit` — and `missingRefs` reports nothing at all until an outline exists, so an
    // instance that has not been migrated onto `Canon/cast.json` used to clear `bible-ready`,
    // write a premise and an outline, pass two human gates, draft, and run the panel's seven
    // before the engine said the one thing it already knew at its second step. The guard carries
    // the identical sentence the probe writes, from `noCastIndexLine` in cast.ts, so an operator who
    // reads it at either step is sent to the same command and the two can never drift.
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const { executors, calls, w } = fakeExecutors(root);
    for (const f of BIBLE) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n");
    const pipeline = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const go = () => run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors, renderGateMessage: async (file, c) => `${file} for ${c.episodeId}` });
    const r = await go();
    expect(r).toMatchObject({ status: "failed", stepId: "bible-ready" });
    expect(r.status === "failed" && r.error).toBe("no cast index at Canon/cast.json — run scripts/cast-index-build.py --write");
    // Nothing was written and nothing was spent: the refusal is two steps in, before the premise
    // guard and before the outline agent.
    expect(calls).toEqual([]);
    // Building the index is the whole fix, as the line says: the run resumes through bible-ready
    // and reaches the first gate.
    await w("Canon/cast.json", JSON.stringify({ version: 1, cast: {} }));
    await resumeRun(log, "r1");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "outline-gate" } });
  });
});

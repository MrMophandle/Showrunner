import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { episodePipeline, EPISODE_STAGE_MAP, EPISODE_PIPELINE_NAME } from "../src/pipelines/episode.js";
import { orderSteps } from "../src/pipeline.js";
import { validateStageMap } from "../src/stages.js";
import type { ShowConfig } from "../src/show-config.js";

export const show: ShowConfig = {
  showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: { ep10: [1, 10] },
  output: { nasRoot: "/tmp/no-such-nas", mixFilename: "{slug} S{season:02d}E{episode:02d}.wav", videoFilename: "episode.mp4" },
  audio: { voiceRefsDir: "Production/voice-refs", voiceRegistry: "Canon/voice-registry.md" },
  visual: { refs: "Canon/refs.json", style: "Canon/visual-style.md", castingPileDir: "Canon/characters" },
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
    expect(p.steps).toHaveLength(74);
  });

  it("has the eight gates in run order, each opening its DRAFT_ stage", () => {
    const gates = orderSteps(p).filter((s) => s.kind === "gate").map((s) => s.id);
    expect(gates).toEqual(["outline-gate", "script-gate", "casting-gate", "audio-gate", "nano-banana-gate", "image-gate", "final-gate", "canon-gate"]);
    expect(Object.keys(EPISODE_STAGE_MAP.gates).sort()).toEqual([...gates].sort());
  });

  it("keeps the ordering rules as dependencies: images wait for the audio gate, canon waits for the publish kit", () => {
    const by = new Map(p.steps.map((s) => [s.id, s]));
    expect(by.get("visual-direction")?.dependsOn).toEqual(["audio-gate"]);
    expect(by.get("visual-direction")?.inputs).toContain("Production/s02e01/audio/HarborLight S02E01.wav");
    expect(by.get("canon-baseline")?.dependsOn).toEqual(["assemble-commit"]);
    expect(by.get("assemble-commit")?.dependsOn).toEqual(["stamp-finalized", "publish-kit"]);
  });

  it("never declares a directory as an input or output, and names the mix by the show's pattern", () => {
    for (const s of p.steps) for (const f of [...(s.inputs ?? []), ...(s.outputs ?? [])]) expect(f, `${s.id}: ${f}`).not.toMatch(/\/$/);
    const mix = p.steps.find((s) => s.id === "audio-mix");
    expect(mix?.outputs).toEqual(["Production/s02e01/audio/HarborLight S02E01.wav"]);
    expect(episodePipeline({ show, episodeId: "ep98", engineRoot: "/engine" }).steps.find((s) => s.id === "audio-mix")?.outputs).toEqual(["Production/ep98/audio/episode.wav"]);
  });

  it("runs scripts through uv against the engine's scripts project, with the episode id first", () => {
    const ctx = { runId: "r", episodeId: "s02e01", showRoot: "/show", results: {} };
    const stamp = p.steps.find((s) => s.id === "stamp-outline");
    expect(stamp?.kind === "script" && stamp.argv(ctx)).toEqual(["uv", "run", "--project", "/engine/scripts", "python", "/engine/scripts/status.py", "s02e01", "outline", "approved at outline-gate"]);
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
    "validate-manifest": "MANIFEST_OK 120 segments, 2 guests", "audio-mix": "MIX_OK 1500.0s -14.0 LUFS", "populator-check": "POPULATORS_OK 3 briefs",
    "nano-banana-generate": "NANO_OK 1/1", "build-timeline": "TIMELINE_OK 3 shots", "master": "MASTER_OK episode-mastered.mp4",
    "canon-baseline": "NO_CHANGES", "canon-diff": "CHANGED 2 files, 30 lines", "image-sheet": "SHEET_OK", "image-sheet-final": "SHEET_OK",
  };
  const script: Executors["script"] = async (step: ScriptStep, ctx) => {
    calls.push(step.id);
    if (knobs.failOnce?.delete(step.id)) return { ok: false, error: `${step.id} failed once` };
    const argv = step.argv(ctx);
    const name = path.basename(argv[5] ?? argv[0] ?? "");
    if (name === "image-generate.py" || name === "nano-banana-generate.py") {
      const doc = JSON.parse(await readFile(path.join(root, `Production/${ctx.episodeId}/images/prompts.json`), "utf8")) as { shots: { id: string; type: string; source?: string }[] };
      for (const s of doc.shots) {
        const mine = name === "image-generate.py" ? s.type === "ambient" : s.type === "character";
        if (mine && s.source !== "showrunner" && !(await exists(`Production/${ctx.episodeId}/images/${s.id}.png`))) await w(`Production/${ctx.episodeId}/images/${s.id}.png`, "png");
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
      case "revise-body": return { ok: true, text: "REVISIONS_COMPLETE", toolCalls: 2 };
      case "publish-copy": await w(`Episodes/${ep}/publish.json`, JSON.stringify({ logline: "A week." })); return { ok: true, text: "A week.", toolCalls: 1 };
      case "tts-script": await w(`Production/${ep}/tts-script.json`, "{}"); return { ok: true, text: "cast: Vale; guests: none", toolCalls: 3 };
      case "visual-direction":
        await w(`Production/${ep}/images/prompts.json`, JSON.stringify({ episode: ep, shots: [
          { id: "s01-wide", scene: "COLD OPEN", type: "ambient", prompt: "p", seed: 1 }, { id: "s02-vale", scene: "SCENE 2", type: "character", refs: ["vale"], brief: "b", seed: 2 },
          { id: "s03-hand", scene: "SCENE 3", type: "character", refs: ["vale"], brief: "b", seed: 3, source: "showrunner" },
        ] }));
        return { ok: true, text: "3 shots", toolCalls: 2 };
      case "image-audit-1": case "image-audit-2": case "image-audit-3":
        return { ok: true, text: "", toolCalls: 4, verdict: { pass: true, verdict: "IMAGES_CLEAN", fixed: [], flagged: [], summary: "all clean" } };
      case "image-gate-fix": {
        // What image-gate.reject.md orders: rewrite the shot's prompt and bump its seed. The file
        // has to stay valid JSON — the generators parse it — and it has to change, or the two
        // generators would be served from cache on the restarted pass.
        const rel = `Production/${ep}/images/prompts.json`;
        const doc = JSON.parse(await readFile(path.join(root, rel), "utf8")) as { shots: { seed: number; prompt?: string }[] };
        const first = doc.shots[0];
        if (first) { first.seed += 1; first.prompt = `reworked: ${String(ctx.results["image-gate:rejection"] ?? "")}`; }
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
  it("premise → eight gates → COMPLETE, with the stage right at every stop, a script rejection re-running the panel, an audio rejection re-running synthesis, a failure resumed, and NEEDS_IMAGES while a showrunner shot is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const nas = await mkdtemp(path.join(tmpdir(), "nas-"));
    const cfg: ShowConfig = { ...show, output: { ...show.output, nasRoot: nas } };
    const { executors, calls, w } = fakeExecutors(root, { failOnce: new Set(["tts-generate"]) });
    for (const f of BIBLE) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Canon/refs.json", JSON.stringify({ vale: { kind: "human", ref: "Canon/characters/Vale/ref.png" }, harbor: { kind: "location", ref: "Canon/locations/harbor.png" } }));
    await w("Canon/characters/Vale/ref.png", "png"); await w("Canon/locations/harbor.png", "png");
    await w("Production/voice-refs/refs.json", JSON.stringify({ cast: { Vale: { ref: "Production/voice-refs/vale.wav", status: "LOCKED" } } })); await w("Production/voice-refs/vale.wav", "wav");
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

    // images: the showrunner shot is missing, so NEEDS_IMAGES shows and the guard after the gate stops the line
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "nano-banana-gate", attempt: 1 } });
    expect(await stage()).toBe("NEEDS_IMAGES");
    await answer("nano-banana-gate", true);
    expect(await go()).toMatchObject({ status: "failed", stepId: "showrunner-images" });
    await w("Production/s02e01/images/s03-hand.png", "png");
    expect(await stage()).toBe("AUDIO");
    await resumeRun(log, "r1");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "image-gate", attempt: 1 } });
    expect(await stage()).toBe("DRAFT_IMAGES");
    expect(calls.filter((c) => c.startsWith("image-audit-"))).toEqual(["image-audit-1"]); // rounds 2 and 3 bypassed after a clean audit
    // an image-gate rejection: the fix agent runs first, then every image step between the two
    // gates is reset — but not the already-approved nano-banana-gate inside the closure. A reset
    // gate re-runs on its recorded approval and emits no event, so the projection would report an
    // approved gate as never reached for the rest of the run.
    const beforeImages = calls.length;
    await answer("image-gate", false, "shot 1 is muddy");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "image-gate", attempt: 2 } });
    expect(calls.slice(beforeImages)[0]).toBe("image-gate-fix");
    const afterImageReject = await log.read();
    const resetByImageGate = (id: string) => afterImageReject.some((e) => e.kind === "step_reset" && e.stepId === id && e.payload["by"] === "image-gate");
    for (const id of ["image-generate", "nano-banana-generate", "image-sheet", "showrunner-images", "image-audit-1", "image-audit-verdict"]) {
      expect(resetByImageGate(id), id).toBe(true);
    }
    expect(afterImageReject.some((e) => e.kind === "step_reset" && e.stepId === "nano-banana-gate")).toBe(false);
    expect(deriveRunState(afterImageReject).steps["nano-banana-gate"]).toBe("completed");
    await answer("image-gate", true);

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
    expect(await readFile(path.join(root, "Episodes/s02e01/STATUS.md"), "utf8")).toContain("stamp-finalized");
  });

  it("stops at NEEDS_REFS when the outline names a recurring subject the bible lacks, and continues once it exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const { executors, w } = fakeExecutors(root);
    for (const f of BIBLE) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Canon/refs.json", JSON.stringify({ harbor: { kind: "location", ref: "Canon/locations/harbor.png" } })); await w("Canon/locations/harbor.png", "png");
    await w("Production/voice-refs/refs.json", JSON.stringify({ cast: {} }));
    await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n");
    const pipeline = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const go = () => run({ pipeline, ctx, log, executors, renderGateMessage: async (file, c) => `${file} for ${c.episodeId}` });
    await go(); await answerGate(log, "r1", "outline-gate", { approved: true });
    await go(); await answerGate(log, "r1", "script-gate", { approved: true });
    const r = await go();
    expect(r).toMatchObject({ status: "failed", stepId: "refs-ready" });
    expect(r.status === "failed" && r.error).toMatch(/^NEEDS_REFS: Vale: no entry in Canon\/refs.json/);
    expect(deriveStage(deriveRunState(await log.read()), EPISODE_STAGE_MAP, await episodeNeeds(root, "s02e01", show))).toBe("NEEDS_REFS");
    await w("Canon/refs.json", JSON.stringify({ vale: { kind: "human", ref: "Canon/characters/Vale/ref.png" }, harbor: { kind: "location", ref: "Canon/locations/harbor.png" } }));
    await w("Canon/characters/Vale/ref.png", "png");
    await w("Production/voice-refs/refs.json", JSON.stringify({ cast: { Vale: { ref: "Production/voice-refs/vale.wav", status: "LOCKED" } } })); await w("Production/voice-refs/vale.wav", "wav");
    await resumeRun(log, "r1");
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "casting-gate" } });
  });

  it("routes a failed canon review through the outline-revise loop before the gate, and refuses to start s02e02 while s02e01 has not completed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const { executors, calls, w } = fakeExecutors(root, { reviewFailOnce: new Set(["canon-review-outline"]) });
    for (const f of BIBLE) await w(`Canon/${f}.md`, `${f}\n`);
    await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n"); await w("Episodes/s02e02/premise.md", "Another.\n");
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
});

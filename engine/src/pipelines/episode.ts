import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { EventLog } from "../events.js";
import { deriveRunState } from "../state.js";
import { formatAired, parseEpisodeId } from "../ids.js";
import { mixFilename, seasonOf, type ShowConfig } from "../show-config.js";
import { missingBibleFiles } from "../bible.js";
import { missingRefs, missingShowrunnerImages } from "../needs.js";
import { handEdits } from "../provenance.js";
import type { StageMap } from "../stages.js";
import type { AgentStep, GuardStep, LoopStep, NestedAgentStep, Pipeline, RunContext, ScriptStep, Step, StepId } from "../steps.js";

/** The name every episode run records in its run_started event and its log path. It is a
 *  constant rather than a literal at the call sites because the console, the run log and the
 *  pipeline have to agree on one spelling to find each other's records. */
export const EPISODE_PIPELINE_NAME = "episode";

/** Everything `episodePipeline` needs to build one episode's step list, and nothing else: the
 *  show's config supplies every path and name, the episode id supplies the rest, and the engine
 *  root locates the scripts and the renderer. No show is named in this file; a second show
 *  builds the same pipeline by passing its own config. */
export interface EpisodePipelineOptions {
  show: ShowConfig;
  episodeId: string;
  /** Absolute path of the engine repository checkout; `scripts/` and `render/` are under it. */
  engineRoot: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The stage each gate opens and each completion reaches (spec §3.2). ASSEMBLY is keyed on the
 *  gate itself because nothing stamps it; PUBLISH_KIT on the later of the two steps that follow
 *  finalize; CANON on the commit rather than the gate, which carries a `when` (F-05). */
export const EPISODE_STAGE_MAP: StageMap = {
  gates: {
    "outline-gate": "DRAFT_OUTLINE", "script-gate": "DRAFT_SCRIPT", "casting-gate": "DRAFT_CASTING", "audio-gate": "DRAFT_AUDIO",
    "nano-banana-gate": "DRAFT_IMAGES", "image-gate": "DRAFT_IMAGES", "final-gate": "DRAFT_ASSEMBLY", "canon-gate": "DRAFT_CANON",
  },
  approved: {
    "stamp-outline": "OUTLINE", "stamp-script": "SCRIPT", "stamp-casting": "CASTING", "stamp-audio": "AUDIO",
    "stamp-images": "IMAGES", "final-gate": "ASSEMBLY", "publish-kit": "PUBLISH_KIT", "canon-commit": "CANON",
  },
  final: "COMPLETE",
};

const REVIEWERS = ["tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check"] as const;

function str(v: unknown, fallback: string): string { return typeof v === "string" && v !== "" ? v : fallback; }
function verdictPass(v: unknown): boolean { return typeof v === "object" && v !== null && (v as { pass?: unknown }).pass === true; }
function verdictField(v: unknown, key: string): unknown { return typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined; }
async function isDir(p: string): Promise<boolean> { try { return (await stat(p)).isDirectory(); } catch { return false; } }

/** One typed pipeline per episode: the four Archon workflows as four phases of one step list, so
 *  the ordering rules of spec §1 are dependency edges and one run log holds the episode's whole
 *  history. Every path and name below comes from the show config or the episode id; the engine
 *  repository names no show. */
export function episodePipeline(opts: EpisodePipelineOptions): Pipeline {
  const { show, episodeId, engineRoot } = opts;
  parseEpisodeId(episodeId);
  const canonDir = show.canonDir ?? "Canon";
  const episodesDir = show.episodesDir ?? "Episodes";
  const productionDir = show.productionDir ?? "Production";
  const scriptsDir = path.join(engineRoot, "scripts");
  const renderDir = path.join(engineRoot, "render");
  const ep = `${episodesDir}/${episodeId}`;
  const prod = `${productionDir}/${episodeId}`;
  const voiceRefsDir = str(show.audio?.["voiceRefsDir"], "Production/voice-refs");
  const voiceRegistry = str(show.audio?.["voiceRegistry"], `${canonDir}/voice-registry.md`);
  const visualRefs = str(show.visual?.["refs"], `${canonDir}/refs.json`);
  const visualStyle = str(show.visual?.["style"], `${canonDir}/visual-style.md`);
  const castingPileDir = str(show.visual?.["castingPileDir"], `${canonDir}/characters`);
  const publishingGuide = str(show.publish?.["guide"], `${canonDir}/publishing-guide.md`);
  const compositionId = str(show.video?.["compositionId"], "Episode");
  const videoFilename = show.output.videoFilename ?? "episode.mp4";
  let season: number | undefined;
  try { season = seasonOf(episodeId, show.airMap); } catch { season = undefined; }

  const canonSpine = [
    `${canonDir}/world-overview.md`, `${canonDir}/technology.md`, `${canonDir}/timeline.md`, `${canonDir}/continuity-ledger.md`,
    `${canonDir}/series-arc.md`, `${canonDir}/episode-formula.md`, `${canonDir}/story-craft.md`, `${canonDir}/style-guide.md`,
    ...(season !== undefined ? [`${canonDir}/season-${season}.md`] : []),
  ];
  const outline = `${ep}/outline.md`;
  const script = `${ep}/script.md`;
  const premise = `${ep}/premise.md`;
  const lockedBeats = `${ep}/locked-beats.md`;
  const canonLedger = `${ep}/canon-ledger.md`;
  const status = `${ep}/STATUS.md`;
  const publishJson = `${ep}/publish.json`;
  const ttsScript = `${prod}/tts-script.json`;
  const manifest = `${prod}/audio/manifest.json`;
  const mix = `${prod}/audio/${mixFilename(show, episodeId)}`;
  const prompts = `${prod}/images/prompts.json`;
  const imageSheet = `${prod}/images/IMAGE-SHEET.md`;
  const timeline = `${prod}/video/timeline.json`;
  const video = `${prod}/video/${videoFilename}`;
  const mastered = `${prod}/video/episode-mastered.mp4`;
  const runsDir = `${prod}/runs`;

  /** argv for one of the engine's Python steps: uv runs it inside the engine's scripts project,
   *  with the show root as cwd (the executor's default) and the episode id first. */
  const py = (name: string, ...args: string[]) => (): string[] =>
    ["uv", "run", "--project", scriptsDir, "python", path.join(scriptsDir, name), episodeId, ...args];

  const stamp = (id: StepId, dependsOn: StepId[], milestone: string, detail: string): ScriptStep =>
    ({ kind: "script", id, dependsOn, argv: py("status.py", milestone, detail), outputs: [status], timeoutMs: 15_000 });

  const commit = (id: StepId, dependsOn: StepId[], message: string, paths: string[]): ScriptStep =>
    ({ kind: "script", id, dependsOn, argv: py("git-commit.py", "--message", message, "--", ...paths), timeoutMs: 30_000 });

  const reviewer = (id: (typeof REVIEWERS)[number], inputs: string[]): AgentStep => ({
    kind: "agent", id, dependsOn: ["draft"], promptFile: `${id}.md`, schemaFile: `${id}.schema.json`, model: "medium",
    allowedTools: ["Read", "Glob", "Grep"], context: "fresh", inputs, timeoutMs: 30 * MIN,
  });

  const canonReview = (id: StepId, dependsOn: StepId[], promptFile: string, inputs: string[]): AgentStep => ({
    kind: "agent", id, dependsOn, promptFile, schemaFile: "canon-review.schema.json", model: "medium",
    allowedTools: ["Read", "Glob", "Grep"], context: "fresh", inputs, timeoutMs: 30 * MIN,
  });

  const ledger = (id: StepId, reviewId: StepId, pass: "outline" | "script"): ScriptStep => ({
    kind: "script", id, dependsOn: [reviewId], outputs: [canonLedger], timeoutMs: 15_000,
    argv: (ctx) => [...py("canon-ledger.py", "--pass", pass, "--run", ctx.runId, "--rows", JSON.stringify(verdictField(ctx.results[reviewId], "deviations") ?? []))()],
  });

  const fixAgent = (id: StepId, promptFile: string, model: string, allowedTools: string[], outputs: string[]): NestedAgentStep =>
    ({ kind: "agent", id, promptFile, model, allowedTools, context: "fresh", outputs, timeoutMs: 30 * MIN });

  const imageAudit = (n: 1 | 2 | 3, dependsOn: StepId[], when?: (ctx: RunContext) => boolean): AgentStep => ({
    kind: "agent", id: `image-audit-${n}`, dependsOn, promptFile: "image-audit.md", schemaFile: "image-audit.schema.json", model: "medium",
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], context: "fresh", inputs: [visualStyle, prompts], outputs: [prompts],
    timeoutMs: 30 * MIN, idleTimeoutMs: 30 * MIN, ...(when ? { when } : {}),
  });
  const auditFailed = (n: 1 | 2 | 3) => (ctx: RunContext): boolean => {
    const v = ctx.results[`image-audit-${n}`];
    return v !== undefined && !verdictPass(v);
  };

  const steps: Step[] = [
    // ── write phase ──────────────────────────────────────────────────────────────────────────
    {
      kind: "guard", id: "previous-episode",
      // Rule 1.3: episode N+1 does not start until episode N's canon update is committed. The
      // previous episode's run logs say whether it finished; an episode with no logs at all is
      // from the archive that predates the engine, and a production id has no predecessor.
      check: async (ctx) => {
        const id = parseEpisodeId(ctx.episodeId);
        if (id.kind !== "aired" || id.episode === 1) return { pass: true, message: "no previous episode to wait for" };
        const prev = formatAired(id.season, id.episode - 1);
        const dir = path.join(ctx.showRoot, productionDir, prev, "runs");
        if (!(await isDir(dir))) return { pass: true, message: `${prev} has no run logs (archive)` };
        for (const f of await readdir(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const st = deriveRunState(await new EventLog(path.join(dir, f)).read());
          if (st.finished && st.status === "completed") return { pass: true, message: `${prev} completed in run ${st.runId}` };
        }
        return { pass: false, message: `${prev} has not completed its canon update (rule 1.3); finish it first` };
      },
    },
    {
      kind: "guard", id: "bible-ready", dependsOn: ["previous-episode"],
      // Inventory F-01: nothing else checks that the bible exists, and a declared input that is
      // absent hashes null and the step runs against nothing. The list is the pipeline's own —
      // every bible file a step below declares — so an author who deletes one in month three gets
      // this message rather than an outline written against nothing. The season file is governed
      // by the same `season` the canon spine above uses, so the guard can never demand a file the
      // `outline` step would not have declared. Sections prompts read by name are bible-check's
      // (tools/), not this guard's.
      check: async (ctx) => {
        const missing = await missingBibleFiles(ctx.showRoot, show, season);
        if (missing.length > 0) return { pass: false, message: `BIBLE_INCOMPLETE: ${missing.join(", ")}` };
        return { pass: true, message: "bible complete" };
      },
    } satisfies GuardStep,
    {
      kind: "guard", id: "premise", dependsOn: ["bible-ready"], inputs: [premise],
      check: async (ctx) => {
        let text: string;
        try { text = await readFile(path.join(ctx.showRoot, premise), "utf8"); } catch { text = ""; }
        if (text.trim() === "") return { pass: false, message: `NEEDS_IDEA: write ${premise}` };
        return { pass: true, message: text.trim() };
      },
    } satisfies GuardStep,
    {
      kind: "agent", id: "outline", dependsOn: ["premise"], promptFile: "outline.md", model: "writer",
      allowedTools: ["Read", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 30 * MIN,
      inputs: [premise, ...canonSpine, `${episodesDir}/_TEMPLATE/outline.md`], outputs: [outline],
    },
    {
      kind: "guard", id: "hand-edits-outline", dependsOn: ["outline"],
      check: async (ctx) => ({ pass: true, message: JSON.stringify({ handEdited: await handEdits(ctx, [outline]) }) }),
    },
    canonReview("canon-review-outline", ["hand-edits-outline"], "canon-review-outline.md", [outline, premise, lockedBeats, ...canonSpine]),
    ledger("canon-ledger-outline", "canon-review-outline", "outline"),
    {
      kind: "guard", id: "outline-fix-gate", dependsOn: ["canon-review-outline"],
      // Always passes (F-04): "no" routes to the revise loop; a failing guard would skip the gate.
      check: (ctx) => ({ pass: true, message: verdictPass(ctx.results["canon-review-outline"]) ? "yes" : "no" }),
    },
    {
      kind: "loop", id: "outline-revise", dependsOn: ["outline-fix-gate"], when: (ctx) => ctx.results["outline-fix-gate"] === "no",
      until: "OUTLINE_FIXED", maxIterations: 2, inputs: [outline], outputs: [outline],
      body: { kind: "agent", id: "outline-revise-body", promptFile: "outline-revise.md", model: "writer", allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], context: "shared", idleTimeoutMs: 15 * MIN },
    },
    {
      kind: "gate", id: "outline-gate", dependsOn: ["outline-revise", "canon-ledger-outline"], messageFile: "outline-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("outline-gate-fix", "outline-gate.reject.md", "writer", ["Read", "Edit", "Write", "Glob", "Grep"], [outline]),
      rerunOnReject: ["hand-edits-outline"],
    },
    stamp("stamp-outline", ["outline-gate"], "outline", "approved at outline-gate"),
    {
      kind: "loop", id: "draft", dependsOn: ["stamp-outline"], until: "DRAFT_COMPLETE", maxIterations: 15,
      inputs: [outline, `${canonDir}/style-guide.md`, `${canonDir}/story-craft.md`], outputs: [script],
      body: { kind: "agent", id: "draft-body", promptFile: "draft.md", model: "writer", allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"], context: "fresh", idleTimeoutMs: 15 * MIN },
      // Spec §6.7: progress derived from disk — scene headers written against beats planned.
      progress: async (ctx) => {
        const count = async (rel: string, re: RegExp) => { try { return (await readFile(path.join(ctx.showRoot, rel), "utf8")).split("\n").filter((l) => re.test(l)).length; } catch { return 0; } };
        return { done: await count(script, /^## /), total: await count(outline, /^### Beat \d+/), unit: "scenes" };
      },
    } satisfies LoopStep,
    {
      kind: "guard", id: "hand-edits-script", dependsOn: ["draft"],
      check: async (ctx) => ({ pass: true, message: JSON.stringify({ handEdited: await handEdits(ctx, [script, outline]) }) }),
    },
    canonReview("canon-review-script", ["hand-edits-script"], "canon-review-script.md", [script, outline, premise, lockedBeats, ...canonSpine]),
    ledger("canon-ledger-script", "canon-review-script", "script"),
    reviewer("tone-check", [`${canonDir}/style-guide.md`, script]),
    reviewer("flow-check", [`${canonDir}/episode-formula.md`, `${canonDir}/style-guide.md`, script, outline]),
    reviewer("character-check", [script, outline, `${canonDir}/world-overview.md`, `${canonDir}/style-guide.md`]),
    reviewer("structure-check", [`${canonDir}/story-craft.md`, `${canonDir}/episode-formula.md`, outline, script]),
    reviewer("environment-check", [script, outline, `${canonDir}/technology.md`]),
    reviewer("repetition-check", [`${canonDir}/style-guide.md`, script]),
    {
      kind: "guard", id: "review-gate", dependsOn: ["canon-review-script", ...REVIEWERS],
      check: (ctx) => ({ pass: true, message: ["canon-review-script", ...REVIEWERS].every((id) => verdictPass(ctx.results[id])) ? "yes" : "no" }),
    },
    {
      kind: "loop", id: "revise", dependsOn: ["review-gate"], when: (ctx) => ctx.results["review-gate"] === "no",
      until: "REVISIONS_COMPLETE", maxIterations: 3, inputs: [script, `${canonDir}/style-guide.md`], outputs: [script],
      body: { kind: "agent", id: "revise-body", promptFile: "revise.md", model: "writer", allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], context: "shared", idleTimeoutMs: 15 * MIN },
    },
    {
      kind: "gate", id: "script-gate", dependsOn: ["revise", "canon-ledger-script"], messageFile: "script-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("script-gate-fix", "script-gate.reject.md", "writer", ["Read", "Edit", "Write", "Glob", "Grep"], [script]),
      rerunOnReject: ["hand-edits-script", ...REVIEWERS],
    },
    stamp("stamp-script", ["script-gate"], "script", "panel passed, showrunner approved"),
    {
      kind: "agent", id: "publish-copy", dependsOn: ["script-gate"], promptFile: "publish-copy.md", model: "medium",
      allowedTools: ["Read", "Write"], context: "fresh", timeoutMs: 10 * MIN, inputs: [script, publishingGuide], outputs: [publishJson],
    },
    commit("write-commit", ["stamp-script", "publish-copy"], `${episodeId}: outline + script (write phase)`, [ep, runsDir]),

    // ── assets phase ─────────────────────────────────────────────────────────────────────────
    {
      kind: "guard", id: "refs-ready", dependsOn: ["write-commit"],
      check: async (ctx) => {
        const missing = await missingRefs(ctx.showRoot, ctx.episodeId, show);
        return missing.length === 0 ? { pass: true, message: "all references present" } : { pass: false, message: `NEEDS_REFS: ${missing.join("; ")}` };
      },
    },
    {
      kind: "agent", id: "tts-script", dependsOn: ["refs-ready"], promptFile: "tts-script.md", model: "large",
      allowedTools: ["Read", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 90 * MIN, idleTimeoutMs: 30 * MIN,
      inputs: [`${voiceRefsDir}/refs.json`, voiceRegistry, script, outline], outputs: [ttsScript],
    },
    { kind: "script", id: "validate-manifest", dependsOn: ["tts-script"], argv: py("validate-manifest.py"), inputs: [ttsScript, voiceRegistry], timeoutMs: MIN },
    {
      kind: "gate", id: "casting-gate", dependsOn: ["validate-manifest"], messageFile: "casting-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("casting-gate-fix", "casting-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep"], [ttsScript]),
      rerunOnReject: ["validate-manifest"],
    },
    stamp("stamp-casting", ["casting-gate"], "casting", "guest voices approved"),
    { kind: "script", id: "tts-generate", dependsOn: ["casting-gate"], argv: py("tts-generate.py"), inputs: [ttsScript], outputs: [manifest], timeoutMs: 3 * HOUR },
    { kind: "script", id: "truncation-qc", dependsOn: ["tts-generate"], argv: py("truncation-qc.py"), inputs: [ttsScript, manifest], outputs: [ttsScript, manifest], timeoutMs: 30 * MIN },
    { kind: "script", id: "pace-qc", dependsOn: ["truncation-qc"], argv: py("pace-qc.py"), inputs: [ttsScript, manifest], outputs: [ttsScript, manifest], timeoutMs: HOUR },
    { kind: "script", id: "breath-qc", dependsOn: ["pace-qc"], argv: py("breath-qc.py"), inputs: [ttsScript, manifest], outputs: [ttsScript, manifest], timeoutMs: 10 * MIN },
    { kind: "script", id: "audio-mix", dependsOn: ["breath-qc"], argv: py("audio-mix.py"), inputs: [manifest], outputs: [mix], timeoutMs: 10 * MIN },
    {
      kind: "gate", id: "audio-gate", dependsOn: ["audio-mix"], messageFile: "audio-gate.gate.md", maxAttempts: 5,
      onReject: fixAgent("audio-gate-fix", "audio-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], [ttsScript]),
      rerunOnReject: ["tts-generate"],
    },
    stamp("stamp-audio", ["audio-gate"], "audio", "mix approved (-14 LUFS)"),
    {
      // Rule 1.1: the Vision module takes the approved mix as an input, so the ordering cannot be
      // lost by editing a dependency list — the mix is declared here as well as depended on.
      kind: "agent", id: "visual-direction", dependsOn: ["audio-gate"], promptFile: "visual-direction.md", model: "medium",
      allowedTools: ["Read", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 30 * MIN,
      inputs: [visualStyle, visualRefs, script, outline, mix], outputs: [prompts],
    },
    { kind: "script", id: "populator-check", dependsOn: ["visual-direction"], argv: py("populator-check.py", "--report-only"), inputs: [prompts], timeoutMs: MIN },
    {
      kind: "agent", id: "visual-direction-fix", dependsOn: ["populator-check"], when: (ctx) => String(ctx.results["populator-check"] ?? "").startsWith("POPULATORS_BAD"),
      promptFile: "visual-direction-fix.md", model: "medium", allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 15 * MIN,
      inputs: [prompts, visualRefs], outputs: [prompts],
    },
    {
      kind: "script", id: "populator-check-final", dependsOn: ["visual-direction-fix"], when: (ctx) => String(ctx.results["populator-check"] ?? "").startsWith("POPULATORS_BAD"),
      argv: py("populator-check.py"), inputs: [prompts], timeoutMs: MIN,
    },
    { kind: "script", id: "image-generate", dependsOn: ["populator-check-final", "audio-mix"], argv: py("image-generate.py"), inputs: [prompts, visualRefs], timeoutMs: 3 * HOUR },
    { kind: "script", id: "nano-banana-generate", dependsOn: ["populator-check-final"], argv: py("nano-banana-generate.py"), inputs: [prompts, visualRefs], timeoutMs: 3 * HOUR },
    { kind: "script", id: "image-sheet", dependsOn: ["nano-banana-generate", "image-generate"], argv: py("image-sheet.py"), inputs: [prompts], outputs: [imageSheet], timeoutMs: MIN },
    {
      kind: "gate", id: "nano-banana-gate", dependsOn: ["image-sheet"], messageFile: "nano-banana-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("nano-banana-gate-fix", "nano-banana-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], [prompts, visualRefs]),
      rerunOnReject: ["nano-banana-generate", "image-generate"],
    },
    {
      kind: "guard", id: "showrunner-images", dependsOn: ["nano-banana-gate"],
      check: async (ctx) => {
        const missing = await missingShowrunnerImages(ctx.showRoot, ctx.episodeId, show);
        return missing.length === 0 ? { pass: true, message: "every showrunner-made shot is on disk" } : { pass: false, message: `NEEDS_IMAGES: drop in ${missing.join(", ")} under ${prod}/images/ and resume` };
      },
    },
    imageAudit(1, ["showrunner-images"]),
    { kind: "script", id: "image-regenerate-1", dependsOn: ["image-audit-1"], when: auditFailed(1), argv: py("image-generate.py"), inputs: [prompts], timeoutMs: 3 * HOUR },
    imageAudit(2, ["image-regenerate-1"], auditFailed(1)),
    { kind: "script", id: "image-regenerate-2", dependsOn: ["image-audit-2"], when: auditFailed(2), argv: py("image-generate.py"), inputs: [prompts], timeoutMs: 3 * HOUR },
    imageAudit(3, ["image-regenerate-2"], auditFailed(2)),
    {
      kind: "guard", id: "image-audit-verdict", dependsOn: ["image-audit-3"],
      check: (ctx) => {
        const last = ctx.results["image-audit-3"] ?? ctx.results["image-audit-2"] ?? ctx.results["image-audit-1"];
        const summary = String(verdictField(last, "summary") ?? "");
        return verdictPass(last)
          ? { pass: true, message: summary }
          : { pass: false, message: `ambient images still failing after 3 audits: ${summary} — resume the run and reset image-audit-1 to start the audit again, or fix the named shots by hand` };
      },
    },
    {
      kind: "gate", id: "image-gate", dependsOn: ["image-audit-verdict"], messageFile: "image-gate.gate.md", maxAttempts: 5,
      onReject: fixAgent("image-gate-fix", "image-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep", "Bash"], [prompts]),
      rerunOnReject: ["image-generate", "nano-banana-generate"],
    },
    { kind: "script", id: "registry-append", dependsOn: ["image-gate"], argv: py("registry-append.py"), inputs: [prompts], timeoutMs: 2 * MIN },
    { kind: "script", id: "image-sheet-final", dependsOn: ["registry-append"], argv: py("image-sheet.py"), inputs: [prompts], outputs: [imageSheet], timeoutMs: MIN },
    stamp("stamp-images", ["image-sheet-final"], "images", "assets approved"),
    commit("assets-commit", ["stamp-audio", "stamp-images"], `${episodeId}: assets — manifest, shot list, image sheet, casting pile (assets phase)`,
      [ttsScript, prompts, imageSheet, castingPileDir, visualRefs, runsDir]),

    // ── assemble phase ───────────────────────────────────────────────────────────────────────
    {
      kind: "guard", id: "nas-mounted", dependsOn: ["assets-commit"],
      // Checked before the render so a finalize cannot fail after a four-hour render.
      check: async () => (await isDir(show.output.nasRoot)) ? { pass: true, message: `NAS at ${show.output.nasRoot}` } : { pass: false, message: `mount the NAS at ${show.output.nasRoot} and resume` },
    },
    { kind: "script", id: "build-timeline", dependsOn: ["nas-mounted"], argv: py("build-timeline.py"), inputs: [manifest, ttsScript, prompts, script, mix], outputs: [timeline], timeoutMs: 5 * MIN },
    {
      // Wrapped rather than spawned directly, because Remotion with `--log=error` printed nothing
      // for the ten to forty minutes it ran and the run view could show no evidence of life.
      // `render-video.py` spawns Remotion itself and turns its frame counter into `::progress`
      // lines, so the render directory, the composition id, the output path and the episode id
      // all travel in argv — the episode id as the positional argument. REMOTION_EPISODE is not
      // in argv: `render-video.py` puts it in the Remotion child's *environment* (`:179`), which
      // is where Remotion reads it from. The step keeps the executor's default cwd (the show
      // root), which is what the scripts' convention requires of every Python step.
      kind: "script", id: "render", dependsOn: ["build-timeline"], timeoutMs: 4 * HOUR,
      argv: (ctx) => py("render-video.py", "--render-dir", renderDir, "--composition", compositionId,
        "--out", path.join(ctx.showRoot, video))(),
      inputs: [timeline], outputs: [video],
    },
    { kind: "script", id: "master", dependsOn: ["render"], argv: py("master-video.py"), inputs: [video], outputs: [mastered], timeoutMs: 15 * MIN },
    {
      kind: "gate", id: "final-gate", dependsOn: ["master"], messageFile: "final-gate.gate.md", maxAttempts: 2,
      onReject: fixAgent("final-gate-fix", "final-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep"], [prompts, publishJson]),
      rerunOnReject: ["build-timeline"],
    },
    { kind: "script", id: "finalize", dependsOn: ["final-gate"], argv: py("finalize-video.py"), inputs: [mastered], timeoutMs: 20 * MIN },
    stamp("stamp-finalized", ["finalize"], "finalized", "pushed to NAS"),
    { kind: "script", id: "publish-kit", dependsOn: ["finalize"], argv: py("publish-kit.py"), inputs: [manifest, ttsScript, script, publishJson], outputs: [`${prod}/publish/upload.md`, `${prod}/publish/captions.srt`], timeoutMs: MIN },
    // The paths are the files this phase leaves changed and the show keeps: publish.json and
    // prompts.json because final-gate's fix agent edits exactly those two and no later commit
    // step stages them, and not the timeline, which is derived and which the show git-ignores
    // (git-commit.py skips an ignored path, but naming one here would only ever be noise).
    commit("assemble-commit", ["stamp-finalized", "publish-kit"], `${episodeId}: assembled + finalized — publish kit, status (assemble phase)`,
      [publishJson, prompts, `${prod}/publish`, status, runsDir]),

    // ── canon phase (rule 1.2: after the publish kit) ────────────────────────────────────────
    { kind: "script", id: "canon-baseline", dependsOn: ["assemble-commit"], argv: py("canon-diff.py"), timeoutMs: 15_000 },
    {
      kind: "guard", id: "canon-clean", dependsOn: ["canon-baseline"],
      check: (ctx) => ctx.results["canon-baseline"] === "NO_CHANGES"
        ? { pass: true, message: "canon tree is clean" }
        : { pass: false, message: `${canonDir}/ has uncommitted changes (${String(ctx.results["canon-baseline"])}); commit or revert them, then resume` },
    },
    {
      kind: "agent", id: "propose", dependsOn: ["canon-clean"], promptFile: "propose.md", model: "medium",
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], context: "fresh", timeoutMs: 30 * MIN,
      inputs: [script, outline, `${canonDir}/continuity-ledger.md`, `${canonDir}/timeline.md`, canonLedger],
      outputs: [`${canonDir}/continuity-ledger.md`, `${canonDir}/timeline.md`, canonLedger],
    },
    { kind: "script", id: "canon-diff", dependsOn: ["propose"], argv: py("canon-diff.py"), outputs: [`${prod}/canon-diff.patch`], timeoutMs: 15_000 },
    {
      kind: "gate", id: "canon-gate", dependsOn: ["canon-diff"], when: (ctx) => ctx.results["canon-diff"] !== "NO_CHANGES", messageFile: "canon-gate.gate.md", maxAttempts: 10,
      onReject: fixAgent("canon-gate-fix", "canon-gate.reject.md", "medium", ["Read", "Edit", "Write", "Glob", "Grep"], [canonLedger]),
      rerunOnReject: ["canon-diff"],
    },
    commit("canon-commit", ["canon-gate"], `canon: absorb ${episodeId} (canon phase)`, [canonDir, canonLedger, runsDir]),
  ];

  return { name: EPISODE_PIPELINE_NAME, steps };
}

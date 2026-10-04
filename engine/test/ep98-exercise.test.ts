import { describe, it, expect } from "vitest";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateMessageRenderer } from "../src/agent-step.js";
import { EventLog } from "../src/events.js";
import { orderSteps } from "../src/pipeline.js";
import { episodePipeline } from "../src/pipelines/episode.js";
import { run } from "../src/runner.js";
import { scriptExecutor } from "../src/script-step.js";
import { loadShowConfig } from "../src/show-config.js";
import { deriveRunState } from "../src/state.js";
import type { Event } from "../src/events.js";
import type { Executors, Pipeline } from "../src/steps.js";

/** The exercise: the pipeline's deterministic steps, run for real against a show repository, with
 *  no agent step anywhere. It is env-gated in both directions — `SHOWRUNNER_EP98=1` turns it on and
 *  `SHOWRUNNER_SHOW_ROOT` says which repository it runs against — so the ordinary suite stays
 *  hermetic and no file under engine/ has to name a show or a path inside one.
 *
 *  What it proves, which no fake can: `uv` finds the engine's scripts project with the show root as
 *  cwd, a script's `::progress` lines become step_progress and its other lines become script_line,
 *  its last stdout line becomes the step's result, a hundred-megabyte output is hashed, the render
 *  runs through render-video.py (which supplies render/ as Remotion's cwd and REMOTION_EPISODE in
 *  its environment), and a gate opens with its message rendered from the show's own prompt file. */

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EP = "ep98";

/** The show repository under exercise. It comes from the environment and has no default: a default
 *  would have to spell some show's directory name, and nothing under engine/ may name a show. */
const showRoot = process.env["SHOWRUNNER_SHOW_ROOT"] ?? "";

const skipReason = process.env["SHOWRUNNER_EP98"] !== "1"
  ? "set SHOWRUNNER_EP98=1 to run it; it needs uv, ffmpeg, the render project's dependencies and about half an hour"
  : showRoot === ""
    ? "SHOWRUNNER_EP98=1 is set but SHOWRUNNER_SHOW_ROOT is empty; set it to the show repository checkout"
    : "";

// The reporter renders a skipped suite by name only, and a suite that skips because the operator
// asked for it and left out the one thing it needs must say so rather than pass silently.
if (process.env["SHOWRUNNER_EP98"] === "1" && showRoot === "") console.warn(`ep98 exercise skipped: ${skipReason}`);

/** A log in which every step of `pipeline` before `upto` is completed, so run() starts at `upto`.
 *  The seeded completions carry no inputHashes or outputHashes, which is what keeps them out of the
 *  script cache: deriveRunState marks a step completed on the event kind alone, while the cache
 *  only counts a completion that recorded both hash maps. */
async function seed(
  logPath: string, runId: string, pipeline: Pipeline, upto: string,
  alsoDone: string[], results: Record<string, unknown>,
): Promise<void> {
  const events: Omit<Event, "ts">[] = [
    { runId, kind: "run_started", payload: { pipeline: pipeline.name, episodeId: EP, trigger: "ep98-exercise" } },
  ];
  for (const step of orderSteps(pipeline)) {
    if (step.id === upto) break;
    events.push({ runId, stepId: step.id, kind: "step_started", payload: { kind: step.kind, seeded: true } });
    events.push({ runId, stepId: step.id, kind: "step_completed", payload: { seeded: true, ...(step.id in results ? { result: results[step.id] } : {}) } });
  }
  for (const id of alsoDone) {
    events.push({ runId, stepId: id, kind: "step_started", payload: { kind: "guard", seeded: true } });
    events.push({ runId, stepId: id, kind: "step_completed", payload: { seeded: true, result: "seeded" } });
  }
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, events.map((e, i) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...e })).join("\n") + "\n");
}

/** Prints one line per step that actually ran: its wall-clock from the log's own timestamps, how
 *  many script_line and step_progress events it produced, and its result. The exercise deletes its
 *  log when it is done, so this is where the measurements go. */
function report(runId: string, events: Event[], elapsedMs: number): void {
  const startedAt = new Map<string, number>();
  const lines = new Map<string, number>();
  const progress = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const out: string[] = [];
  for (const e of events) {
    if (e.stepId === undefined || e.payload["seeded"] === true) continue;
    if (e.kind === "step_started") startedAt.set(e.stepId, Date.parse(e.ts));
    if (e.kind === "script_line") bump(lines, e.stepId);
    if (e.kind === "step_progress") bump(progress, e.stepId);
    if (e.kind === "step_completed" || e.kind === "step_failed" || e.kind === "gate_opened") {
      const t0 = startedAt.get(e.stepId);
      const wall = t0 === undefined ? "     " : `${((Date.parse(e.ts) - t0) / 1000).toFixed(1)}s`;
      const counts = `lines=${lines.get(e.stepId) ?? 0} progress=${progress.get(e.stepId) ?? 0}`;
      const tail = String(e.payload["result"] ?? e.payload["error"] ?? "").split("\n")[0] ?? "";
      out.push(`  ${e.stepId.padEnd(15)} ${e.kind.padEnd(14)} ${wall.padStart(8)}  ${counts.padEnd(24)} ${tail}`);
    }
  }
  console.log(`[${runId}] ${(elapsedMs / 1000).toFixed(1)}s total; steps that ran for real:\n${out.join("\n")}`);
}

describe.skipIf(skipReason !== "")(`ep98 exercise (real scripts, no agents)${skipReason === "" ? "" : ` — skipped: ${skipReason}`}`, () => {
  /** The script executor is the real one. The agent executor fails every call, so a run that
   *  reaches an agent step fails the test rather than spending tokens against the real show. */
  const executors: Executors = {
    script: scriptExecutor,
    agent: () => Promise.resolve({ ok: false, error: "no agent step may run in the ep98 exercise", toolCalls: 0 }),
  };

  async function exercise(runId: string, upto: string, alsoDone: string[], results: Record<string, unknown>) {
    const show = await loadShowConfig(showRoot);
    const pipeline = episodePipeline({ show, episodeId: EP, engineRoot });
    const logPath = EventLog.logPath(showRoot, EP, runId);
    await rm(logPath, { force: true });
    await seed(logPath, runId, pipeline, upto, alsoDone, results);
    // The renderer the console builds, from the same options as the agent executor, so the gate
    // message and an agent prompt would read one prompts directory and one set of variables. The
    // query it is built with throws: nothing on this path may reach the SDK.
    const renderGateMessage = createGateMessageRenderer({
      query: () => { throw new Error("no agent query may run in the ep98 exercise"); },
      show,
    });
    const startedAt = Date.now();
    const r = await run({ pipeline, ctx: { runId, episodeId: EP, showRoot, trigger: "ep98-exercise" }, log: new EventLog(logPath), executors, renderGateMessage });
    const events = await new EventLog(logPath).read();
    return { r, events, state: deriveRunState(events), startedAt, elapsedMs: Date.now() - startedAt, logPath, runId };
  }

  it("audio-mix runs for real and audio-gate opens with a rendered message", { timeout: 15 * 60_000 }, async () => {
    const { r, events, state, logPath, runId, elapsedMs } = await exercise("ex-audio", "audio-mix", [], {});
    try {
      expect(r).toMatchObject({ status: "waiting", gate: { stepId: "audio-gate", attempt: 1 } });
      const mixDone = events.find((e) => e.kind === "step_completed" && e.stepId === "audio-mix");
      expect(String(mixDone?.payload["result"])).toMatch(/^MIX_OK /);
      expect(Object.values(mixDone?.payload["outputHashes"] as Record<string, string | null>)[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(events.some((e) => e.kind === "script_line" && e.stepId === "audio-mix")).toBe(true);
      expect(events.some((e) => e.kind === "step_progress" && e.stepId === "audio-mix")).toBe(true);
      // No agent step may run: the executor above fails every call, so any agent_* event or any
      // step the pipeline declares as an agent would have taken the run down before this gate.
      expect(events.filter((e) => e.kind === "agent_query" || e.kind === "agent_result")).toEqual([]);
      expect(state.openGate?.message).toMatch(/MIX_OK/);
      expect(state.openGate?.message).not.toMatch(/\{\{/);
    } finally {
      report(runId, events, elapsedMs);
      await rm(logPath, { force: true });
    }
  });

  it("build-timeline → render → master run for real and final-gate opens", { timeout: 60 * 60_000 }, async () => {
    const { r, events, state, logPath, runId, startedAt, elapsedMs } = await exercise("ex-assemble", "nas-mounted", ["nas-mounted"], { "publish-copy": "(seeded logline)" });
    try {
      expect(r).toMatchObject({ status: "waiting", gate: { stepId: "final-gate", attempt: 1 } });
      for (const id of ["build-timeline", "render", "master"]) {
        expect(state.steps[id], id).toBe("completed");
      }
      expect(String(events.find((e) => e.kind === "step_completed" && e.stepId === "build-timeline")?.payload["result"])).toMatch(/^TIMELINE_OK /);
      expect(String(events.find((e) => e.kind === "step_completed" && e.stepId === "master")?.payload["result"])).toMatch(/^MASTER_OK /);
      // argv[5] is the script path in `uv run --project <scripts> python <script> …`: the render
      // reaches Remotion through render-video.py, which is what turns its frame counter into the
      // step_progress events this run's log carries for the render.
      const renderStarted = events.find((e) => e.kind === "step_started" && e.stepId === "render");
      expect((renderStarted?.payload["argv"] as string[])[5]).toMatch(/render-video\.py$/);
      // The mastered file is checked by stat rather than read: it is hundreds of megabytes, and
      // what matters is that THIS run wrote it. An mtime older than the run's start would mean the
      // assertion was passing on a leftover from an earlier render.
      const mastered = await stat(path.join(showRoot, "Production", EP, "video", "episode-mastered.mp4"));
      expect(mastered.size).toBeGreaterThan(0);
      expect(mastered.mtimeMs).toBeGreaterThanOrEqual(startedAt);
      expect(events.filter((e) => e.kind === "agent_query" || e.kind === "agent_result")).toEqual([]);
      expect(state.openGate?.message).toMatch(/\(seeded logline\)/);
      expect(state.openGate?.message).not.toMatch(/\{\{/);
    } finally {
      report(runId, events, elapsedMs);
      await rm(logPath, { force: true });
      // build-timeline stages the episode's stills and mix into render/public/<episode>/ for the
      // renderer, which leaves the show's own file names inside the engine checkout. Nothing under
      // render/ may name a show (README, Develop), so the exercise takes its staging back out, the
      // same way it takes its run log back out.
      await rm(path.join(engineRoot, "render", "public", EP), { recursive: true, force: true });
    }
  });
});

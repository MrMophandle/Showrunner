import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLog, deriveRunState, episodePipeline, loadShowConfig, type Executors } from "@showrunner/engine";
import { runOnce, lockPath, type LockFile } from "../worker/main.js";

async function show() {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  const w = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); };
  await w("showrunner.json", JSON.stringify({ showName: "Harbor Lights", showSlug: "HarborLights", promptsDir: "prompts", models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: path.join(root, "nas") } }));
  for (const f of ["world-overview", "technology", "timeline", "continuity-ledger", "series-arc", "episode-formula", "story-craft", "style-guide", "season-2", "visual-style", "visual-audit-laws", "voice-registry", "publishing-guide", "pipeline-artifacts", "README"]) await w(`Canon/${f}.md`, `${f}\n`);
  await w("Canon/refs.json", "{}"); await w("Production/voice-refs/refs.json", JSON.stringify({ cast: {} }));
  await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n");
  await w("prompts/outline-gate.gate.md", "Outline for {{episodeId}}");
  return { root, w };
}

/** Executors that write an outline and stop at the first gate, as the real ones would. */
const fakes: Executors = {
  script: async () => ({ ok: true, result: "ok" }),
  agent: async (step, ctx) => {
    if (step.id === "outline") await writeFile(path.join(ctx.showRoot, "Episodes/s02e01/outline.md"), "# Ep\n\n## Cast\n\n## Beat outline\n### Beat 1\n");
    return { ok: true, text: "", toolCalls: 1, verdict: { pass: true, verdict: "CANON PASSED", issues: [], deviations: [] } };
  },
};
const opts = (root: string) => ({ showRoot: root, episodeId: "s02e01", runId: "20261002T100000Z-ab12", engineRoot: path.resolve(__dirname, "..", ".."), operator: "console:test", concurrency: 1 });

describe("the worker", () => {
  it("takes the lock, runs to the first gate, releases the lock, and reports waiting", async () => {
    const { root } = await show();
    const seen: LockFile[] = [];
    const r = await runOnce(opts(root), { executors: fakes, renderGateMessage: async (file, ctx) => `${file} for ${ctx.episodeId}`, heartbeatMs: 20, onHeartbeat: (lock) => { seen.push(lock); } });
    expect(r).toMatchObject({ status: "waiting", detail: expect.stringContaining("outline-gate") });
    const log = new EventLog(EventLog.logPath(root, "s02e01", "20261002T100000Z-ab12"));
    const state = deriveRunState(await log.read());
    expect(state.openGate?.stepId).toBe("outline-gate");
    expect(state.openGate?.message).toBe("outline-gate.gate.md for s02e01");
    expect((await log.read())[0]?.payload["trigger"]).toBe("console:test");
    await expect(stat(lockPath(root, "s02e01", "20261002T100000Z-ab12"))).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ pid: process.pid, groups: [] });
    expect(await readFile(path.join(root, "Production/s02e01/runs/20261002T100000Z-ab12.worker.log"), "utf8")).toMatch(/waiting at outline-gate/);
  });

  it("refuses to run while a live lock exists, and retakes a stale one", async () => {
    const { root, w } = await show();
    const lp = lockPath(root, "s02e01", "20261002T100000Z-ab12");
    await w(path.relative(root, lp), JSON.stringify({ pid: process.pid, startedAt: "t", heartbeatAt: "t", groups: [] }));
    expect(await runOnce(opts(root), { executors: fakes })).toMatchObject({ status: "crashed", detail: `run 20261002T100000Z-ab12 is held by pid ${process.pid}` });
    await w(path.relative(root, lp), JSON.stringify({ pid: 2147483646, startedAt: "t", heartbeatAt: "t", groups: [] }));
    const r = await runOnce(opts(root), { executors: fakes, renderGateMessage: async () => "m" });
    expect(r.status).toBe("waiting");
  });

  it("reports a failed step as failed, and a rejected run() as crashed with the error in the worker log", async () => {
    const { root } = await show();
    const failing: Executors = { ...fakes, agent: async () => ({ ok: false, error: "boom", toolCalls: 0 }) };
    expect(await runOnce(opts(root), { executors: failing })).toMatchObject({ status: "failed", detail: expect.stringContaining("outline") });
    const throwing: Executors = { ...fakes, agent: async () => { throw new Error("log write failed: disk full"); } };
    const r = await runOnce({ ...opts(root), runId: "20261002T100001Z-cd34" }, { executors: throwing });
    expect(r).toMatchObject({ status: "crashed", detail: expect.stringContaining("disk full") });
    expect(await readFile(path.join(root, "Production/s02e01/runs/20261002T100001Z-cd34.worker.log"), "utf8")).toMatch(/disk full/);
    await expect(stat(lockPath(root, "s02e01", "20261002T100001Z-cd34"))).rejects.toThrow();
  });

  it("beats the lock atomically, and stamps one startedAt for the life of the worker", async () => {
    const { root } = await show();
    const seen: LockFile[] = [];
    // Twelve-millisecond beats and a reader between them: the lock is a complete, parseable file
    // at every moment, because each beat is written to `<lock>.tmp` and renamed over the lock. A
    // `writeFile` on the lock itself truncates first, and a reader in that window parses zero
    // bytes as "no lock" — the one path in the protocol where two workers can hold one run.
    const lp = lockPath(root, "s02e01", "20261002T100000Z-ab12");
    let reads = 0;
    const poll = setInterval(() => {
      void readFile(lp, "utf8").then((text) => { JSON.parse(text) as LockFile; reads++; }).catch(() => undefined);
    }, 3);
    // Agent steps that take long enough for the interval to beat several times: the outline phase
    // has two of them, so forty milliseconds each is four or five beats at twelve.
    const slow: Executors = {
      ...fakes,
      agent: async (step, ctx, emit) => { await new Promise((r) => setTimeout(r, 40)); return fakes.agent(step, ctx, emit); },
    };
    try {
      const r = await runOnce(opts(root), {
        executors: slow, renderGateMessage: async () => "m", heartbeatMs: 12,
        onHeartbeat: (lock) => { seen.push(lock); },
      });
      expect(r.status).toBe("waiting");
    } finally {
      clearInterval(poll);
    }
    expect(reads).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(1);
    // One `startedAt` across every beat: it is when this worker took the run, and recomputing it
    // per beat made it a second copy of `heartbeatAt` spelled differently.
    expect(new Set(seen.map((l) => l.startedAt)).size).toBe(1);
    expect(new Set(seen.map((l) => l.heartbeatAt)).size).toBeGreaterThan(1);
    // The lock and its temporary file are both gone once the segment ends.
    await expect(stat(lp)).rejects.toThrow();
    await expect(stat(`${lp}.tmp`)).rejects.toThrow();
  });
});

/** Concurrency, through the worker rather than through `run()` directly: `--concurrency` reaches
 *  the engine as `WorkerOptions.concurrency`, and the review panel is what it exists for — seven
 *  agent steps that all depend on the same draft. */
describe("the worker's concurrency", () => {
  it("runs two ready agent steps at once when asked for two", async () => {
    const { root } = await show();
    const runId = "20261002T110000Z-ef56";
    // Every step up to and including `hand-edits-script` seeded completed, which is where the
    // episode pipeline's seven-wide review panel becomes ready: `canon-review-script` and the six
    // reviewers all depend on the draft and nothing else.
    const pipeline = episodePipeline({ show: await loadShowConfig(root), episodeId: "s02e01", engineRoot: path.resolve(__dirname, "..", "..") });
    const upTo = pipeline.steps.findIndex((s) => s.id === "hand-edits-script");
    expect(upTo).toBeGreaterThan(0);
    const lines = [
      JSON.stringify({ ts: new Date().toISOString(), runId, kind: "run_started", payload: { pipeline: pipeline.name, episodeId: "s02e01" } }),
      ...pipeline.steps.slice(0, upTo + 1).map((s) => JSON.stringify({
        ts: new Date().toISOString(), runId, stepId: s.id, kind: "step_completed",
        payload: { result: s.kind === "guard" ? "yes" : "ok" },
      })),
    ];
    const logFile = EventLog.logPath(root, "s02e01", runId);
    await mkdir(path.dirname(logFile), { recursive: true });
    await writeFile(logFile, `${lines.join("\n")}\n`, "utf8");

    let live = 0;
    let most = 0;
    const panel: Executors = {
      script: async () => ({ ok: true, result: "ok" }),
      agent: async () => {
        live++;
        most = Math.max(most, live);
        await new Promise((r) => setTimeout(r, 30));
        live--;
        return { ok: true, text: "", toolCalls: 1, verdict: { pass: true, verdict: "PASSED", issues: [], deviations: [] } };
      },
    };
    const r = await runOnce({ ...opts(root), runId, concurrency: 2 }, { executors: panel, renderGateMessage: async () => "approve the script" });
    expect(r.status).toBe("waiting");
    expect(r.detail).toContain("script-gate");
    // Two at once, and never a third: the batch is capped at the concurrency it was given.
    expect(most).toBe(2);
    // And the log's order is still the order the emits were made in, so the panel's seven
    // step_started events are all there.
    const started = (await new EventLog(logFile).read()).filter((e) => e.kind === "step_started").map((e) => e.stepId);
    expect(started).toContain("canon-review-script");
    expect(started.filter((id) => id !== undefined && id.endsWith("-check")).length).toBe(6);
  });
});

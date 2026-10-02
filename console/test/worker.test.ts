import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLog, deriveRunState, type Executors } from "@showrunner/engine";
import { runOnce, lockPath, type LockFile } from "../worker/main.js";

async function show() {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  const w = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); };
  await w("showrunner.json", JSON.stringify({ showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts", models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: path.join(root, "nas") } }));
  for (const f of ["world-overview", "technology", "timeline", "continuity-ledger", "series-arc", "episode-formula", "story-craft", "style-guide", "season-2", "visual-style", "voice-registry", "publishing-guide"]) await w(`Canon/${f}.md`, `${f}\n`);
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
});

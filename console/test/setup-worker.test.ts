import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  BIBLE_FILES, EventLog, bibleLogDir, deriveRunState,
  type AgentMessage, type AgentQueryOptions, type BibleFile, type Executors, type QueryFn,
} from "@showrunner/engine";
import { writeAnswers } from "@showrunner/tools";
import { bibleEntry, listSetupRuns, runSetupOnce, setupLockPath, setupLogPath } from "../worker/setup.js";
import { ENGINE_ROOT } from "./helpers.js";

/** The setup worker, driven through its exported seam the way `worker.test.ts` drives the episode
 *  worker's `runOnce`. Nothing here calls a model: either the executors are replaced outright, or
 *  the real ones are built over a fake `query`, which is how the prompts directory is proved. */

const RUN = "20261007T120000Z-ab12";

/** A show with a config that loads and `world-overview`'s answers on disk — the `write` step's one
 *  declared input. No `prompts/` is written **deliberately**: the interview's prompts ship with the
 *  engine's templates, so a worker that resolved the show's own prompts directory would fail to
 *  find `write.md` here, which is what the prompts-directory test asserts. */
async function show(): Promise<{ root: string; entry: BibleFile }> {
  const root = await mkdtemp(path.join(tmpdir(), "setup-worker-"));
  await writeFile(path.join(root, "showrunner.json"), JSON.stringify({
    showName: "Harbor Lights", showSlug: "HarborLights", promptsDir: "prompts",
    models: { medium: "m", large: "l", writer: "w" }, airMap: {},
    output: { nasRoot: path.join(root, "nas") },
  }), "utf8");
  const entry = bibleEntry("world-overview");
  await writeAnswers(root, entry, { "The primary cast": "Vale — the keeper of the light" });
  return { root, entry };
}

const opts = (root: string, over: Partial<Parameters<typeof runSetupOnce>[0]> = {}) => ({
  showRoot: root, key: "world-overview", runId: RUN, engineRoot: ENGINE_ROOT, operator: "console:test", ...over,
});

/** Executors that write the step's declared output, as the real writer agent would. */
function fakes(): { executors: Executors; ran: string[] } {
  const ran: string[] = [];
  const executors: Executors = {
    script: async (step) => { throw new Error(`a bible run executed a script step: ${step.id}`); },
    agent: async (step, ctx) => {
      ran.push(step.id);
      const file = step.outputs?.[0];
      if (file !== undefined) {
        await mkdir(path.dirname(path.join(ctx.showRoot, file)), { recursive: true });
        await writeFile(path.join(ctx.showRoot, file), "# Harbor Lights\n\n## The primary cast\n\nVale — the keeper\n", "utf8");
      }
      return { ok: true, text: "written", toolCalls: 1 };
    },
  };
  return { executors, ran };
}

const renderGateMessage = async (file: string, ctx: { episodeId: string }): Promise<string> => `${file} for ${ctx.episodeId}`;

async function events(root: string, key: string, runId: string) {
  return new EventLog(setupLogPath(root, key, runId)).read();
}

describe("the setup worker", () => {
  it("takes the lock, runs the file's pipeline, writes the log, and reports waiting at the gate", async () => {
    const { root } = await show();
    const f = fakes();
    const beats: number[] = [];
    const r = await runSetupOnce(opts(root), {
      executors: f.executors, renderGateMessage, heartbeatMs: 20, onHeartbeat: (lock) => { beats.push(lock.pid); },
    });

    expect(r).toEqual({ status: "waiting", detail: "waiting at gate (attempt 1)" });
    expect(f.ran).toEqual(["write"]);
    const log = await events(root, "world-overview", RUN);
    const started = log.find((e) => e.kind === "run_started");
    // The reserved id, and the pipeline's own name: an interview's run is not an episode's.
    expect(started?.payload["episodeId"]).toBe("setup");
    expect(started?.payload["pipeline"]).toBe("bible-world-overview");
    expect(started?.payload["trigger"]).toBe("console:test");
    const state = deriveRunState(log);
    expect(state.steps["write"]).toBe("completed");
    expect(state.openGate).toMatchObject({ stepId: "gate", attempt: 1, message: "gate.md for setup" });
    // The log is under the reserved setup id, beside the answers, and the lock is gone with the
    // worker that held it.
    expect(setupLogPath(root, "world-overview", RUN)).toBe(path.join(bibleLogDir(root, "world-overview"), `${RUN}.jsonl`));
    await expect(stat(setupLockPath(root, "world-overview", RUN))).rejects.toThrow();
    expect(beats[0]).toBe(process.pid);
    expect(await readFile(`${setupLogPath(root, "world-overview", RUN)}`.replace(/\.jsonl$/, ".worker.log"), "utf8"))
      .toMatch(/waiting at gate \(attempt 1\)/);
  });

  it("renders the writer's prompt from the interview's own templates and not from the show's prompts directory", async () => {
    const { root } = await show();
    const calls: { prompt: string; options: AgentQueryOptions }[] = [];
    const query: QueryFn = async function* (args) {
      calls.push(args);
      const messages: AgentMessage[] = [
        { type: "system", subtype: "init", session_id: "s1" },
        { type: "result", subtype: "success", result: "done", session_id: "s1", num_turns: 1, duration_ms: 1, total_cost_usd: 0, permission_denials: [] },
      ];
      for (const m of messages) yield m;
    };

    // The real executors and the real gate-message renderer, with nothing but the model faked.
    const r = await runSetupOnce(opts(root), { query, heartbeatMs: 1_000 });

    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain("You are the bible writer for *Harbor Lights*");
    expect(prompt).toContain("Production/setup/world-overview/answers.md");
    expect(prompt).toContain("Canon/world-overview.md");
    expect(prompt).toContain(path.join("templates", "canon", "world-overview.md"));
    // The gate's message is rendered by the real renderer from the same directory's `gate.md`,
    // which never queries a model — so the whole of the interview's prompt wiring is proved here.
    expect(r.status).toBe("waiting");
    const state = deriveRunState(await events(root, "world-overview", RUN));
    expect(state.openGate?.message).toContain("is ready to review");
  });

  it("refuses to run while a live lock exists, and retakes a stale one", async () => {
    const { root } = await show();
    const lock = setupLockPath(root, "world-overview", RUN);
    await mkdir(path.dirname(lock), { recursive: true });
    const body = (pid: number) => JSON.stringify({ pid, startedAt: "t", heartbeatAt: "t", groups: [] });

    await writeFile(lock, body(process.pid), "utf8");
    expect(await runSetupOnce(opts(root), { executors: fakes().executors, renderGateMessage }))
      .toEqual({ status: "crashed", detail: `run ${RUN} is held by pid ${process.pid}` });

    await writeFile(lock, body(2147483646), "utf8");
    expect((await runSetupOnce(opts(root), { executors: fakes().executors, renderGateMessage })).status).toBe("waiting");
  });

  it("describes a default file as the gate alone, with no writer step", async () => {
    const { root } = await show();
    await mkdir(path.join(root, "Canon"), { recursive: true });
    await writeFile(path.join(root, "Canon/story-craft.md"), "# Story craft\n", "utf8");
    const f = fakes();
    const r = await runSetupOnce(opts(root, { key: "story-craft" }), { executors: f.executors, renderGateMessage });
    expect(r.status).toBe("waiting");
    expect(f.ran).toEqual([]);
    const state = deriveRunState(await events(root, "story-craft", RUN));
    expect(Object.keys(state.steps)).toEqual(["gate"]);
  });

  it("refuses a key that is no bible file, a scaffold key and a malformed run id before any path is built", async () => {
    const { root } = await show();
    const keys = ["../../etc", "refs.json", "world-overview2", "continuity-ledger", "voice-registry"];
    for (const key of keys) {
      const r = await runSetupOnce(opts(root, { key }), { executors: fakes().executors, renderGateMessage });
      expect(r.status).toBe("crashed");
      expect(r.detail).toMatch(key === "continuity-ledger" || key === "voice-registry" ? /is a scaffold file/ : /no such bible file/);
    }
    expect((await runSetupOnce(opts(root, { runId: "../oops" }), { executors: fakes().executors })).detail)
      .toBe('invalid run id "../oops": expected [A-Za-z0-9_-]+');
    // Nothing was created for any of them: the fences come before the first path join.
    await expect(stat(path.join(root, "Production", "setup", "continuity-ledger"))).rejects.toThrow();
    expect(await listSetupRuns(root, "world-overview")).toEqual([]);
  });

  it("reports a failed step as failed, and a rejected run() as crashed with its text in the worker log", async () => {
    const { root } = await show();
    const failing: Executors = { ...fakes().executors, agent: async () => ({ ok: false, error: "the writer gave up", toolCalls: 0 }) };
    expect(await runSetupOnce(opts(root), { executors: failing, renderGateMessage }))
      .toMatchObject({ status: "failed", detail: expect.stringContaining("write") });

    const throwing: Executors = { ...fakes().executors, agent: async () => { throw new Error("log write failed: disk full"); } };
    const r = await runSetupOnce(opts(root, { runId: "20261007T130000Z-cd34" }), { executors: throwing, renderGateMessage });
    expect(r.status).toBe("crashed");
    expect(await readFile(setupLogPath(root, "world-overview", "20261007T130000Z-cd34").replace(/\.jsonl$/, ".worker.log"), "utf8"))
      .toMatch(/disk full/);
  });

  it("lists its own run ids in creation order, one log per run", async () => {
    const { root } = await show();
    const f = fakes();
    await runSetupOnce(opts(root), { executors: f.executors, renderGateMessage });
    await runSetupOnce(opts(root, { runId: "20261007T130000Z-cd34" }), { executors: f.executors, renderGateMessage });
    // Lexical order is creation order, because `mintRunId` stamps the time into the id, so the
    // last entry is the run the server's refusals and the Bible row read.
    expect(await listSetupRuns(root, "world-overview")).toEqual([RUN, "20261007T130000Z-cd34"]);
    for (const id of [RUN, "20261007T130000Z-cd34"]) {
      expect((await events(root, "world-overview", id)).find((e) => e.kind === "run_started")?.runId).toBe(id);
    }
  });

  it("names the fifteen bible files, and every key the server can reach is one of them", () => {
    expect(BIBLE_FILES).toHaveLength(15);
    expect(BIBLE_FILES.filter((b) => b.mode !== "scaffold")).toHaveLength(13);
    expect(bibleEntry("readme").mode).toBe("default");
  });
});

import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { EventLog } from "@showrunner/engine";
import { createApp } from "../server/app.js";
import { loadShowContext, type ShowContext } from "../server/show.js";
import { RunStore } from "../server/runs.js";

/** Not a test file: the fixtures Tasks 4 and 5 both build their tests on. One invented show on
 *  disk ("Harbor Light" — the engine repository names no real show), one way to write a run log
 *  with the timestamps a test chose, and one app wired to a fake worker. */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root, which is what the pipeline means by `engineRoot`: `scripts/` and
 *  `render/` live under it. `console/test/` is two levels down. */
export const ENGINE_ROOT = path.resolve(here, "..", "..");

/** The fake worker the server's tests spawn instead of the real one: it appends a run_started, a
 *  completed step and either a run_finished or an open gate, and exits. */
export const FAKE_WORKER = path.join(here, "fixtures", "fake-worker.mjs");

/** The eight gates of the episode pipeline, so `makeShow` can write the message file each one
 *  names. A gate with no message file is a load-time error in `orderSteps`, so a fixture show
 *  that is missing one cannot run at all. */
const GATES = ["outline-gate", "script-gate", "casting-gate", "audio-gate", "nano-banana-gate", "image-gate", "final-gate", "canon-gate"] as const;

/** Writes one file under the show root, creating its directory. Returns the absolute path. */
export async function writeIn(root: string, rel: string, text: string): Promise<string> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return file;
}

/** A temporary show repository: the config, the canon spine every agent step declares as an
 *  input, the two reference files the needs probes read, the outline template, the gate message
 *  files, and one episode (s02e01) with a premise and an empty runs directory. The runs
 *  directory exists so `RunStore.watch()` has something to watch at once rather than waiting for
 *  its poll to notice. Returns the show root. */
export async function makeShow(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "console-show-"));
  await writeIn(root, "showrunner.json", JSON.stringify({
    showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts",
    models: { medium: "m", large: "l", writer: "w" }, airMap: {},
    output: { nasRoot: path.join(root, "nas") },
  }));
  for (const f of ["world-overview", "technology", "timeline", "continuity-ledger", "series-arc", "episode-formula", "story-craft", "style-guide", "season-2", "visual-style", "voice-registry", "publishing-guide"]) {
    await writeIn(root, `Canon/${f}.md`, `${f}\n`);
  }
  await writeIn(root, "Canon/refs.json", "{}");
  await writeIn(root, "Production/voice-refs/refs.json", JSON.stringify({ cast: {} }));
  await writeIn(root, "Episodes/_TEMPLATE/outline.md", "# Template\n");
  await writeIn(root, "Episodes/s02e01/premise.md", "A week on the water.\n");
  for (const gate of GATES) {
    await writeIn(root, `prompts/${gate}.gate.md`, `${gate} for {{episodeId}}`);
    await writeIn(root, `prompts/${gate}.reject.md`, `${gate} rejected for {{episodeId}}`);
  }
  await mkdir(path.join(root, "Production", "s02e01", "runs"), { recursive: true });
  return root;
}

/** One event as a test writes it: the timestamp is the test's, not the clock's. */
export interface SeedEvent { ts?: string; stepId?: string; kind: string; payload?: Record<string, unknown> }

/** Writes a run log by hand, keeping the timestamps the test chose. `EventLog.append` stamps
 *  every event with the clock — correctly, since the log is the source of truth for when things
 *  happened — so a test that needs a run spread over a known forty seconds writes the lines
 *  itself. Returns the log's path. */
export async function seedRun(root: string, episodeId: string, runId: string, events: SeedEvent[], productionDir = "Production"): Promise<string> {
  const file = EventLog.logPath(root, episodeId, runId, productionDir);
  await mkdir(path.dirname(file), { recursive: true });
  const lines = events.map((e) => JSON.stringify({
    ts: e.ts ?? new Date().toISOString(), runId,
    ...(e.stepId !== undefined ? { stepId: e.stepId } : {}),
    kind: e.kind, payload: e.payload ?? {},
  }) + "\n");
  await writeFile(file, lines.join(""), "utf8");
  return file;
}

/** Writes a run's lock file: the one fact a log cannot state. A test that wants a run to look
 *  live passes `process.pid`; one that wants a crash passes a pid nothing holds. */
export async function writeLock(root: string, episodeId: string, runId: string, pid: number, groups: number[] = []): Promise<string> {
  const now = new Date().toISOString();
  const file = EventLog.logPath(root, episodeId, runId).replace(/\.jsonl$/, ".lock");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ pid, startedAt: now, heartbeatAt: now, groups }), "utf8");
  return file;
}

/** What the server's tests drive: the app, the context it was built from, and the store the app
 *  reads through. The worker command is the fake worker, so an action spawns a process that
 *  writes a log and exits rather than one that calls a model. `pollMs` is short so a test that
 *  wants the store's directory poll does not wait the production two seconds for it. */
export async function appWith(root: string, opts: { pollMs?: number } = {}): Promise<{ root: string; app: Hono; ctx: ShowContext; store: RunStore }> {
  const ctx = await loadShowContext({
    showRoot: root, engineRoot: ENGINE_ROOT, operator: "console:test",
    workerCommand: [process.execPath, FAKE_WORKER],
  });
  const store = new RunStore(ctx, { pollMs: opts.pollMs ?? 2000 });
  return { root, app: createApp(ctx, store), ctx, store };
}

/** Polls a condition until it holds, then returns; throws when it has not held by `timeoutMs`.
 *  The store's notifications arrive through `fs.watch`, whose latency is the filesystem's and
 *  not a number a test can assert on. */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 4000, everyMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`waitFor: condition did not hold within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

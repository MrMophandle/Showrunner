import path from "node:path";
import os from "node:os";
import { appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  EventLog, run, runLogPaths, episodePipeline, loadShowConfig, createAgentExecutor, createGateMessageRenderer, sdkQuery, scriptExecutor,
  type Executors, type GateMessageRenderer, type RunResult,
} from "@showrunner/engine";
import { killOnSignal, lockFileFor, startHeartbeat, takeLock, type HeartbeatDeps } from "./lock.js";

/** The lock, the heartbeat and the signal handling live in `worker/lock.ts`, shared with
 *  `worker/setup.ts`: this entry runs an episode's pipeline and that one runs a bible file's, and
 *  the two differ in which log, which lock path, which pipeline, which prompts directory and which
 *  prior logs — and in nothing about locking (ruling H-13).
 *
 *  `LockFile` and `lockPath` are re-exported here because `server/workers.ts` reads an episode
 *  run's lock through them. `lockPath` stays this module's own: it is built from `EventLog.logPath`,
 *  which validates the episode id, and a bible file's lock is beside a log that path builder
 *  refuses to compose. */
export { lockFileFor, type LockFile } from "./lock.js";

/** Which run segment to execute, and as whom. `engineRoot` locates the engine's `scripts/` and
 *  `render/` directories for the pipeline's script steps; `operator` becomes the run's `trigger`,
 *  so the log records who started it. `concurrency` is how many ready agent steps one run may
 *  execute at once — the console's default is 7, which covers the review panel; everything that
 *  is not an agent step runs alone whatever it is set to. */
export interface WorkerOptions { showRoot: string; episodeId: string; runId: string; engineRoot: string; operator: string; concurrency?: number }

/** The seams a test replaces. Production passes none of them: `executors` and `renderGateMessage`
 *  default to the real ones built from the show config, and the three heartbeat seams
 *  (`heartbeatMs`, `now`, `onHeartbeat`) come from `lock.ts`, so this entry and the setup worker
 *  cannot drift into two defaults for one interval. The shape is unchanged. */
export interface WorkerDeps extends HeartbeatDeps { executors?: Executors; renderGateMessage?: GateMessageRenderer }

/** What one segment came to. Three of the four are states the run log already records and the
 *  console re-derives from it; "crashed" is the one it cannot — a rejected `run()` or a lock held
 *  by another worker — and `detail` is the only account of it outside the worker log. */
export type WorkerOutcome = { status: "waiting" | "completed" | "failed" | "crashed"; detail: string };

/** The lock of one episode run, beside its log and named by the run id. An episode's log address
 *  is `EventLog.logPath`'s, which validates both ids, so this is the one place the console and the
 *  worker agree on where an episode run's lock is; `lockFileFor` applies the naming rule the setup
 *  worker's lock obeys too. */
export function lockPath(showRoot: string, episodeId: string, runId: string, productionDir = "Production"): string {
  return lockFileFor(EventLog.logPath(showRoot, episodeId, runId, productionDir));
}

/** One run segment: lock, build, run() once, release. Returns rather than throws for every
 *  outcome the log can state; "crashed" is the one it cannot — a rejected run() or a held lock —
 *  and the worker log carries its text. */
export async function runOnce(opts: WorkerOptions, deps: WorkerDeps = {}): Promise<WorkerOutcome> {
  const now = deps.now ?? (() => new Date());
  const show = await loadShowConfig(opts.showRoot);
  const productionDir = show.productionDir ?? "Production";
  const logFile = EventLog.logPath(opts.showRoot, opts.episodeId, opts.runId, productionDir);
  const lockFile = lockPath(opts.showRoot, opts.episodeId, opts.runId, productionDir);
  const workerLog = logFile.replace(/\.jsonl$/, ".worker.log");
  const note = async (line: string) => { await mkdir(path.dirname(workerLog), { recursive: true }); await appendFile(workerLog, `${now().toISOString()} pid ${process.pid}: ${line}\n`); };

  const tookAt = now();
  const lock = await takeLock(lockFile, tookAt);
  if (!lock.ok) { const detail = `run ${opts.runId} is held by pid ${lock.holder}`; await note(detail); return { status: "crashed", detail }; }

  // The beat starts at once, so a reader never sees a lock without `groups`, and `release()` is
  // what the `finally` below calls: it stops the interval, waits for the beat in flight and
  // removes the lock. `lock.ts` records why each of those three matters.
  const heartbeat = await startHeartbeat(lockFile, tookAt, deps);

  try {
    const pipeline = episodePipeline({ show, episodeId: opts.episodeId, engineRoot: opts.engineRoot });
    const agentOpts = { query: sdkQuery, show };
    const executors: Executors = deps.executors ?? { script: scriptExecutor, agent: createAgentExecutor(agentOpts) };
    const renderGateMessage = deps.renderGateMessage ?? createGateMessageRenderer(agentOpts);
    const priorLogs = (await runLogPaths(opts.showRoot, opts.episodeId, productionDir)).filter((p) => p !== logFile).map((p) => new EventLog(p));
    let result: RunResult;
    try {
      result = await run({ pipeline, ctx: { runId: opts.runId, episodeId: opts.episodeId, showRoot: opts.showRoot, trigger: opts.operator }, log: new EventLog(logFile), executors, priorLogs, renderGateMessage, ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}) });
    } catch (err) {
      const detail = `run() rejected: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
      await note(detail);
      return { status: "crashed", detail };
    }
    const detail = result.status === "waiting" ? `waiting at ${result.gate.stepId} (attempt ${result.gate.attempt})`
      : result.status === "failed" ? `failed at ${result.stepId}: ${result.error}` : "completed";
    await note(detail);
    return { status: result.status, detail };
  } finally {
    await heartbeat.release();
  }
}

function flag(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; }

async function main(): Promise<void> {
  const showRoot = flag("show"); const episodeId = flag("episode"); const runId = flag("run");
  if (!showRoot || !episodeId || !runId) { process.stderr.write("usage: worker --show <root> --episode <id> --run <runId> [--engine-root <path>] [--operator <name>] [--concurrency N]\n"); process.exit(64); }
  const engineRoot = flag("engine-root") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const operator = flag("operator") ?? `console:${os.userInfo().username}`;
  // Validated the way the server validates its own `--concurrency` (`server/main.ts`): without
  // this, `Number("abc")` is NaN, `Math.max(1, NaN)` is NaN, `concurrency > 1` is false, and the
  // run falls back silently to one agent step at a time — a review panel that takes seven times
  // as long as it was asked to, reported nowhere.
  const c = flag("concurrency");
  if (c !== undefined && (!Number.isInteger(Number(c)) || Number(c) < 1)) {
    process.stderr.write(`invalid --concurrency ${c}\n`);
    process.exit(64);
  }
  killOnSignal();
  const r = await runOnce({ showRoot, episodeId, runId, engineRoot, operator, ...(c !== undefined ? { concurrency: Number(c) } : {}) });
  process.stdout.write(`${r.status}: ${r.detail}\n`);
  process.exit(r.status === "waiting" || r.status === "completed" ? 0 : r.status === "failed" ? 1 : 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

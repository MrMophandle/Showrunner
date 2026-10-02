import path from "node:path";
import os from "node:os";
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  EventLog, run, runLogPaths, episodePipeline, loadShowConfig, createAgentExecutor, createGateMessageRenderer, sdkQuery, scriptExecutor,
  liveProcessGroups, killLiveProcessGroups, type Executors, type GateMessageRenderer, type RunResult,
} from "@showrunner/engine";

/** Which run segment to execute, and as whom. `engineRoot` locates the engine's `scripts/` and
 *  `render/` directories for the pipeline's script steps; `operator` becomes the run's `trigger`,
 *  so the log records who started it. `concurrency` is how many ready agent steps one run may
 *  execute at once — the console's default is 7, which covers the review panel; everything that
 *  is not an agent step runs alone whatever it is set to. */
export interface WorkerOptions { showRoot: string; episodeId: string; runId: string; engineRoot: string; operator: string; concurrency?: number }

/** The contents of `<runs>/<runId>.lock` — the one fact the run log cannot state: whether a
 *  process is running this run right now. `groups` are the process-group ids of the worker's live
 *  script children, refreshed on every beat, so the console can kill a render the worker is
 *  supervising without having to go looking for it. */
export interface LockFile { pid: number; startedAt: string; heartbeatAt: string; groups: number[] }

/** The seams a test replaces. Production passes none of them: `executors` and `renderGateMessage`
 *  default to the real ones built from the show config, `heartbeatMs` to five seconds, `now` to
 *  the clock. `onHeartbeat` is observation only — it is called with the body of each beat,
 *  including the immediate first one. */
export interface WorkerDeps { executors?: Executors; renderGateMessage?: GateMessageRenderer; heartbeatMs?: number; now?: () => Date; onHeartbeat?: (lock: LockFile) => void }

/** What one segment came to. Three of the four are states the run log already records and the
 *  console re-derives from it; "crashed" is the one it cannot — a rejected `run()` or a lock held
 *  by another worker — and `detail` is the only account of it outside the worker log. */
export type WorkerOutcome = { status: "waiting" | "completed" | "failed" | "crashed"; detail: string };

/** The lock lives beside the log it guards; both are named by the run id. */
export function lockPath(showRoot: string, episodeId: string, runId: string, productionDir = "Production"): string {
  return EventLog.logPath(showRoot, episodeId, runId, productionDir).replace(/\.jsonl$/, ".lock");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Takes the run's lock or says who holds it. The lock is created with `wx`, so two workers
 *  racing for one run cannot both win; a lock whose pid is dead belongs to a worker that died
 *  without its `finally`, and is removed and retaken. The lock is the one fact the log cannot
 *  state — whether anyone is running this run right now. */
async function takeLock(file: string, now: Date): Promise<{ ok: true } | { ok: false; holder: number }> {
  await mkdir(path.dirname(file), { recursive: true });
  const body = (): string => JSON.stringify({ pid: process.pid, startedAt: now.toISOString(), heartbeatAt: now.toISOString(), groups: [] } satisfies LockFile);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await open(file, "wx");
      await h.writeFile(body(), "utf8");
      await h.close();
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: LockFile | undefined;
      try { holder = JSON.parse(await readFile(file, "utf8")) as LockFile; } catch { holder = undefined; }
      if (holder && alive(holder.pid)) return { ok: false, holder: holder.pid };
      await rm(file, { force: true });
    }
  }
  return { ok: false, holder: -1 };
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

  // The latest beat is held as a promise so the release in `finally` can wait for it. A write
  // still in flight when the lock file is removed would land after the removal and recreate the
  // lock, leaving the run looking held by a worker that has already exited.
  let beat: Promise<void> = Promise.resolve();
  let heartbeat: NodeJS.Timeout | undefined;
  // One `startedAt` for the life of the worker — the moment it took the lock, which is what the
  // field means. Recomputing it on every beat made it a second copy of `heartbeatAt` that happens
  // to be spelled differently, and a lock whose `startedAt` moves says nothing about how long the
  // worker has held the run.
  const startedAt = tookAt.toISOString();
  const tmpFile = `${lockFile}.tmp`;

  /** One beat: write the body to `<lockFile>.tmp` and rename it over the lock.
   *
   *  `writeFile` on the lock itself opens with `O_TRUNC` and then writes, so between those two
   *  syscalls the lock is zero bytes — which `readLock` reads as "no lock" by design, every five
   *  seconds, for the life of the run. Two things follow from that microsecond: the Board can read
   *  a running episode as crashed, and `spawnWorker`'s refusal does not fire, so a second worker
   *  starts and its `takeLock` finds the same truncated file, cannot parse it, deletes it and
   *  takes the lock. Rename within one directory is atomic: a reader resolving the lock's name
   *  gets the previous beat whole or this one whole, and the lock's path is never empty, so
   *  `takeLock`'s `wx` still refuses a second worker throughout. */
  const writeBeat = async (): Promise<void> => {
    const body: LockFile = { pid: process.pid, startedAt, heartbeatAt: now().toISOString(), groups: liveProcessGroups() };
    deps.onHeartbeat?.(body);
    await writeFile(tmpFile, JSON.stringify(body), "utf8");
    await rename(tmpFile, lockFile);
  };

  try {
    // The first beat at once, so a reader never sees a lock without `groups` — and inside the
    // `try`, so a write that throws still reaches the release below rather than leaving a lock
    // behind with no worker.
    await writeBeat();
    heartbeat = setInterval(() => { beat = writeBeat().catch(() => undefined); }, deps.heartbeatMs ?? 5000);
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
    if (heartbeat !== undefined) clearInterval(heartbeat);
    await beat;
    await rm(lockFile, { force: true });
    // A beat that failed between its write and its rename leaves the temporary file behind; it is
    // the worker's own and nothing else reads it, so it goes with the lock.
    await rm(tmpFile, { force: true });
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
  const stop = () => { const { killed, failed } = killLiveProcessGroups(); process.stderr.write(`signalled: killed ${killed} process groups, ${failed} refused\n`); process.exit(143); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  const r = await runOnce({ showRoot, episodeId, runId, engineRoot, operator, ...(c !== undefined ? { concurrency: Number(c) } : {}) });
  process.stdout.write(`${r.status}: ${r.detail}\n`);
  process.exit(r.status === "waiting" || r.status === "completed" ? 0 : r.status === "failed" ? 1 : 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

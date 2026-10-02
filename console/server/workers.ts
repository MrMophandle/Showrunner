import path from "node:path";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { EventLog, RUN_ID, parseEpisodeId } from "@showrunner/engine";
import { lockPath, type LockFile } from "../worker/main.js";
import type { ShowContext } from "./show.js";

/** The server's whole relationship with a running episode: it starts a worker and it reads the
 *  lock that worker writes. It does not supervise one. A run belongs to the detached process
 *  holding its lock, and this server may be restarted, upgraded or killed without that run
 *  noticing — which is the point of spawning detached in the first place.
 *
 *  The one exception is `killRecordedGroups`, and even that kills only process groups a lock
 *  recorded, at an operator's explicit request (Task 5's "continue after a crash"): never the
 *  worker, never a group the server went looking for itself. */

/** A lock as a reader sees it: the file's own fields plus this reader's verdict on the pid. */
export type LockReading = LockFile & { alive: boolean };

/** The three files a run owns, all named by the run id and all validated on the way: the log,
 *  the lock beside it, and the file a spawned worker's stdout and stderr land in. Both ids are
 *  checked by `EventLog.logPath` before any of them is built, so a `..` in either cannot put a
 *  run's files outside the episode. */
function runFiles(ctx: ShowContext, episodeId: string, runId: string): { log: string; lock: string; out: string; runsDir: string } {
  const log = EventLog.logPath(ctx.showRoot, episodeId, runId, ctx.productionDir);
  return {
    log,
    lock: lockPath(ctx.showRoot, episodeId, runId, ctx.productionDir),
    out: log.replace(/\.jsonl$/, ".worker.out"),
    runsDir: path.dirname(log),
  };
}

/** Whether a pid is held by a live process. EPERM means the process exists and belongs to
 *  someone else, which is still alive; only ESRCH means gone. The same test the worker applies
 *  to a lock it finds, so the two agree on what "held" means. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The run's lock, with a verdict on whether its worker is still there — or undefined when there
 *  is no lock, which is every run that is not being worked on. A lock the reader cannot parse is
 *  reported as absent rather than as an error: a half-written lock is a worker that is mid-beat,
 *  and the next read will see it whole. */
export async function readLock(ctx: ShowContext, episodeId: string, runId: string): Promise<LockReading | undefined> {
  const { lock } = runFiles(ctx, episodeId, runId);
  let text: string;
  try { text = await readFile(lock, "utf8"); } catch { return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Partial<LockFile>;
  if (typeof raw.pid !== "number") return undefined;
  return {
    pid: raw.pid,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    heartbeatAt: typeof raw.heartbeatAt === "string" ? raw.heartbeatAt : "",
    groups: Array.isArray(raw.groups) ? raw.groups.filter((g): g is number => typeof g === "number") : [],
    alive: alive(raw.pid),
  };
}

/** Starts a worker for one run and forgets about it. Three things make this the server's whole
 *  involvement: `detached: true` puts the worker in its own process group, so killing or
 *  restarting the console cannot take a four-hour render with it; `stdio` points at a file, so
 *  the worker's output survives the server; and `unref()` means the server can exit while the
 *  worker runs.
 *
 *  Refuses when a live lock holds the run. The worker would refuse too — `takeLock` is the real
 *  guard against two workers on one run — but the worker's refusal is a line in a log file,
 *  while this one is the message the operator reads. */
export async function spawnWorker(ctx: ShowContext, episodeId: string, runId: string): Promise<{ pid: number }> {
  parseEpisodeId(episodeId);
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)}: expected [A-Za-z0-9_-]+`);
  const held = await readLock(ctx, episodeId, runId);
  if (held?.alive) throw new Error(`run ${runId} is held by pid ${held.pid}`);

  const { out, runsDir } = runFiles(ctx, episodeId, runId);
  await mkdir(runsDir, { recursive: true });
  const [cmd, ...entry] = ctx.workerCommand;
  if (cmd === undefined) throw new Error("workerCommand is empty: nothing to spawn");
  // Appended, not truncated: a run that is resumed three times keeps all three workers' output
  // in one file, in order, which is the only record of a worker that died before it could log.
  const fd = openSync(out, "a");
  try {
    const argv = [...entry, "--show", ctx.showRoot, "--episode", episodeId, "--run", runId, "--engine-root", ctx.engineRoot, "--operator", ctx.operator];
    const child = spawn(cmd, argv, { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    if (child.pid === undefined) throw new Error(`worker did not start: ${[cmd, ...entry].join(" ")}`);
    return { pid: child.pid };
  } finally {
    // The child holds its own duplicate of the descriptor, so the parent's copy is closed at
    // once; leaving it open would leak one descriptor per launch for the life of the server.
    closeSync(fd);
  }
}

/** SIGTERMs the process groups a lock recorded — the script children a dead worker was
 *  supervising, which outlive it because they are in their own groups. Used by Task 5's
 *  "continue after a crash", never on its own initiative.
 *
 *  A group id of 0, 1 or a negative number is refused rather than signalled: `process.kill(-0)`
 *  signals the caller's own group and `process.kill(-1)` signals every process the user owns,
 *  so a lock with a malformed `groups` entry could otherwise take down the operator's whole
 *  session, the console included. */
export function killRecordedGroups(lock: LockFile): { killed: number; failed: number } {
  let killed = 0;
  let failed = 0;
  for (const group of lock.groups) {
    if (!Number.isInteger(group) || group <= 1 || group === process.pid) { failed++; continue; }
    try { process.kill(-group, "SIGTERM"); killed++; } catch { failed++; }
  }
  return { killed, failed };
}

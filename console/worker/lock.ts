import path from "node:path";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { killLiveProcessGroups, liveProcessGroups } from "@showrunner/engine";

/** The run lock: the one fact a run log cannot state — whether a process is running this run right
 *  now — and the three pieces of machinery that keep it honest. Taking it with `wx` so two workers
 *  cannot both win, beating it every few seconds so a reader can tell a live worker from a dead
 *  one, and removing it on the way out, including on a signal.
 *
 *  **Extracted here because there are two worker entries, not one** (ruling H-13). `worker/main.ts`
 *  runs an episode's pipeline and `worker/setup.ts` runs one bible file's, and the two differ in
 *  five decisions — which log, which lock path, which pipeline, which prompts directory, which
 *  prior logs — and in nothing about locking. A `--setup` branch inside the episode worker would
 *  have put five chances of taking an episode code path into the interview; two entries over one
 *  lock module puts none, and the lock's rules are stated once.
 *
 *  Nothing here knows what an episode or a bible file is. It is given a path and a clock. */

/** The contents of `<runs>/<runId>.lock`. `pid` is the worker holding the run and `heartbeatAt` is
 *  the last beat it wrote, so a reader can tell a working worker from one that died without its
 *  `finally`. `startedAt` is the moment the lock was taken and never moves afterwards: a
 *  `startedAt` that moved on every beat would be a second copy of `heartbeatAt` spelled
 *  differently, and would say nothing about how long the worker has held the run. `groups` are the
 *  process-group ids of the worker's live script children, refreshed on every beat, so the console
 *  can kill a render the worker is supervising without having to go looking for it. */
export interface LockFile { pid: number; startedAt: string; heartbeatAt: string; groups: number[] }

/** The seams a test replaces in the heartbeat. Production passes none of them: `heartbeatMs`
 *  defaults to five seconds and `now` to the clock. `onHeartbeat` is observation only — it is
 *  called with the body of each beat, including the immediate first one. Declared here rather than
 *  in either entry because both entries' `Deps` carry exactly these three and a second declaration
 *  would be two defaults for one interval. */
export interface HeartbeatDeps { heartbeatMs?: number; now?: () => Date; onHeartbeat?: (lock: LockFile) => void }

/** A running heartbeat: the `startedAt` it stamps on every beat, and the release that ends it.
 *  `release()` is what a `finally` calls — it stops the interval, waits for the beat in flight and
 *  removes the lock — and it is safe to call twice. */
export interface Heartbeat { startedAt: string; release(): Promise<void> }

/** The lock that guards one run log: the log's own path with `.jsonl` replaced by `.lock`.
 *
 *  One function for the one rule "the lock lives beside the log it guards, and both are named by
 *  the run id", because the two entries build their log paths differently — an episode's through
 *  `EventLog.logPath`, a bible file's by joining the run id onto `bibleLogDir`, which
 *  `EventLog.logPath` cannot build at all since it validates the episode id and the reserved setup
 *  id is not one. The naming rule must not differ with them: a reader looks for the lock beside the
 *  log, and a worker that wrote it anywhere else would be a worker nobody could see. */
export function lockFileFor(logFile: string): string {
  return logFile.replace(/\.jsonl$/, ".lock");
}

/** Whether a pid is held by a live process. EPERM means the process exists and belongs to someone
 *  else, which is still alive; only ESRCH means gone. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** One lock as a reader sees it — the file's own fields plus this reader's verdict on the pid — or
 *  `undefined` when there is no lock, which is every run nobody is working on.
 *
 *  A lock the reader cannot parse is reported as absent rather than as an error: a half-written
 *  lock is a worker mid-beat, and the next read will see it whole.
 *
 *  Exported because the server reads setup locks too. `server/workers.ts` reads an episode run's
 *  lock through a path it builds from two validated episode ids; a bible file's lock is beside its
 *  own log under the reserved setup id, which that path builder refuses, so the store needs the
 *  parse on its own — and the parse is the lock format's, which lives here with the format. */
export async function readLockFile(file: string): Promise<(LockFile & { alive: boolean }) | undefined> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return undefined; }
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

/** Takes the run's lock or says who holds it. The lock is created with `wx`, so two workers racing
 *  for one run cannot both win; a lock whose pid is dead belongs to a worker that died without its
 *  `finally`, and is removed and retaken. The lock is the one fact the log cannot state — whether
 *  anyone is running this run right now. */
export async function takeLock(file: string, now: Date): Promise<{ ok: true } | { ok: false; holder: number }> {
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

/** Starts beating a lock this process already holds, and returns the release.
 *
 *  **Each beat writes the body to `<lockFile>.tmp` and renames it over the lock.** `writeFile` on
 *  the lock itself opens with `O_TRUNC` and then writes, so between those two syscalls the lock is
 *  zero bytes — which a reader reads as "no lock" by design, every five seconds, for the life of
 *  the run. Two things follow from that microsecond: the Board can read a running episode as
 *  crashed, and `spawnWorker`'s refusal does not fire, so a second worker starts and its
 *  `takeLock` finds the same truncated file, cannot parse it, deletes it and takes the lock.
 *  Rename within one directory is atomic: a reader resolving the lock's name gets the previous
 *  beat whole or this one whole, the lock's path is never empty, and `takeLock`'s `wx` still
 *  refuses a second worker throughout.
 *
 *  The first beat is written before this returns, so a reader never sees a lock without `groups`.
 *  **A first beat that fails removes the lock before it rethrows**, because a caller that never
 *  received a `release` has no `finally` that could: the lock would otherwise be left behind with
 *  no worker, and every later launch of that run refused by a process that is gone.
 *
 *  `release()` waits for the beat in flight before removing the lock. A write still in flight when
 *  the lock file is removed would land after the removal and recreate the lock, leaving the run
 *  looking held by a worker that has already exited. It also removes `<lockFile>.tmp`: a beat that
 *  failed between its write and its rename leaves it behind, it is the worker's own and nothing
 *  else reads it, so it goes with the lock. */
export async function startHeartbeat(lockFile: string, tookAt: Date, deps: HeartbeatDeps = {}): Promise<Heartbeat> {
  const now = deps.now ?? ((): Date => new Date());
  // One `startedAt` for the life of the worker: the moment it took the lock, which is what the
  // field means.
  const startedAt = tookAt.toISOString();
  const tmpFile = `${lockFile}.tmp`;
  let beat: Promise<void> = Promise.resolve();
  let heartbeat: NodeJS.Timeout | undefined;

  const writeBeat = async (): Promise<void> => {
    const body: LockFile = { pid: process.pid, startedAt, heartbeatAt: now().toISOString(), groups: liveProcessGroups() };
    deps.onHeartbeat?.(body);
    await writeFile(tmpFile, JSON.stringify(body), "utf8");
    await rename(tmpFile, lockFile);
  };

  try {
    await writeBeat();
  } catch (err) {
    await rm(lockFile, { force: true });
    await rm(tmpFile, { force: true });
    throw err;
  }
  heartbeat = setInterval(() => { beat = writeBeat().catch(() => undefined); }, deps.heartbeatMs ?? 5000);

  return {
    startedAt,
    release: async (): Promise<void> => {
      if (heartbeat !== undefined) { clearInterval(heartbeat); heartbeat = undefined; }
      await beat;
      await rm(lockFile, { force: true });
      await rm(tmpFile, { force: true });
    },
  };
}

/** Installs the signal handlers both entries share: SIGTERM and SIGINT kill the process groups of
 *  the worker's live script children, say how many went, and exit 143.
 *
 *  The children are killed and the worker does not wait for them: they are in their own process
 *  groups precisely so that the console can be restarted without taking them with it, so the one
 *  thing a signalled worker must not do is leave a renderer writing to a file the next worker will
 *  replay. The exit code is 143 — SIGTERM's conventional 128 + 15 — so a supervisor can tell a
 *  worker that was asked to stop from one that failed. */
export function killOnSignal(): void {
  const stop = (): void => {
    const { killed, failed } = killLiveProcessGroups();
    process.stderr.write(`signalled: killed ${killed} process groups, ${failed} refused\n`);
    process.exit(143);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

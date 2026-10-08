import path from "node:path";
import os from "node:os";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BIBLE_FILES, EventLog, RUN_ID, SETUP_ID, bibleFilePipeline, bibleLogDir, createAgentExecutor,
  createGateMessageRenderer, loadShowConfig, run, scriptExecutor, sdkQuery,
  type BibleFile, type Executors, type GateMessageRenderer, type QueryFn, type RunResult,
} from "@showrunner/engine";
import { buildVars, interviewPromptsDir } from "@showrunner/tools";
import { killOnSignal, lockFileFor, startHeartbeat, takeLock, type HeartbeatDeps } from "./lock.js";
import type { WorkerOutcome } from "./main.js";

/** The second worker entry: one bible file's interview pipeline, run detached, exactly as the
 *  episode worker runs one segment of an episode (rulings H-04 and H-13).
 *
 *  **Why a second entry and not a `--setup <key>` mode.** The episode worker hard-codes the
 *  episode shape at five lines — the lock path, the log path, the pipeline, the agent options and
 *  the prior logs (inventory §3.8) — and a branch at each of those five is five chances for a
 *  setup run to take an episode code path. All five are different here, and nothing else is: the
 *  lock, the heartbeat and the signal handling come from `worker/lock.ts`, shared.
 *
 *  **Why the interview's writing step runs here at all.** `runInit` cannot run in the server: it
 *  builds the real SDK executors, spawns `git` and `gh`, and the `write` step's declared bound is
 *  twenty minutes a file across thirteen files (inventory §3.6, §3.7). A browser form submission
 *  cannot hold that open, and spec §4.2's rule is that the server owns no run — a console restart
 *  must not kill an interview any more than it kills a render. So the server writes `answers.md`,
 *  creates the log and spawns this process, which then owns the run.
 *
 *  **What it does not do.** It never asks the author anything. The interview's 52 questions happen
 *  before any run, in the browser, and are recorded in `answers.md`; the gate is answered the way
 *  an episode gate is — the engine's `answerGate` and then a fresh one of these (the comment at
 *  `tools/src/init/interview.ts` says so: "the same two steps the console takes"). A detached
 *  worker cannot call `io.ask`, and it is never asked to. */

/** Which bible file to write, and as whom. `key` is one of the fifteen `BIBLE_FILES` keys and
 *  `runId` names the log this segment appends to; both are validated before either reaches a path.
 *  `engineRoot` is carried for symmetry with the episode worker and because a bible pipeline may
 *  one day want a script step; `operator` becomes the run's `trigger`, so the log records who
 *  started the interview. There is no `concurrency`: a bible file's pipeline is at most two steps
 *  and never two agent steps at once. */
export interface SetupWorkerOptions { showRoot: string; key: string; runId: string; engineRoot: string; operator: string }

/** The seams a test replaces, the same shape as the episode worker's `WorkerDeps`: `executors` and
 *  `renderGateMessage` default to the real ones built from the show config and the interview's own
 *  prompts, and the three heartbeat seams come from `lock.ts`.
 *
 *  `query` is one seam the episode worker does not have, and it is here for one reason: it is the
 *  only way to run the **real** executors with no model behind them, which is the only way to
 *  prove that the prompt the writer step loads is the interview's `write.md` and not a file out of
 *  the show's own `prompts/`. A test that replaced `executors` wholesale would skip the very
 *  wiring that differs from the episode worker's. */
export interface SetupWorkerDeps extends HeartbeatDeps { executors?: Executors; renderGateMessage?: GateMessageRenderer; query?: QueryFn }

/** The `BIBLE_FILES` row for a key, or a refusal naming what is wrong with it.
 *
 *  **This is the bible key's fence** (spec §4.4), and it is applied before the key reaches a path
 *  or a process: the key becomes a directory name under `Production/setup/`, and the set it is
 *  checked against is a fifteen-row table in the engine, so there is nothing to sanitise — a key
 *  that is not in the table is refused outright and `..` is simply not one of the fifteen.
 *
 *  A `scaffold` row is refused too, for the reason `interviewFile` refuses it: the pipeline fills
 *  the continuity ledger and the voice registry, they have no gate, and a run over one of them
 *  would open a gate nobody can answer about a file the author is not meant to write.
 *
 *  Exported because the server applies the same fence at the edge of every bible route, and two
 *  spellings of "which keys exist" would be a route that accepts a key no worker will run. This is
 *  the lookup alone; `bibleEntry` below adds the refusal a run needs. */
export function bibleFileFor(key: string): BibleFile {
  const entry = BIBLE_FILES.find((b) => b.key === key);
  if (entry === undefined) {
    throw new Error(`no such bible file ${JSON.stringify(key)}: expected one of ${BIBLE_FILES.map((b) => b.key).join(", ")}`);
  }
  return entry;
}

/** The `BIBLE_FILES` row for a key that can be **interviewed** — `bibleFileFor` plus the scaffold
 *  refusal, which is the fence every run path applies.
 *
 *  A `scaffold` row is refused for the reason `interviewFile` refuses it: the pipeline fills the
 *  continuity ledger and the voice registry, they have no gate, and a run over one of them would
 *  open a gate nobody can answer about a file the author is not meant to write. The read paths use
 *  `bibleFileFor` instead, because a scaffold file is still one of the fifteen rows the Bible view
 *  draws and still a file the page can show. */
export function bibleEntry(key: string): BibleFile {
  const entry = bibleFileFor(key);
  if (entry.mode === "scaffold") {
    throw new Error(`${key} is a scaffold file: the pipeline fills it and it has no gate, so it is not interviewed`);
  }
  return entry;
}

/** A run id, validated against the engine's own alphabet, or the refusal the console words it
 *  with. Exported alongside `bibleEntry` so the two fences a setup path is built from are applied
 *  from one place. */
export function checkSetupRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)}: expected [A-Za-z0-9_-]+`);
}

/** One bible file's run log: `<productionDir>/setup/<key>/runs/<runId>.jsonl`.
 *
 *  Both ids are validated here, so the address is composed in exactly one place for the worker,
 *  the server and the store alike — the role `EventLog.logPath` plays for an episode, which it
 *  cannot play here: that function validates the episode id and the reserved setup id is not one
 *  (`engine/src/pipelines/bible.ts`). The run id is joined onto `bibleLogDir` by the caller for
 *  the same reason, and this is that caller. */
export function setupLogPath(showRoot: string, key: string, runId: string, productionDir = "Production"): string {
  bibleEntry(key);
  checkSetupRunId(runId);
  return path.join(bibleLogDir(showRoot, key, productionDir), `${runId}.jsonl`);
}

/** The lock beside one bible run's log, named by the run id — `lockFileFor` applied to
 *  `setupLogPath`, so a setup lock is found by the same rule an episode lock is. */
export function setupLockPath(showRoot: string, key: string, runId: string, productionDir = "Production"): string {
  return lockFileFor(setupLogPath(showRoot, key, runId, productionDir));
}

/** Every run id already under one bible file's log directory, ascending — `<runId>.jsonl` and
 *  nothing else, with the engine's run-id alphabet applied to the name. Lexical order is creation
 *  order, because `mintRunId` stamps the time into the id, so the last entry is the latest run.
 *  Empty for a file that has never been interviewed, and for a show whose directory does not exist
 *  yet, which is every file of a show before its first run.
 *
 *  Exported because three callers need the same list and the same filter: this worker's prior
 *  logs, the server's "is the latest run finished" refusal, and the store's tail of a directory it
 *  has just started watching. */
export async function listSetupRuns(showRoot: string, key: string, productionDir = "Production"): Promise<string[]> {
  let names: string[];
  try { names = await readdir(bibleLogDir(showRoot, key, productionDir)); } catch { return []; }
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => n.slice(0, -".jsonl".length))
    // `<runId>.troubleshooting.jsonl` also ends in .jsonl and is not a run log; its would-be run
    // id carries a dot, which RUN_ID refuses.
    .filter((id) => RUN_ID.test(id))
    .sort();
}

/** One segment of one bible file's interview: lock, build, `run()` once, release. Returns rather
 *  than throws for every outcome the log can state; "crashed" is the one it cannot — a rejected
 *  `run()`, a held lock, or a key or run id the fences refuse — and `<runId>.worker.log` carries
 *  its text.
 *
 *  **The fences are applied first, before the show config is read and before any path is built.**
 *  They are applied here as well as in `main()` because this is the function a caller calls: the
 *  entry's argv check protects the command line, and this one protects every other caller,
 *  including the test seam.
 *
 *  Exported as the test seam, mirroring the episode worker's `runOnce(opts, deps)` field for
 *  field, and sharing its `WorkerOutcome` rather than declaring a second one — two entries that
 *  meant different things by "crashed" would be two vocabularies in one console. */
export async function runSetupOnce(opts: SetupWorkerOptions, deps: SetupWorkerDeps = {}): Promise<WorkerOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  let entry: BibleFile;
  try {
    entry = bibleEntry(opts.key);
    checkSetupRunId(opts.runId);
  } catch (err) {
    return { status: "crashed", detail: err instanceof Error ? err.message : String(err) };
  }

  const show = await loadShowConfig(opts.showRoot);
  const productionDir = show.productionDir ?? "Production";
  const logFile = setupLogPath(opts.showRoot, opts.key, opts.runId, productionDir);
  const lockFile = lockFileFor(logFile);
  const workerLog = logFile.replace(/\.jsonl$/, ".worker.log");
  const note = async (line: string): Promise<void> => {
    await mkdir(path.dirname(workerLog), { recursive: true });
    await appendFile(workerLog, `${now().toISOString()} pid ${process.pid}: ${line}\n`);
  };

  const tookAt = now();
  const lock = await takeLock(lockFile, tookAt);
  if (!lock.ok) {
    const detail = `run ${opts.runId} is held by pid ${lock.holder}`;
    await note(detail);
    return { status: "crashed", detail };
  }
  const heartbeat = await startHeartbeat(lockFile, tookAt, deps);

  try {
    // The six variables the interview's three prompts render, built by the one function the
    // terminal builds them with: a seventh spelling of these keys here would be a prompt
    // rendering an empty string, which is the one failure a prompt does not announce.
    const vars = buildVars(opts.showRoot, entry, now(), productionDir);
    const pipeline = bibleFilePipeline({ entry, vars, productionDir });
    // `promptsDir` is the line that differs most from the episode worker. Without it the agent
    // executor resolves the **show's own** `prompts/` (`engine/src/agent-step.ts`), where
    // `write.md`, `gate.md` and `revise.md` do not exist: the interview's prompts ship with the
    // engine's templates because they are the setup's and not the show's.
    const agentOpts = { query: deps.query ?? sdkQuery, show, promptsDir: interviewPromptsDir() };
    const executors: Executors = deps.executors ?? { script: scriptExecutor, agent: createAgentExecutor(agentOpts) };
    const renderGateMessage = deps.renderGateMessage ?? createGateMessageRenderer(agentOpts);
    // Every earlier run of this file, oldest first, and never this run's own log: the runner reads
    // that one itself and appends to it as it goes, so handing it over as a prior log would put a
    // stale copy of it in the cache search.
    const priorLogs = (await listSetupRuns(opts.showRoot, opts.key, productionDir))
      .map((id) => path.join(bibleLogDir(opts.showRoot, opts.key, productionDir), `${id}.jsonl`))
      .filter((p) => p !== logFile)
      .map((p) => new EventLog(p));
    let result: RunResult;
    try {
      result = await run({
        pipeline,
        // The reserved id, which `run()` and the agent executor exempt from the episode-id
        // grammar — the one id this pipeline can run under.
        ctx: { runId: opts.runId, episodeId: SETUP_ID, showRoot: opts.showRoot, trigger: opts.operator },
        log: new EventLog(logFile), executors, priorLogs, renderGateMessage,
      });
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
  const showRoot = flag("show"); const key = flag("key"); const runId = flag("run");
  if (!showRoot || !key || !runId) {
    process.stderr.write("usage: setup-worker --show <root> --key <bibleKey> --run <runId> [--engine-root <path>] [--operator <name>]\n");
    process.exit(64);
  }
  // **The two fences, before anything else happens**: before the show config is read, before
  // `bibleLogDir` is joined, before any process is spawned. The key becomes a directory name and
  // the run id a file name, and this is the one place on the command line that can refuse them.
  try {
    bibleEntry(key);
    checkSetupRunId(runId);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(64);
  }
  const engineRoot = flag("engine-root") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const operator = flag("operator") ?? `console:${os.userInfo().username}`;
  killOnSignal();
  const r = await runSetupOnce({ showRoot, key, runId, engineRoot, operator });
  process.stdout.write(`${r.status}: ${r.detail}\n`);
  // The episode worker's codes, so one supervisor reads both: 0 for a segment that ended where the
  // log says it ended, 1 for a failed step, 2 for a crash.
  process.exit(r.status === "waiting" || r.status === "completed" ? 0 : r.status === "failed" ? 1 : 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

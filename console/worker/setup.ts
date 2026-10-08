import path from "node:path";
import os from "node:os";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BIBLE_FILES, EventLog, RUN_ID, SETUP_ID, bibleFilePipeline, bibleLogDir, createAgentExecutor,
  createGateMessageRenderer, loadShowConfig, run, scriptExecutor, sdkQuery,
  type BibleFile, type Event, type Executors, type GateMessageRenderer, type QueryFn, type RunResult,
  type ShowConfig,
} from "@showrunner/engine";
import {
  AUTHOR_NOTES, CAST_HEADING, CAST_KEY, IMPORT_NOTES_PREFIX, afterFileApproved, buildVars,
  castSectionOf, interviewPromptsDir, parseCast, readAnswers, type InterviewResult,
} from "@showrunner/tools";
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
 *  worker cannot call `io.ask`, and it is never asked to.
 *
 *  **What it does do beyond running the pipeline: the approved file's commit.** A run that ends
 *  `completed` is a bible file whose gate was approved, and this worker then calls
 *  `afterFileApproved` — the character sheets, `audio.mainCast` and the per-file commit — before it
 *  exits, inside the lock it already holds. That is the terminal `init`'s own order (`run()` writes
 *  `run_finished`, *then* the commit is taken), and keeping it here is what makes the two paths
 *  produce the same repository: the commit carries the log's last line, so no approved file leaves a
 *  modified `.jsonl` behind. It also leaves the server with nothing to commit, which is the
 *  direction spec §4.2 points — the server's writes are `answers.md`, the registry, a new show's
 *  scaffold, and the zero-byte log it creates before spawning. (Plan H's Task 5 text had the server
 *  make this commit in `answerBibleGate`; the ledger's ruling of 2026-10-07 moved it here.) */

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

/** One bible file's path relative to the show root, with the show's own canon directory in it.
 *  `BIBLE_FILES` writes every row as `Canon/<name>.md`; a show that renamed its canon directory in
 *  `showrunner.json` has it rewritten here, the way `bibleFilesFor` rewrites it for the
 *  `bible-ready` guard.
 *
 *  Exported because the worker and the server both address the file and must agree: the worker
 *  reads it for the cast of an approved `world-overview`, and the server serves it through the one
 *  bible file route.
 */
export function bibleFileRelative(entry: BibleFile, canonDir?: string): string {
  return entry.file.replace(/^Canon\//, `${canonDir ?? "Canon"}/`);
}

/** How an approved bible file came to be approved, read from the notes on the approving
 *  `gate_answered` — `undefined` when the run holds no approval at all.
 *
 *  The notes are the only record of which of the gate's four answers was given: nothing for a plain
 *  approval, `imported from <path>` for an import, and `the author writes this file` when the author
 *  took the file over. Both readers need the same mapping and get it here: this worker words the
 *  commit's subject from it (`canon: <file> — <outcome>`, as the terminal does), and the server's
 *  Bible row reports it as the file's state. Two copies of this test would be a file that read
 *  `imported` in the browser and `approved` in its own git history.
 *
 *  Read backwards, so a file rejected twice and then approved reports the approval. */
export function approvalOutcome(events: Event[]): InterviewResult["outcome"] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind !== "gate_answered" || e.payload["approved"] !== true) continue;
    const notes = String(e.payload["notes"] ?? "");
    if (notes === AUTHOR_NOTES) return "written-by-author";
    if (notes.startsWith(IMPORT_NOTES_PREFIX)) return "imported";
    return "approved";
  }
  return undefined;
}

/** The cast an approved `world-overview` yields, for `afterFileApproved` to turn into character
 *  sheets and `audio.mainCast` — and `undefined` for every other file, which has no cast to record.
 *
 *  The order of preference is `interviewFile`'s own: the author's typed answer under
 *  `## The primary cast`, then that section of the file on disk when the answer is empty, which is
 *  the imported file's case and the "I will write it myself" case. Parsed by the one grammar
 *  `@showrunner/tools` declares, never a second one here: a parser that disagreed would either drop
 *  a name `writeCastSheets` accepts or hand it one it throws on.
 *
 *  An empty list is still a list and is still passed, because that is what the terminal does for a
 *  `world-overview` whose cast question went unanswered: it rewrites `audio.mainCast` to the
 *  narrator alone rather than leaving the scaffold's placeholder in the config. */
async function castForApproval(showRoot: string, entry: BibleFile, show: ShowConfig, productionDir: string): Promise<{ name: string; line: string }[] | undefined> {
  if (entry.key !== CAST_KEY) return undefined;
  const answers = await readAnswers(showRoot, entry, productionDir);
  const typed = answers[CAST_HEADING];
  if (typed !== undefined && typed.trim() !== "") {
    const listed = parseCast(typed);
    if (listed.cast.length > 0) return listed.cast;
  }
  const inFile = await castSectionOf(path.join(showRoot, bibleFileRelative(entry, show.canonDir)));
  return inFile?.cast ?? [];
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
  const segment = await runSegment(opts, deps);
  if (segment.outcome.status !== "completed" || segment.commit === undefined) return segment.outcome;
  const commit = await segment.commit();
  if (commit.ok) return segment.outcome;
  await segment.note(commit.error);
  return { status: "crashed", detail: commit.error };
}

/** The locked part of one segment: take the lock, build, `run()` once, release. Split out so that
 *  the approval's commit — which stages the directory the lock sits in — happens after the release;
 *  `commitApproval` records why that matters. `note` is handed back so the caller can write the
 *  commit's own failure into the same worker log. */
async function runSegment(opts: SetupWorkerOptions, deps: SetupWorkerDeps): Promise<{
  outcome: WorkerOutcome;
  note: (line: string) => Promise<void>;
  commit?: () => Promise<{ ok: true; commits: string[] } | { ok: false; error: string }>;
}> {
  const now = deps.now ?? ((): Date => new Date());
  let entry: BibleFile;
  try {
    entry = bibleEntry(opts.key);
    checkSetupRunId(opts.runId);
  } catch (err) {
    // Refused before a path exists, so there is no worker log to write into: the refusal is the
    // return value and the entry writes it to stderr.
    return { outcome: { status: "crashed", detail: err instanceof Error ? err.message : String(err) }, note: async () => undefined };
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
    return { outcome: { status: "crashed", detail }, note };
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
      return { outcome: { status: "crashed", detail }, note };
    }
    const detail = result.status === "waiting" ? `waiting at ${result.gate.stepId} (attempt ${result.gate.attempt})`
      : result.status === "failed" ? `failed at ${result.stepId}: ${result.error}` : "completed";
    await note(detail);
    // The note goes in before the commit below, never after it: `commitPaths` names this run's log
    // directory, so a line appended afterwards would leave `<runId>.worker.log` modified in the
    // very commit the line is about. The sha is in git, which is where a sha belongs.
    if (result.status !== "completed") return { outcome: { status: result.status, detail }, note };
    await note(`committing the approval of ${bibleFileRelative(entry, show.canonDir)}`);
    return {
      outcome: { status: result.status, detail },
      note,
      commit: () => commitApproval(opts, entry, show, productionDir, logFile),
    };
  } finally {
    await heartbeat.release();
  }
}

/** The approval's own work, after the run that produced it has completed: the character sheets,
 *  `audio.mainCast` and the per-file commit, through `afterFileApproved`.
 *
 *  **Taken after the lock is released, which is the one ordering subtlety here.** The commit stages
 *  the run's whole log directory (`commitPaths`, `tools/src/init/init.ts`), and the lock lives in
 *  that directory: committing while holding it would put `<runId>.lock` — a statement that some pid
 *  is running this run — into the show's history, and the `finally` that removes the lock a
 *  moment later would leave a tracked deletion staring at the operator forever. A lock is a process
 *  fact and never history. Nothing is at risk in the gap: the run is finished, its log is closed,
 *  and the only thing that spawns a worker for an existing run id is a gate answer, which
 *  `answerGate` refuses for a run with no open gate.
 *
 *  Returns the shas, or the refusal as a string. **A refusal leaves the file approved**: the run log
 *  says `completed` and nothing undoes that, so the Bible row still reads approved, imported or
 *  written-by-author — what is missing is the commit. The operator sees the reason in
 *  `<runId>.worker.log`, the worker exits 2 so a supervisor sees it too, and `git status` in the
 *  show shows the file, its answers and its log uncommitted. The remedy is the one the terminal
 *  already has for an interview interrupted between its approval and its commit:
 *  `showrunner-init --resume` makes the catch-up commit for an approved file that was never
 *  committed, or the operator commits the three paths by hand. */
async function commitApproval(
  opts: SetupWorkerOptions, entry: BibleFile, show: ShowConfig, productionDir: string, logFile: string,
): Promise<{ ok: true; commits: string[] } | { ok: false; error: string }> {
  try {
    const outcome = approvalOutcome(await new EventLog(logFile).read()) ?? "approved";
    const cast = await castForApproval(opts.showRoot, entry, show, productionDir);
    const approved: InterviewResult = {
      key: opts.key, outcome, runId: opts.runId,
      // `applyApproval` unions this with `commitPaths`, which already names the file, the answers,
      // this log directory and — for `world-overview` — `showrunner.json` and the characters
      // directory. Naming the file here as well costs nothing and says what changed.
      commits: [bibleFileRelative(entry, show.canonDir)],
      ...(cast !== undefined ? { cast } : {}),
    };
    return { ok: true, commits: await afterFileApproved(opts.showRoot, entry, approved, { operator: opts.operator }) };
  } catch (err) {
    return { ok: false, error: `the run completed but the approval could not be committed: ${err instanceof Error ? err.message : String(err)}` };
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

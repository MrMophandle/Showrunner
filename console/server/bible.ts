import path from "node:path";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BIBLE_FILES, EventLog, answerGate, answersPath, mintRunId, deriveRunState,
  type BibleFile, type Event, type RunState,
} from "@showrunner/engine";
import {
  AUTHOR_NOTES, IMPORT_NOTES_PREFIX, initFinish, isApproved, questionsFor, readAnswers,
  resolveImport, templateWithoutQuestions, templatesDir, writeAnswers,
  type FinishResult, type GateChoice, type InitIO,
} from "@showrunner/tools";
import {
  approvalNotes, approvalOutcome, bibleEntry, bibleFileFor, bibleFileRelative, checkSetupRunId,
  listSetupRuns, setupLockPath, setupLogPath,
} from "../worker/setup.js";
import { readLockFile } from "../worker/lock.js";
import type { BibleFileView, BibleRow, BibleState } from "../shared/types.js";
import { deriveRunStatus, type RunStore } from "./runs.js";
import type { ShowContext } from "./show.js";

/** The Bible view's own projection, its one file fence, the author's answers, and the four gate
 *  answers — the server half of the New-show surface.
 *
 *  **Why this is a route family and a projection of its own** (ruling H-07). The interview runs
 *  under the engine's reserved id `setup`, which `parseEpisodeId` refuses: `episodePipeline`,
 *  `latestRunId`, `listRuns`, `EventLog.logPath` and `RunStore.view` all throw on it, and making it
 *  a first-class id would have meant twenty-seven conditional sites plus a `Canon/` branch in the
 *  artifact fence (inventory §4.4). Even exempted, the episode projection would describe a
 *  two-step bible run as a sixty-eight-step episode with every step pending, and `gateArtifacts`
 *  returns `[]` for a gate whose id is the literal `gate`. So: four routes and a small projection,
 *  with the episode's twenty-seven sites untouched.
 *
 *  **What the server writes here, and nothing else** (spec §4.2, the plan's Global Constraints):
 *  `Production/setup/<key>/answers.md`, as a one-shot write like `premise.md`; the zero-byte run
 *  log a start creates before it spawns; and the file a gate answer *is* (the house template for
 *  "I will write it myself", the copy for an import, and a default file's template before its first
 *  gate). Those three are the console's **only** writes under `Canon/`, and they are named in every
 *  list of the server's writes — the root `README.md`, `console/README.md` and
 *  `console/worker/setup.ts` — because a list that omitted them invited two mistakes: moving the
 *  writes somewhere else to "restore" a rule they never broke, and believing a read-only show's
 *  `Canon/` is unreachable for some reason other than the middleware's 403.
 *
 *  Every event in a run log is written by the detached worker or by the engine's `answerGate`.
 *  **No `git` process runs in this server for a run at all**: the approved file's commit is the
 *  setup worker's, taken after its run completes, which is the terminal `init`'s own order (the
 *  ledger's ruling of 2026-10-07; `worker/setup.ts` carries the argument). No agent and no step
 *  runs here either, because the server owns no run.
 *
 *  **The two setup-time exceptions, and why they are in the server on purpose.** `finishBible` calls
 *  `initFinish`, which spawns `git remote`, `gh auth status` and `gh repo create --source --push`;
 *  `POST /api/shows` calls `initScaffold`, which runs `git init` and the scaffold commit. Both run
 *  here, in this process. Neither is a run: each is bounded — a handful of processes that finish in
 *  seconds, against no model and no twenty-minute step — so there is nothing for a console restart
 *  to orphan. And `gh repo create` is the one action in the whole setup that **cannot be retried
 *  under one name**: a second attempt answers "name already exists", so it must not be handed to a
 *  detached process nobody is watching, whose failure would be a line in a log file the author has
 *  no reason to open. The qualifier "for a run" is the one the two READMEs use, and it is the
 *  sentence that is true.
 *
 *  **Why the pieces of the interview come from `@showrunner/tools` and are never re-implemented
 *  here.** `resolveImport` is the import fence, `AUTHOR_NOTES` and `IMPORT_NOTES_PREFIX` the two
 *  strings a gate answer is recorded with and a row's state read back from, `writeAnswers` the
 *  answers file's shape. A second copy of any of them would be the copy that diverges, and the
 *  divergence would show up as a bible file approved in the browser that reads differently from one
 *  approved in the terminal — or, for the fence, as a symlink nobody refused. */

/** The seams the Bible routes are driven with. Production passes none: `setupWorkerCommand`
 *  defaults to this console's own compiled setup worker. A test points it at a fake that writes a
 *  log and exits, exactly as the episode tests point `ShowContext.workerCommand` at one. */
export interface BibleDeps {
  /** argv of the setup worker, as an array and never a shell string: `[executable, entry]`, to
   *  which the spawner appends the run's flags. */
  setupWorkerCommand?: string[];
}

/** The compiled setup worker entry, as a path relative to this module: `server/bible.ts` compiles
 *  to `dist/server/bible.js`, so the worker is one directory over at `dist/worker/setup.js`.
 *  Resolved from `import.meta.url` and not from `process.cwd()`, because the console is started
 *  from wherever the operator happens to be standing. */
function defaultSetupWorkerCommand(): string[] {
  return [process.execPath, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "setup.js")];
}

/** The bible file's path relative to the show root, through the one function the worker addresses
 *  it with, so the file the page serves and the file the commit names cannot differ. */
function relativeFile(ctx: ShowContext, entry: BibleFile): string {
  return bibleFileRelative(entry, ctx.show.canonDir);
}

/** **The one fence this task adds**: the absolute path of one bible file, and no other path, ever.
 *
 *  Two properties make it a fence rather than a filter. The key is looked up in `BIBLE_FILES`
 *  first, so a key that is not one of the fifteen is refused before any path exists — `..`,
 *  `refs.json` and a sibling file are not keys, so they are unreachable rather than stripped. And
 *  the path is composed entirely from that table and the show's config: **no byte of the request
 *  reaches it.** The route above it (`GET bible/:key/file`) has no path parameter at all, which is
 *  why there is nothing to traverse.
 *
 *  This is also the only place in the console that serves a file under `Canon/`. The artifact route
 *  cannot: `resolveArtifactPath` requires the path to begin `<episodesDir>/<id>/` or
 *  `<productionDir>/<id>/`, and the comment in `server/gates.ts` records that `Canon/` is kept out
 *  of that fence deliberately, even for `canon-gate`. */
export function bibleFilePath(ctx: ShowContext, key: string): string {
  // `bibleFileFor` and not `bibleEntry`: a scaffold file is one of the fifteen the page draws and
  // its file is the pipeline's own output, which the operator may want to read.
  const entry = bibleFileFor(key);
  return path.join(ctx.showRoot, relativeFile(ctx, entry));
}

/** The canon template one bible file is interviewed and written from: `<templatesDir()>/canon/<key>.md`.
 *  The engine's template and never the show's copy — the show has no copy of this one — and the key
 *  is validated by `bibleEntry` before it is joined. */
function canonTemplatePath(key: string): string {
  bibleFileFor(key);
  return path.join(templatesDir(), "canon", `${key}.md`);
}

/** One lock as `readLockFile` reports it, or `undefined` when nothing holds the run. Taken from
 *  the reader's own return type so the two cannot drift. */
type LockReading = Awaited<ReturnType<typeof readLockFile>>;

/** The latest run of one bible file, read from disk: the lexically last log under its runs
 *  directory, its events, the state they derive, and the lock beside it. `undefined` for a file
 *  that has never been interviewed, which is every file of a new show.
 *
 *  Read directly rather than through the `RunStore` because `bibleRows` has no store — the Board's
 *  fifteen rows are fifteen small reads of fifteen one-run logs, where going through the store
 *  would load every bible run the show has ever made into the cache to answer a question nobody
 *  asked. The view of one file does go through the store, which is what tails it. */
async function latestRun(ctx: ShowContext, entry: BibleFile): Promise<{ runId: string; events: Event[]; state: RunState; lock: LockReading } | undefined> {
  const runs = await listSetupRuns(ctx.showRoot, entry.key, ctx.productionDir);
  const runId = runs[runs.length - 1];
  if (runId === undefined) return undefined;
  let events: Event[];
  try {
    events = await new EventLog(setupLogPath(ctx.showRoot, entry.key, runId, ctx.productionDir)).read();
  } catch {
    // A log that cannot be parsed is a run whose state cannot be derived; the row says `failed`
    // rather than taking the whole Bible view down with it.
    events = [];
  }
  return {
    runId,
    events,
    state: deriveRunState(events),
    lock: await readLockFile(setupLockPath(ctx.showRoot, entry.key, runId, ctx.productionDir)),
  };
}

/** Whether a failed run failed because its gate was rejected its maximum ten times, rather than
 *  because a step broke. The engine writes `rejected <n> times` as the gate step's error
 *  (`engine/src/runner.ts`), which is the same string `init`'s `GATE_EXHAUSTED` matches to call a
 *  file stalled rather than failed. The distinction is the operator's next move: a stalled file is
 *  on disk as the fix agent last revised it and is theirs to finish, while a failed one is a run to
 *  start again. */
function exhausted(events: Event[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind !== "step_failed") continue;
    return /^rejected \d+ times?$/.test(String(e.payload["error"] ?? ""));
  }
  return false;
}

/** Where one bible file stands, from its row, its answers, its latest log and that log's lock —
 *  and deliberately **not** from whether the file is on disk, because a bible file can be on disk
 *  before anybody is interviewed about it: `initScaffold` writes the two `scaffold` files with the
 *  show itself, an `importFrom` copies whatever rows the source show happens to have, and a
 *  `default` file's house template is written before its first gate opens.
 *
 *  The run's status comes from `deriveRunStatus`, the same six-rule ladder the Board's rows and the
 *  Run page use, so a bible run and an episode run cannot come to disagree about what "running" or
 *  "crashed" means. The three approved states are told apart by the notes on the approving
 *  `gate_answered`, which is what makes a file approved in the terminal read identically to one
 *  approved in the browser.
 *
 *  A `scaffold` row never has a log — `startBibleRun` refuses it and the worker refuses it — so it
 *  stays `pending` for the life of the show, and its `mode` is what the page renders instead of a
 *  state ("the pipeline writes this one"). */
function bibleStateOf(
  answered: number,
  latest: { events: Event[]; state: RunState; lock: LockReading } | undefined,
): BibleState {
  if (latest === undefined) return answered > 0 ? "answering" : "pending";
  const status = deriveRunStatus(latest.state, latest.lock, latest.events.length);
  switch (status) {
    // The three approved states are the gate's own three outcomes, told apart by the notes on the
    // approving `gate_answered` — through `approvalOutcome`, the same function the setup worker
    // words its commit's subject from, so a file's row and its git history cannot disagree about
    // how it came to be approved. The names are identical by construction.
    case "completed": return approvalOutcome(latest.events) ?? "approved";
    case "waiting": return "gate";
    case "running": return "running";
    case "failed": return exhausted(latest.events) ? "stalled" : "failed";
    // A crash is a fact about a run, not about a file: the row says `failed` and the view's
    // `run.status` says `crashed`, which is what lets the page offer "start again" with the
    // worker's own account beside it.
    case "crashed": return "failed";
    // An empty log with no lock: a run that was created and whose worker has not written yet.
    default: return answered > 0 ? "answering" : "pending";
  }
}

/** One row of the Bible view **and** the latest run it was derived from, for one of the fifteen
 *  files.
 *
 *  Two values rather than one because `bibleFile` needs the run's events as well as the row: it
 *  reports the notes on the approving `gate_answered`, and reading the log a second time to find
 *  them would be two reads of one file per request and two chances for them to disagree. `bibleRow`
 *  below is this function with the events dropped, which is what the fifteen-row rail wants. */
async function bibleRowWith(
  ctx: ShowContext, entry: BibleFile,
): Promise<{ row: BibleRow; latest: Awaited<ReturnType<typeof latestRun>> }> {
  const questions = await questionsFor(entry);
  const answers = await readAnswers(ctx.showRoot, entry, ctx.productionDir);
  const answered = Object.keys(answers).length;
  // A scaffold file is never interviewed, so its directory is never read: the pipeline fills it.
  const latest = entry.mode === "scaffold" ? undefined : await latestRun(ctx, entry);
  const row: BibleRow = {
    key: entry.key,
    file: relativeFile(ctx, entry),
    mode: entry.mode,
    purpose: entry.purpose,
    state: bibleStateOf(answered, latest),
    questions: questions.length,
    answered,
  };
  if (latest !== undefined) {
    row.runId = latest.runId;
    if (latest.state.openGate !== undefined) row.attempt = latest.state.openGate.attempt;
  }
  return { row, latest };
}

/** One row of the Bible view, for one of the fifteen files. */
async function bibleRow(ctx: ShowContext, entry: BibleFile): Promise<BibleRow> {
  return (await bibleRowWith(ctx, entry)).row;
}

/** The fifteen rows of the Bible view, in interview order — the order an author can think in,
 *  which is `BIBLE_FILES`' own order and not alphabetical.
 *
 *  The rows are the engine's table and not the show's directory listing, so the view is the same
 *  fifteen rows for a show whose setup never ran, for one interviewed in the terminal, and for one
 *  interviewed in the browser. That is the whole point of deriving the state from the logs: ruling
 *  H-06 says a second visit continues an interview with no new persistence, and this is where that
 *  is cashed in. */
export async function bibleRows(ctx: ShowContext): Promise<BibleRow[]> {
  const rows: BibleRow[] = [];
  for (const entry of BIBLE_FILES) rows.push(await bibleRow(ctx, entry));
  return rows;
}

/** One bible file at the altitude the Bible page draws: the row, the questions with whatever is
 *  answered, the gate's message when a gate is open, the file itself, and the latest run as the
 *  store projects it.
 *
 *  The file's whole content is carried rather than a link to it, because the gate shows the file
 *  whole — `tools/src/init/main.ts` records why: "a bible file at its gate is printed whole … a
 *  pager would put the decision behind a program". `GET bible/:key/file` serves the same bytes for
 *  a raw view and for a client that would rather stream them. */
export async function bibleFile(ctx: ShowContext, key: string, store: RunStore): Promise<BibleFileView> {
  // Every one of the fifteen, scaffold rows included: the page links to each row, and a row the
  // rail draws and the view refuses would be a dead link. What a scaffold row cannot do — start a
  // run, answer a gate, hold answers — is refused by the actions, each of which is a POST.
  const entry = bibleFileFor(key);
  const { row, latest } = await bibleRowWith(ctx, entry);
  const questions = await questionsFor(entry);
  const answers = await readAnswers(ctx.showRoot, entry, ctx.productionDir);
  // The notes on the approving `gate_answered`, read off the events the row was already derived
  // from — the source path for an import, and the author's own sentence for "I will write it
  // myself". `approvalNotes` is the setup worker's, beside the `approvalOutcome` the row's state
  // comes from, so the page's note and the row's state cannot come to disagree about which answer
  // was given. Absent when there is no approval, or when the approval carried no notes.
  const note = latest === undefined ? undefined : approvalNotes(latest.events);
  const view: BibleFileView = {
    ...row,
    questionsList: questions.map((q) => ({ heading: q.heading, question: q.question, answer: answers[q.heading] ?? "" })),
    prior: row.answered > 0,
    ...(note !== undefined ? { note } : {}),
  };
  let content: string | undefined;
  try { content = await readFile(bibleFilePath(ctx, key), "utf8"); } catch { content = undefined; }
  if (content !== undefined) view.content = content;
  if (row.runId !== undefined) {
    const run = await store.setupView(key, row.runId);
    view.run = run;
    if (run.gate !== undefined) view.gateMessage = run.gate.message;
  }
  return view;
}

/** Writes the author's answers for one bible file and returns the path they landed at, relative to
 *  the show root.
 *
 *  **One of the server's four writes**, and the shape of it matters. `writeAnswers` rewrites the
 *  whole file — every heading the template declares, with `(blank)` under the questions that have
 *  no answer — because that is the shape the writer agent and `bible-check` both read. So the
 *  posted record is **merged over what is on disk** rather than written straight through: a
 *  heading the request carries wins, even when it is empty (the author cleared a textarea), and a
 *  heading the request does not carry keeps the answer it had. A straight write-through would have
 *  meant one form that posted a single field erasing the other eight answers — the failure
 *  `interviewFile`'s own `record()` guards against for the terminal. */
export async function saveAnswers(ctx: ShowContext, key: string, answers: Record<string, string>): Promise<string> {
  const entry = bibleFileFor(key);
  // A default file's gate is the author reading the house template and a scaffold file is the
  // pipeline's; neither asks anything, so answers for one are a mistake rather than a write —
  // `writeAnswers` would otherwise leave an answers file holding no questions at all.
  const questions = await questionsFor(entry);
  if (questions.length === 0) {
    throw new Error(`${key} asks no questions: it is a ${entry.mode} file, and its gate is the file itself`);
  }
  const prior = await readAnswers(ctx.showRoot, entry, ctx.productionDir);
  const merged: Record<string, string> = { ...prior };
  for (const [heading, text] of Object.entries(answers)) merged[heading] = text;
  return writeAnswers(ctx.showRoot, entry, merged, ctx.productionDir);
}

/** Starts a worker for one bible run and forgets about it — `spawnWorker`'s three properties, for
 *  the same three reasons: `detached: true` puts the worker in its own process group so a console
 *  restart cannot take a twenty-minute writer with it, `stdio` points at a file so its output
 *  survives the server, and `unref()` lets the server exit while the worker runs.
 *
 *  Refuses when a live lock holds the run. The worker would refuse too — `takeLock` is the real
 *  guard against two workers on one run, and it is what keeps two browser tabs from colliding
 *  (ruling H-04) — but the worker's refusal is a line in a log file, while this one is the message
 *  the operator reads. */
export async function spawnSetupWorker(ctx: ShowContext, key: string, runId: string, deps: BibleDeps = {}): Promise<{ pid: number }> {
  const logFile = setupLogPath(ctx.showRoot, key, runId, ctx.productionDir);
  const held = await readLockFile(setupLockPath(ctx.showRoot, key, runId, ctx.productionDir));
  if (held?.alive === true) throw new Error(`run ${runId} is held by pid ${held.pid}`);

  const command = deps.setupWorkerCommand ?? defaultSetupWorkerCommand();
  const [cmd, ...entry] = command;
  if (cmd === undefined) throw new Error("setupWorkerCommand is empty: nothing to spawn");
  const file = entry[0];
  // The same check `loadShowContext` makes for the episode worker, and for the same reason: under
  // `npm run dev` the server runs from TypeScript and `dist/worker/setup.js` does not exist, so a
  // spawn would start a Node process that exits at once with ERR_MODULE_NOT_FOUND while this
  // function reported a pid and the route answered 200.
  if (file !== undefined && !existsSync(file)) {
    throw new Error(`the setup worker is not built: run npm run build -w console`);
  }
  await mkdir(path.dirname(logFile), { recursive: true });
  // Appended, not truncated: a file whose gate is answered three times keeps all three workers'
  // output in one place, in order, which is the only record of a worker that died before it logged.
  const fd = openSync(logFile.replace(/\.jsonl$/, ".worker.out"), "a");
  try {
    const argv = [...entry, "--show", ctx.showRoot, "--key", key, "--run", runId, "--engine-root", ctx.engineRoot, "--operator", ctx.operator];
    const child = spawn(cmd, argv, { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    if (child.pid === undefined) throw new Error(`the setup worker did not start: ${command.join(" ")}`);
    return { pid: child.pid };
  } finally {
    closeSync(fd);
  }
}

/** Starts one bible file's writing step: mints a run id, creates its log, and spawns the setup
 *  worker on it.
 *
 *  **Refused unless the file's latest run is finished** — the launch route's three checks, in the
 *  same order and with the same wording, because the failure they prevent is the same: two workers
 *  writing one file. A run that is working, parked at its gate or crashed is a run whose output the
 *  next worker would write over.
 *
 *  **Refused for an interview file with no answers**, because `answers.md` is the `write` step's
 *  one declared input and a writer run from an empty file would produce a bible file invented from
 *  nothing, charged at the writer model's rate.
 *
 *  **A default file's template is written first if it is absent**, with `wx`, exactly as
 *  `interviewFile` writes it: a default file's gate *is* the author reading that file, so there has
 *  to be one. `wx` keeps a second start from overwriting a revision the fix agent has since made.
 *
 *  **The log is created before the spawn, with `wx` and zero bytes**, which is what makes the
 *  refusal above reachable at all: a worker writes its first line only after Node has started and
 *  the config is read, and in that half-second a second start would see no latest run and skip
 *  every check. An empty log is unfinished, so the second start is refused by the same check as a
 *  crash. A spawn that fails takes the log with it, for the reason the launch route records: left
 *  behind it would be the file's latest run, empty and so unfinished, refusing every later start.
 *
 *  A read-only show never reaches here: the show middleware refuses every POST under it with 403. */
export async function startBibleRun(ctx: ShowContext, key: string, deps: BibleDeps = {}): Promise<{ runId: string; pid: number }> {
  const entry = bibleEntry(key);
  const latest = await latestRun(ctx, entry);
  if (latest !== undefined) {
    if (latest.lock?.alive === true) throw new Error(`run ${latest.runId} is held by pid ${latest.lock.pid}`);
    if (latest.state.openGate !== undefined) throw new Error(`answer the gate on run ${latest.runId} first`);
    if (!latest.state.finished) throw new Error(`run ${latest.runId} is not finished; answer its gate, or wait for the worker that is writing it`);
  }
  if (entry.mode === "interview") {
    const answers = await readAnswers(ctx.showRoot, entry, ctx.productionDir);
    if (Object.keys(answers).length === 0) {
      throw new Error(`answer ${key}'s questions first: ${answersPath(key, ctx.productionDir)} holds no answers, and it is the writer's one input`);
    }
  } else {
    const destination = bibleFilePath(ctx, key);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, templateWithoutQuestions(await readFile(canonTemplatePath(key), "utf8")), { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  let runId: string | undefined;
  let logFile: string | undefined;
  for (let attempt = 0; attempt < 3 && runId === undefined; attempt++) {
    const candidate = mintRunId();
    const file = setupLogPath(ctx.showRoot, key, candidate, ctx.productionDir);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, "", { encoding: "utf8", flag: "wx" });
      runId = candidate;
      logFile = file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  if (runId === undefined || logFile === undefined) {
    throw new Error(`could not mint a free run id for ${key}: three candidates already had logs`);
  }
  try {
    const { pid } = await spawnSetupWorker(ctx, key, runId, deps);
    return { runId, pid };
  } catch (err) {
    await rm(logFile, { force: true });
    throw err;
  }
}

/** What one gate answer carries. `choice` is one of `GATE_CHOICES`' four keys, so the browser's
 *  buttons and the terminal's menu offer the same four and mean the same thing by them; `notes`
 *  belongs to a rejection, `importPath` to an import, and `expectedAttempt` is the attempt the
 *  page was reading when the operator answered. */
export interface GateAnswer {
  choice: GateChoice;
  notes?: string;
  importPath?: string;
  expectedAttempt: number;
  by: string;
}

/** Answers one bible file's gate — the four answers the terminal offers, in the browser.
 *
 *  **The order, which is load-bearing.** For `approve` and `reject`: `answerGate`, then the
 *  worker. For `myself` and `import`: the file is written **first**, then `answerGate` as an
 *  approval, then the worker. Each step is where it is for a reason:
 *
 *  - *the file before the answer*, because an approval appended to the log and a copy that then
 *    failed would record an approval for a file nobody ever put there. This is `resolveImport`'s
 *    own argument — every check happens before the gate is answered — carried one step further.
 *  - *the worker last, and never waited on.* It must come after the append: a worker spawned first
 *    would read a log in which nothing had changed, report `waiting` at the same gate, release its
 *    lock and exit, leaving the answer in a log with no process behind it. And it is not awaited,
 *    because a server that waited for a worker's exit would be supervising a run, which spec §4.2
 *    forbids — this console must be killable at any moment without a run noticing.
 *  - *the worker at all*, because an approval is not a finished run: `run()` must read the answer
 *    out of the log, complete the gate and write `run_finished`, and `isApproved` — which is what
 *    makes the row read `approved` and what `initFinish` counts — asks for a **finished** log. This
 *    is exactly how an episode gate is answered (`answerGate`, then a worker), and
 *    `interviewFile`'s own comment says so.
 *
 *  **No commit is made here.** Plan H's Task 5 text put `afterFileApproved` in this function; the
 *  ledger's ruling of 2026-10-07 moved it into the setup worker, which calls it after its run ends
 *  `completed` — the terminal `init`'s own order, so the commit carries the log's closing
 *  `run_finished` line and no approved file is left with a modified `.jsonl` beside it. It also
 *  leaves no `git` process running inside this server.
 *
 *  `expectedAttempt` is refused by the engine when it names an attempt the gate is not open at,
 *  which is the whole protection against a tab left open across a rejection: the operator would
 *  otherwise approve a message a fix agent has already superseded.
 *
 *  A refused import path throws `ImportRefused` **before anything is written or appended**, so the
 *  gate is still open at the same attempt and the operator can answer again — the inner loop of
 *  the terminal's gate, as a 400. */
export async function answerBibleGate(
  ctx: ShowContext, key: string, runId: string, answer: GateAnswer, deps: BibleDeps = {},
): Promise<{ runId: string; pid: number }> {
  const entry = bibleEntry(key);
  checkSetupRunId(runId);
  const logFile = setupLogPath(ctx.showRoot, key, runId, ctx.productionDir);
  const held = await readLockFile(setupLockPath(ctx.showRoot, key, runId, ctx.productionDir));
  if (held?.alive === true) throw new Error(`run ${runId} is held by pid ${held.pid}`);
  const log = new EventLog(logFile);
  const stamp = { by: answer.by, expectedAttempt: answer.expectedAttempt };
  const destination = bibleFilePath(ctx, key);
  const template = async (): Promise<string> => templateWithoutQuestions(await readFile(canonTemplatePath(key), "utf8"));

  switch (answer.choice) {
    case "approve":
      await answerGate(log, runId, "gate", { approved: true, ...stamp });
      break;
    case "reject": {
      const notes = answer.notes ?? "";
      if (notes.trim() === "") throw new Error("a rejection needs notes: the fix agent revises the file against them");
      await answerGate(log, runId, "gate", { approved: false, notes, ...stamp });
      break;
    }
    case "myself":
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await template(), "utf8");
      await answerGate(log, runId, "gate", { approved: true, notes: AUTHOR_NOTES, ...stamp });
      break;
    case "import": {
      // The fence is `@showrunner/tools`', not a copy of it: a symlink, a path under the show's
      // production directory, the destination itself and anything beside it in the bible are all
      // refused there, on both the typed spelling and the dereferenced one.
      const source = await resolveImport(ctx.showRoot, entry, answer.importPath ?? "", ctx.productionDir);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await answerGate(log, runId, "gate", { approved: true, notes: `${IMPORT_NOTES_PREFIX}${source}`, ...stamp });
      break;
    }
  }
  // The same two steps for all four answers: the engine's append, then a worker. What the worker
  // does next is the log's business — the fix agent and the next attempt for a rejection, the
  // gate completed, `run_finished` and the commit for the three approvals.
  const { pid } = await spawnSetupWorker(ctx, key, runId, deps);
  return { runId, pid };
}

/** Every gated bible file whose interview has not been approved, in interview order — read out of
 *  the run logs by `isApproved` and never remembered, so the answer is the same for a setup driven
 *  from the terminal in one sitting and for one driven from the browser over a week.
 *
 *  Exported because `POST bible/finish` is offered and accepted only when this list is empty
 *  (Task 2's ruling): `initFinish` derives its own `stalled` the same way, so calling it part-way
 *  through an interview would answer "thirteen files are waiting on you" to an operator who had
 *  asked to finish — true, but not an answer to the question, and the GitHub repository would be
 *  created over a half-written bible. */
export async function unapprovedBibleFiles(ctx: ShowContext): Promise<string[]> {
  const out: string[] = [];
  for (const entry of BIBLE_FILES) {
    if (entry.mode === "scaffold") continue;
    if (!(await isApproved(ctx.showRoot, entry, ctx.productionDir))) out.push(entry.key);
  }
  return out;
}

/** The end of a setup: the bible-check report, the GitHub repository, and the next steps read back
 *  out of the show's own README — Task 2's `initFinish`, with the lines it would have printed to a
 *  terminal collected for the Finish panel to render.
 *
 *  `said` is the phase's own prose and is carried rather than paraphrased: it holds the
 *  bible-check's work-left-to-do list and, when `gh` is not signed in, the exact two commands to
 *  run. The console's rule everywhere else is not to reword what the engine or the tools chose. */
export async function finishBible(ctx: ShowContext, github: "private" | "public" | "none"): Promise<FinishResult & { said: string[] }> {
  const { io, said } = collectingIO();
  const result = await initFinish(ctx.showRoot, { github, engineRoot: ctx.engineRoot }, io, { operator: ctx.operator });
  return { ...result, said };
}

/** The `InitIO` a route hands a phase of `init` that asks nothing: `say` is collected and returned
 *  to the browser as the phase's own account of what it did, and a phase that tried to ask a
 *  question fails loudly rather than hanging on a terminal that is not there.
 *
 *  `said` is the phase's own prose and is carried rather than paraphrased: `initFinish`'s holds the
 *  bible-check's work-left-to-do list and, when `gh` is not signed in, the exact two commands to
 *  run; `initScaffold`'s says what it wrote. The console's rule everywhere else is not to reword
 *  what the engine or the tools chose.
 *
 *  Exported because the two phases a route can call — `initScaffold` under `POST /api/shows` and
 *  `initFinish` under `POST …/bible/finish` — both need exactly this, and they had one each with
 *  different refusal wording. One of them would eventually grow a `say` that was dropped, or an
 *  `ask` that hung. */
export function collectingIO(): { io: InitIO; said: string[] } {
  const said: string[] = [];
  return {
    said,
    io: {
      say: (text: string) => { said.push(text); },
      ask: async () => { throw new Error("this phase asks nothing: the browser asks the author"); },
      choose: async () => { throw new Error("this phase asks nothing: the browser asks the author"); },
    },
  };
}

import path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import {
  BIBLE_FILES, BYPASS_REASON, EPISODE_STAGE_MAP, EventLog, RUN_ID, bibleFilePipeline, bibleLogDir,
  deriveRunState, deriveStage, describePipeline,
  episodePipeline, latestRunId, listEpisodeIds, parseEpisodeId, pipelineHash,
  type Event, type Needs, type RunState, type StepDescription,
} from "@showrunner/engine";
import { buildVars } from "@showrunner/tools";
import type { EpisodeRow, RunStatus, RunView, SetupRunView, SseMessage, StepRow } from "../shared/types.js";
import { episodeTitle, idleEpisodeRow, readNeeds } from "./episodes.js";
import { readLock } from "./workers.js";
import { readLockFile } from "../worker/lock.js";
import { bibleEntry, checkSetupRunId, listSetupRuns, setupLockPath, setupLogPath } from "../worker/setup.js";
import type { ShowContext } from "./show.js";

/** How long a run with no live lock and nothing in flight may go without an event before it is
 *  reported crashed. A worker beats its lock every five seconds, so a minute of silence is
 *  twelve missed beats: the process is gone. */
const STALE_MS = 60_000;

/** How often the store re-lists the show's episodes to find runs directories that appeared after
 *  it started watching. `fs.watch` cannot watch a directory that does not exist yet, and the
 *  first run of a new episode creates `Production/<id>/runs/` as its first act. */
const DEFAULT_POLL_MS = 2_000;

/** How many lines of a crashed run's `<runId>.worker.log` the run view carries. Enough for the
 *  frames of a rejected `run()`'s stack that name the engine's own modules, short enough that the
 *  Run page's crashed status does not become a wall of text. */
const WORKER_LOG_TAIL_LINES = 20;

/** One log as the store holds it: every event parsed so far, the byte offset to resume reading
 *  from, and the last read failure if there was one. The offset is the whole point — a run log
 *  grows by thousands of lines, and a console that re-read it on every change notification would
 *  spend the run re-parsing it.
 *
 *  `lastError` exists because the alternative is worse than an error. A log the store cannot
 *  parse past byte N leaves the cached events at their last good state and the offset where it
 *  was, so every projection of that run — its Board row, its step rail, its progress — is frozen
 *  at the bad byte while the status still reads from the lock. Carrying the failure forward is
 *  what lets both surfaces say so instead of showing stale truth confidently. */
interface CachedLog { events: Event[]; offset: number; lastError?: string }

/** The one seam the store has: how often the directory poll runs. Production takes the default. */
export interface RunStoreOptions { pollMs?: number }

/** Whether `p` is a directory. */
async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/** The events logged for one step since that step's most recent `step_started`, in log order.
 *  A step that was reset and ran again, or a loop resumed after a crash, has two attempts in one
 *  log; only the latest one describes what is happening, so a rate or an iteration flag computed
 *  over both would describe a run that no longer exists. */
function sinceLastStart(events: Event[], stepId: string): Event[] {
  let from = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e && e.stepId === stepId && e.kind === "step_started") from = i;
  }
  const out: Event[] = [];
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i];
    if (e && e.stepId === stepId) out.push(e);
  }
  return out;
}

interface Sample { at: number; done: number; total: number; unit: string; message?: string }

/** The step's progress, with a rate and an ETA when the log supports one.
 *
 *  The rate is measured over the last two **distinct** `done` values, collapsing a run of
 *  samples that report the same count to the first of them — the moment that count was first
 *  observed. A loop that emits one `step_progress` per iteration reports the same `done` several
 *  times while the scene it is on is unfinished; measuring over the last two samples instead
 *  would divide a count that did not change by the seconds since it last did not change, which
 *  understates the rate the longer the step has been stuck. Three samples at 20 s (1 scene),
 *  24 s (1) and 40 s (2) are one scene in the twenty seconds from the first to the third.
 *
 *  No rate is reported when fewer than two distinct counts exist or when their timestamps are
 *  equal — the engine emits a loop's `step_progress` immediately after its `loop_iteration`, so
 *  a zero interval is ordinary, not a malformed log — and no ETA when the rate is not positive,
 *  since a count that went backwards would otherwise give an ETA in the past. */
function progressOf(stepEvents: Event[]): StepRow["progress"] | undefined {
  const samples: Sample[] = [];
  for (const e of stepEvents) {
    if (e.kind !== "step_progress") continue;
    const at = Date.parse(e.ts);
    const done = Number(e.payload["done"]);
    const total = Number(e.payload["total"]);
    if (!Number.isFinite(at) || !Number.isFinite(done)) continue;
    const message = e.payload["message"];
    samples.push({
      at, done, total: Number.isFinite(total) ? total : NaN, unit: String(e.payload["unit"] ?? ""),
      ...(typeof message === "string" ? { message } : {}),
    });
  }
  const last = samples[samples.length - 1];
  if (last === undefined) return undefined;
  const progress: NonNullable<StepRow["progress"]> = {
    done: last.done, total: Number.isFinite(last.total) ? last.total : 0, unit: last.unit,
    ...(last.message !== undefined ? { message: last.message } : {}),
  };

  const distinct: Sample[] = [];
  for (const s of samples) {
    const prev = distinct[distinct.length - 1];
    if (prev === undefined || prev.done !== s.done) distinct.push(s);
  }
  const b = distinct[distinct.length - 1];
  const a = distinct[distinct.length - 2];
  if (a === undefined || b === undefined) return progress;
  const seconds = (b.at - a.at) / 1000;
  if (seconds <= 0) return progress;
  const rate = (b.done - a.done) / seconds;
  if (!Number.isFinite(rate)) return progress;
  progress.ratePerSec = rate;
  if (rate > 0 && Number.isFinite(last.total)) progress.etaSec = Math.max(0, (last.total - last.done) / rate);
  return progress;
}

/** The flag a running loop carries, or none. Every `loop_iteration` since the loop's last
 *  `step_started` is read, not only the last one: an iteration that called no tool did nothing
 *  and an iteration that errored failed, and either is worth the operator's attention for as
 *  long as the loop is still going — a draft loop that burned iteration 2 on nothing is the
 *  shape of a loop that is about to exhaust its cap, whatever iteration 3 did.
 *  An error takes precedence: a loop that both failed an iteration and wasted one is first of
 *  all failing. */
function loopFlag(stepEvents: Event[]): StepRow["flag"] | undefined {
  let flag: StepRow["flag"] | undefined;
  for (const e of stepEvents) {
    if (e.kind !== "loop_iteration") continue;
    const error = e.payload["error"];
    if (error !== undefined && error !== null && error !== "") return "failed-iteration";
    if (e.payload["toolCalls"] === 0) flag = "did-nothing";
  }
  return flag;
}

/** Every step of the pipeline definition as a row, in pipeline order, overlaid with the log.
 *  The rows come from the definition and not from the log, which is what makes the run view a
 *  picture of the whole episode rather than of the part that has happened: a step the log never
 *  mentions is `pending`, and the operator can see what is still ahead.
 *
 *  A step id the log names and the definition does not gets a row of its own at the end, with
 *  the kind the log recorded. The episode pipeline's runner logs every nested step under its
 *  top-level step's id, so this is defensive rather than load-bearing — but a log whose steps
 *  silently vanished from the view would be the worst possible way to find out that a pipeline
 *  had been renamed under a run. */
function projectSteps(descriptions: StepDescription[], events: Event[]): StepRow[] {
  const rows = new Map<string, StepRow>();
  for (const d of descriptions) rows.set(d.id, { id: d.id, kind: d.kind, status: "pending" });

  for (const e of events) {
    const id = e.stepId;
    if (id === undefined) continue;
    let row = rows.get(id);
    if (row === undefined) {
      const kind = e.payload["kind"];
      row = { id, kind: typeof kind === "string" ? kind : "unknown", status: "pending" };
      rows.set(id, row);
    }
    switch (e.kind) {
      case "step_started":
        row.status = "running";
        row.startedAt = e.ts;
        delete row.endedAt; delete row.error; delete row.result; delete row.toolCalls; delete row.progress; delete row.flag;
        break;
      case "step_completed":
      case "step_cached": {
        row.status = "completed";
        row.endedAt = e.ts;
        if ("result" in e.payload) row.result = e.payload["result"];
        const toolCalls = e.payload["toolCalls"];
        if (typeof toolCalls === "number") row.toolCalls = toolCalls;
        break;
      }
      case "step_failed":
        row.status = "failed";
        row.endedAt = e.ts;
        row.error = String(e.payload["error"] ?? "");
        break;
      case "step_skipped":
        // The same event kind for two different outcomes: a step its own `when` turned off was
        // bypassed and its dependents still ran; one a broken dependency took out was skipped.
        row.status = e.payload["reason"] === BYPASS_REASON ? "bypassed" : "skipped";
        row.endedAt = e.ts;
        break;
      case "step_reset":
        row.status = "pending";
        delete row.endedAt; delete row.error; delete row.result; delete row.toolCalls; delete row.progress; delete row.flag;
        break;
      case "gate_opened":
        row.status = "waiting";
        break;
      case "gate_answered":
        if (e.payload["approved"] === true) { row.status = "completed"; row.endedAt = e.ts; }
        // A rejected gate is running again, not answered: the runner re-executes it, which runs
        // its fix agent and reopens it at the next attempt.
        else { row.status = "running"; delete row.endedAt; }
        break;
      default:
        break;
    }
  }

  // Progress and the loop flag are computed for every running step rather than only for the
  // run's `position`: `position` is the last step to have started, and Plan E's Task 9 lets two
  // steps run at once, at which point the earlier of them would silently lose its progress bar.
  for (const row of rows.values()) {
    if (row.status !== "running") continue;
    const stepEvents = sinceLastStart(events, row.id);
    const progress = progressOf(stepEvents);
    if (progress !== undefined) row.progress = progress;
    const flag = loopFlag(stepEvents);
    if (flag !== undefined) row.flag = flag;
  }
  return [...rows.values()];
}

/** What the console reports for a run. Six states, read in this order, because every later check
 *  is weaker evidence than the one before it:
 *
 *  1. `run_finished` in the log — "completed" or "failed". The log is the authority on a finish,
 *     and it must be read before the lock: between the runner appending `run_finished` and the
 *     worker's `finally` removing the lock, a completed run still has a live lock.
 *  2. An open gate — "waiting". Read before anything about the lock, because a run parked at a
 *     gate has no lock at all: the worker released it and exited, which is the normal resting
 *     state of an episode awaiting the showrunner and not a crash.
 *  3. A live lock — "running". A process is holding this run right now, and that is the only
 *     thing that means a run is running.
 *  4. An empty log and no lock — "none". A run that was launched and has not written yet: the
 *     worker takes the lock and appends `run_started` within milliseconds of being spawned, and
 *     for that moment there is nothing on disk to read. Reporting it as a crash would make every
 *     launch flash red.
 *  5. A step in flight, with no live lock — "crashed", whether the lock is stale or gone.
 *     **There is no honest state in which a step is in flight and no live worker holds the run.**
 *     One worker owns one run: it takes the lock before `run()` and removes it in `finally`, and
 *     the runner writes a terminal event for every step it finishes. So a log whose last word on
 *     a step is `step_started`, beside a lock that nothing holds or no lock at all, is one of
 *     exactly two things — a worker that was killed (the lock is still there, its pid dead) or a
 *     `run()` that rejected (the `finally` took the lock with it, and only `<runId>.worker.log`
 *     says why). Both are crashes, and the Board has to say so: the operator's move is Continue,
 *     which replays the open step, and a run mislabelled "running" offers no move at all and
 *     waits forever on a process that is gone.
 *  6. Nothing in flight and no live lock — "running" if the log was written to within the last
 *     minute, else "crashed". This is the narrow window where a lock write has not landed yet or
 *     a reader raced it; a minute of silence is twelve missed heartbeats. */
export function deriveRunStatus(state: RunState, lock: { alive: boolean } | undefined, eventCount: number, now = Date.now()): RunStatus {
  if (state.finished) return state.status === "completed" ? "completed" : "failed";
  if (state.openGate) return "waiting";
  if (lock?.alive === true) return "running";
  if (eventCount === 0 && lock === undefined) return "none";
  const inFlight = state.position !== undefined || Object.values(state.steps).some((s) => s === "running");
  if (inFlight) return "crashed";
  const last = state.lastEventAt !== undefined ? Date.parse(state.lastEventAt) : NaN;
  return Number.isFinite(last) && now - last < STALE_MS ? "running" : "crashed";
}

/** The run log's own account of which pipeline it ran, set beside the pipeline the console built
 *  for the same episode just now. The name, the hash and the engine version are reported as the
 *  log wrote them, never as the current code would; `hashNow` is the current code's hash, and
 *  `changed` is the two of them differing — which is the answer to "why does this run have steps
 *  the code does not". A log that recorded no hash has nothing to compare, so `changed` is false
 *  rather than a mismatch invented from an absent value. */
function pipelineOf(name: string, started: Event | undefined, hashNow: string): RunView["pipeline"] {
  const payload = started?.payload ?? {};
  const logged = payload["pipeline"];
  const hash = payload["pipelineHash"];
  const engineVersion = payload["engineVersion"];
  return {
    name: typeof logged === "string" && logged !== "" ? logged : name,
    ...(typeof hash === "string" ? { hash } : {}),
    ...(typeof engineVersion === "string" ? { engineVersion } : {}),
    hashNow,
    changed: typeof hash === "string" && hash !== hashNow,
  };
}

/** The last few lines of a crashed run's `<runId>.worker.log`, or undefined when the file is not
 *  there. Blank lines are dropped and the tail is taken from the end, so a run that was continued
 *  three times shows the most recent worker's account rather than the first one's.
 *
 *  Read only for a crashed run (`RunStore.#project`), because that is the one status whose
 *  explanation is not in the run log: a rejected `run()` removes its lock in the `finally`, which
 *  leaves the console with a step stuck at `running`, no worker to report, and this file. */
async function workerExitOf(workerLog: string, lines = WORKER_LOG_TAIL_LINES): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(workerLog, "utf8"); } catch { return undefined; }
  const kept = text.split("\n").filter((line) => line.trim() !== "").slice(-lines);
  return kept.length === 0 ? undefined : kept.join("\n");
}

/** The step whose failure the run stopped at, if one is still failed. Read from the last
 *  `step_failed` whose step the state still reports as failed, so a failure that a later
 *  `run_resumed` swept away is not reported as the run's current problem. */
function failedOf(events: Event[], state: RunState): { stepId: string; error: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.kind !== "step_failed" || e.stepId === undefined) continue;
    if (state.steps[e.stepId] !== "failed") continue;
    return { stepId: e.stepId, error: String(e.payload["error"] ?? "") };
  }
  return undefined;
}

/** Every run log of **one** show, tailed by byte offset, projected into the views the console
 *  draws, and announced on one channel.
 *
 *  The store writes nothing and owns nothing. It reads logs that detached workers append to, and
 *  the only thing it knows that a log does not is whether a process is holding the run — which
 *  it reads from the lock beside the log. A console that believed it owned a run would be a
 *  console that could kill one by restarting.
 *
 *  **One store per registered show, not one store that knows about several.** The server builds
 *  the map in `server/main.ts` and the show middleware hands a request the store for its own show,
 *  which is why every key inside here — `#logs`, `#tails`, `#watchers` — stays keyed as it was,
 *  on the episode id and the run id alone. Two shows each holding an `s02e01` sit in two stores
 *  with two `#watchers` maps, so neither can take the other's watcher entry; had one store served
 *  both shows, every one of these five maps would have needed a show segment and a single missed
 *  one would have been two shows sharing a tail.
 *
 *  What the show key *is* needed for is the channel: every notice this store publishes carries
 *  `show: this.#ctx.key`, because the SSE channel is one stream across every registered show and a
 *  client watching one Board must be able to ignore another show's heartbeat (ruling H-12). */
export class RunStore {
  readonly #ctx: ShowContext;
  readonly #pollMs: number;
  readonly #logs = new Map<string, CachedLog>();
  /** One promise chain per log, so two change notifications for one file cannot both read from
   *  the same offset and append the same events twice. */
  readonly #tails = new Map<string, Promise<void>>();
  readonly #watchers = new Map<string, FSWatcher>();
  /** One watcher per bible file whose `Production/setup/<key>/runs/` directory exists. Kept apart
   *  from `#watchers` because the two key spaces are different — an episode id there, a bible key
   *  here — and a single map would let one show's `world-overview` and an episode called
   *  `world-overview` take each other's entry. (No episode id can be a bible key, so this is
   *  belt and braces; the maps are separate so that the reasoning does not have to be repeated.) */
  readonly #setupWatchers = new Map<string, FSWatcher>();
  readonly #subscribers = new Set<(m: SseMessage) => void>();
  #episodeIds: string[] = [];
  #poll: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(ctx: ShowContext, opts: RunStoreOptions = {}) {
    this.#ctx = ctx;
    this.#pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  }

  /** The events of one run, tailing the log first so the answer includes everything on disk at
   *  the moment of the call, with the byte offset they were read to — and `lastError` when the
   *  tail could not be read past that offset, so a caller projecting these events knows they are
   *  a prefix of the log rather than the whole of it. */
  async get(episodeId: string, runId: string): Promise<{ events: Event[]; offset: number; lastError?: string }> {
    const key = this.#key(episodeId, runId);
    await this.#tailAndPublish(episodeId, runId);
    const cached = this.#logs.get(key) ?? { events: [], offset: 0 };
    return {
      events: [...cached.events], offset: cached.offset,
      ...(cached.lastError !== undefined ? { lastError: cached.lastError } : {}),
    };
  }

  /** Starts watching every runs directory the show has — the episodes' and the bible's — and polls
   *  for ones that appear later. Called once before the server listens. */
  async watch(): Promise<void> {
    this.#episodeIds = await listEpisodeIds(this.#ctx.showRoot, this.#ctx.show);
    for (const id of this.#episodeIds) await this.#watchEpisode(id);
    // The thirteen interviewable bible files. Almost none of their directories exist on a new
    // show, and `fs.watch` cannot watch a directory that is not there, so the poll below attaches
    // the rest: a bible run creates `Production/setup/<key>/runs/` as its first act, exactly as an
    // episode's first run creates `Production/<id>/runs/`.
    for (const entry of BIBLE_FILES) {
      if (entry.mode !== "scaffold") await this.#watchSetup(entry.key);
    }
    this.#poll = setInterval(() => { void this.#rescan(); }, this.#pollMs);
    // The HTTP server keeps the process alive; this timer must not, or a console whose server
    // has closed would hang on exit.
    this.#poll.unref();
  }

  /** Adds a listener for every message the store publishes. Returns the function that removes
   *  it, which is what an SSE handler calls when its client disconnects. */
  subscribe(fn: (m: SseMessage) => void): () => void {
    this.#subscribers.add(fn);
    return () => { this.#subscribers.delete(fn); };
  }

  /** One run at the middle altitude: the pipeline's steps overlaid with the log, what is in
   *  flight, what is open, and the status. */
  async view(episodeId: string, runId: string): Promise<RunView> {
    return (await this.#project(episodeId, runId)).view;
  }

  /** One row of the Board: the episode's title and needs joined to the state of its latest run.
   *  An episode with no runs never builds a pipeline or reads a log. */
  async episodeRow(episodeId: string): Promise<EpisodeRow> {
    parseEpisodeId(episodeId);
    const runId = await latestRunId(this.#ctx.showRoot, episodeId, this.#ctx.productionDir);
    if (runId === undefined) return idleEpisodeRow(this.#ctx, episodeId);
    const { view, needs } = await this.#project(episodeId, runId);
    const row: EpisodeRow = {
      id: episodeId,
      title: await episodeTitle(this.#ctx, episodeId),
      stage: view.stage,
      status: view.status,
      runId,
      needs: needs.detail,
    };
    // The Board's row carries the gate's identity and age but not its message: the message is
    // several paragraphs of rendered prose, and twenty of them is the Board's whole payload.
    if (view.openGate) row.openGate = { stepId: view.openGate.stepId, attempt: view.openGate.attempt, openedAt: view.openGate.openedAt };
    if (view.failed) row.failed = view.failed;
    if (view.lastEventAt !== undefined) row.lastEventAt = view.lastEventAt;
    if (view.worker) row.worker = view.worker;
    // A row whose log could not be read to its end is a row that has stopped moving: everything
    // above is derived from the bytes before the bad one, and the Board says so rather than
    // showing a frozen row as a current one.
    if (view.logError !== undefined) row.logError = view.logError;
    return row;
  }

  /** The events of one bible run, tailing its log first so the answer includes everything on disk
   *  at the moment of the call, with the byte offset they were read to. The twin of `get` for the
   *  reserved setup id, which `get` cannot serve: its `#key` validates the episode id and `setup`
   *  is deliberately not one. */
  async setupGet(key: string, runId: string): Promise<{ events: Event[]; offset: number; lastError?: string }> {
    const cacheKey = this.#setupKey(key, runId);
    await this.#tailAndPublishSetup(key, runId);
    const cached = this.#logs.get(cacheKey) ?? { events: [], offset: 0 };
    return {
      events: [...cached.events], offset: cached.offset,
      ...(cached.lastError !== undefined ? { lastError: cached.lastError } : {}),
    };
  }

  /** One bible run as the Bible page draws it: the file's own pipeline described, overlaid with
   *  its log.
   *
   *  **A projection of `bibleFilePipeline` and not of the episode's.** A bible file's pipeline is
   *  `write` then `gate` for an interviewed file and the gate alone for a default one; the episode
   *  projection would have described this run as a sixty-eight-step episode with every step
   *  pending, and `#project` cannot be reached for it in any case — it builds `episodePipeline`
   *  and calls `parseEpisodeId`, both of which throw on the reserved id (inventory §4.3).
   *
   *  The status comes from `deriveRunStatus`, the same six-rule ladder the Board's rows use, read
   *  against the lock beside this run's own log — which is what "crashed" means here as there: a
   *  step in flight with no live worker holding the run, or a minute of silence. The pipeline is
   *  built per call with the current clock, because only its name and its steps' ids and kinds are
   *  read from it: `describePipeline` renders no prompt, so the `vars` a prompt would render are
   *  not load-bearing here — the worker builds its own from the same function. */
  async setupView(key: string, runId: string): Promise<SetupRunView> {
    const entry = bibleEntry(key);
    const { events, offset } = await this.setupGet(key, runId);
    const state = deriveRunState(events);
    const pipeline = bibleFilePipeline({
      entry,
      vars: buildVars(this.#ctx.showRoot, entry, new Date(), this.#ctx.productionDir),
      productionDir: this.#ctx.productionDir,
    });
    const lock = await readLockFile(setupLockPath(this.#ctx.showRoot, key, runId, this.#ctx.productionDir));
    const view: SetupRunView = {
      runId,
      // The cast is safe and narrowing: `deriveRunStatus` returns one of six values and
      // `SetupRunView["status"]` is exactly those six — `RunStatus`' seventh, "archived", comes
      // from an episode's `archive.json` marker, which `idleEpisodeRow` reads and this ladder
      // never produces. A bible file has no archive marker and never will.
      status: deriveRunStatus(state, lock, events.length) as SetupRunView["status"],
      steps: projectSteps(describePipeline(pipeline).steps, events).map((row) => ({
        id: row.id, status: row.status, ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
      })),
      offset,
    };
    if (state.openGate !== undefined) view.gate = { attempt: state.openGate.attempt, message: state.openGate.message };
    const failed = failedOf(events, state);
    if (failed !== undefined) view.error = `${failed.stepId} failed: ${failed.error}`;
    return view;
  }

  /** The id of a bible file's latest run, or `undefined` when it has never been interviewed.
   *  Lexical order is creation order, because `mintRunId` stamps the time into the id. */
  async latestSetupRunId(key: string): Promise<string | undefined> {
    const runs = await listSetupRuns(this.#ctx.showRoot, key, this.#ctx.productionDir);
    return runs[runs.length - 1];
  }

  /** Stops every watcher and the poll, and drops every subscriber. The runs the store was
   *  watching are unaffected: they belong to their workers. */
  close(): void {
    this.#closed = true;
    if (this.#poll !== undefined) { clearInterval(this.#poll); this.#poll = undefined; }
    for (const w of [...this.#watchers.values(), ...this.#setupWatchers.values()]) { try { w.close(); } catch { /* already closed */ } }
    this.#watchers.clear();
    this.#setupWatchers.clear();
    this.#subscribers.clear();
  }

  #key(episodeId: string, runId: string): string {
    parseEpisodeId(episodeId);
    if (!RUN_ID.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)}: expected [A-Za-z0-9_-]+`);
    return `${episodeId}/${runId}`;
  }

  #logPath(episodeId: string, runId: string): string {
    return EventLog.logPath(this.#ctx.showRoot, episodeId, runId, this.#ctx.productionDir);
  }

  /** The cache key of one bible run, with both ids validated first — the bible key against
   *  `BIBLE_FILES` and the run id against the engine's alphabet, which is the fence spec §4.4 asks
   *  for applied once, here, for every setup log the store touches.
   *
   *  Three segments where an episode's key (`#key`) has two, and the first of them is the reserved
   *  id `setup`, which `parseEpisodeId` refuses: so a bible run and an episode run can never
   *  collide in `#logs` or `#tails`, and the two key spaces need no further separation. */
  #setupKey(key: string, runId: string): string {
    bibleEntry(key);
    checkSetupRunId(runId);
    return `setup/${key}/${runId}`;
  }

  #setupLogPath(key: string, runId: string): string {
    return setupLogPath(this.#ctx.showRoot, key, runId, this.#ctx.productionDir);
  }

  #setupDir(key: string): string {
    return bibleLogDir(this.#ctx.showRoot, key, this.#ctx.productionDir);
  }

  #publish(message: SseMessage): void {
    if (this.#closed) return;
    for (const fn of this.#subscribers) {
      try { fn(message); } catch { /* a subscriber's failure is its own */ }
    }
  }

  /** The run view and the episode's needs from one pass: `episodeRow` wants both, and reading
   *  the needs twice would scan the same reference files twice per row. */
  async #project(episodeId: string, runId: string): Promise<{ view: RunView; needs: { flags: Needs; detail: EpisodeRow["needs"] } }> {
    const { events, offset, lastError } = await this.get(episodeId, runId);
    const state = deriveRunState(events);
    const needs = await readNeeds(this.#ctx, episodeId);
    // Built per episode, never cached across them: every step's inputs and outputs, every
    // script step's argv and the canon spine's season file are the episode's own, so one
    // pipeline reused for a second episode would describe the first one's files.
    const pipeline = episodePipeline({ show: this.#ctx.show, episodeId, engineRoot: this.#ctx.engineRoot });
    const description = describePipeline(pipeline);
    const lock = await readLock(this.#ctx, episodeId, runId);
    const started = events.find((e) => e.kind === "run_started");
    let finished: Event | undefined;
    for (const e of events) if (e.kind === "run_finished") finished = e;

    const status = deriveRunStatus(state, lock, events.length);
    const view: RunView = {
      episodeId,
      runId,
      status,
      stage: deriveStage(state, EPISODE_STAGE_MAP, needs.flags),
      steps: projectSteps(description.steps, events),
      pipeline: pipelineOf(description.name, started, pipelineHash(pipeline)),
      offset,
    };
    if (lastError !== undefined) view.logError = lastError;
    // Only for a crash: the file exists for every segment, and reading it for a run that is
    // working would put a worker's last line on a page whose status already says more than it.
    if (status === "crashed") {
      const exit = await workerExitOf(this.#logPath(episodeId, runId).replace(/\.jsonl$/, ".worker.log"));
      if (exit !== undefined) view.workerExit = exit;
    }
    if (started !== undefined) view.startedAt = started.ts;
    if (finished !== undefined) view.finishedAt = finished.ts;
    if (state.lastEventAt !== undefined) view.lastEventAt = state.lastEventAt;
    // The position carries no progress of its own: the progress belongs to the step's row, where
    // the client draws it, and two copies of it would be two things to keep in agreement.
    if (state.position !== undefined) view.position = { stepId: state.position.stepId, startedAt: state.position.startedAt };
    if (state.openGate !== undefined) view.openGate = { ...state.openGate };
    const failed = failedOf(events, state);
    if (failed !== undefined) view.failed = failed;
    if (lock !== undefined) view.worker = { pid: lock.pid, heartbeatAt: lock.heartbeatAt, alive: lock.alive, groups: lock.groups };
    return { view, needs };
  }

  /** Reads whatever has been appended to one log since the store last read it, and says how many
   *  events arrived. Three cases, all of them `EventLog.readFrom`'s:
   *
   *  - the writer appended whole lines: they are parsed and appended to the cache, and the
   *    offset advances past the last newline;
   *  - the writer is mid-line: `readFrom` returns no events and the same offset, leaving the
   *    partial line to be read whole on the next notification;
   *  - the file is shorter than the offset: it was truncated or replaced under the store, so the
   *    returned offset moves backwards. That is the only signal a reader gets, and the cached
   *    events describe bytes that no longer exist, so the log is re-read from the start rather
   *    than appended to. A log the store already holds is never otherwise re-read from zero:
   *    doing so on a change notification would double every event in the cache and announce a
   *    change to a run that had not changed.
   *
   *  And one case that is not `readFrom`'s: a read that throws, which is a malformed line
   *  (`EventLog.readFrom`'s "malformed JSON after byte N") or a failure of the read itself. The
   *  offset does not advance and the cached events stay at their last good state — the same
   *  freeze as before — but the failure is recorded against the log, so `RunView.logError` and
   *  `EpisodeRow.logError` can say which run stopped being readable and where. The strictness is
   *  kept deliberately: a malformed line is skipped by nobody, because an event the store
   *  silently dropped would be a projection that is wrong rather than frozen. */
  async #tailOnce(episodeId: string, runId: string): Promise<number> {
    const key = this.#key(episodeId, runId);
    const cached = this.#logs.get(key) ?? { events: [], offset: 0 };
    const log = new EventLog(this.#logPath(episodeId, runId));
    let next: { events: Event[]; offset: number };
    try {
      next = await log.readFrom(cached.offset);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logs.set(key, {
        events: cached.events, offset: cached.offset,
        lastError: `this run's log could not be read past byte ${cached.offset}: ${message}`,
      });
      return 0;
    }
    if (next.offset < cached.offset) {
      let fresh: { events: Event[]; offset: number };
      try {
        fresh = await log.readFrom(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#logs.set(key, { events: [], offset: 0, lastError: `this run's log could not be read past byte 0: ${message}` });
        return 0;
      }
      this.#logs.set(key, { events: fresh.events, offset: fresh.offset });
      return fresh.events.length;
    }
    if (next.events.length === 0) {
      this.#logs.set(key, { events: cached.events, offset: next.offset });
      return 0;
    }
    this.#logs.set(key, { events: [...cached.events, ...next.events], offset: next.offset });
    return next.events.length;
  }

  /** Tails one log and, if anything arrived, says so on the channel. The message carries the new
   *  offset and nothing else: a client that holds a view asks for the events between its offset
   *  and this one, so one notification costs one small message however many events landed. */
  #tailAndPublish(episodeId: string, runId: string): Promise<void> {
    const key = this.#key(episodeId, runId);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      const added = await this.#tailOnce(episodeId, runId);
      if (added > 0) this.#publish({ type: "run", show: this.#ctx.key, episodeId, runId, offset: this.#logs.get(key)?.offset ?? 0 });
    }).catch(() => undefined);
    this.#tails.set(key, next);
    return next;
  }

  /** Reads whatever has been appended to one bible run's log since the store last read it, by the
   *  same three-case rule `#tailOnce` applies to an episode's (whole lines, a partial line, or a
   *  file shorter than the offset), and with the same freeze-and-report on a malformed line. The
   *  cache, the offsets and the error handling are one implementation; only the log's address and
   *  the key differ. */
  async #tailOnceSetup(key: string, runId: string): Promise<number> {
    const cacheKey = this.#setupKey(key, runId);
    const cached = this.#logs.get(cacheKey) ?? { events: [], offset: 0 };
    const log = new EventLog(this.#setupLogPath(key, runId));
    let next: { events: Event[]; offset: number };
    try {
      next = await log.readFrom(cached.offset);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logs.set(cacheKey, {
        events: cached.events, offset: cached.offset,
        lastError: `this run's log could not be read past byte ${cached.offset}: ${message}`,
      });
      return 0;
    }
    if (next.offset < cached.offset) {
      let fresh: { events: Event[]; offset: number };
      try {
        fresh = await log.readFrom(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#logs.set(cacheKey, { events: [], offset: 0, lastError: `this run's log could not be read past byte 0: ${message}` });
        return 0;
      }
      this.#logs.set(cacheKey, { events: fresh.events, offset: fresh.offset });
      return fresh.events.length;
    }
    if (next.events.length === 0) {
      this.#logs.set(cacheKey, { events: cached.events, offset: next.offset });
      return 0;
    }
    this.#logs.set(cacheKey, { events: [...cached.events, ...next.events], offset: next.offset });
    return next.events.length;
  }

  /** Tails one bible run's log and, if anything arrived, says so on the channel as
   *  `{type: "setup", show, key, runId, offset}`.
   *
   *  **Only on growth**, like the episode notice: the message carries the new offset and nothing
   *  else, so one notification costs one small message however many events landed and the client
   *  asks for the bytes between its offset and this one. The show key is on it because the channel
   *  is one stream across every registered show (ruling H-12), and the bible key because a client
   *  watching `world-overview` must be able to ignore `series-arc`'s writer. */
  #tailAndPublishSetup(key: string, runId: string): Promise<void> {
    const cacheKey = this.#setupKey(key, runId);
    const previous = this.#tails.get(cacheKey) ?? Promise.resolve();
    const next = previous.then(async () => {
      const added = await this.#tailOnceSetup(key, runId);
      if (added > 0) this.#publish({ type: "setup", show: this.#ctx.key, key, runId, offset: this.#logs.get(cacheKey)?.offset ?? 0 });
    }).catch(() => undefined);
    this.#tails.set(cacheKey, next);
    return next;
  }

  /** Attaches one watcher to one bible file's runs directory, and tails what is already in it. A
   *  directory that does not exist is left to the poll — which is the ordinary case: a show's
   *  thirteen setup directories are created one at a time, by the first run of each file. */
  async #watchSetup(key: string): Promise<void> {
    if (this.#closed || this.#setupWatchers.has(key)) return;
    const dir = this.#setupDir(key);
    if (!(await isDir(dir))) return;
    let watcher: FSWatcher;
    try { watcher = watch(dir, (_eventType, filename) => { this.#onSetupChange(key, filename); }); }
    catch { return; }
    watcher.on("error", () => { try { watcher.close(); } catch { /* already closed */ } this.#setupWatchers.delete(key); });
    this.#setupWatchers.set(key, watcher);
    await this.#rescanSetupDir(key);
  }

  /** One change inside a bible file's runs directory. A `*.jsonl` whose stem is a run id is
   *  tailed; an undefined filename (which some platforms and editors produce) re-reads the
   *  directory; and a lock appearing or disappearing is a run starting or stopping — nothing new
   *  to read, but the file's state turns on it, so the notice goes out with the offset the store
   *  already holds. */
  #onSetupChange(key: string, filename: string | null): void {
    if (this.#closed) return;
    if (filename === null || filename === "") { void this.#rescanSetupDir(key); return; }
    if (filename.endsWith(".jsonl")) {
      const runId = filename.slice(0, -".jsonl".length);
      if (RUN_ID.test(runId)) void this.#tailAndPublishSetup(key, runId);
      return;
    }
    if (filename.endsWith(".lock")) {
      const runId = filename.slice(0, -".lock".length);
      if (RUN_ID.test(runId)) {
        this.#publish({ type: "setup", show: this.#ctx.key, key, runId, offset: this.#logs.get(`setup/${key}/${runId}`)?.offset ?? 0 });
      }
    }
  }

  /** Tails the logs in one bible file's runs directory: its latest run, and any run the store is
   *  already caching. The same two-of-them rule the episode directories use, and for the same
   *  reason — the latest run is the only log anything will ever append to, and older ones are
   *  finished and inert. */
  async #rescanSetupDir(key: string): Promise<void> {
    let runIds: string[];
    try { runIds = await listSetupRuns(this.#ctx.showRoot, key, this.#ctx.productionDir); } catch { return; }
    const latest = runIds[runIds.length - 1];
    for (const runId of runIds) {
      if (runId === latest || this.#logs.has(`setup/${key}/${runId}`)) await this.#tailAndPublishSetup(key, runId);
    }
  }

  /** Attaches one watcher to one episode's runs directory, and tails what is already in it. A
   *  directory that does not exist is left to the poll. */
  async #watchEpisode(episodeId: string): Promise<void> {
    if (this.#closed || this.#watchers.has(episodeId)) return;
    const dir = path.join(this.#ctx.showRoot, this.#ctx.productionDir, episodeId, "runs");
    if (!(await isDir(dir))) return;
    let watcher: FSWatcher;
    try { watcher = watch(dir, (_eventType, filename) => { this.#onChange(episodeId, filename); }); }
    catch { return; }
    // A watched directory that is renamed or removed errors the watcher; forgetting it lets the
    // poll re-attach if the directory comes back, which is what a restored backup looks like.
    watcher.on("error", () => { try { watcher.close(); } catch { /* already closed */ } this.#watchers.delete(episodeId); });
    this.#watchers.set(episodeId, watcher);
    await this.#rescanDir(episodeId, dir);
  }

  /** One change inside a runs directory. `fs.watch` on macOS names the file; an undefined name
   *  (which other platforms and some editors produce) says only that something changed, so the
   *  whole directory is re-read. */
  #onChange(episodeId: string, filename: string | null): void {
    if (this.#closed) return;
    if (filename === null || filename === "") {
      const dir = path.join(this.#ctx.showRoot, this.#ctx.productionDir, episodeId, "runs");
      void this.#rescanDir(episodeId, dir);
      this.#publish({ type: "episodes", show: this.#ctx.key });
      return;
    }
    if (filename.endsWith(".jsonl")) {
      const runId = filename.slice(0, -".jsonl".length);
      // `<runId>.troubleshooting.jsonl` also ends in .jsonl and is not a run log; its would-be
      // run id carries a dot, which RUN_ID refuses.
      if (RUN_ID.test(runId)) void this.#tailAndPublish(episodeId, runId);
      return;
    }
    // A lock appearing or disappearing is a run starting or stopping, which is a Board fact
    // rather than a log one: there is nothing new to read, but every row's status may have
    // changed.
    if (filename.endsWith(".lock")) this.#publish({ type: "episodes", show: this.#ctx.key });
  }

  /** Tails the run logs in one directory — used when a watcher is first attached, and whenever a
   *  change arrives without a filename.
   *
   *  Two of them, not all of them: the episode's latest run, and any run the store is already
   *  caching. The latest run is the only log anything will ever append to — one lock per run,
   *  and a launch is refused while the previous run is live — so it is the one a watcher
   *  attached to a directory that already had a log in it would otherwise never read, which is
   *  exactly the case the poll creates when a worker makes `runs/` and writes its first lines in
   *  the same moment. Older runs are finished and inert; reading them at startup would load
   *  every run the show has ever made into memory to answer a question nobody asked, and
   *  `get()` tails one on demand when an operator opens it. */
  async #rescanDir(episodeId: string, dir: string): Promise<void> {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    const runIds = names
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => n.slice(0, -".jsonl".length))
      .filter((id) => RUN_ID.test(id))
      .sort();
    const latest = runIds[runIds.length - 1];
    for (const runId of runIds) {
      if (runId === latest || this.#logs.has(`${episodeId}/${runId}`)) await this.#tailAndPublish(episodeId, runId);
    }
  }

  /** The poll: re-lists the show's episodes, watches any whose runs directory has appeared, and
   *  says so when the list itself changed — a new episode is a new Board row. */
  async #rescan(): Promise<void> {
    if (this.#closed) return;
    // The bible pass first and in its own try, so a show whose episode list cannot be read — a
    // directory being restored, a volume being mounted — still has its interview watched. The
    // first run of a bible file is created by the route that starts it, and this is what notices.
    for (const entry of BIBLE_FILES) {
      if (entry.mode !== "scaffold") await this.#watchSetup(entry.key);
    }
    let ids: string[];
    try { ids = await listEpisodeIds(this.#ctx.showRoot, this.#ctx.show); } catch { return; }
    const changed = ids.length !== this.#episodeIds.length || ids.some((id, i) => id !== this.#episodeIds[i]);
    this.#episodeIds = ids;
    for (const id of ids) await this.#watchEpisode(id);
    if (changed) this.#publish({ type: "episodes", show: this.#ctx.key });
  }
}

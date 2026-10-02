/** The types the console's server and client both read: the status vocabulary the worker's
 *  outcomes are drawn from, what a reader of a run's lock file can say about the process running
 *  it, and the three altitudes the server serves — the Board's `EpisodeRow`, one run's `RunView`
 *  with its `StepRow`s, and the `EventBatch` a client tails a log with. Nothing here imports the
 *  engine: the client bundles this file, and an engine import would drag `node:fs` into it,
 *  which is why `stage`, `kind` and `StepRow.status` are plain strings rather than the engine's
 *  `Stage`, `Step["kind"]` and `StepStatus` unions. */

/** What the console reports for an episode's latest run, or for a run it is showing. Six states,
 *  and only two of them are not in the run log: "none" is an episode that has never run, and
 *  "crashed" is a run whose log stops mid-step with no `run_finished` — the worker died, or its
 *  `run()` rejected. The worker's own `WorkerOutcome.status` is the four of these a finished
 *  `runOnce` can report: `Exclude<RunStatus, "none" | "running">`. */
export type RunStatus = "none" | "running" | "waiting" | "failed" | "crashed" | "completed";

/** The worker holding a run, as a reader of the run's `<runId>.lock` sees it. `pid`,
 *  `heartbeatAt` and `groups` are the lock's own fields, written by the worker on every beat;
 *  `alive` is the reader's verdict on `pid` at the moment it read the file, since a lock whose
 *  worker died without its `finally` is still on disk. `groups` are the process-group ids of the
 *  worker's live script children, so the console can kill a render the worker is supervising
 *  without having to find it. */
export interface WorkerInfo {
  pid: number;
  heartbeatAt: string;
  alive: boolean;
  groups: number[];
}

/** One row of the Board: everything the operator needs to decide whether an episode wants
 *  attention, and nothing that requires opening the run. `stage` is a `Stage` string from the
 *  engine's vocabulary and `status` the state of the episode's latest run — "none" when the
 *  episode has never run. The type is a plain string rather than the engine's `Stage` union
 *  because this file is imported by the client, which must not pull the engine (and `node:fs`
 *  with it) into its bundle. `needs` carries the reasons and not only the flags: a row that says
 *  NEEDS_REFS without naming the three references that are missing sends the operator looking. */
export interface EpisodeRow {
  id: string;
  /** The `# ` heading of the episode's outline, else of its script, else the id itself. */
  title: string;
  /** A `Stage` string: "IDEA", "DRAFT_OUTLINE", "NEEDS_IMAGES", … */
  stage: string;
  status: RunStatus;
  /** The id of the episode's latest run; absent for an episode that has never run. */
  runId?: string;
  openGate?: { stepId: string; attempt: number; openedAt: string };
  failed?: { stepId: string; error: string };
  /** Why the episode is blocked, in the operator's words: whether the premise is missing, and
   *  the exact references and showrunner-made shots that are not on disk. */
  needs: { ideaMissing: boolean; refsMissing: string[]; imagesMissing: string[] };
  /** The timestamp of the last event in the latest run's log — the "time since anything moved"
   *  the Board sorts and colours by. */
  lastEventAt?: string;
  worker?: WorkerInfo;
}

/** One step of a run as the console draws it: the row exists for every step of the pipeline
 *  definition, so a step the log never mentions is `status: "pending"` with nothing else set.
 *  `status` is a `StepStatus` string ("pending", "running", "completed", "failed", "skipped",
 *  "waiting", "bypassed") and `kind` a `Step["kind"]` string ("guard", "script", "agent",
 *  "gate", "loop"); both are plain strings for the same reason `EpisodeRow.stage` is.
 *  `flag` is the one judgment the row carries that the log does not state outright: a loop
 *  iteration that called no tool did nothing, and one that errored failed. */
export interface StepRow {
  id: string;
  kind: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  result?: unknown;
  progress?: { done: number; total: number; unit: string; message?: string; ratePerSec?: number; etaSec?: number };
  toolCalls?: number;
  flag?: "did-nothing" | "failed-iteration";
}

/** One run at the middle altitude: which step is in flight, how far into it, what is open, and
 *  the whole step list in pipeline order. `offset` is the byte offset in the run's log that this
 *  view was built from, so a client that holds a view can ask for exactly the events it has not
 *  seen (`/events?after=<offset>`) rather than re-reading the log. */
export interface RunView {
  episodeId: string;
  runId: string;
  status: RunStatus;
  /** A `Stage` string, derived from the run's state and the episode's needs. */
  stage: string;
  startedAt?: string;
  finishedAt?: string;
  lastEventAt?: string;
  /** The step in flight. Carries no progress of its own: the progress is on that step's row. */
  position?: { stepId: string; startedAt: string };
  openGate?: { stepId: string; attempt: number; message: string; openedAt: string };
  failed?: { stepId: string; error: string };
  /** Every step of the pipeline definition, in pipeline order, overlaid with the log. */
  steps: StepRow[];
  /** The pipeline the run recorded on its `run_started`: its name, and the hash and engine
   *  version if the log carried them. A hash that differs from the pipeline the console just
   *  built is the "this run is older than the code" answer. */
  pipeline: { name: string; hash?: string; engineVersion?: string };
  worker?: WorkerInfo;
  offset: number;
}

/** A slice of a run's log, with the byte offset to resume from. The console's clients never read
 *  a log from the start twice: they hold the offset the last batch returned and ask for what has
 *  been appended since. */
export interface EventBatch {
  events: Array<{ ts: string; stepId?: string; kind: string; payload: Record<string, unknown> }>;
  offset: number;
}

/** What the server pushes over its one SSE channel. Each message is a notice, not a payload: a
 *  "run" message says a log grew and to what offset, leaving the client to fetch the bytes it is
 *  missing, and an "episodes" message says some episode's status changed and the Board should
 *  re-read. "hello" is sent once, first, so a client knows the channel is open and who it is
 *  talking to. */
export type SseMessage =
  | { type: "run"; episodeId: string; runId: string; offset: number }
  | { type: "episodes" }
  | { type: "hello"; operator: string; showName: string };

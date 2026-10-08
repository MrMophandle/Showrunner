/** The types the console's server and client both read: the status vocabulary the worker's
 *  outcomes are drawn from, what a reader of a run's lock file can say about the process running
 *  it, and the three altitudes the server serves — the Board's `EpisodeRow`, one run's `RunView`
 *  with its `StepRow`s, and the `EventBatch` a client tails a log with — plus the `GateView` the
 *  Gate page draws and the `WhatHappenedContext` the troubleshooter is handed.
 *
 *  Nothing here imports engine *code*: the client bundles this file, and a value import from the
 *  engine would drag `node:fs` into the browser bundle. That is why `stage`, `kind` and
 *  `StepRow.status` are plain strings rather than the engine's `Stage`, `Step["kind"]` and
 *  `StepStatus` unions. The one exception is the `import type` below, which TypeScript and
 *  esbuild both erase: `WhatHappenedContext.pipeline` *is* the engine's `PipelineDescription`,
 *  and mirroring its twenty fields here would be two declarations to keep in agreement. Keep the
 *  `type` keyword on it. */
import type { PipelineDescription } from "@showrunner/engine";

/** What the console reports for an episode's latest run, or for a run it is showing. Seven
 *  states, and three of them are not in the run log: "none" is an episode that has never run,
 *  "crashed" is a run whose log stops mid-step with no `run_finished` — the worker died, or its
 *  `run()` rejected — and "archived" is an episode that was finished outside the engine, which
 *  says so in an `archive.json` marker beside its files rather than in a log it never had. The
 *  worker's own `WorkerOutcome.status` is the four of these a finished `runOnce` can report:
 *  `Exclude<RunStatus, "none" | "running" | "archived">`. */
export type RunStatus = "none" | "running" | "waiting" | "failed" | "crashed" | "completed" | "archived";

/** One registered show, as `GET /api/shows` lists it and `GET /api/shows/:show` answers for one.
 *
 *  `key` is the operator's own name for the show, from the registry — the segment every URL
 *  carries and the value every SSE message is stamped with. It is not derived from the config:
 *  `showName` and `showSlug` are the only identity fields a `showrunner.json` has, and the two
 *  shows this console was built against declare the same value for both (ruling H-02). `readOnly`
 *  is why a client draws no Launch button, no gate answer and no New-episode form for a show: the
 *  server refuses every POST to it, and a button that is refused is worse than no button.
 *
 *  Declared here rather than in the client because two things now read it — the client, and the
 *  server's own `/api/shows` route, which builds one of these per context. */
export interface ShowInfo {
  key: string;
  readOnly: boolean;
  showName: string;
  showSlug: string;
  operator: string;
  episodesDir: string;
  productionDir: string;
  stages: string[];
  engineVersion: string;
}

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
 *  NEEDS_REFS without naming the three references that are missing sends the operator looking.
 *
 *  **An archived episode is `status: "archived"` with `stage` taken from its `archive.json`
 *  marker, `archiveNote` carrying the marker's one line, and every list in `needs` empty** — it
 *  was finished outside the engine and needs nothing. The marker is read only for an episode with
 *  no run logs (`idleEpisodeRow`, `server/episodes.ts`), so it can never contradict a log. */
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
  /** The one line of the episode's `archive.json` marker, shown beside the "archived" chip —
   *  where the finished episode is and what made it. Set only for `status: "archived"`. */
  archiveNote?: string;
  /** The timestamp of the last event in the latest run's log — the "time since anything moved"
   *  the Board sorts and colours by. */
  lastEventAt?: string;
  worker?: WorkerInfo;
  /** Set when the store could not read this row's own data to the end, in either of the two ways
   *  that happens. For a run: "this run's log could not be read past byte N: <message>" —
   *  everything else on the row is then derived from the bytes before N, which is a row that has
   *  stopped moving, and a row that has stopped moving without saying so is the worst thing the
   *  Board can show. For an episode with no runs: "archive.json: <reason>" — the archive marker
   *  is there and unreadable, and the stage beside it is the derived one, not the marker's. */
  logError?: string;
  /** Set on the **one** row a show yields when its rows could not be read at all: `id` is the
   *  empty string and this carries the reason.
   *
   *  The Board gathers its rows per show and catches per show, so one show whose episode files
   *  throw — a malformed `images/prompts.json`, an unreadable `Canon/refs.json` — becomes one row
   *  saying so instead of a 500 that tells the operator nothing about which show is at fault
   *  (ruling H-14). `logError` is the narrower fact (this row's own log or marker stopped being
   *  readable); `error` means no row for this show could be built. */
  error?: string;
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
  /** The pipeline the run recorded on its `run_started` set beside the pipeline the console built
   *  for the same episode just now: `name`, `hash` and `engineVersion` are the log's own (absent
   *  when the log did not record them), `hashNow` is the hash of the pipeline the code builds
   *  today, and `changed` is the answer to "is this run older than the code" — true only when the
   *  log recorded a hash and it differs from `hashNow`, marked the way `PromptAtRun.changed`
   *  marks a prompt that was edited after the run read it. */
  pipeline: { name: string; hash?: string; engineVersion?: string; hashNow: string; changed: boolean };
  worker?: WorkerInfo;
  offset: number;
  /** The last lines of `<runId>.worker.log` — the worker's own account of how the segment ended —
   *  carried only for a run whose status is "crashed", and absent when the file does not exist.
   *  A `run()` that rejected removes its lock in the `finally`, so this file is the whole of the
   *  explanation for that crash and the run log has no entry for it at all (ruling F-09). */
  workerExit?: string;
  /** Set when the store could not read this run's log to its end: "this run's log could not be
   *  read past byte N: <message>". Every other field of the view is then derived from the bytes
   *  before N — a view frozen at the bad byte, which the page says rather than hides. */
  logError?: string;
}

/** One event of a run's log on the wire: the engine's `Event` without its `runId`, which every
 *  event of one log repeats, and with `kind` as a plain string for the reason the file header
 *  gives. Named rather than inlined because two things carry it — the `EventBatch` a client tails
 *  with, and the `WhatHappenedContext` the troubleshooter reads. */
export interface WireEvent {
  ts: string;
  stepId?: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** A slice of a run's log, with the byte offset to resume from. The console's clients never read
 *  a log from the start twice: they hold the offset the last batch returned and ask for what has
 *  been appended since. */
export interface EventBatch {
  events: WireEvent[];
  offset: number;
}

/** Where one bible file stands, derived from four things and nothing else: its `BIBLE_FILES` row,
 *  its `Production/setup/<key>/answers.md`, the latest log under
 *  `Production/setup/<key>/runs/` and the lock beside that log.
 *
 *  **The file's own presence on disk is not one of the four**, deliberately: `init` scaffolds or
 *  imports every bible file before anybody is interviewed, so a file existing says nothing about
 *  whether its interview has happened. The state is the interview's, not the file's.
 *
 *  The nine, in the order an interview passes through them. `pending`: nothing has happened —
 *  there is no run and no answer saved. `answering`: answers are on disk and the writer has not
 *  been started. `running`: a worker is holding the file's latest run. `gate`: the run is parked
 *  at its gate, waiting for one of the four answers. `approved`, `imported` and
 *  `written-by-author` are the three ways an approval is recorded, told apart by the notes on the
 *  approving `gate_answered` — nothing, "imported from <path>", or "the author writes this file" —
 *  so a file approved from the terminal reads the same as one approved from the browser.
 *  `stalled`: the gate was rejected its maximum ten times and the file on disk is the last
 *  revision the fix agent made, which is the author's to finish. `failed`: anything else that
 *  ended badly — the writer agent failed, or the run crashed with no worker holding it.
 *
 *  There is no `crashed` member, because a crash is a fact about a run and not about a file: the
 *  row says `failed` and `BibleFileView.run.status` says `crashed`, which is what lets the page
 *  offer "start again" with the worker's own account beside it. */
export type BibleState =
  | "pending" | "answering" | "running" | "gate"
  | "approved" | "imported" | "written-by-author"
  | "stalled" | "failed";

/** One row of the Bible view: one of the fifteen files `BIBLE_FILES` names, with where its
 *  interview stands and how much of its form is filled in.
 *
 *  `key`, `file`, `mode` and `purpose` are the engine's table, not the show's, so the rows are the
 *  same fifteen for every show. `mode` decides what the row can do: an `interview` file has
 *  questions and a writer, a `default` file has a house template and a gate over it, and a
 *  `scaffold` file has neither — the pipeline fills it, there is nothing to interview and no run
 *  can be started for it, which is why a scaffold row stays `pending` for the life of the show.
 *
 *  `runId` and `attempt` are the file's latest run and the attempt its gate is open at, absent for
 *  a file that has never run. `attempt` is what an answer carries back as `expectedAttempt`, which
 *  is the protection against a tab left open across a rejection. `questions` is how many the
 *  file's canon template asks (nine for `world-overview`, zero for the three default and two
 *  scaffold files) and `answered` how many have a real answer — not blank — so the rail can show
 *  "4 of 9" without fetching every file's answers. */
export interface BibleRow {
  key: string;
  /** The file, relative to the show root, with the show's own canon directory in it. */
  file: string;
  mode: "interview" | "default" | "scaffold";
  /** One sentence from `BIBLE_FILES`: what this file is for. Shown before the questions. */
  purpose: string;
  state: BibleState;
  runId?: string;
  attempt?: number;
  questions: number;
  answered: number;
}

/** One bible file at the altitude the Bible page draws: its row, its questions with whatever is
 *  answered, the gate's message when a gate is open, the file itself, and its latest run.
 *
 *  `questionsList` is the canon template's questions in template order joined to the answers on
 *  disk by heading — one textarea per entry, with `answer` as the prefill and `""` for a question
 *  nobody has answered. `prior` says those answers came from an earlier sitting rather than from
 *  this one, which is what lets the form say so; it is true exactly when `answers.md` is on disk.
 *  `content` is the file's text when it is readable, because the gate shows the whole file as the
 *  terminal prints it whole — `GET bible/:key/file` serves the same bytes for a raw view. */
export interface BibleFileView extends BibleRow {
  questionsList: { heading: string; question: string; answer: string }[];
  gateMessage?: string;
  content?: string;
  run?: SetupRunView;
  prior: boolean;
}

/** One setup run as the Bible page draws it: a projection over `bibleFilePipeline`'s own
 *  description and the run's log, and **not** the episode's `RunView`.
 *
 *  A bible file's pipeline is one or two steps — `write` then `gate` for an interviewed file, the
 *  gate alone for a default one — so the episode's sixty-eight-step view would describe a setup
 *  run as an episode with every step pending (inventory §4.3). `status` is derived by the same
 *  ladder `RunView.status` is, so a bible run and an episode run cannot come to disagree about
 *  what "crashed" means: it is a run whose log stops mid-step with no live worker holding its
 *  lock. `gate` is the open gate's attempt and message; `error` is the failed step's message;
 *  `offset` is the byte offset in the log this view was built from, so a client can ask for
 *  exactly the events it has not seen. */
export interface SetupRunView {
  runId: string;
  status: "none" | "running" | "waiting" | "failed" | "completed" | "crashed";
  steps: { id: string; status: string; startedAt?: string }[];
  gate?: { attempt: number; message: string };
  error?: string;
  offset: number;
}

/** What the server pushes over its one SSE channel. Each message is a notice, not a payload: a
 *  "run" message says a log grew and to what offset, leaving the client to fetch the bytes it is
 *  missing, and an "episodes" message says some episode's status changed and the Board should
 *  re-read. "hello" is sent once, first, so a client knows the channel is open and who it is
 *  talking to.
 *
 *  **`show` is on every notice, and it is load-bearing.** One channel carries the notices of every
 *  registered show, and the two shows this console was built against both hold an episode called
 *  `s02e01`: without the key, a Board watching one show would refetch on the other show's every
 *  heartbeat and a Run page would tail a log that is not the one it is drawing (ruling H-12). The
 *  channel stays one stream rather than one per show because a client that is looking at two shows
 *  in two tabs should still cost one connection.
 *
 *  `hello` carries the list and not one name, because the list is what the Shows page draws and
 *  what tells a client which shows refuse a POST before it offers a button that would be refused.
 *  The `setup` variant is the interview's runs, written by Task 5's setup worker; it is declared
 *  here from the start so the client's parser accepts it before anything publishes one. */
export type SseMessage =
  | { type: "run"; show: string; episodeId: string; runId: string; offset: number }
  | { type: "episodes"; show: string }
  | { type: "setup"; show: string; key: string; runId: string; offset: number }
  | { type: "hello"; operator: string; shows: { key: string; showName: string; readOnly: boolean }[] };

/** One file (or one directory of files) a gate refers to, as a url the artifact route serves.
 *
 *  `kind` says how to render it and `label` is what the operator sees. `url` is what the client
 *  fetches; `listUrl` is set when `url` names a **directory**, and it is the address whose JSON
 *  listing enumerates the files to render, each of them at `url` + "/" + the entry's name. The
 *  two are the same string, because one route serves both a file and a listing — so the presence
 *  of `listUrl` is the client's one unambiguous test for "this artifact is a directory", rather
 *  than it having to infer that from `kind`. */
export interface GateArtifact {
  kind: "markdown" | "audio" | "video" | "images" | "diff" | "json" | "text";
  label: string;
  url: string;
  listUrl?: string;
}

/** Everything the Gate page draws: the question the gate is asking, the files it is asking about,
 *  and the evidence the pipeline gathered before it asked.
 *
 *  `attempt` is load-bearing and not decoration. The showrunner answers the attempt they read,
 *  and the answer carries that number back as `expectedAttempt`, so an answer written against a
 *  message that a rejection has since superseded is refused by the engine rather than applied to
 *  a newer ask nobody read. `verdicts` are the verdict-shaped step results of this run, by step
 *  id; `rejections` is every note the gate has already been rejected with, oldest first;
 *  `maxAttempts` is the gate's cap from the pipeline definition, absent for a gate with none. */
export interface GateView {
  episodeId: string;
  runId: string;
  stepId: string;
  attempt: number;
  openedAt: string;
  /** The gate's rendered message — several paragraphs of prose, which is why the Board's row
   *  carries the gate's identity and not this. */
  message: string;
  artifacts: GateArtifact[];
  verdicts: Record<string, unknown>;
  rejections: string[];
  maxAttempts?: number;
}

/** One prompt file an agent step ran, as the run recorded it and as it stands on disk now.
 *  `hashAtRun` is the sha256 the engine logged on that step's `agent_query`; `hashNow` is the
 *  sha256 of the same file today, or null when the file is gone. `changed` is the answer to "did
 *  someone edit the prompt after this run read it", which is the first question to ask about a
 *  run that behaved unlike its neighbours. */
export interface PromptAtRun {
  stepId: string;
  promptFile: string;
  hashAtRun: string;
  hashNow: string | null;
  changed: boolean;
}

/** What the troubleshooter is handed before it is asked anything: the pipeline as a document, the
 *  run at the middle altitude, the run's events with the chatter collapsed, the prompts by hash,
 *  and every file the run wrote.
 *
 *  `events` is collapsed rather than complete because a render writes a `script_line` per second
 *  and a loop a `step_progress` per iteration: a whole log would be mostly chatter, and the
 *  chatter would crowd out the events that say what happened. The last fifty lines of a step are
 *  the ones that carry its failure, and only the last progress of a step says how far it got. */
export interface WhatHappenedContext {
  pipeline: PipelineDescription;
  /** The hash of the pipeline above — the one the code builds today. The run's own recorded hash
   *  is `run.pipeline.hash`, and the two differing is the "this run has steps the code does not"
   *  answer, which is the question a troubleshooter would otherwise have to guess at. */
  pipelineHashNow: string;
  run: RunView;
  events: WireEvent[];
  prompts: PromptAtRun[];
  /** Every path named by any `outputHashes` the run recorded, sorted and without repeats. */
  outputs: string[];
}

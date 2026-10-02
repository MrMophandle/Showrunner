/** The types the console's server and client both read. This file carries the worker's part of
 *  them — what a reader of a run's lock file can say about the process running it, and the status
 *  vocabulary the worker's outcomes are drawn from. Task 4 adds the rest of the wire types
 *  (`EpisodeRow`, `StepRow`, `RunView`, `EventBatch`, `SseMessage`) beside these. */

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

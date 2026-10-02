# Plan E (the console) — deferred items and rulings

**Status:** Plan E is built on one branch, `plan-e` in the engine repository (branched from `main` at `adf9b1c` on 2026-09-30; `git log adf9b1c..plan-e` is the commit list). The show repository was read during the live check and never written. The final tree passes the engine suite (229 tests, 4 env-gated exercises skipped in the ordinary run), the console suite (116), the tools suite (20) and the scripts suite (350) with every typecheck silent and the show-name grep — which now covers `console/` — empty. The whole-branch review returned "ready to merge with fixes" (one Critical, four Importants, three Minors); one fix wave and one follow-up commit addressed every one of them and the parked minors of the nine task reviews, and a scoped re-review confirmed them.

This document is the durable record of what the review process deferred to later plans and of every ruling the controller made during execution. The plan file (`docs/plans/2026-10-02-the-console.md`) describes what was built and rules on the inventory's thirty-one findings; the inventory (`docs/plans/2026-09-30-plan-e-inventory.md`) records what was found. Each later plan's author reads their section here, together with the Plan A–D records (`docs/plans/2026-09-26-engine-core-deferred.md`, `2026-09-27-agent-runner-deferred.md`, `2026-09-28-show-config-and-prompts-deferred.md`, `2026-09-29-the-dead-light-pipeline-deferred.md`).

## What Plan E established that later plans build on

- **Three processes.** The **worker** (`console/worker/main.ts`, one per run segment) takes a lock beside the run's log, builds the pipeline and the real executors, calls `run()` once, heartbeats its live process groups into the lock, and exits with 0 (waiting or completed), 1 (a step failed), 2 (crashed: `run()` rejected or the lock was held) or 143 (signalled). The **server** (`console/server/`, Hono) owns no run: it lists episodes, tails every run log by byte offset, pushes `{episodeId, runId, offset}` over one SSE channel, serves the artifacts a gate names from under the episode's own two directories with HTTP Range, and turns every action into one engine append followed by one detached worker spawn. The **client** (`console/src/`, React 18 + Vite) is the four surfaces.
- **The files beside a run log:** `<runId>.lock` (`{pid, startedAt, heartbeatAt, groups}`; live while its pid is alive), `<runId>.worker.log` (one line per outcome; the stack of a rejected `run()`), `<runId>.worker.out` (the worker's stdout and stderr), `<runId>.troubleshooting.jsonl` (every "what happened" question and answer). The run log itself stays the only source of truth.
- **The engine's additions for a server:** `EventLog.readFrom(offset)` and `logPath(…, productionDir)`; `runs.ts` (`mintRunId` — sortable, `YYYYMMDDTHHMMSSZ-xxxx`; `listRuns`, `latestRunId`, `runLogPaths`); `episodes.ts` (`listEpisodeIds`); `answerGate`'s `expectedAttempt`; `withdrawApproval` (a rejection of an approved gate: downstream non-gate steps reset, the ordinary rejection path reopens it); `describePipeline`/`pipelineHash`, recorded with `ENGINE_VERSION` on `run_started`; `killLiveProcessGroups → {killed, failed}`; `RunOptions.concurrency` (ready agent steps batched; the review panel runs seven-wide).
- **The status rule.** For an unfinished run with no open gate: a live lock → `running`; an empty log → `none`; a step in flight with no live lock → `crashed` (a killed worker or a rejected `run()` — a healthy worker holds the lock for the whole segment); nothing in flight → `running` within 60 s of the last event, else `crashed`.
- **The Board row** carries `stage`, `openGate` and the `needs` reasons separately, so a `NEEDS_` state and an open gate show together; `status` and the failed step sit beside the stage, so a failed run is never reported as progress.
- **The console's writes outside the log:** `premise.md` for a new episode (`POST /api/episodes`, `wx`, 409 on an existing file) and nothing else. Launch is disabled with the reason on a row whose premise is missing.
- **`scripts/render-video.py`** wraps the Remotion render and emits `::progress` from Remotion's own `Rendered N/M` lines (measured on Remotion 4.0.487 under a pipe: newline-separated, no `\r`, no ANSI, printed at `--log=info`); `--progress-interval` throttles it (default one per second).

## Plan F — cutover

- Console v1, `.archon/`, `remotion/` and the root `package.json` leave the show repository; `STATUS.md` and the six `status.py` steps retire. **The Season 1 episodes read `NEEDS_IDEA · no runs` on the Board** because they predate the engine and have no `premise.md`; Plan F decides whether archived episodes get a marker file the Board reads or a Board rule keyed on an existing `script.md` with no run.
- `prompts/index.json` can be deleted.
- `prompts/audio-gate.gate.md`'s air-named glob and the ten `epNN` encodings the inventory listed in console v1 go with v1.

## Plan G — new-show setup

- A show registry over `--show` (one server, many shows) is Plan G's; `ShowContext` already takes one root and nothing else assumes a single show.
- The New-episode form is the first thing `init` teaches; the `## Cast` grammar and the `source` field travel with the prompts.

## The first real run

- The SDK child under the worker's `SIGTERM`: its pid is not in the lock's `groups` (only script children are registered); the abort lever is the worker's only hold on it. Measure.
- `render-video.py` against a full-length render: the final minutes (Remotion's encode summary) were not observed in the 45-second measurement; they are forwarded as `script_line`s.
- The fan-out's rate-limit exposure with seven concurrent SDK queries.
- Whether 2,000 events is the right window for the feed, and whether one `step_progress` per second (about 2,100 per render) is the right rate.
- `step_started` order within a concurrent batch is the order each step's input hashing finished, not pipeline order; no view assumes otherwise.

## What the whole-branch review deferred (2026-10-02)

- **`killRecordedGroups` guards against `process.pid`** where the dangerous collision is the server's own process group (`process.getpgid(0)`); the `group <= 1` guard covers the catastrophic cases.
- **`takeLock`'s exhausted loop reports `pid -1`** (three processes contending on one run id in one tick).
- **The two `main()` guards compare a resolved path with a realpath**; a checkout reached through a symlink would exit 0 having done nothing. No symlink exists today.
- **The Board's refresh is a full per-episode projection at up to 4 Hz during a run**, and `RunStore` never evicts a tailed log (F-21 ruled no cap). Fine at one show's scale; measure on the first real run.
- **`step_started` order inside a concurrent batch is the order the steps' input hashing finished**, not pipeline order; array order still equals file order.
- **The withdrawn `attempt` number recorded on a withdrawal is the withdrawn attempt**, not the reopened one; the Gate page's copy says so.
- **Console v1 was still listening on port 4400** (pid 3353, started 2026-09-30) during the live check; the new server bound `127.0.0.1:4400` beside it. Plan F retires v1; until then check `lsof -ti :4400` before trusting a live check, and `--host` would collide outright.
- **The Playwright MCP server writes screenshots and scratch into the show repository by default**; a screenshot task against the real show must move them out.
- **`ep99`** is a production directory holding a spike, not an episode; it joins Plan F's archived-episode question with Season 1.

## Not built

- A content-addressed prompt store (inventory F-19): "what happened" reports a prompt changed since the run and nothing more.
- A protocol-relative link (`//host/path`) in a gate message is kept by `safeHref` (test-locked as kept); it reaches another host with the console's scheme.
- The season map, the desk, discuss, notes, the standalone buttons (spec §7.2). Re-roll and the ambient pass are rejection notes naming shot ids.
- Auth (home network only; `--host` binds all interfaces, else loopback). Log rotation. A browser test suite (the client's rendering evidence is the seeded-show walkthrough's screenshots).

## Rulings made during execution (2026-10-02), with the cost if wrong

1. **Each run lives in a detached worker process** (Ryan, 2026-10-02, the inventory's F-01/F-02 option B). Cost: a lock file, a file tail instead of memory, one more process to test.
2. **The kill test clears its fake pids before restoring `process.kill`**, and the two existing `formatAired` assertions were rewritten rather than appended beside (Task 1). Cost: none.
3. **A heartbeat write in flight is awaited before the lock is removed** (Task 3; the implementer found the race). Cost: none.
4. **The progress rate collapses runs of equal `done` to their first timestamp; the loop flag scans every iteration since the loop's last start with `error` taking precedence** (Task 4; the brief's prose disagreed with its own tests). Cost: a rate or a flag shown slightly differently.
5. **A step in flight with no lock is a crash** (Task 4, fix round 1; the brief's fixture was wrong, its prose right). Cost: none.
6. **Live-lock refusal → engine append → detached spawn, in that order, for every action** (Task 5). Cost: none.
7. **The throttle is an argv flag, `--progress-interval`**, not an environment setting; the measured `--log=info` replaces the brief's guessed `--log=verbose` (Task 7). Cost: none.
8. **Test fixtures name the invented show only**; the brief's `s03-opha-still` was the controller's own slip (Task 6). Cost: none.
9. **The composed rejection block is held in state and replaced by exact match; Launch is disabled with a reason when the premise is missing** (Task 6). Cost: none.
10. **Task 9 ran before Task 8**, not after it as the plan's budget rule said, because no budget signal fired and its files did not overlap Task 6's. Cost: none.
11. **The whole-branch review's fix-before-merge set was taken whole** — the launch that creates its log before spawning and refuses while the latest run is unfinished (C-1); the worker entry checked at startup (I-1); the worker log surfaced on the Run page (I-2); a tail failure shown rather than frozen (I-3); withdraw offered only on the latest approved gate with the surviving gates named, the engine's rule unchanged (I-4); `safeHref` stripping what a browser strips (M-1); the lock beaten atomically by rename (M-2); the pipeline hash compared with today's (M-3) — plus the parked minors of the nine task reviews. Cost if wrong: one fix wave and one scoped re-review.
12. **A launch whose spawn fails removes the log it created** (fix round 2; the fix wave's own implementer found that the `wx` log would otherwise wedge the episode). Cost: none.
13. **Reviewers on Sonnet, implementers and the whole-branch reviewer on Opus; the three-question quiz before every implementer** — it caught, in this plan, a missing-test claim (T1), the heartbeat race (T3), three prose-versus-test defects (T4), a URL-normalised traversal test (T5), the fixture slip (T6) and the throttle-versus-test tension (T7), each before code was written.

# The Console Implementation Plan (Plan E of 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the console of spec §7.2 — the Board, the Run view, the Gate view and "What happened" — as a new `console/` workspace in the engine repository, over the engine Plans A–D built, so that an episode can be launched, watched, gated, recovered and questioned from a browser on the home network, with every run living in a detached worker process that outlives the console.

**Architecture:** Three processes. **The worker** (`console/worker/main.ts`) is one short-lived Node process per run segment: it takes a lock beside the run's log, builds the pipeline and the real executors, calls `run()` once — which returns at the next gate, at the end, or on failure — heartbeats its live process groups into the lock, and exits. **The server** (`console/server/`, Hono on Node) never runs a step: it lists episodes, tails run logs incrementally and pushes changes over Server-Sent Events, serves the artifacts a gate names from under the episode's own directories with HTTP Range, and turns every action — launch, approve, reject, resume, re-run from here, withdraw an approval — into one log append plus one detached worker spawn. **The client** (`console/src/`, React 18 + Vite) is the four surfaces and nothing else. The event log stays the only source of truth: the server's projections are rebuilt from it on every start, and the worker's lock file is the one piece of state that is not in the log, because it answers a question the log cannot — "is anyone running this right now?"

**Tech Stack:** TypeScript 5 (strict, ESM, `NodeNext` for the server and worker; `bundler` resolution for the client), Hono 4 with `@hono/node-server`, React 18, React Router 6, Vite 6, `marked` for Markdown, vitest 2; the engine as a workspace dependency (`@showrunner/engine`). Python 3 for one new script (`scripts/render-video.py`).

**Spec:** `docs/specs/2026-09-25-console-rewrite-design.md` — §4.2 (detached execution becomes the only path), §4.4 (the fences: argv arrays, ids validated before they reach a process, the board as one derivation, no direct canon or script edits outside a gate), §4.6 (the orchestrator layer: a server-side job queue, the event stream, the board derivation), §6.5–§6.9 (the log as source of truth; three altitudes; progress; what the troubleshooting agent gets; restart by replay), §7.2 (four surfaces and no more; what is deferred), §7.3 (`console/` lives in the engine repository). **The inventory this plan is written from:** `docs/plans/2026-09-30-plan-e-inventory.md` — console v1 measured (§1), the engine API and its gaps (§2), the four surfaces against the data (§3), what moves and what is deleted (§4), and 31 findings (§5). **The obligations this plan pays:** the 24 collected in the inventory's first section (O-01…O-24), plus Plan D's Task 10.

**This is plan E of six.** A (engine core), B (agent runner), C (show config and prompts) and D (the Dead Light pipeline) are merged. F (cutover) and G (new-show setup) follow. **Ryan ruled 2026-10-02 that each run lives in a detached worker process the console launches and watches** (the inventory's F-01/F-02 fork, option B); this plan is that ruling worked out.

## Rulings on the inventory's findings (made 2026-10-02; the spec is the authority, this plan its argument)

| Finding | Ruling |
|---|---|
| F-01 the job queue's shape | **A detached worker per run segment** (Ryan's ruling). The server owns no run; it appends to the log and spawns a worker, for every action. The queue is the filesystem: a run that is "waiting" has an open gate in its log and no lock; a run that is "running" has a live lock. |
| F-02 "detached", and cross-process concurrency | **A lock file beside the log**, `<productionDir>/<id>/runs/<runId>.lock`, created with `wx` (exclusive) by the worker, holding `{pid, startedAt, heartbeatAt, groups}`; refreshed every five seconds. A lock whose `pid` is not alive is stale; the worker removes it and takes its own. The server refuses to spawn while a live lock exists. The engine's per-process `active` map stays as the in-process guard. |
| F-03 how the client learns of events | **The server tails each log by byte offset** (`EventLog.readFrom(offset)`), driven by `fs.watch` on each episode's `runs/` directory, and pushes `{episodeId, runId, offset}` over one SSE channel; the client fetches the increment. The Board listens to the same channel and recomputes one row. The runner's in-memory array is never consulted: the worker is a different process. |
| F-04 one show per server; failed runs on the Board | **One show per server process** (`--show <root>`); Plan G's registry comes later. The Board row carries the stage **and** the latest run's status (`none`, `running`, `waiting`, `failed`, `completed`) and, when failed, the failed step id and its error. |
| F-05 listing episodes | `listEpisodeIds(showRoot, show)`: the union of the directory names under `episodesDir` and `productionDir` that `isEpisodeId` accepts, sorted by `compareEpisodeIds`. `_TEMPLATE` and `_retired` fall out of the filter. |
| F-06 the browser and the show repository | **One artifact route, `GET /api/episodes/:id/files/*`**, that serves only paths under `<episodesDir>/<id>/` and `<productionDir>/<id>/`, resolved with v1's `safeResolve` fence, refusing dot segments and dotfiles, with HTTP Range (v1's `serveMediaRange`, ported). Nothing under `Canon/`, nothing under `.git`, never `showrunner.json`. The canon gate's patch and ledger are both inside those two trees. |
| F-07 which run is "the episode" | **Run ids are minted sortable**: `<UTC timestamp, 20061002T153000Z form>-<4 random base36>`, by `mintRunId()`. "The episode's run" is the lexically last `*.jsonl` under `runs/`; `priorLogs` is every earlier one, ascending. `listRuns` is an engine export. |
| F-08 the episode title | The first `# ` heading of `outline.md`, else of `script.md`, else the id — read by the server, show-agnostic. |
| F-09 a rejected `run()` promise | **The worker catches it**, writes the error to `<runId>.worker.log` beside the lock, exits with code 2; the lock is removed in `finally`. The Run view shows the worker's exit and offers **Continue**, which spawns a worker whose `run()` replays the step. |
| F-10 shutdown and orphans | `killLiveProcessGroups()` continues past any error and returns `{killed, failed}`. The worker heartbeats `liveProcessGroups()` into the lock; on `SIGTERM`/`SIGINT` it kills them and exits 143. **Continue** after a stale lock first kills the groups the lock recorded, with the ids shown. SDK children stay unrecorded (the abort lever; measured in the first real run). |
| F-11 attempt-blind `answerGate` | `answerGate` gains optional `expectedAttempt`; a mismatch throws `gate "<id>" is open at attempt N, not M`. The console always passes it and, on the error, re-renders the newer message and asks again. |
| F-12 `by` | The server's `--operator <name>` flag, default `os.userInfo().username`; every write records `console:<name>`. Required by the console, still optional in the engine. |
| F-13 a restart mid-render | Accepted as the resume contract states: a worker's death re-executes the interrupted step on Continue; a completed render is cached by its hashes. The console itself restarting changes nothing, because it runs no step. |
| F-14 the render's silence | `scripts/render-video.py` wraps `npx remotion render`, turning Remotion's own progress into `::progress` lines; the pipeline's `render` step calls it. Its first step measures Remotion's non-TTY output before parsing it. |
| F-15 starting an episode | **The console writes `premise.md`**, and nothing else: `POST /api/episodes` creates `<episodesDir>/<id>/premise.md` from a text box, refusing an existing file. It is the console's one write outside the log, named in its README. `Production/<id>/` is created by the first run's log. |
| F-16 a `NEEDS_` state beside an open gate | The Board row carries `stage`, `openGate` and `needs` (the reasons from `missingRefs`/`missingShowrunnerImages`) separately; the stage cell shows the `NEEDS_` state and a gate chip beside it. |
| F-17 the canon patch | Served by the files route; rendered client-side as a unified diff (v1's `DiffLines`, ported). |
| F-18 the pipeline definition is not serialisable | `describePipeline(pipeline)` returns a JSON description (ids, kinds, `dependsOn`, inputs, outputs, prompt and schema files, model, tools, `rerunOnReject`, `maxAttempts`, `until`/`maxIterations`, whether `when` is present); `run_started` gains `engineVersion` and `pipelineHash` (sha256 of that description). "What happened" hands the agent the description plus the evaluated argv the log records. |
| F-19 prompts by hash | "What happened" reads each prompt the log names from disk, compares `promptHash`, and says **"changed since the run"** when they differ; no content store (deferred to the record). |
| F-20 the troubleshooting harness | `sdkQuery` directly, `cwd` the show root, tools `Read, Glob, Grep`, model `show.models.medium`, the assembled context in the prompt; every question and answer appended to `<runId>.troubleshooting.jsonl` beside the run log, never to the run log. |
| F-21 log size | No cap. The tail reader and offsets make the size irrelevant to the live view; the Run view keeps the last 2,000 events in memory and offers the whole log as a download through the files route. |
| F-22 the gate message | Rendered as Markdown (`marked`, sanitised to text and links — no raw HTML). |
| F-23 the show-name grep | **`console/` joins the grep**, including `console/README.md`; test fixtures use an invented show. |
| F-24 terminal events without `kind` | The server's projection joins each step to its `step_started`; no runner change. |
| F-25 the dead-iteration rule | A `loop_iteration` with `toolCalls === 0` and no `error` is flagged **did nothing**; one with `error` is **failed**; the Run view marks both the moment they arrive. |
| F-26 "re-ask an approved gate" | **A new engine verb, `withdrawApproval(pipeline, log, runId, stepId, {notes, by})`**: resets every non-gate step downstream of the gate and appends a rejection answer; the next worker runs the fix agent, the rejection's own re-run set, and reopens the gate at the next attempt. No new event kind. |
| F-27 reset with an open gate | The Gate view disables "re-run from here" while a gate is open and says why; the Run view offers it only when no gate is open. |
| F-28 one executor across runs | One executor per worker; it dies with the run. The session map and the handler race are therefore bounded by one run. |
| F-29 `logPath` hardcodes `Production` | `EventLog.logPath(showRoot, episodeId, runId, productionDir = "Production")`. |
| F-30 Task 10 | **Inside Plan E as its last task, cut-able**; the worker passes `concurrency` from its `--concurrency` flag (default 1) once the option exists. |
| F-31 message-text and test obligations | Task 1: O-04, O-08 fixed; O-11's four tests added; O-16 recorded (the console labels cost "estimated"). |

**Rulings the findings did not ask for:**

- **Deferred surfaces stay deferred** (spec §7.2): no season map, desk, discuss, notes, or standalone buttons. Re-roll and the ambient pass are rejection notes naming shot ids, and the Gate view's image centres compose that note (v1's `composeShotRejection`, ported).
- **The console is a workspace of the engine repository**, `@showrunner/console`, with its own `package.json`, built by the root `npm run build`, tested by `npm test`.
- **The worker is the only process that imports the SDK**; the server imports the engine's log, state and config modules and `sdkQuery` for "what happened" only.
- **No auth beyond the home network**, as v1 (`console/README.md:54` there) — the README states it; the server binds `0.0.0.0` only when `--host` is given, else `127.0.0.1`.

## Global Constraints

- **One repository, one branch.** All work is on branch `plan-e` in `~/GitHub/Showrunner` (cut from `main` at adf9b1c; the inventory is its first commit, a412dd3). The show repository is read during the live check (Task 8) and never written by this plan. Nothing is merged or pushed to `main` by this plan.
- **"A script in the engine repository may not contain the name of a show"** (spec §7.4) now covers the console: after every task, `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ scripts/ render/ tools/ console/ --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=show-data --exclude-dir=.venv --exclude-dir=__pycache__ --exclude-dir=.pytest_cache --exclude-dir=public` prints nothing. Test fixtures use the invented show "Harbor Light" (slug `HarborLight`, characters Vale, the Warden, Pim, location Harbor).
- **The fences of spec §4.4:** argv arrays, never shell strings (every `spawn` is `spawn(cmd, args)`); every episode id and run id is validated by `parseEpisodeId` / the run-id grammar before it reaches a path or a process; the Board is one derivation (`deriveStage` over the log, never `STATUS.md`); the console edits no canon and no script — its only writes are the run log (through engine verbs), the lock and worker files beside it, the troubleshooting log, and `premise.md`.
- **The event log is the source of truth.** Every projection the server holds is rebuilt from the logs on start and refreshed from the logs on change; nothing the server keeps in memory is authoritative.
- **Never a directory as a declared path; `exactOptionalPropertyTypes` respected; every exported symbol carries a doc comment that says why.**
- **Every commit ends with this trailer line in its final paragraph** (use `git commit -F -` with a heredoc): `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Engine tests: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck` (208 passed, 4 skipped at the start). Console tests: `cd ~/GitHub/Showrunner/console && npx vitest run && npm run typecheck`. Scripts: `cd ~/GitHub/Showrunner/scripts && uv run pytest -q` (333). All must be clean before every commit that touches them.

---

## File Structure

```
~/GitHub/Showrunner/
  package.json                       workspaces gain "console"; build/test/typecheck run it
  engine/src/
    events.ts                        MODIFY: logPath(…, productionDir?); readFrom(offset)
    runs.ts                          NEW: mintRunId, listRuns, latestRunId, runLogPaths, RUN_ID
    episodes.ts                      NEW: listEpisodeIds
    runner.ts                        MODIFY: answerGate expectedAttempt + O-04 message; withdrawApproval; run_started gains engineVersion + pipelineHash; (Task 9) concurrency
    pipeline.ts                      MODIFY: describePipeline, pipelineHash
    script-step.ts                   MODIFY: killLiveProcessGroups → {killed, failed}, continues past errors
    ids.ts                           MODIFY: formatAired message (O-08)
    index.ts                         MODIFY: export runs, episodes
  engine/test/                       events, runs, episodes, runner (answerGate, withdrawApproval, run_started), pipeline (describe), script-step (kill), stages (O-11), ids
  scripts/render-video.py            NEW (Task 7); engine/src/pipelines/episode.ts render step calls it; engine/test/ep98-exercise.test.ts argv assertion updated
  console/
    package.json                     NEW: @showrunner/console
    tsconfig.json, tsconfig.server.json, tsconfig.client.json, vite.config.ts, vitest.config.ts, index.html
    shared/types.ts                  NEW: the wire types both sides import
    worker/main.ts                   NEW: runOnce(), the lock, heartbeat, signals, the CLI
    server/show.ts                   NEW: ShowContext (root, config, engineRoot, operator, paths)
    server/episodes.ts               NEW: episode rows (stage, status, gate, needs, title)
    server/runs.ts                   NEW: RunStore — tail cache per log, fs.watch, the SSE bus, projections
    server/workers.ts                NEW: spawnWorker (detached), readLock, isLive, killRecordedGroups
    server/artifacts.ts              NEW: safeResolve, the files route, Range, listing
    server/gates.ts                  NEW: the gate view model and the five actions
    server/what-happened.ts          NEW: assemble(), ask(), the troubleshooting log
    server/app.ts                    NEW: createApp(ctx) — every route
    server/main.ts                   NEW: the CLI (--show, --engine-root, --port, --host, --operator, --worker)
    src/                             NEW: main.tsx, App.tsx, api.ts, useDocTitle.ts, pages/{Board,Run,Gate,WhatHappened}.tsx, components/{Markdown,Diff,AudioSeek,ContactSheet,Progress,EventFeed,ActionBar,…}.tsx, console.css
    test/                            NEW: worker.test.ts, runs.test.ts, episodes.test.ts, app.test.ts (routes over a temp show + a fake worker script), gates.test.ts, artifacts.test.ts, what-happened.test.ts, client/*.test.ts (pure projections)
    test/fixtures/fake-worker.mjs    NEW: a worker stand-in the app tests spawn
    README.md                        NEW
  README.md                          MODIFY: "The console" section; the grep gains console/
  docs/plans/2026-10-02-the-console-deferred.md   NEW (by the controller, at the end)
```

---
## Task 1: The engine additions a server needs — tail reads, run and episode listing, attempt-checked answers, a shutdown that finishes

**Files:**
- Modify: `engine/src/events.ts` (`logPath` gains `productionDir`; `readFrom`)
- Create: `engine/src/runs.ts`, `engine/src/episodes.ts`
- Modify: `engine/src/runner.ts:34-57` (`answerGate`), `engine/src/script-step.ts:36-51`, `engine/src/ids.ts:44-47`, `engine/src/index.ts`
- Test: `engine/test/events.test.ts`, `engine/test/runs.test.ts` (new), `engine/test/episodes.test.ts` (new), `engine/test/gate.test.ts`, `engine/test/script-step.test.ts`, `engine/test/ids.test.ts`, `engine/test/stages.test.ts`

**Interfaces:**
- Produces:
  - `EventLog.logPath(showRoot, episodeId, runId, productionDir = "Production")`.
  - `EventLog.readFrom(offset: number): Promise<{ events: Event[]; offset: number }>` — parses complete lines from `offset`; a trailing partial line is not consumed, so the returned `offset` is the start of that line; a missing file returns `{events: [], offset: 0}`.
  - `RUN_ID: RegExp` (exported), `mintRunId(now = new Date()): string` (`YYYYMMDDTHHMMSSZ-xxxx`, lexically sortable), `listRuns(showRoot, episodeId, productionDir?): Promise<string[]>` (ascending), `latestRunId(...)`: the last or `undefined`, `runLogPaths(showRoot, episodeId, productionDir?)`.
  - `listEpisodeIds(showRoot, show: ShowConfig): Promise<string[]>` — the union of directory names under `episodesDir` and `productionDir` that `isEpisodeId` accepts, sorted by `compareEpisodeIds`.
  - `answerGate(log, runId, stepId, { approved, notes?, by?, expectedAttempt? })` — when `expectedAttempt` is given and differs from the open attempt, throws `gate "<id>" is open at attempt N, not M`. On an empty log the error is `no run in the log at <path>` (O-04).
  - `killLiveProcessGroups(): { killed: number; failed: number }` — continues past any error (O-02).
  - `formatAired`'s error names the parameter: `invalid season 0: season must be 1..99` (O-08).

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/events.test.ts`:

```ts
describe("readFrom", () => {
  it("returns the events after an offset and the offset to resume from, leaving a partial line unconsumed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "log-"));
    const log = new EventLog(path.join(root, "r.jsonl"));
    expect(await log.readFrom(0)).toEqual({ events: [], offset: 0 });
    await log.append({ runId: "r", kind: "run_started", payload: {} });
    await log.append({ runId: "r", stepId: "a", kind: "step_started", payload: {} });
    const first = await log.readFrom(0);
    expect(first.events.map((e) => e.kind)).toEqual(["run_started", "step_started"]);
    const partial = '{"ts":"t","runId":"r","kind":"step_comp';
    await appendFile(log.path, partial);
    const second = await log.readFrom(first.offset);
    expect(second).toEqual({ events: [], offset: first.offset });
    await appendFile(log.path, 'leted","payload":{}}\n');
    const third = await log.readFrom(second.offset);
    expect(third.events.map((e) => e.kind)).toEqual(["step_completed"]);
    expect(third.offset).toBe((await stat(log.path)).size);
  });
  it("logPath takes the production directory", () => {
    expect(EventLog.logPath("/show", "s02e01", "r1")).toBe(path.join("/show", "Production", "s02e01", "runs", "r1.jsonl"));
    expect(EventLog.logPath("/show", "s02e01", "r1", "Prod")).toBe(path.join("/show", "Prod", "s02e01", "runs", "r1.jsonl"));
  });
});
```

(Add `appendFile`, `stat` to the file's `node:fs/promises` import.)

Create `engine/test/runs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RUN_ID, mintRunId, listRuns, latestRunId, runLogPaths } from "../src/runs.js";

describe("runs", () => {
  it("mints sortable ids in the run-id alphabet", () => {
    const a = mintRunId(new Date("2026-10-02T15:30:00Z"));
    const b = mintRunId(new Date("2026-10-02T15:30:01Z"));
    expect(a).toMatch(/^20261002T153000Z-[a-z0-9]{4}$/);
    expect(RUN_ID.test(a)).toBe(true);
    expect(a < b).toBe(true);
  });
  it("lists an episode's runs ascending by id, ignoring other files, and names the latest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const dir = path.join(root, "Production", "s02e01", "runs");
    await mkdir(dir, { recursive: true });
    for (const f of ["20261002T100000Z-b2.jsonl", "20261001T090000Z-a1.jsonl", "20261002T100000Z-b2.lock", "notes.txt", "20261003T000000Z-c3.jsonl"]) await writeFile(path.join(dir, f), "");
    expect(await listRuns(root, "s02e01")).toEqual(["20261001T090000Z-a1", "20261002T100000Z-b2", "20261003T000000Z-c3"]);
    expect(await latestRunId(root, "s02e01")).toBe("20261003T000000Z-c3");
    expect(await listRuns(root, "s02e02")).toEqual([]);
    expect(await latestRunId(root, "s02e02")).toBeUndefined();
    expect(await runLogPaths(root, "s02e01")).toEqual(["20261001T090000Z-a1", "20261002T100000Z-b2", "20261003T000000Z-c3"].map((r) => path.join(dir, `${r}.jsonl`)));
  });
  it("refuses an invalid episode id before touching the filesystem", async () => {
    await expect(listRuns("/nowhere", "../x")).rejects.toThrow(/invalid episode id/);
  });
});
```

Create `engine/test/episodes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listEpisodeIds } from "../src/episodes.js";
import type { ShowConfig } from "../src/show-config.js";

const show: ShowConfig = { showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts", models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/nas" } };

describe("listEpisodeIds", () => {
  it("unions the episode and production directories, filters by id grammar, and sorts by id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    for (const d of ["Episodes/_TEMPLATE", "Episodes/_retired", "Episodes/s02e02", "Episodes/ep98", "Episodes/notes", "Production/s02e01", "Production/s02e02", "Production/voice-refs"]) await mkdir(path.join(root, d), { recursive: true });
    expect(await listEpisodeIds(root, show)).toEqual(["s02e01", "s02e02", "ep98"]);
  });
  it("tolerates a missing directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    expect(await listEpisodeIds(root, show)).toEqual([]);
  });
});
```

Append to `engine/test/gate.test.ts`, inside `describe("gates")`:

```ts
  it("refuses an answer whose expectedAttempt is not the open attempt, and names both", async () => {
    const { pipeline, log, ctx, executors } = await setup();
    await run({ pipeline, ctx, log, executors });
    await expect(answerGate(log, "r1", "g", { approved: true, by: "t", expectedAttempt: 2 })).rejects.toThrow('gate "g" is open at attempt 1, not 2');
    await answerGate(log, "r1", "g", { approved: true, by: "t", expectedAttempt: 1 });
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "completed" });
  });
  it("names an empty log plainly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r9"));
    await expect(answerGate(log, "r9", "g", { approved: true })).rejects.toThrow(/^no run in the log at /);
  });
```

Append to `engine/test/script-step.test.ts` (it already imports `killLiveProcessGroups`; if not, add it):

```ts
describe("killLiveProcessGroups", () => {
  it("returns how many it killed and how many it could not, and continues past a failure", () => {
    const original = process.kill;
    const calls: number[] = [];
    // three live groups: the first dies, the second refuses (EPERM), the third dies
    (process as unknown as { kill: typeof process.kill }).kill = ((pid: number) => {
      calls.push(pid);
      if (pid === -2) { const e = new Error("EPERM") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; }
      return true;
    }) as typeof process.kill;
    try {
      __setLiveForTest([1, 2, 3]);
      expect(killLiveProcessGroups()).toEqual({ killed: 2, failed: 1 });
      expect(calls).toEqual([-1, -2, -3]);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = original;
      __setLiveForTest([]);
    }
  });
});
```

`__setLiveForTest(pids: number[])` is a test-only export that replaces the registry's contents; name it so and document it as such.

Append to `engine/test/ids.test.ts`: `expect(() => formatAired(0, 1)).toThrow("invalid season 0: season must be 1..99");` and the episode counterpart `invalid episode 100: episode must be 1..99`.

Append to `engine/test/stages.test.ts` (O-11):

```ts
describe("deriveStage edges", () => {
  it("ignores a completed step absent from approved, and an open gate absent from gates", () => {
    const s = base({ steps: { "outline-gate": "completed", unmapped: "completed", other: "waiting" }, openGate: { stepId: "other", attempt: 1, message: "", openedAt: "t" } });
    expect(deriveStage(s, map, none)).toBe("OUTLINE");
  });
  it("compareStages is zero for equal stages and negative in order", () => {
    expect(compareStages("IDEA", "IDEA")).toBe(0);
    expect(compareStages("IDEA", "OUTLINE")).toBeLessThan(0);
  });
  it("stops reporting NEEDS_IDEA exactly at OUTLINE and NEEDS_IMAGES exactly at IMAGES", () => {
    expect(deriveStage(base({ steps: { "outline-gate": "completed" } }), map, { ...none, ideaMissing: true })).toBe("OUTLINE");
    expect(deriveStage(base({ steps: { "outline-gate": "completed", "script-gate": "completed", "casting-gate": "completed", "audio-gate": "completed", "image-gate": "completed" } }), map, { ...none, imagesMissing: true })).toBe("IMAGES");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/events.test.ts test/runs.test.ts test/episodes.test.ts test/gate.test.ts test/script-step.test.ts test/ids.test.ts test/stages.test.ts`
Expected: FAIL — missing modules and exports; the message assertions do not match.

- [ ] **Step 3: `events.ts`**

```ts
  /** Both ids are validated here because this is where they become a filesystem path: an
   *  unchecked `..` segment in either one would put a run's log outside the episode. The
   *  production directory is the show's (`show.productionDir`), defaulting to the name this
   *  show uses; every other episode path is built from the same key. */
  static logPath(showRoot: string, episodeId: string, runId: string, productionDir = "Production"): string {
    parseEpisodeId(episodeId);
    if (!RUN_ID.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)}: expected [A-Za-z0-9_-]+`);
    return path.join(showRoot, productionDir, episodeId, "runs", `${runId}.jsonl`);
  }

  /** The events appended since `offset` (a byte position), and the position to resume from. A
   *  reader outside the writing process — the console's tail — calls this on every change
   *  notification rather than re-reading a file that grows by thousands of lines per run. Only
   *  complete lines are parsed: a line still being written is left for the next call, so the
   *  returned offset is the start of that partial line, never past it. */
  async readFrom(offset: number): Promise<{ events: Event[]; offset: number }> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { events: [], offset: 0 };
      throw err;
    }
    try {
      const size = (await handle.stat()).size;
      if (size <= offset) return { events: [], offset: Math.min(offset, size) };
      const buf = Buffer.alloc(size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString("utf8");
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) return { events: [], offset };
      const complete = text.slice(0, lastNewline);
      const events: Event[] = [];
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue;
        try { events.push(JSON.parse(line) as Event); }
        catch (err) { throw new Error(`event log ${this.path}: malformed JSON after byte ${offset}`, { cause: err }); }
      }
      return { events, offset: offset + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8") };
    } finally {
      await handle.close();
    }
  }
```

Import `open`, `type FileHandle` from `node:fs/promises`; move the `RUN_ID` constant to `runs.ts` and import it here (`import { RUN_ID } from "./runs.js"`), keeping `events.ts`'s behaviour.

- [ ] **Step 4: `runs.ts` and `episodes.ts`**

```ts
// engine/src/runs.ts
import path from "node:path";
import { readdir } from "node:fs/promises";
import { parseEpisodeId } from "./ids.js";

/** A run id names a directory entry, so it is held to the same alphabet as an episode id. */
export const RUN_ID = /^[A-Za-z0-9_-]+$/;

/** A run id that sorts by creation time: a UTC timestamp to the second, then four random
 *  characters so two launches in one second stay distinct. Lexical order is creation order, so
 *  "the latest run" is the last id and `priorLogs` is every earlier one — the only ordering the
 *  engine's resume contract gets, since readdir order is not one. */
export function mintRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${stamp}-${rand}`;
}

/** The ids of an episode's runs, ascending — every `<id>.jsonl` under the episode's runs
 *  directory; locks, worker logs and anything else are not runs. Empty when the directory does
 *  not exist, which is every episode that has never run. */
export async function listRuns(showRoot: string, episodeId: string, productionDir = "Production"): Promise<string[]> {
  parseEpisodeId(episodeId);
  const dir = path.join(showRoot, productionDir, episodeId, "runs");
  let names: string[];
  try { names = await readdir(dir); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length)).filter((id) => RUN_ID.test(id)).sort();
}

/** The id of the episode's most recent run, or undefined for an episode that has never run. */
export async function latestRunId(showRoot: string, episodeId: string, productionDir = "Production"): Promise<string | undefined> {
  const runs = await listRuns(showRoot, episodeId, productionDir);
  return runs[runs.length - 1];
}

/** The log paths of an episode's runs, ascending, for `RunOptions.priorLogs`. */
export async function runLogPaths(showRoot: string, episodeId: string, productionDir = "Production"): Promise<string[]> {
  const runs = await listRuns(showRoot, episodeId, productionDir);
  return runs.map((r) => path.join(showRoot, productionDir, episodeId, "runs", `${r}.jsonl`));
}
```

```ts
// engine/src/episodes.ts
import path from "node:path";
import { readdir } from "node:fs/promises";
import { compareEpisodeIds, isEpisodeId, parseEpisodeId } from "./ids.js";
import type { ShowConfig } from "./show-config.js";

/** Every episode the show has, in id order: the union of the directory names under the
 *  episodes directory (where a premise lives) and the production directory (where runs live)
 *  that parse as episode ids. `_TEMPLATE`, `_retired`, `voice-refs` and the like fall out of the
 *  filter. The Board's first job is this list, and nothing else in the engine had it. */
export async function listEpisodeIds(showRoot: string, show: ShowConfig): Promise<string[]> {
  const ids = new Set<string>();
  for (const dir of [show.episodesDir ?? "Episodes", show.productionDir ?? "Production"]) {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(path.join(showRoot, dir), { withFileTypes: true }); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const e of entries) if (e.isDirectory() && isEpisodeId(e.name)) ids.add(e.name);
  }
  return [...ids].sort((a, b) => compareEpisodeIds(parseEpisodeId(a), parseEpisodeId(b)));
}
```

- [ ] **Step 5: `answerGate`, `killLiveProcessGroups`, `formatAired`**

`answerGate` in `runner.ts`:

```ts
export async function answerGate(
  log: EventLog, runId: string, stepId: StepId,
  answer: { approved: boolean; notes?: string; by?: string; expectedAttempt?: number },
): Promise<void> {
  const events = await log.read();
  if (events.length === 0) throw new Error(`no run in the log at ${log.path}`);
  const state = deriveRunState(events);
  if (state.runId !== runId) {
    throw new Error(`run id mismatch: the log at ${log.path} is run ${JSON.stringify(state.runId)}, not ${JSON.stringify(runId)}`);
  }
  if (!state.openGate || state.openGate.stepId !== stepId) {
    throw new Error(`gate ${JSON.stringify(stepId)} is not open on run ${runId}`);
  }
  // A console tab left open across a rejection shows an attempt that has since been superseded;
  // an answer that names the attempt it saw cannot answer a newer one it never read.
  if (answer.expectedAttempt !== undefined && answer.expectedAttempt !== state.openGate.attempt) {
    throw new Error(`gate ${JSON.stringify(stepId)} is open at attempt ${state.openGate.attempt}, not ${answer.expectedAttempt}`);
  }
  …(unchanged from here)
```

`killLiveProcessGroups` in `script-step.ts`:

```ts
/** SIGKILL the whole process group of every live child, and report how many were signalled and
 *  how many could not be. This is the shutdown path: without it a worker going down leaves a
 *  render or an audio batch running with nothing reading its output. A group that has already
 *  gone (ESRCH) is neither killed nor failed; any other error is counted as failed and the loop
 *  continues, because stopping at the first refusal would leave every later group running. */
export function killLiveProcessGroups(): { killed: number; failed: number } {
  let killed = 0, failed = 0;
  for (const pid of live) {
    try { process.kill(-pid, "SIGKILL"); killed++; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") failed++; }
  }
  return { killed, failed };
}

/** Test-only: replace the registry's contents. Production code never calls it. */
export function __setLiveForTest(pids: number[]): void { live.clear(); for (const p of pids) live.add(p); }
```

(`live` is the module's `Set<number>`; if it is declared `const live = new Set<number>()` the function above works as written.) Update the one existing test that expects a number from `killLiveProcessGroups()` to expect `{killed, failed}`.

`formatAired` in `ids.ts`: `throw new InvalidEpisodeId(\`season ${season}\`, "season must be 1..99")` → the message becomes `invalid episode id "season 0": season must be 1..99`; **instead** change `InvalidEpisodeId`'s use here to a plain `Error`: `throw new Error(\`invalid season ${season}: season must be 1..99\`)` and the same for episode. The class stays for real ids.

Add to `index.ts`: `export * from "./runs.js"; export * from "./episodes.js";`.

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: PASS (the count grows by the tests above; report the real number), typecheck silent, the show-name grep (with `console/`) empty.

- [ ] **Step 7: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src engine/test
git commit -F - <<'EOF'
engine: tail reads, run and episode listing, attempt-checked answers, a shutdown that finishes

EventLog.readFrom reads the events appended since a byte offset so a
process that is not writing the log can follow it; logPath takes the
show's production directory. runs.ts mints sortable run ids and lists an
episode's runs in creation order; episodes.ts lists the show's episodes.
answerGate refuses an answer that names a superseded attempt and names
an empty log plainly; killLiveProcessGroups continues past a refusal
and reports what it could not signal; formatAired names its parameter.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 2: `withdrawApproval`, `describePipeline`, and a `run_started` that pins its version

**Files:**
- Modify: `engine/src/pipeline.ts` (`describePipeline`, `pipelineHash`), `engine/src/runner.ts` (`withdrawApproval`; `run_started` payload), `engine/src/index.ts` (nothing new to export — both files are already re-exported)
- Test: `engine/test/pipeline.test.ts`, `engine/test/gate.test.ts`, `engine/test/runner.test.ts`, `engine/test/episode-pipeline.test.ts`

**Interfaces:**
- Produces:
  - `describePipeline(p: Pipeline): PipelineDescription` where `PipelineDescription = { name: string; steps: StepDescription[] }` and `StepDescription = { id, kind, dependsOn: string[], inputs: string[], outputs: string[], when: boolean, timeoutMs?, promptFile?, schemaFile?, model?, allowedTools?, context?, idleTimeoutMs?, messageFile?, maxAttempts?, rerunOnReject?, onReject?: { id, promptFile, model }, body?: { id, promptFile, model }, until?, maxIterations?, cwd? }` — every value JSON-serialisable, functions reduced to "present" booleans.
  - `pipelineHash(p: Pipeline): string` — sha256 of `JSON.stringify(describePipeline(p))`.
  - `run_started`'s payload gains `engineVersion: ENGINE_VERSION` and `pipelineHash`.
  - `withdrawApproval(pipeline, log, runId, stepId, { notes, by }): Promise<StepId[]>` — for a gate whose last answer is an approval and whose run has no open gate: appends `step_reset` (`by: "withdraw:<stepId>"`) for every non-gate step downstream of the gate that has a status, then `gate_answered { approved: false, notes, by, withdrawn: true, attempt }`; returns the reset ids. Refuses when the gate is not approved, when a gate is open, or when the run id mismatches. A finished run is reopened first with `run_resumed`.

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/pipeline.test.ts`:

```ts
describe("describePipeline", () => {
  it("reduces a pipeline to JSON, keeping names and edges and marking functions as present", () => {
    const p: Pipeline = { name: "p", steps: [
      { kind: "guard", id: "g0", check: () => ({ pass: true }) },
      { kind: "script", id: "s", dependsOn: ["g0"], argv: () => ["true"], inputs: ["a.md"], outputs: ["b.md"], cwd: "/x", timeoutMs: 5 },
      { kind: "agent", id: "a", dependsOn: ["s"], promptFile: "a.md", schemaFile: "a.schema.json", model: "medium", allowedTools: ["Read"], context: "fresh", when: () => true },
      { kind: "gate", id: "g", dependsOn: ["a"], messageFile: "g.gate.md", maxAttempts: 3, rerunOnReject: ["s"], onReject: { kind: "agent", id: "g-fix", promptFile: "g.reject.md", model: "writer", allowedTools: [], context: "fresh" } },
      { kind: "loop", id: "l", dependsOn: ["g"], until: "DONE", maxIterations: 2, body: { kind: "agent", id: "l-body", promptFile: "l.md", model: "writer", allowedTools: [], context: "shared" } },
    ] };
    const d = describePipeline(p);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d.steps.map((s) => s.id)).toEqual(["g0", "s", "a", "g", "l"]);
    expect(d.steps[1]).toEqual({ id: "s", kind: "script", dependsOn: ["g0"], inputs: ["a.md"], outputs: ["b.md"], when: false, cwd: "/x", timeoutMs: 5 });
    expect(d.steps[2]).toMatchObject({ id: "a", kind: "agent", when: true, promptFile: "a.md", schemaFile: "a.schema.json", model: "medium", allowedTools: ["Read"], context: "fresh" });
    expect(d.steps[3]).toMatchObject({ id: "g", kind: "gate", messageFile: "g.gate.md", maxAttempts: 3, rerunOnReject: ["s"], onReject: { id: "g-fix", promptFile: "g.reject.md", model: "writer" } });
    expect(d.steps[4]).toMatchObject({ id: "l", kind: "loop", until: "DONE", maxIterations: 2, body: { id: "l-body", promptFile: "l.md", model: "writer" } });
    expect(pipelineHash(p)).toMatch(/^[0-9a-f]{64}$/);
    expect(pipelineHash(p)).toBe(pipelineHash({ ...p }));
    expect(pipelineHash(p)).not.toBe(pipelineHash({ ...p, name: "q" }));
  });
});
```

Append to `engine/test/runner.test.ts`:

```ts
  it("records the engine version and the pipeline hash on run_started", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const pipeline: Pipeline = { name: "p", steps: [{ kind: "guard", id: "a", check: () => ({ pass: true }) }] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    await run({ pipeline, ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log, executors: { script: async () => ({ ok: true }), agent: async () => ({ ok: true, text: "", toolCalls: 0 }) } });
    const started = (await log.read())[0];
    expect(started?.payload).toMatchObject({ pipeline: "p", episodeId: "s02e01", engineVersion: ENGINE_VERSION, pipelineHash: pipelineHash(pipeline) });
  });
```

Append to `engine/test/gate.test.ts`:

```ts
describe("withdrawApproval", () => {
  async function withdrawSetup() {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const calls: string[] = [];
    const executors: Executors = {
      script: async (step) => { calls.push(step.id); return { ok: true }; },
      agent: async (step, ctx) => { calls.push(`${step.id}:${String(ctx.results["g:rejection"] ?? "")}`); return { ok: true, text: "fixed", toolCalls: 1 }; },
    };
    const pipeline: Pipeline = { name: "p", steps: [
      { kind: "script", id: "make", argv: () => ["true"] },
      { kind: "gate", id: "g", dependsOn: ["make"], message: () => "ok?", rerunOnReject: ["make"], onReject: { kind: "agent", id: "fix", promptFile: "f.md", model: "m", allowedTools: [], context: "fresh" } },
      { kind: "script", id: "after", dependsOn: ["g"], argv: () => ["true"] },
      { kind: "gate", id: "g2", dependsOn: ["after"], message: () => "ok2?" },
      { kind: "script", id: "last", dependsOn: ["g2"], argv: () => ["true"] },
    ] };
    const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    return { pipeline, log, ctx, executors, calls };
  }

  it("rejects an approved gate after the fact: downstream work is reset, the fix agent runs, the gate reopens at the next attempt", async () => {
    const { pipeline, log, ctx, executors, calls } = await withdrawSetup();
    await run({ pipeline, ctx, log, executors });
    await answerGate(log, "r1", "g", { approved: true, by: "t" });
    expect(await run({ pipeline, ctx, log, executors })).toMatchObject({ status: "waiting", gate: { stepId: "g2" } });
    await answerGate(log, "r1", "g2", { approved: true, by: "t" });
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "completed" });
    expect(calls).toEqual(["make", "after", "last"]);
    const reset = await withdrawApproval(pipeline, log, "r1", "g", { notes: "scene two is wrong after all", by: "t" });
    expect(reset).toEqual(["after", "last"]);
    const r = await run({ pipeline, ctx, log, executors });
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "g", attempt: 2 } });
    expect(calls.slice(3)).toEqual(["fix:scene two is wrong after all", "make"]);
    const events = await log.read();
    const answers = events.filter((e) => e.kind === "gate_answered" && e.stepId === "g");
    expect(answers[1]?.payload).toMatchObject({ approved: false, notes: "scene two is wrong after all", by: "t", withdrawn: true, attempt: 1 });
    expect(events.filter((e) => e.kind === "step_reset").map((e) => [e.stepId, e.payload["by"]])).toEqual(expect.arrayContaining([["after", "withdraw:g"], ["last", "withdraw:g"], ["make", "g"]]));
    expect(events.some((e) => e.kind === "step_reset" && e.stepId === "g2")).toBe(false);
    expect(events.filter((e) => e.kind === "run_resumed")).toHaveLength(1);
    // g2's approval survives untouched: once g is re-approved, g2 does not ask again
    await answerGate(log, "r1", "g", { approved: true, by: "t" });
    expect(await run({ pipeline, ctx, log, executors })).toEqual({ status: "completed" });
    expect(calls.slice(5)).toEqual(["after", "last"]);
  });

  it("refuses a gate that is not approved, a run with an open gate, and a wrong run id", async () => {
    const { pipeline, log, ctx, executors } = await withdrawSetup();
    await run({ pipeline, ctx, log, executors });
    await expect(withdrawApproval(pipeline, log, "r1", "g", { notes: "n", by: "t" })).rejects.toThrow(/gate "g" is open; answer it instead/);
    await answerGate(log, "r1", "g", { approved: false, notes: "no", by: "t" });
    await expect(withdrawApproval(pipeline, log, "r1", "g", { notes: "n", by: "t" })).rejects.toThrow(/gate "g" is not approved/);
    await expect(withdrawApproval(pipeline, log, "r2", "g", { notes: "n", by: "t" })).rejects.toThrow(/run id mismatch/);
  });
});
```

Add the imports (`withdrawApproval`, `ENGINE_VERSION`, `pipelineHash`, `describePipeline`) where used.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run test/pipeline.test.ts test/runner.test.ts test/gate.test.ts`
Expected: FAIL — the exports do not exist; `run_started` lacks the two fields.

- [ ] **Step 3: `describePipeline` and `pipelineHash` in `pipeline.ts`**

```ts
import { createHash } from "node:crypto";

export interface StepDescription {
  id: StepId; kind: Step["kind"]; dependsOn: StepId[]; inputs: string[]; outputs: string[];
  /** Whether the step carries a `when` predicate; the predicate itself is code and not described. */
  when: boolean;
  timeoutMs?: number; promptFile?: string; schemaFile?: string; model?: string; allowedTools?: string[]; context?: "fresh" | "shared";
  idleTimeoutMs?: number; messageFile?: string; maxAttempts?: number; rerunOnReject?: StepId[];
  onReject?: { id: StepId; promptFile: string; model: string }; body?: { id: StepId; promptFile: string; model: string };
  until?: string; maxIterations?: number; cwd?: string;
}
export interface PipelineDescription { name: string; steps: StepDescription[] }

/** The pipeline as a document: every name, edge, file and bound a step declares, with each
 *  function reduced to "present". A pipeline is live TypeScript — argv, when, check, progress are
 *  code — so JSON.stringify would drop every decision it makes; this is the part that can be
 *  handed to a reader or hashed. The evaluated argv of each script step is in the log already,
 *  on its step_started. */
export function describePipeline(p: Pipeline): PipelineDescription {
  const steps = p.steps.map((s): StepDescription => {
    const d: StepDescription = { id: s.id, kind: s.kind, dependsOn: [...(s.dependsOn ?? [])], inputs: [...(s.inputs ?? [])], outputs: [...(s.outputs ?? [])], when: s.when !== undefined };
    if (s.timeoutMs !== undefined) d.timeoutMs = s.timeoutMs;
    if (s.kind === "script" && s.cwd !== undefined) d.cwd = s.cwd;
    if (s.kind === "agent") {
      d.promptFile = s.promptFile; d.model = s.model; d.allowedTools = [...s.allowedTools]; d.context = s.context;
      if (s.schemaFile !== undefined) d.schemaFile = s.schemaFile;
      if (s.idleTimeoutMs !== undefined) d.idleTimeoutMs = s.idleTimeoutMs;
    }
    if (s.kind === "gate") {
      if (s.messageFile !== undefined) d.messageFile = s.messageFile;
      if (s.maxAttempts !== undefined) d.maxAttempts = s.maxAttempts;
      if (s.rerunOnReject !== undefined) d.rerunOnReject = [...s.rerunOnReject];
      if (s.onReject) d.onReject = { id: s.onReject.id, promptFile: s.onReject.promptFile, model: s.onReject.model };
    }
    if (s.kind === "loop") {
      d.until = s.until; d.maxIterations = s.maxIterations;
      d.body = { id: s.body.id, promptFile: s.body.promptFile, model: s.body.model };
    }
    return d;
  });
  return { name: p.name, steps };
}

/** A content hash of the description, recorded on run_started so a log says which shape of the
 *  pipeline it ran against — the version question §6.8's troubleshooting agent would otherwise
 *  have to guess at. */
export function pipelineHash(p: Pipeline): string {
  return createHash("sha256").update(JSON.stringify(describePipeline(p))).digest("hex");
}
```

Adjust the test's expectation for step `s` if a key order differs — `toEqual` ignores key order.

- [ ] **Step 4: `run_started` and `withdrawApproval` in `runner.ts`**

In `execute`, the `run_started` payload: `const started: Record<string, unknown> = { pipeline: pipeline.name, episodeId: opts.ctx.episodeId, engineVersion: ENGINE_VERSION, pipelineHash: pipelineHash(pipeline) };` (import `ENGINE_VERSION` from `./index.js` would be circular — move the constant to a new `engine/src/version.ts` exporting `ENGINE_VERSION = "0.0.1"` and have `index.ts` re-export it).

```ts
/** Rejects a gate the showrunner already approved — the "re-ask" the record of Plan D asked for.
 *  Everything downstream of the gate is reset (never another gate: a later gate's approval is its
 *  own answer and survives), then a rejection answer is appended with `withdrawn: true`, so the
 *  next run() takes the ordinary rejection path: the fix agent, the gate's own re-run set, and
 *  the gate reopened at the next attempt. Refused while any gate is open (answer it instead), and
 *  for a gate whose last answer is not an approval. A finished run is reopened first. */
export async function withdrawApproval(
  pipeline: Pipeline, log: EventLog, runId: string, stepId: StepId, answer: { notes: string; by: string },
): Promise<StepId[]> {
  const events = await log.read();
  if (events.length === 0) throw new Error(`no run in the log at ${log.path}`);
  const state = deriveRunState(events);
  if (state.runId !== runId) {
    throw new Error(`run id mismatch: the log at ${log.path} is run ${JSON.stringify(state.runId)}, not ${JSON.stringify(runId)}`);
  }
  if (state.openGate) throw new Error(`gate ${JSON.stringify(state.openGate.stepId)} is open; answer it instead`);
  let last: Event | undefined;
  for (const e of events) if (e.stepId === stepId && (e.kind === "gate_opened" || e.kind === "gate_answered")) last = e;
  if (!last || last.kind !== "gate_answered" || last.payload["approved"] !== true) {
    throw new Error(`gate ${JSON.stringify(stepId)} is not approved on run ${runId}`);
  }
  const byId = new Map(pipeline.steps.map((s) => [s.id, s] as const));
  const ids = downstreamOf(pipeline, [stepId]).filter((id) => id !== stepId && byId.get(id)?.kind !== "gate" && state.steps[id] !== undefined);
  if (state.finished) await log.append({ runId, kind: "run_resumed", payload: { by: answer.by } });
  for (const id of ids) await log.append({ runId, stepId: id, kind: "step_reset", payload: { by: `withdraw:${stepId}` } });
  await log.append({ runId, stepId, kind: "gate_answered", payload: { approved: false, notes: answer.notes, by: answer.by, withdrawn: true, attempt: Number(last.payload["attempt"] ?? state.gateAttempts[stepId] ?? 1) } });
  return ids;
}
```

Check `deriveRunState`'s `gate_answered` branch: a rejection with no preceding `gate_opened` sets the step `running` and appends to `:rejections` — that is what the next `run()` needs. `runGateStep` then sees `lastAnswer` rejected, runs the fix agent and the reset, and reopens at `attempts + 1` — `attempts` comes from `gateAttempts`, which the earlier `gate_opened` set. Confirm with the test.

- [ ] **Step 5: Run the whole suite and the typecheck; update the pipeline walk if `run_started` assertions exist there**

Run: `cd ~/GitHub/Showrunner/engine && npx vitest run && npm run typecheck`
Expected: PASS, typecheck silent, grep empty. If `engine/test/episode-pipeline.test.ts` or `ep98-exercise.test.ts` asserts the exact `run_started` payload, extend the expectation with the two new fields.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add engine/src engine/test
git commit -F - <<'EOF'
engine: withdrawApproval, describePipeline, and a run_started that pins its version

withdrawApproval rejects a gate the showrunner already approved: the
work downstream of it is reset, never another gate, and the ordinary
rejection path reopens it at the next attempt. describePipeline reduces
the live pipeline to a document a reader or a hash can hold, and
run_started now records the engine version and that hash.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---
## Task 3: The console workspace and the worker

**Files:**
- Create: `console/package.json`, `console/tsconfig.json`, `console/tsconfig.server.json`, `console/tsconfig.client.json`, `console/vitest.config.ts`, `console/vite.config.ts`, `console/index.html` (a placeholder until Task 6), `console/shared/types.ts` (the worker's part only), `console/worker/main.ts`, `console/test/worker.test.ts`, `console/test/fixtures/fake-worker.mjs` (used from Task 4 on)
- Modify: `package.json` (root): workspaces gain `"console"`; `build`, `test`, `typecheck` run it after `tools`

**Interfaces:**
- Consumes: `episodePipeline`, `EPISODE_STAGE_MAP`, `run`, `EventLog`, `runLogPaths`, `createAgentExecutor`, `createGateMessageRenderer`, `sdkQuery`, `scriptExecutor`, `liveProcessGroups`, `killLiveProcessGroups`, `loadShowConfig` from `@showrunner/engine`.
- Produces:
  - `runOnce(opts: WorkerOptions, deps?: WorkerDeps): Promise<WorkerOutcome>` where `WorkerOptions = { showRoot: string; episodeId: string; runId: string; engineRoot: string; operator: string; concurrency?: number }`, `WorkerDeps = { executors?: Executors; renderGateMessage?: GateMessageRenderer; heartbeatMs?: number; now?: () => Date }`, `WorkerOutcome = { status: "waiting" | "completed" | "failed" | "crashed"; detail: string }`.
  - **The lock file** `<runs>/<runId>.lock`: JSON `{ pid, startedAt, heartbeatAt, groups: number[] }`, created with the `wx` flag; a stale lock (its `pid` not alive per `process.kill(pid, 0)`) is removed and retaken; a live lock makes `runOnce` return `{status: "crashed", detail: "run <id> is held by pid N"}` without touching the log.
  - **The worker log** `<runs>/<runId>.worker.log`: appended on every `runOnce` with one line per outcome and the full text of any rejected `run()`.
  - The CLI: `node console/dist/worker/main.js --show <root> --episode <id> --run <runId> --engine-root <path> --operator <name> [--concurrency N]`; exit codes 0 (waiting or completed), 1 (the run failed — a step failed, recorded in the log), 2 (crashed: `run()` rejected, or the lock was held), 143 (signalled).
  - `console/test/fixtures/fake-worker.mjs`: a Node script taking the same flags, appending `step_started`/`step_completed` for a step named by `FAKE_WORKER_STEP` (default `fake`) and a `gate_opened` for `FAKE_WORKER_GATE` when set, then exiting 0 — so the server's tests can spawn "a worker" without the engine.

- [ ] **Step 1: The workspace**

`console/package.json`:

```json
{
  "name": "@showrunner/console",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -k \"tsx watch server/main.ts --show ${SHOWRUNNER_SHOW_ROOT}\" \"vite --port 5183\"",
    "build": "tsc -p tsconfig.server.json && vite build",
    "start": "node dist/server/main.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.client.json --noEmit"
  },
  "dependencies": {
    "@showrunner/engine": "*",
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "marked": "^14.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "concurrently": "^9.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.server.json` (server, worker, shared, test): `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `outDir: dist`, `rootDir: .`, `include: ["server", "worker", "shared", "test"]`, `types: ["node"]`. `tsconfig.client.json` (src, shared): `jsx: react-jsx`, `moduleResolution: bundler`, `noEmit`, the same strictness, `include: ["src", "shared"]`, `types: ["vite/client"]`. `tsconfig.json` references both. `vite.config.ts`: React plugin, `root: "."`, `build.outDir: "dist/client"`, `server: { host: true, port: 5183, proxy: { "/api": "http://localhost:4400" } }`. `vitest.config.ts`: `test.include: ["test/**/*.test.ts"]`, `environment: "node"`. `index.html`: a minimal page mounting `/src/main.tsx` (Task 6 writes the real client; until then `src/main.tsx` renders "console").

Root `package.json`: `"workspaces": ["engine", "tools", "console"]`; `build`, `test`, `typecheck` gain `&& npm run <script> -w console`. Run `npm install` at the root and commit the lockfile change.

- [ ] **Step 2: Write the failing worker tests**

`console/test/worker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventLog, deriveRunState, type Executors } from "@showrunner/engine";
import { runOnce, lockPath } from "../worker/main.js";

async function show() {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  const w = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); };
  await w("showrunner.json", JSON.stringify({ showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts", models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: path.join(root, "nas") } }));
  for (const f of ["world-overview", "technology", "timeline", "continuity-ledger", "series-arc", "episode-formula", "story-craft", "style-guide", "season-2", "visual-style", "voice-registry", "publishing-guide"]) await w(`Canon/${f}.md`, `${f}\n`);
  await w("Canon/refs.json", "{}"); await w("Production/voice-refs/refs.json", JSON.stringify({ cast: {} }));
  await w("Episodes/_TEMPLATE/outline.md", "t\n"); await w("Episodes/s02e01/premise.md", "A week.\n");
  await w("prompts/outline-gate.gate.md", "Outline for {{episodeId}}");
  return { root, w };
}

/** Executors that write an outline and stop at the first gate, as the real ones would. */
const fakes: Executors = {
  script: async () => ({ ok: true, result: "ok" }),
  agent: async (step, ctx) => {
    if (step.id === "outline") await writeFile(path.join(ctx.showRoot, "Episodes/s02e01/outline.md"), "# Ep\n\n## Cast\n\n## Beat outline\n### Beat 1\n");
    return { ok: true, text: "", toolCalls: 1, verdict: { pass: true, verdict: "CANON PASSED", issues: [], deviations: [] } };
  },
};
const opts = (root: string) => ({ showRoot: root, episodeId: "s02e01", runId: "20261002T100000Z-ab12", engineRoot: path.resolve(__dirname, "..", ".."), operator: "console:test", concurrency: 1 });

describe("the worker", () => {
  it("takes the lock, runs to the first gate, releases the lock, and reports waiting", async () => {
    const { root } = await show();
    const seen: Record<string, unknown>[] = [];
    const r = await runOnce(opts(root), { executors: fakes, renderGateMessage: async (file, ctx) => `${file} for ${ctx.episodeId}`, heartbeatMs: 20, onHeartbeat: (lock) => { seen.push(lock); } });
    expect(r).toMatchObject({ status: "waiting", detail: expect.stringContaining("outline-gate") });
    const log = new EventLog(EventLog.logPath(root, "s02e01", "20261002T100000Z-ab12"));
    const state = deriveRunState(await log.read());
    expect(state.openGate?.stepId).toBe("outline-gate");
    expect(state.openGate?.message).toBe("outline-gate.gate.md for s02e01");
    expect((await log.read())[0]?.payload["trigger"]).toBe("console:test");
    await expect(stat(lockPath(root, "s02e01", "20261002T100000Z-ab12"))).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ pid: process.pid, groups: [] });
    expect(await readFile(path.join(root, "Production/s02e01/runs/20261002T100000Z-ab12.worker.log"), "utf8")).toMatch(/waiting at outline-gate/);
  });

  it("refuses to run while a live lock exists, and retakes a stale one", async () => {
    const { root, w } = await show();
    const lp = lockPath(root, "s02e01", "20261002T100000Z-ab12");
    await w(path.relative(root, lp), JSON.stringify({ pid: process.pid, startedAt: "t", heartbeatAt: "t", groups: [] }));
    expect(await runOnce(opts(root), { executors: fakes })).toMatchObject({ status: "crashed", detail: `run 20261002T100000Z-ab12 is held by pid ${process.pid}` });
    await w(path.relative(root, lp), JSON.stringify({ pid: 2147483646, startedAt: "t", heartbeatAt: "t", groups: [] }));
    const r = await runOnce(opts(root), { executors: fakes, renderGateMessage: async () => "m" });
    expect(r.status).toBe("waiting");
  });

  it("reports a failed step as failed, and a rejected run() as crashed with the error in the worker log", async () => {
    const { root } = await show();
    const failing: Executors = { ...fakes, agent: async () => ({ ok: false, error: "boom", toolCalls: 0 }) };
    expect(await runOnce(opts(root), { executors: failing })).toMatchObject({ status: "failed", detail: expect.stringContaining("outline") });
    const throwing: Executors = { ...fakes, agent: async () => { throw new Error("log write failed: disk full"); } };
    const r = await runOnce({ ...opts(root), runId: "20261002T100001Z-cd34" }, { executors: throwing });
    expect(r).toMatchObject({ status: "crashed", detail: expect.stringContaining("disk full") });
    expect(await readFile(path.join(root, "Production/s02e01/runs/20261002T100001Z-cd34.worker.log"), "utf8")).toMatch(/disk full/);
    await expect(stat(lockPath(root, "s02e01", "20261002T100001Z-cd34"))).rejects.toThrow();
  });
});
```

(`WorkerDeps` gains `onHeartbeat?: (lock: LockFile) => void`, for this test.) The fake-worker fixture:

```js
// console/test/fixtures/fake-worker.mjs — a worker stand-in for the server's tests
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]] : []).filter((p) => p.length));
const file = path.join(args.show, "Production", args.episode, "runs", `${args.run}.jsonl`);
await mkdir(path.dirname(file), { recursive: true });
const ev = (kind, stepId, payload = {}) => JSON.stringify({ ts: new Date().toISOString(), runId: args.run, ...(stepId ? { stepId } : {}), kind, payload }) + "\n";
const step = process.env.FAKE_WORKER_STEP ?? "fake";
let text = "";
if (!(await import("node:fs")).existsSync(file) || (await import("node:fs")).statSync(file).size === 0) text += ev("run_started", undefined, { pipeline: "episode", episodeId: args.episode, trigger: args.operator });
text += ev("step_started", step, { kind: "script" }) + ev("step_completed", step, { result: `${step} ok` });
if (process.env.FAKE_WORKER_GATE) text += ev("gate_opened", process.env.FAKE_WORKER_GATE, { attempt: 1, message: `gate ${process.env.FAKE_WORKER_GATE}` });
else text += ev("run_finished", undefined, { status: "completed" });
await appendFile(file, text);
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/console && npx vitest run test/worker.test.ts`
Expected: FAIL — `../worker/main.js` does not exist.

- [ ] **Step 4: The worker**

`console/worker/main.ts`:

```ts
import path from "node:path";
import os from "node:os";
import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  EventLog, run, runLogPaths, episodePipeline, loadShowConfig, createAgentExecutor, createGateMessageRenderer, sdkQuery, scriptExecutor,
  liveProcessGroups, killLiveProcessGroups, type Executors, type GateMessageRenderer, type RunResult,
} from "@showrunner/engine";

export interface WorkerOptions { showRoot: string; episodeId: string; runId: string; engineRoot: string; operator: string; concurrency?: number }
export interface LockFile { pid: number; startedAt: string; heartbeatAt: string; groups: number[] }
export interface WorkerDeps { executors?: Executors; renderGateMessage?: GateMessageRenderer; heartbeatMs?: number; now?: () => Date; onHeartbeat?: (lock: LockFile) => void }
export type WorkerOutcome = { status: "waiting" | "completed" | "failed" | "crashed"; detail: string };

/** The lock lives beside the log it guards; both are named by the run id. */
export function lockPath(showRoot: string, episodeId: string, runId: string, productionDir = "Production"): string {
  return EventLog.logPath(showRoot, episodeId, runId, productionDir).replace(/\.jsonl$/, ".lock");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Takes the run's lock or says who holds it. The lock is created with `wx`, so two workers
 *  racing for one run cannot both win; a lock whose pid is dead belongs to a worker that died
 *  without its `finally`, and is removed and retaken. The lock is the one fact the log cannot
 *  state — whether anyone is running this run right now. */
async function takeLock(file: string, now: Date): Promise<{ ok: true } | { ok: false; holder: number }> {
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

/** One run segment: lock, build, run() once, release. Returns rather than throws for every
 *  outcome the log can state; "crashed" is the one it cannot — a rejected run() or a held lock —
 *  and the worker log carries its text. */
export async function runOnce(opts: WorkerOptions, deps: WorkerDeps = {}): Promise<WorkerOutcome> {
  const now = deps.now ?? (() => new Date());
  const show = await loadShowConfig(opts.showRoot);
  const productionDir = show.productionDir ?? "Production";
  const logFile = EventLog.logPath(opts.showRoot, opts.episodeId, opts.runId, productionDir);
  const lockFile = lockPath(opts.showRoot, opts.episodeId, opts.runId, productionDir);
  const workerLog = logFile.replace(/\.jsonl$/, ".worker.log");
  const note = async (line: string) => { await mkdir(path.dirname(workerLog), { recursive: true }); await appendFile(workerLog, `${now().toISOString()} pid ${process.pid}: ${line}\n`); };

  const lock = await takeLock(lockFile, now());
  if (!lock.ok) { const detail = `run ${opts.runId} is held by pid ${lock.holder}`; await note(detail); return { status: "crashed", detail }; }

  const heartbeat = setInterval(() => {
    const body: LockFile = { pid: process.pid, startedAt: now().toISOString(), heartbeatAt: now().toISOString(), groups: liveProcessGroups() };
    void writeFile(lockFile, JSON.stringify(body), "utf8").catch(() => undefined);
    deps.onHeartbeat?.(body);
  }, deps.heartbeatMs ?? 5000);
  // the first beat at once, so a reader never sees a lock without groups
  const first: LockFile = { pid: process.pid, startedAt: now().toISOString(), heartbeatAt: now().toISOString(), groups: liveProcessGroups() };
  await writeFile(lockFile, JSON.stringify(first), "utf8"); deps.onHeartbeat?.(first);

  try {
    const pipeline = episodePipeline({ show, episodeId: opts.episodeId, engineRoot: opts.engineRoot });
    const agentOpts = { query: sdkQuery, show };
    const executors: Executors = deps.executors ?? { script: scriptExecutor, agent: createAgentExecutor(agentOpts) };
    const renderGateMessage = deps.renderGateMessage ?? createGateMessageRenderer(agentOpts);
    const priorLogs = (await runLogPaths(opts.showRoot, opts.episodeId, productionDir)).filter((p) => p !== logFile).map((p) => new EventLog(p));
    let result: RunResult;
    try {
      result = await run({ pipeline, ctx: { runId: opts.runId, episodeId: opts.episodeId, showRoot: opts.showRoot, trigger: opts.operator }, log: new EventLog(logFile), executors, priorLogs, renderGateMessage, ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}) });
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
    clearInterval(heartbeat);
    await rm(lockFile, { force: true });
  }
}

function flag(name: string): string | undefined { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; }

async function main(): Promise<void> {
  const showRoot = flag("show"); const episodeId = flag("episode"); const runId = flag("run");
  if (!showRoot || !episodeId || !runId) { process.stderr.write("usage: worker --show <root> --episode <id> --run <runId> [--engine-root <path>] [--operator <name>] [--concurrency N]\n"); process.exit(64); }
  const engineRoot = flag("engine-root") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const operator = flag("operator") ?? `console:${os.userInfo().username}`;
  const c = flag("concurrency");
  const stop = () => { const { killed, failed } = killLiveProcessGroups(); process.stderr.write(`signalled: killed ${killed} process groups, ${failed} refused\n`); process.exit(143); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  const r = await runOnce({ showRoot, episodeId, runId, engineRoot, operator, ...(c !== undefined ? { concurrency: Number(c) } : {}) });
  process.stdout.write(`${r.status}: ${r.detail}\n`);
  process.exit(r.status === "waiting" || r.status === "completed" ? 0 : r.status === "failed" ? 1 : 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
```

`RunOptions.concurrency` does not exist until Task 9: until then the spread `...(opts.concurrency !== undefined ? { concurrency } : {})` is a type error. **Write it now as `...({} as Record<string, never>)` with a comment `// Task 9 adds RunOptions.concurrency; the worker passes it then`, and Task 9 replaces that line.** The `engineRoot` default resolves from `console/dist/worker/main.js` to the repository root; `--engine-root` overrides it (the tests pass one).

- [ ] **Step 5: Run the tests, the typecheck and the grep**

Run: `cd ~/GitHub/Showrunner/console && npx vitest run && npm run typecheck`, then the Global Constraints grep (it now covers `console/`).
Expected: PASS (3 tests), typecheck silent, grep empty. Then the root: `cd .. && npm run build && npm test` runs all three workspaces.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/Showrunner && git add package.json package-lock.json console
git commit -F - <<'EOF'
console: the workspace, and the worker that runs one segment of a run

A run lives in a worker process the console launches and never owns:
the worker takes a lock beside the log, builds the pipeline and the
real executors, calls run() once — to the next gate, the end, or a
failure — heartbeats its live process groups into the lock, and exits.
A rejected run() or a held lock is a crash the worker log explains; the
console reads both and offers Continue.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---
## Task 4: The server — the show context, episode rows, the run store that tails logs, and the worker spawner

**Files:**
- Create: `console/shared/types.ts` (the wire types), `console/server/show.ts`, `console/server/episodes.ts`, `console/server/runs.ts`, `console/server/workers.ts`, `console/server/app.ts` (the read routes and the SSE channel; Task 5 adds the actions), `console/server/main.ts`
- Test: `console/test/episodes.test.ts`, `console/test/runs.test.ts`, `console/test/workers.test.ts`, `console/test/app.test.ts` (the read routes)

**Interfaces:**
- Consumes: `listEpisodeIds`, `listRuns`, `latestRunId`, `mintRunId`, `EventLog.readFrom`, `deriveRunState`, `deriveStage`, `EPISODE_STAGE_MAP`, `episodeNeeds`, `missingRefs`, `missingShowrunnerImages`, `loadShowConfig`, `parseEpisodeId`; `lockPath` and `LockFile` from the worker module.
- Produces (`shared/types.ts`):

```ts
export type RunStatus = "none" | "running" | "waiting" | "failed" | "crashed" | "completed";
export interface EpisodeRow {
  id: string; title: string; stage: string;              // stage is a Stage string
  status: RunStatus; runId?: string;
  openGate?: { stepId: string; attempt: number; openedAt: string };
  failed?: { stepId: string; error: string };
  needs: { ideaMissing: boolean; refsMissing: string[]; imagesMissing: string[] };  // the reasons, not only the flags
  lastEventAt?: string;
  worker?: { pid: number; heartbeatAt: string; alive: boolean; groups: number[] };
}
export interface StepRow { id: string; kind: string; status: string; startedAt?: string; endedAt?: string; error?: string; result?: unknown; progress?: { done: number; total: number; unit: string; message?: string; ratePerSec?: number; etaSec?: number }; toolCalls?: number; flag?: "did-nothing" | "failed-iteration" }
export interface RunView {
  episodeId: string; runId: string; status: RunStatus; stage: string; startedAt?: string; finishedAt?: string; lastEventAt?: string;
  position?: { stepId: string; startedAt: string };
  openGate?: { stepId: string; attempt: number; message: string; openedAt: string };
  failed?: { stepId: string; error: string };
  steps: StepRow[];                                        // in pipeline order, from the pipeline description
  pipeline: { name: string; hash?: string; engineVersion?: string };
  worker?: EpisodeRow["worker"]; offset: number;           // the log offset the view was built from
}
export interface EventBatch { events: Array<{ ts: string; stepId?: string; kind: string; payload: Record<string, unknown> }>; offset: number }
export type SseMessage = { type: "run"; episodeId: string; runId: string; offset: number } | { type: "episodes" } | { type: "hello"; operator: string; showName: string };
```

- `ShowContext` (`server/show.ts`): `{ showRoot, show: ShowConfig, engineRoot, operator, productionDir, episodesDir, workerCommand: string[] }`, built by `loadShowContext({ showRoot, engineRoot, operator?, workerCommand? })`; `workerCommand` defaults to `[process.execPath, <console/dist/worker/main.js>]` and the tests pass `[process.execPath, <fixtures/fake-worker.mjs>]`.
- `RunStore` (`server/runs.ts`): holds per log `{ events, offset }`; `get(episodeId, runId)` returns the events (tailing the file first); `watch()` starts an `fs.watch` on every `<productionDir>/<id>/runs/` directory that exists plus a 2 s poll fallback for directories that appear later; `subscribe(fn: (m: SseMessage) => void)`; `view(episodeId, runId): Promise<RunView>` projects the events (joining each terminal event to its `step_started` for the kind; computing a progress rate from the last two `step_progress` of the current step; flagging loop iterations); `episodeRow(episodeId): Promise<EpisodeRow>`.
- `spawnWorker(ctx, episodeId, runId): Promise<{ pid: number }>` (`server/workers.ts`): `spawn(cmd, [...args, "--show", root, "--episode", id, "--run", runId, "--engine-root", engineRoot, "--operator", operator], { detached: true, stdio: ["ignore", out, out] })` with `out` an `openSync` fd on `<runs>/<runId>.worker.out`, then `child.unref()`. Refuses with `Error("run <id> is held by pid N")` when `readLock` finds a live lock. `readLock(ctx, episodeId, runId): Promise<LockFile & { alive: boolean } | undefined>`; `killRecordedGroups(lock): { killed: number; failed: number }`.
- Routes (`server/app.ts`, `createApp(ctx, store)`): `GET /api/show`, `GET /api/episodes`, `GET /api/episodes/:id`, `GET /api/episodes/:id/runs/:run` (the `RunView`), `GET /api/episodes/:id/runs/:run/events?after=<offset>` (an `EventBatch`), `GET /api/events` (SSE: `hello` first, then every `SseMessage` as `data:` JSON; a `: ping` comment every 15 s). Every `:id` is validated with `parseEpisodeId` and every `:run` with `RUN_ID` before any path is built; a bad one is 400.

- [ ] **Step 1: Write the failing tests**

`console/test/helpers.ts` (shared by Tasks 4–5; not a test file): `makeShow()` builds a temp show like the worker test's (the invented show, a `prompts/` directory with the gate messages the pipeline names, `showrunner.json`), `seedRun(root, episodeId, runId, events)` writes a log, `appWith(root)` returns `{ app, ctx, store }` with `workerCommand` pointing at `test/fixtures/fake-worker.mjs`.

`console/test/runs.test.ts`:

```ts
describe("RunStore", () => {
  it("tails a log incrementally and publishes a change per append", async () => {
    const { root, ctx, store } = await appWith(await makeShow());
    const seen: SseMessage[] = []; store.subscribe((m) => seen.push(m));
    await store.watch();
    const log = new EventLog(EventLog.logPath(root, "s02e01", "20261002T100000Z-ab12"));
    await log.append({ runId: "20261002T100000Z-ab12", kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01" } });
    await waitFor(() => seen.some((m) => m.type === "run"));
    const first = await store.get("s02e01", "20261002T100000Z-ab12");
    expect(first.events.map((e) => e.kind)).toEqual(["run_started"]);
    await log.append({ runId: "20261002T100000Z-ab12", stepId: "premise", kind: "step_started", payload: { kind: "guard" } });
    await waitFor(async () => (await store.get("s02e01", "20261002T100000Z-ab12")).events.length === 2);
    expect(seen.filter((m) => m.type === "run").length).toBeGreaterThanOrEqual(2);
    store.close();
  });

  it("projects a RunView: steps in pipeline order with kinds joined, the position, a progress rate, and the dead-iteration flag", async () => {
    const { root, store } = await appWith(await makeShow());
    const t = (s: number) => new Date(Date.UTC(2026, 9, 2, 10, 0, s)).toISOString();
    await seedRun(root, "s02e01", "r1", [
      { ts: t(0), kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01", pipelineHash: "abc", engineVersion: "0.0.1" } },
      { ts: t(1), stepId: "previous-episode", kind: "step_started", payload: { kind: "guard" } }, { ts: t(1), stepId: "previous-episode", kind: "step_completed", payload: { result: "ok" } },
      { ts: t(2), stepId: "premise", kind: "step_started", payload: { kind: "guard" } }, { ts: t(2), stepId: "premise", kind: "step_completed", payload: {} },
      { ts: t(3), stepId: "outline", kind: "step_started", payload: { kind: "agent" } }, { ts: t(9), stepId: "outline", kind: "step_completed", payload: { toolCalls: 4 } },
      { ts: t(10), stepId: "draft", kind: "step_started", payload: { kind: "loop", body: "draft-body", until: "DRAFT_COMPLETE", max: 15 } },
      { ts: t(20), stepId: "draft", kind: "loop_iteration", payload: { iteration: 1, max: 15, sentinel: false, toolCalls: 5 } },
      { ts: t(20), stepId: "draft", kind: "step_progress", payload: { done: 1, total: 12, unit: "scenes" } },
      { ts: t(24), stepId: "draft", kind: "loop_iteration", payload: { iteration: 2, max: 15, sentinel: false, toolCalls: 0 } },
      { ts: t(24), stepId: "draft", kind: "step_progress", payload: { done: 1, total: 12, unit: "scenes" } },
      { ts: t(40), stepId: "draft", kind: "loop_iteration", payload: { iteration: 3, max: 15, sentinel: false, toolCalls: 6 } },
      { ts: t(40), stepId: "draft", kind: "step_progress", payload: { done: 2, total: 12, unit: "scenes" } },
    ]);
    const v = await store.view("s02e01", "r1");
    expect(v.status).toBe("running");
    expect(v.position).toEqual({ stepId: "draft", startedAt: t(10) });
    expect(v.steps.map((s) => s.id).slice(0, 4)).toEqual(["previous-episode", "premise", "outline", "hand-edits-outline"]);
    expect(v.steps.find((s) => s.id === "outline")).toMatchObject({ kind: "agent", status: "completed", startedAt: t(3), endedAt: t(9), toolCalls: 4 });
    const draft = v.steps.find((s) => s.id === "draft")!;
    expect(draft.status).toBe("running");
    expect(draft.progress).toMatchObject({ done: 2, total: 12, unit: "scenes" });
    expect(draft.progress?.ratePerSec).toBeCloseTo(1 / 20, 3);          // 1 scene over the 20 s between the last two progress events
    expect(draft.progress?.etaSec).toBeCloseTo(200, 0);
    expect(draft.flag).toBe("did-nothing");                              // iteration 2: toolCalls 0, no error
    expect(v.pipeline).toEqual({ name: "episode", hash: "abc", engineVersion: "0.0.1" });
    expect(v.steps.length).toBe(73);
  });
});
```

`console/test/episodes.test.ts`: an `EpisodeRow` for (a) an episode directory with a premise and no run → `{ stage: "IDEA", status: "none", title: "s02e03" }`; (b) one with no premise → `stage: "NEEDS_IDEA"`; (c) a seeded run parked at `outline-gate` → `{ stage: "DRAFT_OUTLINE", status: "waiting", openGate: { stepId: "outline-gate", attempt: 1 } }` and `title` from the outline's `# ` heading; (d) a seeded failed run → `{ status: "failed", failed: { stepId, error } }` with the stage still the highest approved; (e) a live lock (pid = `process.pid`) → `status: "running"`, `worker.alive: true`; a stale lock (dead pid) with a log that has no terminal event → `status: "crashed"`; (f) the showrunner-images case: a shot list with a `source: "showrunner"` shot lacking its PNG and an open `nano-banana-gate` → `stage: "NEEDS_IMAGES"`, `openGate` set, `needs.imagesMissing: ["<id>"]`.

`console/test/workers.test.ts`: `spawnWorker` with the fake worker writes `<runId>.jsonl` (wait for the file) and `<runId>.worker.out`; a live lock makes it throw `run … is held by pid …`; `killRecordedGroups` with `groups: []` returns `{killed: 0, failed: 0}`.

`console/test/app.test.ts` (read routes; use `app.request(...)`): `GET /api/show` → `{ showName: "Harbor Light", operator: "console:test" }`; `GET /api/episodes` lists seeded episodes sorted; `GET /api/episodes/zz` → 400; `GET /api/episodes/s02e01/runs/r1` → the view; `GET /api/episodes/s02e01/runs/r1/events?after=0` → all events and an offset, then `?after=<offset>` → `[]`; `GET /api/events` → the first chunk is a `hello`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/console && npx vitest run`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: `show.ts`, `workers.ts`, `episodes.ts`, `runs.ts`**

Write them to the contracts above. The parts with judgment, stated:

*`RunStore.watch()`*: for each episode id from `listEpisodeIds`, if `<productionDir>/<id>/runs` exists, `fs.watch(dir, (eventType, filename) => …)`; on any change to a `*.jsonl` file, `tail(episodeId, runId)` — `readFrom(cached.offset)`, append, and if anything arrived publish `{type: "run", episodeId, runId, offset}`; on a new `*.jsonl` name, add it. On a change to a `.lock`, publish `{type: "episodes"}` (the Board's status). A 2 s `setInterval` re-runs `listEpisodeIds` and adds watchers for new `runs/` directories, publishing `episodes` when the list changes. `fs.watch` on macOS reports a filename for a directory watch; treat an `undefined` filename as "rescan the directory". Every watcher is closed by `close()`.

*`RunStore.view()`*: build `steps` from `describePipeline(episodePipeline({show, episodeId, engineRoot}))` — the order and the kinds come from the definition, so a step the log never mentions still has a row (`status: "pending"`); overlay the log: `step_started` → `running` + `startedAt` (+ `kind` if the definition lacks it); `step_completed`/`step_cached` → `completed` + `endedAt` + `result`/`toolCalls`; `step_failed` → `failed` + `error`; `step_skipped` → `skipped`/`bypassed` by reason; `step_reset` → `pending` (and `endedAt` cleared); `gate_opened` → `waiting`; `gate_answered` approved → `completed`, rejected → `running`. Progress: the current position's step keeps every `step_progress` since its last `step_started`; a run of consecutive events with the same `done` collapses to its first timestamp (the moment that count was first observed); over that series, `ratePerSec = (last.done - prev.done) / seconds(last.ts - prev.ts)` when two exist and the seconds are positive, `etaSec = (total - done) / ratePerSec` when the rate is positive. Loop flags: scanning every `loop_iteration` of a running loop since its last `step_started`, any with `error` → `"failed-iteration"` (precedence), else any with `toolCalls === 0` → `"did-nothing"` — the flag stays on the loop for its lifetime. `status`: `completed`/`failed` from `run_finished`; else `waiting` when `openGate`; else `running` when a live lock exists; else `none` for an empty log; else `crashed` when the log has a step in flight and no live lock (a killed worker or a rejected `run()` — the lock is taken before `run()` and removed in `finally`, so a healthy worker never leaves a step in flight without one); else `running` if the log's last event is within 60 s, else `crashed`. (The three rules were corrected on 2026-10-02 to agree with the brief's own tests; the projection fixture writes a live lock to be `running`.) `stage` = `deriveStage(state, EPISODE_STAGE_MAP, await episodeNeeds(...))`.

*`episodeRow()`*: title from the first line matching `/^# (.+)$/` of `outline.md`, else `script.md`, else the id; `needs` from `missingRefs`/`missingShowrunnerImages` and the premise check; the run fields from `view()` of the latest run when one exists, else `status: "none"` and `stage` from `deriveStage(deriveRunState([]), …)` (which yields `IDEA` or `NEEDS_IDEA`).

*`spawnWorker()`*: as the Interfaces say. The stdout/stderr fd is opened with `openSync(path, "a")` and closed in the parent after `spawn`.

- [ ] **Step 4: `app.ts` and `main.ts`**

`createApp(ctx: ShowContext, store: RunStore): Hono` with the read routes above; `GET /api/events` uses Hono's `streamSSE` with `store.subscribe` and clears the subscription on close. `main.ts`: flags `--show <root>` (required), `--engine-root`, `--port` (4400), `--host` (binds `0.0.0.0` when present, else `127.0.0.1`), `--operator`, `--worker <path to a worker entry>`; `serveStatic` for `dist/client` when it exists; `store.watch()` before listening; `SIGINT`/`SIGTERM` close the store and the server — **the server kills no process group: it owns no run.**

- [ ] **Step 5: Run the tests, the typecheck and the grep; commit**

Run: `cd ~/GitHub/Showrunner/console && npx vitest run && npm run typecheck` and the grep.
Expected: PASS, silent, empty.

```bash
cd ~/GitHub/Showrunner && git add console
git commit -F - <<'EOF'
console: the server's read side — episode rows, a run store that tails logs, the worker spawner

The server owns no run. It lists the show's episodes, tails every run
log by byte offset and pushes a change notice over one SSE channel,
projects a run into the view the spec's three altitudes ask for — the
step, its progress with a rate, the time since the last event — and
spawns a detached worker when asked. A live lock beside a log is what
"running" means; a stale one is what "crashed" means.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 5: The server — the five actions, the gate view, the artifact route, and "what happened"

**Files:**
- Create: `console/server/gates.ts`, `console/server/artifacts.ts`, `console/server/what-happened.ts`
- Modify: `console/server/app.ts` (the action routes), `console/shared/types.ts` (`GateView`, `WhatHappenedContext`)
- Test: `console/test/gates.test.ts`, `console/test/artifacts.test.ts`, `console/test/what-happened.test.ts`, `console/test/app.test.ts` (the action routes)

**Interfaces:**
- `GateView` (`shared/types.ts`): `{ episodeId; runId; stepId; attempt; openedAt; message: string; artifacts: Array<{ kind: "markdown" | "audio" | "video" | "images" | "diff" | "json" | "text"; label: string; url: string; listUrl?: string }>; verdicts: Record<string, unknown>; rejections: string[]; maxAttempts?: number }`.
- `gateView(ctx, store, episodeId, runId)` (`server/gates.ts`): the open gate's message and attempt from the view; `artifacts` from a table keyed by gate id — `outline-gate`: outline.md (markdown); `script-gate`: script.md; `casting-gate`: `tts-script.json` (json) and the guest-refs directory (audio list); `audio-gate`: the mix (audio; path from `mixFilename`); `nano-banana-gate`: the images directory (images, with `IMAGE-SHEET.md` as markdown); `image-gate`: the images directory; `final-gate`: the video (`episode-mastered.mp4` if present else `episode.mp4`) and `publish.json`; `canon-gate`: `canon-diff.patch` (diff) and `canon-ledger.md` (markdown) — every path relative to the show root and under the two allowed trees; `verdicts` = the `results` entries whose key is a reviewer or canon-review step (an object with `pass`); `rejections` = `results["<gate>:rejections"]`; `maxAttempts` from the pipeline description.
- Actions (all `POST`, all JSON, all `{ by }`-stamped with `console:<operator>`, all returning `{ runId, pid }` after spawning a worker, all 409 with the engine's message on refusal):
  - `POST /api/episodes` `{ id, premise }` → creates `<episodesDir>/<id>/premise.md` (400 on a bad id; 409 if the file exists); returns `{ id }`; no worker.
  - `POST /api/episodes/:id/runs` → `mintRunId()`, spawn. Refused (409) while the latest run has a live lock or an open gate ("answer the gate on run <id> first"); allowed when the latest run is finished or there is none.
  - `POST /api/episodes/:id/runs/:run/gate` `{ stepId, approved, notes, expectedAttempt }` → `answerGate(...)`, spawn.
  - `POST /api/episodes/:id/runs/:run/resume` → `resumeRun(...)`, spawn.
  - `POST /api/episodes/:id/runs/:run/continue` → for a crashed run (no terminal event, no live lock): if a stale lock recorded groups, `killRecordedGroups` first; then spawn (the worker's `run()` replays the open step). Refused when the run is finished or waiting.
  - `POST /api/episodes/:id/runs/:run/reset` `{ stepIds }` → refused (409) while a gate is open (`"gate <id> is open; answer it or withdraw, not reset"`); else `resetSteps(...)`, spawn.
  - `POST /api/episodes/:id/runs/:run/withdraw` `{ stepId, notes }` → `withdrawApproval(...)`, spawn.
- `GET /api/episodes/:id/runs/:run/gate` → the `GateView` or 404 when no gate is open.
- Artifacts (`server/artifacts.ts`): `GET /api/episodes/:id/files/*` — the `*` is a show-relative path that must begin with `<episodesDir>/<id>/` or `<productionDir>/<id>/` (400 otherwise), contain no `..` or empty segment, and name no dotfile; `safeResolve` (ported from v1) then confirms the resolved path is inside the show root; a directory → `{ entries: [{ name, size, isDir }] }` as JSON; a file → the bytes with a content type by extension (`.md` text/markdown, `.json`, `.patch` text/plain, `.wav` audio/wav, `.mp4` video/mp4, `.png`, `.jpg`) and HTTP Range (v1's `serveMediaRange`/`parseRange`, ported). Also `GET /api/episodes/:id/runs/:run/log` → the raw JSONL as a download.
- "What happened" (`server/what-happened.ts`): `assemble(ctx, store, episodeId, runId): Promise<WhatHappenedContext>` = `{ pipeline: PipelineDescription; run: RunView; events: the run's events with `script_line` collapsed to the last 50 per step and `step_progress` to the last per step; prompts: Array<{ stepId, promptFile, hashAtRun, hashNow, changed: boolean }>; outputs: string[] (the union of `outputHashes` keys) }`; `ask(ctx, context, question, query = sdkQuery): AsyncIterable<string>` streams the agent's text with a prompt that states the question, embeds the context as JSON, and instructs: read only; answer from the log; cite step ids and timestamps; `options = { cwd: showRoot, model: show.models.medium, tools: ["Read","Glob","Grep"], allowedTools: [...], permissionMode: "dontAsk", settingSources: [], systemPrompt: { type: "preset", preset: "claude_code" }, abortController, maxTurns: 20 }`; each question and the full answer appended to `<runs>/<runId>.troubleshooting.jsonl` as `{ ts, by, question, answer, costUsd? }`. Routes: `GET /api/episodes/:id/runs/:run/context` and `POST /api/episodes/:id/runs/:run/ask { question }` (a streamed text response).

- [ ] **Step 1: Write the failing tests**

`gates.test.ts`: a seeded run parked at `outline-gate` with `results` for `canon-review-outline` → `gateView` yields the message, `artifacts[0] = { kind: "markdown", label: "outline.md", url: "/api/episodes/s02e01/files/Episodes/s02e01/outline.md" }`, `verdicts["canon-review-outline"].pass === true`, `maxAttempts: 10`; parked at `canon-gate` → a `diff` and a `markdown` artifact; parked at `final-gate` with `episode-mastered.mp4` present → the `video` artifact names it; no open gate → `undefined`.

`artifacts.test.ts` (through `app.request`): a markdown file under `Episodes/s02e01/` → 200 `text/markdown`; `Production/s02e01/images/` → the JSON listing; `Canon/x.md` → 400; `Episodes/s02e01/../s02e02/x.md` → 400; `Episodes/s02e01/.secret` → 400; a 1,000-byte binary with `Range: bytes=100-199` → 206, 100 bytes, `Content-Range: bytes 100-199/1000`; `bytes=2000-` → 416; `/log` → the JSONL with `Content-Disposition`.

`what-happened.test.ts`: `assemble` over a seeded run with two `agent_query` events whose `promptHash` match/mismatch the prompt files on disk → `prompts[0].changed === false`, `prompts[1].changed === true`; `script_line` collapsed to 50 per step; `ask` with a fake `query` yielding two text blocks and a result → streams both, and the troubleshooting log has one line with the question and the joined answer.

`app.test.ts` (actions, with the fake worker): `POST /api/episodes {id:"s02e05", premise:"A week."}` → 200 and the file exists; again → 409; `{id:"nope"}` → 400. `POST /api/episodes/s02e05/runs` → 200 `{runId}` matching `RUN_ID`, and within 2 s the log exists with `run_started` (the fake worker); a second POST while a live lock exists (write one with `process.pid`) → 409. With `FAKE_WORKER_GATE=outline-gate` in the spawn env (the helper lets a test set it): launch → the gate opens; `POST …/gate {stepId:"outline-gate", approved:true, notes:"", expectedAttempt:2}` → 409 with the engine's attempt message; with `expectedAttempt:1` → 200 and `gate_answered` carries `by: "console:test"`. `POST …/reset` while the gate is open → 409. `POST …/resume` on a run that is not failed → 409. `POST …/withdraw` on an approved gate → 200 and the log shows the withdrawn rejection.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/GitHub/Showrunner/console && npx vitest run`
Expected: FAIL on the new files.

- [ ] **Step 3: Implement `gates.ts`, `artifacts.ts`, `what-happened.ts`, and the action routes**

To the contracts. Two rules for the actions: every action does its engine append **before** spawning, and refuses to spawn when `readLock` finds a live lock (the worker would refuse too, but the server's refusal is the message the user sees). `POST /api/episodes` validates `id` with `parseEpisodeId`, writes with the `wx` flag, and never creates `Production/<id>/`.

- [ ] **Step 4: Run the tests, the typecheck and the grep; commit**

```bash
cd ~/GitHub/Showrunner && git add console
git commit -F - <<'EOF'
console: the five actions, the gate view, the artifact route, and "what happened"

Every action is one engine append and one detached worker: launch,
approve or reject with the attempt the showrunner saw, resume, continue
after a crash, re-run from here, withdraw an approval. The gate view
names the artifact each of the eight gates refers to, served from under
the episode's own two directories with HTTP Range and nothing else.
"What happened" assembles the run's log, the pipeline's description,
the prompts by hash and the files the run wrote, and asks an agent
whose every question and answer lands in a log beside the run's.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---
## Task 6: The client — the four surfaces

**Files:**
- Create: `console/src/main.tsx`, `console/src/App.tsx`, `console/src/api.ts`, `console/src/useDocTitle.ts`, `console/src/projections.ts` (pure helpers under test), `console/src/pages/Board.tsx`, `console/src/pages/Run.tsx`, `console/src/pages/Gate.tsx`, `console/src/pages/WhatHappened.tsx`, `console/src/components/{Markdown,Diff,AudioSeek,ContactSheet,ProgressBar,EventFeed,StepRail,ActionBar,NewEpisode,Verdicts}.tsx`, `console/src/console.css`, `console/index.html` (real)
- Test: `console/test/client/projections.test.ts`, `console/test/client/doc-title.test.ts`

**Interfaces:**
- Consumes: every route of Tasks 4–5 and the wire types in `shared/types.ts`.
- Produces: four routes — `/` (Board), `/episodes/:id/runs/:run` (Run), `/episodes/:id/runs/:run/gate` (Gate), `/episodes/:id/runs/:run/what-happened` (What happened); `api.ts` with `useApi(path)` (fetch + refetch on SSE), `useSSE(onMessage)` (a native `EventSource` with a 2 s reconnect, ported from v1), `post(path, body)`; `projections.ts` with `elapsed(sinceIso, now)`, `stalled(lastEventAt, now, thresholdMs = 14 * 60_000)`, `titleFor(showName, rows)`, `stageLabel(stage)` (the `NEEDS_`/`DRAFT_`/approved class), `composeShotRejection(flags: Record<string, string>)` (ported from v1's `GateCenters.tsx:13-53`).

**The surfaces, each as the spec words it:**

1. **Board** (`/`). One row per `EpisodeRow`: the id and title; the stage, styled by its kind — a `NEEDS_` state in amber with its reasons listed underneath (the `needs` lists), a `DRAFT_` state in blue with a gate chip (`openGate.stepId · attempt N`), an approved stage in green; the run status as a chip (`running` with the worker's pid and heartbeat age, `waiting`, `failed` with the step id and the error's first line, `crashed` with "Continue" on the row, `completed`, or "no runs"); the time since the last event. Clicking a row opens its latest run (or, for an episode with none, a Launch button). A **New episode** form (id and premise) posts to `POST /api/episodes`. The page refetches on every `episodes` SSE message and on a `run` message for a row's run.
2. **Run** (`/episodes/:id/runs/:run`). Three altitudes at the top: the stage (as on the Board), the current step with its kind and elapsed, and its progress bar with done/total/unit, the rate and the ETA when known; beside them always **the time since the last event**, turning amber past 14 minutes (spec §6.6's number) unless the step is `render` (which the inventory records as legitimately silent until Task 7 lands) — then the label says "render running (silent)". Below: the **step rail** — every step of the pipeline in order, one line each, kind, status, elapsed or duration, the result's first line, and the loop flags (`did nothing` in red the moment it appears; `failed iteration`); `step_reset` and `run_resumed` shown as markers in the rail ("reset by image-gate", "resumed by console:ryan"). Below that: the **event feed**, the last 2,000 events newest-last, auto-following, with `script_line` collapsed per step behind a toggle, and a "download log" link to `/log`. The **action bar**: "Open gate" when waiting; "Resume" when failed; "Continue" when crashed (with the recorded groups shown and killed on confirm); "Re-run from here" (a step picker) when no gate is open and no worker is live, disabled with the reason otherwise; "What happened". The page applies `/events?after=` increments on every `run` SSE message for its run.
3. **Gate** (`/episodes/:id/runs/:run/gate`). The gate message rendered as Markdown; the attempt and `maxAttempts`; the verdicts as a board (one chip per reviewer: pass/fail with the issue count; ported from v1's `VerdictBoard` in spirit); the previous rejection notes; the artifacts, each by kind: markdown in a scrolling pane; audio with `AudioSeek` (`<audio>` over the Range route); video with `<video controls>`; images as a `ContactSheet` over the directory listing (PNGs by shot id, with a flag toggle per shot that composes the rejection note — the re-roll path); a diff with `Diff` (ported `DiffLines`); json pretty-printed. Approve and Reject with an auto-growing notes field; both post `expectedAttempt`; on a 409 the page refetches the gate and shows "the gate moved to attempt N — read it again". "Withdraw approval" appears on a Run page's rail for an approved gate when no gate is open.
4. **What happened** (`/episodes/:id/runs/:run/what-happened`). The assembled context summarised (steps, prompts with "changed since the run" marks, outputs), a question box, the streamed answer, and the previous questions from the troubleshooting log. Cost labelled "estimated".

The document title (`useDocTitle`) is the alerting story on the home network: `⏸ <id> NEEDS YOU — <showName>` when any run is waiting, `● <id> <stage> · <N>m — <showName>` when running, else `<showName> console`. `showName` comes from `GET /api/show`, never from code.

**Styling:** one `console.css`, system fonts, a dark and a light scheme by `prefers-color-scheme`, the three stage kinds as three colours, nothing else decorative. The couch and the iPad are first-class: touch targets at 44 px, the Board readable at 1024 px wide.

- [ ] **Step 1: Write the failing projection tests**

`console/test/client/projections.test.ts`: `elapsed("2026-10-02T10:00:00Z", new Date("2026-10-02T10:12:05Z"))` → `"12m 05s"`; `stalled(…, 15 min later)` → `true`, 13 min → `false`; `stageLabel("NEEDS_REFS")` → `{ kind: "needs", text: "NEEDS REFS" }`, `"DRAFT_SCRIPT"` → `draft`, `"SCRIPT"` → `approved`; `composeShotRejection({ "s03-vale-still": "she reads too large", "s05-harbor-wide": "" })` → `"s03-vale-still: she reads too large\ns05-harbor-wide: redo"`; `titleFor("Harbor Light", rows)` → the three forms above. `doc-title.test.ts`: the hook's pure part.

- [ ] **Step 2: Build the client**

Write the pages and components to the surfaces above. Vite dev: `npm run dev` with `SHOWRUNNER_SHOW_ROOT` set serves the client on 5183 proxying `/api` to 4400. Production: `npm run build` emits `dist/client` and `dist/server`, and `node dist/server/main.js --show <root>` serves both.

- [ ] **Step 3: Verify in a browser against a seeded temp show**

Write `console/test/fixtures/seed-show.mjs`: creates a temp show with three episodes — one with no premise (`NEEDS_IDEA`), one parked at `outline-gate` with an outline file and verdicts in its log, one failed at `tts-generate` — and prints the path. Run the server against it with `--worker test/fixtures/fake-worker.mjs`, open the Board, the Run, the Gate and What happened pages, and exercise: New episode; Launch (the fake worker completes); Approve with a stale attempt (the 409 path); Reject; Resume. Save a screenshot of each page to `.superpowers/sdd/<plan>/screens/` (the SDD workspace is git-ignored) and name them in the report. The screenshots are the review's evidence for the surfaces; there is no browser test suite in this plan.

- [ ] **Step 4: Run the tests, the typecheck, the build and the grep; commit**

Run: `cd ~/GitHub/Showrunner/console && npx vitest run && npm run typecheck && npm run build` and the grep.

```bash
cd ~/GitHub/Showrunner && git add console
git commit -F - <<'EOF'
console: the four surfaces

The Board is one row per episode with the stage, the run's status, the
open gate and the reasons a NEEDS_ state is blocking, and the time
since the last event. The Run view shows the three altitudes — stage,
step, progress with a rate — the step rail with resets, resumes and
dead iterations marked the moment they land, the live event feed, and
the recovery actions. The Gate view renders the message, the verdicts
and the artifact each gate names, and answers with the attempt the
showrunner saw. What happened asks an agent about one run's record.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---
## Task 7: The render's silence — `render-video.py` turns Remotion's progress into `::progress` lines

**Files:**
- Create: `scripts/render-video.py`, `scripts/tests/test_render_video.py`
- Modify: `engine/src/pipelines/episode.ts` (the `render` step), `engine/test/episode-pipeline.test.ts` (the render argv assertion), `engine/test/ep98-exercise.test.ts` (the render argv assertion), `README.md` (Scripts section)

**Interfaces:**
- `render-video.py <episode> --render-dir <abs path of render/> --composition <id> --out <abs mp4 path> [--show-root <path>]` — spawns `["npx", "remotion", "render", <composition>, <out>, "--log=verbose"]` (or whichever log level emits progress; see Step 1) with `cwd` = the render dir and `REMOTION_EPISODE=<episode>` in the environment, as an argv array; reads the child's output, and for every progress report Remotion prints (frames rendered of total, or a percentage) prints one `::progress {"done":N,"total":M,"unit":"frames"}` line, at most one per second; forwards every other line; exits with the child's code; prints `RENDER_OK <out>` last on success. The `render` step's argv becomes `py("render-video.py", "--render-dir", renderDir, "--composition", compositionId, "--out", path.join(ctx.showRoot, video))` with the engine's default `cwd` (the show root) and no `env`.

- [ ] **Step 1: Measure Remotion's output before parsing it**

Run, from `render/` with `REMOTION_EPISODE=ep98` and the staged `render/public/ep98/` from a prior `build-timeline.py` run (stage it with `cd ~/GitHub/Showrunner/scripts && uv run python build-timeline.py ep98 --show-root /Users/ryanperkowski/GitHub/DeadLight` first), `npx remotion render Episode /tmp/probe.mp4 --log=verbose 2>&1 | head -c 20000 > /tmp/remotion-probe.txt` — stop it after thirty seconds with a timeout, keep the first 20 KB, and record in the report exactly what a progress report looks like under a pipe (not a TTY): whether lines are `\r`-separated, whether frames are printed as `Rendered 123/63280` or as a percentage, and under which `--log` level it appears. Delete `/tmp/probe.mp4` and the staged `render/public/ep98/` afterwards. The parser in Step 3 is written against that measurement; quote the matching lines in the script's docstring.

- [ ] **Step 2: Write the failing test**

`scripts/tests/test_render_video.py`: run the script with `--render-dir` pointing at a temp directory containing a fake `npx` on `PATH` (a shell-free Python stub at `<tmp>/bin/npx` that prints three progress reports in the measured format, separated as Remotion separates them, then exits 0, honouring the argv it receives by writing `out` as an empty file) and assert: exactly three `::progress` lines on stdout with `done` 10, 20, 30 and `total` 30 and `unit: "frames"`; the last stdout line is `RENDER_OK <out>`; the child's `cwd` was the render dir and `REMOTION_EPISODE` was set (the stub records both to a file); a stub that exits 3 makes the script exit 3 with the stub's last stderr line.

- [ ] **Step 3: Write the script, switch the step, update the two assertions, document**

The script follows the house convention (`root = os.path.abspath(sc.show_root(sys.argv)); cfg = sc.load(root); os.chdir(root)`; argv only; one-line error exit) and reads the child with `subprocess.Popen(..., stdout=PIPE, stderr=STDOUT, text=True, bufsize=1)` splitting on both `\n` and `\r`. `episode.ts`'s render step loses `cwd` and `env` and gains the wrapper's argv; the walk's assertion changes to `["uv","run","--project",…,"python",…/render-video.py,"s02e01","--render-dir","/engine/render","--composition","Episode","--out","/show/Production/s02e01/video/episode.mp4"]`; the ep98 exercise's assertion checks `argv[5]` ends with `render-video.py`.

- [ ] **Step 4: Run everything and commit**

`cd scripts && uv run pytest -q` (the count grows), `cd ../engine && npx vitest run && npm run typecheck`, the grep.

```bash
cd ~/GitHub/Showrunner && git add scripts engine README.md
git commit -F - <<'EOF'
scripts, engine: the render reports its frames

render-video.py wraps the Remotion render and turns its own progress
into the pipeline's ::progress lines, so the run view no longer shows
ten silent minutes for the one step that was legitimately silent.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 8: The live check against the real show, and the documentation

**Files:**
- Create: `console/README.md`
- Modify: `README.md` (a "The console" section; the Develop section's grep gains `console/`; the layer table names the three processes)

- [ ] **Step 1: Run the console against the show, read-only**

`cd ~/GitHub/Showrunner && npm run build && node console/dist/server/main.js --show /Users/ryanperkowski/GitHub/DeadLight --port 4400`. In a browser: the Board lists `ep01`–`ep10` and `ep98` (and any `sXXeYY` directory), each with `status: no runs` and a stage derived from disk (`NEEDS_IDEA` for every Season 1 episode, which have no `premise.md` — expected, and the Board says why); the New-episode form is NOT used; no action is posted. Screenshot the Board to the SDD workspace. Stop the server. Confirm `git -C /Users/ryanperkowski/GitHub/DeadLight status --short` is unchanged. Record in the report the time the Board took to render with eleven episodes (the per-episode work is `episodeNeeds` plus a `readdir`).

- [ ] **Step 2: `console/README.md`**

Sections, each a paragraph or a table, naming no show: what the console is (the four surfaces; what is deferred); **the three processes** and what each owns; **what the console writes** — the run log through engine verbs, the lock and worker files beside it, the troubleshooting log, and `premise.md` — and nothing else; **running it** (`--show`, `--port`, `--host` and the home-network rule, `--operator`, `--worker`, `npm run dev` with `SHOWRUNNER_SHOW_ROOT`); **recovery** (Resume, Continue after a crash and what "crashed" means, Re-run from here, Withdraw approval — each with what it appends and when it is refused); **the files beside a run log** (`.lock`, `.worker.log`, `.worker.out`, `.troubleshooting.jsonl`); **the artifact route's fence**; **the alerting story** (the tab title; no notifications on LAN HTTP).

- [ ] **Step 3: The root README**

Add "The console" after "The episode pipeline": one paragraph and a pointer to `console/README.md`; the layer table in "The three layers" gains the console's three processes; the Develop section lists `console/`'s commands; the grep gains `console/`.

- [ ] **Step 4: Commit**

```bash
cd ~/GitHub/Showrunner && git add console/README.md README.md
git commit -F - <<'EOF'
docs: the console's README, and the root README's console section

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Task 9: Concurrent agent steps (Plan D's Task 10; last, and cut-able)

This task is Plan D's Task 10 verbatim — `docs/plans/2026-09-29-the-dead-light-pipeline.md`, the section "Task 10: Concurrent agent steps" — with two additions: the worker's `runOnce` passes `concurrency: opts.concurrency` into `run()` (replacing the placeholder spread Task 3 left, and `main` reads `--concurrency`), and the server's `spawnWorker` passes `--concurrency 7` by default (a `ShowContext.concurrency` the CLI's `--concurrency` sets). Its tests are Plan D's `engine/test/concurrency.test.ts` plus one worker test asserting the option reaches `run()` (a fake `run` is not injectable — assert through the fake executors' overlap, as the engine test does). Commit message: Plan D's, with the trailer line of this plan.

---

## After the tasks: the deferred record, and what this plan does not do

The controller writes `docs/plans/2026-10-02-the-console-deferred.md` after the whole-branch review, in the shape of the Plan D record: status, what Plan E established, a Plan F section, a Plan G section, the first-run items, and every ruling with its cost if wrong. Items already known to belong there:

- **Plan F:** console v1, `.archon/`, `remotion/` and the root `package.json` leave the show repository; `STATUS.md` and the six `status.py` steps retire; the Season 1 rename gives every episode a `premise.md`-less history the Board shows as `NEEDS_IDEA` — Plan F decides whether archived episodes get a marker file or a Board rule.
- **Plan G:** a show registry over `--show` (one server, many shows); the New-episode form becomes the first thing `init` teaches.
- **The first real run:** the SDK child under the worker's `SIGTERM` (its pid is not in the lock's groups); the abort lever; the fan-out's rate-limit exposure; `render-video.py` against a full-length render; whether 2,000 events in the feed is the right window.
- **Not built:** a content-addressed prompt store (F-19); the season map, desk, discuss, notes, standalone buttons (spec §7.2); auth (home network only); log rotation.

## Self-review (run by the plan's author before execution)

1. **Spec coverage.** §7.2's four surfaces → Task 6, over Tasks 4–5's routes; "the one derivation" → `episodeRow` over `deriveStage`; §6.6's three altitudes and the time since the last event → `RunView` and the Run page; §6.7's dead-iteration flag → `StepRow.flag`; §6.8's four inputs → `assemble()`; §6.9's restart → the worker's `run()` replay and Continue; §4.2/§6.9's structural detachment → the detached worker and the lock; §4.4's fences → the Global Constraints and the artifact route; the 24 obligations → the rulings table (O-01/O-17 lock; O-02 Task 1; O-03 Task 1 + the Gate page; O-04/O-08/O-11 Task 1; O-05 Task 4's join; O-06 Task 4's flag; O-07 the status chip; O-09/O-21 Task 4's tail and Task 2's verb; O-10 the lock's groups; O-12 recorded; O-13 the worker; O-14/O-15 one executor per worker; O-16 "estimated"; O-18 `loadShowConfig`; O-19 `deriveStage`; O-20 the worker; O-22 Task 7; O-23 the Board row; O-24 unused).
2. **Placeholder scan.** The client task gives the surfaces' content and contracts and the pure helpers' tests, not JSX; the acceptance is the seeded-show walkthrough with screenshots. Task 7's parser is written after a measurement the task itself specifies. Nothing says "TBD".
3. **Type consistency.** `RunStatus`, `EpisodeRow`, `RunView`, `StepRow`, `GateView`, `SseMessage`, `EventBatch` are defined once in `shared/types.ts` and used by Tasks 4–6; `lockPath`/`LockFile` come from the worker (Task 3) and are read by `workers.ts` (Task 4); `mintRunId`/`listRuns`/`latestRunId`/`runLogPaths`/`RUN_ID` (Task 1) are used by Tasks 3–5; `withdrawApproval`/`describePipeline`/`pipelineHash` (Task 2) by Tasks 4–5; `answerGate`'s `expectedAttempt` (Task 1) by Task 5 and the Gate page.

## Execution handoff

Plan complete and saved to `docs/plans/2026-10-02-the-console.md`. Execute with superpowers:subagent-driven-development: a fresh implementer per task, the three-question quiz before each, a task review after each (reviewers on Sonnet, implementers and the whole-branch reviewer on Opus), one fix wave after the whole-branch review, and the deferred record last. Task 9 is executed only if the budget allows when Task 8 is done.

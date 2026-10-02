import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import { stream as streamText, streamSSE } from "hono/streaming";
import {
  ENGINE_VERSION, EventLog, RUN_ID, STAGES, answerGate, deriveRunState, episodePipeline, latestRunId,
  listEpisodeIds, mintRunId, parseEpisodeId, resetSteps, resumeRun, withdrawApproval,
  type Pipeline, type QueryFn,
} from "@showrunner/engine";
import type { EventBatch, SseMessage } from "../shared/types.js";
import { serveArtifact, serveRunLog } from "./artifacts.js";
import { gateView } from "./gates.js";
import type { RunStore } from "./runs.js";
import type { ShowContext } from "./show.js";
import { assemble, ask } from "./what-happened.js";
import { killRecordedGroups, readLock, spawnWorker } from "./workers.js";

/** The console's HTTP surface: the read side — what the show is, what its episodes are, what one
 *  run looks like, and one channel that says when any of that changed — and the write side, which
 *  is the six actions an operator can take on a run plus the gate view, the episode's own files
 *  and "what happened".
 *
 *  Three rules hold across every route.
 *
 *  Every `:id` is validated with `parseEpisodeId` and every `:run` against `RUN_ID` **before** any
 *  path is built from it, because these are the strings that become filesystem paths: an unchecked
 *  `..` in either one reaches outside the episode, and a 400 at the edge is the only place that
 *  can be enforced once.
 *
 *  Nothing here owns a run. The read routes read logs, the SSE channel reports what the store saw,
 *  and an action spawns a detached worker and forgets it: this server can be restarted, upgraded
 *  or killed without a four-hour render noticing.
 *
 *  And every action goes **lock, append, spawn** — in that order, for the reasons set out above
 *  the actions below. A refusal at any of the three is a 409 carrying the engine's or the
 *  spawner's own message, because that message is what the operator reads. */

/** How often an idle SSE stream sends a comment line. Long enough not to be chatter, short
 *  enough to keep an intermediary from closing a stream it thinks is dead. */
const PING_MS = 15_000;

/** A validated episode id, or the message to answer 400 with. */
function checkEpisodeId(raw: string): { ok: true } | { ok: false; error: string } {
  try { parseEpisodeId(raw); return { ok: true }; } catch (err) { return { ok: false, error: (err as Error).message }; }
}

/** A validated run id, or the message to answer 400 with. The alphabet is the engine's, so the
 *  console and the writer of the log agree on what a run id is. */
function checkRunId(raw: string): { ok: true } | { ok: false; error: string } {
  if (RUN_ID.test(raw)) return { ok: true };
  return { ok: false, error: `invalid run id ${JSON.stringify(raw)}: expected [A-Za-z0-9_-]+` };
}

/** What a route needs the request body to be: an object, or nothing it can use. A body that is
 *  absent, empty or not JSON is read as `{}`, so the field checks below produce the 400 rather
 *  than a parse failure producing a 500 — and `POST …/resume`, which carries no body at all, needs
 *  no special case. */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json() as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Both ids of a run route, validated, or the message to answer 400 with. */
function checkIds(c: Context): { ok: true; id: string; run: string } | { ok: false; error: string } {
  // `?? ""` because a bare `Context` cannot know the route's parameter names; an empty id fails
  // `parseEpisodeId` and an empty run id fails `RUN_ID`, so a missing one is refused like a
  // malformed one rather than reaching a path join as "undefined".
  const id = c.req.param("id") ?? "";
  const run = c.req.param("run") ?? "";
  const validId = checkEpisodeId(id);
  if (!validId.ok) return { ok: false, error: validId.error };
  const validRun = checkRunId(run);
  if (!validRun.ok) return { ok: false, error: validRun.error };
  return { ok: true, id, run };
}

/** The run's log, as the engine's writers want it. Built through `EventLog.logPath`, which
 *  validates both ids again, so the log's address is composed in exactly one place for the server,
 *  the store and the worker alike. */
function logOf(ctx: ShowContext, episodeId: string, runId: string): EventLog {
  return new EventLog(EventLog.logPath(ctx.showRoot, episodeId, runId, ctx.productionDir));
}

/** The episode's pipeline, which `resetSteps` and `withdrawApproval` need for the dependency graph.
 *  Built per call and never cached across episodes: every step's inputs, outputs and argv are the
 *  episode's own, so one pipeline reused for a second episode would describe the first one's
 *  files. */
function pipelineFor(ctx: ShowContext, episodeId: string): Pipeline {
  return episodePipeline({ show: ctx.show, episodeId, engineRoot: ctx.engineRoot });
}

/** Whether a path exists. Used for one thing: telling a minted run id that already has a log from
 *  one that is free. */
async function exists(absolute: string): Promise<boolean> {
  try { await stat(absolute); return true; } catch { return false; }
}

/** The seams the app is built with. Production passes none: `query` defaults, inside
 *  `what-happened.ts`, to the engine's `sdkQuery`. A test passes a fake so the "what happened"
 *  route can be driven end to end without a model behind it. */
export interface AppDeps {
  query?: QueryFn;
}

/** The console's app, reading one show through one store. */
export function createApp(ctx: ShowContext, store: RunStore, deps: AppDeps = {}): Hono {
  const app = new Hono();

  /** What the client needs once, at startup: who it is talking to and the stage vocabulary the
   *  Board's columns are drawn from. */
  app.get("/api/show", (c) => c.json({
    showName: ctx.show.showName,
    showSlug: ctx.show.showSlug,
    operator: ctx.operator,
    episodesDir: ctx.episodesDir,
    productionDir: ctx.productionDir,
    stages: STAGES,
    engineVersion: ENGINE_VERSION,
  }));

  /** The Board: one row per episode of the show, in id order. */
  app.get("/api/episodes", async (c) => {
    const ids = await listEpisodeIds(ctx.showRoot, ctx.show);
    const rows = await Promise.all(ids.map((id) => store.episodeRow(id)));
    return c.json(rows);
  });

  app.get("/api/episodes/:id", async (c) => {
    const id = c.req.param("id");
    const valid = checkEpisodeId(id);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
    return c.json(await store.episodeRow(id));
  });

  /** One run at the middle altitude. A run id with no log is not an error: the view is the
   *  pipeline with every step pending, which is what a run looks like in the second between its
   *  launch and its worker's first write. */
  app.get("/api/episodes/:id/runs/:run", async (c) => {
    const id = c.req.param("id");
    const run = c.req.param("run");
    const validId = checkEpisodeId(id);
    if (!validId.ok) return c.json({ error: validId.error }, 400);
    const validRun = checkRunId(run);
    if (!validRun.ok) return c.json({ error: validRun.error }, 400);
    return c.json(await store.view(id, run));
  });

  /** The bottom altitude: the raw events a client has not seen. `after` is a byte offset — the
   *  one the client's last view or SSE message carried — so a client tailing a run that is
   *  writing hundreds of lines a minute transfers only the lines. Read from the log rather than
   *  from the store's cache because the cache holds no per-event offsets: the file is the only
   *  thing that can answer "the bytes after N" exactly. */
  app.get("/api/episodes/:id/runs/:run/events", async (c) => {
    const id = c.req.param("id");
    const run = c.req.param("run");
    const validId = checkEpisodeId(id);
    if (!validId.ok) return c.json({ error: validId.error }, 400);
    const validRun = checkRunId(run);
    if (!validRun.ok) return c.json({ error: validRun.error }, 400);
    const raw = c.req.query("after") ?? "0";
    const after = Number(raw);
    if (!Number.isInteger(after) || after < 0) return c.json({ error: `invalid after ${JSON.stringify(raw)}: expected a byte offset` }, 400);
    const log = new EventLog(EventLog.logPath(ctx.showRoot, id, run, ctx.productionDir));
    const { events, offset } = await log.readFrom(after);
    const batch: EventBatch = {
      events: events.map((e) => ({
        ts: e.ts, ...(e.stepId !== undefined ? { stepId: e.stepId } : {}), kind: e.kind, payload: e.payload,
      })),
      offset,
    };
    return c.json(batch);
  });

  /** The one channel. A `hello` first, so a client knows the stream is open and who answered;
   *  then one message per change the store saw, each of them a notice rather than a payload —
   *  the client fetches what it is missing. The subscription is dropped when the client goes
   *  away, which is the only cleanup this route owns. */
  app.get("/api/events", (c) => streamSSE(c, async (stream) => {
    const hello: SseMessage = { type: "hello", operator: ctx.operator, showName: ctx.show.showName };
    await stream.writeSSE({ data: JSON.stringify(hello) });

    const queue: SseMessage[] = [];
    let wake: (() => void) | undefined;
    let open = true;
    const unsubscribe = store.subscribe((m) => { queue.push(m); wake?.(); });
    stream.onAbort(() => { open = false; wake?.(); });

    try {
      while (open && !stream.aborted) {
        while (queue.length > 0) {
          const message = queue.shift();
          if (message !== undefined) await stream.writeSSE({ data: JSON.stringify(message) });
        }
        if (!open || stream.aborted) break;
        let timer: NodeJS.Timeout | undefined;
        // The queue is re-checked inside the executor: a message published between the drain
        // above and the assignment of `wake` would otherwise wait for the ping.
        const ticked = await new Promise<boolean>((resolve) => {
          wake = () => { resolve(false); };
          if (queue.length > 0 || !open) { resolve(false); return; }
          timer = setTimeout(() => { resolve(true); }, PING_MS);
        });
        wake = undefined;
        if (timer !== undefined) clearTimeout(timer);
        // A comment line: it keeps an idle connection open through anything that would close it,
        // and it is the client's evidence that the server is still there.
        if (ticked && open && !stream.aborted) await stream.write(": ping\n\n");
      }
    } finally {
      unsubscribe();
    }
  }));

  // ── the write side ────────────────────────────────────────────────────────────────────────
  //
  // Six actions, and one rule they all obey, in this order:
  //
  //   1. **validate**, then **read the lock**. A run a live worker holds is refused with a 409
  //      carrying `spawnWorker`'s own wording, and nothing is written. The refusal comes before
  //      the append rather than between the append and the spawn because a worker reads its log
  //      exactly once, at the start of its run (`engine/src/runner.ts`: "The log is read exactly
  //      once per run"): a line appended while that worker is working is a line its in-memory
  //      copy does not have.
  //   2. **the engine append**. `answerGate`, `resumeRun`, `resetSteps` and `withdrawApproval`
  //      each write the one event that changes what the run is, and each refuses with a message
  //      the operator can act on. That message is the 409 body, verbatim — the engine words these
  //      ("gate … is open at attempt 2, not 1") and the console must not paraphrase them.
  //   3. **the spawn**, last. It must be last: a worker spawned before the append would read a
  //      log in which nothing had changed, report `waiting` at the same gate, release its lock
  //      and exit — and the answer would then land in a log with no process behind it, leaving
  //      the run parked on an answered gate and the showrunner's approve apparently doing
  //      nothing. Appending first also means the decision survives a spawn that fails, so the
  //      operator's next move is Continue rather than deciding again.
  //
  // Launching is the one action with no append: the run does not exist yet, and the worker writes
  // its own `run_started`.

  /** Creates an episode: one directory with one premise in it, and nothing else.
   *
   *  `wx` rather than a read-then-write, so two operators creating the same episode cannot both
   *  believe they did. No `Production/<id>/` is made here: that directory is a run's to create,
   *  and an empty one would put a row on the Board for an episode with no idea in it. */
  app.post("/api/episodes", async (c) => {
    const body = await readJsonBody(c);
    const id = body["id"];
    const premise = body["premise"];
    if (typeof id !== "string") return c.json({ error: "id must be a string" }, 400);
    const valid = checkEpisodeId(id);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
    if (typeof premise !== "string" || premise.trim() === "") return c.json({ error: "premise must be a non-empty string" }, 400);
    const rel = `${ctx.episodesDir}/${id}/premise.md`;
    const file = path.join(ctx.showRoot, ctx.episodesDir, id, "premise.md");
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, premise.endsWith("\n") ? premise : `${premise}\n`, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return c.json({ error: `${rel} already exists; edit the premise rather than creating the episode again` }, 409);
      throw err;
    }
    return c.json({ id });
  });

  /** Launches a run: mints an id and spawns a worker on it.
   *
   *  Refused while the episode's latest run is live or parked at a gate. The gate refusal is the
   *  important one: a second run of an episode whose first run is waiting on the showrunner would
   *  redo from the beginning the work the showrunner is in the middle of judging, and both runs
   *  would write the same files.
   *
   *  The id is minted up to three times. `mintRunId` stamps the time to the second and appends
   *  four random characters, so two launches inside one second can collide — and a collision
   *  would not be a new run at all: the worker would take the existing run's log and append to
   *  its history. */
  app.post("/api/episodes/:id/runs", async (c) => {
    const id = c.req.param("id");
    const valid = checkEpisodeId(id);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
    const latest = await latestRunId(ctx.showRoot, id, ctx.productionDir);
    if (latest !== undefined) {
      const held = await readLock(ctx, id, latest);
      if (held?.alive === true) return c.json({ error: `run ${latest} is held by pid ${held.pid}` }, 409);
      const state = deriveRunState((await store.get(id, latest)).events);
      if (state.openGate !== undefined) return c.json({ error: `answer the gate on run ${latest} first` }, 409);
    }
    let runId: string | undefined;
    for (let attempt = 0; attempt < 3 && runId === undefined; attempt++) {
      const candidate = mintRunId();
      if (!(await exists(EventLog.logPath(ctx.showRoot, id, candidate, ctx.productionDir)))) runId = candidate;
    }
    if (runId === undefined) return c.json({ error: `could not mint a free run id for ${id}: three candidates already had logs` }, 409);
    const { pid } = await spawnWorker(ctx, id, runId);
    return c.json({ runId, pid });
  });

  /** Answers the open gate — approve, or reject with notes — and sets the run going again.
   *
   *  `expectedAttempt` is the attempt the Gate page read. The engine refuses an answer that names
   *  a different one, which is the whole protection against a tab left open across a rejection:
   *  the showrunner would otherwise approve a message that a fix agent has already superseded. */
  app.post("/api/episodes/:id/runs/:run/gate", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const { id, run } = checked;
    const body = await readJsonBody(c);
    const stepId = body["stepId"];
    const approved = body["approved"];
    const notes = body["notes"] ?? "";
    const expectedAttempt = body["expectedAttempt"];
    if (typeof stepId !== "string" || stepId === "") return c.json({ error: "stepId must be a non-empty string" }, 400);
    if (typeof approved !== "boolean") return c.json({ error: "approved must be true or false" }, 400);
    if (typeof notes !== "string") return c.json({ error: "notes must be a string" }, 400);
    if (expectedAttempt !== undefined && !Number.isInteger(expectedAttempt)) return c.json({ error: "expectedAttempt must be an integer" }, 400);
    const held = await readLock(ctx, id, run);
    if (held?.alive === true) return c.json({ error: `run ${run} is held by pid ${held.pid}` }, 409);
    try {
      await answerGate(logOf(ctx, id, run), run, stepId, {
        approved, notes, by: ctx.operator,
        ...(typeof expectedAttempt === "number" ? { expectedAttempt } : {}),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    const { pid } = await spawnWorker(ctx, id, run);
    return c.json({ runId: run, pid });
  });

  /** Resumes a failed run: the failed step and everything it swept away go back to pending, and a
   *  worker continues from there. Only a run whose log ends failed can be resumed. */
  app.post("/api/episodes/:id/runs/:run/resume", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const { id, run } = checked;
    const held = await readLock(ctx, id, run);
    if (held?.alive === true) return c.json({ error: `run ${run} is held by pid ${held.pid}` }, 409);
    try {
      await resumeRun(logOf(ctx, id, run), run, ctx.operator);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    const { pid } = await spawnWorker(ctx, id, run);
    return c.json({ runId: run, pid });
  });

  /** Continues a crashed run: the one action with nothing to append.
   *
   *  A crash is a log with no terminal event and no live worker — a worker that was killed (its
   *  lock still there, its pid dead) or a `run()` that rejected (the lock gone with its
   *  `finally`). The worker's own `run()` replays the open step, so continuing is just putting a
   *  worker back on the run. A stale lock's recorded process groups are signalled first: the
   *  script children of a killed worker are in their own groups and outlive it, and a replay
   *  starting while a dead run's renderer is still writing would have two processes on one file.
   *
   *  Refused for a run that is finished (resume it, or launch a new one) or waiting (answer the
   *  gate). Keyed on the log and the lock rather than on the status string, so it offers the same
   *  move whatever the Board happens to call the run. */
  app.post("/api/episodes/:id/runs/:run/continue", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const { id, run } = checked;
    const { events } = await store.get(id, run);
    if (events.length === 0) return c.json({ error: `run ${run} of ${id} has no log; launch a run instead` }, 409);
    const state = deriveRunState(events);
    if (state.finished) return c.json({ error: `run ${run} is finished (${state.status}); resume it or launch a new run` }, 409);
    if (state.openGate !== undefined) return c.json({ error: `run ${run} is waiting at gate ${JSON.stringify(state.openGate.stepId)}; answer the gate instead` }, 409);
    const held = await readLock(ctx, id, run);
    if (held?.alive === true) return c.json({ error: `run ${run} is held by pid ${held.pid}` }, 409);
    if (held !== undefined && held.groups.length > 0) killRecordedGroups(held);
    const { pid } = await spawnWorker(ctx, id, run);
    return c.json({ runId: run, pid });
  });

  /** Re-runs from here: the named steps and everything downstream of them go back to pending.
   *
   *  Refused while a gate is open, because the two moves mean different things and the wrong one
   *  is expensive: a gate is answered or withdrawn, and resetting around it would leave the run
   *  rebuilding the work the showrunner is being asked about. Gates themselves are never reset —
   *  that is the engine's rule, and `withdraw` is how an approval is taken back. */
  app.post("/api/episodes/:id/runs/:run/reset", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const { id, run } = checked;
    const body = await readJsonBody(c);
    const stepIds = body["stepIds"];
    if (!Array.isArray(stepIds) || stepIds.length === 0 || !stepIds.every((s) => typeof s === "string" && s !== "")) {
      return c.json({ error: "stepIds must be a non-empty array of step ids" }, 400);
    }
    const held = await readLock(ctx, id, run);
    if (held?.alive === true) return c.json({ error: `run ${run} is held by pid ${held.pid}` }, 409);
    const state = deriveRunState((await store.get(id, run)).events);
    if (state.openGate !== undefined) {
      return c.json({ error: `gate ${JSON.stringify(state.openGate.stepId)} is open; answer it or withdraw, not reset` }, 409);
    }
    let reset: string[];
    try {
      reset = await resetSteps(pipelineFor(ctx, id), logOf(ctx, id, run), run, stepIds as string[], ctx.operator);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    const { pid } = await spawnWorker(ctx, id, run);
    return c.json({ runId: run, pid, reset });
  });

  /** Withdraws an approval the showrunner already gave: everything downstream of the gate goes
   *  back to pending and the gate is answered again as a rejection, so the next worker takes the
   *  ordinary rejection path — the fix agent, the gate's re-run set, and the gate reopened at the
   *  next attempt. `reset` names the steps that will run again, which is what the operator is
   *  really deciding about. */
  app.post("/api/episodes/:id/runs/:run/withdraw", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const { id, run } = checked;
    const body = await readJsonBody(c);
    const stepId = body["stepId"];
    const notes = body["notes"] ?? "";
    if (typeof stepId !== "string" || stepId === "") return c.json({ error: "stepId must be a non-empty string" }, 400);
    if (typeof notes !== "string") return c.json({ error: "notes must be a string" }, 400);
    const held = await readLock(ctx, id, run);
    if (held?.alive === true) return c.json({ error: `run ${run} is held by pid ${held.pid}` }, 409);
    let reset: string[];
    try {
      reset = await withdrawApproval(pipelineFor(ctx, id), logOf(ctx, id, run), run, stepId, { notes, by: ctx.operator });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    const { pid } = await spawnWorker(ctx, id, run);
    return c.json({ runId: run, pid, reset });
  });

  // ── the gate, the artifacts and "what happened" ───────────────────────────────────────────

  /** The open gate of one run: the question, the files it is about, the verdicts behind it, and
   *  the attempt the answer must name. A 404 means no gate is open, which is also what a client
   *  polling a gate sees the moment someone else answers it. */
  app.get("/api/episodes/:id/runs/:run/gate", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const view = await gateView(ctx, store, checked.id, checked.run);
    if (view === undefined) return c.json({ error: `no gate is open on run ${checked.run} of ${checked.id}` }, 404);
    return c.json(view);
  });

  /** The episode's own files: a file with HTTP Range, or a directory as a JSON listing. The `*`
   *  is a show-relative path, and `resolveArtifactPath` is the only thing standing between it and
   *  the filesystem — see `server/artifacts.ts` for the three layers it applies. */
  app.get("/api/episodes/:id/files/:path{.+}", async (c) => {
    const id = c.req.param("id");
    const valid = checkEpisodeId(id);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
    return serveArtifact(c, ctx, id, c.req.param("path"));
  });

  /** The run's raw log, as a download: the file to attach to a bug report. */
  app.get("/api/episodes/:id/runs/:run/log", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    return serveRunLog(c, ctx, checked.id, checked.run);
  });

  /** Everything the troubleshooter would be handed, so the operator can read it first. */
  app.get("/api/episodes/:id/runs/:run/context", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    return c.json(await assemble(ctx, store, checked.id, checked.run));
  });

  /** Asks the troubleshooter about one run, streaming the answer as plain text so the operator
   *  reads the first sentence while the agent is still working. Every question and the answer it
   *  produced are appended to `<runs>/<runId>.troubleshooting.jsonl` — beside the run's log, never
   *  in it. */
  app.post("/api/episodes/:id/runs/:run/ask", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const { id, run } = checked;
    const body = await readJsonBody(c);
    const question = body["question"];
    if (typeof question !== "string" || question.trim() === "") return c.json({ error: "question must be a non-empty string" }, 400);
    const context = await assemble(ctx, store, id, run);
    const answer = deps.query !== undefined ? ask(ctx, context, question, deps.query) : ask(ctx, context, question);
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return streamText(c, async (s) => {
      for await (const chunk of answer) await s.write(chunk);
    });
  });

  return app;
}

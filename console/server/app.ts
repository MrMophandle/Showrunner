import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ENGINE_VERSION, EventLog, RUN_ID, STAGES, listEpisodeIds, parseEpisodeId } from "@showrunner/engine";
import type { EventBatch, SseMessage } from "../shared/types.js";
import type { RunStore } from "./runs.js";
import type { ShowContext } from "./show.js";

/** The console's HTTP surface. Task 4 is the read side — what the show is, what its episodes
 *  are, what one run looks like, and one channel that says when any of that changed. Task 5 adds
 *  the actions to the same app.
 *
 *  Two rules hold for every route. Every `:id` is validated with `parseEpisodeId` and every
 *  `:run` against `RUN_ID` **before** any path is built from it, because these are the strings
 *  that become filesystem paths: an unchecked `..` in either one reaches outside the episode, and
 *  a 400 at the edge is the only place that can be enforced once. And nothing here owns a run:
 *  the read routes read logs, and the SSE channel reports what the store saw. */

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

/** The console's app, reading one show through one store. */
export function createApp(ctx: ShowContext, store: RunStore): Hono {
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

  return app;
}

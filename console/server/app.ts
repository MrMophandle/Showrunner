import path from "node:path";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { stream as streamText, streamSSE } from "hono/streaming";
import {
  ENGINE_VERSION, EventLog, RUN_ID, STAGES, answerGate, deriveRunState, describePipeline, episodePipeline,
  latestRunId, listEpisodeIds, mintRunId, parseEpisodeId, resetSteps, resumeRun, withdrawApproval,
  type Pipeline, type PipelineDescription, type QueryFn, type RunState,
} from "@showrunner/engine";
import { ImportRefused, initScaffold, type GateChoice, type InitIO } from "@showrunner/tools";
import type { EpisodeRow, EventBatch, ShowInfo, SseMessage } from "../shared/types.js";
import { serveArtifact, serveRunLog } from "./artifacts.js";
import {
  answerBibleGate, bibleFile, bibleFilePath, bibleRows, finishBible, saveAnswers, startBibleRun,
  unapprovedBibleFiles, type BibleDeps,
} from "./bible.js";
import { gateView } from "./gates.js";
import { SHOW_KEY, readRegistry, registerShow } from "./registry.js";
import { RunStore } from "./runs.js";
import { defaultOperator, loadShowContext, type ShowContext } from "./show.js";
import { assemble, ask } from "./what-happened.js";
import { killRecordedGroups, readLock, spawnWorker } from "./workers.js";

/** The console's HTTP surface: the read side — what the show is, what its episodes are, what one
 *  run looks like, and one channel that says when any of that changed — and the write side, which
 *  is the six actions an operator can take on a run plus the gate view, the episode's own files
 *  and "what happened".
 *
 *  Four rules hold across every route.
 *
 *  Every route but one lives under `/api/shows/:show/`, and one middleware turns that segment into
 *  the `ShowContext` and the `RunStore` of the show the request means. The one exception is
 *  `GET /api/events`, which is one channel across every registered show and stamps the show key on
 *  every message instead. The middleware is also where a read-only show refuses a POST and where
 *  an unknown key becomes a 404, so neither refusal is seven handlers' job to remember.
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

/** The approved gates downstream of one gate, in pipeline order — the gates a withdrawal does
 *  **not** re-ask, computed from the pipeline's own dependency edges and the run's state.
 *
 *  This is a disclosure and not a behaviour: `withdrawApproval` resets every non-gate step
 *  downstream of the gate and leaves every downstream gate at `completed` (ruling F-26, and the
 *  engine's standing rule that no reset touches a gate), so withdrawing `outline-gate` on a run
 *  whose `script-gate` was also approved regenerates the script and then walks past the approval
 *  the showrunner gave the old one. The route returns these ids so the operator is told which
 *  approvals will be applied to work they have not seen.
 *
 *  The description is read rather than the pipeline's live steps because the edges and the kinds
 *  are all this needs, and the description is the shape that is already built per episode. */
function survivingGatesOf(description: PipelineDescription, state: RunState, stepId: string): string[] {
  const marked = new Set<string>([stepId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of description.steps) {
      if (marked.has(step.id)) continue;
      if (step.dependsOn.some((d) => marked.has(d))) { marked.add(step.id); grew = true; }
    }
  }
  return description.steps
    .filter((step) => step.id !== stepId && step.kind === "gate" && marked.has(step.id) && state.steps[step.id] === "completed")
    .map((step) => step.id);
}

/** What the show middleware puts on the Hono context, and what every route under
 *  `/api/shows/:show/` reads back with `c.get`.
 *
 *  Declared as Hono's `Variables` rather than left to `any` so a route that asked for a variable
 *  the middleware does not set would not compile. The two together are the whole of what resolving
 *  a show means: the show's own context, and the store watching that show's logs. */
export type ShowVars = { Variables: { ctx: ShowContext; store: RunStore } };

/** One show as the two show routes answer it: the registry's facts about it (`key`, `readOnly`)
 *  joined to the config's and the engine's. Built in one function because `GET /api/shows` and
 *  `GET /api/shows/:show` must not disagree about what a show is — the list is what the Shows page
 *  draws and the single answer is what a Board reads at startup, and a field present in one and
 *  absent from the other would be a page that works until the operator reloads it. */
function showInfo(ctx: ShowContext): ShowInfo {
  return {
    key: ctx.key,
    readOnly: ctx.readOnly,
    showName: ctx.show.showName,
    showSlug: ctx.show.showSlug,
    operator: ctx.operator,
    episodesDir: ctx.episodesDir,
    productionDir: ctx.productionDir,
    stages: [...STAGES],
    engineVersion: ENGINE_VERSION,
  };
}

/** What `POST /api/shows` needs in order to make a show and hold it: the registry file to append
 *  the entry to, and the four facts a `ShowContext` takes that are the console's own rather than
 *  the registry's.
 *
 *  It is a dep and not derived from the shows the app already holds, because the case this route
 *  exists for is **a console with no shows at all** — a new machine, whose registry file does not
 *  exist yet — and there is then no context to copy an engine root or a worker command from. When
 *  it is absent the route refuses: that is `--show <root>` single mode, which by ruling H-01 writes
 *  nothing on the machine. */
export interface NewShowDeps {
  registryFile: string;
  engineRoot: string;
  operator?: string;
  workerCommand?: string[];
  concurrency?: number;
}

/** The seams the app is built with. Production passes `newShow` and nothing else: `query` defaults,
 *  inside `what-happened.ts`, to the engine's `sdkQuery`; `setupWorkerCommand` defaults, inside
 *  `server/bible.ts`, to this console's own compiled setup worker; and `makeStore` to one store per
 *  show with the production poll. A test passes a fake worker, a temporary registry and a short
 *  poll, so every route can be driven end to end with no model and nothing written outside a
 *  temporary directory. */
export interface AppDeps {
  query?: QueryFn;
  /** What a new show is made and registered with; absent in `--show` single mode. */
  newShow?: NewShowDeps;
  /** argv prefix of the setup worker, as `ShowContext.workerCommand` is for the episode worker. */
  setupWorkerCommand?: string[];
  /** How the store for a newly registered show is built, so a test can give it the same short
   *  poll its other stores have. */
  makeStore?: (ctx: ShowContext) => RunStore;
}

/** A refusal a bible route answers, or `undefined` for a failure that is not the operator's and
 *  belongs on `app.onError` as a 500.
 *
 *  The statuses are the console's existing vocabulary, applied to the bible's own refusals: **404**
 *  for a key that is not one of the fifteen `BIBLE_FILES` names, because as far as a URL is
 *  concerned that file does not exist; **400** for a malformed run id and for an import path the
 *  fence refuses, both of which the operator can correct; **409** for every refusal that names a
 *  conflicting state — a run a worker holds, a gate that must be answered first, a file with no
 *  answers yet, a scaffold file that has no gate, and the engine's own wording for a gate answered
 *  at the wrong attempt.
 *
 *  Matched on the messages these functions produce, with `ImportRefused` matched on its class
 *  rather than its prose, because that prose is `@showrunner/tools`' to reword. A message no
 *  pattern here recognises is **not** turned into a 409 by default: an unrecognised failure
 *  answered as a conflict would tell the operator to retry something that is broken. */
function bibleRefusal(err: unknown): { status: 400 | 404 | 409; error: string } | undefined {
  if (err instanceof ImportRefused) return { status: 400, error: err.message };
  if (!(err instanceof Error)) return undefined;
  const m = err.message;
  if (/^no such bible file /.test(m)) return { status: 404, error: m };
  if (/^invalid run id /.test(m)) return { status: 400, error: m };
  if (/ is a scaffold file: /.test(m)) return { status: 409, error: m };
  if (/ asks no questions: /.test(m)) return { status: 409, error: m };
  if (/^run .* is held by pid /.test(m)) return { status: 409, error: m };
  if (/^answer the gate on run /.test(m)) return { status: 409, error: m };
  if (/ is not finished; /.test(m)) return { status: 409, error: m };
  if (/^answer .*'s questions first: /.test(m)) return { status: 409, error: m };
  if (/^a rejection needs notes/.test(m)) return { status: 400, error: m };
  if (/^could not mint a free run id /.test(m)) return { status: 409, error: m };
  // `answerGate`'s own refusals: "gate ... is open at attempt 2, not 1", "no gate is open on ...".
  if (/\bgate\b/.test(m) && /\battempt\b|no gate is open/.test(m)) return { status: 409, error: m };
  return undefined;
}

/** The `InitIO` a route hands a phase of `init` that asks nothing: `say` is collected and returned
 *  to the browser as the phase's own account of what it did, and a phase that tried to ask a
 *  question would fail loudly rather than hang on a terminal that is not there. */
function collectingIO(): { io: InitIO; said: string[] } {
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

/** A path with every symlink in it resolved, or the path itself when it does not exist yet — which
 *  is the ordinary case for a new show's directory. The comparisons below are string comparisons
 *  on resolved paths, and on macOS a temporary directory under `/var` is reached through a
 *  symlink, so two spellings of one directory would otherwise sit inside neither each other. */
async function realish(p: string): Promise<string> {
  try { return await realpath(p); } catch { /* not there yet */ }
  try { return path.join(await realpath(path.dirname(p)), path.basename(p)); } catch { return p; }
}

/** Whether `child` is `parent` or sits under it. A path that merely shares a prefix with the
 *  parent's name ("Showrunner-old" beside "Showrunner") is not inside it. */
function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** The console's app: one context and one store per registered show, resolved per request from the
 *  URL's show segment.
 *
 *  The two maps are keyed alike and are expected to hold the same keys — `main.ts` builds the
 *  store map by walking the show map — and the middleware refuses a key missing from either, so a
 *  half-built pair can never reach a route as a context with no store behind it. */
export function createApp(
  shows: Map<string, ShowContext>, stores: Map<string, RunStore>, deps: AppDeps = {},
): Hono<ShowVars> {
  const app = new Hono<ShowVars>();

  /** Any failure a route did not answer for itself, as JSON.
   *
   *  Without this, Hono answers its own `Internal Server Error` as `text/plain`, and every client
   *  of this server parses an error body as `{error}` — so a 500 read as an empty object and the
   *  page said nothing at all about what had gone wrong (ruling H-14). The message is the thrown
   *  error's own, because that message is what the operator has to act on, and the console's rule
   *  everywhere else is not to paraphrase the words the engine chose. */
  app.onError((err, c) => c.json({ error: err instanceof Error ? err.message : String(err) }, 500));

  /** What the bible's two actions spawn with: the setup worker's argv prefix, or nothing, in which
   *  case `server/bible.ts` resolves this console's own compiled `dist/worker/setup.js`. */
  const bibleDeps: BibleDeps = deps.setupWorkerCommand !== undefined ? { setupWorkerCommand: deps.setupWorkerCommand } : {};

  /** Every show this console holds. The client's first request: the Shows page is drawn from it,
   *  and a client cannot build any other url until it knows a key. */
  app.get("/api/shows", (c) => c.json([...shows.values()].map(showInfo)));

  /** Creates a show and registers it, in one request: the scaffold `init` writes, then the
   *  registry entry, then the context and the store this server holds it by.
   *
   *  **The three path refusals, each before anything is written** (spec §4.4, and ruling H-01's
   *  reason for a registry file at all):
   *
   *  - **a key the grammar rejects** — the key is the one string that becomes a URL segment, a map
   *    lookup and a log line, and `SHOW_KEY` is where that is decided for all three;
   *  - **a key already registered**, refused here against the shows this server holds *and* against
   *    the file on disk, so the scaffold is never written for a show whose key cannot be used
   *    (`registerShow` refuses it again, as the second line of defence);
   *  - **a path inside the engine root, or inside or containing a registered show's root.** The
   *    engine root holds this console and the engine's own tests; a show scaffolded inside it would
   *    put a show repository inside a repository, and the show-name grep over `engine/` would start
   *    reporting the new show's own bible. A path that contains a registered root would make the new
   *    show's repository the parent of an existing one, which is two shows with one git history.
   *    Both directions are refused, on resolved and symlink-resolved spellings alike.
   *
   *  **The maps gain the show without a restart.** `createApp` closes over the two maps and the
   *  show middleware reads them per request, so the `set` below is visible to the very next
   *  request — which is the whole reason the registry is a file and not argv: a list that lived in
   *  `process.argv` could not be appended to by the surface that creates a show (ruling H-01).
   *  `watch()` is started here too, so the new show's first bible run is tailed from the moment it
   *  starts rather than from the next console restart.
   *
   *  A console started with `--show <root>` refuses: that mode is one show, keyed by its directory
   *  name, writing nothing on the machine. */
  app.post("/api/shows", async (c) => {
    const newShow = deps.newShow;
    if (newShow === undefined) {
      return c.json({ error: "this console was started with --show, which holds one show and writes no registry; start it with --registry <file> to create a show" }, 409);
    }
    const body = await readJsonBody(c);
    const name = body["name"];
    const rawPath = body["path"];
    const github = body["github"] ?? "none";
    if (typeof name !== "string" || name.trim() === "") return c.json({ error: "name must be a non-empty string" }, 400);
    if (typeof rawPath !== "string" || rawPath.trim() === "") return c.json({ error: "path must be a non-empty string" }, 400);
    if (github !== "private" && github !== "public" && github !== "none") return c.json({ error: 'github must be "private", "public" or "none"' }, 400);
    for (const field of ["slug", "nasRoot", "importFrom", "key"]) {
      const value = body[field];
      if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
        return c.json({ error: `${field} must be a non-empty string when it is given` }, 400);
      }
    }
    const target = path.resolve(rawPath);
    const key = typeof body["key"] === "string" ? body["key"] : path.basename(target);
    if (!SHOW_KEY.test(key)) {
      return c.json({ error: `${JSON.stringify(key)} is not a show key: expected [A-Za-z0-9][A-Za-z0-9_-]{0,63}` }, 400);
    }
    if (shows.has(key)) return c.json({ error: `${key} is already registered, at ${shows.get(key)?.showRoot ?? "another path"}` }, 409);
    const registry = await readRegistry(newShow.registryFile);
    const registered = registry.shows[key];
    if (registered !== undefined) return c.json({ error: `${key} is already registered, at ${path.resolve(registered.root)}` }, 409);

    const resolvedTarget = await realish(target);
    const engineRoot = await realish(path.resolve(newShow.engineRoot));
    if (inside(resolvedTarget, engineRoot) || inside(engineRoot, resolvedTarget)) {
      return c.json({ error: `${target} is inside the engine repository at ${newShow.engineRoot}; a show lives in a repository of its own` }, 400);
    }
    for (const [otherKey, entry] of Object.entries(registry.shows)) {
      const other = await realish(path.resolve(entry.root));
      if (inside(resolvedTarget, other) || inside(other, resolvedTarget)) {
        return c.json({ error: `${target} is inside or holds the show registered as ${otherKey} at ${entry.root}; a show lives in a repository of its own` }, 400);
      }
    }

    const { io, said } = collectingIO();
    let root: string;
    let commits: string[];
    try {
      const scaffold = await initScaffold({
        name: name.trim(),
        path: target,
        github,
        engineRoot: newShow.engineRoot,
        ...(typeof body["slug"] === "string" ? { slug: body["slug"] } : {}),
        ...(typeof body["nasRoot"] === "string" ? { nasRoot: body["nasRoot"] } : {}),
        ...(typeof body["importFrom"] === "string" ? { importFrom: body["importFrom"] } : {}),
      }, io);
      root = scaffold.root;
      commits = scaffold.commits;
    } catch (err) {
      // Every refusal `initScaffold` makes is the author's to fix: an empty name, a slug that
      // would not name a file, a directory that already holds something, an `--import` path that
      // is not a show. The message is the one to show them.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    await registerShow(newShow.registryFile, key, { root });
    const ctx = await loadShowContext({
      key, showRoot: root, engineRoot: newShow.engineRoot,
      ...(newShow.operator !== undefined ? { operator: newShow.operator } : {}),
      ...(newShow.workerCommand !== undefined ? { workerCommand: newShow.workerCommand } : {}),
      ...(newShow.concurrency !== undefined ? { concurrency: newShow.concurrency } : {}),
    });
    const store = deps.makeStore !== undefined ? deps.makeStore(ctx) : new RunStore(ctx);
    shows.set(key, ctx);
    stores.set(key, store);
    await store.watch();
    return c.json({ key, root, commits, said });
  });

  /** Resolves `:show` into the context and the store of the show a request means, and refuses the
   *  two things no route beneath it should have to think about.
   *
   *  **404 for a key this console does not hold**, including a key the grammar rejects — tested
   *  before the map lookup, because the key is the one string that reaches a URL path segment and
   *  validating it once here is the fence spec §4.4 asks for (the episode ids beneath it are
   *  fenced the same way, once, by `checkEpisodeId`).
   *
   *  **403 for any POST to a read-only show.** Here and not in the seven POST handlers, for a
   *  measured reason: a POST to a path no route registered still matches `/api/shows/:show/*`, so
   *  the refusal covers the whole subtree rather than the seven paths somebody remembered. The
   *  retired repository and the live instance name the same NAS root and the same final filename,
   *  so one write in the wrong tree overwrites a finished season (ruling H-03) — this is the line
   *  that makes listing the retired show safe. */
  const resolveShow: MiddlewareHandler<ShowVars> = async (c, next) => {
    const key = c.req.param("show") ?? "";
    if (!SHOW_KEY.test(key)) return c.json({ error: "no such show" }, 404);
    const ctx = shows.get(key);
    const store = stores.get(key);
    if (ctx === undefined || store === undefined) return c.json({ error: "no such show" }, 404);
    if (ctx.readOnly && c.req.method === "POST") return c.json({ error: `${key} is read-only` }, 403);
    c.set("ctx", ctx);
    c.set("store", store);
    await next();
  };
  // Two registrations and not one: Hono's `/*` does not match `/api/shows/<key>` with nothing
  // after it, and that is exactly the shape of the one-show route below.
  app.use("/api/shows/:show", resolveShow);
  app.use("/api/shows/:show/*", resolveShow);

  /** What a client needs once per show, at startup: which show this is, whether it may be
   *  written to, who it is talking to, and the stage vocabulary the Board's columns are drawn
   *  from. */
  app.get("/api/shows/:show", (c) => c.json(showInfo(c.get("ctx"))));

  /** The Board: one row per episode of the show, in id order.
   *
   *  **The gather is caught, and a show whose rows cannot be read becomes one row rather than a
   *  500** (ruling H-14). The failures are real and are the show's own files, not the console's: a
   *  malformed `Production/<id>/images/prompts.json` or `Canon/refs.json` throws out of the needs
   *  probes, through `episodeRow`, and used to take this route with it — and the operator was told
   *  "Internal Server Error" about a Board that names no show. One row carrying the reason says
   *  which show and why, the other registered shows are untouched because each is gathered under
   *  its own request, and the row's empty `id` is what marks it as a row about the show rather
   *  than about an episode. */
  app.get("/api/shows/:show/episodes", async (c) => {
    const ctx = c.get("ctx");
    const store = c.get("store");
    try {
      const ids = await listEpisodeIds(ctx.showRoot, ctx.show);
      return c.json(await Promise.all(ids.map((id) => store.episodeRow(id))));
    } catch (err) {
      // `id: ""` is what marks the row as a row about the show; `stage: ""` because an
      // unreadable show has no stage and claiming one would colour the chip with a fact nobody
      // derived. The reason is the whole of the row's content.
      const row: EpisodeRow = {
        id: "",
        title: ctx.show.showName,
        stage: "",
        status: "none",
        needs: { ideaMissing: false, refsMissing: [], imagesMissing: [] },
        error: `${ctx.key}: its episodes could not be read — ${err instanceof Error ? err.message : String(err)}`,
      };
      return c.json([row]);
    }
  });

  app.get("/api/shows/:show/episodes/:id", async (c) => {
    const id = c.req.param("id");
    const valid = checkEpisodeId(id);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
    return c.json(await c.get("store").episodeRow(id));
  });

  /** One run at the middle altitude. A run id with no log is not an error: the view is the
   *  pipeline with every step pending, which is what a run looks like in the second between its
   *  launch and its worker's first write. */
  app.get("/api/shows/:show/episodes/:id/runs/:run", async (c) => {
    const id = c.req.param("id");
    const run = c.req.param("run");
    const validId = checkEpisodeId(id);
    if (!validId.ok) return c.json({ error: validId.error }, 400);
    const validRun = checkRunId(run);
    if (!validRun.ok) return c.json({ error: validRun.error }, 400);
    return c.json(await c.get("store").view(id, run));
  });

  /** The bottom altitude: the raw events a client has not seen. `after` is a byte offset — the
   *  one the client's last view or SSE message carried — so a client tailing a run that is
   *  writing hundreds of lines a minute transfers only the lines. Read from the log rather than
   *  from the store's cache because the cache holds no per-event offsets: the file is the only
   *  thing that can answer "the bytes after N" exactly. */
  app.get("/api/shows/:show/episodes/:id/runs/:run/events", async (c) => {
    const ctx = c.get("ctx");
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
    const first = [...shows.values()][0];
    const hello: SseMessage = {
      type: "hello",
      // Every context carries the same operator — one `--operator` is passed to every show, and
      // the default is one function — so the first show's is the console's. A console holding no
      // shows yet still has an operator to name, which is the state the New-show surface runs in.
      operator: first?.operator ?? defaultOperator(),
      shows: [...shows.values()].map((s) => ({ key: s.key, showName: s.show.showName, readOnly: s.readOnly })),
    };
    await stream.writeSSE({ data: JSON.stringify(hello) });

    const queue: SseMessage[] = [];
    let wake: (() => void) | undefined;
    let open = true;
    // One subscription per show, drained into one queue: the channel is one stream across every
    // registered show, and each message says which show it is about.
    const unsubscribes = [...stores.values()].map((s) => s.subscribe((m) => { queue.push(m); wake?.(); }));
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
      for (const unsubscribe of unsubscribes) unsubscribe();
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
  app.post("/api/shows/:show/episodes", async (c) => {
    const ctx = c.get("ctx");
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

  /** Launches a run: mints an id, creates its log, and spawns a worker on it.
   *
   *  **Refused unless the episode's latest run is finished.** Three checks in order — a live
   *  lock, an open gate, an unfinished log — and the third is the one that keeps two workers off
   *  one episode. A run that is working, parked, crashed or resumed is a run whose files the next
   *  worker would write over: the same `outline.md`, the same `tts-script.json`, the same
   *  `video/episode.mp4`. The three legitimate launches all pass: the first one (there is no
   *  latest run), a relaunch after a completed run, and a relaunch after a failed one.
   *
   *  **The log is created before the spawn, with `wx` and zero bytes**, which is what makes the
   *  refusal above reachable at all. `latestRunId` lists `*.jsonl` and nothing else, while a
   *  worker writes its first line only after Node has started, the show config is read and the
   *  pipeline is built — half a second to a second in which a second launch would see no latest
   *  run, skip every check and mint a second run of the same episode. Creating the log here makes
   *  the minted run the latest run from the moment this route answers, and an empty log is
   *  unfinished, so the second launch is refused by the same check as a crash.
   *
   *  The empty file costs the worker nothing: `run()` reads its log once and appends
   *  `run_started` when that read yields no events, and a zero-byte file yields none. `wx` also
   *  subsumes the collision check the mint loop used to make — `mintRunId` stamps the time to the
   *  second and appends four random characters, so two launches inside one second can collide,
   *  and a collision would not be a new run at all but a second worker appending to an existing
   *  run's history. An `EEXIST` here is that collision, caught atomically rather than in the gap
   *  between a test and a create.
   *
   *  **A spawn that fails takes the log with it**, answering 500 with the spawner's own message.
   *  The log exists to name a run a worker is about to pick up; with no worker there is no run,
   *  and the file left behind would be the episode's latest run, empty and so unfinished —
   *  refusing every later launch while Continue refused it too. The episode would be wedged by a
   *  misconfiguration, which is a worse failure than the misconfiguration. */
  app.post("/api/shows/:show/episodes/:id/runs", async (c) => {
    const ctx = c.get("ctx");
    const store = c.get("store");
    const id = c.req.param("id");
    const valid = checkEpisodeId(id);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
    const latest = await latestRunId(ctx.showRoot, id, ctx.productionDir);
    if (latest !== undefined) {
      const held = await readLock(ctx, id, latest);
      if (held?.alive === true) return c.json({ error: `run ${latest} is held by pid ${held.pid}` }, 409);
      const state = deriveRunState((await store.get(id, latest)).events);
      if (state.openGate !== undefined) return c.json({ error: `answer the gate on run ${latest} first` }, 409);
      if (!state.finished) return c.json({ error: `run ${latest} is not finished; continue it, answer its gate, or resume it` }, 409);
    }
    let runId: string | undefined;
    let logFile: string | undefined;
    for (let attempt = 0; attempt < 3 && runId === undefined; attempt++) {
      const candidate = mintRunId();
      const file = EventLog.logPath(ctx.showRoot, id, candidate, ctx.productionDir);
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
      return c.json({ error: `could not mint a free run id for ${id}: three candidates already had logs` }, 409);
    }
    try {
      const { pid } = await spawnWorker(ctx, id, runId);
      return c.json({ runId, pid });
    } catch (err) {
      // The spawn failed, so the run the log was created for does not exist and never will. The
      // log has to go with it: left behind it would be the episode's **latest** run — empty, and
      // therefore unfinished — and the refusal above would then turn every later launch away
      // while Continue refused it too (an empty log is `has no log; launch a run instead`). An
      // episode wedged by a failed spawn is a worse failure than the spawn's own.
      await rm(logFile, { force: true });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /** Answers the open gate — approve, or reject with notes — and sets the run going again.
   *
   *  `expectedAttempt` is the attempt the Gate page read. The engine refuses an answer that names
   *  a different one, which is the whole protection against a tab left open across a rejection:
   *  the showrunner would otherwise approve a message that a fix agent has already superseded. */
  app.post("/api/shows/:show/episodes/:id/runs/:run/gate", async (c) => {
    const ctx = c.get("ctx");
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
  app.post("/api/shows/:show/episodes/:id/runs/:run/resume", async (c) => {
    const ctx = c.get("ctx");
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
  app.post("/api/shows/:show/episodes/:id/runs/:run/continue", async (c) => {
    const ctx = c.get("ctx");
    const store = c.get("store");
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
  app.post("/api/shows/:show/episodes/:id/runs/:run/reset", async (c) => {
    const ctx = c.get("ctx");
    const store = c.get("store");
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
   *  really deciding about.
   *
   *  `survivingGates` names the other half of that decision: the approved gates downstream of the
   *  withdrawn one, which keep their approvals and are walked past rather than re-asked. They are
   *  computed from the state **before** the withdrawal, because the withdrawal's own
   *  `gate_answered` changes the state it would be read from afterwards. The rail offers withdraw
   *  only on the latest approved gate, so an operator reaching this route for an earlier gate is
   *  acting deliberately — and is told exactly which approvals that spends. */
  app.post("/api/shows/:show/episodes/:id/runs/:run/withdraw", async (c) => {
    const ctx = c.get("ctx");
    const store = c.get("store");
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
    const pipeline = pipelineFor(ctx, id);
    const before = deriveRunState((await store.get(id, run)).events);
    const survivingGates = survivingGatesOf(describePipeline(pipeline), before, stepId);
    let reset: string[];
    try {
      reset = await withdrawApproval(pipeline, logOf(ctx, id, run), run, stepId, { notes, by: ctx.operator });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
    const { pid } = await spawnWorker(ctx, id, run);
    return c.json({ runId: run, pid, reset, survivingGates });
  });

  // ── the bible ─────────────────────────────────────────────────────────────────────────────
  //
  // The New-show surface's read and write sides. Four things make this family different from the
  // episode routes above, and all four are ruling H-07's:
  //
  //   * the key is a **bible key**, one of the fifteen `BIBLE_FILES` names, validated by
  //     `bibleEntry` inside `server/bible.ts` before it reaches a path — so these routes carry no
  //     `checkEpisodeId`, because the reserved id `setup` is not an episode id and never will be;
  //   * `GET bible/:key/file` is the one fence that serves a file under `Canon/`, and it serves
  //     exactly the file the table names for the key — there is no path parameter to traverse;
  //   * the gate's four answers are the terminal's four (`GATE_CHOICES`), two of which write the
  //     file before they answer; and
  //   * a read-only show refuses every one of the POSTs in the middleware above, not here.
  //
  // The write order inside each action is `server/bible.ts`' own, and its doc comments carry the
  // argument for it.

  /** The fifteen rows of the Bible view, in interview order. */
  app.get("/api/shows/:show/bible", async (c) => c.json(await bibleRows(c.get("ctx"))));

  /** One bible file: its row, its questions with whatever is answered, the gate's message when a
   *  gate is open, the file itself, and the latest run. */
  app.get("/api/shows/:show/bible/:key", async (c) => {
    try {
      return c.json(await bibleFile(c.get("ctx"), c.req.param("key"), c.get("store")));
    } catch (err) {
      const refusal = bibleRefusal(err);
      if (refusal === undefined) throw err;
      return c.json({ error: refusal.error }, refusal.status);
    }
  });

  /** The bible file itself, as text — the raw view behind the gate's rendered Markdown.
   *
   *  A 404 for a key that is not one of the fifteen, and a 404 for a file that is not written yet:
   *  both are "there is no such file here", which is the honest answer and the one the client's
   *  raw toggle can render. */
  app.get("/api/shows/:show/bible/:key/file", async (c) => {
    const ctx = c.get("ctx");
    const key = c.req.param("key");
    let file: string;
    try {
      file = bibleFilePath(ctx, key);
    } catch (err) {
      const refusal = bibleRefusal(err);
      if (refusal === undefined) throw err;
      return c.json({ error: refusal.error }, refusal.status);
    }
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: `${path.relative(ctx.showRoot, file)} is not written yet` }, 404);
      }
      throw err;
    }
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(text);
  });

  /** The author's answers for one bible file, saved the moment the form is saved — one of the four
   *  writes this server makes. The record is merged over what is on disk, so a form that posts one
   *  field cannot erase the other eight answers (`saveAnswers` records why). */
  app.post("/api/shows/:show/bible/:key/answers", async (c) => {
    const body = await readJsonBody(c);
    const answers = body["answers"];
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
      return c.json({ error: "answers must be an object of heading → answer" }, 400);
    }
    for (const [heading, value] of Object.entries(answers)) {
      if (typeof value !== "string") return c.json({ error: `the answer under ${JSON.stringify(heading)} must be a string` }, 400);
    }
    try {
      const file = await saveAnswers(c.get("ctx"), c.req.param("key"), answers as Record<string, string>);
      return c.json({ file });
    } catch (err) {
      const refusal = bibleRefusal(err);
      if (refusal === undefined) throw err;
      return c.json({ error: refusal.error }, refusal.status);
    }
  });

  /** Starts the file's writing step: creates the log and spawns the setup worker on it. Refused
   *  while the file's latest run is unfinished, and for an interview file with no answers. */
  app.post("/api/shows/:show/bible/:key/runs", async (c) => {
    try {
      return c.json(await startBibleRun(c.get("ctx"), c.req.param("key"), bibleDeps));
    } catch (err) {
      const refusal = bibleRefusal(err);
      if (refusal === undefined) throw err;
      return c.json({ error: refusal.error }, refusal.status);
    }
  });

  /** Answers the file's open gate with one of the four answers the terminal offers.
   *
   *  `expectedAttempt` is required and not optional, unlike the episode gate's, because every one
   *  of these four answers is a decision about a file the page has just shown: an answer written
   *  against a message a rejection has since superseded must be refused by the engine rather than
   *  applied to a newer ask nobody read. */
  app.post("/api/shows/:show/bible/:key/runs/:run/gate", async (c) => {
    const ctx = c.get("ctx");
    const body = await readJsonBody(c);
    const choice = body["choice"];
    const notes = body["notes"] ?? "";
    const importPath = body["importPath"];
    const expectedAttempt = body["expectedAttempt"];
    const choices: GateChoice[] = ["approve", "reject", "myself", "import"];
    if (typeof choice !== "string" || !choices.includes(choice as GateChoice)) {
      return c.json({ error: `choice must be one of ${choices.join(", ")}` }, 400);
    }
    if (typeof notes !== "string") return c.json({ error: "notes must be a string" }, 400);
    if (importPath !== undefined && typeof importPath !== "string") return c.json({ error: "importPath must be a string" }, 400);
    if (!Number.isInteger(expectedAttempt)) return c.json({ error: "expectedAttempt must be an integer: the attempt the gate you read is open at" }, 400);
    try {
      return c.json(await answerBibleGate(ctx, c.req.param("key"), c.req.param("run"), {
        choice: choice as GateChoice, notes, expectedAttempt: expectedAttempt as number, by: ctx.operator,
        ...(typeof importPath === "string" ? { importPath } : {}),
      }, bibleDeps));
    } catch (err) {
      const refusal = bibleRefusal(err);
      if (refusal === undefined) throw err;
      return c.json({ error: refusal.error }, refusal.status);
    }
  });

  /** The end of a setup: the bible-check report, the GitHub repository, and the next steps out of
   *  the show's own README.
   *
   *  **Refused while any gated bible file is unapproved**, with the list of them. `initFinish`
   *  derives its own `stalled` from the run logs, so calling it part-way through would answer
   *  "thirteen files are waiting on you" to an operator who asked to finish — and would create the
   *  GitHub repository over a half-written bible, which `gh repo create --push` cannot be asked to
   *  do twice under one name (Task 2's ruling, and its report's second concern).
   *
   *  The registry entry's `readOnly` is untouched: a show whose bible is finished is the show this
   *  console writes to, and read-only is the retired repository's property, not a stage. */
  app.post("/api/shows/:show/bible/finish", async (c) => {
    const ctx = c.get("ctx");
    const body = await readJsonBody(c);
    const github = body["github"] ?? "none";
    if (github !== "private" && github !== "public" && github !== "none") {
      return c.json({ error: 'github must be "private", "public" or "none"' }, 400);
    }
    const unapproved = await unapprovedBibleFiles(ctx);
    if (unapproved.length > 0) {
      return c.json({
        error: `${unapproved.length} bible file(s) are not approved yet: ${unapproved.join(", ")}. Finish them first — each one's gate is still the author's to answer.`,
        unapproved,
      }, 409);
    }
    return c.json(await finishBible(ctx, github));
  });

  // ── the gate, the artifacts and "what happened" ───────────────────────────────────────────

  /** The open gate of one run: the question, the files it is about, the verdicts behind it, and
   *  the attempt the answer must name. A 404 means no gate is open, which is also what a client
   *  polling a gate sees the moment someone else answers it. */
  app.get("/api/shows/:show/episodes/:id/runs/:run/gate", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const view = await gateView(c.get("ctx"), c.get("store"), checked.id, checked.run);
    if (view === undefined) return c.json({ error: `no gate is open on run ${checked.run} of ${checked.id}` }, 404);
    return c.json(view);
  });

  /** The episode's own files: a file with HTTP Range, or a directory as a JSON listing. The `*`
   *  is a show-relative path, and `resolveArtifactPath` is the only thing standing between it and
   *  the filesystem — see `server/artifacts.ts` for the three layers it applies. */
  app.get("/api/shows/:show/episodes/:id/files/:path{.+}", async (c) => {
    const id = c.req.param("id");
    const valid = checkEpisodeId(id);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
    return serveArtifact(c, c.get("ctx"), id, c.req.param("path"));
  });

  /** The run's raw log, as a download: the file to attach to a bug report. */
  app.get("/api/shows/:show/episodes/:id/runs/:run/log", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    return serveRunLog(c, c.get("ctx"), checked.id, checked.run);
  });

  /** Everything the troubleshooter would be handed, so the operator can read it first. */
  app.get("/api/shows/:show/episodes/:id/runs/:run/context", async (c) => {
    const checked = checkIds(c);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    return c.json(await assemble(c.get("ctx"), c.get("store"), checked.id, checked.run));
  });

  /** Asks the troubleshooter about one run, streaming the answer as plain text so the operator
   *  reads the first sentence while the agent is still working. Every question and the answer it
   *  produced are appended to `<runs>/<runId>.troubleshooting.jsonl` — beside the run's log, never
   *  in it. */
  app.post("/api/shows/:show/episodes/:id/runs/:run/ask", async (c) => {
    const ctx = c.get("ctx");
    const store = c.get("store");
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

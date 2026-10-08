import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadShowConfig, type ShowConfig } from "@showrunner/engine";
import { SHOW_KEY, type Registry } from "./registry.js";

/** One registered show, resolved once at startup. Everything the server does for that show is
 *  relative to it: the episode list, every log path, every artifact path and the argv of every
 *  worker it spawns.
 *
 *  **The server holds one of these per registered show, in a map keyed by `key`, and resolves
 *  which one a request means from the request's own URL** — `/api/shows/:show/…`, through one
 *  middleware in `server/app.ts`. The objection this module used to record against a second show
 *  was that a console pointed at two shows "would have to say which one every route meant, and no
 *  route does"; a show segment in front of every route and a middleware that reads it answer
 *  exactly that objection without changing what a context is. That is why none of the twenty-two
 *  signatures that take a `ShowContext` had to grow a show parameter: the caller resolves the
 *  show, and the callee still works on one.
 *
 *  `productionDir` and `episodesDir` are lifted out of `show` because every path the server
 *  builds needs them and `show.productionDir` is optional with a default; resolving the default
 *  once here keeps the fallback from being written out at a dozen call sites, where one of them
 *  would eventually get it wrong. */
export interface ShowContext {
  /** The operator's own name for this show, from the registry — what a URL carries and what the
   *  SSE channel stamps on every message. It is not derived from the config, because the only
   *  identity fields a `showrunner.json` carries are `showName` and `showSlug` and both shows on
   *  this machine declare the same pair of values (ruling H-02). Matches `SHOW_KEY`. */
  key: string;
  /** Whether this show refuses every POST. A read-only show is listed, read and browsed; nothing
   *  the console does writes to it, because the retired repository and the live instance name the
   *  same NAS root and the same final filename, so one finalize step run in the wrong tree
   *  overwrites the other show's finished season (ruling H-03). Enforced in one place — the show
   *  middleware in `server/app.ts` — and not in each write route, so a POST to a path no route
   *  registered is refused too. */
  readOnly: boolean;
  /** Absolute path of the show repository: the one tree the server reads and writes. */
  showRoot: string;
  show: ShowConfig;
  /** Absolute path of the engine repository checkout, where `scripts/` and `render/` live. */
  engineRoot: string;
  /** Who this server acts as, stamped on every gate answer and every run it launches:
   *  "console:<user>". */
  operator: string;
  /** The show's production directory name, already defaulted ("Production"). */
  productionDir: string;
  /** The show's episodes directory name, already defaulted ("Episodes"). */
  episodesDir: string;
  /** argv of the worker, as an array and never a shell string: `[executable, entry]`, to which
   *  `spawnWorker` appends the run's flags. A test points it at a fake worker. */
  workerCommand: string[];
  /** How many ready agent steps a run may execute at once, passed to every worker this server
   *  spawns as `--concurrency <n>` and from there into `run()`. The default of 7 is the width of
   *  the script pass's review panel — the canon reviewer plus the six checks, which all depend on
   *  the same draft — so the panel goes out in one batch. Only agent steps are batched, so a
   *  larger number buys nothing anywhere else in the episode pipeline. */
  concurrency: number;
}

/** What `loadShowContext` needs. `operator` defaults to "console:<username>", matching what the
 *  worker stamps when it is run by hand, and `workerCommand` to this console's own compiled
 *  worker. */
export interface ShowContextOptions {
  /** The registry key this show is reached by. */
  key: string;
  showRoot: string;
  /** Whether this show refuses every POST; defaults to false, the ordinary writable show. */
  readOnly?: boolean;
  engineRoot: string;
  operator?: string;
  workerCommand?: string[];
  concurrency?: number;
}

/** What `loadShows` needs: everything a `ShowContext` takes except the three facts the registry
 *  supplies per entry (`key`, `showRoot`, `readOnly`). The engine root, the operator, the worker
 *  command and the concurrency are the console's own and are the same for every show it holds, so
 *  a second show needs no second set of flags. */
export interface LoadShowsOptions {
  engineRoot: string;
  operator?: string;
  workerCommand?: string[];
  concurrency?: number;
  /** Where a show that would not load is reported. Defaults to a line on stderr; `main.ts` leaves
   *  the default and a test passes a collector so it can assert the reason by key. A seam rather
   *  than a thrown error because the reporting is the whole of the behaviour being specified: a
   *  skipped show that nobody was told about is a show the operator looks for in the list and does
   *  not find. */
  report?: (line: string) => void;
}

/** The compiled worker entry, as a path relative to this module. `server/show.ts` compiles to
 *  `dist/server/show.js`, so the worker is one directory over at `dist/worker/main.js`. Resolved
 *  from `import.meta.url` rather than from `process.cwd()` because the console is started from
 *  wherever the operator happens to be standing. */
function defaultWorkerEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "main.js");
}

/** Who this console acts as when `--operator` is not given: `console:<username>`, matching what
 *  the worker stamps when it is run by hand.
 *
 *  Exported because two places need the same value and one of them has no `ShowContext` to read it
 *  from: `loadShowContext` stamps it on every context, and the SSE channel's `hello` has to name
 *  the operator even on a console that holds no shows at all — the state a console is in before
 *  the first show is registered. Two spellings of the default would mean a `hello` that named a
 *  different operator from the one every gate answer was signed with. */
export function defaultOperator(): string {
  return `console:${os.userInfo().username}`;
}

/** Reads the show's config and resolves the paths and the identity the rest of the server works
 *  from. `showRoot` and `engineRoot` are made absolute here, once, so no later path join can
 *  depend on the working directory.
 *
 *  **The worker entry must exist, and this is where that is checked.** Under `npm run dev` the
 *  server runs from `console/server/main.ts` through `tsx`, so `defaultWorkerEntry()` resolves to
 *  `console/worker/main.js` — a file that exists only after a build; only `worker/main.ts` is
 *  there. Spawning it starts a Node process that exits at once with `ERR_MODULE_NOT_FOUND`, and
 *  `spawnWorker` sees a pid and reports success, so the route answers 200, the client navigates
 *  to the Run page, and the run never starts. Failing at startup instead puts the remedy in front
 *  of the operator before any episode is launched against it. */
export async function loadShowContext(opts: ShowContextOptions): Promise<ShowContext> {
  const showRoot = path.resolve(opts.showRoot);
  const show = await loadShowConfig(showRoot);
  const workerCommand = opts.workerCommand ?? [process.execPath, defaultWorkerEntry()];
  const entry = workerCommand[1];
  if (entry !== undefined && !existsSync(entry)) {
    throw new Error(`the worker is not built: run npm run build -w console, or pass --worker <path>`);
  }
  return {
    key: opts.key,
    readOnly: opts.readOnly ?? false,
    showRoot,
    show,
    engineRoot: path.resolve(opts.engineRoot),
    operator: opts.operator ?? defaultOperator(),
    productionDir: show.productionDir ?? "Production",
    episodesDir: show.episodesDir ?? "Episodes",
    workerCommand,
    concurrency: opts.concurrency ?? 7,
  };
}

/** One `ShowContext` per registered show, in registry order, keyed by the registry's key.
 *
 *  **A show whose repository will not load is reported by key and skipped, not fatal** (ruling
 *  H-14). A `showrunner.json` that is absent, unparseable or refused by the loader — an
 *  `audio.guestRefsDir` with no `{episodeId}`, say — is one repository being edited, restored or
 *  mounted, and the other shows on the machine have nothing to do with it. Refusing to start would
 *  mean one unfinished edit in one show takes every other show's Board off the air, and the
 *  operator's first move would be to stop the console rather than to look at the message. A
 *  skipped show is absent from the map, so its routes answer 404 through the show middleware: as
 *  far as a URL is concerned it is a show that does not exist, which is the honest answer, rather
 *  than a show whose Board is an error row.
 *
 *  **A key the grammar rejects is refused and not skipped**, because that is the registry file
 *  being wrong rather than a repository being wrong, and `readRegistry` has already refused the
 *  same thing for the same reason — this check is the second line of defence for a registry built
 *  in memory (`singleShowRegistry`, or Task 5's New-show surface) and never read from a file. */
export async function loadShows(reg: Registry, opts: LoadShowsOptions): Promise<Map<string, ShowContext>> {
  const report = opts.report ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const shows = new Map<string, ShowContext>();
  for (const [key, entry] of Object.entries(reg.shows)) {
    if (!SHOW_KEY.test(key)) {
      throw new Error(`${JSON.stringify(key)} is not a show key: expected [A-Za-z0-9][A-Za-z0-9_-]{0,63}`);
    }
    try {
      shows.set(key, await loadShowContext({
        key,
        showRoot: entry.root,
        readOnly: entry.readOnly ?? false,
        engineRoot: opts.engineRoot,
        ...(opts.operator !== undefined ? { operator: opts.operator } : {}),
        ...(opts.workerCommand !== undefined ? { workerCommand: opts.workerCommand } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      }));
    } catch (err) {
      report(`console: show ${key} (${entry.root}) was not loaded — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return shows;
}

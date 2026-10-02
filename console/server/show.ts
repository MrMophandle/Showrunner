import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadShowConfig, type ShowConfig } from "@showrunner/engine";

/** The one show this server is pointed at, resolved once at startup. Everything the server does
 *  afterwards is relative to it: the episode list, every log path, every artifact path and the
 *  argv of every worker it spawns. The server holds one of these and never a second, because a
 *  console that could be pointed at two shows at once would have to say which one every route
 *  meant, and no route does.
 *
 *  `productionDir` and `episodesDir` are lifted out of `show` because every path the server
 *  builds needs them and `show.productionDir` is optional with a default; resolving the default
 *  once here keeps the fallback from being written out at a dozen call sites, where one of them
 *  would eventually get it wrong. */
export interface ShowContext {
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
}

/** What `loadShowContext` needs. `operator` defaults to "console:<username>", matching what the
 *  worker stamps when it is run by hand, and `workerCommand` to this console's own compiled
 *  worker. */
export interface ShowContextOptions {
  showRoot: string;
  engineRoot: string;
  operator?: string;
  workerCommand?: string[];
}

/** The compiled worker entry, as a path relative to this module. `server/show.ts` compiles to
 *  `dist/server/show.js`, so the worker is one directory over at `dist/worker/main.js`. Resolved
 *  from `import.meta.url` rather than from `process.cwd()` because the console is started from
 *  wherever the operator happens to be standing. */
function defaultWorkerEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "main.js");
}

/** Reads the show's config and resolves the paths and the identity the rest of the server works
 *  from. `showRoot` and `engineRoot` are made absolute here, once, so no later path join can
 *  depend on the working directory. */
export async function loadShowContext(opts: ShowContextOptions): Promise<ShowContext> {
  const showRoot = path.resolve(opts.showRoot);
  const show = await loadShowConfig(showRoot);
  return {
    showRoot,
    show,
    engineRoot: path.resolve(opts.engineRoot),
    operator: opts.operator ?? `console:${os.userInfo().username}`,
    productionDir: show.productionDir ?? "Production",
    episodesDir: show.episodesDir ?? "Episodes",
    workerCommand: opts.workerCommand ?? [process.execPath, defaultWorkerEntry()],
  };
}

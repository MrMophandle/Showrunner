import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { defaultRegistryPath, readRegistry, singleShowRegistry, type Registry } from "./registry.js";
import { RunStore } from "./runs.js";
import { defaultOperator, loadShows } from "./show.js";

/** The console's entry point: every registered show, one port, and one store per show watching
 *  that show's run logs.
 *
 *  **The shows come from a registry** — `~/.showrunner/shows.json` by default, `--registry <file>`
 *  to point elsewhere, or `--show <root>` for the one-show console this used to be. Which show a
 *  request means is a segment of its own url, resolved by one middleware in `app.ts`, so the shows
 *  are a map here and a `ShowContext` is still one show everywhere else.
 *
 *  What it deliberately does not do is own anything it started. Workers are spawned detached and
 *  into their own process groups, so stopping this server — on a signal, on a crash, on an
 *  upgrade — leaves every run exactly where it was, still writing its log, still holding its
 *  lock. The console's job is to read those logs and to start workers; killing a render because
 *  an operator restarted the web server would be the single most expensive bug this program
 *  could have. */

/** The value after `--name`, or undefined. argv is read as an array and never joined into a
 *  shell string. */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/** Whether `--name` was given at all, for the flags that are a presence and not a value. */
function present(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** The port the server listens on when `--port` is not given.
 *
 *  **4410 and not 4400, because 4400 is console v1's port in the show repository** (its Vite dev
 *  server is on 5183, and this console's is on 5193). The two defaults differ so that both
 *  consoles run side by side through the transition — the showrunner's ruling of 2026-10-02 —
 *  rather than the second one to start failing to bind, or worse, binding the same port on a
 *  different interface and answering half the requests. Plan F retires v1 and frees 4400. */
export const DEFAULT_PORT = 4410;

const USAGE = `usage: console [--registry <file>] [--show <root>] [--engine-root <path>] [--port ${DEFAULT_PORT}] [--host] [--operator <name>] [--worker <path to a worker entry>] [--concurrency 7]\n`;

/** The registry the flags name, and the line to print about it once the server is listening.
 *
 *  Three cases, and the exits are the point of each. **Both flags is a usage error**: they are two
 *  answers to one question, and silently preferring one would be a console holding shows the
 *  operator did not ask for. **A malformed registry file is fatal** — exit 65, the message on
 *  stderr rather than a stack — because a registry read as empty looks exactly like a machine with
 *  no shows on it, and the operator's remedy would then be to register every show again.
 *  **The default registry being absent is not an error at all**: it is a new machine, and the
 *  New-show surface that writes the first entry is served by this very process, so the console has
 *  to come up with nothing in it and say so. */
async function registryFromFlags(): Promise<{ registry: Registry; note?: string }> {
  const showRoot = flag("show");
  const registryFile = flag("registry");
  if (showRoot !== undefined && registryFile !== undefined) {
    process.stderr.write("--show and --registry are two ways of saying which shows this console holds; pass one\n");
    process.stderr.write(USAGE);
    process.exit(64);
  }
  if (showRoot !== undefined) {
    try {
      return { registry: singleShowRegistry(showRoot) };
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(64);
    }
  }
  const file = registryFile !== undefined ? path.resolve(registryFile) : defaultRegistryPath();
  let registry: Registry;
  try {
    registry = await readRegistry(file);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(65);
  }
  if (Object.keys(registry.shows).length === 0) {
    return {
      registry,
      note: `console: no shows are registered — the registry at ${file} is empty or does not exist yet; `
        + `register a show from the browser, or start with --show <root>`,
    };
  }
  return { registry };
}

async function main(): Promise<void> {
  const { registry, note } = await registryFromFlags();
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/server/main.js → dist/server → dist → console → the repository root, where `scripts/`
  // and `render/` live.
  const engineRoot = flag("engine-root") ?? path.resolve(here, "..", "..", "..");
  const portRaw = flag("port") ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { process.stderr.write(`invalid --port ${portRaw}\n`); process.exit(64); }
  const operator = flag("operator");
  const worker = flag("worker");
  // How many ready agent steps a worker may run at once. 7 is the review panel's width; the flag
  // is here for an operator who is being rate-limited and wants the panel narrower.
  const concurrencyRaw = flag("concurrency") ?? "7";
  const concurrency = Number(concurrencyRaw);
  if (!Number.isInteger(concurrency) || concurrency < 1) { process.stderr.write(`invalid --concurrency ${concurrencyRaw}\n`); process.exit(64); }

  // One context per registered show, and one store per context. A show whose repository will not
  // load is reported on stderr by `loadShows` and left out of the map, so one unfinished edit in
  // one show does not take every other show's Board off the air (ruling H-14).
  const shows = await loadShows(registry, {
    engineRoot, concurrency,
    ...(operator !== undefined ? { operator } : {}),
    ...(worker !== undefined ? { workerCommand: [process.execPath, path.resolve(worker)] } : {}),
  });
  const stores = new Map<string, RunStore>();
  for (const [key, ctx] of shows) stores.set(key, new RunStore(ctx));
  const app = createApp(shows, stores);

  // The built client, when there is one. In development Vite serves it on its own port and
  // proxies /api here, so this directory does not exist and nothing is mounted.
  const clientDir = path.resolve(here, "..", "client");
  if (existsSync(clientDir)) {
    app.use("/*", serveStatic({ root: clientDir }));
    // The client routes in the browser ("/shows/<key>/episodes/s02e01"), so a path that names no
    // file is the client's own route and gets its index. Anything under /api/ that reached here is
    // a route that does not exist, and must stay a 404 rather than becoming an HTML page.
    app.get("/*", async (c) => {
      if (c.req.path.startsWith("/api/")) return c.notFound();
      return c.html(await readFile(path.join(clientDir, "index.html"), "utf8"));
    });
  }

  // Watching starts before listening, so the first request already has every show's logs tailed.
  for (const store of stores.values()) await store.watch();
  // Loopback unless asked: the console answers for a show repository and spawns processes, and
  // it has no authentication of its own. `--host` is the operator saying "put it on the LAN".
  const hostname = present("host") ? "0.0.0.0" : "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    const address = `http://${hostname === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"}:${info.port}`;
    // The operator is the console's, not a show's: `--operator` is passed to every show and the
    // default is one function, so this is the string every context was stamped with — and it is
    // still the right line to print on a console that holds no shows at all.
    const operatorName = operator ?? defaultOperator();
    process.stdout.write(`console: ${shows.size} show${shows.size === 1 ? "" : "s"} at ${address} (operator ${operatorName})\n`);
    // One line per show, keyed as the url keys it, because the key is what the operator has to
    // type or click and the name alone cannot be told apart when two shows share a name.
    for (const ctx of shows.values()) {
      process.stdout.write(`console:   ${ctx.key} — ${ctx.show.showName}${ctx.readOnly ? " (read-only)" : ""} → ${address}/shows/${ctx.key}\n`);
    }
    if (note !== undefined) process.stdout.write(`${note}\n`);
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`console: ${signal} — closing the server; every run keeps going\n`);
    for (const store of stores.values()) store.close();
    server.close(() => { process.exit(0); });
    // A connection that will not close must not keep the console alive forever: SSE streams are
    // open by design, and an operator who pressed Ctrl-C meant it.
    setTimeout(() => { process.exit(0); }, 2_000).unref();
  };
  process.on("SIGINT", () => { stop("SIGINT"); });
  process.on("SIGTERM", () => { stop("SIGTERM"); });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

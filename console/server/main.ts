import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { RunStore } from "./runs.js";
import { loadShowContext } from "./show.js";

/** The console's entry point: one show, one port, one store watching the show's run logs.
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

const USAGE = "usage: console --show <root> [--engine-root <path>] [--port 4400] [--host] [--operator <name>] [--worker <path to a worker entry>] [--concurrency 7]\n";

async function main(): Promise<void> {
  const showRoot = flag("show");
  if (showRoot === undefined) { process.stderr.write(USAGE); process.exit(64); }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/server/main.js → dist/server → dist → console → the repository root, where `scripts/`
  // and `render/` live.
  const engineRoot = flag("engine-root") ?? path.resolve(here, "..", "..", "..");
  const portRaw = flag("port") ?? "4400";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { process.stderr.write(`invalid --port ${portRaw}\n`); process.exit(64); }
  const operator = flag("operator");
  const worker = flag("worker");
  // How many ready agent steps a worker may run at once. 7 is the review panel's width; the flag
  // is here for an operator who is being rate-limited and wants the panel narrower.
  const concurrencyRaw = flag("concurrency") ?? "7";
  const concurrency = Number(concurrencyRaw);
  if (!Number.isInteger(concurrency) || concurrency < 1) { process.stderr.write(`invalid --concurrency ${concurrencyRaw}\n`); process.exit(64); }

  const ctx = await loadShowContext({
    showRoot, engineRoot, concurrency,
    ...(operator !== undefined ? { operator } : {}),
    ...(worker !== undefined ? { workerCommand: [process.execPath, path.resolve(worker)] } : {}),
  });
  const store = new RunStore(ctx);
  const app = createApp(ctx, store);

  // The built client, when there is one. In development Vite serves it on its own port and
  // proxies /api here, so this directory does not exist and nothing is mounted.
  const clientDir = path.resolve(here, "..", "client");
  if (existsSync(clientDir)) {
    app.use("/*", serveStatic({ root: clientDir }));
    // The client routes in the browser ("/episodes/s02e01"), so a path that names no file is
    // the client's own route and gets its index. Anything under /api/ that reached here is a
    // route that does not exist, and must stay a 404 rather than becoming an HTML page.
    app.get("/*", async (c) => {
      if (c.req.path.startsWith("/api/")) return c.notFound();
      return c.html(await readFile(path.join(clientDir, "index.html"), "utf8"));
    });
  }

  // Watching starts before listening, so the first request already has the show's logs tailed.
  await store.watch();
  // Loopback unless asked: the console answers for a show repository and spawns processes, and
  // it has no authentication of its own. `--host` is the operator saying "put it on the LAN".
  const hostname = present("host") ? "0.0.0.0" : "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    process.stdout.write(`console: ${ctx.show.showName} at http://${hostname === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"}:${info.port} (operator ${ctx.operator})\n`);
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`console: ${signal} — closing the server; every run keeps going\n`);
    store.close();
    server.close(() => { process.exit(0); });
    // A connection that will not close must not keep the console alive forever: SSE streams are
    // open by design, and an operator who pressed Ctrl-C meant it.
    setTimeout(() => { process.exit(0); }, 2_000).unref();
  };
  process.on("SIGINT", () => { stop("SIGINT"); });
  process.on("SIGTERM", () => { stop("SIGTERM"); });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

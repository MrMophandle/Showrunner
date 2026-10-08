import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { defaultOperator, loadShowContext } from "../server/show.js";
import { DEFAULT_PORT } from "../server/main.js";
import { ENGINE_ROOT, FAKE_WORKER, makeShow } from "./helpers.js";

/** The show context is resolved once, at startup, and it is the last moment at which the console
 *  can refuse to run on a worker entry that does not exist. Past it, `spawnWorker` sees a pid for
 *  a Node process that exits at once with `ERR_MODULE_NOT_FOUND`, the launch route answers 200,
 *  and the operator watches a Run page for a run that never started. */
describe("loadShowContext", () => {
  it("refuses a worker entry that does not exist, and names the remedy", async () => {
    const root = await makeShow();
    const missing = path.join(root, "dist", "worker", "main.js");
    await expect(loadShowContext({ key: "show", showRoot: root, engineRoot: ENGINE_ROOT, workerCommand: [process.execPath, missing] }))
      .rejects.toThrow("the worker is not built: run npm run build -w console, or pass --worker <path>");
  });

  it("resolves the context when the worker entry is there", async () => {
    const root = await makeShow();
    const ctx = await loadShowContext({
      key: "show", showRoot: root, engineRoot: ENGINE_ROOT, operator: "console:test",
      workerCommand: [process.execPath, FAKE_WORKER],
    });
    expect(ctx.workerCommand).toEqual([process.execPath, FAKE_WORKER]);
    expect(ctx.productionDir).toBe("Production");
    expect(ctx.episodesDir).toBe("Episodes");
    expect(ctx.concurrency).toBe(7);
  });

  it("carries the registry's key and defaults readOnly to false — a writable show", async () => {
    const root = await makeShow();
    const ctx = await loadShowContext({
      key: "harbor-light", showRoot: root, engineRoot: ENGINE_ROOT,
      workerCommand: [process.execPath, FAKE_WORKER],
    });
    expect(ctx.key).toBe("harbor-light");
    expect(ctx.readOnly).toBe(false);
  });

  it("carries readOnly when the registry set it, which is how a retired repository is listed", async () => {
    const root = await makeShow();
    const ctx = await loadShowContext({
      key: "retired", showRoot: root, readOnly: true, engineRoot: ENGINE_ROOT,
      workerCommand: [process.execPath, FAKE_WORKER],
    });
    expect(ctx.readOnly).toBe(true);
  });
});

/** The operator default has one declaration because two places need the same string: every
 *  context, and the SSE hello of a console that holds no shows at all. */
describe("defaultOperator", () => {
  it("is console:<username>, and is the default loadShowContext stamps", async () => {
    const root = await makeShow();
    const ctx = await loadShowContext({
      key: "show", showRoot: root, engineRoot: ENGINE_ROOT,
      workerCommand: [process.execPath, FAKE_WORKER],
    });
    expect(defaultOperator()).toBe(`console:${os.userInfo().username}`);
    expect(ctx.operator).toBe(defaultOperator());
  });
});

/** The ports, and the two places they can silently disagree with themselves.
 *
 *  A wrong port is not a crash. The server binds, the browser loads the client from Vite, and
 *  every `/api` request is proxied to console v1 on 4400 — which answers, with v1's own routes,
 *  so the Board reads as broken rather than as misconfigured. These three assertions are cheaper
 *  than that diagnosis. */
describe("the console's ports", () => {
  it("defaults to 4410, which is not console v1's 4400", () => {
    expect(DEFAULT_PORT).toBe(4410);
  });

  it("proxies the dev server's /api to the port the server binds with no --port", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(config).toContain(`"/api": "http://localhost:${DEFAULT_PORT}"`);
  });

  it("names one Vite port, 5193, in both the config and the dev script", async () => {
    const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    // The `vite --port` flag in the dev script overrides `server.port` in the config, so the two
    // numbers must be equal or `npm run dev` serves on a port the config does not name.
    expect(/port:\s*(\d+)/.exec(config)?.[1]).toBe("5193");
    expect(/vite --port (\d+)/.exec(pkg.scripts["dev:client"] ?? "")?.[1]).toBe("5193");
    // And `dev` is still what starts both halves. The flag moved into `dev:client` when `dev:server`
    // grew its `SHOWRUNNER_REGISTRY` branch — a conditional that would not survive being nested
    // inside `concurrently`'s own quoting — so this asserts the chain as well as the number.
    expect(pkg.scripts["dev"]).toContain("npm run dev:client");
    expect(pkg.scripts["dev"]).toContain("npm run dev:server");
  });

  it("starts a registry console under SHOWRUNNER_REGISTRY and a single-show one without it", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    const dev = pkg.scripts["dev:server"] ?? "";
    // `--show` single mode answers `409` to `POST /api/shows` (`app.ts`: "this console was started
    // with --show, which holds one show and writes no registry"), so the documented development
    // command used to be the one mode in which the branch's own New-show form submits and fails.
    // `SHOWRUNNER_REGISTRY` wins when it is set.
    expect(dev).toContain('if [ -n "$SHOWRUNNER_REGISTRY" ]');
    expect(dev).toContain('--registry "$SHOWRUNNER_REGISTRY"');
    expect(dev).toContain('--show "$SHOWRUNNER_SHOW_ROOT"');
  });
});

import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadShowContext } from "../server/show.js";
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
    await expect(loadShowContext({ showRoot: root, engineRoot: ENGINE_ROOT, workerCommand: [process.execPath, missing] }))
      .rejects.toThrow("the worker is not built: run npm run build -w console, or pass --worker <path>");
  });

  it("resolves the context when the worker entry is there", async () => {
    const root = await makeShow();
    const ctx = await loadShowContext({
      showRoot: root, engineRoot: ENGINE_ROOT, operator: "console:test",
      workerCommand: [process.execPath, FAKE_WORKER],
    });
    expect(ctx.workerCommand).toEqual([process.execPath, FAKE_WORKER]);
    expect(ctx.productionDir).toBe("Production");
    expect(ctx.episodesDir).toBe("Episodes");
    expect(ctx.concurrency).toBe(7);
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
    expect(/vite --port (\d+)/.exec(pkg.scripts["dev"] ?? "")?.[1]).toBe("5193");
  });
});

import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadShowContext } from "../server/show.js";
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

import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { killRecordedGroups, readLock, spawnWorker } from "../server/workers.js";
import { appWith, makeShow, waitFor, writeLock } from "./helpers.js";

const exists = async (p: string): Promise<boolean> => { try { await stat(p); return true; } catch { return false; } };

describe("spawnWorker", () => {
  it("spawns a detached worker that writes the run's log, and captures its output beside it", async () => {
    const { root, ctx } = await appWith(await makeShow());
    const { pid } = await spawnWorker(ctx, "s02e01", "20261002T100000Z-ab12");
    expect(pid).toBeGreaterThan(0);
    const runs = path.join(root, "Production", "s02e01", "runs");
    const log = path.join(runs, "20261002T100000Z-ab12.jsonl");
    await waitFor(async () => (await read(log)).includes("run_started"));
    expect(await exists(path.join(runs, "20261002T100000Z-ab12.worker.out"))).toBe(true);
  });

  it("refuses to spawn while a live lock holds the run", async () => {
    const { root, ctx } = await appWith(await makeShow());
    await writeLock(root, "s02e01", "r1", process.pid);
    await expect(spawnWorker(ctx, "s02e01", "r1")).rejects.toThrow(`run r1 is held by pid ${process.pid}`);
  });

  it("refuses an episode id or a run id that is not one", async () => {
    const { ctx } = await appWith(await makeShow());
    await expect(spawnWorker(ctx, "zz", "r1")).rejects.toThrow(/invalid episode id/);
    await expect(spawnWorker(ctx, "s02e01", "../escape")).rejects.toThrow(/invalid run id/);
  });
});

describe("readLock", () => {
  it("returns undefined when there is no lock, and the lock with its verdict on the pid when there is", async () => {
    const { root, ctx } = await appWith(await makeShow());
    expect(await readLock(ctx, "s02e01", "r1")).toBeUndefined();
    await writeLock(root, "s02e01", "r1", process.pid, [4242]);
    expect(await readLock(ctx, "s02e01", "r1")).toMatchObject({ pid: process.pid, alive: true, groups: [4242] });
  });
});

describe("killRecordedGroups", () => {
  it("kills nothing when the lock recorded no groups", () => {
    expect(killRecordedGroups({ pid: 1234, startedAt: "t", heartbeatAt: "t", groups: [] })).toEqual({ killed: 0, failed: 0 });
  });

  it("refuses a group id that would signal every process the user owns", () => {
    expect(killRecordedGroups({ pid: 1234, startedAt: "t", heartbeatAt: "t", groups: [0, 1, -5] })).toEqual({ killed: 0, failed: 3 });
  });
});

/** A file's text, or "" while it does not exist yet: the fake worker is a detached process, so a
 *  test waits for its writes rather than awaiting them. */
async function read(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); } catch { return ""; }
}

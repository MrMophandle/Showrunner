import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RUN_ID, mintRunId, listRuns, latestRunId, runLogPaths } from "../src/runs.js";

describe("runs", () => {
  it("mints sortable ids in the run-id alphabet", () => {
    const a = mintRunId(new Date("2026-10-02T15:30:00Z"));
    const b = mintRunId(new Date("2026-10-02T15:30:01Z"));
    expect(a).toMatch(/^20261002T153000Z-[a-z0-9]{4}$/);
    expect(RUN_ID.test(a)).toBe(true);
    expect(a < b).toBe(true);
  });
  it("lists an episode's runs ascending by id, ignoring other files, and names the latest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const dir = path.join(root, "Production", "s02e01", "runs");
    await mkdir(dir, { recursive: true });
    for (const f of ["20261002T100000Z-b2.jsonl", "20261001T090000Z-a1.jsonl", "20261002T100000Z-b2.lock", "notes.txt", "20261003T000000Z-c3.jsonl"]) await writeFile(path.join(dir, f), "");
    expect(await listRuns(root, "s02e01")).toEqual(["20261001T090000Z-a1", "20261002T100000Z-b2", "20261003T000000Z-c3"]);
    expect(await latestRunId(root, "s02e01")).toBe("20261003T000000Z-c3");
    expect(await listRuns(root, "s02e02")).toEqual([]);
    expect(await latestRunId(root, "s02e02")).toBeUndefined();
    expect(await runLogPaths(root, "s02e01")).toEqual(["20261001T090000Z-a1", "20261002T100000Z-b2", "20261003T000000Z-c3"].map((r) => path.join(dir, `${r}.jsonl`)));
  });
  it("refuses an invalid episode id before touching the filesystem", async () => {
    await expect(listRuns("/nowhere", "../x")).rejects.toThrow(/invalid episode id/);
  });
});

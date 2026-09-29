import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handEdits } from "../src/provenance.js";
import { hashFile } from "../src/hash.js";
import type { Event } from "../src/events.js";

describe("handEdits", () => {
  it("reports a file whose hash differs from the last step_completed that recorded it, and nothing for files never recorded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    await writeFile(path.join(root, "outline.md"), "agent wrote this");
    const recorded = await hashFile(path.join(root, "outline.md"));
    const ev = (stepId: string, outputHashes: Record<string, string | null>): Event => ({ ts: "t", runId: "r", stepId, kind: "step_completed", payload: { outputHashes } });
    const events: Event[] = [ev("outline", { "outline.md": "stale" }), ev("outline-fix", { "outline.md": recorded })];
    const ctx = { runId: "r", episodeId: "s02e01", showRoot: root, results: {}, events };
    expect(await handEdits(ctx, ["outline.md", "script.md"])).toEqual([]);
    await writeFile(path.join(root, "outline.md"), "the showrunner changed a line");
    const current = await hashFile(path.join(root, "outline.md"));
    expect(await handEdits(ctx, ["outline.md", "script.md"])).toEqual([{ file: "outline.md", recordedBy: "outline-fix", recordedHash: recorded, currentHash: current }]);
    // The brief wrote this as `{ ...ctx, events: undefined }`, which exactOptionalPropertyTypes
    // refuses: an optional `events` may be absent but never explicitly undefined. Omitting the
    // key tests the same branch of handEdits (`ctx.events ?? []`) and is the only shape a typed
    // caller can build.
    expect(await handEdits({ runId: "r", episodeId: "s02e01", showRoot: root, results: {} }, ["outline.md"])).toEqual([]);
  });
});

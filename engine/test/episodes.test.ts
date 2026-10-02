import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listEpisodeIds } from "../src/episodes.js";
import type { ShowConfig } from "../src/show-config.js";

const show: ShowConfig = { showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts", models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/nas" } };

describe("listEpisodeIds", () => {
  it("unions the episode and production directories, filters by id grammar, and sorts by id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    for (const d of ["Episodes/_TEMPLATE", "Episodes/_retired", "Episodes/s02e02", "Episodes/ep98", "Episodes/notes", "Production/s02e01", "Production/s02e02", "Production/voice-refs"]) await mkdir(path.join(root, d), { recursive: true });
    expect(await listEpisodeIds(root, show)).toEqual(["s02e01", "s02e02", "ep98"]);
  });
  it("tolerates a missing directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    expect(await listEpisodeIds(root, show)).toEqual([]);
  });
});

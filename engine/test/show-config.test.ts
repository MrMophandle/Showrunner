import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadShowConfig, seasonOf, resolveShowPath, ShowConfigError, SHOW_CONFIG_FILE } from "../src/show-config.js";

const good = {
  showName: "Harbor Lights", showSlug: "HarborLights", promptsDir: "prompts",
  models: { medium: "m-mid", large: "m-large", writer: "m-writer" },
  // Annotated, not inferred: a bare [1, 1] is number[], and seasonOf takes [number, number].
  airMap: { ep01: [1, 1], ep02: [1, 2] } as Record<string, [number, number]>,
  output: { nasRoot: "/Volumes/media/HarborLights" },
};
async function root(cfg: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "show-"));
  await writeFile(path.join(dir, SHOW_CONFIG_FILE), JSON.stringify(cfg));
  return dir;
}

describe("loadShowConfig", () => {
  it("loads a minimal valid config", async () => {
    const cfg = await loadShowConfig(await root(good));
    expect(cfg.showName).toBe("Harbor Lights");
    expect(cfg.models.writer).toBe("m-writer");
    expect(cfg.airMap["ep02"]).toEqual([1, 2]);
  });
  it("names the missing file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "show-"));
    await expect(loadShowConfig(dir)).rejects.toThrow(/showrunner\.json/);
  });
  it("names the first missing required key", async () => {
    const { models, ...rest } = good; void models;
    await expect(loadShowConfig(await root(rest))).rejects.toThrow(ShowConfigError);
    await expect(loadShowConfig(await root(rest))).rejects.toThrow(/models/);
    await expect(loadShowConfig(await root({ ...good, models: { medium: "m" } }))).rejects.toThrow(/models\.large/);
  });
  it("rejects a malformed airMap entry", async () => {
    await expect(loadShowConfig(await root({ ...good, airMap: { ep01: [1] } }))).rejects.toThrow(/airMap\.ep01/);
  });
  it("rejects an airMap key that is not a production id", async () => {
    // The air map answers "which season did this production id air in", so every key must be a
    // production id — an epNN. A key that parseEpisodeId refuses at all ("ep1", one digit) and a
    // key that parses as an aired id ("s01e01") are both rejected, the second because an aired id
    // already carries its season in the id and looking it up here would let the two disagree.
    await expect(loadShowConfig(await root({ ...good, airMap: { "ep1": [1, 1] } }))).rejects.toThrow(ShowConfigError);
    await expect(loadShowConfig(await root({ ...good, airMap: { "ep1": [1, 1] } }))).rejects.toThrow(/airMap\.ep1\b/);
    await expect(loadShowConfig(await root({ ...good, airMap: { "s01e01": [1, 1] } }))).rejects.toThrow(/airMap\.s01e01\b/);
    await expect(loadShowConfig(await root({ ...good, airMap: { "s01e01": [1, 1] } }))).rejects.toThrow(/production id/);
  });

  it("rejects invalid JSON with the file named", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "show-"));
    await writeFile(path.join(dir, SHOW_CONFIG_FILE), "{ not json");
    await expect(loadShowConfig(dir)).rejects.toThrow(/showrunner\.json/);
  });
});

describe("seasonOf", () => {
  it("reads the season off an aired id", () => { expect(seasonOf("s02e01", {})).toBe(2); });
  it("looks a production id up in the air map", () => { expect(seasonOf("ep02", good.airMap)).toBe(1); });
  it("fails for an unmapped production id", () => { expect(() => seasonOf("ep99", good.airMap)).toThrow(ShowConfigError); });
});

describe("resolveShowPath", () => {
  it("joins relative paths and keeps absolute ones", () => {
    expect(resolveShowPath("/show", "prompts")).toBe(path.join("/show", "prompts"));
    expect(resolveShowPath("/show", "/elsewhere/prompts")).toBe("/elsewhere/prompts");
  });
});

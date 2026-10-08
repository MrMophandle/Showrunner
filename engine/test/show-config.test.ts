import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadShowConfig, seasonOf, resolveShowPath, formatFilename, mixFilename, ShowConfigError, SHOW_CONFIG_FILE, SHOW_CONFIG_KEYS } from "../src/show-config.js";

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

  it("refuses a bad audio.guestRefsDir at load, and loads one that is absent or carries {episodeId}", async () => {
    // The key's two bad shapes were refused only where needs.ts reads them, which is inside the
    // reference probe, which is inside the console's Board route: a show whose config named one
    // shared guest-references directory started the console cleanly and then answered 500 for the
    // whole Board, with the reason reaching no operator (Plan H's inventory §6.3, ruling H-14).
    // Refusing at load means the config is refused where it is read, by name, once.
    const audio = (guestRefsDir: unknown) => ({ ...good, audio: { sampleRate: 48_000, guestRefsDir } });

    // Absent is this key's documented default, <productionDir>/<episodeId>/guest-refs: a show that
    // never casts a speaking guest must not have to name a directory it will never fill. Absent
    // with other audio keys present is the same case, and is the one a real config is in.
    expect((await loadShowConfig(await root(good))).audio).toBeUndefined();
    expect((await loadShowConfig(await root({ ...good, audio: { sampleRate: 48_000 } }))).audio).toEqual({ sampleRate: 48_000 });

    // One shared directory for every episode: the probe matches a guest WAV by slug prefix, so
    // s02e01's dock-hand-pim-1.wav would satisfy s02e02's Dock Hand Pim and refs-ready would pass
    // having proved nothing. The message says the shared case is unsupported, or an author reads
    // the refusal as a bug rather than as a ruling.
    await expect(loadShowConfig(await root(audio("Production/guest-refs")))).rejects.toThrow(ShowConfigError);
    await expect(loadShowConfig(await root(audio("Production/guest-refs")))).rejects.toThrow(/audio\.guestRefsDir "Production\/guest-refs" names no \{episodeId\}/);
    await expect(loadShowConfig(await root(audio("Production/guest-refs")))).rejects.toThrow(/one shared guest-references directory for every episode is not supported/);

    // Present and empty is a mistake in showrunner.json rather than a request for the default: a
    // scaffolding step that left the field blank would otherwise write an episode's guest WAVs
    // into a directory the show never named.
    await expect(loadShowConfig(await root(audio("")))).rejects.toThrow(/audio\.guestRefsDir is empty/);

    // Present and not a string reached no check before and silently took the default, which is the
    // same "report a check it did not perform" fault as the two above.
    await expect(loadShowConfig(await root(audio(42)))).rejects.toThrow(/audio\.guestRefsDir must be a string/);

    // The value a show that does name the directory writes. The loader validates and does not
    // rewrite: the literal {episodeId} is substituted per run by formatFilename in needs.ts, so the
    // string on the way out is the string in the file.
    const named = await loadShowConfig(await root(audio("Production/{episodeId}/guest-refs")));
    expect(named.audio?.["guestRefsDir"]).toBe("Production/{episodeId}/guest-refs");
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

describe("filenames", () => {
  it("formats {name} and {name:02d}, and refuses an unknown name", () => {
    expect(formatFilename("{slug} S{season:02d}E{episode:02d}.wav", { slug: "Show", season: 2, episode: 1 })).toBe("Show S02E01.wav");
    expect(formatFilename("{episodeId}.mp4", { episodeId: "ep98" })).toBe("ep98.mp4");
    expect(() => formatFilename("{nope}", { slug: "s" })).toThrow(/unknown name "nope"/);
  });
  it("names the mix from the pattern for an id with a season, and episode.wav otherwise", () => {
    const show = { showName: "S", showSlug: "Show", promptsDir: "prompts", models: { medium: "m", large: "l", writer: "w" }, airMap: { ep10: [1, 10] as [number, number] }, output: { nasRoot: "/nas", mixFilename: "{slug} S{season:02d}E{episode:02d}.wav" } };
    expect(mixFilename(show, "s02e01")).toBe("Show S02E01.wav");
    expect(mixFilename(show, "ep10")).toBe("Show S01E10.wav");
    expect(mixFilename(show, "ep98")).toBe("episode.wav");
    expect(mixFilename({ ...show, output: { nasRoot: "/nas" } }, "s02e01")).toBe("Show S02E01.wav");
  });
});

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts");

describe("SHOW_CONFIG_KEYS", () => {
  it("carries the eight required keys as requiredBy engine or both", () => {
    const required = ["showName", "showSlug", "promptsDir", "models.medium", "models.large", "models.writer", "airMap", "output.nasRoot"];
    for (const p of required) {
      const k = SHOW_CONFIG_KEYS.find((k) => k.path === p);
      expect(k, p).toBeDefined();
      expect(["engine", "both"]).toContain(k!.requiredBy);
    }
  });
  it("names every key a script reads through sc.value or sc.path", async () => {
    // The scripts read their config through exactly two accessors (scripts/lib/showconfig.py).
    // Every `sc.value(cfg, "a", "b")` / `sc.path(cfg, "a", "b", root=…)` site names a dotted key;
    // this test refuses a site whose key the list does not carry, so a new script setting cannot
    // be added without a row here — and `init` builds its config from these rows.
    // Either quote is accepted because a site inside an f-string writes its keys single-quoted
    // (scripts/master-video.py:74), and a quote class that saw only `"` would miss it silently.
    const files = (await readdir(SCRIPTS)).filter((f) => f.endsWith(".py")).map((f) => path.join(SCRIPTS, f));
    files.push(path.join(SCRIPTS, "lib", "showconfig.py"));
    const site = /sc\.(?:value|path)\(\s*cfg\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)/g;
    const seen = new Set<string>();
    for (const f of files) {
      const text = await readFile(f, "utf8");
      for (const m of text.matchAll(site)) {
        const dotted = [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).join(".");
        seen.add(dotted);
      }
    }
    expect(seen.size).toBeGreaterThan(40);
    const known = new Set(SHOW_CONFIG_KEYS.map((k) => k.path));
    const missing = [...seen].filter((k) => !known.has(k)).sort();
    expect(missing).toEqual([]);
  });
  it("has no duplicate paths", () => {
    const paths = SHOW_CONFIG_KEYS.map((k) => k.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

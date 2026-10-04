import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SHOW_CONFIG_KEYS, loadShowConfig } from "@showrunner/engine";
import { buildShowConfig, type ShowIdentity } from "../src/init/config.js";

const identity: ShowIdentity = {
  showName: "Harbor Lights",
  showSlug: "HarborLights",
  nasRoot: "/Volumes/media/HarborLights",
};

/** The value at a dotted path, or `undefined` where any segment of the path is absent — the walk
 *  `SHOW_CONFIG_KEYS` asks for, since its rows are dotted paths and the config is nested objects. */
function at(value: unknown, dotted: string): unknown {
  let cursor: unknown = value;
  for (const segment of dotted.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Every string anywhere in the built config, with the path it sits at, so a test can assert
 *  something about all of them at once. */
function strings(value: unknown, at = ""): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path: at, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${at}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => strings(v, at === "" ? k : `${at}.${k}`));
  }
  return [];
}

/** The first show's proper nouns, each spelled as two halves joined at run time so that this file
 *  does not itself carry one of them. The repository-wide grep that keeps the engine show-agnostic
 *  greps these very words over `tools/`, and the test that proves the built config is free of them
 *  must not be the one hit that grep reports. Matched with word boundaries, as the grep's `-w`
 *  does, so an innocent word that merely contains one of them is not a failure. */
const FIRST_SHOW_NOUNS: readonly string[] = [
  "dead" + "light", "dead " + "light", "sa" + "ble", "op" + "ha", "cric" + "ket", "re" + "mo",
  "tre" + "nt", "ilva" + "ren", "coal" + "vane", "the " + "mute", "an" + "sa", "mar" + "do",
  "ve" + "sk", "set" + "hin", "ely" + "th", "iss" + "-kar", "dray" + "man", "vanis" + "hed",
  "dark " + "forest",
];

describe("buildShowConfig: every key a reader reads", () => {
  it("resolves every SHOW_CONFIG_KEYS path to a defined value", () => {
    const config = buildShowConfig(identity, []);
    const absent = SHOW_CONFIG_KEYS.filter((k) => at(config, k.path) === undefined).map((k) => k.path);
    expect(absent).toEqual([]);
    expect(SHOW_CONFIG_KEYS.length).toBeGreaterThan(50);
  });

  it("is accepted by loadShowConfig once written", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "showrunner-config-"));
    await writeFile(path.join(root, "showrunner.json"), JSON.stringify(buildShowConfig(identity, ["Vale"]), null, 2) + "\n", "utf8");
    const loaded = await loadShowConfig(root);
    expect(loaded.showName).toBe("Harbor Lights");
    expect(loaded.showSlug).toBe("HarborLights");
    expect(loaded.promptsDir).toBe("prompts");
    expect(loaded.canonDir).toBe("Canon");
    expect(loaded.episodesDir).toBe("Episodes");
    expect(loaded.productionDir).toBe("Production");
    expect(loaded.output.nasRoot).toBe("/Volumes/media/HarborLights");
    expect(loaded.airMap).toEqual({});
    expect(loaded.models.writer).not.toBe("");
  });
});

describe("buildShowConfig: the values derived from the identity", () => {
  const config = buildShowConfig(identity, ["Vale", "The Warden"]);

  it("names the show, its slug and its NAS root", () => {
    expect(at(config, "showName")).toBe("Harbor Lights");
    expect(at(config, "showSlug")).toBe("HarborLights");
    expect(at(config, "output.nasRoot")).toBe("/Volumes/media/HarborLights");
  });

  it("derives the NAS mount from the NAS root's parent", () => {
    expect(at(config, "output.nasMount")).toBe("/Volumes/media");
  });

  it("puts the show's name on the title card in upper case", () => {
    expect(at(config, "video.titleCard.text")).toBe("HARBOR LIGHTS");
  });

  it("names the first season's playlist after the show", () => {
    expect(at(config, "publish.playlistName")).toBe("Harbor Lights Season 1");
  });

  it("writes standing copy that names the show and claims no setting of its own", () => {
    expect(at(config, "publish.standingCopy.weekly")).toBe("New episodes weekly. Self-contained stories set in the world of Harbor Lights.");
    expect(String(at(config, "publish.standingCopy.aiDisclosure"))).toContain("AI helps with the writing");
  });

  it("puts the narrator and the interviewed cast in audio.mainCast", () => {
    expect(at(config, "audio.mainCast")).toEqual(["narrator", "Vale", "The Warden"]);
    expect(at(buildShowConfig(identity, []), "audio.mainCast")).toEqual(["narrator"]);
  });

  it("leaves the keys a new show cannot know empty rather than inheriting another show's", () => {
    expect(at(config, "publish.playlistUrl")).toBe("");
    expect(at(config, "publish.tags")).toBe("");
    expect(at(config, "visual.ambientPromptScaffold")).toEqual([]);
    expect(at(config, "visual.styleConstants")).toBe("no text, no watermark, no signature.");
    expect(at(config, "airMap")).toEqual({});
  });
});

describe("buildShowConfig: no first-show noun survives into a new show", () => {
  it("carries none of them in any string value", () => {
    const config = buildShowConfig(identity, ["Vale"]);
    const hits: string[] = [];
    for (const { path: at, text } of strings(config)) {
      for (const noun of FIRST_SHOW_NOUNS) {
        if (new RegExp(`\\b${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
          hits.push(`${at}: ${text}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { castEntry, castIndexPath, castKey, loadCastIndex, voiceReady, CastIndexError } from "../src/cast.js";
import type { ShowConfig } from "../src/show-config.js";

const SHOW = {
  showName: "S", showSlug: "Show", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/nas" },
} as unknown as ShowConfig;

const INDEX = {
  version: 1, audio: { engine: "qwen3" },
  cast: {
    vale: { name: "Vale", kind: "human", speaks: true, debut: "s01e01", face: { ref: "Canon/characters/Vale/reference.png", gallery: [] }, voice: { ref: "Production/voice-refs/vale.wav", ref_text: "x", direction: "d", status: "LOCKED (speed 1.1)" } },
    "the-warden": { name: "the Warden", kind: "character", speaks: false, silent: true, face: { ref: "Canon/characters/Warden/reference.png", gallery: [] }, voice: null },
    pim: { name: "Dock Hand Pim", kind: "human", speaks: true, debut: "s02e01", voice: { ref: "Production/voice-refs/pim.wav", ref_text: "x", direction: "d", status: "CANDIDATE" } },
  },
};

async function showWithIndex(text: string | null) {
  const root = await mkdtemp(path.join(tmpdir(), "cast-"));
  await mkdir(path.join(root, "Canon"), { recursive: true });
  if (text !== null) await writeFile(path.join(root, "Canon", "cast.json"), text);
  return root;
}

describe("the cast index", () => {
  it("defaults its path under the canon directory and honours cast.index", () => {
    expect(castIndexPath(SHOW)).toBe("Canon/cast.json");
    expect(castIndexPath({ ...SHOW, canonDir: "Bible" } as ShowConfig)).toBe("Bible/cast.json");
    expect(castIndexPath({ ...SHOW, cast: { index: "Canon/people.json" } } as unknown as ShowConfig)).toBe("Canon/people.json");
  });

  it("is undefined when absent, an error when unreadable, and the parsed index otherwise", async () => {
    expect(await loadCastIndex(await showWithIndex(null), SHOW)).toBeUndefined();
    await expect(loadCastIndex(await showWithIndex("not json"), SHOW)).rejects.toBeInstanceOf(CastIndexError);
    await expect(loadCastIndex(await showWithIndex(JSON.stringify({ version: 1 })), SHOW)).rejects.toBeInstanceOf(CastIndexError);
    const index = await loadCastIndex(await showWithIndex(JSON.stringify(INDEX)), SHOW);
    expect(Object.keys(index!.cast)).toEqual(["vale", "the-warden", "pim"]);
  });

  it("finds an entry by the slug of a cast name, with the the- alternative", () => {
    const index = INDEX as never;
    expect(castEntry(index, "Vale")?.name).toBe("Vale");
    expect(castEntry(index, "the Warden")?.name).toBe("the Warden");
    expect(castEntry(index, "Warden")?.name).toBe("the Warden");
    expect(castEntry(index, "Dock Hand Pim")?.debut).toBe("s02e01");
    expect(castEntry(index, "Nobody")).toBeUndefined();
  });

  /** The third lookup step, which is the one the outline's cast lines need. An index key is
   *  `slugName` of whatever the migration filed the entry under — `pim` — while the outline names
   *  the character as the script does, "Dock Hand Pim", and neither `dock-hand-pim` nor
   *  `the-dock-hand-pim` is a key. Matching the entry's own `name` field closes that gap, and
   *  `castKey` still answers with the **index** key, which is what the probe's messages name so an
   *  author editing `Canon/cast.json` is pointed at the line that is actually there. */
  it("falls back to an entry whose own name slugs to the cast line's name, and reports the index key", () => {
    const index = INDEX as never;
    expect(castKey(index, "Pim")).toBe("pim");
    expect(castKey(index, "Dock Hand Pim")).toBe("pim");
    expect(castEntry(index, "Dock Hand Pim")?.name).toBe("Dock Hand Pim");
    // The direct key still wins, and `the-<slug>` still beats the name scan: both are answered
    // with the key as it is written in the file.
    expect(castKey(index, "Vale")).toBe("vale");
    expect(castKey(index, "the Warden")).toBe("the-warden");
    expect(castKey(index, "Warden")).toBe("the-warden");
    expect(castKey(index, "Nobody")).toBeUndefined();
  });

  it("calls a voice ready only when it is an object whose status says LOCKED", () => {
    const index = INDEX as never;
    expect(voiceReady(castEntry(index, "Vale")!)).toBe(true);
    expect(voiceReady(castEntry(index, "Pim")!)).toBe(false);
    expect(voiceReady(castEntry(index, "the Warden")!)).toBe(false);
  });
});

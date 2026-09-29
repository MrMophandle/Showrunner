import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { episodeNeeds, missingRefs, missingShowrunnerImages, parseCastSection } from "../src/needs.js";
import type { ShowConfig } from "../src/show-config.js";

const show: ShowConfig = {
  showName: "S", showSlug: "Show", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/nas" },
  audio: { voiceRefsDir: "Production/voice-refs" }, visual: { refs: "Canon/refs.json" },
};

async function show1() {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  const w = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); };
  await w("Canon/refs.json", JSON.stringify({
    _doc: "meta", vale: { kind: "human", ref: "Canon/characters/Vale/ref.png" }, "the-warden": { kind: "character", ref: "Canon/characters/Warden/ref.png" },
    harbor: { kind: "location", ref: "Canon/locations/harbor.png" }, ghost: { kind: "human", ref: "Canon/characters/Ghost/missing.png" },
  }));
  await w("Canon/characters/Vale/ref.png", "png"); await w("Canon/characters/Warden/ref.png", "png"); await w("Canon/locations/harbor.png", "png");
  await w("Production/voice-refs/refs.json", JSON.stringify({ cast: {
    narrator: { ref: "Production/voice-refs/n.wav", status: "LOCKED" }, Vale: { ref: "Production/voice-refs/vale.wav", status: "LOCKED (speed 1.1)" },
    Warden: { ref: "Production/voice-refs/warden.wav", status: "CANDIDATE" },
  } }));
  await w("Production/voice-refs/n.wav", "wav"); await w("Production/voice-refs/vale.wav", "wav"); await w("Production/voice-refs/warden.wav", "wav");
  return { root, w };
}

describe("parseCastSection", () => {
  it("reads the lines of the ## Cast section and nothing else", () => {
    const outline = "# Ep\n\n## Cast\n- Vale (recurring, speaks)\n- the Warden (recurring)\n- Dock Hand Pim (guest, speaks)\n- Harbor (location)\nnot a cast line\n\n## Beat outline\n- Vale (this is a beat, not cast)\n";
    expect(parseCastSection(outline)).toEqual([
      { name: "Vale", tags: ["recurring", "speaks"] }, { name: "the Warden", tags: ["recurring"] },
      { name: "Dock Hand Pim", tags: ["guest", "speaks"] }, { name: "Harbor", tags: ["location"] },
    ]);
    expect(parseCastSection("# Ep\n## Beat outline\n- x\n")).toEqual([]);
  });
});

describe("missingRefs", () => {
  it("is empty when every recurring subject has its image and every speaker its locked voice", async () => {
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Vale (recurring, speaks)\n- Harbor (location)\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([]);
  });
  it("names a missing image, an unlocked voice, an unregistered recurring subject, and a guest without a WAV", async () => {
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Ghost (recurring)\n- the Warden (recurring, speaks)\n- Nobody (recurring)\n- Dock Hand Pim (guest, speaks)\n- Quiet Pim (guest)\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([
      "Ghost: reference image missing at Canon/characters/Ghost/missing.png (Canon/refs.json key ghost)",
      "the Warden: voice is not LOCKED in Production/voice-refs/refs.json (cast key Warden)",
      "Nobody: no entry in Canon/refs.json (tried nobody, the-nobody)",
      "Dock Hand Pim: no guest voice at Production/s02e01/guest-refs/dock-hand-pim*.wav",
    ]);
  });
  it("finds a guest voice by slug prefix, and is empty without a cast section", async () => {
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Dock Hand Pim (guest, speaks)\n");
    await w("Production/s02e01/guest-refs/dock-hand-pim-1.wav", "wav");
    expect(await missingRefs(root, "s02e01", show)).toEqual([]);
    await w("Episodes/s02e01/outline.md", "## Beat outline\n- x\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([]);
  });
});

describe("missingShowrunnerImages and episodeNeeds", () => {
  it("lists showrunner shots without a PNG, and nothing before a shot list exists", async () => {
    const { root, w } = await show1();
    expect(await missingShowrunnerImages(root, "s02e01", show)).toEqual([]);
    await w("Production/s02e01/images/prompts.json", JSON.stringify({ shots: [
      { id: "s01-a", type: "ambient" }, { id: "s02-b", type: "character", source: "showrunner" }, { id: "s03-c", type: "character", source: "showrunner" }, { id: "s04-d", type: "character", source: "pipeline" },
    ] }));
    await w("Production/s02e01/images/s03-c.png", "png");
    expect(await missingShowrunnerImages(root, "s02e01", show)).toEqual(["s02-b"]);
  });
  it("derives all three flags", async () => {
    const { root, w } = await show1();
    expect(await episodeNeeds(root, "s02e01", show)).toEqual({ ideaMissing: true, refsMissing: false, imagesMissing: false });
    await w("Episodes/s02e01/premise.md", "  \n");
    expect((await episodeNeeds(root, "s02e01", show)).ideaMissing).toBe(true);
    await w("Episodes/s02e01/premise.md", "A week.");
    await w("Episodes/s02e01/outline.md", "## Cast\n- Nobody (recurring)\n");
    expect(await episodeNeeds(root, "s02e01", show)).toEqual({ ideaMissing: false, refsMissing: true, imagesMissing: false });
  });
});

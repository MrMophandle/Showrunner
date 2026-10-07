import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { episodeNeeds, missingRefs, missingShowrunnerImages, parseCastSection } from "../src/needs.js";
import type { ShowConfig } from "../src/show-config.js";

/** The probe's message for an outline whose `## Cast` section is absent or holds nothing it can
 *  read, asserted by text rather than by shape: it is the one line an author sees when a run stops
 *  at NEEDS_REFS with no cast at all, so it has to say what to write and in what grammar. */
const NO_CAST = 'the outline has no readable ## Cast section (write one line per subject as "- <Name> (<tags>)")';

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
  it("reads the lines of the ## Cast section, keeps the ones that miss the grammar, and ignores everything outside it", () => {
    const outline = "# Ep\n\n## Cast\n- Vale (recurring, speaks)\n- the Warden (recurring)\n- Dock Hand Pim (guest, speaks)\n- Harbor (location)\nnot a cast line\n\n## Beat outline\n- Vale (this is a beat, not cast)\n";
    expect(parseCastSection(outline)).toEqual({
      entries: [
        { name: "Vale", tags: ["recurring", "speaks"] }, { name: "the Warden", tags: ["recurring"] },
        { name: "Dock Hand Pim", tags: ["guest", "speaks"] }, { name: "Harbor", tags: ["location"] },
      ],
      // inside the section and not blank, so it is reported rather than dropped
      malformed: ["not a cast line"],
    });
    expect(parseCastSection("# Ep\n## Beat outline\n- x\n")).toEqual({ entries: [], malformed: [] });
    // a blank line between entries is layout, not a slip
    expect(parseCastSection("## Cast\n\n- Vale (recurring)\n\n")).toEqual({ entries: [{ name: "Vale", tags: ["recurring"] }], malformed: [] });
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
  it("reports a cast line that misses the grammar instead of passing it silently", async () => {
    const { root, w } = await show1();
    // The show's own prose habit: an em-dash where the grammar wants parentheses. This used to
    // return [] and take an unregistered subject into synthesis and image generation.
    await w("Episodes/s02e01/outline.md", "## Cast\n- Vale — recurring, speaks\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([
      "- Vale — recurring, speaks: not in the `- <Name> (<tags>)` grammar",
    ]);
    await w("Episodes/s02e01/outline.md", "## Cast\n- Vale (recurring, speaks\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([
      "- Vale (recurring, speaks: not in the `- <Name> (<tags>)` grammar",
    ]);
  });

  it("reports an entry whose tags name none of recurring, guest or location", async () => {
    const { root, w } = await show1();
    // `lead` reaches no check: without one of the three tags the probe routes on, the entry was
    // looked up nowhere and the outline passed refs-ready with a subject nobody had registered.
    await w("Episodes/s02e01/outline.md", "## Cast\n- Vale (lead, speaks)\n- Harbor (location)\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([
      "Vale: tags name none of recurring, guest, location (got lead, speaks)",
    ]);
  });

  it("reads the guest-reference directory from audio.guestRefsDir, substituting {episodeId}", async () => {
    // Every other test here omits the key and so exercises the <productionDir>/<episodeId>/guest-refs
    // default; this one is the only proof that a show which names the directory is obeyed, and that
    // the refusal names the directory the probe actually read rather than the old literal.
    const renamed: ShowConfig = { ...show, productionDir: "Prod", audio: { ...show.audio, guestRefsDir: "Voices/{episodeId}/guests" } };
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Dock Hand Pim (guest, speaks)\n");
    await w("Voices/s02e01/guests/dock-hand-pim-1.wav", "wav");
    expect(await missingRefs(root, "s02e01", renamed)).toEqual([]);
    // The WAV that satisfies s02e01 is in s02e01's directory, so s02e02 is still missing one — and
    // the line names Voices/s02e02/guests, not Prod/s02e02/guest-refs.
    await w("Episodes/s02e02/outline.md", "## Cast\n- Dock Hand Pim (guest, speaks)\n");
    expect(await missingRefs(root, "s02e02", renamed)).toEqual([
      "Dock Hand Pim: no guest voice at Voices/s02e02/guests/dock-hand-pim*.wav",
    ]);
  });

  it("refuses a configured guest-reference directory that names no {episodeId}, and an empty one", async () => {
    // A show whose audio.guestRefsDir is one shared directory gets no guest check at all: the probe
    // matches a WAV by slug prefix, so s02e01's dock-hand-pim-1.wav would satisfy s02e02's Dock Hand
    // Pim and refs-ready would report "all references present" having proved nothing (SR-3). The
    // refusal is the only thing standing between that config and a silent pass, so it is asserted
    // by message as well as by type -- the message has to say the shared case is unsupported, or an
    // author reads the throw as a bug rather than as a ruling.
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Dock Hand Pim (guest, speaks)\n");
    const shared: ShowConfig = { ...show, audio: { ...show.audio, guestRefsDir: "Production/guest-refs" } };
    await expect(missingRefs(root, "s02e01", shared)).rejects.toThrow(/audio\.guestRefsDir "Production\/guest-refs" names no \{episodeId\}/);
    await expect(missingRefs(root, "s02e01", shared)).rejects.toThrow(/one shared guest-references directory for every episode is not supported/);

    // Absent is a default and present-but-empty is a mistake: the two must not collapse into the
    // same silent <productionDir>/<episodeId>/guest-refs, or a show whose scaffolding left the
    // field blank writes its guest WAVs into a directory it never named. scripts/lib/showconfig.py's
    // production_dir refuses "" for productionDir by name for the same reason.
    const blank: ShowConfig = { ...show, audio: { ...show.audio, guestRefsDir: "" } };
    await expect(missingRefs(root, "s02e01", blank)).rejects.toThrow(/audio\.guestRefsDir is empty/);

    // A trailing slash is honoured rather than refused, and trimmed, because nothing downstream
    // collapses a double slash: without the trim the refusal below would name
    // Voices/s02e01/guests//dock-hand-pim*.wav.
    const slashed: ShowConfig = { ...show, audio: { ...show.audio, guestRefsDir: "Voices/{episodeId}/guests/" } };
    expect(await missingRefs(root, "s02e01", slashed)).toEqual([
      "Dock Hand Pim: no guest voice at Voices/s02e01/guests/dock-hand-pim*.wav",
    ]);
    await w("Voices/s02e01/guests/dock-hand-pim-1.wav", "wav");
    expect(await missingRefs(root, "s02e01", slashed)).toEqual([]);
  });

  it("finds a guest voice by slug prefix, and names the missing cast section", async () => {
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Dock Hand Pim (guest, speaks)\n");
    await w("Production/s02e01/guest-refs/dock-hand-pim-1.wav", "wav");
    expect(await missingRefs(root, "s02e01", show)).toEqual([]);
    // An outline with no `## Cast` heading at all. This used to return [] and pass refs-ready with
    // "all references present" having checked nothing (Plan H's H-09): the only thing between such
    // an outline and synthesis was the canon reviewer's willingness to put the absent section in
    // its `issues` array, which is an agent's judgment and not a guard.
    await w("Episodes/s02e01/outline.md", "## Beat outline\n- x\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([NO_CAST]);
  });

  it("names the missing cast section for a ## Cast heading with nothing under it, and reports nothing for an episode with no outline", async () => {
    const { root, w } = await show1();
    // The shape a writer leaves when it writes the heading and no lines under it. parseCastSection
    // skips a blank line inside the section, so `entries` and `malformed` are both empty exactly as
    // they are for an outline carrying no heading at all, and one message covers both shapes. A
    // section holding a line that misses the grammar is a different finding and keeps its own
    // message (the grammar test above), because that line names a subject the probe can see.
    await w("Episodes/s02e01/outline.md", "# Ep\n\n## Cast\n\n## Beat outline\n### Beat 1\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([NO_CAST]);
    // An outline that does not exist is not this probe's finding, and must stay empty. The episode
    // pipeline's `premise` guard refuses an episode with nothing in it as NEEDS_IDEA five steps
    // before refs-ready runs, so a message here would blame refs-ready for a state premise owns —
    // and because the console puts this list on every Board row regardless of stage, it would put
    // a "references missing" line on every episode nobody has started yet.
    expect(await missingRefs(root, "s02e02", show)).toEqual([]);
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

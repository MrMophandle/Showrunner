import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { episodeNeeds, missingRefs, missingShowrunnerImages, parseCastSection } from "../src/needs.js";
import type { ShowConfig } from "../src/show-config.js";

/** The probe's message for an outline whose `## Cast` section is absent or holds nothing it can
 *  read, asserted by text rather than by shape: it is the one line an author sees when a run stops
 *  at NEEDS_REFS with no cast at all, so it has to say what to write and in what grammar. */
const NO_CAST = 'the outline has no readable ## Cast section (write one line per subject as "- <Name> (<tags>)")';

/** The probe's one line for a show that has no `Canon/cast.json` at all, asserted by text: it is
 *  the whole report in that case, and the only thing standing between an unmigrated show and a
 *  run that stops at NEEDS_REFS with no idea what to do about it, so it has to carry the command
 *  that builds the index. */
const NO_INDEX = "no cast index at Canon/cast.json — run scripts/cast-index-build.py --write";

/** No `audio` and no `visual` group, which is the point: after Plan L1 (2026-10-31) the probe
 *  reads `Canon/cast.json` and neither `Production/voice-refs/refs.json` nor `Canon/refs.json`,
 *  and `cast.index` is defaulted, so a config naming no path at all exercises the real one. */
const show: ShowConfig = {
  showName: "S", showSlug: "Show", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/nas" },
};

/** The fixture show: one cast index and the files it points at. Six subjects, each of which is a
 *  case the probe below asserts on — Vale complete (a face on disk and a LOCKED voice whose WAV is
 *  on disk), the Warden a face and a voice that is still a CANDIDATE, Harbor a location with a
 *  face, Ghost a face reference that names a file nobody made, Dock Hand Pim an entry filed under
 *  the short key `pim` with a face and **no** voice, and Quiet Pim a face and no voice, which is
 *  all a subject who does not speak needs. */
async function show1() {
  const root = await mkdtemp(path.join(tmpdir(), "show-"));
  const w = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); };
  await w("Canon/cast.json", JSON.stringify({
    version: 1,
    audio: { engine: "qwen3", model: "a-tts-model" },
    cast: {
      vale: {
        name: "Vale", kind: "human", speaks: true, debut: "s01e01", face: { ref: "Canon/characters/Vale/ref.png", gallery: [] },
        voice: { ref: "Production/voice-refs/vale.wav", ref_text: "x", direction: "d", status: "LOCKED (speed 1.1)" },
      },
      "the-warden": {
        name: "the Warden", kind: "character", speaks: true, face: { ref: "Canon/characters/Warden/ref.png", gallery: [] },
        voice: { ref: "Production/voice-refs/warden.wav", ref_text: "x", direction: "d", status: "CANDIDATE" },
      },
      harbor: { name: "Harbor", kind: "location", speaks: false, face: { ref: "Canon/locations/harbor.png", gallery: [] } },
      ghost: { name: "Ghost", kind: "human", speaks: false, face: { ref: "Canon/characters/Ghost/missing.png", gallery: [] } },
      pim: { name: "Dock Hand Pim", kind: "human", speaks: true, debut: "s02e01", face: { ref: "Canon/characters/Pim/ref.png", gallery: [] } },
      "quiet-pim": { name: "Quiet Pim", kind: "human", speaks: false, face: { ref: "Canon/characters/QuietPim/ref.png", gallery: [] } },
    },
  }));
  await w("Canon/characters/Vale/ref.png", "png"); await w("Canon/characters/Warden/ref.png", "png"); await w("Canon/locations/harbor.png", "png");
  await w("Canon/characters/Pim/ref.png", "png"); await w("Canon/characters/QuietPim/ref.png", "png");
  await w("Production/voice-refs/vale.wav", "wav"); await w("Production/voice-refs/warden.wav", "wav");
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

  it("skips a line that is entirely an HTML comment, which is what the shipped outline template writes under ## Cast", () => {
    // The template at `tools/templates/episodes/_TEMPLATE/outline.md:10` writes the section's
    // instructions as a one-line HTML comment between the heading and the first entry. Before the
    // skip, this parser reported that line in `malformed` and `missingRefs` turned the engine's own
    // template into a NEEDS_REFS stop naming the instructions as a cast member.
    const comment = "<!-- One line per character and location, as `- <Name> (<tags>)`, tags from: recurring, guest, speaks, location. -->";
    expect(parseCastSection(`## Cast\n${comment}\n- Vale (recurring, speaks)\n- Harbor (location)\n`)).toEqual({
      entries: [{ name: "Vale", tags: ["recurring", "speaks"] }, { name: "Harbor", tags: ["location"] }],
      malformed: [],
    });
    // Indented, and with nothing else on the line, is the same thing: the test is on the trimmed line.
    expect(parseCastSection(`## Cast\n   ${comment}   \n- Vale (recurring)\n`).malformed).toEqual([]);
    // A comment that is not the whole line is still a cast line that misses the grammar, because the
    // part outside the comment is a subject this probe would otherwise never check.
    expect(parseCastSection("## Cast\n- Vale <!-- recurring -->\n").malformed).toEqual(["- Vale <!-- recurring -->"]);
    // And a comment opened on one line and closed on another is reported rather than skipped: it has
    // swallowed every line between the two, cast lines included.
    expect(parseCastSection("## Cast\n<!-- opened here\n- Vale (recurring)\nclosed here -->\n").malformed).toEqual([
      "<!-- opened here", "closed here -->",
    ]);
  });

  it("ends the section at a heading of any level, which is where the shipped template's beats begin", () => {
    // The other half of the template fault, and the one the comment skip alone did not fix. The
    // outline template's `## Cast` is followed by `### Beat 1` and `### Beat 2` *before* the next
    // level-2 heading, so a section closed only by `## ` swallowed both beat headings and reported
    // them as cast lines missing the grammar. `tools/test/templates.test.ts` asserts this against
    // the real template; this is the shape, in one string.
    const outline = "# s02e01\n\n## Cast\n<!-- instructions -->\n- Vale (recurring, speaks)\n- Harbor (location)\n\n### Beat 1 — <title>\n<!-- what a beat is -->\n\n### Beat 2 — <title>\n\n## Ending duties\n- not cast either\n";
    expect(parseCastSection(outline)).toEqual({
      entries: [{ name: "Vale", tags: ["recurring", "speaks"] }, { name: "Harbor", tags: ["location"] }],
      malformed: [],
    });
    // A heading is a boundary and never an entry, whatever its depth and whatever follows it: the
    // list under a later heading is that heading's, not the cast's.
    expect(parseCastSection("## Cast\n- Vale (recurring)\n#### Notes\n- a note, not a subject\n")).toEqual({
      entries: [{ name: "Vale", tags: ["recurring"] }],
      malformed: [],
    });
    // And the heading test is the ATX one: `#hashtag` with no space is prose, so it is still a line
    // inside the section that misses the grammar.
    expect(parseCastSection("## Cast\n#notaheading\n").malformed).toEqual(["#notaheading"]);
  });
});

describe("missingRefs", () => {
  it("is empty when every recurring subject has its image and every speaker its locked voice", async () => {
    const { root, w } = await show1();
    await w("Episodes/s02e01/outline.md", "## Cast\n- Vale (recurring, speaks)\n- Harbor (location)\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([]);
  });
  it("names a missing image, an unlocked voice, a subject with no entry, and a speaking guest with no voice", async () => {
    const { root, w } = await show1();
    // Every subject on the page is looked up in the index the same way, speaking or not, recurring
    // or guest: the four findings below are one entry each. Quiet Pim is the fifth line and
    // produces nothing, which is the proof that a guest who does not speak needs a face and no
    // voice — and that a guest is no longer satisfied by a WAV someone dropped in a directory.
    await w("Episodes/s02e01/outline.md", "## Cast\n- Ghost (recurring)\n- the Warden (recurring, speaks)\n- Nobody (recurring)\n- Dock Hand Pim (guest, speaks)\n- Quiet Pim (guest)\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([
      "Ghost: reference image missing at Canon/characters/Ghost/missing.png (Canon/cast.json key ghost)",
      "the Warden: voice is not LOCKED in Canon/cast.json (key the-warden)",
      "Nobody: no entry in Canon/cast.json (tried nobody, the-nobody)",
      "Dock Hand Pim: no voice in Canon/cast.json (key pim)",
    ]);
  });

  it("reports the one line that names the index and how to build it when the show has none", async () => {
    // The unmigrated show, and the shape of a production outage: the engine that reads the index
    // against an instance that has none stops every run here. The remedy is the whole report, so
    // the operator reads the command rather than a list of subjects nothing could have registered.
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    const w = async (rel: string, text: string) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); };
    await w("Episodes/s02e01/outline.md", "## Cast\n- Vale (recurring, speaks)\n- Harbor (location)\n");
    expect(await missingRefs(root, "s02e01", show)).toEqual([NO_INDEX]);
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

  it("honours the configured cast.index, and reports a voice WAV the index names and the show does not have", async () => {
    // The key is read through castIndexPath, so a show that files its index somewhere else is
    // obeyed and every message names the file the probe actually read.
    const { root, w } = await show1();
    const named: ShowConfig = { ...show, cast: { index: "Canon/people.json" } };
    await w("Episodes/s02e01/outline.md", "## Cast\n- Vale (recurring, speaks)\n");
    expect(await missingRefs(root, "s02e01", named)).toEqual([
      "no cast index at Canon/people.json — run scripts/cast-index-build.py --write",
    ]);
    await w("Canon/people.json", JSON.stringify({
      version: 1,
      cast: {
        vale: {
          name: "Vale", kind: "human", speaks: true, face: { ref: "Canon/characters/Vale/ref.png", gallery: [] },
          voice: { ref: "Production/voice-refs/gone.wav", ref_text: "x", direction: "d", status: "LOCKED" },
        },
      },
    }));
    // A LOCKED voice whose WAV is not on disk is its own finding: the index can say a character is
    // cast while the file the synthesiser needs is missing, and that is the last of the three
    // things a speaking subject owes.
    expect(await missingRefs(root, "s02e01", named)).toEqual([
      "Vale: voice WAV missing at Production/voice-refs/gone.wav (Canon/people.json key vale)",
    ]);
  });

  it("finds a speaking guest's entry under the index's own key, and names the missing cast section", async () => {
    const { root, w } = await show1();
    // "Dock Hand Pim" is how the outline names him and `pim` is how the index files him, which is
    // the third lookup step in cast.ts: once the entry carries a LOCKED voice with its WAV on
    // disk, a guest passes exactly as a recurring character does.
    await w("Episodes/s02e01/outline.md", "## Cast\n- Dock Hand Pim (guest, speaks)\n");
    const index = JSON.parse(await readFile(path.join(root, "Canon/cast.json"), "utf8")) as { cast: Record<string, Record<string, unknown>> };
    index.cast["pim"] = { ...index.cast["pim"], voice: { ref: "Production/voice-refs/pim.wav", ref_text: "x", direction: "d", status: "LOCKED" } };
    await w("Canon/cast.json", JSON.stringify(index));
    await w("Production/voice-refs/pim.wav", "wav");
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

  it("is empty for an outline written from the shipped template, whose ## Cast carries an instruction comment", async () => {
    // The behavioural half of the comment skip. An author who fills in the template's own cast
    // lines and leaves its instruction comment in place — which is the ordinary thing to do, since
    // the comment does not render — must get a clean probe, not a line blaming the instructions for
    // missing the grammar.
    // The whole template shape, not just its cast lines: the instruction comment under the heading
    // *and* the two `### Beat <n>` headings that follow the cast, which are what the next section
    // of this file proves are a boundary rather than cast lines.
    const { root, w } = await show1();
    await w(
      "Episodes/s02e01/outline.md",
      "# s02e01\n\n## Scene synopsis\n<!-- One paragraph. -->\n\n## Cast\n<!-- One line per character and location, as `- <Name> (<tags>)`, tags from: recurring, guest, speaks, location. -->\n- Vale (recurring, speaks)\n- Harbor (location)\n\n### Beat 1 — <title>\n<!-- One beat per heading. -->\n\n### Beat 2 — <title>\n\n## Ending duties\n<!-- How the ending pays its duties. -->\n",
    );
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

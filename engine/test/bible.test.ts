import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BIBLE_FILES, REQUIRED_SECTIONS, headingMatches, missingBibleFiles, missingSections } from "../src/bible.js";

const show = { showName: "Harbor Lights", showSlug: "HarborLights", promptsDir: "prompts", models: { medium: "m", large: "l", writer: "w" }, airMap: {}, output: { nasRoot: "/nas" }, visual: { style: "Canon/visual-style.md", auditLaws: "Canon/visual-audit-laws.md" }, audio: { voiceRegistry: "Canon/voice-registry.md" }, publish: { guide: "Canon/publishing-guide.md" } } as const;

describe("headingMatches", () => {
  it("matches by prefix after normalising case, '&' and punctuation", () => {
    expect(headingMatches("## The rules of the universe (load-bearing — do not contradict)", "The rules of the universe")).toBe(true);
    expect(headingMatches("## Tone & genre", "Tone and genre")).toBe(true);
    expect(headingMatches('## "Present day" baseline', "Present-day baseline")).toBe(true);
    expect(headingMatches("## Endings — the \"so what?\" test", "Endings")).toBe(true);
  });
  it("needs a level-2 heading", () => {
    expect(headingMatches("### Cadence", "Cadence")).toBe(false);
    expect(headingMatches("Cadence", "Cadence")).toBe(false);
  });
  it("does not match a different heading that shares a word", () => {
    expect(headingMatches("## Cast", "Casting")).toBe(false);
  });
  it("matches a longer heading that begins with the required one as whole words", () => {
    // The stated cost of the prefix rule, in the direction that costs something: the rule is what
    // admits "## The rules of the universe (load-bearing — do not contradict)" and "## Endings —
    // the \"so what?\" test", and the price is that a required heading is also carried by an
    // unrelated heading that merely starts with it. "## Beats per minute" carries "Beats", so a
    // file with that heading and no "## Beats" passes the Beats requirement while outline.md and
    // flow-check.md read nothing. REQUIRED_SECTIONS must therefore never require, of one file, a
    // heading that is a whole-word prefix of another heading required of that same file; the test
    // below is what holds that line.
    expect(headingMatches("## Beats per minute", "Beats")).toBe(true);
  });
});

describe("BIBLE_FILES and REQUIRED_SECTIONS", () => {
  it("every required section names a bible file", () => {
    const files = new Set(BIBLE_FILES.map((b) => b.file));
    for (const s of REQUIRED_SECTIONS) expect(files.has(s.file) || s.file === "Canon/season-{season}.md", s.file).toBe(true);
  });
  it("keys are unique and are safe path segments", () => {
    const keys = BIBLE_FILES.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9-]+$/);
  });
  it("requires of one file no heading that is a whole-word prefix of another required of it", () => {
    // Two requirements on one file must not be satisfiable by one heading. `headingMatches("## " +
    // a.heading, b.heading)` is true exactly when b equals a or is a whole-word prefix of it,
    // which is that ambiguity: the file's single "## Beats per minute" would satisfy both "Beats
    // per minute" and "Beats", and whichever prompt wanted the other would read nothing. Checked
    // in both directions by walking every ordered pair, which also refuses a duplicated row.
    for (const a of REQUIRED_SECTIONS) {
      for (const b of REQUIRED_SECTIONS) {
        if (a === b || a.file !== b.file) continue;
        expect(headingMatches(`## ${a.heading}`, b.heading), `${a.file}: "${b.heading}" is carried by "${a.heading}"`).toBe(false);
      }
    }
  });
});

describe("missingBibleFiles / missingSections", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "bible-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("reports every absent and every empty file by path, sorted", async () => {
    await mkdir(path.join(root, "Canon"), { recursive: true });
    await writeFile(path.join(root, "Canon/style-guide.md"), "");
    const missing = await missingBibleFiles(root, show);
    expect(missing).toContain("Canon/style-guide.md (empty)");
    expect(missing).toContain("Canon/world-overview.md");
    expect(missing).toEqual([...missing].sort());
  });
  it("requires the season file of the season it is given, and no other season's", async () => {
    const missing = await missingBibleFiles(root, show, 2);
    expect(missing).toContain("Canon/season-2.md");
    expect(missing).not.toContain("Canon/season-1.md");
  });
  it("requires no season file at all when no season is given", async () => {
    const missing = await missingBibleFiles(root, show);
    expect(missing.filter((m) => m.startsWith("Canon/season-"))).toEqual([]);
  });
  it("reports a file whose required section is absent, naming the reader", async () => {
    await mkdir(path.join(root, "Canon"), { recursive: true });
    await writeFile(path.join(root, "Canon/style-guide.md"), "# Style\n\n## Narration\ntext\n");
    const missing = await missingSections(root, show);
    const cadence = missing.find((m) => m.file === "Canon/style-guide.md" && m.heading === "Cadence");
    expect(cadence).toBeDefined();
    expect(cadence!.readBy).toMatch(/flow-check/);
  });
  it("is silent about an absent file (that is missingBibleFiles' report)", async () => {
    const missing = await missingSections(root, show);
    expect(missing.filter((m) => m.file === "Canon/world-overview.md")).toEqual([]);
  });
});

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

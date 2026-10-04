import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REQUIRED_SECTIONS, bibleFilesFor, loadShowConfig } from "@showrunner/engine";
import { buildShowConfig } from "../src/init/config.js";
import { bibleCheck, main } from "../src/bible-check.js";

/** A show whose bible is complete for the given season: every file `bibleFilesFor` lists, each
 *  carrying every level-2 heading `REQUIRED_SECTIONS` requires of it. Nothing here runs the
 *  interview or the scaffold — the check reads files off disk, so the fixture is files on disk. */
async function completeShow(season = 1): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "showrunner-bible-check-"));
  await writeFile(
    path.join(root, "showrunner.json"),
    JSON.stringify(buildShowConfig({ showName: "Harbor Lights", showSlug: "HarborLights", nasRoot: "/Volumes/media/HarborLights" }, ["Vale"]), null, 2) + "\n",
    "utf8",
  );
  const config = await loadShowConfig(root);
  for (const rel of bibleFilesFor(config, season)) {
    const headings = REQUIRED_SECTIONS
      .filter((s) => s.file.replace("{season}", String(season)) === rel)
      .map((s) => `## ${s.heading}\n\nwritten.\n`);
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), `# ${path.basename(rel)}\n\n${headings.join("\n")}\n`, "utf8");
  }
  return root;
}

function captured(): { io: { out(text: string): void; err(text: string): void }; text: () => string } {
  const lines: string[] = [];
  return {
    io: { out: (text) => { lines.push(text); }, err: (text) => { lines.push(text); } },
    text: () => lines.join(""),
  };
}

describe("bible-check on a complete show", () => {
  it("reports nothing missing and exits 0", async () => {
    const root = await completeShow();
    const result = await bibleCheck(root, 1);
    expect(result.missingFiles).toEqual([]);
    expect(result.missingSections).toEqual([]);
    expect(result.ok).toBe(true);

    const cap = captured();
    expect(await main(["--show", root], cap.io)).toBe(0);
    expect(cap.text()).toMatch(/every bible file/);
  });
});

describe("bible-check on a show with a file missing", () => {
  it("names the file and exits 1", async () => {
    const root = await completeShow();
    await rm(path.join(root, "Canon/timeline.md"));
    const cap = captured();
    expect(await main(["--show", root], cap.io)).toBe(1);
    expect(cap.text()).toContain("Canon/timeline.md");
    expect(cap.text()).not.toContain("Canon/style-guide.md");
  });

  it("names an empty file as empty", async () => {
    const root = await completeShow();
    await writeFile(path.join(root, "Canon/technology.md"), "   \n", "utf8");
    const result = await bibleCheck(root, 1);
    expect(result.missingFiles).toContain("Canon/technology.md (empty)");
    expect(result.ok).toBe(false);
  });
});

describe("bible-check on a show with a section missing", () => {
  it("names the section, the file and the prompt that reads it, and exits 1", async () => {
    const root = await completeShow();
    const file = path.join(root, "Canon/style-guide.md");
    await writeFile(file, "# style-guide.md\n\n## Narration\n\nwritten.\n", "utf8");
    const cap = captured();
    expect(await main(["--show", root], cap.io)).toBe(1);
    expect(cap.text()).toContain("Cadence");
    expect(cap.text()).toContain("flow-check.md");
    expect(cap.text()).not.toContain("## Narration");
  });
});

describe("bible-check's season", () => {
  it("defaults to season 1 and checks the season the operator names", async () => {
    const root = await completeShow(1);
    expect((await bibleCheck(root, 1)).ok).toBe(true);
    const two = await bibleCheck(root, 2);
    expect(two.missingFiles).toContain("Canon/season-2.md");
    const cap = captured();
    expect(await main(["--show", root, "--season", "2"], cap.io)).toBe(1);
    expect(cap.text()).toContain("Canon/season-2.md");
  });
});

describe("bible-check's usage", () => {
  it("exits 64 and prints the usage when --show is absent", async () => {
    const cap = captured();
    expect(await main([], cap.io)).toBe(64);
    expect(cap.text()).toMatch(/usage: bible-check --show/);
  });

  it("exits 64 on an unrecognised argument", async () => {
    const cap = captured();
    expect(await main(["--shoe", "/x"], cap.io)).toBe(64);
    expect(cap.text()).toContain("--shoe");
  });

  it("exits 64 on a season that is not a positive integer", async () => {
    const cap = captured();
    expect(await main(["--show", "/x", "--season", "zero"], cap.io)).toBe(64);
    expect(cap.text()).toContain("--season");
  });
});

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ShowConfig } from "@showrunner/engine";
import { templatesDir } from "../src/init/paths.js";
import {
  gitignoreFor,
  parseCanonTemplate,
  slugOf,
  templateWithoutQuestions,
  writeCastSheets,
  writeScaffold,
} from "../src/init/scaffold.js";

const FIXTURE = fileURLToPath(new URL("fixtures/harbor-check-context.json", import.meta.url));

/** The Harbor Lights config Task 4's render fixture already carries, so the scaffold's tests and
 *  the prompt harness describe the same invented show. */
async function harborConfig(): Promise<ShowConfig> {
  const context = JSON.parse(await readFile(FIXTURE, "utf8")) as { show: ShowConfig };
  return context.show;
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "showrunner-scaffold-"));
}

/** Every file under a directory, as paths relative to it, sorted. */
async function walkRelative(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkRelative(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

const SAMPLE = `# Style guide

> **Status legend.** RULED means approved and binding.

## Narration
<!-- Q: Who is telling this story, and in what tense? -->

## The core technique
Prose that belongs to the template rather than to a question.

## The retention contract
<!-- Q: What must the first minute do to keep a viewer? -->
`;

describe("parseCanonTemplate", () => {
  it("returns the header and one question per heading that has one, skipping a heading with none", () => {
    const parsed = parseCanonTemplate(SAMPLE);
    expect(parsed.header).toBe("# Style guide\n\n> **Status legend.** RULED means approved and binding.\n\n");
    expect(parsed.questions).toEqual([
      { heading: "Narration", question: "Who is telling this story, and in what tense?" },
      { heading: "The retention contract", question: "What must the first minute do to keep a viewer?" },
    ]);
  });

  it("reads a question on a level-1 heading, for a file whose whole body is one question", () => {
    const parsed = parseCanonTemplate("# Visual audit laws\n<!-- Q: List the numbered laws. -->\n");
    expect(parsed.questions).toEqual([{ heading: "Visual audit laws", question: "List the numbered laws." }]);
    expect(parsed.header).toBe("");
  });

  it("returns no questions for a filled default, and its header is everything before the first section", () => {
    const parsed = parseCanonTemplate("# Story craft\n\n> Craft doctrine.\n\n## The causality law\nEvery beat turns.\n");
    expect(parsed.questions).toEqual([]);
    expect(parsed.header).toBe("# Story craft\n\n> Craft doctrine.\n\n");
  });
});

describe("templateWithoutQuestions", () => {
  it("strips every Q comment and nothing else", () => {
    const stripped = templateWithoutQuestions(SAMPLE);
    expect(stripped).not.toContain("<!-- Q:");
    expect(stripped).toContain("# Style guide");
    expect(stripped).toContain("## Narration");
    expect(stripped).toContain("## The retention contract");
    expect(stripped).toContain("Prose that belongs to the template rather than to a question.");
  });

  it("leaves a comment that is not a question alone", () => {
    const text = "## Cast\n<!-- Q: Who recurs? -->\n<!-- One line per character. -->\n";
    expect(templateWithoutQuestions(text)).toBe("## Cast\n<!-- One line per character. -->\n");
  });
});

describe("gitignoreFor", () => {
  it("derives every line from the config's own directory keys", async () => {
    const config = { ...(await harborConfig()), productionDir: "Out" };
    config.visual = { ...config.visual, candidatesDir: "Canon/_cands" };
    const lines = gitignoreFor(config).split("\n").filter((l) => l !== "");
    expect(lines).toEqual([
      ".DS_Store",
      "Out/*/audio/",
      "Out/*/video/",
      "Out/*/images/*.png",
      "Out/*/images/*.jpg",
      "Out/*/images/.*.bak",
      "Canon/_cands/",
      "Finalized",
      "Finalized/",
      ".superpowers/",
    ]);
  });

  it("falls back to the engine's own defaults when the config omits the keys", async () => {
    const config = await harborConfig();
    delete config.productionDir;
    delete config.visual;
    const lines = gitignoreFor(config).split("\n");
    expect(lines).toContain("Production/*/audio/");
    expect(lines).toContain("Canon/_candidates/");
  });
});

describe("slugOf", () => {
  it("lowercases a name and hyphenates what is not alphanumeric", () => {
    expect(slugOf("The Warden")).toBe("the-warden");
    expect(slugOf("Vale")).toBe("vale");
    expect(slugOf("Pim O'Dell")).toBe("pim-o-dell");
  });

  it("refuses a name with no alphanumeric character in it", () => {
    expect(() => slugOf("—")).toThrow(/slug/i);
  });
});

describe("writeCastSheets", () => {
  it("writes one sheet per cast entry, named by the entry and carrying its one-liner", async () => {
    const root = await tempRoot();
    try {
      const config = await harborConfig();
      const written = await writeCastSheets(root, config, [
        { name: "Vale", line: "The keeper." },
        { name: "The Warden", line: "Whoever has been tending the light." },
      ]);
      expect(written).toEqual(["Canon/characters/The Warden/the-warden.md", "Canon/characters/Vale/vale.md"]);
      const vale = await readFile(path.join(root, "Canon/characters/Vale/vale.md"), "utf8");
      expect(vale.startsWith("# Vale\n\nThe keeper.\n")).toBe(true);
      expect(vale).toContain("## Physical description");
      expect(vale).not.toContain("[Character Name]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a cast name that could escape Canon/characters/, before it writes anything", async () => {
    const root = await tempRoot();
    try {
      const config = await harborConfig();
      await expect(
        writeCastSheets(root, config, [
          { name: "Vale", line: "The keeper." },
          { name: "../pwn", line: "Not a character." },
        ]),
      ).rejects.toThrow(/\.\.\/pwn/);
      // The whole call is refused, so the good name before the bad one wrote nothing either.
      await expect(readFile(path.join(root, "Canon/characters/Vale/vale.md"), "utf8")).rejects.toThrow(/ENOENT/);
      await expect(readdir(path.join(root, "Canon")), "nothing under Canon/ at all").rejects.toThrow(/ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a name that would traverse out of the show root entirely", async () => {
    const root = await tempRoot();
    try {
      const config = await harborConfig();
      const escape = "../../../../../../tmp/showrunner-scaffold-escape/pwn";
      await expect(writeCastSheets(root, config, [{ name: escape, line: "hi" }])).rejects.toThrow(/not a usable directory name/);
      await expect(readdir("/tmp/showrunner-scaffold-escape")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a name with an apostrophe and a hyphen", async () => {
    const root = await tempRoot();
    try {
      const config = await harborConfig();
      const written = await writeCastSheets(root, config, [{ name: "O'Brien-Vale", line: "The relief keeper." }]);
      expect(written).toEqual(["Canon/characters/O'Brien-Vale/o-brien-vale.md"]);
      expect(await readFile(path.join(root, "Canon/characters/O'Brien-Vale/o-brien-vale.md"), "utf8")).toContain("# O'Brien-Vale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a sheet that exists", async () => {
    const root = await tempRoot();
    try {
      const config = await harborConfig();
      await writeCastSheets(root, config, [{ name: "Vale", line: "The keeper." }]);
      await expect(writeCastSheets(root, config, [{ name: "Vale", line: "Someone else." }])).rejects.toThrow(/EEXIST/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("writeScaffold", () => {
  it("writes the whole scaffold and returns the relative paths, sorted", async () => {
    const root = await tempRoot();
    try {
      const config = await harborConfig();
      const written = await writeScaffold(root, config, [{ name: "Vale", line: "The keeper." }]);
      expect(written).toEqual([...written].sort());

      // The cast sheet, from the entity template.
      const vale = await readFile(path.join(root, "Canon/characters/Vale/vale.md"), "utf8");
      expect(vale).toContain("# Vale");
      expect(vale).toContain("The keeper.");

      // Every prompt template is copied, whichever task wrote it.
      const prompts = await walkRelative(path.join(templatesDir(), "prompts"));
      expect(prompts.length).toBeGreaterThan(0);
      for (const name of prompts) expect(written).toContain(`prompts/${name}`);
      expect(await readFile(path.join(root, "prompts/README.md"), "utf8")).toContain("## Cast");

      // The show's README, rendered.
      const readme = await readFile(path.join(root, "README.md"), "utf8");
      expect(readme).toContain("Harbor Lights");
      expect(readme).toContain("HarborLights");
      expect(readme).not.toContain("{{");

      // The derived .gitignore.
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toContain("Production/*/audio/");

      // The two reference indices.
      const refs = JSON.parse(await readFile(path.join(root, "Canon/refs.json"), "utf8")) as Record<string, unknown>;
      expect(typeof refs["_doc"]).toBe("string");
      const voices = JSON.parse(await readFile(path.join(root, "Production/voice-refs/refs.json"), "utf8")) as Record<string, unknown>;
      expect(voices["cast"]).toEqual({});

      // The four entity templates and the outline template, under the names the prompts name.
      for (const rel of [
        "Canon/characters/_TEMPLATE.md",
        "Canon/species/_TEMPLATE.md",
        "Canon/locations/_TEMPLATE.md",
        "Canon/factions/_TEMPLATE.md",
        "Episodes/_TEMPLATE/outline.md",
      ]) expect(written).toContain(rel);
      expect(await readFile(path.join(root, "Episodes/_TEMPLATE/outline.md"), "utf8")).toContain("## Scene synopsis");

      // The two scaffold bible files, with their questions stripped and their headings present.
      const ledger = await readFile(path.join(root, "Canon/continuity-ledger.md"), "utf8");
      expect(ledger).toContain("## Open threads");
      expect(ledger).toContain("## Episode log");
      expect(ledger).not.toContain("<!-- Q:");
      const voiceRegistry = await readFile(path.join(root, "Canon/voice-registry.md"), "utf8");
      expect(voiceRegistry).toContain("Production/voice-refs/refs.json");
      expect(voiceRegistry).toContain("## Locked");

      // No interviewed bible file is written here: the interview writes those.
      await expect(readFile(path.join(root, "Canon/world-overview.md"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never overwrites: a second call against the same root rejects with EEXIST", async () => {
    const root = await tempRoot();
    try {
      const config = await harborConfig();
      await writeScaffold(root, config, [{ name: "Vale", line: "The keeper." }]);
      await expect(writeScaffold(root, config, [{ name: "Vale", line: "The keeper." }])).rejects.toThrow(/EEXIST/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves an author's own file untouched rather than writing over it", async () => {
    const root = await tempRoot();
    try {
      const config = await harborConfig();
      await writeFile(path.join(root, ".gitignore"), "mine\n", "utf8");
      await expect(writeScaffold(root, config, [])).rejects.toThrow(/EEXIST/);
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("mine\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honours the config's directory keys", async () => {
    const root = await tempRoot();
    try {
      const config = { ...(await harborConfig()), canonDir: "Bible", episodesDir: "Eps", productionDir: "Out", promptsDir: "agents" };
      const written = await writeScaffold(root, config, [{ name: "Vale", line: "The keeper." }]);
      expect(written).toContain("Bible/characters/Vale/vale.md");
      expect(written).toContain("Eps/_TEMPLATE/outline.md");
      expect(written).toContain("Out/voice-refs/refs.json");
      expect(written).toContain("agents/README.md");
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toContain("Out/*/audio/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the canon templates", () => {
  it("every BIBLE_FILES key has a template, and every interviewed file asks at least one question", async () => {
    const { BIBLE_FILES } = await import("@showrunner/engine");
    const canon = path.join(templatesDir(), "canon");
    for (const entry of BIBLE_FILES) {
      const text = await readFile(path.join(canon, `${entry.key}.md`), "utf8");
      const parsed = parseCanonTemplate(text);
      if (entry.mode === "interview") expect(parsed.questions.length, entry.key).toBeGreaterThan(0);
      else expect(parsed.questions, entry.key).toEqual([]);
    }
  });
});

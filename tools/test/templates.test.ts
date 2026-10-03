import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { renderPrompt, TemplateError, REQUIRED_SECTIONS, BIBLE_FILES, headingMatches } from "@showrunner/engine";
import { templatesDir } from "../src/init/paths.js";

const PROMPTS = path.join(templatesDir(), "prompts");
const CANON = path.join(templatesDir(), "canon");
const INTERVIEW = path.join(templatesDir(), "interview");

async function mdFiles(dir: string): Promise<string[]> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".md") && n !== "README.md").sort();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p))); else out.push(p);
  }
  return out;
}

describe("prompt templates render against the invented show", () => {
  it("every prompt renders with no hole, given the Harbor Lights context", async () => {
    const context = JSON.parse(await readFile(path.join(__dirname, "fixtures/harbor-check-context.json"), "utf8"));
    const ctx = { episodeId: context.episodeId, runId: context.runId, showRoot: context.showRoot, results: context.results };
    const failures: string[] = [];
    for (const name of await mdFiles(PROMPTS)) {
      const text = await readFile(path.join(PROMPTS, name), "utf8");
      const isReject = name.endsWith(".reject.md");
      const results = isReject ? { ...context.results, [`${name.replace(/\.reject\.md$/, "")}:rejection`]: "notes" } : context.results;
      try { renderPrompt(text, { ...ctx, results }, { season: context.season, show: context.show }); }
      catch (err) { failures.push(`${name}: ${err instanceof TemplateError ? err.message : String(err)}`); }
    }
    expect(failures).toEqual([]);
  });
  it("every prompt that is not a gate message opens with the role line", async () => {
    const bad: string[] = [];
    for (const name of await mdFiles(PROMPTS)) {
      if (name.endsWith(".gate.md")) continue;
      const first = (await readFile(path.join(PROMPTS, name), "utf8")).split("\n")[0] ?? "";
      if (!/^You are the .+ for \*\{\{show\.showName\}\}\*\./.test(first)) bad.push(`${name}: ${first}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("templates carry no history and no show", () => {
  it("no production id, no 2026 date, no 'Ryan', no 'ruled' anywhere under tools/templates", async () => {
    const hits: string[] = [];
    for (const f of await walk(templatesDir())) {
      const text = await readFile(f, "utf8");
      text.split("\n").forEach((line, i) => {
        if (/\bep\d\d\b/.test(line) || /\b2026-/.test(line) || /\bRyan\b/.test(line) || /\bruled\b/i.test(line)) hits.push(`${path.relative(templatesDir(), f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("the canon templates carry every required section, and the prompts read nothing else by name", () => {
  it("each REQUIRED_SECTIONS row has its heading in the canon template for that file", async () => {
    const missing: string[] = [];
    for (const s of REQUIRED_SECTIONS) {
      const key = s.file === "Canon/season-{season}.md" ? "season-1" : BIBLE_FILES.find((b) => b.file === s.file)?.key;
      if (!key) { missing.push(`${s.file}: no BIBLE_FILES entry`); continue; }
      let text: string;
      try { text = await readFile(path.join(CANON, `${key}.md`), "utf8"); } catch { continue; } // Task 5 adds the files
      if (!text.split("\n").some((l) => headingMatches(l, s.heading))) missing.push(`${key}.md lacks ## ${s.heading}`);
    }
    expect(missing).toEqual([]);
  });
  it("every `Canon/<file>` a prompt template names is a bible file or an entity directory", async () => {
    const known = new Set(BIBLE_FILES.map((b) => b.file));
    const bad: string[] = [];
    for (const name of await mdFiles(PROMPTS)) {
      const text = await readFile(path.join(PROMPTS, name), "utf8");
      for (const m of text.matchAll(/`Canon\/([^`\s]+)`/g)) {
        const rel = `Canon/${m[1]}`;
        if (known.has(rel) || /^Canon\/(characters|species|locations|factions)\//.test(rel) || rel === "Canon/refs.json" || /^Canon\/season-\{\{season\}\}\.md$/.test(rel)) continue;
        bad.push(`${name}: ${rel}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("the interview prompts render with vars", () => {
  it("write.md, gate.md and revise.md render given the vars the pipeline passes", async () => {
    const vars = { file: "Canon/style-guide.md", key: "style-guide", purpose: "p", answersPath: "Production/setup/style-guide/answers.md", templatePath: "/engine/tools/templates/canon/style-guide.md", date: "2026-01-01".replace("2026", "2030") };
    const ctx = { episodeId: "setup", runId: "r", showRoot: "/show", results: { "gate:rejection": "notes" } };
    for (const name of await mdFiles(INTERVIEW)) {
      const text = await readFile(path.join(INTERVIEW, name), "utf8");
      expect(() => renderPrompt(text, ctx, { vars, show: { showName: "Harbor Lights" } }), name).not.toThrow();
    }
  });
});

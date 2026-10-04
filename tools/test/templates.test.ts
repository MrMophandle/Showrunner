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

/** The shapes a history stamp took in the measured prompts and bible files: a production id, a
 *  dated note, the first show's author by name, and a ruling — a ruling written either as a
 *  hyphenated attribution ("Ryan-ruled", "showrunner-ruled") or as the word followed by the date
 *  it was made ("ruled 2026-09-09", "ruled on 3 October"). The ruling patterns are deliberately
 *  narrower than the bare word: `RULED` is the status vocabulary every interviewed bible template
 *  carries in its header ("RULED means approved and binding. DRAFT means proposed at the
 *  interview, pending an episode." — the plan's F-08), so refusing the bare word would refuse the
 *  legend the plan requires. A stamp is a ruling with a date or an author attached to it, and
 *  that is what these two patterns match. */
const HISTORY_STAMPS: readonly RegExp[] = [/\bep\d\d\b/, /\b2026-/, /\bRyan\b/, /\b\w+-ruled\b/i, /\bruled\s+(on\s+)?\d/i];

/** The first show's cosmology words — the thing its characters are afraid of, and the species tier
 *  its entity template offered as an example. Neither is a name, which is why the repository-wide
 *  show-name grep in `README.md` does not list them and why they survived into the templates: the
 *  four entity `_TEMPLATE.md` files were derived from that show's, and one of them asked a new
 *  author what their species believes about a cosmology their universe does not have. A template
 *  may ask about "the central mystery"; it may not name whose.
 *
 *  Deliberately only these two. The first show's proper nouns — its characters, its ship, its
 *  peoples — are the repository-wide grep's job, and that grep searches `tools/` including this
 *  file, so listing them here as regex alternatives would make the grep report itself and the
 *  plan's "no show's name in the engine" constraint could never go green again. The two lists are
 *  complementary by construction: this scan holds what the grep cannot express, and nothing else. */
const SHOW_CONCEPTS = /\b(vanished|dark[- ]forest)\b/i;

describe("templates carry no history and no show", () => {
  it("no production id, no 2026 date, no 'Ryan', no dated or attributed ruling anywhere under tools/templates", async () => {
    const hits: string[] = [];
    for (const f of await walk(templatesDir())) {
      const text = await readFile(f, "utf8");
      text.split("\n").forEach((line, i) => {
        if (HISTORY_STAMPS.some((re) => re.test(line))) hits.push(`${path.relative(templatesDir(), f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("no first-show cosmology or world word anywhere under tools/templates", async () => {
    const hits: string[] = [];
    for (const f of await walk(templatesDir())) {
      const text = await readFile(f, "utf8");
      text.split("\n").forEach((line, i) => {
        if (SHOW_CONCEPTS.test(line)) hits.push(`${path.relative(templatesDir(), f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

/** A backticked level-2 heading as a prompt writes it: `` `## Cadence` ``. */
const CITED_HEADING = /`##\s+([^`]+)`/g;

/** A section citation in the house form -- one or more backticked `## <Heading>` spans, optionally
 *  followed by "section"/"sections", then "of" and the file, which may be backticked or bare:
 *  `` `## Narration` and `## Cadence` of `Canon/style-guide.md` ``. A line break may fall anywhere
 *  inside one, because these prompts are hard-wrapped. */
const CITATION = /((?:`##\s+[^`]+`(?:,\s*|\s+and\s+)?)+)\s*(?:sections?\s+)?of\s+`?(Canon\/[A-Za-z0-9_.{}-]+\.md)`?/g;

/** True for a script's OWN scene header rather than a bible section: the draft prompt writes those
 *  upper case (`## COLD OPEN`, `## SCENE TWO — <name>`, `## SCENE`) and every bible heading is
 *  sentence case, so case alone separates the two. Placeholders are dropped before the test. */
const isScriptHeading = (heading: string): boolean => {
  const bare = heading.replace(/<[^>]*>/g, "");
  return bare === bare.toUpperCase();
};

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
  it("every bible section a prompt template cites is a REQUIRED_SECTIONS row", async () => {
    // The guard the whole named-section design rests on. A prompt that cites `## X` of a bible
    // file reads that section by name, and `bible-check` refuses a show whose file lacks a
    // REQUIRED_SECTIONS heading -- so a citation that names no row is a silent partial read
    // waiting to happen, and a bible heading renamed out from under a citation must break a test
    // rather than a run. Two assertions, because prompts cite in more than one shape: the
    // heading-only one holds for every form (a dash list, a parenthetical), and the pair one adds
    // the file wherever the citation states it.
    const required = (file: string | undefined, heading: string): boolean =>
      REQUIRED_SECTIONS.some((r) => (file === undefined || r.file === file.replace("season-{{season}}", "season-{season}")) && headingMatches(`## ${heading}`, r.heading));
    const bad: string[] = [];
    for (const name of await mdFiles(PROMPTS)) {
      const text = await readFile(path.join(PROMPTS, name), "utf8");
      for (const m of text.matchAll(CITED_HEADING)) {
        const heading = m[1]!.trim();
        if (isScriptHeading(heading)) continue;
        if (!required(undefined, heading)) bad.push(`${name}: \`## ${heading}\` is no REQUIRED_SECTIONS heading`);
      }
      for (const m of text.matchAll(CITATION)) {
        for (const h of m[1]!.matchAll(CITED_HEADING)) {
          const heading = h[1]!.trim();
          if (!required(m[2]!, heading)) bad.push(`${name}: \`## ${heading}\` of ${m[2]} is no REQUIRED_SECTIONS row`);
        }
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

import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { renderPrompt, TemplateError, REQUIRED_SECTIONS, BIBLE_FILES, headingMatches, parseCastSection } from "@showrunner/engine";
import { templatesDir } from "../src/init/paths.js";

const PROMPTS = path.join(templatesDir(), "prompts");
const CANON = path.join(templatesDir(), "canon");
const INTERVIEW = path.join(templatesDir(), "interview");
/** The outline format `init` copies into a new show, and the only document besides the bible whose
 *  sections the prompts read by name. */
const OUTLINE_TEMPLATE = path.join(templatesDir(), "episodes", "_TEMPLATE", "outline.md");

async function mdFiles(dir: string): Promise<string[]> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".md") && n !== "README.md").sort();
}

/** Every `.md` in `dir` including its README, which `mdFiles` leaves out. `prompts/README.md`
 *  documents the two machine-read conventions and cites the outline's `## Cast` section by name,
 *  so the structural check below has to read it. */
async function allMdFiles(dir: string): Promise<string[]> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".md")).sort();
}

/** Every level-2 heading of a Markdown document, as its text without the `##`. */
function headingsOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m !== null) out.push(m[1] as string);
  }
  return out;
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
  it("tts-script.md names the show's own audio.guestRefsDir and no longer builds that path itself", async () => {
    // H-19. The guest-reference directory is a config key (`engine/src/show-config.ts:88`) and this
    // was the one prompt line that spelled it out as `<productionDir>/<episodeId>/guest-refs`, so a
    // show that configured the key anywhere else was told to look in a directory the probe does not
    // read. The key's value carries a literal `{episodeId}` on purpose — it is the one show path
    // that is per-episode — and `renderPrompt` substitutes a `{{show.<path>}}` verbatim and leaves
    // single braces alone, so the prompt has to say what the token stands for. That sentence is
    // what this test pins: the key renders, and the token is explained beside it.
    const context = JSON.parse(await readFile(path.join(__dirname, "fixtures/harbor-check-context.json"), "utf8"));
    const text = await readFile(path.join(PROMPTS, "tts-script.md"), "utf8");
    expect(text).toContain("{{show.audio.guestRefsDir}}");
    const rendered = renderPrompt(
      text,
      { episodeId: context.episodeId, runId: context.runId, showRoot: context.showRoot, results: context.results },
      { season: context.season, show: context.show },
    );
    const configured = context.show.audio.guestRefsDir as string;
    expect(configured).toContain("{episodeId}");
    expect(rendered).toContain(`${configured}/<guest-slug>*.wav`);
    expect(rendered).toContain(`\`{episodeId}\`\n     stands for ${context.episodeId}`);
    // And the literal the line used to build is gone from the rendered prompt entirely.
    expect(rendered).not.toContain(`${context.show.productionDir}/${context.episodeId}/guest-refs`);
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

describe("every interviewed bible template carries the status legend", () => {
  it("names RULED and DRAFT, because every law the interview writes is stamped DRAFT", async () => {
    // The plan's F-08: approval at a gate does not promote a DRAFT to RULED, an episode or the
    // author's hand does, so the file has to say what the two words mean. One template carried a
    // question and no legend until this test existed.
    const missing: string[] = [];
    for (const entry of BIBLE_FILES.filter((b) => b.mode === "interview")) {
      const text = await readFile(path.join(CANON, `${entry.key}.md`), "utf8");
      if (!/RULED means approved and binding/.test(text) || !/DRAFT means proposed/.test(text)) missing.push(entry.key);
    }
    expect(missing).toEqual([]);
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
    // A prompt cites the outline's own sections as well as the bible's, and a citation that names
    // no file could be either. The outline template's headings are the second closed set the
    // heading-only form is allowed to name; the next describe is what holds that set honest.
    const outlineHeadings = headingsOf(await readFile(OUTLINE_TEMPLATE, "utf8"));
    const inOutline = (heading: string): boolean => outlineHeadings.some((h) => headingMatches(`## ${heading}`, h));
    const bad: string[] = [];
    for (const name of await mdFiles(PROMPTS)) {
      const text = await readFile(path.join(PROMPTS, name), "utf8");
      for (const m of text.matchAll(CITED_HEADING)) {
        const heading = m[1]!.trim();
        if (isScriptHeading(heading)) continue;
        if (!required(undefined, heading) && !inOutline(heading)) {
          bad.push(`${name}: \`## ${heading}\` is neither a REQUIRED_SECTIONS heading nor a heading of ${path.basename(OUTLINE_TEMPLATE)}`);
        }
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

/** A level-2 heading as a prompt quotes it rather than backticks it: `"## Cast"`. Both forms are
 *  read, because the measured prompts used both; `[^"\n]` keeps a quotation from running across a
 *  hard wrap and swallowing half a paragraph. */
const QUOTED_HEADING = /"##\s+([^"\n]+)"/g;

/** The beat-heading grammar the draft loop counts, copied from `engine/src/pipelines/episode.ts`'s
 *  own `progress` function: `total` is the number of lines of the outline matching it. An outline
 *  with no such heading makes every iteration of the draft loop report `done/0`, which is the
 *  blind loop the spec's §6.7 exists to prevent. */
const BEAT_HEADING = /^### Beat \d+/;

describe("the outline template carries every section the prompts name", () => {
  /** Why this exists. Three findings of the whole-branch review — an exemplar naming eight
   *  sections the template did not have, three prompts reading a `## Threads opened` section the
   *  template did not have, and an `## Ending duties` comment naming three duties where five are
   *  enforced — all survived ten task reviews because nothing bound the outline template to the
   *  prompts that read it. The bible has that binding (`REQUIRED_SECTIONS` and the guard above);
   *  the outline is the other document whose sections a prompt reads by name, and this is its. */
  it("every section a prompt names that is not a bible section is a heading of the outline template", async () => {
    const outlineHeadings = headingsOf(await readFile(OUTLINE_TEMPLATE, "utf8"));
    expect(outlineHeadings.length).toBeGreaterThan(0);
    const isBibleSection = (heading: string): boolean =>
      REQUIRED_SECTIONS.some((r) => headingMatches(`## ${heading}`, r.heading));
    const inOutline = (heading: string): boolean =>
      outlineHeadings.some((h) => headingMatches(`## ${heading}`, h));

    const bad: string[] = [];
    for (const name of await allMdFiles(PROMPTS)) {
      const text = await readFile(path.join(PROMPTS, name), "utf8");
      for (const re of [CITED_HEADING, QUOTED_HEADING]) {
        for (const m of text.matchAll(re)) {
          const heading = m[1]!.trim();
          // A script's own scene headers are upper case and belong to no template.
          if (isScriptHeading(heading)) continue;
          if (isBibleSection(heading) || inOutline(heading)) continue;
          bad.push(`${name}: \`## ${heading}\` is a section of no template this engine ships`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the outline template carries the `### Beat <n>` headings the draft loop counts, and the outline prompt states the grammar", async () => {
    const template = await readFile(OUTLINE_TEMPLATE, "utf8");
    const beats = template.split("\n").filter((l) => BEAT_HEADING.test(l));
    // Two, so the template demonstrates the numbering and the draft loop's `total` is never zero
    // for an outline written from it.
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.map((l) => /^### Beat (\d+)/.exec(l)?.[1])).toEqual(beats.map((_, i) => String(i + 1)));
    // And the prompt that writes outlines says so, which is the half that was missing: nothing
    // told the agent to write a heading the engine counts.
    const prompt = await readFile(path.join(PROMPTS, "outline.md"), "utf8");
    expect(prompt).toContain("### Beat <n>");
  });

  it("the outline template's own `## Cast` section parses, so the engine never refuses the template it ships", async () => {
    // The engine's own template, through the engine's own parser. `engine/test/needs.test.ts` proves
    // the comment-skip against a string in the *shape* of this template's comment; this is the half
    // that reads the real file, and it lives here because this is the suite that walks
    // `tools/templates/`. The fault it guards against is the one that was shipped: the template
    // writes the section's instructions as a one-line HTML comment, `parseCastSection` reported that
    // line as missing the grammar, and `missingRefs` turned the template's own instructions into a
    // NEEDS_REFS stop. Wrapping that comment across two lines — a reflow nobody would think twice
    // about — brings the fault straight back, and would otherwise be caught by nothing until an
    // author's first episode stopped on it.
    const { entries, malformed } = parseCastSection(await readFile(OUTLINE_TEMPLATE, "utf8"));
    expect(malformed).toEqual([]);
    // The two example subjects the template demonstrates the grammar with, and their tags, so the
    // empty `malformed` above cannot be the emptiness of a section this parser never found.
    expect(entries).toEqual([
      { name: "Vale", tags: ["recurring", "speaks"] },
      { name: "Harbor", tags: ["location"] },
    ]);
  });

  it("no outline heading is also a bible section, so a fileless citation cannot be misfiled", async () => {
    // The two closed sets the assertion above takes the union of. If a bible section and an
    // outline section ever came to share a name, a citation aimed at the wrong document would
    // pass that union silently, so the collision is refused rather than its symptom.
    const outlineHeadings = headingsOf(await readFile(OUTLINE_TEMPLATE, "utf8"));
    const collisions: string[] = [];
    for (const h of outlineHeadings) {
      for (const r of REQUIRED_SECTIONS) {
        if (headingMatches(`## ${h}`, r.heading) || headingMatches(`## ${r.heading}`, h)) {
          collisions.push(`outline's ## ${h} collides with ${r.file}'s ## ${r.heading}`);
        }
      }
    }
    expect(collisions).toEqual([]);
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

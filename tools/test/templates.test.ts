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
    // The review round's two variables ride in the extra beside the show config, because they come
    // from the run's `panel_round` event and not from any step's result. Asserted present rather
    // than passed blindly: `{{prior.<id>}}` renders the word `none` for a step the object does not
    // carry, so a fixture that quietly lost its `prior` would render every reviewer and check
    // nothing. `{{round.*}}` has no such mercy — it is a hole by name, which the gate's message
    // would report.
    expect(Object.keys(context.prior)).toContain("tone-check");
    expect(context.round).toEqual({ n: 2, costUsd: 12.3456 });
    const round = { prior: context.prior, round: context.round };
    const failures: string[] = [];
    for (const name of await mdFiles(PROMPTS)) {
      const text = await readFile(path.join(PROMPTS, name), "utf8");
      const isReject = name.endsWith(".reject.md");
      const results = isReject ? { ...context.results, [`${name.replace(/\.reject\.md$/, "")}:rejection`]: "notes" } : context.results;
      try { renderPrompt(text, { ...ctx, results }, { season: context.season, show: context.show, ...round }); }
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

/** The six craft reviewers, whose prompts and schemas are one form. `canon-review-script` is not
 *  among them because it is the form's source rather than a copy of it: its pass rule was already
 *  mechanical, its non-failing field is `deviations`, and its issues are strings, so the six are
 *  what this plan changed and the seventh is what they were changed to resemble. */
const CRAFT_REVIEWERS = ["character-check", "environment-check", "flow-check", "repetition-check", "structure-check", "tone-check"] as const;

/** Every reviewer the panel reads a verdict from: the six plus the canon review. Each renders its
 *  own prior verdict, and the writer renders all seven. */
const PANEL = [...CRAFT_REVIEWERS, "canon-review-script"] as const;

async function promptText(name: string): Promise<string> {
  return await readFile(path.join(PROMPTS, `${name}.md`), "utf8");
}

/** A prompt's text with every run of whitespace collapsed to one space, so a sentence can be
 *  asserted whole. These prompts are hard-wrapped and reflowed by hand whenever a line grows, and a
 *  rule that moved across a line break is still the rule — a test that read the raw text would turn
 *  every rewrap into a failure and teach the next editor to pad the line instead. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

describe("the panel's reviewers pass only on an empty issue list and judge their own prior issues", () => {
  /** Why these assertions exist. The script gate now opens only on a green panel, so a reviewer's
   *  pass rule is what decides whether a run ever ends. Six of the seven used to read "pass only
   *  if the episode lands" and the like — a judgment about the whole draft, which a reviewer may
   *  reach differently on identical text — and a loop with no round cap built on that cannot be
   *  argued to terminate. The rules below are the convergence argument, written where the model
   *  reads them. */
  it("each of the six states the mechanical pass rule, the citation format and the non-failing field", async () => {
    const missing: string[] = [];
    for (const id of CRAFT_REVIEWERS) {
      const text = flat(await promptText(id));
      if (!text.includes("`pass` is true only when `issues` is empty")) missing.push(`${id}.md: the pass rule`);
      if (!text.includes("`<law file>:<section or line>`")) missing.push(`${id}.md: the citation format`);
      if (!text.includes("put it in `notes`, which never fails the review")) missing.push(`${id}.md: the non-failing field`);
      // The issue is an object now, and the script line is one of its fields: an issue that cannot
      // say where it is cannot be judged resolved next round.
      if (!text.includes("`line` — where the defect is in the script")) missing.push(`${id}.md: the script line`);
      // And the old rule is gone rather than merely outvoted by the new one.
      if (/\bpass only if\b/i.test(text)) missing.push(`${id}.md: a judgment pass rule survives`);
    }
    expect(missing).toEqual([]);
  });

  it("each panel member renders its own prior verdict and no one else's", async () => {
    const bad: string[] = [];
    for (const id of PANEL) {
      const text = await promptText(id);
      if (!text.includes("## Your prior verdict")) bad.push(`${id}.md: no prior-verdict section`);
      if (!text.includes(`{{prior.${id}}}`)) bad.push(`${id}.md: does not render {{prior.${id}}}`);
      // A reviewer judges its own issues and nobody else's — that is what keeps the issue set
      // shrinking — so a copy-paste that left another reviewer's id in place is a defect.
      for (const other of PANEL) {
        if (other !== id && text.includes(`{{prior.${other}}}`)) bad.push(`${id}.md: renders ${other}'s prior verdict`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("each of the six carries the round-2 rule and accounts for every prior issue by id", async () => {
    const missing: string[] = [];
    for (const id of CRAFT_REVIEWERS) {
      const text = flat(await promptText(id));
      if (!text.includes("From round 2 on you may block on two kinds of issue and no others")) missing.push(`${id}.md: the round-2 rule`);
      if (!text.includes("One of your own prior issues you judge unresolved")) missing.push(`${id}.md: the unresolved-prior arm`);
      if (!text.includes("A regression — a new defect in text the revision changed")) missing.push(`${id}.md: the regression arm`);
      if (!text.includes("Account for every prior issue by its id in `prior`")) missing.push(`${id}.md: the prior accounting`);
      // The two headings of the writer's round report, which is where a reviewer learns what the
      // revision touched and which of its issues the writer declined on purpose.
      if (!text.includes("## Changed")) missing.push(`${id}.md: does not name the changed-scenes heading`);
      if (!text.includes("## Deliberate exceptions")) missing.push(`${id}.md: does not name the exceptions heading`);
      if (!text.includes("Reuse the id the previous round gave the same finding")) missing.push(`${id}.md: the stable id`);
    }
    expect(missing).toEqual([]);
  });

  it("the licensing clause is named and never addressed, because the line belongs to a show", async () => {
    // A template may not cite the line a particular show's style guide happens to write the
    // judgment clause on — and this engine's own `canon/style-guide.md` template has no such
    // section at all. The prompts name the clause by what it licenses and leave the writer to cite
    // the file and the line of the guide the show actually has.
    const bad: string[] = [];
    for (const id of CRAFT_REVIEWERS) {
      const text = flat(await promptText(id));
      if (!text.includes("licenses a knowing exception")) bad.push(`${id}.md: the clause is not named`);
      if (/Canon\/style-guide\.md:\d/.test(text)) bad.push(`${id}.md: cites a line number of a show's own guide`);
    }
    expect(bad).toEqual([]);
  });

  it("the six schemas are one form: ids on the issues, notes beside them, the prior accounted for", async () => {
    interface ReviewerSchema {
      properties: Record<string, { properties?: Record<string, unknown>; items?: { properties?: Record<string, unknown>; required?: string[] } }>;
      required: string[];
    }
    const shapes: Record<string, unknown> = {};
    for (const id of CRAFT_REVIEWERS) {
      const schema = JSON.parse(await readFile(path.join(PROMPTS, `${id}.schema.json`), "utf8")) as ReviewerSchema;
      const issues = schema.properties["issues"];
      shapes[id] = {
        properties: Object.keys(schema.properties).sort(),
        required: [...schema.required].sort(),
        issue: Object.keys(issues?.items?.properties ?? {}).sort(),
        issueRequired: [...(issues?.items?.required ?? [])].sort(),
        prior: Object.keys(schema.properties["prior"]?.properties ?? {}).sort(),
      };
    }
    // One shape, six files. They are separate files and not one shared schema because a show's
    // copy of each is its own to tune, which is also why a drift between them has to be a test.
    const form = {
      properties: ["issues", "notes", "pass", "prior", "verdict"],
      required: ["issues", "notes", "pass", "prior", "verdict"],
      issue: ["id", "law", "line", "text"],
      issueRequired: ["id", "law", "line", "text"],
      prior: ["resolved", "unresolved"],
    };
    expect(shapes).toEqual(Object.fromEntries(CRAFT_REVIEWERS.map((id) => [id, form])));
  });

  it("the canon review keeps its own schema, which is the one the six were modelled on", async () => {
    // Its non-failing field is `deviations` and its pass rule was already "`pass` is true only
    // when `issues` is empty", so the plan changed its prompt (it reads its prior verdict now) and
    // deliberately not its schema.
    const schema = JSON.parse(await readFile(path.join(PROMPTS, "canon-review.schema.json"), "utf8")) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["deviations", "issues", "pass", "verdict"]);
    expect([...schema.required].sort()).toEqual(["deviations", "issues", "pass", "verdict"]);
  });
});

describe("the writer is told the precedence and reports its round", () => {
  it("revise.md reads all seven verdicts as priors and never as step results", async () => {
    // The round's order is hand-edits-script → revise → the reviewers → panel, so the revision
    // runs *after* the reset that deleted the reviewers' results and *before* they produce new
    // ones. A `{{results.tone-check}}` in this prompt is therefore a hole that fails the step on
    // every round 2, which is why the verdicts arrive as `{{prior.<id>}}`.
    const text = await promptText("revise");
    const bad: string[] = [];
    for (const id of PANEL) {
      if (!text.includes(`{{prior.${id}}}`)) bad.push(`revise.md does not render {{prior.${id}}}`);
      if (text.includes(`{{results.${id}}}`)) bad.push(`revise.md still renders {{results.${id}}}`);
    }
    if (!text.includes("{{prior.revise}}")) bad.push("revise.md does not render its own prior round report");
    expect(bad).toEqual([]);
  });

  it("revise.md names the precedence, requires the two-section round report, and has no sentinel", async () => {
    const text = flat(await promptText("revise"));
    expect(text).toContain("A canon issue outranks every other finding");
    expect(text).toContain("cites a law and a line outranks one that cites");
    expect(text).toContain("satisfy the cited law");
    expect(text).toContain("`repetition-check` blocks only on measured counts");
    expect(text).toContain("## Changed");
    expect(text).toContain("## Deliberate exceptions");
    // The sentinel is retired. The measured convergence failure of the one real review round was
    // the writer withholding it after doing the work, and the panel is the arbiter now: a
    // revision that did not land is caught by the next round's verdicts.
    expect(text).not.toContain("REVISIONS_COMPLETE");
  });
});

describe("the script gate opens on a green panel and says what the rounds cost", () => {
  it("is three lines, and the round sentence renders", async () => {
    const context = JSON.parse(await readFile(path.join(__dirname, "fixtures/harbor-check-context.json"), "utf8"));
    const text = await readFile(path.join(PROMPTS, "script-gate.gate.md"), "utf8");
    const rendered = renderPrompt(
      text,
      { episodeId: context.episodeId, runId: context.runId, showRoot: context.showRoot, results: context.results },
      { season: context.season, show: context.show, prior: context.prior, round: context.round },
    );
    expect(rendered.trimEnd().split("\n")).toEqual([
      `Script drafted: ${context.show.episodesDir}/${context.episodeId}/script.md`,
      "The panel is green after 2 round(s) ($12.3456 of review and revision).",
      "Approve to commit. Reject with notes for a targeted revision.",
    ]);
    // The seven verdict dumps are gone: the gate opens green, so printing them said "pass" seven
    // times over, and the console's verdict board draws the per-reviewer detail from the log.
    for (const id of PANEL) expect(text).not.toContain(`{{results.${id}}}`);
  });

  it("the outline gate's message is left alone", async () => {
    // Its panel is not looped — one canon reviewer, no round — and it already reads a path rather
    // than dumping a verdict, which is the pattern the script gate was moved towards.
    const text = await readFile(path.join(PROMPTS, "outline-gate.gate.md"), "utf8");
    expect(text).toContain("{{results.canon-review-outline.verdict}}");
    expect(text).not.toContain("{{round.");
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

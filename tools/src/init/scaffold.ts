import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { renderPrompt, type ShowConfig } from "@showrunner/engine";
import { templatesDir } from "./paths.js";

/** The file `writeScaffold` leaves in a new show's prompts directory recording what it copied:
 *  `{ "<file>": "<sha256>" }`, one entry per file, keyed by the path relative to the prompts
 *  directory.
 *
 *  **Why a show needs one.** A show's prompts are *copies*, and both sides of a copy move: the
 *  author edits a prompt to suit their show, and the engine's own template is improved under them.
 *  With only two files to compare — the show's and the engine's current one — a difference says
 *  nothing about which side moved, so the question an operator actually has ("is this my edit, or
 *  have I fallen behind?") cannot be answered. A third fixed point answers it. The baseline is that
 *  fixed point, written once at `init` and never updated, and `check-prompts --baseline` reads it.
 *
 *  Exported because `check-prompts.ts` reads the file this module writes, and the two must not
 *  spell its name independently. */
export const PROMPT_BASELINE_FILE = ".templates-baseline.json";

/** The hash the baseline records, and the one `check-prompts --baseline` recomputes: sha256 of the
 *  file's text as UTF-8.
 *
 *  Of the *text* and not of the bytes on disk, deliberately. Both sides of every comparison read
 *  their file with `readFile(..., "utf8")` and hash the result through this function, so the two can
 *  never disagree about an encoding detail — a byte-order mark, a lone surrogate — that no prompt
 *  has and that would otherwise show up as drift nobody introduced. What the baseline states is
 *  "this is the text that was copied", which is the thing a drift report is about.
 *
 *  Exported for the same reason the filename is: one definition, read and written by two modules. */
export function promptHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** One question the interview asks, and the bible section whose answer it is. `heading` is the
 *  template heading's text without its `#` marks, so the driver can write the answer under it and
 *  the writer agent can find the section it belongs to. */
export interface Question {
  heading: string;
  question: string;
}

/** A heading line (level 1 or 2) immediately followed — blank lines allowed between — by the HTML
 *  comment holding its question. Level 1 is matched as well as level 2 because one bible template
 *  is a single question with no sections at all (`visual-audit-laws.md`, whose whole body the
 *  image-audit prompt inserts verbatim); every other template asks its questions on level 2. */
const QUESTIONED_HEADING = /^(#{1,2})[ \t]+(.+?)[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*<!--[ \t]*Q:([\s\S]*?)-->/gm;

/** A whole-line `<!-- Q: … -->` comment, with its own line ending, so stripping one leaves no
 *  blank line behind where the question was. Only a `Q:` comment matches: a template's other
 *  comments are instructions to the author and survive into the file. */
const QUESTION_COMMENT = /^[ \t]*<!--[ \t]*Q:[\s\S]*?-->[ \t]*\r?\n?/gm;

/** The first level-2 heading, which bounds the header of a template that asks nothing. */
const FIRST_SECTION = /^##[ \t]/m;

/** Splits a canon template into the header it opens with — the title and, for an interviewed file,
 *  the RULED/DRAFT status legend — and one question per heading that carries a `<!-- Q: … -->`
 *  comment. A heading with no comment is a section the interview does not ask about, and the
 *  writer agent fills it with `_Not yet decided._`; a file with no comments at all is one of the
 *  three filled defaults, which has no interview and only a gate. The header is everything before
 *  the first questioned heading, or before the first section when nothing is questioned, so the
 *  driver can show the author what file they are describing before it asks anything. */
export function parseCanonTemplate(text: string): { header: string; questions: Question[] } {
  const questions: Question[] = [];
  let firstAt: number | undefined;
  QUESTIONED_HEADING.lastIndex = 0;
  for (let m = QUESTIONED_HEADING.exec(text); m !== null; m = QUESTIONED_HEADING.exec(text)) {
    if (firstAt === undefined) firstAt = m.index;
    questions.push({ heading: m[2]!.trim(), question: m[3]!.replace(/\s+/g, " ").trim() });
  }
  if (firstAt === undefined) {
    const section = FIRST_SECTION.exec(text);
    firstAt = section === null ? text.length : section.index;
  }
  return { header: text.slice(0, firstAt), questions };
}

/** The template with every question stripped and nothing else touched: the artifact written when
 *  the author answers a gate with "I will write this one myself", and the artifact `writeScaffold`
 *  writes for the two files the pipeline fills (the continuity ledger and the voice registry),
 *  which have no questions and so come through unchanged. The headings stay, because a heading a
 *  prompt reads by name must exist even before anyone has written under it. */
export function templateWithoutQuestions(text: string): string {
  return text.replace(QUESTION_COMMENT, "");
}

/** A name as a file name: lower case, every run of non-alphanumerics a single hyphen, no leading or
 *  trailing hyphen — "The Warden" becomes "the-warden". Accents are decomposed and their marks
 *  dropped rather than hyphenated, so "Maève" becomes "maeve" and not "ma-ve".
 *
 *  Latin script only, by construction: the filter keeps `a-z0-9` and nothing else, so a name
 *  written wholly in another script reduces to the empty string and is **refused** rather than
 *  turned into a path the author cannot recognise. Failing by name is the right half of that
 *  trade — a silent "" would collide every such name onto one file. `CAST_NAME` below refuses the
 *  same input earlier and with a better message, so the throw here is the backstop, not the gate. */
export function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") throw new Error(`${JSON.stringify(name)} has no alphanumeric character in it, so it has no slug`);
  return slug;
}

/** A directory name out of the config: the configured value when it is a non-empty string, else the
 *  engine's own default, in both cases without a trailing slash so callers can join with one. The
 *  argument is `unknown` because half these keys are typed on `ShowConfig` and half live inside its
 *  `Record<string, unknown>` groups (`visual.candidatesDir`), and the rule for reading them must
 *  not differ by which half a key happens to be in. */
function dirKey(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value.replace(/\/+$/, "") : fallback;
}

/** The show's `.gitignore`, derived from the config's own directory keys rather than written as a
 *  fixed list, so a show that renames `Production` or moves its image candidates still ignores the
 *  right paths (the inventory's F-20, where the first show's candidates directory was tracked for
 *  months because the two were written independently). The generated binaries are ignored and the
 *  manifests beside them are not. `Finalized` appears twice on purpose: the show's `Finalized` is a
 *  symlink to the NAS, and git matches a symlink by the bare name and a real directory by the
 *  trailing slash.
 *
 *  **`*.worker.out`, `*.lock` and `*.lock.tmp` are runtime state beside a run log, and a show that
 *  tracked them could not have a clean working tree.** The console's server creates
 *  `<runId>.worker.out` empty before it spawns a worker, and the kernel appends that worker's
 *  output — its closing line included — *after* the approving commit has been taken, so every
 *  approved bible file would otherwise leave a modified file behind that the next commit would
 *  sweep in. The lock is a statement about a live process (`console/worker/lock.ts`) and belongs in
 *  no history at all: it is created with `O_EXCL` and removed in a `finally`, so a tracked lock
 *  would be a tracked deletion on every run. `<runId>.lock.tmp` is the lock's own write target —
 *  each heartbeat writes it and renames it over the lock, so a reader never sees the empty file a
 *  truncating rewrite leaves behind — and it is ignored as its own row because `release()` removes
 *  it but `killOnSignal` does not: a worker that takes SIGTERM exits 143 without the `finally`, and
 *  the tmp file it leaves behind would otherwise be an untracked file in the show. Every pattern
 *  matches at any depth rather than at one fixed depth, because
 *  the two run-log trees are not at the same depth — an episode's is
 *  `<productionDir>/<id>/runs/` and a bible file's is `<productionDir>/setup/<key>/runs/`, one
 *  segment deeper. The ignore is what makes them stay out: `commitPaths`
 *  stages a run's log *directory*, and `git add -- <dir>` honours `.gitignore`. */
export function gitignoreFor(config: ShowConfig): string {
  const production = dirKey(config.productionDir, "Production");
  const candidates = dirKey(config.visual?.["candidatesDir"], "Canon/_candidates");
  return (
    [
      ".DS_Store",
      `${production}/*/audio/`,
      `${production}/*/video/`,
      `${production}/*/images/*.png`,
      `${production}/*/images/*.jpg`,
      `${production}/*/images/.*.bak`,
      `${production}/**/*.worker.out`,
      `${production}/**/*.lock`,
      `${production}/**/*.lock.tmp`,
      `${candidates}/`,
      "Finalized",
      "Finalized/",
      ".superpowers/",
    ].join("\n") + "\n"
  );
}

/** Writes `text` at `rel` under `root` with the `wx` flag, so an existing file raises `EEXIST`
 *  rather than being overwritten: nothing in the setup may destroy a file an author put there. The
 *  parent directory is created first, because a cast sheet lives in a directory named after the
 *  character and that directory cannot be known before the cast is. Returns `rel` so a caller can
 *  collect what it wrote. */
async function writeNew(root: string, rel: string, text: string): Promise<string> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text, { encoding: "utf8", flag: "wx" });
  return rel;
}

/** Every file under `dir`, as paths relative to it, sorted — so the prompt set is copied in a
 *  stable order however the file system lists it, and a prompt set that grows a subdirectory is
 *  copied whole without this function changing. */
async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

function templatePath(...segments: string[]): string {
  return path.join(templatesDir(), ...segments);
}

/** A cast name that is safe to use as a directory segment: it starts with a letter or a digit and
 *  carries only letters, digits, spaces, apostrophes and hyphens, up to 64 characters — "Vale",
 *  "The Warden", "O'Brien-Vale", "Maève". Letter and digit are Unicode classes, not ASCII ranges,
 *  because a name is a person's name and an author should not have to transliterate one to cast it.
 *  Everything a path could be steered with is absent from the class,
 *  `.` and `/` first among them, so no name matching this can name a directory other than the one
 *  under `Canon/characters/`. The names reach this module as free text typed at the world-overview
 *  interview, so they are validated and not merely slugged: `slugOf` makes a safe *file* name, and
 *  the *directory* keeps the author's spelling, which is the part a traversal would ride in on.
 *
 *  **Exported because the interview driver must refuse a name this function would refuse, before
 *  it ever gets here.** `writeCastSheets` throws on a name outside this class, and that throw is
 *  not caught by `runInit`, so it ends the whole setup. The driver reads a cast out of prose it
 *  did not write — the `## The primary cast` section of an imported bible file — and
 *  `CAST_LINE`'s lazy first group matches at the first spaced dash in any paragraph, so a prose
 *  sentence yields a hundred-character "name" with asterisks and commas in it. The driver filters
 *  every candidate name through this one rule and reports a refused line back to the author as a
 *  line it could not read, which leaves this throw as the backstop it was written to be rather
 *  than the way an import ends an interview. */
export const CAST_NAME = /^[\p{L}\p{N}][\p{L}\p{N} '\-]{0,63}$/u;

/** One `Canon/characters/<Name>/<slug>.md` per cast entry, from the character entity template with
 *  the name on its `#` line and the author's one-liner as the sheet's one-line summary directly
 *  under it. Separate from `writeScaffold` because the cast is not known when the scaffold is
 *  written: `init` writes the layout first and learns the cast from the world-overview interview,
 *  the first file it interviews, and calls this afterwards (the plan's F-24). A sheet that already
 *  exists raises `EEXIST`, because a sheet an author has filled in is not the setup's to replace.
 *  Returns the relative paths written, sorted.
 *
 *  The one-liner goes under the `#` line rather than under the template's first level-2 heading,
 *  which is `## Physical description`: the world-overview interview asks for the cast as
 *  `Name — one line about who they are`, so the line it collects is a role and writing it under a
 *  physical-description heading would put a wrong fact in the section the character auditor and
 *  the image prompts both read. Under the name it is true wherever the author's line lands. */
export async function writeCastSheets(root: string, config: ShowConfig, cast: readonly { name: string; line: string }[]): Promise<string[]> {
  const canon = dirKey(config.canonDir, "Canon");

  // Every name is checked, slugged and resolved before anything at all is written, so a name this
  // function will not accept — wherever it sits in the cast list — leaves no half-written set of
  // sheets behind. The whole call is refused, naming the member that caused it.
  const charactersRoot = path.resolve(root, canon, "characters");
  const planned: { name: string; line: string; rel: string }[] = [];
  for (const member of cast) {
    if (!CAST_NAME.test(member.name)) {
      throw new Error(
        `cast name ${JSON.stringify(member.name)} is not a usable directory name: a name may carry only letters, digits, spaces, apostrophes and hyphens, must start with a letter or a digit, and must be at most 64 characters`,
      );
    }
    // `slugOf` throws for a name with no Latin letter or digit in it, which `CAST_NAME` admits:
    // the name class is Unicode and the file name is not. Calling it here rather than in the write
    // loop is what keeps that case all-or-nothing too.
    const rel = `${canon}/characters/${member.name}/${slugOf(member.name)}.md`;
    // Belt and braces over CAST_NAME: the path that is about to be written is resolved and
    // required to lie under Canon/characters/, so a future change to the name class, or a
    // `canonDir` that is itself an escape, cannot write outside the show's own character pile.
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(charactersRoot + path.sep)) {
      throw new Error(`cast sheet for ${JSON.stringify(member.name)} would be written at ${abs}, outside ${charactersRoot}`);
    }
    planned.push({ ...member, rel });
  }

  const template = await readFile(templatePath("canon", "characters", "_TEMPLATE.md"), "utf8");
  const written: string[] = [];
  for (const member of planned) {
    const sheet = template.replace(/^#[ \t]+.*$/m, `# ${member.name}\n\n${member.line.trim()}`);
    written.push(await writeNew(root, member.rel, sheet));
  }
  return written.sort();
}

/** Everything a new show starts with that nobody has to be interviewed about: the directories, the
 *  four entity templates, the outline template the outline prompt and the draft loop require, the
 *  two reference indices with their shapes and no entries, the two bible files the pipeline itself
 *  fills, the `.gitignore` derived from the config, the show's README rendered with its name, the
 *  whole prompt set with its `PROMPT_BASELINE_FILE` baseline, and a sheet per cast member. The
 *  thirteen interviewed and default bible files are not written here — the interview writes those,
 *  one commit each.
 *
 *  Every file is written with `wx`. The function is therefore not atomic: a failure part-way leaves
 *  what it had already written on disk and throws. That is the right trade, because the alternative
 *  to failing loudly is overwriting an author's file, and `init` refuses a directory that is not
 *  empty before it calls this at all. Returns the relative paths written, sorted. */
export async function writeScaffold(root: string, config: ShowConfig, cast: readonly { name: string; line: string }[]): Promise<string[]> {
  const canon = dirKey(config.canonDir, "Canon");
  const episodes = dirKey(config.episodesDir, "Episodes");
  const production = dirKey(config.productionDir, "Production");
  const prompts = dirKey(config.promptsDir, "prompts");

  for (const dir of [
    canon,
    `${canon}/characters`,
    `${canon}/species`,
    `${canon}/locations`,
    `${canon}/factions`,
    `${episodes}/_TEMPLATE`,
    `${production}/voice-refs`,
    prompts,
  ]) await mkdir(path.join(root, dir), { recursive: true });

  const written: string[] = [];
  const copy = async (rel: string, ...from: string[]): Promise<void> => {
    written.push(await writeNew(root, rel, await readFile(templatePath(...from), "utf8")));
  };

  for (const kind of ["characters", "species", "locations", "factions"]) {
    await copy(`${canon}/${kind}/_TEMPLATE.md`, "canon", kind, "_TEMPLATE.md");
  }
  await copy(`${episodes}/_TEMPLATE/outline.md`, "episodes", "_TEMPLATE", "outline.md");
  await copy(`${canon}/refs.json`, "refs", "canon-refs.json");
  await copy(`${production}/voice-refs/refs.json`, "refs", "voice-refs.json");

  // The two bible files the pipeline fills: written with their headings and nothing under them,
  // because `propose` appends to the ledger and the NEEDS_REFS stop fills the registry.
  for (const key of ["continuity-ledger", "voice-registry"]) {
    const text = await readFile(templatePath("canon", `${key}.md`), "utf8");
    written.push(await writeNew(root, `${canon}/${key}.md`, templateWithoutQuestions(text)));
  }

  written.push(await writeNew(root, ".gitignore", gitignoreFor(config)));

  const readme = await readFile(templatePath("show", "README.md"), "utf8");
  written.push(
    await writeNew(
      root,
      "README.md",
      renderPrompt(
        readme,
        { episodeId: "setup", runId: "init", showRoot: root, results: {} },
        { show: config as unknown as Record<string, unknown> },
      ),
    ),
  );

  // The prompt set, and the baseline recording what each file's text was when it was copied. The
  // baseline is built from the same strings that are written, so it describes this show's files and
  // not the template directory as some later reader finds it.
  const promptsRoot = templatePath("prompts");
  const baseline: Record<string, string> = {};
  for (const rel of await filesUnder(promptsRoot)) {
    const text = await readFile(path.join(promptsRoot, rel), "utf8");
    written.push(await writeNew(root, `${prompts}/${rel}`, text));
    baseline[rel] = promptHash(text);
  }
  written.push(await writeNew(root, `${prompts}/${PROMPT_BASELINE_FILE}`, `${JSON.stringify(baseline, null, 2)}\n`));

  written.push(...(await writeCastSheets(root, config, cast)));
  return written.sort();
}

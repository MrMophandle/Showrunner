/** Renders every extracted prompt against a sample context and reports the ones with holes.
 *
 *  This is the check that makes the extraction trustworthy. `renderPrompt` treats every hole as an
 *  error — an unknown variable, a missing step result, a path through a non-object, a null value —
 *  because a prompt with a hole in it lies to the model quietly. Running the whole prompts
 *  directory through it once, against a context that names every step the pipeline will produce,
 *  turns that run-time failure into a check that can be run before anything is launched.
 *
 *  A prompt that names `{{vars.<name>}}` renders against the context file's own `vars` object: the
 *  vars belong to a pipeline step and the checker has no pipeline, so the context file supplies one
 *  sample set for the whole directory. A prompt naming a var that object does not carry is reported
 *  like any other hole.
 *
 *  Every `.md` file in the directory is checked, with no special case for a gate message or a
 *  rejection prompt. A gate message is rendered by the same `renderPrompt` at run time and is read
 *  by the showrunner at an approval, so a hole in one misleads the one person the pipeline cannot
 *  afford to mislead. The check therefore has a single rule: every `.md` the extractor wrote must
 *  render.
 *
 *  `README.md` is the one exception, and it is skipped rather than checked. It is written by a
 *  person and never by the extractor — which is why the extractor's own cleanup keeps it — and it
 *  documents the template syntax, so it quotes forms like `{{show.<path>}}` that are deliberately
 *  not renderable. Nothing renders it at run time, so a hole in it misleads no one.
 *
 *  **`--baseline` is the module's second question, and it is about drift rather than holes.** A
 *  show's prompts are copies of the engine's templates, and both sides move: the author tunes a
 *  prompt, and the engine improves a template. `promptBaseline` reads the
 *  `PROMPT_BASELINE_FILE` that `init` left in the prompts directory and reports, per file, which
 *  side moved — see `BaselineVerdict` for the seven answers and why three of them are not among
 *  the four the report is for. The two checks share only the `--prompts` directory: a hole is a
 *  refusal (exit 1) and drift is a report (exit 0). */

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { renderPrompt, TemplateError, type RenderExtra, type ShowConfig } from "@showrunner/engine";
import { templatesDir } from "./init/paths.js";
import { PROMPT_BASELINE_FILE, promptHash } from "./init/scaffold.js";

export interface CheckContext {
  episodeId: string;
  runId: string;
  showRoot: string;
  /** Every step result a prompt may name, keyed by step id. A gate's rejection is keyed
   *  `<gateId>:rejection`, which is the form the extractor's rewrite produces. */
  results: Record<string, unknown>;
  season?: number;
  show?: ShowConfig | Record<string, unknown>;
  /** The values a prompt may name as `{{vars.<name>}}`. A step declares its own vars, so the
   *  checker cannot derive them: a prompt file run for several targets renders here against the
   *  one sample set the context file supplies. A prompt naming a var this object does not carry is
   *  a hole, which is the point — the check is what catches it before a run does. */
  vars?: Record<string, string>;
}

export interface CheckOptions {
  promptsDir: string;
  context: CheckContext;
}

export interface CheckError {
  /** The prompt file's basename under `promptsDir`. */
  file: string;
  error: string;
}

export async function checkPrompts(opts: CheckOptions): Promise<CheckError[]> {
  const { promptsDir, context } = opts;
  const extra: RenderExtra = {
    ...(context.season !== undefined ? { season: context.season } : {}),
    // The same cast the engine's own agent step makes when it hands a ShowConfig to the renderer:
    // ShowConfig is an interface, so it has no implicit index signature and is not assignable to
    // Record<string, unknown> without it.
    ...(context.show !== undefined ? { show: context.show as unknown as Record<string, unknown> } : {}),
    ...(context.vars !== undefined ? { vars: context.vars } : {}),
  };
  const ctx = {
    episodeId: context.episodeId,
    runId: context.runId,
    showRoot: context.showRoot,
    results: context.results,
  };

  const files = (await readdir(promptsDir)).filter((n) => n.endsWith(".md") && n !== "README.md").sort();
  const errors: CheckError[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(path.join(promptsDir, file), "utf8");
    } catch (err) {
      errors.push({ file, error: `could not be read: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    try {
      renderPrompt(text, ctx, extra);
    } catch (err) {
      // A TemplateError is a hole in the prompt — the thing this check exists to find — and its
      // message already names the variable as written. Anything else is a failure of the check
      // itself, and is labelled so the two are never confused in the report.
      const message = err instanceof TemplateError
        ? err.message
        : `could not be checked: ${err instanceof Error ? err.message : String(err)}`;
      errors.push({ file, error: message });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// The drift report

/** Where one of a show's prompt files stands against the two things it can have drifted from.
 *
 *  **The four the report exists for**, each the answer to "who moved?": `unchanged` — neither side
 *  has; `show-edited` — the show's copy differs from the baseline and the engine's template does
 *  not, so this is the author's own edit and an update would overwrite it; `template-moved` — the
 *  show's copy is still what was copied and the engine's template has moved on, so this file can be
 *  refreshed with nothing lost; `both` — each side has moved independently, which is the only case
 *  that needs a person to merge.
 *
 *  **And three a two-hash comparison cannot express**, kept as their own names rather than folded
 *  into one of the four, because calling any of them "unchanged" or "both" would be a lie about
 *  what was compared: `no-baseline` — a file in the show's prompts directory that the baseline does
 *  not list, which is a prompt added after `init`; `missing` — a baseline entry whose file is no
 *  longer in the show; `no-template` — a baseline entry the engine no longer ships, so there is
 *  nothing to refresh from. `missing` wins over `no-template` when both hold, because the show's own
 *  state is what the operator acts on. */
export type BaselineVerdict =
  | "unchanged" | "show-edited" | "template-moved" | "both"
  | "no-baseline" | "missing" | "no-template";

/** One row of the drift report: the file, relative to the prompts directory, and where it stands. */
export interface BaselineRow {
  file: string;
  verdict: BaselineVerdict;
}

export interface BaselineOptions {
  /** The show's prompts directory, which holds the copies and the baseline beside them. */
  promptsDir: string;
  /** The engine's own `templates/prompts`, which the report compares against. Defaults to the
   *  directory this build ships, which is what an operator means; a test points it elsewhere. */
  templatesPromptsDir?: string;
}

/** Every file under `dir`, as paths relative to it, sorted — the same walk `init` copied the set
 *  with, so a prompt set that grew a subdirectory is reported whole. A directory that cannot be
 *  read is no files, which is how a template set the engine no longer ships reads. */
async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** The sha256 of one file's text, or `undefined` when there is no such file. The absence is a
 *  verdict here and not an error — a baseline entry whose file is gone is exactly what `missing`
 *  reports — so it must not throw. */
async function hashOf(file: string): Promise<string | undefined> {
  try { return promptHash(await readFile(file, "utf8")); } catch { return undefined; }
}

/** Reads a show's prompt baseline and reports, for every file either side knows about, which side
 *  has moved since `init` copied the set.
 *
 *  **Both comparisons are against the baseline and never against each other.** The show's file is
 *  compared to the baseline, and the engine's current template is compared to the same baseline.
 *  That is the whole design: comparing the show's file to the current template would say only
 *  "these differ", which is true of almost every prompt in a show a month old and tells an operator
 *  nothing about whether the difference is theirs.
 *
 *  Throws only when the baseline file itself cannot be read or parsed, because a report with no
 *  baseline is not a report: every row would read `no-baseline` and the output would look like a
 *  show that had edited all forty-three of its prompts. */
export async function promptBaseline(opts: BaselineOptions): Promise<BaselineRow[]> {
  const { promptsDir } = opts;
  const templates = opts.templatesPromptsDir ?? path.join(templatesDir(), "prompts");
  const baselineFile = path.join(promptsDir, PROMPT_BASELINE_FILE);
  let baseline: Record<string, string>;
  try {
    const parsed = JSON.parse(await readFile(baselineFile, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("it must hold a JSON object of file names to hashes");
    }
    baseline = parsed as Record<string, string>;
  } catch (err) {
    throw new Error(
      `the prompt baseline at ${baselineFile} could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
      `Shows scaffolded before this file existed have none; there is nothing to compare against.`,
    );
  }

  const inShow = (await filesUnder(promptsDir)).filter((f) => f !== PROMPT_BASELINE_FILE);
  const rows: BaselineRow[] = [];
  for (const file of [...new Set([...inShow, ...Object.keys(baseline)])].sort()) {
    const recorded = baseline[file];
    if (typeof recorded !== "string") { rows.push({ file, verdict: "no-baseline" }); continue; }
    const mine = await hashOf(path.join(promptsDir, file));
    if (mine === undefined) { rows.push({ file, verdict: "missing" }); continue; }
    const theirs = await hashOf(path.join(templates, file));
    if (theirs === undefined) { rows.push({ file, verdict: "no-template" }); continue; }
    const showMoved = mine !== recorded;
    const templateMoved = theirs !== recorded;
    rows.push({ file, verdict: showMoved && templateMoved ? "both" : showMoved ? "show-edited" : templateMoved ? "template-moved" : "unchanged" });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = "usage: check-prompts --prompts <dir> [--context <json-file>] [--baseline]\n"
  + "  --context <file>  render every prompt and report the ones with holes: { episodeId, runId, showRoot, results, season?, show?, vars? }\n"
  + "  --baseline        report, per prompt, which side has drifted since init copied it\n"
  + "  one of the two is required; both may be given";

interface ParsedArgs { prompts?: string; context?: string; baseline?: boolean }

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--prompts" && value !== undefined) { parsed.prompts = value; i++; }
    else if (flag === "--context" && value !== undefined) { parsed.context = value; i++; }
    // A presence and not a value: there is one baseline for a prompts directory and it lives in
    // that directory, so there is nothing for a path to say.
    else if (flag === "--baseline") { parsed.baseline = true; }
    else throw new Error(`unrecognised argument ${JSON.stringify(flag ?? "")}\n${USAGE}`);
  }
  return parsed;
}

/** The context file's accepted shape, as a parser: the CLI reads the file, `JSON.parse`s it, and
 *  hands the result here, so this function is where "what a context file may contain" is defined.
 *  Exported so that shape has tests of its own — the CLI is the only other way to reach it. */
export function asCheckContext(value: unknown, file: string): CheckContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`context file ${file} must hold a JSON object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of ["episodeId", "runId", "showRoot"] as const) {
    if (typeof record[key] !== "string") throw new Error(`context file ${file}: ${key} must be a string`);
  }
  const results = record["results"];
  if (typeof results !== "object" || results === null || Array.isArray(results)) {
    throw new Error(`context file ${file}: results must be an object keyed by step id`);
  }
  const season = record["season"];
  const show = record["show"];
  // Only string values: `{{vars.<name>}}` substitutes its value verbatim, so a number or a nested
  // object in the context file would be a var the engine's own type does not permit.
  // Deliberately stricter than `season` and `show` above, which drop a malformed value silently:
  // a dropped `vars` would report every prompt that names a var as a hole and send the reader to
  // the prompts instead of to the context file, which is the one file at fault.
  const vars = record["vars"];
  if (vars !== undefined) {
    if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
      throw new Error(`context file ${file}: vars must be an object of string values`);
    }
    for (const [name, value] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof value !== "string") throw new Error(`context file ${file}: vars.${name} must be a string`);
    }
  }
  return {
    episodeId: record["episodeId"] as string,
    runId: record["runId"] as string,
    showRoot: record["showRoot"] as string,
    results: results as Record<string, unknown>,
    ...(typeof season === "number" ? { season } : {}),
    ...(typeof show === "object" && show !== null && !Array.isArray(show) ? { show: show as Record<string, unknown> } : {}),
    ...(vars !== undefined ? { vars: vars as Record<string, string> } : {}),
  };
}

/** Prints the drift report and answers whether it found anything worth a non-zero exit.
 *
 *  **It does not.** Drift is a report and not a refusal: `show-edited` is the ordinary state of a
 *  show whose author has tuned a prompt, and an exit code that treated it as a failure would make
 *  this unusable in any script. Only a baseline that cannot be read is an error, and that is thrown
 *  by `promptBaseline` before this function is reached. The rows that are worth an operator's
 *  attention are summarised in the last line rather than signalled in the exit code. */
function reportBaseline(promptsDir: string, rows: BaselineRow[]): void {
  const width = rows.reduce((w, r) => Math.max(w, r.file.length), 0);
  for (const row of rows) process.stdout.write(`  ${row.file.padEnd(width)}  ${row.verdict}\n`);
  const counts = new Map<BaselineVerdict, number>();
  for (const row of rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
  const summary = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([v, n]) => `${n} ${v}`).join(", ");
  process.stdout.write(`${rows.length} prompt(s) in ${promptsDir}: ${summary === "" ? "none" : summary}\n`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  // `--prompts` is always required, and one of the two checks must be asked for: a bare
  // `--prompts <dir>` names a directory and no question about it.
  if (args.prompts === undefined || (args.context === undefined && args.baseline !== true)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (args.baseline === true) {
    reportBaseline(args.prompts, await promptBaseline({ promptsDir: args.prompts }));
  }
  if (args.context === undefined) return 0;
  const context = asCheckContext(JSON.parse(await readFile(args.context, "utf8")) as unknown, args.context);
  const errors = await checkPrompts({ promptsDir: args.prompts, context });
  if (errors.length === 0) {
    process.stdout.write(`every prompt in ${args.prompts} renders\n`);
    return 0;
  }
  process.stderr.write(`${errors.length} prompt(s) did not render:\n`);
  for (const e of errors) process.stderr.write(`  ${e.file}\t${e.error}\n`);
  return 1;
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url === pathToFileURL(invokedAs).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; },
  );
}

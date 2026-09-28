/** Renders every extracted prompt against a sample context and reports the ones with holes.
 *
 *  This is the check that makes the extraction trustworthy. `renderPrompt` treats every hole as an
 *  error — an unknown variable, a missing step result, a path through a non-object, a null value —
 *  because a prompt with a hole in it lies to the model quietly. Running the whole prompts
 *  directory through it once, against a context that names every step the pipeline will produce,
 *  turns that run-time failure into a check that can be run before anything is launched.
 *
 *  Every `.md` file in the directory is checked, with no special case for a gate message or a
 *  rejection prompt. A gate message is rendered by the same `renderPrompt` at run time and is read
 *  by the showrunner at an approval, so a hole in one misleads the one person the pipeline cannot
 *  afford to mislead. The check therefore has a single rule: every `.md` the extractor wrote must
 *  render. */

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { renderPrompt, TemplateError, type RenderExtra, type ShowConfig } from "@showrunner/engine";

export interface CheckContext {
  episodeId: string;
  runId: string;
  showRoot: string;
  /** Every step result a prompt may name, keyed by step id. A gate's rejection is keyed
   *  `<gateId>:rejection`, which is the form the extractor's rewrite produces. */
  results: Record<string, unknown>;
  season?: number;
  show?: ShowConfig | Record<string, unknown>;
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
  };
  const ctx = {
    episodeId: context.episodeId,
    runId: context.runId,
    showRoot: context.showRoot,
    results: context.results,
  };

  const files = (await readdir(promptsDir)).filter((n) => n.endsWith(".md")).sort();
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
// CLI

const USAGE = "usage: check-prompts --prompts <dir> --context <json-file>";

interface ParsedArgs { prompts?: string; context?: string }

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--prompts" && value !== undefined) { parsed.prompts = value; i++; }
    else if (flag === "--context" && value !== undefined) { parsed.context = value; i++; }
    else throw new Error(`unrecognised argument ${JSON.stringify(flag ?? "")}\n${USAGE}`);
  }
  return parsed;
}

function asCheckContext(value: unknown, file: string): CheckContext {
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
  return {
    episodeId: record["episodeId"] as string,
    runId: record["runId"] as string,
    showRoot: record["showRoot"] as string,
    results: results as Record<string, unknown>,
    ...(typeof season === "number" ? { season } : {}),
    ...(typeof show === "object" && show !== null && !Array.isArray(show) ? { show: show as Record<string, unknown> } : {}),
  };
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.prompts === undefined || args.context === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
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

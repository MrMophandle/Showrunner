/** Reports what the bible is missing: the files the episode pipeline declares that are absent or
 *  empty, and the level-2 sections a prompt template reads by name that a file does not carry.
 *
 *  It exists because a prompt that reads an absent section does not fail — it renders the file's
 *  text up to a heading that is not there and hands the model a partial read, which is the one
 *  pipeline failure that announces itself nowhere. `init` runs this check at the end of the
 *  interview and the author runs it after every edit to the bible; the engine's `bible-ready`
 *  guard runs the same two functions before an episode, where the answer is a refusal rather than
 *  a report. */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadShowConfig, missingBibleFiles, missingSections, type RequiredSection } from "@showrunner/engine";

/** What the command prints for a usage fault: the one statement of what it takes and what it
 *  reports. Exported so the tests assert against the same string the author is shown. */
export const USAGE = "usage: bible-check --show <show root> [--season <n>]\n  names every bible file that is missing or empty and every section a prompt reads by name that a file does not carry";

/** One run of the check. The two lists are kept apart rather than flattened into messages because
 *  `init` and the CLI both report them and the engine's `bible-ready` guard refuses a run over the
 *  same two questions: a file that is not there at all, and a file that is there without a section
 *  some prompt reads by name. `ok` is the exit code in a word. */
export interface BibleCheckResult {
  /** Each absent file as its path, each present-but-empty file as `<path> (empty)`, sorted. */
  missingFiles: string[];
  /** Each required section a file that exists does not carry, with the prompt that reads it. An
   *  absent file's sections are not listed: that is one fault, reported once, by `missingFiles`. */
  missingSections: RequiredSection[];
  /** True when both lists are empty: the bible is complete for this season. */
  ok: boolean;
}

/** The check itself, against the show's own config: `canonDir` and `episodesDir` decide where the
 *  files are looked for, and `season` decides which season file stands for `Canon/season-{season}`.
 *  Separated from the CLI so `init` can run the same check at the end of the interview and print
 *  the same lines. */
export async function bibleCheck(showRoot: string, season = 1): Promise<BibleCheckResult> {
  const config = await loadShowConfig(showRoot);
  const files = await missingBibleFiles(showRoot, config, season);
  const sections = await missingSections(showRoot, config, season);
  return { missingFiles: files, missingSections: sections, ok: files.length === 0 && sections.length === 0 };
}

/** The report as lines, one fault per line, with the reader named for every missing section so the
 *  author knows which prompt is reading nothing. Empty when the bible is complete — the caller
 *  words the clean case, because `init` and the CLI say it differently. */
export function bibleCheckLines(result: BibleCheckResult): string[] {
  const lines: string[] = [];
  if (result.missingFiles.length > 0) {
    lines.push(`${result.missingFiles.length} bible file(s) missing or empty:`);
    for (const file of result.missingFiles) lines.push(`  ${file}`);
  }
  if (result.missingSections.length > 0) {
    lines.push(`${result.missingSections.length} section(s) a prompt reads by name are missing:`);
    for (const s of result.missingSections) lines.push(`  ${s.file}\t## ${s.heading}\tread by ${s.readBy}`);
  }
  return lines;
}

/** Where the CLI writes. Injected so the tests can read what was printed without capturing the
 *  process's own streams. */
export interface CheckIO {
  out(text: string): void;
  err(text: string): void;
}

const processIO: CheckIO = {
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); },
};

interface ParsedArgs {
  show?: string;
  season?: number;
}

/** The arguments, or a thrown `Error` whose message is the complaint and the usage. A usage fault
 *  exits 64 rather than 1, so a script driving this can tell "I called it wrongly" from "the bible
 *  is incomplete". */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  /** The value of a flag that takes one: the next token, unless there is no next token or the next
   *  token is itself a flag. Both are usage faults that name the flag, because reading a flag as a
   *  value is worse than refusing it — `--show --season` would have gone looking for a show root
   *  called "--season" and reported that its config could not be read. */
  const valueOf = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--show") { parsed.show = valueOf(flag, next); i++; }
    else if (flag === "--season") {
      const value = valueOf(flag, next);
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`--season must be a positive whole number, not ${JSON.stringify(value)}\n${USAGE}`);
      parsed.season = Number(value);
      i++;
    }
    else throw new Error(`unrecognised argument ${JSON.stringify(flag ?? "")}\n${USAGE}`);
  }
  return parsed;
}

/** Exit 0 when the bible is complete, 1 when anything is missing, 64 on a usage fault. The
 *  incomplete case is a 1 and not a 0 so that a `bible-check` in a script or a pre-launch hook
 *  stops the launch. */
export async function main(argv: string[], io: CheckIO = processIO): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n`);
    return 64;
  }
  if (args.show === undefined) {
    io.err(`${USAGE}\n`);
    return 64;
  }
  const root = path.resolve(args.show);
  const season = args.season ?? 1;
  const result = await bibleCheck(root, season);
  if (result.ok) {
    io.out(`every bible file in ${root} is present and carries every section a prompt reads by name (season ${season})\n`);
    return 0;
  }
  for (const line of bibleCheckLines(result)) io.out(`${line}\n`);
  return 1;
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url === pathToFileURL(invokedAs).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; },
  );
}

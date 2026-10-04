/** `showrunner-init`: the command that makes a new show repository and interviews its author for
 *  the bible. It is the whole of the setup's user interface — a terminal, one question at a time —
 *  and it owns nothing else: `runInit` does the work, and this file is the arguments, the readline
 *  implementation of `InitIO`, and the exit codes. */

import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { InitIO } from "./interview.js";
import { runInit, type InitOptions } from "./init.js";
import { templatesDir } from "./paths.js";

export const USAGE = `usage: showrunner-init --name <show name> --path <directory> [options]

  --name <text>        What the show is called, as it is written on the title card.
  --path <dir>         The directory the show repository is created in. It must be empty or absent.
  --slug <Slug>        One word of letters and digits that names the show's files on disk and on
                       the NAS. Default: --name with every other character removed.
  --nas-root <dir>     The show's own directory on the NAS, where finished video lands. Its parent
                       becomes the mount the pipeline checks for. Default: /Volumes/media/<slug>.
  --github <private|public|none>
                       Whether to create the GitHub repository at the end, and how visible it is.
                       Default: private. Nothing is created until the interview is over, and the
                       command is printed for later if gh is not signed in.
  --engine-root <dir>  The engine repository, named in the next steps this prints at the end.
                       Default: the repository this command was installed from.
  --import <dir>       An existing show repository. Every bible file it already has is offered for
                       import, file by file, instead of being interviewed.
  --resume             Continue a setup that was interrupted. Every bible file whose interview was
                       approved is skipped; the first that was not is where it picks up. This is
                       the only way init will touch a directory that is not empty.
  --help               Print this and exit.

--name and --path are asked for at the terminal when they are not given.
A multiline answer ends with a line holding only a period.`;

export interface ParsedArgs {
  name?: string;
  path?: string;
  slug?: string;
  nasRoot?: string;
  github?: "private" | "public" | "none";
  engineRoot?: string;
  importFrom?: string;
  resume?: boolean;
  help?: boolean;
}

/** The arguments, or a thrown `Error` whose message is the complaint and the usage. Exported so the
 *  parse has tests of its own, since the CLI is otherwise only reachable with a terminal attached. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--name" && value !== undefined) { parsed.name = value; i++; }
    else if (flag === "--path" && value !== undefined) { parsed.path = value; i++; }
    else if (flag === "--slug" && value !== undefined) { parsed.slug = value; i++; }
    else if (flag === "--nas-root" && value !== undefined) { parsed.nasRoot = value; i++; }
    else if (flag === "--engine-root" && value !== undefined) { parsed.engineRoot = value; i++; }
    else if (flag === "--import" && value !== undefined) { parsed.importFrom = value; i++; }
    else if (flag === "--github" && value !== undefined) {
      if (value !== "private" && value !== "public" && value !== "none") {
        throw new Error(`--github must be private, public or none, not ${JSON.stringify(value)}\n${USAGE}`);
      }
      parsed.github = value;
      i++;
    }
    else if (flag === "--resume") parsed.resume = true;
    else if (flag === "--help" || flag === "-h") parsed.help = true;
    else throw new Error(`unrecognised argument ${JSON.stringify(flag ?? "")}\n${USAGE}`);
  }
  return parsed;
}

/** The engine repository, as the next steps name it: the workspace root, one directory above
 *  `tools/`, which is where `console/dist/server/main.js` lives. Resolved from the templates
 *  directory, which is resolved from this file's own location, so it is right whether the command
 *  runs from `dist/` or under vitest. */
export function defaultEngineRoot(): string {
  return path.resolve(templatesDir(), "..", "..");
}

/** The line `interviewFile` wraps a file in when it shows one at a gate. The terminal draws it as a
 *  rule rather than as three hyphens, because at a gate the author is reading a whole bible file in
 *  their scrollback and needs to see where it starts and stops. */
const FILE_RULE = /^--- (.+) ---$/;

/** Indents a block so a default answer or a file is visibly not the question. */
function indent(text: string): string {
  return text.split("\n").map((l) => `    ${l}`).join("\n");
}

/** The author's terminal as an `InitIO`.
 *
 *  `ask` returns the default when the author accepts it by answering nothing, which is the contract
 *  `InitIO` sets out: the driver records exactly what `ask` returns, so an implementation that
 *  showed an earlier answer and then returned an empty string would erase the answer it had just
 *  offered back. A multiline answer ends with a line holding only a period; a multiline answer the
 *  author ends immediately keeps the default too.
 *
 *  `choose` offers the first choice as the Enter key's answer, which is how `init` makes "import
 *  this file" the easy answer for a file it found in an imported show. A number or a choice's own
 *  name is accepted; anything else is asked again, because a gate answer that was a typo would
 *  otherwise approve a bible file.
 *
 *  Nothing is paged. A bible file at its gate is printed whole, between two rules: the author is
 *  reading it to approve it, and a pager would put the decision behind a program they then have to
 *  quit. */
export function terminalIO(rl: Interface = createInterface({ input: process.stdin, output: process.stdout })): InitIO & { close(): void } {
  const write = (text: string): void => { process.stdout.write(`${text}\n`); };
  return {
    say: (text) => {
      write(text.split("\n").map((line) => {
        const rule = FILE_RULE.exec(line);
        return rule === null ? line : `──── ${rule[1] as string} ────`;
      }).join("\n"));
    },
    ask: async (question, opts) => {
      if (opts?.multiline === true) {
        write("");
        write(question);
        if (opts.default !== undefined) {
          write("The answer from an earlier sitting:");
          write(indent(opts.default));
          write("End with a line holding only a period — immediately, to keep the answer above, or after typing over it.");
        } else {
          write("End with a line holding only a period.");
        }
        const lines: string[] = [];
        for (;;) {
          const line = await rl.question("");
          if (line.trim() === ".") break;
          lines.push(line);
        }
        const text = lines.join("\n").trim();
        return text === "" && opts.default !== undefined ? opts.default : text;
      }
      write("");
      write(opts?.default === undefined ? question : `${question} [${opts.default}]`);
      const answer = (await rl.question("> ")).trim();
      return answer === "" && opts?.default !== undefined ? opts.default : answer;
    },
    choose: async <T extends string>(question: string, choices: readonly { key: T; label: string }[]) => {
      const first = choices[0];
      if (first === undefined) throw new Error("nothing was offered to choose from");
      for (;;) {
        write("");
        write(question);
        for (const [i, choice] of choices.entries()) {
          write(`  ${i + 1}. ${choice.label}${i === 0 ? "  (Enter)" : ""}`);
        }
        const answer = (await rl.question("> ")).trim();
        if (answer === "") return first.key;
        const byKey = choices.find((c) => (c.key as string).toLowerCase() === answer.toLowerCase());
        if (byKey !== undefined) return byKey.key;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return (choices[n - 1] as { key: T; label: string }).key;
        write(`Answer with a number from 1 to ${choices.length}, or the name of one of them.`);
      }
    },
    close: () => { rl.close(); },
  };
}

/** Exit 0 on a report, 1 on a thrown error with its message on stderr, 64 on a usage fault — so a
 *  script can tell "I called it wrongly" from "the setup failed". A setup that ends with bible
 *  files still to write, or with the GitHub repository not created, is a report and exits 0: both
 *  are ordinary, and both are said at the end in words. */
export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 64;
  }
  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const terminal = terminalIO();
  try {
    const name = (args.name ?? (await terminal.ask("What is the show called?"))).trim();
    const dir = (args.path ?? (await terminal.ask("Which directory should the show repository be created in?"))).trim();
    if (name === "" || dir === "") {
      process.stderr.write(`a show needs a name and a path\n${USAGE}\n`);
      return 64;
    }
    const options: InitOptions = {
      name,
      path: dir,
      github: args.github ?? "private",
      engineRoot: args.engineRoot ?? defaultEngineRoot(),
      ...(args.slug !== undefined ? { slug: args.slug } : {}),
      ...(args.nasRoot !== undefined ? { nasRoot: args.nasRoot } : {}),
      ...(args.importFrom !== undefined ? { importFrom: args.importFrom } : {}),
      ...(args.resume === true ? { resume: true } : {}),
    };
    const report = await runInit(options, terminal);
    terminal.say(`${report.root} is ready: ${report.files.length} bible file(s) approved, ${report.commits.length} commit(s)${report.remote === undefined ? "" : `, ${report.remote}`}.`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    terminal.close();
  }
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url === pathToFileURL(invokedAs).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; },
  );
}

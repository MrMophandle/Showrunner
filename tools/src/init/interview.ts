import path from "node:path";
import { homedir } from "node:os";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import {
  EventLog, RUN_ID, SETUP_ID, answerGate, answersPath, bibleFilePipeline, bibleLogDir,
  deriveRunState, mintRunId, run,
  type BibleFile, type Executors, type GateMessageRenderer, type RunResult,
} from "@showrunner/engine";
import { templatesDir } from "./paths.js";
import { parseCanonTemplate, templateWithoutQuestions } from "./scaffold.js";

/** The terminal the interview talks through, injected so the driver is testable without a TTY:
 *  `init` passes a readline-backed implementation (Task 8) and the tests pass scripted answers.
 *  `say` prints a block of text; `ask` asks one question and returns the answer, with
 *  `multiline: true` for the answers that are paragraphs or lists; `choose` offers the gate's
 *  four answers and returns the key of the one picked. */
export interface InitIO {
  say(text: string): void;
  ask(question: string, opts?: { multiline?: boolean }): Promise<string>;
  choose<T extends string>(question: string, choices: readonly { key: T; label: string }[]): Promise<T>;
}

/** The four answers a bible file's gate takes. `approve` accepts the file as it stands; `reject`
 *  sends notes to the fix agent and reopens the gate; `myself` writes the empty template over the
 *  file and approves it, because an author who will write the file by hand still wants the
 *  headings the prompts read by name; `import` copies a file the author already has over it. */
export type GateChoice = "approve" | "reject" | "myself" | "import";

/** What the driver needs from its caller. `executors` and `renderGateMessage` are the real ones
 *  in production — built by `init` from `createAgentExecutor` / `createGateMessageRenderer` with
 *  `promptsDir` pointed at `<templatesDir()>/interview`, which is where this task's three prompt
 *  files live — and fakes in the tests. `now` is the clock the run id and the interview's date
 *  stamp are minted from. `operator` is who is answering: it is recorded as the run's trigger and
 *  as the `by` on every gate answer, so the log says who approved the bible. */
export interface InterviewDeps {
  executors: Executors;
  renderGateMessage: GateMessageRenderer;
  now?: () => Date;
  operator: string;
}

/** What one interviewed file leaves behind. `outcome` is the last answer the gate took, so `init`
 *  can word its commit. `runId` names the log that is the record of this file's interview.
 *  `commits` are the paths `init` should stage for this file's commit, relative to the show root
 *  and sorted — the bible file, the answers for an interviewed file, and the run log. `cast` is
 *  set by the `world-overview` interview and by no other: it is the recurring cast the author
 *  named, for `init` to write the character sheets from and to fill the config's main-cast list. */
export interface InterviewResult {
  key: string;
  outcome: "approved" | "written-by-author" | "imported";
  runId: string;
  commits: string[];
  cast?: { name: string; line: string }[];
}

/** The production directory the interview logs and answers under. `interviewFile` takes no
 *  production directory of its own, so a show that renames the key in its config would need this
 *  threaded through — `bibleLogDir`, `answersPath` and `isApproved` all already take it. */
const PRODUCTION_DIR = "Production";

/** The gate's step id, as `bibleFilePipeline` declares it: `answerGate` names the step it answers. */
const GATE_ID = "gate";

const JSONL = ".jsonl";

/** The one interviewed file that also collects the cast, because its `## The primary cast` section
 *  is where the recurring characters are named (`BIBLE_FILES`, `engine/src/bible.ts`). */
const CAST_KEY = "world-overview";

/** The extra question the `world-overview` interview asks after the template's own: the cast as a
 *  list this setup can parse. It is asked separately from the section's question because its
 *  answer is not only prose in a file — `init` makes a character sheet per name and puts the names
 *  in the show config — so it has to come back as data rather than as a paragraph. */
const CAST_QUESTION =
  "Finally, the recurring cast as a list this setup can read: one per line, `Name — one line about who they are`. " +
  "A character sheet is created for each name you give, and each name becomes a speaker key in the show's config. " +
  "Repeat the names you gave for the primary cast above, or amend them.";

/** What an unanswered question records in the answers file. The writer agent is told that a
 *  heading whose question was left blank gets `_Not yet decided._`, so the blank has to be visible
 *  in the file rather than being an absent section the agent cannot tell from a lost one. */
const BLANK = "(blank)";

/** The notes recorded on the approval when the author takes the file over. The notes are the log's
 *  record of why an approved file holds nothing but headings. */
const AUTHOR_NOTES = "the author writes this file";

const GATE_CHOICES: readonly { key: GateChoice; label: string }[] = [
  { key: "approve", label: "Approve this file as it stands" },
  { key: "reject", label: "Reject it with notes, and let the writer revise it" },
  { key: "myself", label: "I will write this one myself — write the empty template over it and approve" },
  { key: "import", label: "Import a file I already have — copy it over this one and approve" },
];

/** A name — one line, as the cast question asks for it. The separator is an em dash, an en dash, a
 *  hyphen or a colon, because an author types whichever their keyboard offers; a dash has to carry
 *  whitespace before it so that a hyphenated name ("Jean-Luc — the keeper") is not split at its
 *  own hyphen, while a colon may sit tight against the name ("Jean-Luc: the keeper"). */
const CAST_LINE = /^(.+?)(?:\s+[—–-]+|\s*:)\s+(.+)$/;

/** Refusal of a path the author offered to import. A class of its own so the gate loop can tell
 *  "that path will not do, ask again" from a real I/O fault, which is not the author's to fix. */
class ImportRefused extends Error {
  override readonly name = "ImportRefused";
}

/** The canon template for a bible file: the question list the interview asks, the header it shows
 *  first, and the file the writer agent is pointed at as the format to follow. */
function canonTemplatePath(key: string): string {
  return path.join(templatesDir(), "canon", `${key}.md`);
}

/** True when `child` is `parent` or sits under it. String comparison on resolved paths, which is
 *  what the refusals below need: a path that merely shares a prefix with the directory's name
 *  ("Production-notes" beside "Production") is not inside it. */
function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** Every run log already in a bible file's log directory, ascending — `<runId>.jsonl` and nothing
 *  else, with the run-id alphabet applied to the name exactly as `listRuns` applies it. This is
 *  `runLogPaths` for the reserved setup id, which `listRuns` cannot serve: it validates the
 *  episode id, and the setup id is deliberately not one. Lexical order is creation order, because
 *  `mintRunId` stamps the time into the id. Empty for a file that has never been interviewed. */
async function runLogsIn(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .filter((n) => n.endsWith(JSONL) && RUN_ID.test(n.slice(0, -JSONL.length)))
    .sort()
    .map((n) => path.join(dir, n));
}

/** The answers file's text: one block per question, the heading it answers and the question itself
 *  above the answer. The question is kept in the file for two reasons — the writer agent is told
 *  to read the author's answers "under the question each answers", and a year later the file still
 *  says what was asked, which a bare list of paragraphs would not. */
function answersFileFor(questions: readonly { heading: string; question: string }[], answers: readonly string[]): string {
  return questions
    .map((q, i) => `## ${q.heading}\n<!-- Q: ${q.question} -->\n${(answers[i] ?? "").trim() === "" ? BLANK : (answers[i] as string).trim()}\n`)
    .join("\n");
}

/** The cast the author listed, and the lines that were not in the form the question asked for.
 *  The unparsed lines are returned rather than dropped: a name the driver silently ignored would
 *  be a character with no sheet and no speaker key, discovered episodes later. */
function parseCast(text: string): { cast: { name: string; line: string }[]; ignored: string[] } {
  const cast: { name: string; line: string }[] = [];
  const ignored: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*+]\s+/, "");
    if (line === "") continue;
    const m = CAST_LINE.exec(line);
    if (m) cast.push({ name: m[1]!.trim(), line: m[2]!.trim() });
    else ignored.push(line);
  }
  return { cast, ignored };
}

/** The file as the author is shown it at the gate, with its path above and below so a long file
 *  does not run into the question that follows it. A file that is not on disk is said to be
 *  missing rather than throwing: the gate is still answerable — with a rejection, or by importing
 *  a file — and an exception here would end the interview over a file the agent failed to write. */
async function fileForReview(abs: string, rel: string): Promise<string> {
  try {
    return `--- ${rel} ---\n${await readFile(abs, "utf8")}\n--- end of ${rel} ---`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return `--- ${rel} is not on disk ---`;
    throw err;
  }
}

/** The path to import from, resolved and checked, or an `ImportRefused` naming what is wrong with
 *  it. Every check happens before the gate is answered, because an answer is appended to the log
 *  and a refusal afterwards would leave an approval recorded for a copy that never happened.
 *
 *  Four refusals. A path under the show's production directory, because that is where the
 *  interview's own record lives — the answers the author just typed and the run logs — so such a
 *  path imports the interview's input as its output and makes the record its own source; it is
 *  also where the episode pipeline writes every generated artifact. The destination itself, and
 *  anything beside it in the bible's own directory, because that copies one bible file over
 *  another (or a file over itself, which `copyFile` performs as a no-op, leaving an approval that
 *  records an import that did nothing). A path that does not exist. And a path that is not a
 *  regular file, since `copyFile` from a directory fails after the gate has been answered.
 *
 *  A leading `~` is expanded: the author types this path at a prompt rather than in a shell, so
 *  nothing else expands it for them. A relative path resolves against the process's directory,
 *  which is where the author is standing. */
async function resolveImport(showRoot: string, entry: BibleFile, typed: string): Promise<string> {
  const raw = typed.trim();
  if (raw === "") throw new ImportRefused("no path was given, so there is nothing to import");
  const expanded = raw === "~" ? homedir() : raw.startsWith(`~${path.sep}`) || raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : raw;
  const abs = path.resolve(expanded);
  const destination = path.resolve(showRoot, entry.file);
  const production = path.resolve(showRoot, PRODUCTION_DIR);
  if (inside(abs, production)) {
    throw new ImportRefused(`${abs} is under ${production}, which holds this interview's own answers and run logs; import a file from outside the show instead`);
  }
  if (abs === destination) {
    throw new ImportRefused(`${abs} is the file being written, so importing it over itself would record an import that copied nothing`);
  }
  if (inside(abs, path.dirname(destination))) {
    throw new ImportRefused(`${abs} is beside ${entry.file} in the show's own bible, so importing it would copy one bible file over another`);
  }
  let regular: boolean;
  try {
    regular = (await stat(abs)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ImportRefused(`${abs} does not exist`);
    throw err;
  }
  if (!regular) throw new ImportRefused(`${abs} is not a regular file`);
  return abs;
}

/** One bible file's interview, end to end: the questions, the pipeline, and the gate.
 *
 *  An interviewed file is asked its template's questions and the answers are written to
 *  `<productionDir>/setup/<key>/answers.md`, which is both the record and the `write` agent's
 *  declared input. A default file has no questions and no `write` step, so the template with its
 *  questions stripped is written here, before the gate opens, because the gate is the author
 *  reading that file. Then the file's pipeline is run through the executors it was handed, and
 *  every gate it opens is answered from the terminal: approve, reject with notes, "I will write
 *  this one myself", or "import this file". A rejection runs the fix agent and the gate reopens,
 *  which is why this is a loop and not a single answer.
 *
 *  The driver never commits and never calls git: `init` commits after each file (Task 8), which is
 *  what keeps this testable without a repository. It returns the paths to stage.
 *
 *  Nothing here resumes a run. `resumeRun` reopens a run whose log ends *failed*; a gate answer
 *  leaves the run unfinished rather than failed, so the next `run()` reads the answer out of the
 *  log and carries on by itself — the same two steps the console takes (`answerGate`, then a
 *  worker that calls `run()`). A run that really did fail is thrown from here, with the step. */
export async function interviewFile(showRoot: string, entry: BibleFile, io: InitIO, deps: InterviewDeps): Promise<InterviewResult> {
  if (entry.mode === "scaffold") {
    throw new Error(`${entry.key} is a scaffold file: the pipeline fills it and it has no gate, so it is not interviewed`);
  }
  const now = deps.now ?? ((): Date => new Date());
  const templatePath = canonTemplatePath(entry.key);
  const template = await readFile(templatePath, "utf8");
  const destination = path.resolve(showRoot, entry.file);
  const answers = answersPath(entry.key, PRODUCTION_DIR);
  const staged: string[] = [entry.file];

  io.say(entry.purpose);

  let cast: { name: string; line: string }[] | undefined;
  if (entry.mode === "interview") {
    const parsed = parseCanonTemplate(template);
    if (parsed.header.trim() !== "") io.say(parsed.header.trim());
    const given: string[] = [];
    for (const q of parsed.questions) given.push(await io.ask(q.question, { multiline: true }));
    if (entry.key === CAST_KEY) {
      const listed = parseCast(await io.ask(CAST_QUESTION, { multiline: true }));
      cast = listed.cast;
      io.say(cast.length === 0
        ? "No cast was recorded, so no character sheet is created; add sheets under the bible's characters directory when you have them."
        : `${cast.length} recorded: ${cast.map((c) => c.name).join(", ")}. A sheet is created for each.`);
      if (listed.ignored.length > 0) {
        io.say(`These lines were not in the form \`Name — one line\`, so no sheet is created for them: ${listed.ignored.join(" / ")}`);
      }
    }
    const abs = path.resolve(showRoot, answers);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, answersFileFor(parsed.questions, given), "utf8");
    staged.push(answers);
  } else {
    // A default file's gate opens over a file that must already be there. `wx` so a second
    // attempt — a crash, or a rejection whose fix agent has since edited the file — keeps what is
    // on disk rather than overwriting the work the gate is about to show.
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, templateWithoutQuestions(template), { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  const vars: Record<string, string> = {
    file: entry.file,
    key: entry.key,
    purpose: entry.purpose,
    answersPath: answers,
    templatePath,
    date: now().toISOString().slice(0, 10),
  };
  const pipeline = bibleFilePipeline({ entry, vars, productionDir: PRODUCTION_DIR });
  const dir = bibleLogDir(showRoot, entry.key, PRODUCTION_DIR);
  const runId = mintRunId(now());
  const log = new EventLog(path.join(dir, `${runId}.jsonl`));
  // Every earlier run of this file, oldest first, and never this run's own log: the runner reads
  // that one itself and appends to it as it goes, so handing it over as a prior log would put a
  // stale copy of it in the cache search.
  const priorLogs = (await runLogsIn(dir)).filter((p) => p !== log.path).map((p) => new EventLog(p));
  staged.push(path.relative(showRoot, log.path));

  const ctx = { runId, episodeId: SETUP_ID, showRoot, trigger: deps.operator };
  const once = (): Promise<RunResult> => run({
    pipeline, ctx, log, executors: deps.executors, priorLogs, renderGateMessage: deps.renderGateMessage,
  });

  let result = await once();
  let outcome: InterviewResult["outcome"] = "approved";
  while (result.status === "waiting") {
    const gate = result.gate;
    io.say(gate.message);
    io.say(await fileForReview(destination, entry.file));
    // The inner loop is for an answer that cannot be acted on — an import path that is refused.
    // Nothing has been appended to the log at that point, so the gate is still open at the same
    // attempt and the author is simply asked again.
    answering: for (;;) {
      const choice = await io.choose<GateChoice>(`How do you answer the gate on ${entry.file}?`, GATE_CHOICES);
      const stamp = { by: deps.operator, expectedAttempt: gate.attempt };
      switch (choice) {
        case "approve":
          await answerGate(log, runId, GATE_ID, { approved: true, ...stamp });
          outcome = "approved";
          break answering;
        case "reject": {
          const notes = await io.ask("Notes for the writer", { multiline: true });
          await answerGate(log, runId, GATE_ID, { approved: false, notes, ...stamp });
          break answering;
        }
        case "myself":
          await writeFile(destination, templateWithoutQuestions(template), "utf8");
          await answerGate(log, runId, GATE_ID, { approved: true, notes: AUTHOR_NOTES, ...stamp });
          outcome = "written-by-author";
          break answering;
        case "import": {
          let source: string;
          try {
            source = await resolveImport(showRoot, entry, await io.ask("Path of the file to import"));
          } catch (err) {
            if (err instanceof ImportRefused) { io.say(err.message); continue answering; }
            throw err;
          }
          await copyFile(source, destination);
          await answerGate(log, runId, GATE_ID, { approved: true, notes: `imported from ${source}`, ...stamp });
          outcome = "imported";
          break answering;
        }
      }
    }
    result = await once();
  }
  if (result.status === "failed") throw new Error(`${entry.key}: ${result.stepId} failed: ${result.error}`);

  const done: InterviewResult = { key: entry.key, outcome, runId, commits: [...new Set(staged)].sort() };
  if (cast !== undefined) done.cast = cast;
  return done;
}

/** Whether a bible file's interview has been approved: the latest run under its log directory
 *  finished completed. "Latest" is the lexically last log, which is the most recent one because
 *  `mintRunId` sorts by time. False for a file that has never been interviewed, for one whose run
 *  failed, and for one still waiting at its gate — which is what makes this the question
 *  `init --resume` asks per file before it interviews one again. */
export async function isApproved(showRoot: string, entry: BibleFile, productionDir?: string): Promise<boolean> {
  const logs = await runLogsIn(bibleLogDir(showRoot, entry.key, productionDir));
  const latest = logs[logs.length - 1];
  if (latest === undefined) return false;
  const state = deriveRunState(await new EventLog(latest).read());
  return state.finished && state.status === "completed";
}

import path from "node:path";
import { homedir } from "node:os";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import {
  EventLog, RUN_ID, SETUP_ID, answerGate, answersPath, bibleFilePipeline, bibleLogDir,
  deriveRunState, headingMatches, mintRunId, run,
  type BibleFile, type Executors, type GateMessageRenderer, type RunResult,
} from "@showrunner/engine";
import { templatesDir } from "./paths.js";
import { parseCanonTemplate, templateWithoutQuestions } from "./scaffold.js";

/** The terminal the interview talks through, injected so the driver is testable without a TTY:
 *  `init` passes a readline-backed implementation (Task 8) and the tests pass scripted answers.
 *  `say` prints a block of text; `ask` asks one question and returns the answer, with
 *  `multiline: true` for the answers that are paragraphs or lists; `choose` offers the gate's
 *  four answers and returns the key of the one picked.
 *
 *  `ask`'s `default` is the answer this question already has — the text a previous, unfinished
 *  interview of the same file left in its answers file. An implementation that offers a default
 *  owes the driver one thing: when the author accepts it unchanged, return the default text.
 *  The driver records exactly what `ask` returns and nothing else, so an implementation that
 *  showed a default and then returned an empty string would silently erase the earlier answer. */
export interface InitIO {
  say(text: string): void;
  ask(question: string, opts?: { multiline?: boolean; default?: string }): Promise<string>;
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
 *  as the `by` on every gate answer, so the log says who approved the bible.
 *
 *  `productionDir` is the show's production directory, defaulting to `Production`. Every path the
 *  interview writes hangs off it — the answers, the run logs, and the one directory an import is
 *  refused from — so a show that renames the key in its config must pass it here, or the interview
 *  would log under a tree the rest of the show does not use and `isApproved` would be asked about
 *  the right one. */
export interface InterviewDeps {
  executors: Executors;
  renderGateMessage: GateMessageRenderer;
  now?: () => Date;
  operator: string;
  productionDir?: string;
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

/** The production directory used when `InterviewDeps.productionDir` is absent — the same default
 *  `bibleLogDir`, `answersPath` and the engine's own paths carry. */
const DEFAULT_PRODUCTION_DIR = "Production";

/** The gate's step id, as `bibleFilePipeline` declares it: `answerGate` names the step it answers. */
const GATE_ID = "gate";

const JSONL = ".jsonl";

/** The one interviewed file that also collects the cast, because its `## The primary cast` section
 *  is where the recurring characters are named (`BIBLE_FILES`, `engine/src/bible.ts`). */
const CAST_KEY = "world-overview";

/** The heading whose answer carries the cast. The cast is collected from that one answer and is
 *  never asked for twice: the template's question already asks for it one per line as
 *  `Name — one line about who they are`, and a second question would have given the author two
 *  places to name the cast and the driver no rule for which of the two wins. The heading is
 *  matched through the engine's own `headingMatches`, so punctuation or a parenthetical in the
 *  template's wording does not break the lookup. It is the heading `REQUIRED_SECTIONS`
 *  (`engine/src/bible.ts`) already requires of this file for the character auditor. */
const CAST_HEADING = "The primary cast";

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

/** A name — one line, as the cast question asks for it: an em dash, an en dash or a plain hyphen,
 *  with whitespace on both sides of it, because an author types whichever their keyboard offers.
 *  The name is everything before the separator, trimmed. The whitespace is required so that a
 *  hyphenated name ("Jean-Luc — the keeper") is not split at its own hyphen.
 *
 *  Deliberately no colon, now that this is read out of the prose answer to one of the template's
 *  own questions rather than out of a question of its own: a line like "Note: these five recur"
 *  would otherwise become a character called "Note", with a sheet and a speaker key of its own.
 *  A line that matches nothing is ignored and reported back to the author. */
const CAST_LINE = /^(.+?)\s+[—–-]+\s+(.+)$/;

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

/** The answers an earlier, unfinished interview of this file left behind, by heading — the inverse
 *  of `answersFileFor`, read back so a resumed interview can offer each answer as the default and
 *  the author need not retype a bible they already described. `(blank)` comes back as no answer at
 *  all, because it records a question that was skipped rather than an answer to keep.
 *
 *  A heading the current template no longer carries is simply never looked up, and a heading the
 *  file does not carry yields no default: both are what a template that changed between the two
 *  sittings should do. */
function parsePriorAnswers(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | undefined;
  let body: string[] = [];
  const close = (): void => {
    if (heading !== undefined) {
      const answer = body.join("\n").trim();
      if (answer !== "" && answer !== BLANK) out.set(heading, answer);
    }
    body = [];
  };
  for (const line of text.split("\n")) {
    const m = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m) { close(); heading = m[1] as string; continue; }
    // The question comment is the file's record of what was asked; it is not part of the answer.
    if (/^[ \t]*<!--[ \t]*Q:/.test(line)) continue;
    if (heading !== undefined) body.push(line);
  }
  close();
  return out;
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

/** A path with every symlink in it resolved, or the path itself when it does not exist. The show
 *  root's own anchors go through this before they are compared against anything: a temporary
 *  directory under `/tmp` or `/var` is reached through a symlink on macOS, so a real path and a
 *  resolved-but-not-dereferenced path can name one directory in two spellings and `inside` would
 *  find neither inside the other. */
async function realPathOf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // The file itself may not exist yet — a bible file whose writer agent failed — but its
    // directory does, and that is where the symlinks would be.
    try {
      return path.join(await realpath(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

/** The path to import from, resolved and checked, or an `ImportRefused` naming what is wrong with
 *  it. Every check happens before the gate is answered, because an answer is appended to the log
 *  and a refusal afterwards would leave an approval recorded for a copy that never happened.
 *
 *  The refusals. A path under the show's production directory, because that is where the
 *  interview's own record lives — the answers the author just typed and the run logs — so such a
 *  path imports the interview's input as its output and makes the record its own source; it is
 *  also where the episode pipeline writes every generated artifact. The destination itself, and
 *  anything beside it in the bible's own directory, because that copies one bible file over
 *  another (or a file over itself, which `copyFile` performs as a no-op, leaving an approval that
 *  records an import that did nothing). A path that does not exist. A path that is not a regular
 *  file, since `copyFile` from a directory fails after the gate has been answered. And a symlink,
 *  outright.
 *
 *  **A symlink is refused, and every refusal is applied to the dereferenced path as well as to
 *  the typed one.** `copyFile` and `stat` follow links; the refusals above compare paths. So a
 *  link named anywhere outside the show would otherwise satisfy every one of them while the bytes
 *  copied were the interview's own `answers.md`, the destination itself, or a sibling bible file —
 *  the three outcomes the refusals exist to prevent, laundered through one indirection. An import
 *  is a copy of a file the author names, and a link is not that file, so a link is refused by
 *  `lstat` before anything else is asked; `realpath` then covers the case the link check cannot,
 *  where a *parent directory* on the way to a real file is itself a link.
 *
 *  Returns the dereferenced path — what was actually read — so the gate's notes record the file
 *  the bytes came from rather than a spelling of it.
 *
 *  A leading `~` is expanded: the author types this path at a prompt rather than in a shell, so
 *  nothing else expands it for them. A relative path resolves against the process's directory,
 *  which is where the author is standing. */
async function resolveImport(showRoot: string, entry: BibleFile, typed: string, productionDir: string): Promise<string> {
  const raw = typed.trim();
  if (raw === "") throw new ImportRefused("no path was given, so there is nothing to import");
  const expanded = raw === "~" ? homedir() : raw.startsWith(`~${path.sep}`) || raw.startsWith("~/") ? path.join(homedir(), raw.slice(2)) : raw;
  const abs = path.resolve(expanded);

  // lstat, not stat: the question is what the author named, not what it points at.
  let named: { symlink: boolean; file: boolean };
  try {
    const st = await lstat(abs);
    named = { symlink: st.isSymbolicLink(), file: st.isFile() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ImportRefused(`${abs} does not exist`);
    throw err;
  }
  if (named.symlink) {
    throw new ImportRefused(`${abs} is a symbolic link, and an import copies the file you name; give the path of the file itself`);
  }
  if (!named.file) throw new ImportRefused(`${abs} is not a regular file`);

  const real = await realPathOf(abs);
  const destination = path.resolve(showRoot, entry.file);
  const production = path.resolve(showRoot, productionDir);
  const productions = [production, await realPathOf(production)];
  const destinations = [destination, await realPathOf(destination)];
  // Both spellings of the source are checked against both spellings of each anchor: a link
  // anywhere along either path must not be able to put the source outside a directory it is in.
  for (const candidate of new Set([abs, real])) {
    for (const p of productions) {
      if (inside(candidate, p)) {
        throw new ImportRefused(`${candidate} is under ${p}, which holds this interview's own answers and run logs; import a file from outside the show instead`);
      }
    }
    for (const d of destinations) {
      if (candidate === d) {
        throw new ImportRefused(`${candidate} is the file being written, so importing it over itself would record an import that copied nothing`);
      }
      if (inside(candidate, path.dirname(d))) {
        throw new ImportRefused(`${candidate} is beside ${entry.file} in the show's own bible, so importing it would copy one bible file over another`);
      }
    }
  }
  return real;
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
  const productionDir = deps.productionDir ?? DEFAULT_PRODUCTION_DIR;
  const templatePath = canonTemplatePath(entry.key);
  const template = await readFile(templatePath, "utf8");
  const destination = path.resolve(showRoot, entry.file);
  const answers = answersPath(entry.key, productionDir);
  const staged: string[] = [entry.file];

  io.say(entry.purpose);

  let cast: { name: string; line: string }[] | undefined;
  if (entry.mode === "interview") {
    const parsed = parseCanonTemplate(template);
    if (parsed.header.trim() !== "") io.say(parsed.header.trim());
    // What an earlier, unfinished sitting answered. The answers file is rewritten below, so it is
    // read before anything is asked: this is the only place the earlier text still exists.
    const abs = path.resolve(showRoot, answers);
    let earlier = new Map<string, string>();
    try {
      earlier = parsePriorAnswers(await readFile(abs, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (earlier.size > 0) {
      io.say(`${earlier.size} answer(s) from an earlier sitting are offered back as you go; keep one as it is, or type over it.`);
    }
    const given: string[] = [];
    for (const q of parsed.questions) {
      const prior = earlier.get(q.heading);
      given.push(await io.ask(q.question, prior === undefined ? { multiline: true } : { multiline: true, default: prior }));
    }
    if (entry.key === CAST_KEY) {
      // The cast is read out of the answer to the template's own cast question, never asked for
      // a second time: two questions would be two lists with no rule for which one wins.
      const at = parsed.questions.findIndex((q) => headingMatches(`## ${q.heading}`, CAST_HEADING));
      if (at === -1) {
        cast = [];
        io.say(`This template has no \`## ${CAST_HEADING}\` question, so no cast was recorded and no character sheet is created.`);
      } else {
        const listed = parseCast(given[at] ?? "");
        cast = listed.cast;
        io.say(cast.length === 0
          ? "No cast was recorded, so no character sheet is created; add sheets under the bible's characters directory when you have them."
          : `${cast.length} recorded: ${cast.map((c) => c.name).join(", ")}. A sheet is created for each.`);
        if (listed.ignored.length > 0) {
          io.say(`These lines of that answer were not in the form \`Name — one line\`, so no sheet is created for them: ${listed.ignored.join(" / ")}`);
        }
      }
    }
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
  const pipeline = bibleFilePipeline({ entry, vars, productionDir });
  const dir = bibleLogDir(showRoot, entry.key, productionDir);
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
            source = await resolveImport(showRoot, entry, await io.ask("Path of the file to import"), productionDir);
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

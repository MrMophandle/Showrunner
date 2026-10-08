import path from "node:path";
import { homedir } from "node:os";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import {
  EventLog, RUN_ID, SETUP_ID, answerGate, answersPath, bibleFilePipeline, bibleLogDir,
  deriveRunState, headingMatches, mintRunId, run,
  type BibleFile, type Executors, type GateMessageRenderer, type RunResult,
} from "@showrunner/engine";
import { templatesDir } from "./paths.js";
import { CAST_NAME, parseCanonTemplate, templateWithoutQuestions, type Question } from "./scaffold.js";

/** One question the interview asks and the bible section whose answer it is, re-exported from
 *  `scaffold.ts` where it is declared beside the template parser that produces it. The console
 *  renders these as a form and reads them back by heading, so it must have the type without
 *  importing the scaffold writer; a second declaration of the same two fields would be a second
 *  spelling of the one contract `questionsFor`, `readAnswers` and `writeAnswers` share. */
export type { Question } from "./scaffold.js";

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
 *  is where the recurring characters are named (`BIBLE_FILES`, `engine/src/bible.ts`).
 *
 *  Exported because `init` needs it too and had a second copy of the literal. `init` cannot ask
 *  `result.cast !== undefined` instead: the catch-up commit a `--resume` makes has no interview
 *  result to read, because the interview it is cleaning up after finished in an earlier process,
 *  and that commit's path list is longer for this one file. */
export const CAST_KEY = "world-overview";

/** The heading whose answer carries the cast. The cast is collected from that one answer and is
 *  never asked for twice: the template's question already asks for it one per line as
 *  `Name — one line about who they are`, and a second question would have given the author two
 *  places to name the cast and the driver no rule for which of the two wins. The heading is
 *  matched through the engine's own `headingMatches`, so punctuation or a parenthetical in the
 *  template's wording does not break the lookup. It is the heading `REQUIRED_SECTIONS`
 *  (`engine/src/bible.ts`) already requires of this file for the character auditor.
 *
 *  Exported because the console reads the cast out of `readAnswers`' heading-keyed record before
 *  it calls `afterFileApproved`, and a second spelling of this string there would be a browser
 *  interview that writes no character sheet and leaves `audio.mainCast` naming only the narrator. */
export const CAST_HEADING = "The primary cast";

/** What an unanswered question records in the answers file. The writer agent is told that a
 *  heading whose question was left blank gets `_Not yet decided._`, so the blank has to be visible
 *  in the file rather than being an absent section the agent cannot tell from a lost one. */
const BLANK = "(blank)";

/** The notes recorded on the approval when the author takes the file over. The notes are the log's
 *  record of why an approved file holds nothing but headings.
 *
 *  Exported because the console both writes it — its gate panel offers the same four answers — and
 *  reads it back: a bible row is `written-by-author` exactly when the approving `gate_answered`
 *  carries these notes, and a file approved this way in the terminal must read the same in the
 *  browser. Two spellings would be two states for one decision. */
export const AUTHOR_NOTES = "the author writes this file";

/** What an approval's notes begin with when the file was imported, with the source path after it.
 *  Exported for the same reason as `AUTHOR_NOTES`: the console writes these notes when its gate
 *  panel imports a file and derives the `imported` row state by reading them back, and the state
 *  must be the same for a file imported from the terminal. */
export const IMPORT_NOTES_PREFIX = "imported from ";

/** The gate's four answers, with the wording the author reads. Exported because the terminal and
 *  the console must offer the same four and word them the same way: the console renders one button
 *  per entry, and a fifth answer invented in a React component would be an answer `answerGate` has
 *  no meaning for. */
export const GATE_CHOICES: readonly { key: GateChoice; label: string }[] = [
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

/** A moment as the author's own calendar date, `YYYY-MM-DD`.
 *
 *  The interview stamps every law it writes `— DRAFT (interview <date>)`
 *  (`tools/templates/interview/write.md`), and that date is the day the author sat down, which is
 *  their calendar's day and not Greenwich's. `toISOString().slice(0, 10)` is UTC, so an interview
 *  run on any evening west of Greenwich stamped tomorrow's date on every law in the bible — a
 *  retrospective stamp (the plan's F-08) that disagrees with the author's own memory of when they
 *  said it. The run id keeps its UTC stamp: a run id is the engine's, and sorting run logs by time
 *  across machines is what it is for. */
function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Refusal of a path the author offered to import. A class of its own so the gate loop can tell
 *  "that path will not do, ask again" from a real I/O fault, which is not the author's to fix.
 *
 *  Exported with `resolveImport` because the console's gate route has to make the same
 *  distinction: a refused path is a 400 the author can correct, and an I/O fault is a 500 that is
 *  not theirs. Matching on the class rather than on the message keeps the console from parsing
 *  prose this module is free to reword. */
export class ImportRefused extends Error {
  override readonly name = "ImportRefused";
}

/** The canon template for a bible file: the question list the interview asks, the header it shows
 *  first, and the file the writer agent is pointed at as the format to follow. */
function canonTemplatePath(key: string): string {
  return path.join(templatesDir(), "canon", `${key}.md`);
}

/** The interview's own prompt directory: `write.md`, `gate.md` and `revise.md` ship with the
 *  engine's templates rather than being copied into the show, because they are the setup's prompts
 *  and not the show's. The show's own prompt set is copied into `prompts/` by the scaffold.
 *
 *  Exported, and here rather than in `init.ts`, because three callers now need the same directory:
 *  `init`'s own executors, the console's setup worker — which runs in a process of its own and
 *  would otherwise resolve the show's `prompts/` and render an episode prompt for a bible step —
 *  and the tests that drive a gate message. */
export function interviewPromptsDir(): string {
  return path.join(templatesDir(), "interview");
}

/** The questions one bible file's canon template asks, in the template's order: the heading each
 *  answer is written under and the question itself.
 *
 *  Exported because the console's New-show surface *is* these questions — one textarea per entry,
 *  prefilled from `readAnswers` — and because `writeAnswers` needs the same list to write every
 *  heading the writer agent and `bible-check` both read. Empty for a `default` or `scaffold` file,
 *  which has no interview: the author reviews those at a gate without being asked anything. */
export async function questionsFor(entry: BibleFile): Promise<Question[]> {
  return parseCanonTemplate(await readFile(canonTemplatePath(entry.key), "utf8")).questions;
}

/** The six variables `bibleFilePipeline`'s three prompts render: `file`, `key`, `purpose`,
 *  `answersPath`, `templatePath` and `date`.
 *
 *  Exported because the console's setup worker builds the same pipeline in a process of its own,
 *  and a seventh spelling of these six keys would be a prompt rendering an empty string — the one
 *  failure a prompt does not announce. `date` is the author's own calendar date and not
 *  Greenwich's, for the reason `localDate` records, which is also why the clock arrives here as a
 *  `Date` and not as a string. `showRoot` is taken but not read: every file-addressed function in
 *  this module takes the show root first, and a caller that had to drop it for this one would be
 *  the caller most likely to pass the arguments in the wrong order. */
export function buildVars(showRoot: string, entry: BibleFile, now: Date, productionDir?: string): Record<string, string> {
  void showRoot;
  return {
    file: entry.file,
    key: entry.key,
    purpose: entry.purpose,
    answersPath: answersPath(entry.key, productionDir),
    templatePath: canonTemplatePath(entry.key),
    date: localDate(now),
  };
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

/** The index of the first of `headings` at or after `from` that `line` is the heading of, or -1.
 *
 *  This is what makes a line in an answers file a section boundary: **only a `## <heading>` line
 *  naming one of the template's own headings**, which is exactly what `answersFileFor` writes.
 *  Any other line that happens to begin with `##` — a prose answer illustrating a markdown
 *  heading, say — is part of the answer it sits in, and treating it as a boundary truncated the
 *  default a resumed interview offered back, which an author who accepted the default then
 *  recorded as their answer.
 *
 *  The search starts at `from`, so the headings are matched in the order the template declares
 *  them: a line inside a later answer that repeats an earlier heading cannot reopen that section.
 *  A line matching a heading still to come is a boundary, which is the rule's one remaining edge
 *  and the price of reading a flat file without escaping anything in it.
 *
 *  `headingMatches` does the comparison, so case, `&`/"and", punctuation and a parenthetical do
 *  not count — and the direction is the engine's: the document's line first, the canonical heading
 *  second, because the test is a whole-word prefix on the line. */
function headingAt(line: string, headings: readonly string[], from = 0): number {
  for (let i = from; i < headings.length; i++) {
    if (headingMatches(line, headings[i] as string)) return i;
  }
  return -1;
}

/** The index of the template question whose heading is `wanted`, or -1 — the same rule as
 *  `headingAt`, asked the other way round: here the template's heading is the document line and
 *  `wanted` is the canonical name, because the template may carry a parenthetical the required
 *  name does not ("## The primary cast (the crew)" carries "The primary cast"). */
function questionIndexFor(headings: readonly string[], wanted: string): number {
  return headings.findIndex((h) => headingMatches(`## ${h}`, wanted));
}

/** The answers an earlier, unfinished interview of this file left behind, by heading — the inverse
 *  of `answersFileFor`, read back so a resumed interview can offer each answer as the default and
 *  the author need not retype a bible they already described. `(blank)` comes back as no answer at
 *  all, because it records a question that was skipped rather than an answer to keep.
 *
 *  `headings` are the template's own question headings, in order, and they are the only thing that
 *  opens a section (see `headingAt`); the keys of the returned map are those headings rather than
 *  the file's spelling of them, so the caller looks an answer up by the heading it is asking
 *  about. A heading the current template no longer carries is never looked for, and a heading the
 *  file does not carry yields no default: both are what a template that changed between the two
 *  sittings should do. */
function parsePriorAnswers(text: string, headings: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let open: string | undefined;
  let next = 0;
  let body: string[] = [];
  const close = (): void => {
    if (open !== undefined) {
      const answer = body.join("\n").trim();
      if (answer !== "" && answer !== BLANK) out.set(open, answer);
    }
    body = [];
  };
  for (const line of text.split("\n")) {
    const at = headingAt(line, headings, next);
    if (at !== -1) {
      close();
      open = headings[at] as string;
      next = at + 1;
      continue;
    }
    if (open === undefined) continue;
    // The question comment `answersFileFor` writes directly under the heading is the file's record
    // of what was asked, and not part of the answer. Only that one line is dropped — the first of
    // the section — so a comment inside the answer's own text is the author's and is kept.
    if (body.length === 0 && /^[ \t]*<!--[ \t]*Q:/.test(line)) continue;
    body.push(line);
  }
  close();
  return out;
}

/** Writes a bible file's answers file whole — `<productionDir>/setup/<key>/answers.md` — and
 *  returns its path relative to the show root, which is the path a caller stages for the file's
 *  commit.
 *
 *  Exported because the console writes the author's answers as a one-shot request, outside any run,
 *  the way the server writes `premise.md`: the form posts what it holds and the answers are on disk
 *  before any writer agent is started. The whole file is rewritten and never appended to, for the
 *  reason the question loop records: `answersFileFor` emits every one of the template's headings
 *  with `(blank)` under the questions that have no answer, which is the shape the writer agent and
 *  `bible-check` both need, and a truncated rewrite loses at most the answer in flight where a
 *  truncated append would leave a half-written heading block for `parsePriorAnswers` to read as
 *  part of the answer above it.
 *
 *  **The consequence a caller owes: `answers` is the whole file, not a patch.** A heading absent
 *  from it is written back as `(blank)`, so a form holding one answer must read the rest with
 *  `readAnswers` first. The record is keyed by heading because that is how the file is read back,
 *  and no canon template carries one heading twice. */
export async function writeAnswers(showRoot: string, entry: BibleFile, answers: Record<string, string>, productionDir?: string): Promise<string> {
  const rel = answersPath(entry.key, productionDir);
  const abs = path.resolve(showRoot, rel);
  const questions = await questionsFor(entry);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, answersFileFor(questions, questions.map((q) => answers[q.heading] ?? "")), "utf8");
  return rel;
}

/** The answers already on disk for a bible file, by heading — `{}` when the file has never been
 *  answered, and never an entry for a question recorded as `(blank)`, because that records a
 *  question the author skipped rather than an answer to keep.
 *
 *  Exported because this is how a second visit continues an interview with no new persistence: the
 *  terminal offers each answer back as that question's default and the console prefills the same
 *  text into the form, both reading the file the question loop rewrites after every answer. A
 *  heading the current template no longer carries is never looked for, and a heading the file does
 *  not carry yields nothing: both are what a template that changed between two sittings should do. */
export async function readAnswers(showRoot: string, entry: BibleFile, productionDir?: string): Promise<Record<string, string>> {
  const abs = path.resolve(showRoot, answersPath(entry.key, productionDir));
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return {};
  }
  const headings = (await questionsFor(entry)).map((q) => q.heading);
  return Object.fromEntries(parsePriorAnswers(text, headings));
}

/** The cast the author listed, and the lines that were not in the form the question asked for.
 *  The unparsed lines are returned rather than dropped: a name the driver silently ignored would
 *  be a character with no sheet and no speaker key, discovered episodes later.
 *
 *  **A line whose name `CAST_NAME` refuses is an unparsed line, not a cast member.** `CAST_LINE`'s
 *  first group is lazy, so it matches at the first spaced dash on the line — which any prose
 *  paragraph with an em dash in it has. That is how a `## The primary cast` section written as
 *  prose rather than as a list (an imported bible file's, read by `castSectionOf`) yielded a
 *  hundred-character "name" carrying asterisks and commas, which `writeCastSheets` then refused
 *  with a throw that ended the whole setup. The one rule that decides what is a usable name lives
 *  in `scaffold.ts` beside the function that writes the sheet, and is applied here first.
 *
 *  Exported because the console's gate route must build the same `InterviewResult.cast` the
 *  terminal builds before it calls `afterFileApproved`, which is what writes the character sheets
 *  and `audio.mainCast`. A second parser in the console would be a second rule for what counts as
 *  a name, and the one that disagreed would either refuse a cast `writeCastSheets` accepts or hand
 *  it a name it throws on. */
export function parseCast(text: string): { cast: { name: string; line: string }[]; ignored: string[] } {
  const cast: { name: string; line: string }[] = [];
  const ignored: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*+]\s+/, "");
    if (line === "") continue;
    const m = CAST_LINE.exec(line);
    const name = m === null ? "" : m[1]!.trim();
    if (m !== null && CAST_NAME.test(name)) cast.push({ name, line: m[2]!.trim() });
    else ignored.push(line);
  }
  return { cast, ignored };
}

/** The `## The primary cast` section of a bible file on disk, parsed with the same two rules a
 *  typed answer is parsed with — `undefined` when the file is not there or carries no such
 *  section, so the caller can tell "the section holds no names" from "there is no section".
 *
 *  This is what an **imported** `world-overview.md` is read with. Before it existed, `init` wrote
 *  `audio.mainCast = ["narrator"]` over a config that should have named every speaker of an
 *  imported show, no character sheet was written, and `scripts/validate-manifest.py` then refused
 *  every TTS manifest whose speaker was a cast member with no guest WAV. The heading is found
 *  through the engine's `headingMatches`, so an imported file whose heading carries a
 *  parenthetical still matches; the section ends at the next level-1 or level-2 heading.
 *
 *  Exported with `parseCast` because the console reaches the same two cases: a file the author
 *  imported at its gate, and a file they wrote themselves, neither of which has a typed cast
 *  answer to read. */
export async function castSectionOf(abs: string): Promise<{ cast: { name: string; line: string }[]; ignored: string[] } | undefined> {
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const lines = text.split("\n");
  const at = lines.findIndex((l) => headingMatches(l, CAST_HEADING));
  if (at === -1) return undefined;
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^##?\s/.test(lines[i] as string)) break;
    body.push(lines[i] as string);
  }
  return parseCast(body.join("\n"));
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
 *  which is where the author is standing.
 *
 *  **Exported because the console's gate route imports a file through this function and not
 *  through a copy of it.** Every refusal above is a fence, and a fence that exists twice is a
 *  fence that diverges: the console's copy would be the one that forgot `lstat`, or compared only
 *  the typed spelling, and the failure would be a bible file silently overwritten by the
 *  interview's own `answers.md` through one symlink. One implementation, two callers. The path the
 *  browser sends is the author's typed path, exactly as the terminal's prompt yields one. */
export async function resolveImport(showRoot: string, entry: BibleFile, typed: string, productionDir: string): Promise<string> {
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
export async function interviewFile(showRoot: string, entry: BibleFile, io: InitIO, deps: InterviewDeps, candidate?: string): Promise<InterviewResult> {
  if (entry.mode === "scaffold") {
    throw new Error(`${entry.key} is a scaffold file: the pipeline fills it and it has no gate, so it is not interviewed`);
  }
  const now = deps.now ?? ((): Date => new Date());
  const productionDir = deps.productionDir ?? DEFAULT_PRODUCTION_DIR;
  const templatePath = canonTemplatePath(entry.key);
  const template = await readFile(templatePath, "utf8");
  const parsed = parseCanonTemplate(template);
  const headings = parsed.questions.map((q) => q.heading);
  const destination = path.resolve(showRoot, entry.file);
  const answers = answersPath(entry.key, productionDir);
  const abs = path.resolve(showRoot, answers);
  const staged: string[] = [entry.file];

  io.say(entry.purpose);

  // **The import is offered before a single question is asked.** An author who already has this
  // file is otherwise asked every one of its questions and then charged for a writer agent whose
  // output the import overwrites at the gate — measured at roughly $2.24 a file on the writer
  // model, and thirteen files for a whole bible — and is left with an answers file on disk that
  // contradicts the file beside it. Declining here puts the author back on the path they were on
  // before: the questions are asked, the writer runs, and `import` is still one of the gate's
  // four answers with this path filled in.
  let imported: string | undefined;
  if (candidate !== undefined) {
    const offered = await io.choose<"import" | "ask">(`${entry.file}: how do you want this file written?`, [
      { key: "import", label: `Import ${candidate} — copy it over ${entry.file} and review it` },
      { key: "ask", label: entry.mode === "interview" ? "Answer the questions, and let the writer draft it from your answers" : "Keep the house default, and review it" },
    ]);
    if (offered === "import") {
      try {
        imported = await resolveImport(showRoot, entry, candidate, productionDir);
      } catch (err) {
        if (!(err instanceof ImportRefused)) throw err;
        io.say(`${err.message}. Nothing was imported; the questions are asked instead, and the import is still offered at the gate.`);
      }
      if (imported !== undefined) {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(imported, destination);
        io.say(`${entry.file} is ${imported}, copied here. No question was asked and the writer agent did not run: the gate below is over the imported file.`);
      }
    }
  }

  let cast: { name: string; line: string }[] | undefined;
  const given: string[] = [];
  // An interviewed file whose import was taken is not interviewed: its questions would be asked
  // about a file that is already written, and the answers would contradict it.
  const interviewed = entry.mode === "interview" && imported === undefined;
  if (interviewed) {
    if (parsed.header.trim() !== "") io.say(parsed.header.trim());
    // What an earlier, unfinished sitting answered, read through the same function the console's
    // form prefills itself from. The answers file is rewritten below, so it is read before
    // anything is asked: this is the only place the earlier text still exists.
    const earlier = new Map(Object.entries(await readAnswers(showRoot, entry, productionDir)));
    if (earlier.size > 0) {
      io.say(`${earlier.size} answer(s) from an earlier sitting are offered back as you go; keep one as it is, or type over it.`);
    }
    await mkdir(path.dirname(abs), { recursive: true });
    staged.push(answers);
    // The answers file is rewritten after **every** answer and not once after the last one. An
    // author nine multiline answers into a file who presses Ctrl-C, closes the terminal or runs
    // out of piped stdin keeps every word they typed, which is what `main.ts`'s "what was written
    // is committed; run again with --resume" promises them: `--resume` reads this file back and
    // offers each answer as that question's default (`parsePriorAnswers`).
    //
    // The whole file is rewritten rather than appended to, because `answersFileFor` emits every
    // one of the template's headings with `(blank)` under the questions not yet reached — the
    // shape the writer agent and `bible-check` both need — and a truncated rewrite loses at most
    // the answer in flight where a truncated append would leave a half-written heading block for
    // `parsePriorAnswers` to read as part of the answer above it.
    //
    // A question this sitting has not reached is written back from `earlier`, not blanked: on a
    // resumed interview the first rewrite would otherwise erase every answer below the one being
    // typed, which is the very loss this fix exists to prevent.
    //
    // The write goes through `writeAnswers`, which is also the console's one-shot write, so the
    // terminal and the browser cannot put differently shaped answers files on disk for the same
    // show. It takes the answers by heading and this loop holds them by index, hence the record
    // built here; no canon template carries one heading twice.
    const record = async (): Promise<void> => {
      await writeAnswers(
        showRoot,
        entry,
        Object.fromEntries(parsed.questions.map((q, i) => [q.heading, given[i] ?? earlier.get(q.heading) ?? ""])),
        productionDir,
      );
    };
    for (const q of parsed.questions) {
      const prior = earlier.get(q.heading);
      given.push(await io.ask(q.question, prior === undefined ? { multiline: true } : { multiline: true, default: prior }));
      await record();
    }
  } else if (imported === undefined) {
    // A default file's gate opens over a file that must already be there. `wx` so a second
    // attempt — a crash, or a rejection whose fix agent has since edited the file — keeps what is
    // on disk rather than overwriting the work the gate is about to show. An imported file skips
    // this: the import *is* the file, and writing the house default over it first and then being
    // overwritten would put a file the author never sees on disk for the length of one gate.
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, templateWithoutQuestions(template), { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  const vars = buildVars(showRoot, entry, now(), productionDir);
  // An imported file's pipeline is the gate alone. `bibleFilePipeline` pushes the `write` step for
  // an `interview` entry and not for a `default` one, so handing it the entry with its mode
  // rewritten is how the writer agent is skipped — the one thing I5 asks for — without the engine
  // needing to know that an import happened. The gate keeps its `onReject` fix agent, so an
  // author who rejects an imported file with notes still gets it revised.
  const pipeline = bibleFilePipeline({ entry: imported === undefined ? entry : { ...entry, mode: "default" }, vars, productionDir });
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
  // The outcome the commit message is worded from. A file that was imported before the questions
  // and then simply approved was recorded as "approved", which told the show's history that an
  // agent had written from the author's answers a file nobody had answered anything about. A
  // rejection hands the file to the fix agent, so from that point it is no longer the import.
  let untouchedImport = imported !== undefined;
  let outcome: InterviewResult["outcome"] = untouchedImport ? "imported" : "approved";
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
          outcome = untouchedImport ? "imported" : "approved";
          break answering;
        case "reject": {
          const notes = await io.ask("Notes for the writer", { multiline: true });
          await answerGate(log, runId, GATE_ID, { approved: false, notes, ...stamp });
          untouchedImport = false;
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
            // The candidate `init` found in the imported show is this question's default, so an
            // author who declined the import before the questions and changed their mind at the
            // gate does not have to type the path out.
            const typed = await io.ask("Path of the file to import", candidate === undefined ? undefined : { default: candidate });
            source = await resolveImport(showRoot, entry, typed, productionDir);
          } catch (err) {
            if (err instanceof ImportRefused) { io.say(err.message); continue answering; }
            throw err;
          }
          await copyFile(source, destination);
          await answerGate(log, runId, GATE_ID, { approved: true, notes: `${IMPORT_NOTES_PREFIX}${source}`, ...stamp });
          imported = source;
          untouchedImport = true;
          outcome = "imported";
          break answering;
        }
      }
    }
    result = await once();
  }
  if (result.status === "failed") throw new Error(`${entry.key}: ${result.stepId} failed: ${result.error}`);

  // **The cast, from whichever source yielded names.** It is resolved after the gate rather than
  // in the question loop because the gate is where a file can still become an imported one, and
  // because an import run never reaches the question loop at all. The order of preference is the
  // author's typed answer, then the file on disk when that file was imported, then one question
  // asked here — never two of them at once, because two lists would be two casts with no rule for
  // which wins. The cast question is found by heading through `headingMatches` and never by a
  // bare string, the same way the answers file is parsed.
  if (entry.key === CAST_KEY) {
    const at = questionIndexFor(headings, CAST_HEADING);
    if (at === -1) {
      cast = [];
      io.say(`This template has no \`## ${CAST_HEADING}\` question, so no cast was recorded and no character sheet is created.`);
    } else {
      let listed = interviewed ? parseCast(given[at] ?? "") : { cast: [] as { name: string; line: string }[], ignored: [] as string[] };
      if (listed.cast.length === 0 && imported !== undefined) {
        const inFile = await castSectionOf(destination);
        if (inFile !== undefined && inFile.cast.length > 0) {
          listed = inFile;
          io.say(`The cast is read from \`## ${CAST_HEADING}\` of the imported ${entry.file}.`);
        } else if (!interviewed) {
          // Nothing usable in the imported file and no question was ever asked. Asking it here is
          // the difference between a config that names every speaker of the show and one that
          // names only the narrator, which `scripts/validate-manifest.py` then refuses every
          // manifest against.
          io.say(inFile === undefined
            ? `The imported ${entry.file} carries no \`## ${CAST_HEADING}\` section, so no cast could be read from it.`
            : `The \`## ${CAST_HEADING}\` section of the imported ${entry.file} holds no \`Name — one line\` line, so no cast could be read from it.`);
          if (inFile !== undefined && inFile.ignored.length > 0) {
            io.say(`What that section holds instead: ${inFile.ignored.join(" / ")}`);
          }
          const question = parsed.questions[at] as Question;
          const typed = await io.ask(question.question, { multiline: true });
          listed = parseCast(typed);
          // Recorded under the cast heading, so a `--resume` of this file offers it back as the
          // default rather than asking for the cast a second time. The file holds this one
          // question and nothing else: no other question was asked in this sitting, and a file of
          // `(blank)` answers would claim the author had skipped questions they were never put.
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, answersFileFor([question], [typed]), "utf8");
          staged.push(answers);
        }
      }
      cast = listed.cast;
      io.say(cast.length === 0
        ? "No cast was recorded, so no character sheet is created; add sheets under the bible's characters directory when you have them."
        : `${cast.length} recorded: ${cast.map((c) => c.name).join(", ")}. A sheet is created for each.`);
      if (listed.ignored.length > 0) {
        io.say(`These lines were not in the form \`Name — one line\`, so no sheet is created for them: ${listed.ignored.join(" / ")}`);
      }
    }
  }

  const done: InterviewResult = { key: entry.key, outcome, runId, commits: [...new Set(staged)].sort() };
  if (cast !== undefined) done.cast = cast;
  return done;
}

/** The absolute path of the most recent run log of a bible file's interview, or `undefined` when
 *  the file has never been interviewed. "Most recent" is the lexically last log, which is the
 *  latest one because `mintRunId` stamps the time into the id.
 *
 *  Exported because this one log is the whole state of a bible file: the console's Bible view reads
 *  it to say whether a file is waiting at a gate, running, approved or failed, and it must give the
 *  same answer for a file interviewed in the terminal as for one interviewed in the browser. The
 *  path is absolute so a caller can hand it straight to `EventLog`. */
export async function latestSetupLog(showRoot: string, entry: BibleFile, productionDir?: string): Promise<string | undefined> {
  const logs = await runLogsIn(bibleLogDir(showRoot, entry.key, productionDir));
  return logs[logs.length - 1];
}

/** Whether a bible file's interview has been approved: the latest run under its log directory
 *  finished completed. False for a file that has never been interviewed, for one whose run
 *  failed, and for one still waiting at its gate — which is what makes this the question
 *  `init --resume` asks per file before it interviews one again, and the question `initFinish`
 *  asks per file to say which files are still the author's to finish. */
export async function isApproved(showRoot: string, entry: BibleFile, productionDir?: string): Promise<boolean> {
  const latest = await latestSetupLog(showRoot, entry, productionDir);
  if (latest === undefined) return false;
  const state = deriveRunState(await new EventLog(latest).read());
  return state.finished && state.status === "completed";
}

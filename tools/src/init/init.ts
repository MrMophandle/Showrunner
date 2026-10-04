import path from "node:path";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import {
  BIBLE_FILES, answersPath, bibleLogDir, createAgentExecutor, createGateMessageRenderer,
  loadShowConfig, scriptExecutor, sdkQuery,
  type BibleFile, type Executors, type GateMessageRenderer, type ShowConfig,
} from "@showrunner/engine";
import { bibleCheck, bibleCheckLines } from "../bible-check.js";
import { buildShowConfig, showConfigText } from "./config.js";
import { ghAuthOk, ghRepoCreate, gitCommit, gitDirty, gitHasHead, gitInit, gitRemotes, type GitDeps } from "./git.js";
import { CAST_KEY, interviewFile, isApproved, type InitIO, type InterviewDeps, type InterviewResult } from "./interview.js";
import { templatesDir } from "./paths.js";
import { templateWithoutQuestions, writeCastSheets, writeScaffold } from "./scaffold.js";

/** What `init` was asked to make. `name` is the show's name as it is written; `slug` defaults to
 *  the name with every non-alphanumeric character removed; `path` is the directory the show
 *  repository is created in; `nasRoot` defaults to `/Volumes/media/<slug>`; `github` says whether
 *  to create the GitHub repository at the end and how visible it is; `engineRoot` is the engine
 *  repository, which the printed next steps name as the console's `--engine-root`; `importFrom` is
 *  an existing show repository whose bible files are offered for import, file by file; `resume`
 *  continues a setup that was interrupted, which is the only way `init` will touch a directory
 *  that is not empty. */
export interface InitOptions {
  name: string;
  slug?: string;
  path: string;
  nasRoot?: string;
  github: "private" | "public" | "none";
  engineRoot: string;
  importFrom?: string;
  resume?: boolean;
}

/** The seams. `executors` and `renderGateMessage` are the real ones built from the show's own
 *  config when they are absent, which is what `showrunner-init` relies on — see `realInterviewDeps`
 *  for why they cannot be built before `runInit` runs. `git` carries the injectable `spawn`, so a
 *  test can watch every git and `gh` argv. `now` is the clock the run ids and the interview's date
 *  stamp come from. `operator` is recorded as the trigger of every run and the `by` of every gate
 *  answer: the log says who approved the bible. */
export interface InitDeps {
  executors?: Executors;
  renderGateMessage?: GateMessageRenderer;
  git?: GitDeps;
  now?: () => Date;
  operator?: string;
}

/** What `init` did. `root` is the show's directory with every symlink in it resolved, which is
 *  where the files actually are. `files` is one entry per bible file that reached an approval, in
 *  interview order. `stalled` is the key of every bible file whose gate was rejected to
 *  exhaustion — empty on a clean run; those files are on disk as the writer last revised them and
 *  are the author's to finish or to re-run with `--resume`, and they are not in `files` because
 *  they never reached an approval. `commits` is every sha `init` made, the scaffold's first.
 *  `remote` is the GitHub URL when one was created. `nextSteps` is the show README's own "Your
 *  first episode" section, read back from the show on disk so the instructions the author is left
 *  with are the ones in their own repository. */
export interface InitReport {
  root: string;
  files: InterviewResult[];
  stalled: string[];
  commits: string[];
  remote?: string;
  nextSteps: string;
}

/** A slug is what names files: it starts with a letter and carries only letters and digits, because
 *  it is rendered into `output.mixFilename` and into the names of files on the NAS. */
const SLUG_OK = /^[A-Za-z][A-Za-z0-9]*$/;

/** The default NAS parent. A show's own directory under it is `output.nasRoot`, and the parent is
 *  `output.nasMount` — the mount the episode pipeline refuses to render video without. */
const NAS_PARENT = "/Volumes/media";

/** The README section `init` reads back and prints as the next steps. */
const NEXT_STEPS_HEADING = "Your first episode";

/** The interview's own prompt directory: `write.md`, `gate.md` and `revise.md` ship with the
 *  engine's templates rather than being copied into the show, because they are the setup's prompts
 *  and not the show's. The show's own prompt set is copied into `prompts/` by the scaffold. */
function interviewPromptsDir(): string {
  return path.join(templatesDir(), "interview");
}

/** The failure `interviewFile` throws when a gate has been rejected its maximum number of times.
 *  `init` treats it as a stall rather than an abort: the file on disk is the last revision the
 *  writer made, the author can finish it by hand, and the rest of the bible is still worth
 *  interviewing in this sitting. Matched on the engine's own wording for an exhausted gate. */
const GATE_EXHAUSTED = /: gate failed: rejected \d+ times?$/;

/** A show name as a slug: every non-alphanumeric character removed, so "Harbor Lights" becomes
 *  "HarborLights". Nothing is lower-cased — the slug is read by people in file names — and nothing
 *  is substituted for a space, because `output.mixFilename` renders the slug into a filename and a
 *  hyphen there would be a second spelling of the show's name. */
export function slugFrom(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "");
}

/** One level-2 section of a Markdown document, from its heading to the next level-2 heading or the
 *  end. `init` reads the show README's "Your first episode" section back off disk rather than
 *  printing a copy of it, so the instructions the author is told are the instructions their own
 *  repository carries; an edit to the README template changes both at once. Throws when the
 *  heading is absent, because a silent empty next-steps would leave an author with nothing to do
 *  at the end of an hour of interviews. */
export function readmeSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##[ \t]+/.test(l) && l.replace(/^##[ \t]+/, "").trim() === heading);
  if (start === -1) throw new Error(`the show README has no "## ${heading}" section, so there are no next steps to print`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##[ \t]+/.test(lines[i] as string)) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trim();
}

/** The real executors and gate-message renderer, built from the show's own config.
 *
 *  They are built here rather than by the CLI because they cannot exist before `runInit` runs:
 *  `createAgentExecutor` takes the show config, which supplies the model tier names the interview's
 *  steps declare — and on a fresh `init` that config does not exist until `runInit` has written it.
 *  `promptsDir` is the interview's own template directory and not the show's `prompts/`. */
function realInterviewDeps(config: ShowConfig): { executors: Executors; renderGateMessage: GateMessageRenderer } {
  const options = { query: sdkQuery, promptsDir: interviewPromptsDir(), show: config };
  return {
    executors: { agent: createAgentExecutor(options), script: scriptExecutor },
    renderGateMessage: createGateMessageRenderer(options),
  };
}

/** `--path`, as an absolute path with every symlink in it resolved, which is the path everything
 *  after this uses: the show root, the commit's `cwd`, the `gh repo create --source`, the report.
 *
 *  A symlinked directory is followed and not refused — a home directory tree is often reached
 *  through one, and an author who points `--path` at a link means the directory it names. What is
 *  refused is a `--path` that exists and is not a directory. Resolving it up front is what keeps
 *  every later path honest: `--import`'s refusals compare the source against the show root
 *  (`resolveImport` in `tools/src/init/interview.ts`), and two spellings of one directory would
 *  make a file that is inside the show look as though it were outside it.
 *
 *  A path that does not exist yet has its *parent* resolved instead, so a new directory under a
 *  symlinked parent lands in the real tree too. When the parent does not exist either, the path is
 *  returned as given and `mkdir -p` makes the whole chain. */
async function resolveRoot(given: string): Promise<string> {
  const abs = path.resolve(given);
  try {
    const real = await realpath(abs);
    if (!(await stat(real)).isDirectory()) throw new Error(`${abs} is not a directory, so it cannot hold a show`);
    return real;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    return path.join(await realpath(path.dirname(abs)), path.basename(abs));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return abs;
  }
}

/** The paths one bible file's commit stages — the one list both of the commits that can carry a
 *  file are built from: the commit made as soon as its gate is answered, and the catch-up commit
 *  `--resume` makes for a file whose approval is in its run log and whose commit a crash swallowed.
 *  The two must stage the same list, because the catch-up commit is the only one that will ever
 *  look at that file again: every other commit names only its own paths.
 *
 *  `world-overview`'s list is longer by two, and that is the whole reason this is a function. Its
 *  interview also yields the cast, so `init` writes the character sheets and rewrites
 *  `showrunner.json`'s `audio.mainCast` *after* the driver has returned — which is to say after
 *  `isApproved` already reports the file done — and before the commit. Without those two paths
 *  here, a crash in that window would leave the sheets and the config rewrite uncommitted forever.
 *  The sheets are staged as the characters *directory* and not as file names because after a crash
 *  nobody knows which names were written. */
function commitPaths(root: string, entry: BibleFile, dirs: { productionDir: string; canonDir: string }): string[] {
  const paths = [
    entry.file,
    answersPath(entry.key, dirs.productionDir),
    path.relative(root, bibleLogDir(root, entry.key, dirs.productionDir)),
  ];
  if (entry.key === CAST_KEY) paths.push("showrunner.json", `${dirs.canonDir}/characters`);
  return paths;
}

/** Refuses the path unless it can hold a new show: it must not exist, or be an empty directory.
 *  A resume requires the opposite — a directory that is already there — because there is nothing to
 *  resume otherwise. The refusal names the directory and says what to do about it, since this is
 *  the one check an author meets by accident, by pointing `--path` at the wrong place. */
async function checkRoot(root: string, resume: boolean): Promise<void> {
  let entries: string[] | undefined;
  try {
    entries = await readdir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") throw new Error(`${root} is a file, not a directory`);
    if (code !== "ENOENT") throw err;
  }
  if (entries === undefined) {
    if (resume) throw new Error(`${root} does not exist, so there is nothing to resume`);
    return;
  }
  if (!resume && entries.length > 0) {
    const sample = entries.slice(0, 3).join(", ");
    throw new Error(`${root} is not an empty directory: it already holds ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${sample}). Point --path at a new directory, or pass --resume to continue a setup that was interrupted here.`);
  }
}

/** The show repository an import may draw from: a directory with a bible in it. Checked once, up
 *  front, so an author who mistyped `--import` is told before the interview starts rather than at
 *  the first file that offered nothing. */
async function checkImportFrom(from: string): Promise<string> {
  const dir = path.resolve(from);
  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`--import ${dir} does not exist`);
    throw err;
  }
  if (!isDir) throw new Error(`--import ${dir} is not a directory`);
  try {
    if (!(await stat(path.join(dir, "Canon"))).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`--import ${dir} has no Canon/ directory, so it is not a show repository to import bible files from`);
  }
  return dir;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Those of `rels` that exist under `root`, as relative paths. `git add -- <path>` fails outright
 *  on a pathspec that matches nothing, so the two commits `init` makes over a part-finished
 *  interview — the catch-up commit on a resume and the commit of a file a gate stalled on — stage
 *  only what is actually there: an interview that stopped before it wrote its answers file has no
 *  answers file to stage. */
async function existing(root: string, rels: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const rel of rels) {
    try {
      await stat(path.join(root, rel));
      out.push(rel);
    } catch {
      /* not written yet, so not staged */
    }
  }
  return out;
}

/** The file in `--import`'s show that could be copied over `entry.file`, or `undefined` when that
 *  show has no such file. The driver offers it before it asks anything (`interviewFile`'s fifth
 *  argument), which is the whole of finding I5: an import run used to answer every question and
 *  pay for a writer agent per file before the import was so much as mentioned. */
async function importCandidate(importFrom: string | undefined, entry: BibleFile): Promise<string | undefined> {
  if (importFrom === undefined) return undefined;
  const candidate = path.join(importFrom, entry.file);
  return (await isFile(candidate)) ? candidate : undefined;
}

/** Copies `--import`'s copy of a scaffold bible file over the scaffold, and returns the source when
 *  it did.
 *
 *  The two `mode: "scaffold"` rows — `Canon/continuity-ledger.md` and `Canon/voice-registry.md` —
 *  have no interview and no gate, because the pipeline fills them: `propose` appends to the ledger
 *  and the NEEDS_REFS stop fills the registry. That is right for a new show and wrong for a fresh
 *  instance of an existing one, which used to start with a ledger of four empty headings while
 *  `prompts/propose.md` and `prompts/outline.md` read it for the open threads every episode must
 *  honour, and `prompts/tts-script.md` read the registry for pronunciation. There is nothing for a
 *  gate to be asked about — the author is importing their own ledger, not reviewing a draft of it —
 *  so this is a copy and a commit and no agent at all (finding I6).
 *
 *  The destination is only overwritten while it is still the untouched scaffold. On a `--resume`,
 *  days may have passed and the ledger may hold an episode's worth of threads; copying over that
 *  would destroy work no gate ever showed anyone. */
async function importScaffold(root: string, entry: BibleFile, importFrom: string | undefined, io: InitIO): Promise<string | undefined> {
  const source = await importCandidate(importFrom, entry);
  if (source === undefined) return undefined;
  const destination = path.join(root, entry.file);
  const scaffold = templateWithoutQuestions(await readFile(path.join(templatesDir(), "canon", `${entry.key}.md`), "utf8"));
  const onDisk = await readFile(destination, "utf8").catch(() => "");
  const wanted = await readFile(source, "utf8");
  // Already imported — a `--resume` of a run that did this before. Nothing to say and nothing to
  // commit: the file is the file.
  if (onDisk === wanted) return undefined;
  if (onDisk !== "" && onDisk !== scaffold) {
    io.say(`${entry.file} has been written to since the scaffold was created, so ${source} was not copied over it. Merge it by hand if you still want it.`);
    return undefined;
  }
  await writeFile(destination, wanted, "utf8");
  return source;
}

/** Writes `showrunner.json` and returns the config as every reader will see it — through
 *  `loadShowConfig`, which is the validator. Writing and then loading is deliberate: the config
 *  `init` works from is the file on disk, so a key this build got wrong fails here, at the first
 *  step, instead of at an episode three weeks later. */
async function writeConfig(root: string, config: Record<string, unknown>): Promise<ShowConfig> {
  await writeFile(path.join(root, "showrunner.json"), showConfigText(config), "utf8");
  return loadShowConfig(root);
}

/** Rewrites one key of an existing `showrunner.json`: `audio.mainCast`, once the `world-overview`
 *  interview has recorded the recurring cast. The file is read and edited rather than rebuilt from
 *  `buildShowConfig`, because by the time the cast is known the author may have edited the config —
 *  on a resume, days may have passed — and rebuilding it would quietly undo that. */
async function writeMainCast(root: string, mainCast: string[]): Promise<void> {
  const file = path.join(root, "showrunner.json");
  const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const audio = config["audio"];
  if (typeof audio === "object" && audio !== null && !Array.isArray(audio)) {
    (audio as Record<string, unknown>)["mainCast"] = mainCast;
  } else {
    config["audio"] = { mainCast };
  }
  await writeFile(file, showConfigText(config), "utf8");
}

/** Creates a new show repository and interviews its author for the bible, one file and one commit
 *  at a time.
 *
 *  The order of the steps is the whole design. The layout, the config and the prompt set are
 *  written and committed first, so that every later commit is a change to a repository that already
 *  works. Then each bible file is interviewed and committed on its own, after its gate is answered
 *  and its run log is closed — a commit taken while the interview's log was still open would record
 *  a run that is permanently waiting for an answer it has already had. Then `bible-check` reports
 *  what is still missing, as a report and not a refusal, because an author who said "I will write
 *  this one myself" has files to write. The GitHub repository is created last of all, and only
 *  then: `gh repo create --push` refuses a repository with no commits, an interview that is
 *  abandoned half-way would otherwise have left an empty repository on GitHub under a name a second
 *  attempt could not reuse, and everything before this point works with no network and no account.
 *
 *  Nothing here is destructive. The scaffold writes every file with `wx`, a non-empty directory is
 *  refused unless `resume` says the author means it, and `resume` skips every file whose interview
 *  the run log says was approved. */
export async function runInit(opts: InitOptions, io: InitIO, deps: InitDeps = {}): Promise<InitReport> {
  const resume = opts.resume === true;
  const name = opts.name.trim();
  if (name === "") throw new Error("the show needs a name");
  const root = await resolveRoot(opts.path);
  await checkRoot(root, resume);
  const importFrom = opts.importFrom === undefined ? undefined : await checkImportFrom(opts.importFrom);

  let config: ShowConfig;
  const commits: string[] = [];
  if (resume) {
    config = await loadShowConfig(root);
    io.say(`Resuming the setup of ${config.showName} in ${root}.`);
    if (config.showName !== name) {
      io.say(`showrunner.json names this show ${config.showName}, so that is the name used: on a resume the config on disk is what every step reads, and --name ${name} is ignored.`);
    }
    // A run whose scaffold commit failed — no git identity, or `commit.gpgsign` on with no key —
    // left a repository with no commit at all, and `--resume` only ever makes per-file commits
    // over `commitPaths`' lists. Now that `gitCommit` passes `--only`, nothing would ever sweep
    // the scaffold's prompts, README and `.gitignore` in by accident, and `gh repo create --push`
    // would publish an incomplete repository. So the resume asks whether there is a HEAD, and
    // makes the scaffold commit when there is not (finding I8).
    if (!(await gitHasHead(root, deps.git))) {
      io.say("This repository has no commit yet, so the scaffold's own commit — which an earlier run could not make — is made now.");
      commits.push(await gitCommit(root, `init: ${config.showName} — the house layout, the prompts, the scaffolds`, ["."], deps.git));
    }
  } else {
    const slug = (opts.slug ?? slugFrom(name)).trim();
    if (!SLUG_OK.test(slug)) {
      throw new Error(`${JSON.stringify(slug)} is not a usable slug: it names the show's files, so it must start with a letter and carry only letters and digits. Pass --slug.`);
    }
    const nasRoot = opts.nasRoot === undefined || opts.nasRoot.trim() === "" ? path.join(NAS_PARENT, slug) : path.resolve(opts.nasRoot.trim());
    await mkdir(root, { recursive: true });
    config = await writeConfig(root, buildShowConfig({ showName: name, showSlug: slug, nasRoot }, []));
    const written = await writeScaffold(root, config, []);
    io.say(`${root}: ${written.length} file(s) written — the layout, the prompts, the reference indices and the README. The NAS root is ${nasRoot}.`);
    await gitInit(root, deps.git);
    commits.push(await gitCommit(root, `init: ${name} — the house layout, the prompts, the scaffolds`, ["."], deps.git));
  }

  const productionDir = config.productionDir ?? "Production";
  const canonDir = config.canonDir ?? "Canon";
  const built = realInterviewDeps(config);
  const interviewDeps: InterviewDeps = {
    executors: deps.executors ?? built.executors,
    renderGateMessage: deps.renderGateMessage ?? built.renderGateMessage,
    operator: deps.operator ?? "showrunner-init",
    productionDir,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };

  // The scaffold rows, before any interview: an imported continuity ledger is what the first
  // episode of a fresh instance proposes against, and the author should not have to answer
  // thirteen files' worth of questions to find out whether it came across.
  for (const entry of BIBLE_FILES) {
    if (entry.mode !== "scaffold") continue;
    const source = await importScaffold(root, entry, importFrom, io);
    if (source === undefined) continue;
    io.say(`${entry.file} is ${source}, copied here. It has no gate: the pipeline writes this file, so there is no draft to review.`);
    commits.push(await gitCommit(root, `canon: ${entry.file} — imported from ${source}`, [entry.file], deps.git));
  }

  const files: InterviewResult[] = [];
  const stalled: string[] = [];
  for (const entry of BIBLE_FILES) {
    // A scaffold file has no gate: the pipeline fills the continuity ledger and the NEEDS_REFS
    // stop fills the voice registry, and the scaffold has already written both with their
    // headings. The loop above has already offered an import for one.
    if (entry.mode === "scaffold") continue;
    const staged = commitPaths(root, entry, { productionDir, canonDir });

    if (resume && (await isApproved(root, entry, productionDir))) {
      io.say(`${entry.file} is already approved; skipping it.`);
      // The approval is in the run log and the commit that was to carry it is a later step, so a
      // crash can land between the two. What that leaves is committed now, under its own message:
      // every other commit names only its own paths, so nothing else would ever pick it up. The
      // list is `commitPaths`' list and not a shorter one, so a crash after the `world-overview`
      // interview also commits the character sheets and the config's rewritten main cast.
      const candidates = await existing(root, staged);
      if (await gitDirty(root, candidates, deps.git)) {
        io.say(`${entry.file} was approved but not committed, so it is committed now.`);
        commits.push(await gitCommit(root, `canon: ${entry.file} — approved, committed on resume`, candidates, deps.git));
      }
      continue;
    }

    const candidate = await importCandidate(importFrom, entry);

    let result: InterviewResult;
    try {
      result = await interviewFile(root, entry, io, interviewDeps, candidate);
    } catch (err) {
      if (err instanceof Error && GATE_EXHAUSTED.test(err.message)) {
        // Ten rejections. The file on disk is the writer's last revision, which is worth keeping
        // and worth committing: it is where the author picks the file up by hand. The interview
        // moves on, because the rest of the bible is still worth doing in this sitting.
        stalled.push(entry.key);
        io.say(`${entry.file} was rejected ten times, so the interview has stopped asking about it. The file on disk is the writer's last revision: finish it by hand, or run init again with --resume to interview it afresh. The rest of the bible carries on.`);
        const paths = await existing(root, staged);
        if (await gitDirty(root, paths, deps.git)) {
          commits.push(await gitCommit(root, `canon: ${entry.file} — not approved, rejected ten times`, paths, deps.git));
        }
        continue;
      }
      throw err;
    }

    if (result.cast !== undefined) {
      // The cast is known only after the first interviewed file, so the character sheets and the
      // config's main-cast list are written here, between the driver returning and the commit.
      // Both are in `commitPaths`' list for this entry, so a crash in this window is recoverable:
      // `--resume` makes the same commit from the same list.
      const sheets = await writeCastSheets(root, config, result.cast);
      const mainCast = ["narrator", ...result.cast.map((c) => c.name)];
      await writeMainCast(root, mainCast);
      if (config.audio !== undefined) config.audio["mainCast"] = mainCast;
      io.say(`${sheets.length} character sheet(s) written, and audio.mainCast is now ${mainCast.join(", ")}.`);
    }
    const paths = await existing(root, [...new Set([...result.commits, ...staged])]);
    commits.push(await gitCommit(root, `canon: ${entry.file} — ${result.outcome}`, paths, deps.git));
    files.push(result);
  }

  if (stalled.length > 0) io.say(`${stalled.length} file(s) are waiting on you: ${stalled.join(", ")}.`);

  // The check, as a report. An author who took a file over, imported a partial one, or ran out of
  // patience at a gate has work left, and `init` says what it is rather than refusing to finish.
  const check = await bibleCheck(root, 1);
  if (check.ok) {
    io.say("bible-check: every bible file is present and carries every section a prompt reads by name.");
  } else {
    io.say(["bible-check found work left to do. Nothing is broken; a prompt that reads a missing section reads nothing, so write these before the first episode.", ...bibleCheckLines(check)].join("\n"));
  }

  let remote: string | undefined;
  if (opts.github !== "none") {
    const slug = config.showSlug;
    const command = `gh repo create ${slug} --source ${root} --push --${opts.github}`;
    const remotes = await gitRemotes(root, deps.git);
    if (remotes.length > 0) {
      io.say(`This repository already has a remote (${remotes.join(", ")}), so no GitHub repository was created. Push with: git push -u ${remotes[0] as string} HEAD`);
    } else if (await ghAuthOk(deps.git)) {
      try {
        remote = await ghRepoCreate(root, slug, opts.github, deps.git);
        io.say(`GitHub: ${remote}`);
      } catch (err) {
        io.say(`gh could not create the repository: ${err instanceof Error ? err.message : String(err)}\nEverything is committed here. Run this when that is sorted out:\n  ${command}`);
      }
    } else {
      io.say(`gh is not installed or not signed in, so no GitHub repository was created. Everything is committed here. Run these when you want one:\n  gh auth login\n  ${command}`);
    }
  }

  const nextSteps = readmeSection(await readFile(path.join(root, "README.md"), "utf8"), NEXT_STEPS_HEADING);
  io.say(nextSteps);
  io.say(`In that command, <this directory> is ${root} and <the engine repository> is ${opts.engineRoot}.`);

  return { root, files, stalled, commits, nextSteps, ...(remote !== undefined ? { remote } : {}) };
}

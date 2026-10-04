import { spawn as nodeSpawn } from "node:child_process";

/** The seam every command in this file goes through. `spawn` is injectable so the tests can record
 *  the argv a call was made with and reply to it without a repository, a network or a `gh` on the
 *  machine — which is the only way to test "init creates the GitHub repository last" at all.
 *
 *  Every call here is `spawn(cmd, args, opts)` with an argv array and never a shell string: a show
 *  name, a path or a slug reaches these functions as free text an author typed, and an argv array
 *  has no syntax for that text to escape into. */
export interface GitDeps {
  spawn?: typeof nodeSpawn;
}

/** The trailer every commit `init` makes carries, as its own last paragraph. The setup's commits
 *  are written by an agent from an author's answers, and the trailer is the commit's own record of
 *  that: a reader of the show's history can tell the files the interview produced from the files
 *  the author wrote afterwards by hand. */
export const COMMIT_TRAILER = "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>";

interface Capture {
  /** The exit code, or `null` when the process was killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the spawn itself failed — the executable is not on `PATH` (`ENOENT`) or could not be
   *  run. A process that started and exited non-zero has a `code` and no `failure`, and the two
   *  are kept apart because "`gh` is not installed" and "`gh` said no" are different news for the
   *  author. */
  failure?: string;
}

/** Runs a command to completion and returns what it said, without throwing for a non-zero exit or
 *  for a spawn that failed: every caller below decides for itself which of those is an error.
 *  Both pipes are read to the end before the result settles, so nothing a command printed is lost
 *  to the close event arriving first. */
async function capture(cmd: string, args: string[], opts: { cwd?: string; stdin?: string }, deps?: GitDeps): Promise<Capture> {
  const spawn = deps?.spawn ?? nodeSpawn;
  return new Promise<Capture>((resolve) => {
    const child = spawn(cmd, args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: Capture): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on("error", (err: Error) => { settle({ code: null, stdout, stderr, failure: err.message }); });
    child.on("close", (code: number | null) => { settle({ code, stdout, stderr }); });
    // The stdin pipe is always closed, whether or not anything is written to it: `git commit -F -`
    // waits for end-of-file on it, and a command that reads nothing is unharmed by an empty one.
    // An EPIPE here belongs to a process that has already failed, and `close` reports that.
    try {
      child.stdin?.end(opts.stdin ?? "");
    } catch {
      /* the close event carries the real failure */
    }
  });
}

/** `capture`, with a non-zero exit or a failed spawn turned into a thrown `Error` naming the
 *  command and quoting what the command itself said. The message is the whole diagnosis: an
 *  author who sees it does not have to re-run anything to find out what git objected to. */
async function must(cmd: string, args: string[], opts: { cwd?: string; stdin?: string }, deps?: GitDeps): Promise<Capture> {
  const result = await capture(cmd, args, opts, deps);
  const said = [result.stderr.trim(), result.stdout.trim()].filter((s) => s !== "").join("\n");
  if (result.failure !== undefined) {
    throw new Error(`${cmd} could not be run: ${result.failure}`);
  }
  if (result.code !== 0) {
    throw new Error(`${[cmd, ...args].join(" ")} exited ${result.code === null ? "without a code" : String(result.code)}${said === "" ? "" : `: ${said}`}`);
  }
  return result;
}

/** `git init` in the show root. Quiet, because `init` prints its own account of what it did and
 *  git's hint about the default branch name is not part of it. */
export async function gitInit(root: string, deps?: GitDeps): Promise<void> {
  await must("git", ["init", "-q"], { cwd: root }, deps);
}

/** Stages `paths` and commits them with `message`, and returns the new commit's sha.
 *
 *  The message goes in on stdin (`-F -`) rather than as `-m` arguments: a bible file's commit
 *  message carries the author's own words in its subject, and stdin is the one channel that cannot
 *  mangle a dash, a quote or a newline in them. `COMMIT_TRAILER` is appended as the last
 *  paragraph unless the message already carries it.
 *
 *  **Only the named paths reach the commit**, which is what `--only` is for and why `git add`
 *  alone was not enough. `git add -- <paths>` followed by a bare `git commit` commits the whole
 *  index, so an author who had staged their own work before starting the interview would have
 *  found it inside a commit whose subject says "canon: Canon/world-overview.md — approved". `init`
 *  commits one bible file at a time and an interview runs for an hour, so there is every reason
 *  for other work to be in that tree. The `add` stays because `--only` refuses a pathspec git has
 *  never heard of, and every path here is a file the setup has just created.
 *
 *  The commit's identity is git's own: whatever `user.name` and `user.email` the author's git is
 *  configured with, since the show's history is theirs and not the setup's. */
export async function gitCommit(root: string, message: string, paths: string[], deps?: GitDeps): Promise<string> {
  await must("git", ["add", "--", ...paths], { cwd: root }, deps);
  const body = message.includes(COMMIT_TRAILER) ? message : `${message.trimEnd()}\n\n${COMMIT_TRAILER}\n`;
  await must("git", ["commit", "--only", "-q", "-F", "-", "--", ...paths], { cwd: root, stdin: body }, deps);
  const head = await must("git", ["rev-parse", "HEAD"], { cwd: root }, deps);
  return head.stdout.trim();
}

/** Whether the repository has a commit. `init --resume` asks before it does anything else: a run
 *  whose scaffold commit failed — git with no `user.name`, or `commit.gpgsign` on with no key —
 *  leaves a repository with no HEAD, and every commit `--resume` makes names only its own bible
 *  file's paths, so the scaffold's prompt set, README and `.gitignore` would never be committed by
 *  anything and `gh repo create --push` would publish an incomplete show.
 *
 *  It answers with a boolean and never throws for the ordinary no: `git rev-parse --verify HEAD`
 *  exits non-zero in a repository with no commits, which is the state this question is asked
 *  about. `--verify` is what makes the exit code the answer rather than the output. */
export async function gitHasHead(root: string, deps?: GitDeps): Promise<boolean> {
  const result = await capture("git", ["rev-parse", "--verify", "HEAD"], { cwd: root }, deps);
  return result.failure === undefined && result.code === 0;
}

/** The names of the repository's remotes, in the order git lists them. `init` asks before it
 *  offers to create a GitHub repository: `gh repo create --source` adds a remote of its own and
 *  fails outright when one of that name already exists, so a show that has been through this once
 *  must be told to push rather than put through it again. */
export async function gitRemotes(root: string, deps?: GitDeps): Promise<string[]> {
  const result = await must("git", ["remote"], { cwd: root }, deps);
  return result.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/** Whether any of `paths` differs from `HEAD` or is untracked. `init --resume` asks this about a
 *  bible file its interview says is already approved: the approval is recorded in the run log, and
 *  the commit that was supposed to carry it is a separate step that a crash can land between. A
 *  file that is approved and uncommitted would otherwise never be committed at all, because every
 *  later commit names only its own paths. */
export async function gitDirty(root: string, paths: string[], deps?: GitDeps): Promise<boolean> {
  if (paths.length === 0) return false;
  const result = await must("git", ["status", "--porcelain", "--", ...paths], { cwd: root }, deps);
  return result.stdout.trim() !== "";
}

/** Whether `gh` is installed and signed in: `gh auth status` exits 0 when every known account
 *  authenticates and 1 when any of them has an authentication problem, including having no account
 *  at all (`gh help exit-codes` adds 4 for a command that requires authentication, which is
 *  likewise not a yes).
 *
 *  It answers with a boolean and never throws, for both of the ways this can be no: a `gh` that is
 *  signed out exits non-zero, and a `gh` that is not installed does not exit at all — the spawn
 *  fails with `ENOENT`, which Node delivers as the child's `error` event rather than as an exit
 *  code. Both are ordinary outcomes of `init` on a machine that has not met GitHub, and both end
 *  with the one command printed for the author to run later. */
export async function ghAuthOk(deps?: GitDeps): Promise<boolean> {
  const result = await capture("gh", ["auth", "status"], {}, deps);
  return result.failure === undefined && result.code === 0;
}

/** Creates the GitHub repository from the show's own repository and pushes it, returning the URL
 *  `gh` printed for it.
 *
 *  Three things must already be true of `root`, which is why `init` calls this last of all: it is
 *  a git repository, it has at least one commit (`gh` refuses `--push` with "no commits found"),
 *  and it has no remote named `origin` yet (`gh` adds one and refuses when the name is taken). The
 *  visibility flag is explicit because `gh repo create` is interactive without one, and `init` is
 *  not.
 *
 *  The URL is read out of whatever `gh` printed, on either stream, because that is where `gh` puts
 *  it — one line among its progress ticks. A `gh` that succeeded without printing one is an error
 *  rather than an empty remote in the report: the author is told to check GitHub themselves. */
export async function ghRepoCreate(root: string, slug: string, visibility: "private" | "public", deps?: GitDeps): Promise<string> {
  const result = await must("gh", ["repo", "create", slug, "--source", root, "--push", `--${visibility}`], {}, deps);
  const url = /https?:\/\/[^\s"'<>]+/.exec(`${result.stdout}\n${result.stderr}`);
  if (url === null) {
    throw new Error(`gh repo create ${slug} reported no repository URL; check GitHub for ${slug} before running it again. gh said: ${result.stdout.trim()}${result.stderr.trim()}`);
  }
  return url[0];
}

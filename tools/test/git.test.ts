import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { spawn as nodeSpawn } from "node:child_process";
import {
  COMMIT_TRAILER, ghAuthOk, ghRepoCreate, gitCommit, gitDirty, gitHasHead, gitInit, gitRemotes,
} from "../src/init/git.js";

interface Reply {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** When set, the spawn fails the way a missing executable does: an `error` event and no exit. */
  error?: string;
}

interface Recorded {
  cmd: string;
  args: string[];
  cwd?: string;
  stdin: string;
}

/** A `spawn` that records the argv it was called with and replies from a script, so every test
 *  below asserts on the exact argv and never runs git or gh. The fake closes only once both of its
 *  output streams have ended, which is the order a real child process closes in — a `close` before
 *  the pipes drain would let an implementation that reads its output pass by accident. */
function fakeSpawn(replies: readonly Reply[]) {
  const calls: Recorded[] = [];
  let next = 0;
  const spawn = ((cmd: string, args: readonly string[], opts?: { cwd?: string }) => {
    const reply = replies[next++] ?? {};
    const call: Recorded = { cmd, args: [...args], stdin: "", ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; stdin: PassThrough };
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer) => { call.stdin += chunk.toString("utf8"); });
    child.stdin = stdin;
    child.stdout = Readable.from([reply.stdout ?? ""]);
    child.stderr = Readable.from([reply.stderr ?? ""]);
    if (reply.error !== undefined) {
      setImmediate(() => child.emit("error", Object.assign(new Error(reply.error as string), { code: "ENOENT" })));
    } else {
      let ended = 0;
      const done = (): void => { if (++ended === 2) child.emit("close", reply.code ?? 0); };
      child.stdout.on("end", done);
      child.stderr.on("end", done);
    }
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}

describe("gitInit", () => {
  it("runs git init -q in the show root", async () => {
    const fake = fakeSpawn([{ code: 0 }]);
    await gitInit("/shows/harbor", { spawn: fake.spawn });
    expect(fake.calls).toEqual([{ cmd: "git", args: ["init", "-q"], cwd: "/shows/harbor", stdin: "" }]);
  });

  it("throws with git's own complaint when it fails", async () => {
    const fake = fakeSpawn([{ code: 128, stderr: "fatal: cannot mkdir\n" }]);
    await expect(gitInit("/shows/harbor", { spawn: fake.spawn })).rejects.toThrow(/git init -q.*128.*cannot mkdir/s);
  });
});

describe("gitCommit", () => {
  it("adds the paths, commits the message from stdin with the trailer, and returns the sha", async () => {
    const fake = fakeSpawn([{ code: 0 }, { code: 0 }, { code: 0, stdout: "9f1c0de4ab\n" }]);
    const sha = await gitCommit(
      "/shows/harbor",
      "canon: Canon/style-guide.md — approved",
      ["Canon/style-guide.md", "Production/setup/style-guide"],
      { spawn: fake.spawn },
    );

    expect(sha).toBe("9f1c0de4ab");
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["add", "--", "Canon/style-guide.md", "Production/setup/style-guide"],
      ["commit", "--only", "-q", "-F", "-", "--", "Canon/style-guide.md", "Production/setup/style-guide"],
      ["rev-parse", "HEAD"],
    ]);
    // `--only` with the paths repeated is what keeps an author's own staged work out of a bible
    // commit: `git add` followed by a bare `git commit` commits the whole index.
    expect(fake.calls.every((c) => c.cmd === "git" && c.cwd === "/shows/harbor")).toBe(true);
    expect(fake.calls[1]?.stdin).toBe(`canon: Canon/style-guide.md — approved\n\n${COMMIT_TRAILER}\n`);
  });

  it("does not append the trailer twice when the message already carries it", async () => {
    const fake = fakeSpawn([{ code: 0 }, { code: 0 }, { code: 0, stdout: "abc\n" }]);
    await gitCommit("/r", `one line\n\n${COMMIT_TRAILER}\n`, ["."], { spawn: fake.spawn });
    const stdin = fake.calls[1]?.stdin ?? "";
    expect(stdin.match(new RegExp(COMMIT_TRAILER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1);
  });

  it("throws naming the command and git's message when the commit fails", async () => {
    const fake = fakeSpawn([{ code: 0 }, { code: 1, stdout: "nothing to commit, working tree clean\n" }]);
    await expect(gitCommit("/r", "m", ["."], { spawn: fake.spawn })).rejects.toThrow(/git commit --only -q -F - -- \..*nothing to commit/s);
  });
});

describe("ghAuthOk", () => {
  it("asks gh auth status and is true only when it exits 0", async () => {
    const ok = fakeSpawn([{ code: 0, stdout: "Logged in to github.com\n" }]);
    expect(await ghAuthOk({ spawn: ok.spawn })).toBe(true);
    expect(ok.calls[0]).toMatchObject({ cmd: "gh", args: ["auth", "status"] });
  });

  it("is false when gh is signed out, and never throws", async () => {
    const out = fakeSpawn([{ code: 1, stderr: "You are not logged into any GitHub hosts.\n" }]);
    expect(await ghAuthOk({ spawn: out.spawn })).toBe(false);
  });

  it("is false when gh is not installed, and never throws", async () => {
    const missing = fakeSpawn([{ error: "spawn gh ENOENT" }]);
    expect(await ghAuthOk({ spawn: missing.spawn })).toBe(false);
  });
});

describe("ghRepoCreate", () => {
  it("creates the repository from the local source and returns the URL gh printed", async () => {
    const fake = fakeSpawn([{
      code: 0,
      stdout: "✓ Created repository showrunner/HarborLights on github.com\n  https://github.com/showrunner/HarborLights\n",
      stderr: "✓ Added remote https://github.com/showrunner/HarborLights.git\n",
    }]);
    const url = await ghRepoCreate("/shows/harbor", "HarborLights", "private", { spawn: fake.spawn });
    expect(url).toBe("https://github.com/showrunner/HarborLights");
    expect(fake.calls[0]).toMatchObject({
      cmd: "gh",
      args: ["repo", "create", "HarborLights", "--source", "/shows/harbor", "--push", "--private"],
    });
  });

  it("passes --public when that is the visibility asked for", async () => {
    const fake = fakeSpawn([{ code: 0, stdout: "https://github.com/showrunner/HarborLights\n" }]);
    await ghRepoCreate("/shows/harbor", "HarborLights", "public", { spawn: fake.spawn });
    expect(fake.calls[0]?.args.at(-1)).toBe("--public");
  });

  it("throws gh's own message when gh fails", async () => {
    const fake = fakeSpawn([{ code: 1, stderr: "GraphQL: Name already exists on this account\n" }]);
    await expect(ghRepoCreate("/r", "HarborLights", "private", { spawn: fake.spawn })).rejects.toThrow(/Name already exists/);
  });

  it("throws when gh succeeded but printed no URL, rather than reporting an empty remote", async () => {
    const fake = fakeSpawn([{ code: 0, stdout: "done\n" }]);
    await expect(ghRepoCreate("/r", "HarborLights", "private", { spawn: fake.spawn })).rejects.toThrow(/no repository URL/);
  });
});

describe("gitRemotes and gitDirty", () => {
  it("lists the remotes by name", async () => {
    const fake = fakeSpawn([{ code: 0, stdout: "origin\nupstream\n" }]);
    expect(await gitRemotes("/r", { spawn: fake.spawn })).toEqual(["origin", "upstream"]);
    expect(fake.calls[0]?.args).toEqual(["remote"]);
  });

  it("has no remotes in a repository that has none", async () => {
    const fake = fakeSpawn([{ code: 0, stdout: "\n" }]);
    expect(await gitRemotes("/r", { spawn: fake.spawn })).toEqual([]);
  });

  it("reports whether the given paths have uncommitted changes", async () => {
    const dirty = fakeSpawn([{ code: 0, stdout: "?? Canon/style-guide.md\n" }]);
    expect(await gitDirty("/r", ["Canon/style-guide.md"], { spawn: dirty.spawn })).toBe(true);
    expect(dirty.calls[0]?.args).toEqual(["status", "--porcelain", "--", "Canon/style-guide.md"]);

    const clean = fakeSpawn([{ code: 0, stdout: "" }]);
    expect(await gitDirty("/r", ["Canon/style-guide.md"], { spawn: clean.spawn })).toBe(false);
  });
});

describe("gitHasHead", () => {
  it("asks git rev-parse --verify HEAD and is true only when it exits 0", async () => {
    const yes = fakeSpawn([{ code: 0, stdout: "9f1c0de4ab\n" }]);
    expect(await gitHasHead("/shows/harbor", { spawn: yes.spawn })).toBe(true);
    expect(yes.calls[0]).toMatchObject({ cmd: "git", args: ["rev-parse", "--verify", "HEAD"], cwd: "/shows/harbor" });
  });

  it("is false in a repository with no commit, and never throws", async () => {
    const none = fakeSpawn([{ code: 128, stderr: "fatal: Needed a single revision\n" }]);
    expect(await gitHasHead("/r", { spawn: none.spawn })).toBe(false);
  });

  it("is false when git itself cannot be run", async () => {
    const missing = fakeSpawn([{ error: "spawn git ENOENT" }]);
    expect(await gitHasHead("/r", { spawn: missing.spawn })).toBe(false);
  });
});

import { describe, it, expect, vi } from "vitest";
import { execFile, spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline/promises";
import { PassThrough, Readable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  BIBLE_FILES, createGateMessageRenderer, loadShowConfig,
  type Executors, type QueryFn, type ShowConfig,
} from "@showrunner/engine";
import { templatesDir } from "../src/init/paths.js";
import type { InitIO } from "../src/init/interview.js";
import { readmeSection, runInit, slugFrom, type InitOptions } from "../src/init/init.js";
import { USAGE, defaultEngineRoot, parseArgs, terminalIO } from "../src/init/main.js";

const run = promisify(execFile);
const INTERVIEW = path.join(templatesDir(), "interview");
/** The repository that holds the engine, the console and these templates: one directory above
 *  `tools/`, which is where `templatesDir()` sits two levels down. */
const ENGINE_ROOT = path.resolve(templatesDir(), "..", "..");
const GATED = BIBLE_FILES.filter((b) => b.mode !== "scaffold");
/** The built CLI. The EOF test below drives the real binary, because what it is testing — what
 *  happens when stdin ends while readline is waiting — only exists in a real process. */
const BIN = path.join(ENGINE_ROOT, "tools", "dist", "init", "main.js");

/** A child process that never ran a program: it replies from a script and closes. Used to fail one
 *  particular git or gh call inside an otherwise real run. */
function fakeChild(reply: { code?: number; stdout?: string; stderr?: string; error?: string }): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; stdin: PassThrough };
  child.stdin = new PassThrough();
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
}

/** An author who answers every question the same way and approves every file. The one answer is
 *  in the form the cast question asks for, so the `world-overview` interview records a cast from
 *  it; every other question is answered with the same sentence, which is all this test needs.
 *  Everything said is kept so a test can assert what the author was told. */
function autoIO(answer = "Vale — the keeper of the light"): { io: InitIO; said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  const io: InitIO = {
    say: (text) => { said.push(text); },
    ask: async (question) => { asked.push(question); return answer; },
    choose: async <T extends string>(_q: string, choices: readonly { key: T; label: string }[]) => {
      const approve = choices.find((c) => c.key === "approve");
      if (!approve) throw new Error("the interview did not offer approve");
      return approve.key;
    },
  };
  return { io, said, asked };
}

/** The write and revise agents, faked: each writes the file its step declares as an output, the
 *  way the real one would, and records that it ran. */
function fakeAgent(): { executors: Executors; ran: string[] } {
  const ran: string[] = [];
  const executors: Executors = {
    script: async () => ({ ok: true }),
    agent: async (step, ctx) => {
      ran.push(`${step.id}:${String(step.vars?.["key"] ?? "")}`);
      const file = step.outputs?.[0];
      if (file !== undefined) {
        await mkdir(path.dirname(path.join(ctx.showRoot, file)), { recursive: true });
        await writeFile(path.join(ctx.showRoot, file), `# ${file}\n\n## A heading\n\nthe author's words.\n`, "utf8");
      }
      return { ok: true, text: `${step.id} done`, toolCalls: 1 };
    },
  };
  return { executors, ran };
}

async function harborShow(): Promise<ShowConfig> {
  const context = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures/harbor-check-context.json"), "utf8")) as { show: ShowConfig };
  return context.show;
}

async function deps(): Promise<{ executors: Executors; renderGateMessage: ReturnType<typeof createGateMessageRenderer>; now: () => Date; operator: string; ran: string[] }> {
  const agent = fakeAgent();
  const query: QueryFn = () => { throw new Error("a gate message is rendered, never queried"); };
  return {
    executors: agent.executors,
    renderGateMessage: createGateMessageRenderer({ query, promptsDir: INTERVIEW, show: await harborShow() }),
    now: () => new Date("2030-04-01T09:00:00.000Z"),
    operator: "cli:test",
    ran: agent.ran,
  };
}

/** An empty temp directory, with its symlinks resolved — `/var` is a link to `/private/var` on
 *  macOS — so a test's own `root` is the path `runInit` resolves it to and reports. */
async function emptyDir(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "showrunner-init-")));
}

function options(root: string, over: Partial<InitOptions> = {}): InitOptions {
  return { name: "Harbor Lights", path: root, github: "none", engineRoot: ENGINE_ROOT, ...over };
}

/** `git status --porcelain`'s output in the show: empty when nothing is left uncommitted. */
async function uncommitted(root: string): Promise<string> {
  return (await run("git", ["status", "--porcelain"], { cwd: root })).stdout;
}

async function logLines(root: string): Promise<string[]> {
  const { stdout } = await run("git", ["log", "--oneline"], { cwd: root });
  return stdout.trim().split("\n");
}

describe("slugFrom", () => {
  it("removes every non-alphanumeric character", () => {
    expect(slugFrom("Harbor Lights")).toBe("HarborLights");
    expect(slugFrom("The 13th Hour!")).toBe("The13thHour");
  });
});

describe("readmeSection", () => {
  it("returns one level-2 section of a README and nothing after it", async () => {
    const text = "# T\n\n## One\n\nfirst\n\n## Your first episode\n\nthe steps\n\n## Three\n\nthird\n";
    const section = readmeSection(text, "Your first episode");
    expect(section).toContain("the steps");
    expect(section).not.toContain("third");
    expect(section).not.toContain("first\n");
  });

  it("throws naming the heading when the README does not carry it", () => {
    expect(() => readmeSection("# T\n\n## One\n", "Your first episode")).toThrow(/Your first episode/);
  });
});

describe("runInit on an empty directory", () => {
  it("lays out the show, interviews every gated bible file, and commits one per file", async () => {
    const root = await emptyDir();
    const io = autoIO();
    const d = await deps();
    const report = await runInit(options(root), io.io, d);

    // The layout.
    for (const rel of [
      "showrunner.json", ".gitignore", "README.md", "Canon/refs.json", "Canon/characters/_TEMPLATE.md",
      "Episodes/_TEMPLATE/outline.md", "Production/voice-refs/refs.json", "prompts/outline.md",
      "Canon/continuity-ledger.md", "Canon/voice-registry.md",
    ]) {
      expect(existsSync(path.join(root, rel)), rel).toBe(true);
    }

    // The config, as the engine reads it.
    const config = await loadShowConfig(root);
    expect(config.showName).toBe("Harbor Lights");
    expect(config.showSlug).toBe("HarborLights");
    expect(config.output.nasRoot).toBe("/Volumes/media/HarborLights");

    // Every gated bible file was interviewed, exists, and is in the report.
    expect(report.files.map((f) => f.key)).toEqual(GATED.map((b) => b.key));
    expect(report.files).toHaveLength(13);
    expect(report.stalled).toEqual([]);
    for (const entry of GATED) expect(existsSync(path.join(root, entry.file)), entry.file).toBe(true);

    // The cast the world-overview answer named: a sheet, and the config's main cast.
    expect(existsSync(path.join(root, "Canon/characters/Vale/vale.md"))).toBe(true);
    expect(config.audio?.["mainCast"]).toEqual(["narrator", "Vale"]);

    // One commit for the scaffold and one per bible file.
    const log = await logLines(root);
    expect(log).toHaveLength(1 + 13);
    expect(report.commits).toHaveLength(1 + 13);
    expect(log.at(-1)).toContain("init: Harbor Lights — the house layout");
    expect(log[0]).toContain("canon: Canon/README.md — approved");
    const { stdout: message } = await run("git", ["log", "-1", "--format=%B"], { cwd: root });
    expect(message).toContain("Co-Authored-By:");

    // No GitHub repository was asked for, so the command is printed instead of a remote.
    expect(report.remote).toBeUndefined();
    expect(io.said.join("\n")).not.toContain("gh repo create");

    // The next steps are the README's own section, read back from the show on disk.
    expect(report.nextSteps).toContain("Write the premise");
    expect(report.nextSteps).not.toContain("## The layout");
    expect(io.said).toContain(report.nextSteps);

    // The default files had no write step; the interviewed ones did.
    expect(d.ran).toEqual(GATED.filter((b) => b.mode === "interview").map((b) => `write:${b.key}`));
  }, 120_000);
});

describe("runInit on a directory that already holds a show", () => {
  it("refuses it by name unless --resume is given", async () => {
    const root = await emptyDir();
    await writeFile(path.join(root, "notes.md"), "mine\n", "utf8");
    const io = autoIO();
    await expect(runInit(options(root), io.io, await deps())).rejects.toThrow(root);
  });
});

describe("runInit --resume", () => {
  it("re-runs only the file whose interview was lost", async () => {
    const root = await emptyDir();
    const first = await runInit(options(root), autoIO().io, await deps());
    expect(first.files).toHaveLength(13);

    // Lose the last file's interview the way a crash would: the file and its run log are gone,
    // and the commit that carried them is rolled back.
    const last = GATED.at(-1)!;
    await run("git", ["reset", "--hard", "HEAD~1"], { cwd: root });
    await rm(path.join(root, last.file), { force: true });
    await rm(path.join(root, "Production/setup", last.key), { recursive: true, force: true });

    const io = autoIO();
    const d = await deps();
    const report = await runInit(options(root, { resume: true }), io.io, d);

    expect(report.files.map((f) => f.key)).toEqual([last.key]);
    expect(existsSync(path.join(root, last.file))).toBe(true);
    expect(await logLines(root)).toHaveLength(1 + 13);
    expect(io.said.filter((s) => /already approved/.test(s))).toHaveLength(12);
    expect(d.ran).toEqual([]);
  }, 120_000);

  it("refuses a path that does not exist", async () => {
    const missing = path.join(await emptyDir(), "nothing");
    await expect(runInit(options(missing, { resume: true }), autoIO().io, await deps())).rejects.toThrow(/nothing to resume/);
  });
});

describe("runInit with --import", () => {
  it("offers the import first with the path filled in, and imports what the author accepts", async () => {
    const root = await emptyDir();
    const source = await emptyDir();
    await mkdir(path.join(source, "Canon"), { recursive: true });
    await writeFile(path.join(source, "Canon/timeline.md"), "# Timeline\n\n## Eras\n\nthe old coast.\n", "utf8");

    const offered: { question: string; default?: string }[] = [];
    const firstChoices: string[] = [];
    const base = autoIO();
    const io: InitIO = {
      say: base.io.say,
      ask: async (question, opts) => {
        offered.push(opts?.default === undefined ? { question } : { question, default: opts.default });
        return opts?.default ?? "Vale — the keeper of the light";
      },
      choose: async <T extends string>(question: string, choices: readonly { key: T; label: string }[]) => {
        firstChoices.push(choices[0]!.key);
        const want = choices.find((c) => c.key === (question.includes("timeline") ? "import" : "approve"));
        return (want ?? choices[0]!).key;
      },
    };

    const report = await runInit(options(root, { importFrom: source }), io, await deps());
    expect(await readFile(path.join(root, "Canon/timeline.md"), "utf8")).toContain("the old coast.");
    expect(report.files.find((f) => f.key === "timeline")?.outcome).toBe("imported");
    // The one gate that had an import available was offered it first; every other gate was not.
    expect(firstChoices.filter((k) => k === "import")).toHaveLength(1);
    expect(offered.some((o) => /import/i.test(o.question) && o.default === path.join(source, "Canon/timeline.md"))).toBe(true);
  }, 120_000);
});

describe("runInit's bible-check", () => {
  it("reports the sections the interview did not produce and still returns a report", async () => {
    const root = await emptyDir();
    const io = autoIO();
    const report = await runInit(options(root), io.io, await deps());
    const said = io.said.join("\n");
    expect(said).toMatch(/section\(s\)/);
    expect(said).toContain("Logline");
    expect(report.files).toHaveLength(13);
  }, 120_000);
});

describe("the showrunner-init command's arguments", () => {
  it("parses every flag", () => {
    expect(parseArgs([
      "--name", "Harbor Lights", "--slug", "HarborLights", "--path", "/shows/harbor",
      "--nas-root", "/Volumes/media/HarborLights", "--github", "public",
      "--engine-root", "/code/showrunner", "--import", "/shows/old", "--resume",
    ])).toEqual({
      name: "Harbor Lights", slug: "HarborLights", path: "/shows/harbor",
      nasRoot: "/Volumes/media/HarborLights", github: "public",
      engineRoot: "/code/showrunner", importFrom: "/shows/old", resume: true,
    });
  });

  it("refuses a --github that is not one of the three, and an unrecognised flag", () => {
    expect(() => parseArgs(["--github", "secret"])).toThrow(/--github must be private, public or none/);
    expect(() => parseArgs(["--nmae", "x"])).toThrow(/unrecognised argument "--nmae"/);
  });

  it("refuses a flag offered as another flag's value, and names the flag that is short of one", () => {
    // --resume used to be swallowed as the path to import from, with no error at all.
    expect(() => parseArgs(["--path", "/tmp/foo", "--import", "--resume"])).toThrow(/--import needs a value/);
    // A flag at the end of argv used to be reported as an unrecognised argument naming itself.
    expect(() => parseArgs(["--name", "Harbor Lights", "--path"])).toThrow(/--path needs a value/);
    expect(() => parseArgs(["--github"])).toThrow(/--github needs a value/);
    expect(() => parseArgs(["--slug", "--name", "Harbor Lights"])).toThrow(/--slug needs a value/);
  });

  it("documents every flag it accepts in the usage", () => {
    for (const flag of ["--name", "--path", "--slug", "--nas-root", "--github", "--engine-root", "--import", "--resume"]) {
      expect(USAGE, flag).toContain(flag);
    }
  });

  it("defaults the engine root to the repository the templates live in", () => {
    expect(defaultEngineRoot()).toBe(path.resolve(templatesDir(), "..", ".."));
    expect(existsSync(path.join(defaultEngineRoot(), "engine"))).toBe(true);
  });
});

describe("the terminal InitIO", () => {
  /** A real readline interface over a block of text, which is how the answers arrive in life: a
   *  line typed at a prompt and a block pasted or piped in at once are the same `line` events to
   *  readline, and the second is what the terminal used to lose. Nothing here is faked but the
   *  stream, so what these tests exercise is the queue the IO actually reads through. */
  function readlineOver(block: string): Parameters<typeof terminalIO>[0] {
    return createInterface({ input: Readable.from([block]) });
  }

  it("returns the default when the author accepts it with an empty answer, and the answer otherwise", async () => {
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await terminalIO(readlineOver("\n")).ask("Q", { default: "the earlier answer" })).toBe("the earlier answer");
      expect(await terminalIO(readlineOver("  a new answer  \n")).ask("Q", { default: "the earlier answer" })).toBe("a new answer");
    } finally {
      quiet.mockRestore();
    }
  });

  it("ends a multiline answer at a line holding only a period, and keeps the default when nothing is typed", async () => {
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await terminalIO(readlineOver("first line\nsecond line\n.\n")).ask("Q", { multiline: true })).toBe("first line\nsecond line");
      expect(await terminalIO(readlineOver(".\n")).ask("Q", { multiline: true, default: "what I said last time" })).toBe("what I said last time");
    } finally {
      quiet.mockRestore();
    }
  });

  it("offers the first choice to the Enter key, takes a number or a name, and re-asks a typo", async () => {
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const choices = [{ key: "import", label: "Import" }, { key: "approve", label: "Approve" }] as const;
      expect(await terminalIO(readlineOver("\n")).choose("Q", choices)).toBe("import");
      expect(await terminalIO(readlineOver("2\n")).choose("Q", choices)).toBe("approve");
      expect(await terminalIO(readlineOver("Approve\n")).choose("Q", choices)).toBe("approve");
      expect(await terminalIO(readlineOver("yes please\n1\n")).choose("Q", choices)).toBe("import");
    } finally {
      quiet.mockRestore();
    }
  });

  it("keeps a whole block of type-ahead and hands it out one question at a time, in order", async () => {
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      // Nine answers and a choice, arriving in one chunk before a single question is asked — the
      // shape of a pasted bible and of a piped script, and the shape that used to deliver only its
      // first line and then wait forever for the second.
      const io = terminalIO(readlineOver("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n2\n"));
      const answers: string[] = [];
      for (let i = 0; i < 9; i++) answers.push(await io.ask(`Q${i + 1}`, { multiline: false }));
      expect(answers).toEqual(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]);
      expect(await io.choose("Q10", [{ key: "import", label: "Import" }, { key: "approve", label: "Approve" }] as const)).toBe("approve");
      // The block is used up, and stdin has ended behind it: the next question is refused rather
      // than left waiting for a line that will never come.
      await expect(io.ask("Q11")).rejects.toThrow(/stdin closed before the interview finished/);
    } finally {
      quiet.mockRestore();
    }
  });

  it("takes a multiline answer out of a block too, up to its lone period", async () => {
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const io = terminalIO(readlineOver("a paragraph\nand another\n.\nthe next answer\n"));
      expect(await io.ask("Q1", { multiline: true })).toBe("a paragraph\nand another");
      expect(await io.ask("Q2")).toBe("the next answer");
    } finally {
      quiet.mockRestore();
    }
  });

  it("draws a file shown at a gate between two rules rather than printing it as three hyphens", () => {
    const written: string[] = [];
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation((text) => { written.push(String(text)); return true; });
    try {
      terminalIO(readlineOver("")).say("--- Canon/style-guide.md ---\nthe file\n--- end of Canon/style-guide.md ---");
    } finally {
      quiet.mockRestore();
    }
    expect(written.join("")).toBe("──── Canon/style-guide.md ────\nthe file\n──── end of Canon/style-guide.md ────\n");
  });
});

describe("runInit when a gate is rejected to exhaustion", () => {
  it("keeps the last revision, says so, and interviews the rest of the bible", async () => {
    const root = await emptyDir();
    const said: string[] = [];
    const first = GATED[0]!;
    let rejections = 0;
    const io: InitIO = {
      say: (text) => { said.push(text); },
      ask: async () => "Vale — the keeper of the light",
      choose: async <T extends string>(question: string, choices: readonly { key: T; label: string }[]) => {
        const want = question.includes(first.file) && rejections++ < 10 ? "reject" : "approve";
        return (choices.find((c) => (c.key as string) === want) ?? choices[0]!).key;
      },
    };
    const d = await deps();
    const report = await runInit(options(root), io, d);

    // The gate was rejected its ten times, the fix agent ran after each of the first nine, and the
    // file it last revised is on disk and committed.
    expect(rejections).toBe(10);
    expect(d.ran.filter((r) => r === `revise:${first.key}`)).toHaveLength(9);
    expect(existsSync(path.join(root, first.file))).toBe(true);
    expect(await readFile(path.join(root, first.file), "utf8")).toContain("the author's words");

    // The interview carried on: every other gated file was approved and is in the report.
    expect(report.files.map((f) => f.key)).toEqual(GATED.slice(1).map((b) => b.key));
    expect(report.stalled).toEqual([first.key]);
    expect(said.join("\n")).toContain("rejected ten times");
    expect(said.join("\n")).toContain(`1 file(s) are waiting on you: ${first.key}`);

    // The stalled file has a commit of its own, worded as not approved, so the revision is not
    // left loose in the working tree.
    const log = await logLines(root);
    expect(log).toHaveLength(1 + 1 + 12);
    expect(log.some((l) => l.includes(`canon: ${first.file} — not approved, rejected ten times`))).toBe(true);

    // No cast was recorded, because the file that collects it never reached an approval.
    expect((await loadShowConfig(root)).audio?.["mainCast"]).toEqual(["narrator"]);
  }, 120_000);
});

describe("runInit's GitHub step", () => {
  /** A `spawn` that runs git for real and fakes `gh`, so the GitHub step can be driven through
   *  `runInit` over a real repository. Every `gh` argv is recorded. */
  function ghSpawn(reply: { code?: number; stdout?: string; error?: string }): { spawn: typeof realSpawn; gh: string[][] } {
    const gh: string[][] = [];
    const spawn = ((cmd: string, args: readonly string[], opts?: object) => {
      if (cmd !== "gh") return realSpawn(cmd, args as string[], opts as never);
      gh.push([...args]);
      return fakeChild(reply);
    }) as unknown as typeof realSpawn;
    return { spawn, gh };
  }

  it("creates the repository last and reports its URL when gh is signed in", async () => {
    const root = await emptyDir();
    const fake = ghSpawn({ code: 0, stdout: "✓ Created repository me/HarborLights\nhttps://github.com/me/HarborLights\n" });
    const io = autoIO();
    const report = await runInit(options(root, { github: "private" }), io.io, { ...(await deps()), git: { spawn: fake.spawn } });

    expect(report.remote).toBe("https://github.com/me/HarborLights");
    expect(fake.gh).toEqual([
      ["auth", "status"],
      ["repo", "create", "HarborLights", "--source", root, "--push", "--private"],
    ]);
    // Last of all: every bible commit is already in the repository when gh is called.
    expect(report.commits).toHaveLength(1 + 13);
  }, 120_000);

  it("prints the command for later and throws nothing when gh is signed out", async () => {
    const root = await emptyDir();
    const fake = ghSpawn({ code: 1 });
    const io = autoIO();
    const report = await runInit(options(root, { github: "public" }), io.io, { ...(await deps()), git: { spawn: fake.spawn } });

    expect(report.remote).toBeUndefined();
    expect(fake.gh).toEqual([["auth", "status"]]);
    expect(io.said.join("\n")).toContain(`gh repo create HarborLights --source ${root} --push --public`);
    expect(io.said.join("\n")).toContain("gh auth login");
  }, 120_000);

  it("prints the command for later and throws nothing when gh is not installed", async () => {
    const root = await emptyDir();
    const fake = ghSpawn({ error: "spawn gh ENOENT" });
    const io = autoIO();
    const report = await runInit(options(root, { github: "private" }), io.io, { ...(await deps()), git: { spawn: fake.spawn } });

    expect(report.remote).toBeUndefined();
    expect(io.said.join("\n")).toContain(`gh repo create HarborLights --source ${root} --push --private`);
  }, 120_000);
});

describe("runInit after a crash between the world-overview interview and its commit", () => {
  it("commits the character sheets and the rewritten config on the next --resume", async () => {
    const root = await emptyDir();
    // The crash: the second `git commit` — world-overview's, the scaffold's being the first —
    // fails, which is the window in which the cast sheets and the config rewrite are on disk,
    // the run log already says the file is approved, and no commit carries either.
    let commits = 0;
    const crashing = ((cmd: string, args: readonly string[], opts?: object) => {
      if (cmd === "git" && args[0] === "commit" && ++commits === 2) return fakeChild({ code: 1, stderr: "fatal: the machine lost power\n" });
      return realSpawn(cmd, args as string[], opts as never);
    }) as unknown as typeof realSpawn;
    await expect(runInit(options(root), autoIO().io, { ...(await deps()), git: { spawn: crashing } }))
      .rejects.toThrow(/git commit/);

    // The state a crash leaves: approved in the log, written on disk, in no commit.
    expect(existsSync(path.join(root, "Canon/characters/Vale/vale.md"))).toBe(true);
    expect((await loadShowConfig(root)).audio?.["mainCast"]).toEqual(["narrator", "Vale"]);
    expect(await logLines(root)).toHaveLength(1);

    const io = autoIO();
    const report = await runInit(options(root, { resume: true }), io.io, await deps());

    // The catch-up commit carries all four: the bible file, the answers, the sheets and the config.
    const sha = (await run("git", ["log", "--format=%H", "--grep=committed on resume"], { cwd: root })).stdout.trim();
    expect(sha).not.toBe("");
    const staged = (await run("git", ["show", "--name-only", "--format=", sha], { cwd: root })).stdout;
    expect(staged).toContain("Canon/world-overview.md");
    expect(staged).toContain("Canon/characters/Vale/vale.md");
    expect(staged).toContain("showrunner.json");
    expect(staged).toContain("Production/setup/world-overview/answers.md");

    // Nothing is left orphaned, which is the whole point.
    expect((await run("git", ["status", "--porcelain"], { cwd: root })).stdout).toBe("");
    expect(report.files.map((f) => f.key)).toEqual(GATED.slice(1).map((b) => b.key));
    expect(io.said.join("\n")).toContain("was approved but not committed");
  }, 120_000);
});

describe("runInit's --path", () => {
  it("follows a symlinked directory into the real one and reports the real path", async () => {
    const real = await emptyDir();
    const link = path.join(await emptyDir(), "by-link");
    await symlink(real, link);

    const report = await runInit(options(link), autoIO().io, await deps());

    expect(report.root).toBe(real);
    expect(existsSync(path.join(real, "showrunner.json"))).toBe(true);
    expect((await loadShowConfig(real)).showSlug).toBe("HarborLights");
  }, 120_000);

  it("resolves a path that does not exist yet through its symlinked parent", async () => {
    const real = await emptyDir();
    const link = path.join(await emptyDir(), "by-link");
    await symlink(real, link);

    const report = await runInit(options(path.join(link, "show")), autoIO().io, await deps());

    expect(report.root).toBe(path.join(real, "show"));
    expect(existsSync(path.join(real, "show/showrunner.json"))).toBe(true);
  }, 120_000);

  it("refuses a path that exists and is not a directory", async () => {
    const file = path.join(await emptyDir(), "notes.md");
    await writeFile(file, "mine\n", "utf8");
    await expect(runInit(options(file), autoIO().io, await deps())).rejects.toThrow(/is not a directory/);
  });
});

describe("the showrunner-init command on a closed stdin", () => {
  const SENTENCE = "init: stdin closed before the interview finished; what was written is committed; run again with --resume";

  /** The built CLI, run with its stdin a pipe that `feed` writes and then ends. Returns what it
   *  said and how it exited. The real binary, because what these tests are about — a readline over
   *  a closed or pre-filled stdin — only exists in a real process. */
  async function runBin(args: string[], feed = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
    expect(existsSync(BIN), `${BIN} is missing — run \`npm run build -w tools\` before the suite`).toBe(true);
    const child = realSpawn(process.execPath, [BIN, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.stdin.end(feed);
    const code = await new Promise<number | null>((resolve) => { child.on("close", resolve); });
    return { code, stdout, stderr };
  }

  it("says the sentence and exits 1 when stdin is already closed at the first question", async () => {
    const target = path.join(await emptyDir(), "show");
    const run = await runBin(["--path", target]);

    expect(run.stdout).toContain("What is the show called?");
    expect(run.stderr.trim()).toBe(SENTENCE);
    expect(run.code).toBe(1);
    // This order asks before it writes, so there is nothing on disk to resume from either.
    expect(existsSync(target)).toBe(false);
  }, 30_000);

  it("says the same sentence when stdin closed long before the first question, after the scaffold commit", async () => {
    // --name and --path given, so `runInit` writes the scaffold, runs git init and makes the
    // scaffold commit before the first interview question. stdin's close has come and gone by
    // then: this used to exit 1 with Node's own `readline was closed`.
    const target = path.join(await emptyDir(), "show");
    const run = await runBin(["--name", "Harbor Lights", "--path", target, "--github", "none"]);

    expect(run.stderr.trim()).toBe(SENTENCE);
    expect(run.code).toBe(1);
    // And what the sentence promises is true: the scaffold is written and committed, so --resume
    // continues from it.
    expect(existsSync(path.join(target, "showrunner.json"))).toBe(true);
    const log = await logLines(target);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("init: Harbor Lights — the house layout");
    expect(await uncommitted(target)).toBe("");
  }, 60_000);

  it("reads a whole piped block, so an answer after the first is not lost", async () => {
    // Two answers in one chunk. The second used to be consumed by readline with nobody listening
    // and then waited for forever, so the show was never created at all; now the path answer is
    // taken from the queue and the scaffold is written where it says.
    const target = path.join(await emptyDir(), "show");
    const run = await runBin(["--github", "none"], `Harbor Lights\n${target}\n`);

    expect(run.stdout).toContain("What is the show called?");
    expect(run.stdout).toContain("Which directory should the show repository be created in?");
    expect(existsSync(path.join(target, "showrunner.json"))).toBe(true);
    expect((await loadShowConfig(target)).showName).toBe("Harbor Lights");
    // The block ran out at the interview's first question, which is the documented stop.
    expect(run.stderr.trim()).toBe(SENTENCE);
    expect(run.code).toBe(1);
  }, 60_000);
});

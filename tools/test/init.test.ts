import { describe, it, expect, vi } from "vitest";
import { execFile, spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
  /** A readline interface whose answers come from an array, so the terminal's own rules — what an
   *  empty answer means, what ends a multiline answer — are tested without a TTY. */
  function fakeReadline(answers: readonly string[]): { rl: Parameters<typeof terminalIO>[0]; asked: string[] } {
    const asked: string[] = [];
    let next = 0;
    const rl = Object.assign(new EventEmitter(), {
      question: async (prompt: string) => {
        asked.push(prompt);
        if (next >= answers.length) throw new Error("the terminal asked one question too many");
        return answers[next++] as string;
      },
      close: () => undefined,
    });
    return { rl: rl as unknown as Parameters<typeof terminalIO>[0], asked };
  }

  it("returns the default when the author accepts it with an empty answer, and the answer otherwise", async () => {
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const kept = fakeReadline([""]);
      expect(await terminalIO(kept.rl).ask("Q", { default: "the earlier answer" })).toBe("the earlier answer");

      const typed = fakeReadline(["  a new answer  "]);
      expect(await terminalIO(typed.rl).ask("Q", { default: "the earlier answer" })).toBe("a new answer");
    } finally {
      quiet.mockRestore();
    }
  });

  it("ends a multiline answer at a line holding only a period, and keeps the default when nothing is typed", async () => {
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const two = fakeReadline(["first line", "second line", "."]);
      expect(await terminalIO(two.rl).ask("Q", { multiline: true })).toBe("first line\nsecond line");

      const kept = fakeReadline(["."]);
      expect(await terminalIO(kept.rl).ask("Q", { multiline: true, default: "what I said last time" })).toBe("what I said last time");
    } finally {
      quiet.mockRestore();
    }
  });

  it("offers the first choice to the Enter key, takes a number or a name, and re-asks a typo", async () => {
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const choices = [{ key: "import", label: "Import" }, { key: "approve", label: "Approve" }] as const;
      const enter = fakeReadline([""]);
      expect(await terminalIO(enter.rl).choose("Q", choices)).toBe("import");

      const numbered = fakeReadline(["2"]);
      expect(await terminalIO(numbered.rl).choose("Q", choices)).toBe("approve");

      const named = fakeReadline(["Approve"]);
      expect(await terminalIO(named.rl).choose("Q", choices)).toBe("approve");

      const typo = fakeReadline(["yes please", "1"]);
      expect(await terminalIO(typo.rl).choose("Q", choices)).toBe("import");
    } finally {
      quiet.mockRestore();
    }
  });

  it("draws a file shown at a gate between two rules rather than printing it as three hyphens", () => {
    const written: string[] = [];
    const quiet = vi.spyOn(process.stdout, "write").mockImplementation((text) => { written.push(String(text)); return true; });
    try {
      terminalIO(fakeReadline([]).rl).say("--- Canon/style-guide.md ---\nthe file\n--- end of Canon/style-guide.md ---");
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
  it("exits 1 saying so, rather than exiting 0 in silence", async () => {
    expect(existsSync(BIN), `${BIN} is missing — run \`npm run build -w tools\` before the suite`).toBe(true);
    const target = path.join(await emptyDir(), "show");
    const child = realSpawn(process.execPath, [BIN, "--path", target], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => { child.on("close", resolve); });

    expect(stdout).toContain("What is the show called?");
    expect(stderr.trim()).toBe("init: stdin closed before the interview finished; run again with --resume");
    expect(code).toBe(1);
    // Nothing was created, so there is nothing to clean up before running it again.
    expect(existsSync(target)).toBe(false);
  }, 30_000);
});

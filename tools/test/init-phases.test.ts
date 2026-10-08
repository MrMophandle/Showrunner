/** `init`'s phases, called one at a time the way the console calls them.
 *
 *  `tools/test/init.test.ts` drives the whole of `runInit` from a terminal that answers every
 *  question, and `tools/test/init-exercise.test.ts` takes one show from `init` to its first
 *  `NEEDS_IDEA`. Neither can call a phase on its own, which is what the console's New-show surface
 *  does: it scaffolds a show in one request, writes a file's answers in another, starts the writer
 *  in a detached worker, answers the gate, and finishes the setup minutes or days later. So these
 *  tests call `initScaffold`, `afterFileApproved` and `initFinish` separately, with the question
 *  helpers (`questionsFor`, `readAnswers`, `writeAnswers`, `buildVars`) called as a form would call
 *  them — no `runInit` anywhere in this file.
 *
 *  The show is Harbor Lights, the invented show the rest of the tools tests use. No file under
 *  `engine/`, `scripts/`, `render/`, `tools/` or `console/` may name a real one. */

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  BIBLE_FILES, createGateMessageRenderer, loadShowConfig,
  type BibleFile, type Executors, type QueryFn, type ShowConfig,
} from "@showrunner/engine";
import { afterFileApproved, initFinish, initScaffold, type InitOptions } from "../src/init/init.js";
import {
  GATE_CHOICES, buildVars, interviewFile, interviewPromptsDir, latestSetupLog, questionsFor,
  readAnswers, writeAnswers, type InitIO, type InterviewDeps,
} from "../src/init/interview.js";
import { templatesDir } from "../src/init/paths.js";
import { parseCanonTemplate, templateWithoutQuestions } from "../src/init/scaffold.js";

const execFileAsync = promisify(execFile);

/** The repository that holds the engine, the tools and the templates: one directory above
 *  `tools/`, which is two above `tools/templates/`. */
const ENGINE_ROOT = path.resolve(templatesDir(), "..", "..");
const SHOW_NAME = "Harbor Lights";
const SHOW_SLUG = "HarborLights";
/** The thirteen bible files that have a gate — every row but the two the pipeline fills. */
const GATED = BIBLE_FILES.filter((b) => b.mode !== "scaffold");
const CAST = BIBLE_FILES.find((b) => b.key === "world-overview") as BibleFile;
const ARC = BIBLE_FILES.find((b) => b.key === "series-arc") as BibleFile;
/** One fixed moment, so a run id and the interview's date stamp are the same in every assertion. */
const NOW = new Date("2030-04-01T09:00:00.000Z");
/** One answer for every question, in the form the cast question asks for, so the `world-overview`
 *  interview records a cast from it and every other file is answered with a sentence. */
const ANSWER = "Vale — the keeper of the light";

/** An author who answers every question the same way and approves every gate. Everything said is
 *  kept so an assertion can read what the author was told. */
function autoIO(): { io: InitIO; said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  const io: InitIO = {
    say: (text) => { said.push(text); },
    ask: async (question) => { asked.push(question); return ANSWER; },
    choose: async <T extends string>(_question: string, choices: readonly { key: T; label: string }[]) => {
      const approve = choices.find((c) => c.key === "approve");
      if (approve === undefined) throw new Error("the interview offered no approve");
      return approve.key;
    },
  };
  return { io, said, asked };
}

/** The writer and fix agents, faked: each writes its step's declared output as the canon template
 *  with its questions stripped, and records that it ran.
 *
 *  The stripped template carries **every** heading the template declares, which is what makes
 *  `initFinish`'s `bibleCheck` meaningful here: `REQUIRED_SECTIONS` names headings a prompt reads
 *  by name, the canon templates carry every one of them (`tools/test/templates.test.ts`), and
 *  `missingSections` asks only whether the heading is in the file. Whether the author's answers
 *  travel into the file is the exercise test's question, not this file's. */
function fakeWriter(): { executors: Executors; ran: string[] } {
  const ran: string[] = [];
  const executors: Executors = {
    script: async (step) => { throw new Error(`a bible interview ran a script step: ${step.id}`); },
    agent: async (step, ctx) => {
      ran.push(`${step.id}:${String(step.vars?.["key"] ?? "")}`);
      const file = step.outputs?.[0];
      const templatePath = step.vars?.["templatePath"];
      if (file !== undefined && templatePath !== undefined) {
        await writeFileAt(path.join(ctx.showRoot, file), templateWithoutQuestions(await readFile(templatePath, "utf8")));
      }
      return { ok: true, text: `${step.id} wrote ${String(file)}`, toolCalls: 1 };
    },
  };
  return { executors, ran };
}

/** One file written with its parent directory made first — what both fakes need and neither of the
 *  two `node:fs/promises` calls does on its own. */
async function writeFileAt(abs: string, text: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text, "utf8");
}

/** The interview's dependencies over a scaffolded show: the fake writer, the real gate-message
 *  renderer over the show's own config, and the fixed clock. */
function interviewDeps(show: ShowConfig, executors: Executors): InterviewDeps {
  const query: QueryFn = () => { throw new Error("a gate message is rendered, never queried"); };
  return {
    executors,
    renderGateMessage: createGateMessageRenderer({ query, promptsDir: interviewPromptsDir(), show }),
    now: () => NOW,
    operator: "init-phases",
  };
}

function options(root: string, over: Partial<InitOptions> = {}): InitOptions {
  return { name: SHOW_NAME, path: root, github: "none", engineRoot: ENGINE_ROOT, ...over };
}

async function gitLog(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["log", "--format=%s"], { cwd: root });
  return stdout.trim() === "" ? [] : stdout.trim().split("\n");
}

/** The paths one commit touched, as `git show --name-only` lists them. */
async function committedPaths(root: string, ref = "HEAD"): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["show", "--name-only", "--format=", ref], { cwd: root });
  return stdout.trim() === "" ? [] : stdout.trim().split("\n");
}

describe("init's phases, called one at a time", () => {
  const made: string[] = [];
  afterEach(async () => {
    while (made.length > 0) await rm(made.pop() as string, { recursive: true, force: true });
  });

  /** An empty temp directory with its symlinks resolved — `/var` is a link to `/private/var` on
   *  macOS — so a test's own path is the path `initScaffold` resolves it to and reports. */
  async function emptyDir(): Promise<string> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "init-phases-")));
    made.push(dir);
    return dir;
  }

  describe("initScaffold", () => {
    it("writes the layout and the config, makes one commit, and interviews nothing", async () => {
      const root = await emptyDir();
      const io = autoIO();
      const result = await initScaffold(options(root), io.io);

      expect(result.root).toBe(root);
      expect(result.commits).toHaveLength(1);
      expect(await gitLog(root)).toEqual(["init: Harbor Lights — the house layout, the prompts, the scaffolds"]);

      // The layout the scaffold writes, and the two bible files the pipeline fills.
      for (const rel of [
        "showrunner.json", ".gitignore", "README.md", "Canon/refs.json", "Canon/characters/_TEMPLATE.md",
        "Episodes/_TEMPLATE/outline.md", "Production/voice-refs/refs.json", "prompts/outline.md",
        "Canon/continuity-ledger.md", "Canon/voice-registry.md",
      ]) {
        expect(existsSync(path.join(root, rel)), rel).toBe(true);
      }

      // The config, as the engine reads it and as the phase returns it to a caller that will put it
      // in a JSON response.
      const config = await loadShowConfig(root);
      expect([config.showName, config.showSlug, config.output.nasRoot]).toEqual([SHOW_NAME, SHOW_SLUG, `/Volumes/media/${SHOW_SLUG}`]);
      expect(result.config["showName"]).toBe(SHOW_NAME);
      expect(result.config["showSlug"]).toBe(SHOW_SLUG);

      // Not one gated bible file is written, and nothing was asked: the interview is the caller's
      // to drive, one file at a time.
      for (const entry of GATED) expect(existsSync(path.join(root, entry.file)), entry.file).toBe(false);
      expect(io.asked).toEqual([]);
      expect(io.said.join("\n")).toContain(`The NAS root is /Volumes/media/${SHOW_SLUG}.`);
    }, 120_000);

    it("refuses a slug that would not name a file", async () => {
      const root = await emptyDir();
      await expect(initScaffold(options(root, { slug: "Harbor Lights" }), autoIO().io)).rejects.toThrow(/not a usable slug/);
    });

    it("refuses a directory that already holds something, unless the caller means to resume", async () => {
      const root = await emptyDir();
      await writeFileAt(path.join(root, "notes.md"), "mine\n");
      await expect(initScaffold(options(root), autoIO().io)).rejects.toThrow(root);
    });
  });

  describe("questionsFor", () => {
    it("returns the nine questions world-overview's template asks, in the template's order", async () => {
      const questions = await questionsFor(CAST);
      expect(questions).toHaveLength(9);
      const template = parseCanonTemplate(await readFile(path.join(templatesDir(), "canon", "world-overview.md"), "utf8"));
      expect(questions.map((q) => q.heading)).toEqual(template.questions.map((q) => q.heading));
      for (const q of questions) expect(q.question.length, q.heading).toBeGreaterThan(0);
    });

    it("returns nothing for a file the author is not interviewed about", async () => {
      const story = BIBLE_FILES.find((b) => b.key === "story-craft") as BibleFile;
      expect(await questionsFor(story)).toEqual([]);
    });
  });

  describe("writeAnswers and readAnswers", () => {
    it("round-trip the answers by heading, and record a question with no answer as a blank", async () => {
      const root = await emptyDir();
      const questions = await questionsFor(CAST);
      const first = questions[0]!.heading;
      const second = questions[1]!.heading;

      expect(await readAnswers(root, CAST)).toEqual({});

      const rel = await writeAnswers(root, CAST, { [first]: "Harbor, in the winter.", [second]: "A keeper who arrives to a lit lamp." });
      expect(rel).toBe("Production/setup/world-overview/answers.md");

      const text = await readFile(path.join(root, rel), "utf8");
      for (const q of questions) expect(text, q.heading).toContain(`## ${q.heading}`);
      expect(text).toContain("(blank)");
      expect(text).toContain("<!-- Q:");

      expect(await readAnswers(root, CAST)).toEqual({
        [first]: "Harbor, in the winter.",
        [second]: "A keeper who arrives to a lit lamp.",
      });
    });

    it("write and read under the production directory they are given", async () => {
      const root = await emptyDir();
      const heading = (await questionsFor(ARC))[0]!.heading;
      const rel = await writeAnswers(root, ARC, { [heading]: "Three seasons, one contract." }, "Prod");
      expect(rel).toBe("Prod/setup/series-arc/answers.md");
      expect(await readAnswers(root, ARC, "Prod")).toEqual({ [heading]: "Three seasons, one contract." });
      expect(await readAnswers(root, ARC)).toEqual({});
    });
  });

  describe("buildVars", () => {
    it("carries the six variables the interview's three prompts render", async () => {
      const root = await emptyDir();
      const vars = buildVars(root, CAST, NOW);
      expect(Object.keys(vars).sort()).toEqual(["answersPath", "date", "file", "key", "purpose", "templatePath"]);
      expect(vars["file"]).toBe(CAST.file);
      expect(vars["key"]).toBe("world-overview");
      expect(vars["purpose"]).toBe(CAST.purpose);
      expect(vars["answersPath"]).toBe("Production/setup/world-overview/answers.md");
      expect(vars["templatePath"]).toBe(path.join(templatesDir(), "canon", "world-overview.md"));
      // The author's own calendar date, which is why the clock is a Date and not a string.
      const pad = (n: number): string => String(n).padStart(2, "0");
      expect(vars["date"]).toBe(`${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`);
      expect(buildVars(root, CAST, NOW, "Prod")["answersPath"]).toBe("Prod/setup/world-overview/answers.md");
    });
  });

  describe("interviewPromptsDir and GATE_CHOICES", () => {
    it("name the interview's own three prompts and the gate's four answers", async () => {
      const dir = interviewPromptsDir();
      expect(dir).toBe(path.join(templatesDir(), "interview"));
      for (const file of ["write.md", "gate.md", "revise.md"]) expect(existsSync(path.join(dir, file)), file).toBe(true);
      expect(GATE_CHOICES.map((c) => c.key)).toEqual(["approve", "reject", "myself", "import"]);
      for (const c of GATE_CHOICES) expect(c.label.length, c.key).toBeGreaterThan(0);
    });
  });

  describe("afterFileApproved", () => {
    it("writes the cast sheets, rewrites audio.mainCast, and commits the file with its answers and its log", async () => {
      const root = await emptyDir();
      const io = autoIO();
      await initScaffold(options(root), io.io);
      const writer = fakeWriter();
      const result = await interviewFile(root, CAST, io.io, interviewDeps(await loadShowConfig(root), writer.executors));
      expect(result.outcome).toBe("approved");
      expect(result.cast).toEqual([{ name: "Vale", line: "the keeper of the light" }]);

      const shas = await afterFileApproved(root, CAST, result);

      expect(shas).toHaveLength(1);
      expect(existsSync(path.join(root, "Canon/characters/Vale/vale.md"))).toBe(true);
      expect((await loadShowConfig(root)).audio?.["mainCast"]).toEqual(["narrator", "Vale"]);

      const log = await gitLog(root);
      expect(log).toHaveLength(2);
      expect(log[0]).toBe(`canon: ${CAST.file} — approved`);
      const paths = await committedPaths(root);
      for (const rel of [
        CAST.file, "Production/setup/world-overview/answers.md", "showrunner.json",
        "Canon/characters/Vale/vale.md", `Production/setup/world-overview/runs/${result.runId}.jsonl`,
      ]) {
        expect(paths, rel).toContain(rel);
      }
      // The approval is in the log the commit carries, which is what the next visit reads.
      expect(await latestSetupLog(root, CAST)).toBe(path.join(root, "Production/setup/world-overview/runs", `${result.runId}.jsonl`));
    }, 120_000);

    it("commits a file that yields no cast without touching the config", async () => {
      const root = await emptyDir();
      const io = autoIO();
      await initScaffold(options(root), io.io);
      const writer = fakeWriter();
      const result = await interviewFile(root, ARC, io.io, interviewDeps(await loadShowConfig(root), writer.executors));
      expect(result.cast).toBeUndefined();

      await afterFileApproved(root, ARC, result);

      const paths = await committedPaths(root);
      expect(paths).toContain(ARC.file);
      expect(paths).not.toContain("showrunner.json");
      expect(existsSync(path.join(root, "Canon/characters/Vale"))).toBe(false);
      expect((await gitLog(root))[0]).toBe(`canon: ${ARC.file} — approved`);
    }, 120_000);
  });

  describe("initFinish", () => {
    it("reports a clean bible, nothing stalled and the README's next steps once every file is approved", async () => {
      const root = await emptyDir();
      const io = autoIO();
      const scaffold = await initScaffold(options(root), io.io);
      const writer = fakeWriter();
      const deps = interviewDeps(await loadShowConfig(root), writer.executors);
      const commits = [...scaffold.commits];
      for (const entry of GATED) {
        const result = await interviewFile(root, entry, io.io, deps);
        commits.push(...(await afterFileApproved(root, entry, result)));
      }

      const finish = await initFinish(root, { github: "none", engineRoot: ENGINE_ROOT }, io.io);

      expect(finish.stalled).toEqual([]);
      expect(finish.bibleCheck.missingFiles).toEqual([]);
      expect(finish.bibleCheck.missingSections).toEqual([]);
      expect(finish.remote).toBeUndefined();
      expect(finish.nextSteps).toContain("Write the premise");
      expect(finish.nextSteps).not.toContain("## The layout");
      const said = io.said.join("\n");
      expect(said).toContain("bible-check: every bible file is present and carries every section a prompt reads by name.");
      expect(said).toContain(finish.nextSteps);
      expect(said).toContain(`<the engine repository> is ${ENGINE_ROOT}`);
      // No GitHub repository was asked for, so nothing was said about one.
      expect(said).not.toContain("gh repo create");

      // One commit for the scaffold and one per gated file — the same fourteen `runInit` makes.
      expect(commits).toHaveLength(1 + 13);
      expect(await gitLog(root)).toHaveLength(1 + 13);
      expect(writer.ran).toEqual(GATED.filter((b) => b.mode === "interview").map((b) => `write:${b.key}`));
    }, 300_000);

    it("names every gated file whose interview has not been approved, and reports the bible as incomplete", async () => {
      const root = await emptyDir();
      const io = autoIO();
      await initScaffold(options(root), io.io);

      const finish = await initFinish(root, { github: "none", engineRoot: ENGINE_ROOT }, io.io);

      expect(finish.stalled).toEqual(GATED.map((b) => b.key));
      expect(finish.bibleCheck.missingFiles).toHaveLength(13);
      expect(finish.bibleCheck.missingSections).toEqual([]);
      expect(io.said.join("\n")).toContain("13 file(s) are waiting on you: world-overview");
      expect(io.said.join("\n")).toContain("bible-check found work left to do.");
      expect(finish.nextSteps).toContain("Write the premise");
    }, 120_000);
  });
});

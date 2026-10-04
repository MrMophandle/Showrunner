import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EventLog, answersPath, bibleLogDir, createGateMessageRenderer,
  type BibleFile, type Event, type Executors, type QueryFn, type ShowConfig,
} from "@showrunner/engine";
import { templatesDir } from "../src/init/paths.js";
import { parseCanonTemplate, templateWithoutQuestions } from "../src/init/scaffold.js";
import { interviewFile, isApproved, type GateChoice, type InitIO, type InterviewDeps } from "../src/init/interview.js";

const FIXTURE = fileURLToPath(new URL("fixtures/harbor-check-context.json", import.meta.url));
const INTERVIEW = path.join(templatesDir(), "interview");

const styleGuide: BibleFile = { key: "style-guide", file: "Canon/style-guide.md", mode: "interview", purpose: "The narration's voice." };
const storyCraft: BibleFile = { key: "story-craft", file: "Canon/story-craft.md", mode: "default", purpose: "The craft rules." };
const worldOverview: BibleFile = { key: "world-overview", file: "Canon/world-overview.md", mode: "interview", purpose: "The premise and the cast." };

async function harborConfig(): Promise<ShowConfig> {
  const context = JSON.parse(await readFile(FIXTURE, "utf8")) as { show: ShowConfig };
  return context.show;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "showrunner-interview-"));
  await mkdir(path.join(root, "Canon"), { recursive: true });
  return root;
}

/** An `InitIO` whose answers and choices come from arrays, in order. Everything it said is kept,
 *  so a test can assert what the author was shown; running past the end of either array throws
 *  rather than hanging, which is what a driver that asked one question too many would do to a
 *  real terminal. */
function scriptedIO(answers: readonly string[], choices: readonly GateChoice[], onChoose?: () => void) {
  const said: string[] = [];
  const asked: { question: string; default?: string }[] = [];
  let a = 0;
  let c = 0;
  const io: InitIO = {
    say: (text) => { said.push(text); },
    ask: async (question, opts) => {
      asked.push(opts?.default === undefined ? { question } : { question, default: opts.default });
      if (a >= answers.length) throw new Error(`no scripted answer for: ${question}`);
      return answers[a++] as string;
    },
    choose: async <T extends string>(_q: string, offered: readonly { key: T; label: string }[]) => {
      onChoose?.();
      if (c >= choices.length) throw new Error("no scripted choice left");
      const want = choices[c++] as string;
      const found = offered.find((o) => o.key === want);
      if (!found) throw new Error(`the driver did not offer ${want}`);
      return found.key;
    },
  };
  return { io, said, asked, answersUsed: () => a };
}

/** The write and revise agents, faked: each writes the file the step declares as its output, as
 *  the real one would, and records that it ran. `verdict` is never set — the bible steps have no
 *  schema — so the step's result is the text. */
function fakeAgent(root: string) {
  const ran: string[] = [];
  const executors: Executors = {
    script: async () => ({ ok: true }),
    agent: async (step, ctx) => {
      ran.push(step.id);
      const file = step.outputs?.[0];
      if (file !== undefined) {
        const body = step.id === "revise" ? "# T\n\n## H\nanswer, revised\n" : "# T\n\n## H\nanswer\n";
        await writeFile(path.join(ctx.showRoot, file), body, "utf8");
      }
      return { ok: true, text: `${step.id} done`, toolCalls: 2 };
    },
  };
  return { executors, ran, root };
}

/** The real gate-message renderer, built against this task's own `tools/templates/interview/`, so
 *  every test renders `gate.md` from the file on disk with the vars the pipeline actually passes.
 *  Its `query` is never called: a gate message is rendered, never queried. */
async function deps(root: string, over: Partial<InterviewDeps> = {}): Promise<InterviewDeps & { ran: string[] }> {
  const show = await harborConfig();
  const agent = fakeAgent(root);
  const query: QueryFn = () => { throw new Error("a gate message is rendered, never queried"); };
  return {
    executors: agent.executors,
    renderGateMessage: createGateMessageRenderer({ query, promptsDir: INTERVIEW, show }),
    now: () => new Date("2030-04-01T09:00:00.000Z"),
    operator: "cli:author",
    ran: agent.ran,
    ...over,
  };
}

async function logEvents(root: string, entry: BibleFile, runId: string, productionDir?: string): Promise<Event[]> {
  return new EventLog(path.join(bibleLogDir(root, entry.key, productionDir), `${runId}.jsonl`)).read();
}

const kindsOf = (events: Event[]): string[] => events.map((e) => `${e.kind}:${e.stepId ?? "-"}`);

describe("interviewFile: an interviewed file approved at its first gate", () => {
  it("asks the template's questions, writes the answers, runs write then the gate, and completes", async () => {
    const root = await tempRoot();
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    expect(questions).toBeGreaterThan(0);
    const answers = Array.from({ length: questions }, (_, i) => `answer ${i + 1}`);
    const io = scriptedIO(answers, ["approve"]);
    const d = await deps(root);
    const result = await interviewFile(root, styleGuide, io.io, d);

    expect(result.outcome).toBe("approved");
    expect(result.key).toBe("style-guide");
    expect(d.ran).toEqual(["write"]);
    expect(result.cast).toBeUndefined();
    expect(io.answersUsed()).toBe(questions);
    expect(result.commits).toEqual([
      "Canon/style-guide.md",
      "Production/setup/style-guide/answers.md",
      path.join("Production", "setup", "style-guide", "runs", `${result.runId}.jsonl`),
    ]);

    const written = await readFile(path.join(root, answersPath("style-guide")), "utf8");
    expect(written).toContain("## Narration");
    expect(written).toContain("<!-- Q: ");
    expect(written).toContain("answer 1");
    expect(written).not.toContain("(blank)");

    const events = await logEvents(root, styleGuide, result.runId);
    expect(kindsOf(events)).toEqual([
      "run_started:-",
      "step_started:write", "step_completed:write",
      "gate_opened:gate", "gate_answered:gate",
      "run_finished:-",
    ]);
    expect(events[0]?.payload["episodeId"]).toBe("setup");
    expect(events[0]?.payload["trigger"]).toBe("cli:author");
    expect(events[0]?.payload["pipeline"]).toBe("bible-style-guide");
    const answer = events.find((e) => e.kind === "gate_answered");
    expect(answer?.payload).toMatchObject({ approved: true, attempt: 1, by: "cli:author" });
    expect(events.at(-1)?.payload["status"]).toBe("completed");

    // The gate message is the rendered gate.md, with this file's vars in it.
    const message = events.find((e) => e.kind === "gate_opened")?.payload["message"];
    expect(message).toContain("Canon/style-guide.md");
    expect(message).toContain("The narration's voice.");
    expect(io.said.some((s) => s.includes("--- Canon/style-guide.md ---"))).toBe(true);
    expect(io.said.some((s) => s.includes("## H\nanswer"))).toBe(true);
  });

  it("records an unanswered question as a blank the writer is told how to treat", async () => {
    const root = await tempRoot();
    const template = await readFile(path.join(templatesDir(), "canon", "timeline.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const timeline: BibleFile = { key: "timeline", file: "Canon/timeline.md", mode: "interview", purpose: "The world's history." };
    const io = scriptedIO(["the eras", "   ", ...Array.from({ length: questions - 2 }, () => "x")], ["approve"]);
    const result = await interviewFile(root, timeline, io.io, await deps(root));
    expect(result.outcome).toBe("approved");
    expect(await readFile(path.join(root, answersPath("timeline")), "utf8")).toContain("(blank)");
  });
});

describe("interviewFile: a rejection", () => {
  it("runs the fix agent, reopens the gate at attempt 2, and completes on the approval", async () => {
    const root = await tempRoot();
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const io = scriptedIO([...Array.from({ length: questions }, () => "a"), "too long, and it rhymes"], ["reject", "approve"]);
    const d = await deps(root);
    const result = await interviewFile(root, styleGuide, io.io, d);

    expect(result.outcome).toBe("approved");
    expect(d.ran).toEqual(["write", "revise"]);
    const events = await logEvents(root, styleGuide, result.runId);
    expect(kindsOf(events)).toEqual([
      "run_started:-",
      "step_started:write", "step_completed:write",
      "gate_opened:gate", "gate_answered:gate",
      "step_started:revise", "step_completed:revise",
      "gate_opened:gate", "gate_answered:gate",
      "run_finished:-",
    ]);
    const opened = events.filter((e) => e.kind === "gate_opened");
    expect(opened.map((e) => e.payload["attempt"])).toEqual([1, 2]);
    const answered = events.filter((e) => e.kind === "gate_answered");
    expect(answered[0]?.payload).toMatchObject({ approved: false, notes: "too long, and it rhymes", attempt: 1 });
    expect(answered[1]?.payload).toMatchObject({ approved: true, attempt: 2 });
    expect(events.find((e) => e.kind === "step_started" && e.stepId === "revise")?.payload["rejectionOf"]).toBe("gate");
    expect(await readFile(path.join(root, "Canon/style-guide.md"), "utf8")).toContain("revised");
  });
});

describe("interviewFile: I will write this one myself", () => {
  it("writes the template with its questions stripped and approves, with the notes saying so", async () => {
    const root = await tempRoot();
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const io = scriptedIO(Array.from({ length: questions }, () => "a"), ["myself"]);
    const result = await interviewFile(root, styleGuide, io.io, await deps(root));
    expect(result.outcome).toBe("written-by-author");
    expect(await readFile(path.join(root, "Canon/style-guide.md"), "utf8")).toBe(templateWithoutQuestions(template));
    const events = await logEvents(root, styleGuide, result.runId);
    expect(events.find((e) => e.kind === "gate_answered")?.payload).toMatchObject({ approved: true, notes: "the author writes this file" });
  });
});

describe("interviewFile: import this file", () => {
  it("copies the file's bytes over the bible file and records where it came from", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "author-"));
    const source = path.join(outside, "my-style-guide.md");
    await writeFile(source, "# Mine\n\n## Narration\nFirst person, past tense.\n", "utf8");
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const io = scriptedIO([...Array.from({ length: questions }, () => "a"), source], ["import"]);
    const result = await interviewFile(root, styleGuide, io.io, await deps(root));
    expect(result.outcome).toBe("imported");
    expect(await readFile(path.join(root, "Canon/style-guide.md"))).toEqual(await readFile(source));
    const events = await logEvents(root, styleGuide, result.runId);
    expect(events.find((e) => e.kind === "gate_answered")?.payload).toMatchObject({ approved: true, notes: `imported from ${await realpath(source)}` });
  });

  it("refuses a path under the show's production directory, the file itself, a sibling bible file, and a directory — and asks again", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "author-"));
    const source = path.join(outside, "mine.md");
    await writeFile(source, "# Mine\n", "utf8");
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const refused = [
      path.join(root, answersPath("style-guide")),
      path.join(root, "Canon/style-guide.md"),
      path.join(root, "Canon/world-overview.md"),
      outside,
      path.join(outside, "absent.md"),
    ];
    await writeFile(path.join(root, "Canon/world-overview.md"), "# Theirs\n", "utf8");
    const io = scriptedIO([...Array.from({ length: questions }, () => "a"), ...refused, source], ["import", "import", "import", "import", "import", "import"]);
    const result = await interviewFile(root, styleGuide, io.io, await deps(root));
    expect(result.outcome).toBe("imported");
    const said = io.said.join("\n");
    expect(said).toContain("holds this interview's own answers and run logs");
    expect(said).toContain("importing it over itself would record an import that copied nothing");
    expect(said).toContain("is beside Canon/style-guide.md in the show's own bible");
    expect(said).toContain("is not a regular file");
    expect(said).toContain("does not exist");
    // Nothing was appended for a refused path: one gate, one answer, at attempt 1.
    const events = await logEvents(root, styleGuide, result.runId);
    expect(events.filter((e) => e.kind === "gate_opened").length).toBe(1);
    expect(events.filter((e) => e.kind === "gate_answered").length).toBe(1);
    expect(await readFile(path.join(root, "Canon/style-guide.md"))).toEqual(await readFile(source));
  });
});

describe("interviewFile: a default file", () => {
  it("has no write step, and the template is on disk before the gate opens", async () => {
    const root = await tempRoot();
    const file = path.join(root, "Canon/story-craft.md");
    let onDiskAtTheGate = false;
    const io = scriptedIO([], ["approve"], () => { onDiskAtTheGate = existsSync(file); });
    const d = await deps(root);
    const result = await interviewFile(root, storyCraft, io.io, d);

    expect(result.outcome).toBe("approved");
    expect(d.ran).toEqual([]);
    expect(onDiskAtTheGate).toBe(true);
    expect(io.asked).toEqual([]);
    expect(result.commits).toEqual([
      "Canon/story-craft.md",
      path.join("Production", "setup", "story-craft", "runs", `${result.runId}.jsonl`),
    ]);
    const template = await readFile(path.join(templatesDir(), "canon", "story-craft.md"), "utf8");
    expect(await readFile(file, "utf8")).toBe(templateWithoutQuestions(template));
    expect(kindsOf(await logEvents(root, storyCraft, result.runId))).toEqual([
      "run_started:-", "gate_opened:gate", "gate_answered:gate", "run_finished:-",
    ]);
  });

  it("keeps a file an earlier attempt left on disk rather than overwriting it", async () => {
    const root = await tempRoot();
    const file = path.join(root, "Canon/story-craft.md");
    await writeFile(file, "# Mine, from the attempt before\n", "utf8");
    const io = scriptedIO([], ["approve"]);
    await interviewFile(root, storyCraft, io.io, await deps(root));
    expect(await readFile(file, "utf8")).toBe("# Mine, from the attempt before\n");
  });
});

/** The answers for an interviewed template, with one answer placed under the heading it belongs
 *  to: the cast is read out of the answer to the template's own cast question, so a test that is
 *  about the cast has to put its list at that question's index and not at an arbitrary one. */
async function answersFor(key: string, byHeading: Record<string, string>, fill = "a"): Promise<string[]> {
  const template = await readFile(path.join(templatesDir(), "canon", `${key}.md`), "utf8");
  return parseCanonTemplate(template).questions.map((q) => byHeading[q.heading] ?? fill);
}

describe("interviewFile: the cast", () => {
  it("is parsed from the answer to the template's own cast question, which is asked only once", async () => {
    const root = await tempRoot();
    const list = [
      "Mira Vale — the keeper who took the contract",
      "Jean-Luc Ardent - the relief keeper",
      "Theo Ash — the harbourmaster who signs the contracts",
      "They have all known each other since before the winter.",
    ].join("\n");
    const answers = await answersFor("world-overview", { "The primary cast": list });
    const io = scriptedIO(answers, ["approve"]);
    const result = await interviewFile(root, worldOverview, io.io, await deps(root));

    expect(result.cast).toEqual([
      { name: "Mira Vale", line: "the keeper who took the contract" },
      { name: "Jean-Luc Ardent", line: "the relief keeper" },
      { name: "Theo Ash", line: "the harbourmaster who signs the contracts" },
    ]);
    // Asked once: one question per template heading and not one more, and no question mentions
    // the cast a second time.
    expect(io.asked.length).toBe(answers.length);
    expect(io.answersUsed()).toBe(answers.length);
    expect(io.said.some((s) => s.includes("They have all known each other since before the winter."))).toBe(true);
    // The list the author typed is in the answers file, under the heading it answers.
    expect(await readFile(path.join(root, answersPath("world-overview")), "utf8")).toContain("Mira Vale — the keeper");
  });

  it("is empty, and says so, when the cast answer holds no line in the asked-for form", async () => {
    const root = await tempRoot();
    const answers = await answersFor("world-overview", { "The primary cast": "Nobody recurs yet." });
    const io = scriptedIO(answers, ["approve"]);
    const result = await interviewFile(root, worldOverview, io.io, await deps(root));
    expect(result.cast).toEqual([]);
    expect(io.said.some((s) => s.includes("No cast was recorded"))).toBe(true);
  });

  it("is not collected by any other file's interview", async () => {
    const root = await tempRoot();
    const arc: BibleFile = { key: "series-arc", file: "Canon/series-arc.md", mode: "interview", purpose: "The long thread." };
    const answers = await answersFor("series-arc", {});
    const io = scriptedIO(answers, ["approve"]);
    const result = await interviewFile(root, arc, io.io, await deps(root));
    expect("cast" in result).toBe(false);
    expect(io.answersUsed()).toBe(answers.length);
  });
});

describe("interviewFile: a failed run", () => {
  it("throws with the step and the error, and names no gate", async () => {
    const root = await tempRoot();
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const io = scriptedIO(Array.from({ length: questions }, () => "a"), []);
    const failing: Executors = { script: async () => ({ ok: true }), agent: async () => ({ ok: false, error: "the model stopped", toolCalls: 0 }) };
    await expect(interviewFile(root, styleGuide, io.io, await deps(root, { executors: failing })))
      .rejects.toThrow("style-guide: write failed: the model stopped");
  });
});

describe("isApproved", () => {
  it("is false before the interview and true once its latest run completed", async () => {
    const root = await tempRoot();
    expect(await isApproved(root, storyCraft)).toBe(false);
    const io = scriptedIO([], ["approve"]);
    await interviewFile(root, storyCraft, io.io, await deps(root));
    expect(await isApproved(root, storyCraft)).toBe(true);
  });

  it("is false while a run is still waiting at its gate, and true again after a later run completes", async () => {
    const root = await tempRoot();
    // A run that stops at the gate: the log holds gate_opened and nothing after it. Its id is
    // stamped the day before the run this test makes, because `mintRunId` ends in four random
    // characters: two ids minted in the same second sort either way, so "the latest run" is only
    // unambiguous for ids stamped at different times.
    const stuck = new EventLog(path.join(bibleLogDir(root, "story-craft"), "20300331T235959Z-zzzz.jsonl"));
    await stuck.append({ runId: "20300331T235959Z-zzzz", kind: "run_started", payload: { pipeline: "bible-story-craft" } });
    await stuck.append({ runId: "20300331T235959Z-zzzz", stepId: "gate", kind: "gate_opened", payload: { attempt: 1, message: "m" } });
    expect(await isApproved(root, storyCraft)).toBe(false);
    const io = scriptedIO([], ["approve"]);
    const result = await interviewFile(root, storyCraft, io.io, await deps(root));
    // The new run is stamped 2030-04-01, so it sorts after the stuck one whatever its suffix is.
    expect(result.runId > "20300331T235959Z-zzzz").toBe(true);
    expect(await isApproved(root, storyCraft)).toBe(true);
  });
});

describe("interviewFile: a scaffold file", () => {
  it("is refused, because the pipeline fills it and it has no gate", async () => {
    const root = await tempRoot();
    const ledger: BibleFile = { key: "continuity-ledger", file: "Canon/continuity-ledger.md", mode: "scaffold", purpose: "What happened." };
    const io = scriptedIO([], []);
    await expect(interviewFile(root, ledger, io.io, await deps(root))).rejects.toThrow(/scaffold file/);
  });
});

describe("interviewFile: an import follows no symlink", () => {
  /** Every refusal is applied to the path the author typed and to the path it dereferences to,
   *  and a symlink is refused outright: `copyFile` follows a link, so a link named outside the
   *  show would otherwise satisfy every path comparison while the bytes copied were the
   *  interview's own answers, the destination itself, or a sibling bible file. */
  it("refuses a symlink to the interview's own answers file, and copies nothing from it", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "author-"));
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const honest = path.join(outside, "mine.md");
    await writeFile(honest, "# Mine\n", "utf8");
    const link = path.join(outside, "innocuous.md");
    // The answers file exists by the time the gate opens, so the link has a real target.
    const io = scriptedIO([...Array.from({ length: questions }, () => "a"), link, honest], ["import", "import"]);
    const d = await deps(root);
    // Link it before the gate: the answers are written before the run starts.
    const answersAbs = path.join(root, answersPath("style-guide"));
    await mkdir(path.dirname(answersAbs), { recursive: true });
    await writeFile(answersAbs, "## H\nanswer\n", "utf8");
    await symlink(answersAbs, link);
    const result = await interviewFile(root, styleGuide, io.io, d);
    expect(result.outcome).toBe("imported");
    expect(io.said.join("\n")).toContain("is a symbolic link");
    expect(await readFile(path.join(root, "Canon/style-guide.md"), "utf8")).toBe("# Mine\n");
    const events = await logEvents(root, styleGuide, result.runId);
    // One answer only — the refusal appended nothing — and it is the honest import.
    expect(events.filter((e) => e.kind === "gate_answered").length).toBe(1);
    expect(events.find((e) => e.kind === "gate_answered")?.payload["notes"]).toBe(`imported from ${await realpath(honest)}`);
  });

  it("refuses a symlink to the destination and a symlink to a sibling bible file, before any answer is logged", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "author-"));
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    await writeFile(path.join(root, "Canon/world-overview.md"), "# Theirs\n", "utf8");
    const honest = path.join(outside, "mine.md");
    await writeFile(honest, "# Mine\n", "utf8");
    const toSelf = path.join(outside, "self.md");
    const toSibling = path.join(outside, "sibling.md");
    const d = await deps(root);
    // The destination is written by the write agent, so both links are made against paths that
    // exist by the time the gate opens.
    await writeFile(path.join(root, "Canon/style-guide.md"), "# T\n", "utf8");
    await symlink(path.join(root, "Canon/style-guide.md"), toSelf);
    await symlink(path.join(root, "Canon/world-overview.md"), toSibling);
    const io = scriptedIO([...Array.from({ length: questions }, () => "a"), toSelf, toSibling, honest], ["import", "import", "import"]);
    const result = await interviewFile(root, styleGuide, io.io, d);
    expect(result.outcome).toBe("imported");
    expect(io.said.join("\n").match(/is a symbolic link/g)?.length).toBe(2);
    expect(await readFile(path.join(root, "Canon/style-guide.md"), "utf8")).toBe("# Mine\n");
    expect(await readFile(path.join(root, "Canon/world-overview.md"), "utf8")).toBe("# Theirs\n");
    const events = await logEvents(root, styleGuide, result.runId);
    expect(events.filter((e) => e.kind === "gate_answered").length).toBe(1);
  });

  it("refuses a real file reached through a symlinked parent directory", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "author-"));
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const honest = path.join(outside, "mine.md");
    await writeFile(honest, "# Mine\n", "utf8");
    // A link to the bible directory itself: the path typed is a real file through it.
    const linkedCanon = path.join(outside, "canon");
    await symlink(path.join(root, "Canon"), linkedCanon);
    await writeFile(path.join(root, "Canon/world-overview.md"), "# Theirs\n", "utf8");
    const io = scriptedIO([...Array.from({ length: questions }, () => "a"), path.join(linkedCanon, "world-overview.md"), honest], ["import", "import"]);
    const result = await interviewFile(root, styleGuide, io.io, await deps(root));
    expect(result.outcome).toBe("imported");
    expect(io.said.join("\n")).toContain("in the show's own bible");
    expect(await readFile(path.join(root, "Canon/style-guide.md"), "utf8")).toBe("# Mine\n");
  });
});

describe("interviewFile: a renamed production directory", () => {
  it("writes the answers and the run log under the directory it is given", async () => {
    const root = await tempRoot();
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const io = scriptedIO(Array.from({ length: questions }, () => "a"), ["approve"]);
    const d = await deps(root, { productionDir: "Out" });
    const result = await interviewFile(root, styleGuide, io.io, d);

    expect(result.outcome).toBe("approved");
    expect(result.commits).toEqual([
      "Canon/style-guide.md",
      "Out/setup/style-guide/answers.md",
      path.join("Out", "setup", "style-guide", "runs", `${result.runId}.jsonl`),
    ]);
    expect(await readFile(path.join(root, "Out/setup/style-guide/answers.md"), "utf8")).toContain("answer");
    expect(kindsOf(await logEvents(root, styleGuide, result.runId, "Out"))).toEqual([
      "run_started:-", "step_started:write", "step_completed:write",
      "gate_opened:gate", "gate_answered:gate", "run_finished:-",
    ]);
    // The write step reads the answers from the same directory.
    const events = await logEvents(root, styleGuide, result.runId, "Out");
    expect(Object.keys(events.find((e) => e.kind === "step_started" && e.stepId === "write")?.payload["inputHashes"] as object))
      .toEqual(["Out/setup/style-guide/answers.md"]);
    expect(await isApproved(root, styleGuide, "Out")).toBe(true);
    expect(await isApproved(root, styleGuide)).toBe(false);
  });

  it("refuses an import from the renamed production directory", async () => {
    const root = await tempRoot();
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = template.match(/<!--[ \t]*Q:/g)?.length ?? 0;
    const outside = await mkdtemp(path.join(tmpdir(), "author-"));
    const honest = path.join(outside, "mine.md");
    await writeFile(honest, "# Mine\n", "utf8");
    const io = scriptedIO([...Array.from({ length: questions }, () => "a"), path.join(root, "Out/setup/style-guide/answers.md"), honest], ["import", "import"]);
    const result = await interviewFile(root, styleGuide, io.io, await deps(root, { productionDir: "Out" }));
    expect(result.outcome).toBe("imported");
    expect(io.said.join("\n")).toContain("holds this interview's own answers and run logs");
  });
});

describe("interviewFile: a resumed file offers its earlier answers back", () => {
  it("hands each question the answer the earlier sitting left, and keeps what the author returns", async () => {
    const root = await tempRoot();
    const template = await readFile(path.join(templatesDir(), "canon", "style-guide.md"), "utf8");
    const questions = parseCanonTemplate(template).questions;

    // A crashed sitting: the answers file written, no run completed.
    const first = scriptedIO(questions.map((q) => `first pass: ${q.heading}`), []);
    const crashing: Executors = { script: async () => ({ ok: true }), agent: async () => ({ ok: false, error: "killed", toolCalls: 0 }) };
    await expect(interviewFile(root, styleGuide, first.io, await deps(root, { executors: crashing }))).rejects.toThrow(/write failed/);
    expect(await isApproved(root, styleGuide)).toBe(false);
    expect(first.asked.every((a) => a.default === undefined)).toBe(true);

    // The resume, a day later: every question arrives with the earlier answer as its default. The
    // clock moves because `mintRunId` ends in four random characters, so two runs minted in one
    // second sort either way and "the latest run" would be a coin toss.
    const second = scriptedIO(questions.map((q, i) => (i === 0 ? "typed over" : `first pass: ${q.heading}`)), ["approve"]);
    const later = { now: (): Date => new Date("2030-04-02T09:00:00.000Z") };
    const result = await interviewFile(root, styleGuide, second.io, await deps(root, later));
    expect(result.outcome).toBe("approved");
    expect(second.asked.map((a) => a.default)).toEqual(questions.map((q) => `first pass: ${q.heading}`));
    expect(second.said.some((s) => s.includes("from an earlier sitting"))).toBe(true);

    // What the author returned is what the file holds: the first answer typed over, the rest kept.
    const answers = await readFile(path.join(root, answersPath("style-guide")), "utf8");
    expect(answers).toContain("typed over");
    expect(answers).toContain(`first pass: ${questions[1]?.heading}`);
    expect(answers).not.toContain(`first pass: ${questions[0]?.heading}`);
    // Two runs in the directory now, and the latest is the approved one.
    expect(await isApproved(root, styleGuide)).toBe(true);
  });

  it("offers no default for a question the earlier sitting left blank, and none at all for a first sitting", async () => {
    const root = await tempRoot();
    const template = await readFile(path.join(templatesDir(), "canon", "timeline.md"), "utf8");
    const questions = parseCanonTemplate(template).questions;
    const timeline: BibleFile = { key: "timeline", file: "Canon/timeline.md", mode: "interview", purpose: "The world's history." };

    const first = scriptedIO(questions.map((_, i) => (i === 1 ? "   " : `kept ${i}`)), []);
    const crashing: Executors = { script: async () => ({ ok: true }), agent: async () => ({ ok: false, error: "killed", toolCalls: 0 }) };
    await expect(interviewFile(root, timeline, first.io, await deps(root, { executors: crashing }))).rejects.toThrow(/write failed/);

    const second = scriptedIO(questions.map((_, i) => `second ${i}`), ["approve"]);
    await interviewFile(root, timeline, second.io, await deps(root, { now: (): Date => new Date("2030-04-02T09:00:00.000Z") }));
    expect(second.asked.map((a) => a.default)).toEqual(questions.map((_, i) => (i === 1 ? undefined : `kept ${i}`)));
  });
});

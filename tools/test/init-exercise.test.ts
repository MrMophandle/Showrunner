/** The exercise: one invented show taken from `init` to its first `NEEDS_IDEA` and then to the
 *  outline gate, with no agent call and no network.
 *
 *  Every other test in this plan checks one piece. This one checks that the pieces fit: that the
 *  config `init` writes is a config `loadShowConfig` accepts, that the prompt set it copies renders
 *  against that config, that the bible it interviews satisfies `bible-check` *and* the episode
 *  pipeline's own `bible-ready` guard, and that the pipeline the engine builds over the result
 *  stops where a new show is supposed to stop — at the premise the author has not written yet.
 *
 *  Two of its five checks spawn the built CLIs (`tools/dist/check-prompts.js`,
 *  `tools/dist/bible-check.js`) rather than importing the modules, because the `bin` entries are
 *  part of what Task 8 shipped and an import would leave them unexercised. That makes the build
 *  order load-bearing: `npm run build -w engine` then `npm run build -w tools` before this suite,
 *  since `tools/dist/*.js` imports `@showrunner/engine`, which resolves to `engine/dist/index.js`.
 *  The assertions name stderr as well as the exit code so a module-resolution failure cannot be
 *  mistaken for a prompt that rendered.
 *
 *  The show is Harbor Lights, the invented show the rest of the tools tests use. No file under
 *  `engine/`, `scripts/`, `render/`, `tools/` or `console/` may name a real one (README.md's
 *  "Starting a show" and the show-name rule beneath it). */

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  EventLog, createGateMessageRenderer, episodePipeline, headingMatches, loadShowConfig, mintRunId, run,
  type Event, type Executors, type QueryFn, type ShowConfig,
} from "@showrunner/engine";
import { runInit } from "../src/init/init.js";
import type { InitIO } from "../src/init/interview.js";
import { templatesDir } from "../src/init/paths.js";
import { parseCanonTemplate, templateWithoutQuestions } from "../src/init/scaffold.js";

const execFileAsync = promisify(execFile);

/** The repository that holds the engine, the tools and the templates: one directory above
 *  `tools/`, which is two above `tools/templates/`. The episode pipeline is given it as
 *  `engineRoot`, and the two built CLIs are spawned out of it. */
const ENGINE_ROOT = path.resolve(templatesDir(), "..", "..");
const TOOLS_DIST = path.join(ENGINE_ROOT, "tools", "dist");
const SHOW_NAME = "Harbor Lights";
const SHOW_SLUG = "HarborLights";
const EPISODE = "s01e01";

/** The one sentence every question is answered with. One sentence per question is all the exercise
 *  needs — the writer agent is faked, so what matters is that an answer travels from the terminal
 *  into the answers file, out of it into the bible file, and through `bible-check` to the
 *  `bible-ready` guard. */
const ANSWER = "Harbor Lights follows a keeper on a winter contract at Harbor, and the light that is already burning when she arrives.";

/** The cast, in the form the `## The primary cast` question asks for. The cast is collected from
 *  that one answer and from nowhere else, so this is the only answer that is not `ANSWER`. */
const CAST_ANSWER = [
  "Vale — the keeper who signs the winter contract",
  "the Warden — whoever has been tending the light",
  "Pim — the boy who rows the supply run out",
  "Maeve — the harbour master who keeps the contracts",
].join("\n");

const CAST_NAMES = ["Vale", "the Warden", "Pim", "Maeve"];

/** The question that collects the cast, recognised by the form it asks for. `world-overview.md` is
 *  the only canon template whose questions carry it. */
const CAST_QUESTION = /Name\s+[—–-]\s+one line/i;

/** The premise the author writes between the two episode runs — three sentences, which is what the
 *  show README's "Your first episode" section asks for. */
const PREMISE = [
  "Vale takes the winter contract on the Harbor light and finds it already lit.",
  "It is her episode: she has to decide whether to report the Warden or keep him.",
  "It must pay off the cold open, where the lamp turns without a hand on it.",
].join(" ");

/** The author at the terminal: one sentence for every question, the cast for the cast question,
 *  and approve at every gate. Everything said is kept so a failure can be read. */
function scriptedIO(): { io: InitIO; said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  const io: InitIO = {
    say: (text) => { said.push(text); },
    ask: async (question) => {
      asked.push(question);
      return CAST_QUESTION.test(question) ? CAST_ANSWER : ANSWER;
    },
    choose: async <T extends string>(_question: string, choices: readonly { key: T; label: string }[]) => {
      const approve = choices.find((c) => c.key === "approve");
      if (approve === undefined) throw new Error("the interview offered no approve");
      return approve.key;
    },
  };
  return { io, said, asked };
}

/** The answers file read back, by heading — the inverse of the driver's own writer.
 *
 *  **A section opens only on a `## <heading>` line naming one of the template's own headings, in
 *  the template's order**, which is the driver's rule (`parsePriorAnswers` in
 *  `tools/src/init/interview.ts`) and therefore the only rule that reads back what the driver
 *  wrote. Treating any `## ` line as a boundary — which this fake did — is laxer than the driver,
 *  so a prose answer illustrating a markdown heading would be truncated here and not there, and
 *  the fake writer would put a different file on disk than the real one. Harmless while the
 *  scripted answers contain no `## ` line, and a divergence between the two sides of the exercise
 *  either way. `headingMatches` does the comparison, in the engine's own direction. */
function parseAnswersFile(text: string, headings: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | undefined;
  let next = 0;
  let body: string[] = [];
  const close = (): void => {
    if (heading !== undefined) out.set(heading, body.join("\n").trim());
    body = [];
  };
  for (const line of text.split("\n")) {
    const at = headings.findIndex((h, i) => i >= next && headingMatches(line, h));
    if (at !== -1) { close(); heading = headings[at] as string; next = at + 1; continue; }
    if (heading === undefined) continue;
    // The question comment under the heading is the file's record of what was asked, not an answer.
    if (body.length === 0 && /^[ \t]*<!--[ \t]*Q:/.test(line)) continue;
    body.push(line);
  }
  close();
  return out;
}

/** The bible file the faked writer produces: the template's header, then every one of the
 *  template's headings in order, each carrying the author's answer or `_Not yet decided._`.
 *
 *  It writes **every** heading the template carries and not only the questioned ones, because that
 *  is what makes `bible-check`'s section report meaningful: `REQUIRED_SECTIONS` names headings a
 *  prompt reads by name, the canon templates carry every one of them
 *  (`tools/test/templates.test.ts`), and a heading with no question of its own would otherwise be
 *  absent from the file and reported as a missing section. The real writer prompt
 *  (`tools/templates/interview/write.md`) is told to do the same thing. */
async function writeBibleFile(templatePath: string, answersAbs: string, destination: string): Promise<void> {
  const template = await readFile(templatePath, "utf8");
  const parsed = parseCanonTemplate(template);
  const answers = parseAnswersFile(await readFile(answersAbs, "utf8"), parsed.questions.map((q) => q.heading));
  const { header } = parsed;
  const out: string[] = [];
  if (header.trim() !== "") out.push(header.trim(), "");
  // The walk starts after the header so a title heading inside it is not emitted twice. Level 1 is
  // matched as well as level 2 because one template asks its only question on its title line.
  for (const line of templateWithoutQuestions(template.slice(header.length)).split("\n")) {
    const m = /^(#{1,2})[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m === null) continue;
    const answer = answers.get((m[2] as string).trim());
    out.push(line.trim(), "", answer === undefined || answer === "" ? "_Not yet decided._" : answer, "");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${out.join("\n").trimEnd()}\n`, "utf8");
}

/** The bible writer and the fix agent, faked: each writes the file its step declares as an output,
 *  from the answers file its step declares as an input, and records that it ran. No query is made.
 *  The script half throws, because no bible pipeline has a script step and a call would be a
 *  surprise worth failing on. */
function fakeWriter(): { executors: Executors; ran: string[] } {
  const ran: string[] = [];
  const executors: Executors = {
    script: async (step) => { throw new Error(`the bible interview ran a script step: ${step.id}`); },
    agent: async (step, ctx) => {
      ran.push(`${step.id}:${String(step.vars?.["key"] ?? "")}`);
      const templatePath = step.vars?.["templatePath"];
      const answers = step.vars?.["answersPath"];
      const file = step.outputs?.[0];
      if (templatePath !== undefined && answers !== undefined && file !== undefined) {
        await writeBibleFile(templatePath, path.join(ctx.showRoot, answers), path.join(ctx.showRoot, file));
      }
      return { ok: true, text: `${step.id} wrote ${String(file)}`, toolCalls: 2 };
    },
  };
  return { executors, ran };
}

/** The outline the fake writes for the `outline` step: the show's **own**
 *  `Episodes/_TEMPLATE/outline.md`, which `init` copied in, with the episode id on its title line.
 *
 *  Writing `# <stepId>` as every artifact — which is what this fake did before — is how findings
 *  I1, I2 and I3 survived ten task reviews: the exercise could not see that the outline prompt's
 *  exemplar named sections the template did not carry, because no outline in any test was ever in
 *  the template's shape. Taking the template itself means the artifact on disk carries every
 *  heading the prompts read by name and the two `### Beat <n>` headings the draft loop counts, so
 *  the loop's `total` is not zero, and it cannot drift from the template: the template is where
 *  it comes from. */
async function outlineFromTemplate(showRoot: string, episodeId: string): Promise<string> {
  const template = await readFile(path.join(showRoot, "Episodes", "_TEMPLATE", "outline.md"), "utf8");
  return template.replace(/^# .*$/m, `# ${episodeId} — "The Winter Contract"`);
}

/** Every episode step that does real work, faked: an agent writes each declared output and returns
 *  a passing verdict when its step declares a schema, and a script records its argv and succeeds.
 *
 *  The verdict matters. `canon-review-outline` declares `canon-review.schema.json`, and
 *  `outline-gate.gate.md` renders `{{results.canon-review-outline.verdict}}` and
 *  `.deviations` — a plain string result would make that gate message a hole and fail the gate
 *  instead of opening it. A passing verdict is also what sends `outline-fix-gate` to "yes", which
 *  bypasses the `outline-revise` loop, so the run reaches the gate without the fake having to
 *  satisfy a loop sentinel as well. */
function fakeEpisodeWork(): { executors: Executors; ran: string[] } {
  const ran: string[] = [];
  const executors: Executors = {
    script: async (step, ctx) => {
      ran.push(`script:${step.id}`);
      // Every declared output is written, the same way the agent branch writes its own. The two
      // fakes disagreed before: the script half reported success and wrote nothing, so
      // `canon-ledger-outline`'s declared `canon-ledger.md` was never on disk. Harmless today —
      // the runner hashes a missing output to null — and a trap for the first step that reads it.
      for (const out of step.outputs ?? []) {
        const abs = path.join(ctx.showRoot, out);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, `${step.id} wrote this.\n`, "utf8");
      }
      return { ok: true, result: `${step.id} ok` };
    },
    agent: async (step, ctx) => {
      ran.push(`agent:${step.id}`);
      for (const out of step.outputs ?? []) {
        const abs = path.join(ctx.showRoot, out);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, path.basename(out) === "outline.md"
          ? await outlineFromTemplate(ctx.showRoot, ctx.episodeId)
          : `# ${step.id}\n\nwritten by the exercise's fake executor.\n`, "utf8");
      }
      const text = `${step.id} done`;
      return step.schemaFile === undefined
        ? { ok: true, text, toolCalls: 1 }
        : { ok: true, text, verdict: { pass: true, verdict: "CANON PASSED", issues: [], deviations: [] }, toolCalls: 1 };
    },
  };
  return { executors, ran };
}

/** One of the built CLIs, run to completion: the exit code and both streams, never a throw, so an
 *  assertion can name all three. */
async function cli(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(TOOLS_DIST, script), ...args], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** The payload of the one `step_completed` logged for `stepId`, or undefined. */
function completionOf(events: readonly Event[], stepId: string): Record<string, unknown> | undefined {
  return events.find((e) => e.stepId === stepId && e.kind === "step_completed")?.payload;
}

/** One episode run of `pipeline` over `root`, on a log of its own.
 *
 *  A log of its own per run, and not a resume of the first: `run()` returns a finished log's
 *  verdict without executing anything (`engine/src/runner.ts:236-241`), so re-running the failed
 *  `NEEDS_IDEA` log would report the same failure however many premises were written. A relaunch
 *  mints a new run id, which is what this does. */
async function episodeRun(root: string, show: ShowConfig, at: string, executors: Executors): Promise<{ result: Awaited<ReturnType<typeof run>>; events: Event[] }> {
  const pipeline = episodePipeline({ show, episodeId: EPISODE, engineRoot: ENGINE_ROOT });
  const runId = mintRunId(new Date(at));
  const log = new EventLog(path.join(root, show.productionDir ?? "Production", EPISODE, "runs", `${runId}.jsonl`));
  const query: QueryFn = () => { throw new Error("a gate message is rendered, never queried"); };
  const result = await run({
    pipeline,
    ctx: { runId, episodeId: EPISODE, showRoot: root, trigger: "init-exercise" },
    log,
    executors,
    renderGateMessage: createGateMessageRenderer({ query, show }),
  });
  return { result, events: await log.read() };
}

describe("the init exercise: a whole show from init to its first NEEDS_IDEA", () => {
  const made: string[] = [];
  afterEach(async () => {
    while (made.length > 0) await rm(made.pop() as string, { recursive: true, force: true });
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  }

  it("lays the show out, renders every prompt, passes bible-check, stops at NEEDS_IDEA, then reaches outline", async () => {
    const root = path.join(await tempDir("init-exercise-"), SHOW_SLUG);
    const io = scriptedIO();
    const writer = fakeWriter();

    const report = await runInit(
      { name: SHOW_NAME, path: root, github: "none", engineRoot: ENGINE_ROOT },
      io.io,
      { executors: writer.executors, now: () => new Date("2030-04-01T09:00:00.000Z"), operator: "init-exercise" },
    );

    // ── (a) loadShowConfig accepts the result ────────────────────────────────────────────────
    const show = await loadShowConfig(root);
    expect([show.showName, show.showSlug, show.canonDir, show.episodesDir, show.productionDir, show.promptsDir])
      .toEqual([SHOW_NAME, SHOW_SLUG, "Canon", "Episodes", "Production", "prompts"]);
    expect(show.output.nasRoot).toBe(`/Volumes/media/${SHOW_SLUG}`);
    expect(show.audio?.["mainCast"]).toEqual(["narrator", ...CAST_NAMES]);
    // Thirteen gated bible files, one commit each, after the scaffold's own commit. No remote was
    // asked for, so none was made and the report carries none.
    expect(report.files).toHaveLength(13);
    expect(report.commits).toHaveLength(14);
    expect(report.remote).toBeUndefined();
    expect(report.nextSteps).toContain("Write the premise.");
    const log = await execFileAsync("git", ["log", "--oneline"], { cwd: root });
    expect(log.stdout.trim().split("\n")).toHaveLength(14);
    // The writer agent ran once per interviewed file — ten of the thirteen gated rows are
    // `interview` and three are `default`, which have a gate over the template and no writer — and
    // the fix agent never did, because every gate was approved at its first attempt.
    expect(writer.ran.filter((r) => r.startsWith("write:"))).toHaveLength(10);
    expect(writer.ran.filter((r) => r.startsWith("revise:"))).toEqual([]);
    // The author's own sentence reached the bible, through the answers file and the writer.
    expect(await readFile(path.join(root, "Canon/world-overview.md"), "utf8")).toContain(ANSWER);
    for (const name of CAST_NAMES) {
      expect(await readFile(path.join(root, `Canon/characters/${name}/${name.toLowerCase().replace(/ /g, "-")}.md`), "utf8")).toContain(name);
    }

    // ── (b) every prompt in the new show's prompts/ renders against the new config ───────────
    // The results object is the Harbor Lights fixture's, plus the two singular `<gate>:rejection`
    // keys that `outline-gate.reject.md` and `script-gate.reject.md` name and the fixture does not
    // carry (`tools/test/templates.test.ts` synthesises those per file as it loops; one context
    // file handed to one CLI invocation cannot). `show` is the config init just wrote, not the
    // fixture's: that is what makes this a check of the new show.
    const fixture = JSON.parse(
      await readFile(path.join(import.meta.dirname, "fixtures/harbor-check-context.json"), "utf8"),
    ) as { results: Record<string, unknown>; season: number };
    const rejection = "The showrunner rejected this step: beat 4 has the Warden opening the conversation. He answers; he does not open.";
    const contextFile = path.join(await tempDir("init-exercise-ctx-"), "check-context.json");
    await writeFile(contextFile, JSON.stringify({
      episodeId: EPISODE,
      runId: "init-exercise",
      showRoot: root,
      season: fixture.season,
      show,
      results: { ...fixture.results, "outline-gate:rejection": rejection, "script-gate:rejection": rejection },
    }, null, 2), "utf8");

    const promptsDir = path.join(root, "prompts");
    const checked = await cli("check-prompts.js", ["--prompts", promptsDir, "--context", contextFile]);
    expect([checked.code, checked.stdout.trim(), checked.stderr.trim()])
      .toEqual([0, `every prompt in ${promptsDir} renders`, ""]);

    // ── (c) bible-check exits 0 over the interviewed bible ───────────────────────────────────
    const bible = await cli("bible-check.js", ["--show", root]);
    expect([bible.code, bible.stderr.trim()]).toEqual([0, ""]);
    expect(bible.stdout).toContain("carries every section a prompt reads by name");

    // ── (d) the episode pipeline builds, and stops at NEEDS_IDEA ─────────────────────────────
    const first = fakeEpisodeWork();
    const stopped = await episodeRun(root, show, "2030-04-02T09:00:00.000Z", first.executors);
    expect(stopped.result).toEqual({
      status: "failed",
      stepId: "premise",
      error: `NEEDS_IDEA: write Episodes/${EPISODE}/premise.md`,
    });
    // The two guards before it passed, and nothing else ran: the premise is the first thing a new
    // show is missing, and it is missing before any agent or script is spent.
    expect(stopped.events.filter((e) => e.kind === "step_completed").map((e) => e.stepId))
      .toEqual(["previous-episode", "bible-ready"]);
    expect(completionOf(stopped.events, "previous-episode")?.["result"]).toBe("no previous episode to wait for");
    expect(completionOf(stopped.events, "bible-ready")?.["result"]).toBe("bible complete");
    expect(first.ran).toEqual([]);

    // ── (e) with the premise written, the run reaches outline and stops at the outline gate ──
    await mkdir(path.join(root, "Episodes", EPISODE), { recursive: true });
    await writeFile(path.join(root, "Episodes", EPISODE, "premise.md"), `${PREMISE}\n`, "utf8");
    const second = fakeEpisodeWork();
    const reached = await episodeRun(root, show, "2030-04-02T10:00:00.000Z", second.executors);
    expect(reached.result.status).toBe("waiting");
    expect(reached.result.status === "waiting" ? reached.result.gate.stepId : undefined).toBe("outline-gate");
    // The outline step is what the premise unblocked, and the gate it stopped at is four steps
    // later: asserting the stop as well as the step is what proves nothing in between failed.
    expect(second.ran).toContain("agent:outline");
    expect(second.ran).toContain("agent:canon-review-outline");
    expect(second.ran).toContain("script:canon-ledger-outline");
    expect(completionOf(reached.events, "premise")?.["result"]).toBe(PREMISE);

    // The outline on disk is in the format the show's own template teaches, which is what makes
    // the rest of this assertion worth making: every heading the prompts read by name, and the
    // `### Beat <n>` headings the draft loop counts for its `total`. A `done/0` draft loop is the
    // blind loop the spec's §6.7 exists to surface, and it is what an outline carrying none of
    // these would produce on every iteration.
    const outlineText = await readFile(path.join(root, "Episodes", EPISODE, "outline.md"), "utf8");
    expect(outlineText).toContain(`# ${EPISODE} — "The Winter Contract"`);
    for (const heading of ["## Scene synopsis", "## Arc beats", "## Cast", "## Ending duties", "## Threads opened", "## New canon proposed"]) {
      expect(outlineText, heading).toContain(heading);
    }
    expect(outlineText.split("\n").filter((l) => /^### Beat \d+/.test(l))).toHaveLength(2);
    // The script step's declared output is on disk too, which is the fake the agent half always
    // was and the script half was not.
    expect(existsSync(path.join(root, "Episodes", EPISODE, "canon-ledger.md"))).toBe(true);
    // The gate message the showrunner would read, rendered from the new show's own prompt set
    // against the new show's own config.
    const message = reached.result.status === "waiting" ? reached.result.gate.message : "";
    expect(message).toContain(`Episodes/${EPISODE}/outline.md`);
    expect(message).toContain("CANON PASSED");
  }, 300_000);
});

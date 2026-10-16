import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentExecutor, createGateMessageRenderer, type AgentMessage, type AgentQueryOptions, type QueryFn } from "../src/agent-step.js";
import { EventLog, type Event } from "../src/events.js";
import { orderSteps } from "../src/pipeline.js";
import { episodePipeline } from "../src/pipelines/episode.js";
import { run } from "../src/runner.js";
import type { ShowConfig } from "../src/show-config.js";
import type { Executors, Pipeline, ScriptStep } from "../src/steps.js";

/** The run-until-green exercise: the **real** episode pipeline walked through two review rounds to a
 *  green panel and an open script gate, with the run log, the step order, the reset batch, the
 *  prompt rendering and the gate's message all the production ones.
 *
 *  Why it is a file of its own rather than another case in `test/panel.test.ts`. That file proves the
 *  panel's own rules against a miniature pipeline declared inside it — two reviewers, five reset ids,
 *  synthetic step ids and a gate sentence held in a test constant — which is the right fixture for
 *  "what does the step do" and the wrong one for "does the episode's write phase actually go round".
 *  This file asserts the second question with nothing synthetic in the way: `episodePipeline`'s own
 *  eleven-id reset batch, its real step ids, the real `createAgentExecutor` rendering real prompt
 *  files from the show's prompts directory, and the gate message rendered through
 *  `createGateMessageRenderer` from a `script-gate.gate.md` copied from the shipped template.
 *
 *  It is hermetic and runs in the ordinary suite, unlike `test/ep98-exercise.test.ts`, which is
 *  env-gated because it spawns the real Python steps against a show repository. Fake here are exactly
 *  two boundaries: the SDK (a scripted `query`, so each step's reply is chosen by the test and the
 *  prompt it was given is recorded) and the Python child process (one script step, the canon ledger).
 *  Everything between them is the engine as it ships.
 *
 *  The round it walks is the measured one (inventory §2.3, J-09): `tone-check` and `repetition-check`
 *  come back red on round 1, the writer revises once, and the second panel is green. */

/** Harbor Lights, the invented show every engine and tools fixture uses; no file under `engine/`
 *  names a real one (README.md's "Starting a show" and the show-name rule beneath it). The three
 *  model aliases are what `createAgentExecutor` maps a step's `model` through. */
const show: ShowConfig = {
  showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts", episodesDir: "Episodes",
  models: { medium: "model-medium", large: "model-large", writer: "model-writer" }, airMap: { ep10: [1, 10] },
  output: { nasRoot: "/tmp/no-such-nas", mixFilename: "{slug} S{season:02d}E{episode:02d}.wav", videoFilename: "episode.mp4" },
  audio: { voiceRefsDir: "Production/voice-refs", voiceRegistry: "Canon/voice-registry.md" },
  visual: { refs: "Canon/refs.json", style: "Canon/visual-style.md", castingPileDir: "Canon/characters" },
  video: { compositionId: "Episode" },
  publish: { guide: "Canon/publishing-guide.md" },
};

const EP = "s02e01";
const RUN = "r1";

/** The six checks, in the pipeline's own declaration order. `canon-review-script` is the seventh
 *  panel member and is kept apart because its verdict carries `deviations`, which the canon ledger
 *  step reads out of it. */
const CHECKS = ["tone-check", "flow-check", "character-check", "structure-check", "environment-check", "repetition-check"] as const;
const PANEL = ["canon-review-script", ...CHECKS] as const;

/** The eleven ids a red round invalidates, in the order `episodePipeline` declares them — the ten
 *  the script gate's own rejection closure already re-ran, plus the panel itself. The exercise
 *  asserts the batch equals this list rather than counting it, so a pipeline edit that drops a step
 *  out of the round fails here by name. */
const RESETS = [
  "hand-edits-script", "revise", "canon-review-script", "canon-ledger-script",
  ...CHECKS, "panel",
] as const;

/** What each reviewer call costs and what the one revision costs, in US dollars. Two figures rather
 *  than seven so the arithmetic in the assertions is legible: round 1 is seven reviewer calls, the
 *  whole loop is fourteen reviewer calls plus one revision, and the panel sums them by session
 *  maximum. */
const REVIEWER_COST = 0.8666;
const REVISE_COST = 3.2348;
const ROUND_1_COST = 6.0662; // 7 × 0.8666
const GREEN_COST = 15.3672; // 14 × 0.8666 + 3.2348

/** The prompt files the exercise writes into the show, one per step that actually runs. Each begins
 *  with a `STEP <id>` line, which is how the scripted `query` tells which step it is answering: the
 *  SDK options carry the model and the tools but not the step id, and a prompt is the only thing the
 *  seam sees. The bodies name only `{{prior.*}}` and `{{round.*}}` because those two are what Plan J
 *  added and what this exercise is for — and none of them contains the word the round-1 reviewer
 *  assertion looks for, so finding it in a rendered prompt means a variable rendered it. */
const reviewerPrompt = (id: string) => `STEP ${id}
Round {{round.n}} of the panel, \${{round.costUsd}} spent so far.

## Your prior verdict
{{prior.${id}}}
`;

/** The writer's prompt, in the shape `tools/templates/prompts/revise.md` ships: all seven verdicts
 *  read as `{{prior.<id>}}` — never `{{results.<id>}}`, which the round's reset has already deleted —
 *  and the writer's own last round report, which is absent until round 3 because round 1 bypasses
 *  this step. */
const REVISE_PROMPT = `STEP revise
Round {{round.n}} of the revision.
Canon: {{prior.canon-review-script}}
${CHECKS.map((id) => `${id}: {{prior.${id}}}`).join("\n")}

## Your last round
{{prior.revise}}
`;

/** `tools/templates/prompts/script-gate.gate.md` as Task 2 ships it, copied verbatim. The template
 *  itself is pinned by `tools/test/templates.test.ts`; this copy is here because nothing under
 *  `engine/` may read the tools workspace's files, and what the exercise proves is the other half —
 *  that the engine's own `roundExtras` fills those two variables with the round the run reached and
 *  what it cost. */
const GATE_TEMPLATE = `Script drafted: {{show.episodesDir}}/{{episodeId}}/script.md
The panel is green after {{round.n}} round(s) (\${{round.costUsd}} of review and revision).
Approve to commit. Reject with notes for a targeted revision.
`;

/** A reviewer's verdict in the form Task 2's six schemas now require — object issues with stable
 *  ids, the non-failing `notes`, and the by-id `prior` accounting. `pass` is the only field the panel
 *  reads (`verdictPass`); the rest is what the next round's prompts and the gate's verdict board
 *  show, and it is written out here so the exercise records the shape the loop actually carries. */
function verdict(id: string, pass: boolean, round: number) {
  return {
    pass,
    verdict: pass ? "DRAFT PASSED" : "DRAFT FAILED",
    issues: pass ? [] : [{ id: `${id}-1`, law: "Canon/style-guide.md:59", line: "SCENE TWO, line 14", text: `${id} round ${round}: the line runs past the cap` }],
    notes: pass ? [] : ["a preference, which fails nothing"],
    prior: { resolved: [] as string[], unresolved: pass ? [] : [`${id}-1`] },
  };
}

/** The canon review's verdict: the same `pass` rule, plus the `deviations` list that is the
 *  showrunner's own and that `canon-ledger-script` reads out of this result to build its argv. */
const canonVerdict = () => ({
  pass: true, verdict: "CANON PASSED", issues: [] as string[],
  deviations: [{ where: "script.md SCENE TWO", deviation: "the ferry runs at night", canon: "Canon/technology.md", provenance: "premise", evidence: "the premise line" }],
});

/** The writer's reply: a schemaless step, so its text is its result, and it ends with the two
 *  headings `revise.md` requires — which is what rides into a third round as `{{prior.revise}}`. */
const REVISE_REPLY = `Reworked scene two.

## Changed
SCENE TWO — the analogy cut, the cadence re-read aloud.

## Deliberate exceptions
tone-check-1 — kept: Canon/style-guide.md's judgment-over-mechanism clause licenses the long line here.
`;

/** A log in which every step before `upto` is completed, so `run()` starts at `upto` — the same
 *  device as `test/ep98-exercise.test.ts`'s `seed()`. It is what keeps this fixture to the review
 *  round: the premise, the outline, the outline's gate and the draft loop are all behind it, and
 *  none of their files has to exist on disk. The seeded completions record no `outputHashes`, so
 *  `hand-edits-script` finds no recorded hash to compare against and reports no hand edit, and no
 *  script step is served from a prior run's cache. */
async function seed(logPath: string, pipeline: Pipeline, upto: string): Promise<void> {
  const events: Omit<Event, "ts">[] = [
    { runId: RUN, kind: "run_started", payload: { pipeline: pipeline.name, episodeId: EP, trigger: "run-until-green-exercise" } },
  ];
  for (const step of orderSteps(pipeline)) {
    if (step.id === upto) break;
    events.push({ runId: RUN, stepId: step.id, kind: "step_started", payload: { kind: step.kind, seeded: true } });
    events.push({ runId: RUN, stepId: step.id, kind: "step_completed", payload: { seeded: true } });
  }
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, events.map((e, i) => JSON.stringify({ ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...e })).join("\n") + "\n");
}

/** The exercise's two fakes and the real executor over them. The scripted `query` answers by step id
 *  and by how many times that step has been queried: round 1 is the first call of each reviewer,
 *  round 2 the second. Every reply carries its own `session_id` and `total_cost_usd`, because the
 *  panel's cost figure is a per-session maximum over the round's `agent_result` events. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "until-green-"));
  const promptsDir = path.join(root, "prompts");
  await mkdir(promptsDir, { recursive: true });
  const write = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  // The reviewers' prompts and the schemas their steps name, the writer's prompt, and the gate's.
  for (const id of CHECKS) {
    await write(`prompts/${id}.md`, reviewerPrompt(id));
    await write(`prompts/${id}.schema.json`, JSON.stringify({
      type: "object",
      properties: {
        pass: { type: "boolean" }, verdict: { type: "string" },
        issues: { type: "array", items: { type: "object", properties: { id: { type: "string" }, law: { type: "string" }, line: { type: "string" }, text: { type: "string" } }, required: ["id", "law", "line", "text"] } },
        notes: { type: "array", items: { type: "string" } },
        prior: { type: "object", properties: { resolved: { type: "array" }, unresolved: { type: "array" } }, required: ["resolved", "unresolved"] },
      },
      required: ["pass", "verdict", "issues", "notes", "prior"],
    }, null, 2));
  }
  await write("prompts/canon-review-script.md", reviewerPrompt("canon-review-script"));
  await write("prompts/canon-review.schema.json", JSON.stringify({
    type: "object",
    properties: { pass: { type: "boolean" }, verdict: { type: "string" }, issues: { type: "array" }, deviations: { type: "array" } },
    required: ["pass", "verdict", "issues", "deviations"],
  }, null, 2));
  await write("prompts/revise.md", REVISE_PROMPT);
  await write("prompts/script-gate.gate.md", GATE_TEMPLATE);
  // The draft the round is about. Nothing reads its text — the reviewers are fake — but the agent
  // steps declare it as an input and hash it, so a run against a missing file would record a null
  // hash where production records a draft.
  await write(`Episodes/${EP}/script.md`, "# Script\n\n## SCENE ONE\nprose\n\n## SCENE TWO\nprose\n");
  await write(`Episodes/${EP}/outline.md`, "# Ep\n\n## Cast\n- Vale (recurring, speaks)\n\n## Beat outline\n### Beat 1 — a\n");

  /** Every query the run made, in order, with the step it was for and the prompt it was given. */
  const calls: Array<{ stepId: string; prompt: string; options: AgentQueryOptions }> = [];
  const nth = new Map<string, number>();
  const query: QueryFn = async function* (args) {
    const first = args.prompt.split("\n")[0] ?? "";
    const match = /^STEP (\S+)$/.exec(first);
    // A prompt the fake cannot attribute is a fault in the fixture, not a reply to invent: the
    // exercise's whole method is that the reply depends on which step asked.
    if (!match?.[1]) throw new Error(`the exercise's query seam cannot tell which step this prompt is for: ${JSON.stringify(first)}`);
    const stepId = match[1];
    calls.push({ stepId, prompt: args.prompt, options: args.options });
    const n = (nth.get(stepId) ?? 0) + 1;
    nth.set(stepId, n);
    const sessionId = `${stepId}-${n}`;
    yield { type: "system", subtype: "init", session_id: sessionId };
    if (stepId === "revise") {
      yield { type: "result", subtype: "success", result: REVISE_REPLY, session_id: sessionId, num_turns: 6, duration_ms: 1200, total_cost_usd: REVISE_COST };
      return;
    }
    const structured = stepId === "canon-review-script"
      ? canonVerdict()
      // Round 1 (the first call) is red for the two reviewers the measured panel failed on; every
      // call after it passes, which is the revision landing.
      : verdict(stepId, !(n === 1 && (stepId === "tone-check" || stepId === "repetition-check")), n);
    yield { type: "result", subtype: "success", result: "", structured_output: structured, session_id: sessionId, num_turns: 2, duration_ms: 900, total_cost_usd: REVIEWER_COST } as AgentMessage;
  };

  /** The one script step the round runs: the canon ledger. It declares an output and no inputs, so
   *  it is never served from the script cache and really does run once per round. */
  const scriptCalls: string[] = [];
  const script: Executors["script"] = async (step: ScriptStep) => {
    scriptCalls.push(step.id);
    for (const out of step.outputs ?? []) await write(out, `${step.id}@${scriptCalls.length}\n`);
    return { ok: true, result: "LEDGER_OK 1 new row, 1 total" };
  };

  const executors: Executors = { script, agent: createAgentExecutor({ query, show }) };
  const pipeline = episodePipeline({ show, episodeId: EP, engineRoot: "/engine" });
  const log = new EventLog(EventLog.logPath(root, EP, RUN));
  await seed(log.path, pipeline, "hand-edits-script");
  // The renderer the console builds, from the same options as the executor, so the gate's message and
  // an agent's prompt read one prompts directory and one set of variables. Its query throws: nothing
  // on the gate path may reach the seam.
  const renderGateMessage = createGateMessageRenderer({
    query: () => { throw new Error("no query may run while a gate message is rendered"); },
    show,
  });
  // Concurrency 7 is what the console's worker runs production at, and it is load-bearing here: the
  // reviewers depend on `revise` as well as on `draft`, so the writer cannot land in the same batch
  // as the panel that reads the script it is rewriting.
  const go = () => run({
    pipeline, ctx: { runId: RUN, episodeId: EP, showRoot: root, show, trigger: "run-until-green-exercise" },
    log, executors, renderGateMessage, concurrency: 7,
  });
  return { root, log, calls, scriptCalls, go };
}

const kinds = (events: Event[], kind: Event["kind"]) => events.filter((e) => e.kind === kind);
const rounds = (events: Event[]) => kinds(events, "panel_round").map((e) => e.payload);
const resetsBy = (events: Event[], by: string) => kinds(events, "step_reset").filter((e) => e.payload["by"] === by).map((e) => e.stepId);
/** The log position of the nth (1-based) `step_started` for a step, or -1. The log is append-only, so
 *  array position is the authoritative order; timestamps are never compared. */
const startedAt = (events: Event[], stepId: string, n: number) =>
  events.reduce<number[]>((acc, e, i) => (e.kind === "step_started" && e.stepId === stepId ? [...acc, i] : acc), [])[n - 1] ?? -1;

describe("the write phase, run until green", () => {
  it("walks two rounds — red panel, the eleven resets, one fresh revision, green panel — and opens the script gate on round 2", async () => {
    const { log, calls, scriptCalls, go } = await setup();
    const r = await go();
    const events = await log.read();
    const promptFor = (stepId: string, n: number) => calls.filter((c) => c.stepId === stepId)[n - 1]?.prompt ?? "";

    // ── round 1: the pass with no panel_round in the log ────────────────────────────────────────
    // The writer is bypassed rather than run: its `when` asks whether a round has been written, and
    // none has. So round 1 is the draft being reviewed, and the revision belongs to round 2.
    const skipped = events.find((e) => e.kind === "step_skipped" && e.stepId === "revise");
    expect(skipped?.payload["reason"]).toBe("when: false");
    expect(calls.filter((c) => c.stepId === "revise")).toHaveLength(1); // round 2's call, below — never round 1's
    expect(startedAt(events, "revise", 1)).toBeGreaterThan(events.findIndex((e) => e.kind === "panel_round"));

    // Round 1's reviewers were handed no prior verdict, and the template said so in a word rather
    // than failing to render — the one hole in the template language that is not an error.
    expect(promptFor("tone-check", 1)).toContain("## Your prior verdict\nnone");
    expect(promptFor("tone-check", 1)).toContain("Round 1 of the panel, $0 spent so far.");

    // ── the red round, as the log records it ────────────────────────────────────────────────────
    const round = rounds(events);
    expect(round).toHaveLength(1);
    expect(round[0]).toMatchObject({ round: 1, green: false, by: "panel:panel:round-1", costUsd: ROUND_1_COST });
    // No weekly figure anywhere in this log — the fake stream yields no `usage` — and the round went
    // ahead anyway: an unknown quota is never a stop.
    expect("weeklyUtilization" in round[0]!).toBe(false);
    // The verdicts the next round's prompts read back. The event is keyed on **every** reset step
    // whose result the run had, which is wider than the seven panel members: the hand-edit guard's
    // JSON record and the canon ledger's result line are in there too, so the event is a record of
    // the round and not a board of verdicts alone. `revise` is absent because round 1 bypassed it —
    // from round 2 on its own round report rides here, which is what lets the writer be shown what
    // it promised last round.
    const verdicts = round[0]!["verdicts"] as Record<string, unknown>;
    expect(Object.keys(verdicts).sort()).toEqual([...PANEL, "hand-edits-script", "canon-ledger-script"].sort());
    expect(verdicts["canon-ledger-script"]).toBe("LEDGER_OK 1 new row, 1 total");
    expect(verdicts["tone-check"]).toMatchObject({ pass: false, verdict: "DRAFT FAILED" });
    expect(verdicts["repetition-check"]).toMatchObject({ pass: false });
    expect(verdicts["flow-check"]).toMatchObject({ pass: true });
    expect(verdicts["hand-edits-script"]).toBe(JSON.stringify({ handEdited: [] }));

    // The eleven: every id the panel declares, in declaration order, its own among them, each signed
    // with the round so a crashed run can tell which batch it owed.
    expect(resetsBy(events, "panel:panel:round-1")).toEqual([...RESETS]);

    // ── round 2: hand edits, then the writer, then the panel's seven ────────────────────────────
    expect(startedAt(events, "hand-edits-script", 2)).toBeLessThan(startedAt(events, "revise", 1));
    expect(startedAt(events, "revise", 1)).toBeLessThan(startedAt(events, "tone-check", 2));
    // One fresh writer call for the round: one query, nothing resumed.
    const reviseQueries = events.filter((e) => e.kind === "agent_query" && e.stepId === "revise");
    expect(reviseQueries).toHaveLength(1);
    expect(reviseQueries[0]?.payload["resumed"]).toBe(false);
    expect("resume" in (calls.find((c) => c.stepId === "revise")?.options ?? {})).toBe(false);
    // What the writer was given: every reviewer's round-1 verdict, read out of the log rather than
    // out of `ctx.results`, which the reset emptied — and the round it is working on.
    const revisePrompt = promptFor("revise", 1);
    expect(revisePrompt).toContain("Round 2 of the revision.");
    expect(revisePrompt).toContain("tone-check round 1: the line runs past the cap");
    expect(revisePrompt).toContain("repetition-check round 1: the line runs past the cap");
    expect(revisePrompt).toContain("CANON PASSED");
    // Each of the six rendered as an object rather than as the word for an absent one, the passing
    // four included: the writer is shown the whole board and not only the red rows.
    for (const id of CHECKS) expect(revisePrompt, id).toMatch(new RegExp(`^${id}: \\{`, "m"));
    // The only `none` in it is its own last round's, which a round 2 cannot have: the writer did not
    // run on round 1. Asserted as exactly one occurrence, so a regression that emptied the verdicts
    // would show up here rather than passing as "contains the verdicts".
    expect(revisePrompt.match(/none/g)).toHaveLength(1);
    expect(revisePrompt).toContain("## Your last round\nnone");
    // And what each reviewer was given on round 2: its own prior verdict, and no `none` anywhere.
    const tonePrompt = promptFor("tone-check", 2);
    expect(tonePrompt).toContain("tone-check round 1: the line runs past the cap");
    expect(tonePrompt).toContain(`Round 2 of the panel, $${ROUND_1_COST} spent so far.`);
    expect(tonePrompt).not.toContain("none");
    expect(promptFor("flow-check", 2)).not.toContain("none"); // a reviewer that passed round 1 still gets its own verdict

    // Every panel member ran once per round, and the ledger script with them.
    for (const id of PANEL) expect(calls.filter((c) => c.stepId === id), id).toHaveLength(2);
    expect(scriptCalls).toEqual(["canon-ledger-script", "canon-ledger-script"]);

    // ── green, and the gate ────────────────────────────────────────────────────────────────────
    const completed = events.find((e) => e.kind === "step_completed" && e.stepId === "panel" && e.payload["green"] === true);
    expect(completed?.payload).toMatchObject({ result: { round: 2, green: true }, round: 2, green: true, costUsd: GREEN_COST });
    // One round written, one batch, no second of either: the green round writes its cost on its own
    // completion instead, which is the record the gate's sentence is rendered from.
    expect(rounds(events)).toHaveLength(1);
    expect(resetsBy(events, "panel:panel:round-2")).toEqual([]);

    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    if (r.status !== "waiting") return;
    expect(r.gate.message).toBe(
      `Script drafted: Episodes/${EP}/script.md\n`
      + `The panel is green after 2 round(s) ($${GREEN_COST} of review and revision).\n`
      + "Approve to commit. Reject with notes for a targeted revision.\n",
    );
    // The showrunner is never shown a template: a hole would have failed the render, and a `{{` left
    // in the text is refused by a message of its own.
    expect(r.gate.message).not.toContain("{{");
  });
});

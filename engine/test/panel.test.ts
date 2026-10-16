import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { answerGate, resumeRun, run } from "../src/runner.js";
import { roundExtras } from "../src/agent-step.js";
import { EventLog, type Event } from "../src/events.js";
import { orderSteps, PipelineError } from "../src/pipeline.js";
import { renderPrompt } from "../src/prompt-template.js";
import type { AgentUsage } from "../src/agent-step.js";
import type { ShowConfig } from "../src/show-config.js";
import type { AgentStep, Executors, GateStep, GuardStep, PanelStep, Pipeline } from "../src/steps.js";

/** Two reviewers rather than the live pipeline's seven: the round is the same shape at two, and a
 *  failing assertion names a reviewer instead of a column. `tone-check` is the one that fails in
 *  these tests, which is also what it did on the one measured Season 2 panel (inventory §2.3). */
const REVIEWERS = ["tone-check", "flow-check"] as const;

/** The round's ten steps in miniature: the hand-edit guard, the writer's revision, the two
 *  reviewers, and the panel itself — the shape `episodePipeline` declares, minus the canon review
 *  and the ledger, which the panel treats no differently from any other reset id. */
const RESETS = ["hand-edits", "revise", ...REVIEWERS, "panel"] as const;

const GATE_MESSAGE = "The panel is green after {{round.n}} round(s) (${{round.costUsd}} of review and revision).";

/** A show whose only load-bearing key is the weekly ceiling the panel's stop compares against. */
const show = (autoRetryWeeklyUtilizationMax = 65): ShowConfig => ({
  showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: { ep10: [1, 10] },
  output: { nasRoot: "/tmp/no-such-nas", mixFilename: "{slug}.wav", videoFilename: "episode.mp4" },
  audio: { voiceRefsDir: "Production/voice-refs", voiceRegistry: "Canon/voice-registry.md" },
  visual: { refs: "Canon/refs.json", style: "Canon/visual-style.md", castingPileDir: "Canon/characters" },
  video: { compositionId: "Episode" },
  publish: { guide: "Canon/publishing-guide.md" },
  agents: { autoRetryWeeklyUtilizationMax },
});

function pipelineOf(): Pipeline {
  const draft: GuardStep = { kind: "guard", id: "draft", check: () => ({ pass: true, message: "drafted" }) };
  const handEdits: GuardStep = { kind: "guard", id: "hand-edits", dependsOn: ["draft"], check: () => ({ pass: true, message: "no hand edits" }) };
  // The writer: one fresh call per round, bypassed on round 1 because no panel_round exists yet.
  const revise: AgentStep = {
    kind: "agent", id: "revise", dependsOn: ["hand-edits"],
    when: (ctx) => (ctx.events ?? []).some((e) => e.kind === "panel_round" && e.stepId === "panel"),
    promptFile: "revise.md", model: "writer", allowedTools: [], context: "fresh",
  };
  const reviewer = (id: string): AgentStep => ({
    kind: "agent", id, dependsOn: ["draft", "revise"], promptFile: `${id}.md`, model: "medium",
    allowedTools: [], context: "fresh", schema: { type: "object", properties: { pass: { type: "boolean" } }, required: ["pass"] },
  });
  const panel: PanelStep = {
    kind: "panel", id: "panel", dependsOn: [...REVIEWERS], reviewers: [...REVIEWERS], resets: [...RESETS],
  };
  const gate: GateStep = { kind: "gate", id: "script-gate", dependsOn: ["panel"], messageFile: "script-gate.gate.md" };
  return { name: "p", steps: [draft, handEdits, revise, ...REVIEWERS.map(reviewer), panel, gate] };
}

interface Knobs {
  /** Whether reviewer `id` passes on its `nth` run (1-based). Default: every reviewer passes. */
  passes?: (id: string, nth: number) => boolean;
  /** The usage windows every reviewer's agent_result carries, as the wrapper would have yielded. */
  usage?: AgentUsage;
  /** What each reviewer's call costs, and what each revision costs. */
  reviewerCostUsd?: number;
  reviseCostUsd?: number;
  show?: ShowConfig;
}

/** The harness every case below runs through: the real `run()`, a real `EventLog` on a temporary
 *  show, and fake executors that keep the executor's own obligations — an `agent_result` per call,
 *  carrying the cost, the session id and the usage windows — because the panel reads those events
 *  out of the log for its cost figure and its weekly stop. The gate's message is rendered the way
 *  `createGateMessageRenderer` renders it, `renderPrompt` over the same extras, so the round reaches
 *  the showrunner's sentence through the same path production uses. */
async function setup(knobs: Knobs = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "panel-"));
  const calls: string[] = [];
  const runs = new Map<string, number>();
  const passes = knobs.passes ?? (() => true);
  const agent: Executors["agent"] = async (step, _ctx, emit) => {
    calls.push(step.id);
    const nth = (runs.get(step.id) ?? 0) + 1;
    runs.set(step.id, nth);
    // One agent_query per query is the executor's own obligation (`steps.ts`'s Executors contract),
    // and it is what the log answers "how many times was this step queried" with — the question a
    // round's cost turns on, since each query is a fresh session and its own money.
    await emit("agent_query", { promptFile: `${step.id}.md`, model: step.model, context: step.context, resumed: false });
    if (step.id === "revise") {
      await emit("agent_result", { ok: true, toolCalls: 6, costUsd: knobs.reviseCostUsd ?? 3.2348, sessionId: `revise-${nth}` });
      return { ok: true, text: "revised", toolCalls: 6 };
    }
    const pass = passes(step.id, nth);
    const verdict = { pass, verdict: pass ? "DRAFT PASSED" : "DRAFT FAILED", issues: pass ? [] : [`${step.id}: round ${nth}`] };
    await emit("agent_result", {
      ok: true, toolCalls: 2, costUsd: knobs.reviewerCostUsd ?? 1, sessionId: `${step.id}-${nth}`, verdict,
      ...(knobs.usage !== undefined ? { usage: knobs.usage } : {}),
    });
    return { ok: true, text: "", toolCalls: 2, verdict };
  };
  const executors: Executors = { script: async () => ({ ok: true }), agent };
  const log = new EventLog(EventLog.logPath(root, "s02e01", "r1"));
  const pipeline = pipelineOf();
  const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root, ...(knobs.show !== undefined ? { show: knobs.show } : {}) };
  const go = () => run({
    pipeline, ctx, log, executors,
    renderGateMessage: async (_file, c) => renderPrompt(GATE_MESSAGE, c, roundExtras(c.events)),
  });
  return { root, log, pipeline, ctx, executors, calls, runs, go };
}

const kinds = (events: Event[], kind: Event["kind"]) => events.filter((e) => e.kind === kind);
const queries = (events: Event[], stepId: string) => kinds(events, "agent_query").filter((e) => e.stepId === stepId).length;
const starts = (events: Event[], stepId: string) => kinds(events, "step_started").filter((e) => e.stepId === stepId).length;
const rounds = (events: Event[]) => kinds(events, "panel_round").map((e) => e.payload);
const resetsBy = (events: Event[], by: string) => kinds(events, "step_reset").filter((e) => e.payload["by"] === by).map((e) => e.stepId);
const at = (n: number) => `2026-01-01T10:00:${String(n).padStart(2, "0")}.000Z`;

/** Writes a log by hand, as a crashed run left it — the same helper as `test/loop.test.ts:29`. */
async function writeCrashLog(logPath: string, events: Omit<Event, "ts">[]): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, events.map((e, i) => JSON.stringify({ ts: at(i), ...e })).join("\n") + "\n");
}

describe("the panel step", () => {
  it("(a) completes on a green round 1, bypasses the revision, and lets the gate open", async () => {
    const { log, go, calls } = await setup();
    const r = await go();
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    // Round 1 is the pass with no panel_round in the log, so the writer is never called at all.
    expect(calls).toEqual(["tone-check", "flow-check"]);
    const events = await log.read();
    expect(rounds(events)).toEqual([]);
    expect(kinds(events, "step_reset")).toEqual([]);
    const completed = events.find((e) => e.kind === "step_completed" && e.stepId === "panel");
    expect(completed?.payload).toMatchObject({ result: { round: 1, green: true }, round: 1, green: true });
    expect(events.find((e) => e.kind === "step_skipped" && e.stepId === "revise")?.payload["reason"]).toBe("when: false");
    // The gate's own sentence, rendered the way production renders it: one round, and what that
    // round's two reviewer calls cost — the figure the panel counted at its green exit, since a
    // green round writes no panel_round for anyone else to count from.
    expect(completed?.payload["costUsd"]).toBe(2);
    if (r.status === "waiting") expect(r.gate.message).toBe("The panel is green after 1 round(s) ($2 of review and revision).");
  });

  it("(b) writes the round, resets the five, re-runs the revision once and the reviewers again, and opens the gate on round 2", async () => {
    // tone-check fails its first run and passes its second; flow-check always passes.
    const { log, go, calls } = await setup({ passes: (id, nth) => !(id === "tone-check" && nth === 1), reviewerCostUsd: 0.7130, reviseCostUsd: 3.2348 });
    const r = await go();
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    expect(calls).toEqual(["tone-check", "flow-check", "revise", "tone-check", "flow-check"]);

    const events = await log.read();
    // One round, carrying both verdicts — the failed one and the passing one — and the round's cost
    // as the log's own agent_results report it: the two reviewer calls of round 1, by session.
    const round = rounds(events);
    expect(round).toHaveLength(1);
    expect(round[0]).toMatchObject({ round: 1, green: false, by: "panel:panel:round-1", costUsd: 1.426 });
    // Every reset step's result the run had, not the reviewers' alone: the two verdicts and the
    // hand-edit guard's record. `revise` is absent because round 1 bypassed it — it has no result to
    // carry — and from round 2 its own round report rides here, which is what lets the writer be
    // shown what it promised last round as `{{prior.revise}}`.
    expect(round[0]!["verdicts"]).toEqual({
      "hand-edits": "no hand edits",
      "tone-check": { pass: false, verdict: "DRAFT FAILED", issues: ["tone-check: round 1"] },
      "flow-check": { pass: true, verdict: "DRAFT PASSED", issues: [] },
    });
    // No weekly figure in this log at all, and the round went ahead anyway: an unknown quota is
    // never a stop.
    expect("weeklyUtilization" in round[0]!).toBe(false);

    // The batch: every id the step declares, the panel's own among them, signed with the round.
    expect(resetsBy(events, "panel:panel:round-1")).toEqual([...RESETS]);
    // The panel ran twice and wrote one round, so the second evaluation was round 2.
    const started = events.filter((e) => e.kind === "step_started" && e.stepId === "panel").map((e) => e.payload["round"]);
    expect(started).toEqual([1, 2]);
    expect(events.find((e) => e.kind === "step_completed" && e.stepId === "panel")?.payload).toMatchObject({ result: { round: 2, green: true } });
    // One fresh query per step per round, which is what the round's cost is a sum of: two rounds of
    // two reviewers, and the writer called once — on round 2 only, since round 1 bypassed it.
    expect(queries(events, "revise")).toBe(1);
    expect(queries(events, "tone-check")).toBe(2);
    expect(queries(events, "flow-check")).toBe(2);
    // The gate's sentence names the round the run reached and what the loop cost: four reviewer
    // calls at $0.7130 across the two rounds plus one revision at $3.2348, by session maximum.
    if (r.status === "waiting") expect(r.gate.message).toBe("The panel is green after 2 round(s) ($6.0868 of review and revision).");
  });

  it("(c) goes round as many times as the reviewers need, one revision per round, with no cap", async () => {
    const { log, go, calls, runs } = await setup({ passes: (id, nth) => !(id === "tone-check" && nth <= 2) });
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    const events = await log.read();
    expect(rounds(events).map((p) => p["round"])).toEqual([1, 2]);
    expect(runs.get("revise")).toBe(2);
    expect(runs.get("tone-check")).toBe(3);
    expect(runs.get("flow-check")).toBe(3);
    expect(calls.filter((c) => c === "revise")).toHaveLength(2);
    expect(queries(events, "revise")).toBe(2);
    expect(queries(events, "tone-check")).toBe(3);
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "panel").map((e) => e.payload["round"])).toEqual([1, 2, 3]);
    expect(events.find((e) => e.kind === "step_completed" && e.stepId === "panel")?.payload).toMatchObject({ result: { round: 3, green: true } });
  });

  it("(d) a crashed round's half-written batch is finished by one reset, not by a second round", async () => {
    // The log as a run that died between the batch's writes and the re-runs left it: round 1 is
    // written — `tone-check` had failed it — and four of the five step_resets landed. `flow-check`'s
    // did not, so its round-1 verdict is still standing and the pass will not re-run it on its own.
    // The reviewers pass when they do re-run, which is the ordinary way a round ends: the writer
    // revised, and round 2 is green. So the only thing this case measures is which steps re-ran.
    const { root, log, go, calls } = await setup();
    const verdict = (pass: boolean) => ({ pass, verdict: pass ? "DRAFT PASSED" : "DRAFT FAILED", issues: pass ? [] : ["tone-check: round 1"] });
    await writeCrashLog(log.path, [
      { runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } },
      { runId: "r1", stepId: "draft", kind: "step_started", payload: { kind: "guard" } },
      { runId: "r1", stepId: "draft", kind: "step_completed", payload: { result: "drafted" } },
      { runId: "r1", stepId: "hand-edits", kind: "step_started", payload: { kind: "guard" } },
      { runId: "r1", stepId: "hand-edits", kind: "step_completed", payload: { result: "no hand edits" } },
      { runId: "r1", stepId: "revise", kind: "step_skipped", payload: { reason: "when: false" } },
      { runId: "r1", stepId: "tone-check", kind: "step_started", payload: { kind: "agent" } },
      { runId: "r1", stepId: "tone-check", kind: "step_completed", payload: { result: verdict(false) } },
      { runId: "r1", stepId: "flow-check", kind: "step_started", payload: { kind: "agent" } },
      { runId: "r1", stepId: "flow-check", kind: "step_completed", payload: { result: verdict(true) } },
      { runId: "r1", stepId: "panel", kind: "step_started", payload: { kind: "panel", round: 1 } },
      { runId: "r1", stepId: "panel", kind: "panel_round", payload: { round: 1, green: false, verdicts: { "tone-check": verdict(false), "flow-check": verdict(true) }, costUsd: 1.426, by: "panel:panel:round-1" } },
      { runId: "r1", stepId: "hand-edits", kind: "step_reset", payload: { by: "panel:panel:round-1", round: 1 } },
      { runId: "r1", stepId: "revise", kind: "step_reset", payload: { by: "panel:panel:round-1", round: 1 } },
      { runId: "r1", stepId: "tone-check", kind: "step_reset", payload: { by: "panel:panel:round-1", round: 1 } },
      { runId: "r1", stepId: "panel", kind: "step_reset", payload: { by: "panel:panel:round-1", round: 1 } },
    ]);
    expect(root).toContain("panel-");

    const r = await go();
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    const events = await log.read();
    // **Nothing was rewritten.** The round the crashed run paid for is still the only one in the
    // log, and its batch still holds the four rows it wrote: the panel answered "the restart is
    // owed" and returned the reset without a second panel_round or a second batch.
    expect(rounds(events).map((p) => p["round"])).toEqual([1]);
    expect(resetsBy(events, "panel:panel:round-1")).toEqual(["hand-edits", "revise", "tone-check", "panel"]);
    // And the restart it asked for brought `flow-check` back, so round 2 judged two fresh verdicts.
    expect(starts(events, "flow-check")).toBe(2);
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "panel").map((e) => e.payload["round"])).toEqual([1, 2, 2]);
    expect(events.find((e) => e.kind === "step_completed" && e.stepId === "panel")?.payload).toMatchObject({ result: { round: 2, green: true } });

    // **Only the stale steps re-ran, and that is the point of the recovery** (the whole-branch review
    // of 2026-10-15). `flow-check` is the one step the crashed run never reset, so it is the one the
    // restart owed; `hand-edits`, `revise` and `tone-check` had already re-run in the pass that
    // reached the panel, and naming them in the outcome would have deleted those fresh completions
    // and queried them a second time inside one round — a second writer call, $3.23, and the
    // one-fresh-revise-per-round invariant with it.
    expect(queries(events, "revise")).toBe(1);
    expect(queries(events, "tone-check")).toBe(1);
    expect(queries(events, "flow-check")).toBe(1);
    expect(calls).toEqual(["revise", "tone-check", "flow-check"]);
    expect(starts(events, "revise")).toBe(1);
    expect(starts(events, "hand-edits")).toBe(2);
    // One session per query, so the log cannot be read as one conversation resumed: the writer's
    // round is a fresh call and there is exactly one of it.
    expect(kinds(events, "agent_result").filter((e) => e.stepId === "revise").map((e) => e.payload["sessionId"])).toEqual(["revise-1"]);
  });

  it("(d2) a complete batch whose re-runs all happened is evaluated, not reset a second time", async () => {
    // The other half of the guard, and the expensive one: on the ordinary restarted pass the round-N
    // batch is also "already in the log after this step's last step_started", so a guard that asked
    // only that question would reset a panel whose reviewers had just re-run and pay for a second
    // panel ($6.07 on the measured round, inventory §2.2). The log below is that pass exactly — the
    // batch complete, every reset step visited after it — and the panel must judge it.
    const { log, go } = await setup();
    const verdict = (pass: boolean) => ({ pass, verdict: pass ? "DRAFT PASSED" : "DRAFT FAILED", issues: [] as string[] });
    await writeCrashLog(log.path, [
      { runId: "r1", kind: "run_started", payload: { pipeline: "p", episodeId: "s02e01" } },
      { runId: "r1", stepId: "draft", kind: "step_started", payload: { kind: "guard" } },
      { runId: "r1", stepId: "draft", kind: "step_completed", payload: { result: "drafted" } },
      { runId: "r1", stepId: "panel", kind: "step_started", payload: { kind: "panel", round: 1 } },
      { runId: "r1", stepId: "panel", kind: "panel_round", payload: { round: 1, green: false, verdicts: {}, costUsd: 1.426, by: "panel:panel:round-1" } },
      ...RESETS.map((id) => ({ runId: "r1", stepId: id, kind: "step_reset" as const, payload: { by: "panel:panel:round-1", round: 1 } })),
      { runId: "r1", stepId: "hand-edits", kind: "step_completed", payload: { result: "no hand edits" } },
      { runId: "r1", stepId: "revise", kind: "step_completed", payload: { result: "revised" } },
      { runId: "r1", stepId: "tone-check", kind: "step_completed", payload: { result: verdict(true) } },
      { runId: "r1", stepId: "flow-check", kind: "step_completed", payload: { result: verdict(true) } },
    ]);

    const r = await go();
    expect(r).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    const events = await log.read();
    // One entry of the panel, which judged the re-run verdicts as round 2 and completed. No second
    // batch, no second round, and not one reviewer called again.
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "panel").map((e) => e.payload["round"])).toEqual([1, 2]);
    expect(rounds(events).map((p) => p["round"])).toEqual([1]);
    expect(resetsBy(events, "panel:panel:round-2")).toEqual([]);
    expect(events.filter((e) => e.kind === "agent_result")).toEqual([]);
    expect(events.find((e) => e.kind === "step_completed" && e.stepId === "panel")?.payload).toMatchObject({ result: { round: 2, green: true } });
  });

  it("(e) stops at the weekly ceiling with the operator's sentence and no reset, and the Resume continues the loop", async () => {
    const usage: AgentUsage = { available: true, fiveHour: { utilization: 26, resetsAt: null }, sevenDay: { utilization: 78, resetsAt: null } };
    const { log, go, calls } = await setup({ passes: (id, nth) => !(id === "tone-check" && nth === 1), usage, show: show(65) });

    const stopped = await go();
    expect(stopped).toEqual({
      status: "failed", stepId: "panel",
      error: "Manual resume needed: the panel is still red after round 1 and the weekly quota is at 78%, "
        + "at or above the 65% auto-retry ceiling (agents.autoRetryWeeklyUtilizationMax); "
        + "press Resume after the reset to continue the loop.",
    });
    let events = await log.read();
    // The stop writes the failure and nothing else: no round, no batch. So the round the operator
    // resumes into is the same round 1, and no revision has been paid for.
    expect(rounds(events)).toEqual([]);
    expect(kinds(events, "step_reset")).toEqual([]);
    expect(calls).toEqual(["tone-check", "flow-check"]);

    await resumeRun(log, "r1", "showrunner");
    const resumed = await go();
    expect(resumed).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    events = await log.read();
    // The figure that stopped the run is behind the run_resumed, so the re-entered panel knows no
    // weekly figure, and an unknown figure is never a stop: it wrote round 1 and reset.
    expect(rounds(events).map((p) => p["round"])).toEqual([1]);
    expect("weeklyUtilization" in rounds(events)[0]!).toBe(false);
    expect(calls).toEqual(["tone-check", "flow-check", "revise", "tone-check", "flow-check"]);
    if (resumed.status === "waiting") expect(resumed.gate.message).toContain("green after 2 round(s)");
  });

  it("a weekly figure below the ceiling goes round again, and the round records it", async () => {
    const usage: AgentUsage = { available: true, sevenDay: { utilization: 64, resetsAt: null } };
    const { log, go } = await setup({ passes: (id, nth) => !(id === "tone-check" && nth === 1), usage, show: show(65) });
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "script-gate" } });
    const round = rounds(await log.read());
    expect(round).toHaveLength(1);
    expect(round[0]).toMatchObject({ round: 1, weeklyUtilization: 64 });
  });

  it("(f) hands the next round's prompts the prior verdicts and the round, and round 1 the word none", async () => {
    const { log, go } = await setup({ passes: (id, nth) => !(id === "tone-check" && nth === 1), reviewerCostUsd: 0.7130, reviseCostUsd: 3.2348 });

    // Before any round: no prior verdict for anyone, round 1, nothing spent — and `{{prior.*}}`
    // renders the word rather than failing, which is what lets a reviewer's prompt render at all on
    // the first pass.
    const first = roundExtras([]);
    expect(first).toEqual({ prior: {}, round: { n: 1, costUsd: 0 } });
    expect(renderPrompt("prior: {{prior.tone-check}}; round {{round.n}}; ${{round.costUsd}}", { episodeId: "s02e01", runId: "r1", showRoot: "/show", results: {} }, first))
      .toBe("prior: none; round 1; $0");

    await go();
    const events = await log.read();

    // The log as round 2's prompts see it — everything up to and including the red round's own
    // event, which is the moment the reviewers and the writer are queried next. Round 2, round 1's
    // two reviewer calls spent, and each reviewer's own last verdict to judge against.
    const midLoop = roundExtras(events.slice(0, events.findIndex((e) => e.kind === "panel_round") + 1));
    expect(midLoop.round).toEqual({ n: 2, costUsd: 1.426 });
    // The verdict the reviewer gave last round, rendered as the JSON the prompts are written
    // against — read out of the log's panel_round, because the reset deleted it from ctx.results
    // before the reviewer re-ran (inventory J-14).
    const rendered = renderPrompt("{{prior.tone-check}}", { episodeId: "s02e01", runId: "r1", showRoot: "/show", results: {} }, midLoop);
    expect(JSON.parse(rendered)).toEqual({ pass: false, verdict: "DRAFT FAILED", issues: ["tone-check: round 1"] });
    // A step that was not in the round renders `none` too, rather than failing the prompt.
    expect(renderPrompt("{{prior.draft}}", { episodeId: "s02e01", runId: "r1", showRoot: "/show", results: {} }, midLoop)).toBe("none");

    // And the whole log, as the gate's message sees it after the green round: the same round number,
    // and the cost with the revision and the closing panel in it.
    expect(roundExtras(events).round).toEqual({ n: 2, costUsd: 6.0868 });
    expect(roundExtras(events).prior).toEqual(midLoop.prior);
  });

  it("re-runs the round after a gate rejection, so the gate never reopens on a stale panel", async () => {
    // The human path through the same machinery: the script gate's own rerunOnReject closure takes
    // in the panel (it depends on the reviewers), so a rejection resets it and the gate reopens only
    // after the panel has judged the fixed script.
    const { log, pipeline, ctx, executors, calls } = await setup();
    const gate = pipeline.steps.find((s) => s.id === "script-gate") as GateStep;
    gate.rerunOnReject = ["hand-edits", ...REVIEWERS];
    const go = () => run({ pipeline, ctx, log, executors, renderGateMessage: async (_f, c) => renderPrompt(GATE_MESSAGE, c, roundExtras(c.events)) });
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 1 } });
    await answerGate(log, "r1", "script-gate", { approved: false, notes: "scene two is flat" });
    expect(await go()).toMatchObject({ status: "waiting", gate: { stepId: "script-gate", attempt: 2 } });
    expect(calls.filter((c) => c === "tone-check")).toHaveLength(2);
    const events = await log.read();
    expect(resetsBy(events, "script-gate")).toContain("panel");
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "panel").map((e) => e.payload["round"])).toEqual([1, 1]);
  });
});

describe("a panel in a pipeline", () => {
  it("is ordered after its reviewers and before the gate, and the revision between the reset and the panel", () => {
    expect(orderSteps(pipelineOf()).map((s) => s.id))
      .toEqual(["draft", "hand-edits", "revise", "tone-check", "flow-check", "panel", "script-gate"]);
  });

  it("is refused at load time with no reviewer, an unknown id, or a reviewer it does not depend on", () => {
    const base = pipelineOf();
    const withPanel = (over: Partial<PanelStep>): Pipeline => ({
      name: "p",
      steps: base.steps.map((s) => (s.kind === "panel" ? { ...s, ...over } : s)),
    });
    expect(() => orderSteps(withPanel({ reviewers: [] }))).toThrow(PipelineError);
    expect(() => orderSteps(withPanel({ reviewers: ["nobody"], dependsOn: ["nobody"] }))).toThrow(/depends on unknown step/);
    expect(() => orderSteps(withPanel({ reviewers: ["draft"] }))).toThrow(/without depending on it/);
    expect(() => orderSteps(withPanel({ resets: ["nobody"] }))).toThrow(/unknown step "nobody" in resets/);
  });
});

import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, answerGate, EventLog, deriveRunState, deriveStage, scriptExecutor } from "../src/index.js";
import type { Executors, Pipeline, StageMap, Event } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "fixtures", name);

/** A pipeline of the two step kinds a crash can interrupt halfway: a loop and a script. */
function crashPipeline(): Pipeline {
  return {
    name: "write",
    steps: [
      { kind: "loop", id: "draft-loop", until: "DRAFT_COMPLETE", maxIterations: 4,
        body: { kind: "agent", id: "draft", promptFile: "draft.md", model: "writer", allowedTools: ["Write"], context: "fresh" } },
      { kind: "script", id: "stamp", dependsOn: ["draft-loop"], outputs: ["stamp.txt"],
        argv: (ctx) => ["python3", fixture("stamp.py"), path.join(ctx.showRoot, "stamp.txt"), path.join(ctx.showRoot, "runs.txt")] },
    ],
  };
}

const at = (n: number) => `2026-01-01T10:00:0${n}.000Z`;

async function writeCrashLog(logPath: string, events: Omit<Event, "ts">[]): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, events.map((e, i) => JSON.stringify({ ts: at(i), ...e })).join("\n") + "\n");
}

describe("end to end", () => {
  it("premise → guard → loop → gate → script → done, surviving a restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    await writeFile(path.join(root, "premise.md"), "An ordinary week.");
    let scenes = 0;
    const executors: Executors = {
      script: scriptExecutor,
      agent: async (step, ctx) => {
        if (step.id === "draft") {
          scenes++;
          await writeFile(path.join(ctx.showRoot, "script.md"), `## SCENE ${scenes}\n`.repeat(scenes));
          return { ok: true, text: scenes >= 2 ? "DRAFT_COMPLETE" : "wrote a scene", toolCalls: 3 };
        }
        return { ok: true, text: "fixed", toolCalls: 1 };
      },
    };
    const pipeline: Pipeline = {
      name: "write",
      steps: [
        { kind: "guard", id: "setup", inputs: ["premise.md"], check: async (ctx) => (await readFile(path.join(ctx.showRoot, "premise.md"), "utf8")).length > 0 ? { pass: true } : { pass: false, message: "no premise" } },
        { kind: "loop", id: "draft-loop", dependsOn: ["setup"], until: "DRAFT_COMPLETE", maxIterations: 5,
          body: { kind: "agent", id: "draft", promptFile: "draft.md", model: "writer", allowedTools: ["Read", "Write"], context: "fresh" } },
        { kind: "gate", id: "script-gate", dependsOn: ["draft-loop"], message: () => "Read the script", maxAttempts: 3 },
        { kind: "script", id: "stamp", dependsOn: ["script-gate"], inputs: ["script.md"], outputs: ["stamp.txt"],
          argv: (ctx) => ["python3", "-c", "import sys; open(sys.argv[1],'w').write('ok'); print('::progress {\"done\":1,\"total\":1,\"unit\":\"stamps\"}')", path.join(ctx.showRoot, "stamp.txt")] },
      ],
    };
    const map: StageMap = { gates: { "script-gate": "DRAFT_SCRIPT" }, approved: { "script-gate": "SCRIPT" }, final: "COMPLETE" };
    const needs = { ideaMissing: false, refsMissing: false, imagesMissing: false };
    const ctx = { runId: "r1", episodeId: "s02e01", showRoot: root };
    const logPath = EventLog.logPath(root, "s02e01", "r1");

    const r1 = await run({ pipeline, ctx, log: new EventLog(logPath), executors });
    expect(r1).toMatchObject({ status: "waiting", gate: { stepId: "script-gate" } });
    expect(scenes).toBe(2);
    let state = deriveRunState(await new EventLog(logPath).read());
    expect(deriveStage(state, map, needs)).toBe("DRAFT_SCRIPT");
    expect(state.steps).toMatchObject({ setup: "completed", "draft-loop": "completed", "script-gate": "waiting" });

    // Restart: a brand-new process would do exactly this — a new EventLog over the same file.
    await answerGate(new EventLog(logPath), "r1", "script-gate", { approved: true, by: "showrunner" });
    const r2 = await run({ pipeline, ctx, log: new EventLog(logPath), executors });
    expect(r2).toEqual({ status: "completed" });
    expect(await readFile(path.join(root, "stamp.txt"), "utf8")).toBe("ok");
    state = deriveRunState(await new EventLog(logPath).read());
    expect(deriveStage(state, map, needs)).toBe("COMPLETE");

    const kinds = (await new EventLog(logPath).read()).map((e) => e.kind);
    expect(kinds.filter((k) => k === "loop_iteration")).toHaveLength(2);
    expect(kinds).toContain("step_progress");
    expect(kinds.at(-1)).toBe("run_finished");
  });

  it("resumes a crash mid-loop: the finished iterations are not repeated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    let bodyCalls = 0;
    const executors: Executors = {
      script: scriptExecutor,
      agent: async () => { bodyCalls++; return { ok: true, text: "DRAFT_COMPLETE", toolCalls: 2 }; },
    };
    const logPath = EventLog.logPath(root, "s02e01", "r1");
    await writeCrashLog(logPath, [
      { runId: "r1", kind: "run_started", payload: { pipeline: "write", episodeId: "s02e01" } },
      { runId: "r1", stepId: "draft-loop", kind: "step_started", payload: { kind: "loop", body: "draft", until: "DRAFT_COMPLETE", max: 4 } },
      { runId: "r1", stepId: "draft-loop", kind: "loop_iteration", payload: { iteration: 1, max: 4, sentinel: false, toolCalls: 3 } },
    ]);

    const res = await run({ pipeline: crashPipeline(), ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: new EventLog(logPath), executors });
    expect(res).toEqual({ status: "completed" });
    expect(bodyCalls).toBe(1);

    const events = await new EventLog(logPath).read();
    expect(events.filter((e) => e.kind === "loop_iteration").map((e) => e.payload["iteration"])).toEqual([1, 2]);
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "draft-loop")).toHaveLength(2);
    expect(await readFile(path.join(root, "stamp.txt"), "utf8")).toBe("ok");
    expect(events.at(-1)?.kind).toBe("run_finished");
    expect(events.at(-1)?.payload["status"]).toBe("completed");
  });

  it("resumes a crash mid-script: the script re-runs, and idempotency is the script's job", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "show-"));
    // The crashed run had already invoked the script once; its ledger line survives the crash.
    await writeFile(path.join(root, "runs.txt"), "x\n");
    let bodyCalls = 0;
    const executors: Executors = {
      script: scriptExecutor,
      agent: async () => { bodyCalls++; return { ok: true, text: "DRAFT_COMPLETE", toolCalls: 2 }; },
    };
    const logPath = EventLog.logPath(root, "s02e01", "r1");
    await writeCrashLog(logPath, [
      { runId: "r1", kind: "run_started", payload: { pipeline: "write", episodeId: "s02e01" } },
      { runId: "r1", stepId: "draft-loop", kind: "step_started", payload: { kind: "loop", body: "draft", until: "DRAFT_COMPLETE", max: 4 } },
      { runId: "r1", stepId: "draft-loop", kind: "loop_iteration", payload: { iteration: 1, max: 4, sentinel: true, toolCalls: 3 } },
      { runId: "r1", stepId: "draft-loop", kind: "step_completed", payload: { result: "DRAFT_COMPLETE", iterations: 1 } },
      { runId: "r1", stepId: "stamp", kind: "step_started", payload: { kind: "script", argv: ["python3"], inputHashes: {} } },
    ]);

    const res = await run({ pipeline: crashPipeline(), ctx: { runId: "r1", episodeId: "s02e01", showRoot: root }, log: new EventLog(logPath), executors });
    expect(res).toEqual({ status: "completed" });
    // The completed loop is left alone; the interrupted script is re-executed.
    expect(bodyCalls).toBe(0);
    expect((await readFile(path.join(root, "runs.txt"), "utf8")).trim().split("\n")).toHaveLength(2);
    expect(await readFile(path.join(root, "stamp.txt"), "utf8")).toBe("ok");

    const events = await new EventLog(logPath).read();
    // Spec §6.9: the re-execution is logged as a new step_started after the orphaned one, so the
    // interruption stays visible in the history rather than being erased.
    expect(events.filter((e) => e.kind === "step_started" && e.stepId === "stamp")).toHaveLength(2);
    expect(events.some((e) => e.kind === "step_progress" && e.stepId === "stamp")).toBe(true);
    expect(events.at(-1)?.kind).toBe("run_finished");
  });
});

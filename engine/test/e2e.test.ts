import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, answerGate, EventLog, deriveRunState, deriveStage, scriptExecutor } from "../src/index.js";
import type { Executors, Pipeline, StageMap } from "../src/index.js";

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
});

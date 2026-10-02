import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentQueryOptions } from "@showrunner/engine";
import { assemble, ask, troubleshootingPath } from "../server/what-happened.js";
import { appWith, makeShow, seedRun, writeIn, type SeedEvent } from "./helpers.js";

/** The sha256 the engine records for a prompt file: `loadPrompt` hashes the file's raw bytes, so
 *  a context assembled now can compare the hash a run recorded against the file on disk. */
function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** A run whose log carries the two prompt hashes, the chatter and the output hashes `assemble`
 *  has to make something of. `outline.md`'s hash matches the file on disk; `draft.md`'s does not,
 *  which is the "the prompt changed under this run" case the context has to report. */
async function seedBusyRun(root: string): Promise<void> {
  const outlinePrompt = "write the outline for {{episodeId}}\n";
  await writeIn(root, "prompts/outline.md", outlinePrompt);
  await writeIn(root, "prompts/draft.md", "draft the script for {{episodeId}}\n");
  const events: SeedEvent[] = [
    { kind: "run_started", payload: { pipeline: "episode", episodeId: "s02e01", engineVersion: "0.0.1" } },
    { stepId: "outline", kind: "agent_query", payload: { promptFile: "outline.md", promptHash: sha256(outlinePrompt), model: "m" } },
    { stepId: "outline", kind: "step_completed", payload: { inputHashes: { "Episodes/s02e01/premise.md": "aa" }, outputHashes: { "Episodes/s02e01/outline.md": "bb" } } },
    { stepId: "draft", kind: "agent_query", payload: { promptFile: "draft.md", promptHash: sha256("an older draft prompt\n"), model: "w" } },
  ];
  for (let i = 0; i < 4; i++) events.push({ stepId: "render", kind: "step_progress", payload: { done: i, total: 10, unit: "frames" } });
  for (let i = 0; i < 60; i++) events.push({ stepId: "render", kind: "script_line", payload: { stream: "stdout", line: `render line ${i}` } });
  for (let i = 0; i < 3; i++) events.push({ stepId: "tts-generate", kind: "script_line", payload: { stream: "stdout", line: `tts line ${i}` } });
  events.push({ stepId: "render", kind: "step_completed", payload: { inputHashes: {}, outputHashes: { "Production/s02e01/video/episode.mp4": "cc" } } });
  await seedRun(root, "s02e01", "r1", events);
}

describe("the what-happened context", () => {
  it("reports each prompt's hash at the run against the file on disk", async () => {
    const { root, ctx, store } = await appWith(await makeShow());
    await seedBusyRun(root);
    const context = await assemble(ctx, store, "s02e01", "r1");
    expect(context.pipeline.name).toBe("episode");
    expect(context.run).toMatchObject({ episodeId: "s02e01", runId: "r1" });
    expect(context.prompts.map((p) => p.stepId)).toEqual(["outline", "draft"]);
    expect(context.prompts[0]).toMatchObject({ promptFile: "outline.md", changed: false });
    expect(context.prompts[0]?.hashAtRun).toBe(context.prompts[0]?.hashNow);
    expect(context.prompts[1]).toMatchObject({ promptFile: "draft.md", changed: true });
    expect(context.prompts[1]?.hashNow).not.toBe(context.prompts[1]?.hashAtRun);
    store.close();
  });

  it("collapses the chatter: the last fifty script lines per step, the last progress per step", async () => {
    const { root, ctx, store } = await appWith(await makeShow());
    await seedBusyRun(root);
    const context = await assemble(ctx, store, "s02e01", "r1");
    const lines = context.events.filter((e) => e.kind === "script_line" && e.stepId === "render");
    expect(lines.length).toBe(50);
    expect(lines[0]?.payload["line"]).toBe("render line 10");
    expect(lines[49]?.payload["line"]).toBe("render line 59");
    expect(context.events.filter((e) => e.kind === "script_line" && e.stepId === "tts-generate").length).toBe(3);
    const progress = context.events.filter((e) => e.kind === "step_progress");
    expect(progress.length).toBe(1);
    expect(progress[0]?.payload["done"]).toBe(3);
    // Everything else is kept whole, and in log order.
    expect(context.events[0]?.kind).toBe("run_started");
    expect(context.events.filter((e) => e.kind === "agent_query").length).toBe(2);
    store.close();
  });

  it("names every file the run wrote, once", async () => {
    const { root, ctx, store } = await appWith(await makeShow());
    await seedBusyRun(root);
    const context = await assemble(ctx, store, "s02e01", "r1");
    expect(context.outputs).toEqual(["Episodes/s02e01/outline.md", "Production/s02e01/video/episode.mp4"]);
    store.close();
  });
});

describe("asking what happened", () => {
  it("streams the agent's text and logs the question beside the run, not in it", async () => {
    const { root, ctx, store } = await appWith(await makeShow());
    await seedBusyRun(root);
    const context = await assemble(ctx, store, "s02e01", "r1");
    const logFile = path.join(root, "Production", "s02e01", "runs", "r1.jsonl");
    const before = await readFile(logFile, "utf8");

    let seen: { prompt: string; options: AgentQueryOptions } | undefined;
    const fake = async function* (args: { prompt: string; options: AgentQueryOptions }): AsyncIterable<AgentMessage> {
      seen = args;
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield { type: "assistant", message: { content: [
        { type: "text", text: "The run stopped at render. " },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "x" } },
      ] } };
      yield { type: "assistant", message: { content: [{ type: "text", text: "The log says the NAS was not mounted." }] } };
      yield { type: "result", subtype: "success", result: "ignored", total_cost_usd: 0.0123 };
    };

    const chunks: string[] = [];
    for await (const chunk of ask(ctx, context, "Why did the render not finish?", fake)) chunks.push(chunk);
    expect(chunks).toEqual(["The run stopped at render. ", "The log says the NAS was not mounted."]);

    // The options are the read-only ones: three tools, no settings from the host machine.
    expect(seen?.options).toMatchObject({
      cwd: ctx.showRoot, model: "m", tools: ["Read", "Glob", "Grep"], allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "dontAsk", settingSources: [], maxTurns: 20,
    });
    expect(seen?.prompt).toContain("Why did the render not finish?");
    expect(seen?.prompt).toContain("\"runId\": \"r1\"");

    const troubleshooting = await readFile(troubleshootingPath(ctx, "s02e01", "r1"), "utf8");
    const rows = troubleshooting.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      by: "console:test",
      question: "Why did the render not finish?",
      answer: "The run stopped at render. The log says the NAS was not mounted.",
      costUsd: 0.0123,
    });
    expect(typeof rows[0]?.["ts"]).toBe("string");
    // The run log is the run's own history and nothing else was appended to it.
    expect(await readFile(logFile, "utf8")).toBe(before);
    expect(troubleshootingPath(ctx, "s02e01", "r1")).toBe(path.join(root, "Production", "s02e01", "runs", "r1.troubleshooting.jsonl"));
    store.close();
  });
});

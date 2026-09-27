import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProgressLine, scriptExecutor } from "../src/script-step.js";
import type { ScriptStep, RunContext, EventKind } from "../src/steps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "fixtures", name);
const ctx: RunContext = { runId: "r", episodeId: "s02e01", showRoot: here, results: {} };

function collector() {
  const events: { kind: EventKind; payload: Record<string, unknown> }[] = [];
  const emit = async (kind: EventKind, payload: Record<string, unknown>) => { events.push({ kind, payload }); };
  return { events, emit };
}

describe("parseProgressLine", () => {
  it("parses a progress line and ignores everything else", () => {
    expect(parseProgressLine('::progress {"done":2,"total":5,"unit":"shots"}')).toEqual({ done: 2, total: 5, unit: "shots" });
    expect(parseProgressLine('::progress {"done":2,"total":5,"unit":"shots","message":"s02-x"}')).toEqual({ done: 2, total: 5, unit: "shots", message: "s02-x" });
    expect(parseProgressLine("hello")).toBeNull();
    expect(parseProgressLine("::progress not json")).toBeNull();
  });
});

describe("scriptExecutor", () => {
  it("streams lines, turns progress lines into step_progress, and succeeds on exit 0", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", fixture("progress.py"), "3"] };
    const { events, emit } = collector();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: true });
    const progress = events.filter((e) => e.kind === "step_progress").map((e) => e.payload["done"]);
    expect(progress).toEqual([1, 2, 3]);
    const lines = events.filter((e) => e.kind === "script_line").map((e) => [e.payload["stream"], e.payload["line"]]);
    expect(lines).toContainEqual(["stdout", "starting"]);
    expect(lines).toContainEqual(["stderr", "done"]);
    expect(lines.some(([, l]) => String(l).startsWith("::progress"))).toBe(false);
  });

  it("fails with the exit code and the last stderr line", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", fixture("fail.py")] };
    const { emit } = collector();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: false, error: "exit 3: the reason" });
  });

  it("fails on timeout", async () => {
    const step: ScriptStep = { kind: "script", id: "s", timeoutMs: 200, argv: () => ["python3", "-c", "import time; time.sleep(5)"] };
    const { emit } = collector();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: false, error: "timeout after 200ms" });
  });

  it("never goes through a shell", async () => {
    // If argv were joined into a shell string, the semicolon would run `echo pwned`; as argv it is a literal filename.
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", "-c", "import sys; print(sys.argv[1])", "a; echo pwned"] };
    const { events, emit } = collector();
    await scriptExecutor(step, ctx, emit);
    const out = events.filter((e) => e.kind === "script_line").map((e) => e.payload["line"]);
    expect(out).toEqual(["a; echo pwned"]);
  });
});

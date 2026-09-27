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

  it("preserves script_line order even when the log write is slow and jittery", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", "-c", "for i in range(300): print(i)"] };
    const events: { kind: EventKind; payload: Record<string, unknown> }[] = [];
    const emit = async (kind: EventKind, payload: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      events.push({ kind, payload });
    };
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: true });
    const lines = events.filter((e) => e.kind === "script_line").map((e) => Number(e.payload["line"]));
    expect(lines).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });

  it("fails the step, and never hangs or leaks a rejection, when the log write rejects", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", fixture("progress.py"), "3"] };
    let n = 0;
    const emit = async () => { if (++n === 2) throw new Error("disk full"); };
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: false, error: "log write failed: disk full" });
  });

  it("destroys the pipes and stops queuing lines once the drain grace expires", async () => {
    // The child prints one line and exits at once; its grandchild, in its own session, keeps
    // writing to the inherited stdout for six seconds. Without the grace the executor would
    // never resolve; without the destroy-and-drop it would keep logging under a settled step.
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", fixture("escapee.py")] };
    const { events, emit } = collector();
    const started = Date.now();
    const r = await scriptExecutor(step, ctx, emit);
    const elapsed = Date.now() - started;

    expect(r).toEqual({ ok: true });
    expect(elapsed).toBeLessThan(3000);
    expect(events.some((e) => e.kind === "script_line" && e.payload["line"] === "one line")).toBe(true);

    const atResolve = events.length;
    await new Promise((done) => setTimeout(done, 500));
    expect(events.length).toBe(atResolve);
  });

  it("times out even when a grandchild holds the stdio pipes open", async () => {
    const step: ScriptStep = {
      kind: "script", id: "s", timeoutMs: 300,
      argv: () => ["python3", "-c", "import subprocess, time; subprocess.Popen(['sleep', '30']); time.sleep(30)"],
    };
    const { emit } = collector();
    const started = Date.now();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: false, error: "timeout after 300ms" });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

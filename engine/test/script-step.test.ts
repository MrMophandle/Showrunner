import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killLiveProcessGroups, liveProcessGroups, parseProgressLine, scriptExecutor } from "../src/script-step.js";
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
    // "starting" is the result: the last stdout line that was not a progress line.
    expect(r).toEqual({ ok: true, result: "starting" });
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
    expect(r).toEqual({ ok: true, result: "299" });
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

    // The grandchild's lines are logged under this step until the grace abandons the pipes, so
    // they are part of its stdout and the last of them is its result — "late 19" or thereabouts,
    // depending on how many 0.1s ticks fit in the grace. The step's own line is long overtaken.
    // This is the price of reading the result after the drain rather than at exit, and it is the
    // right side of the trade: a script that prints a summary and exits always gets that summary,
    // while only a grandchild that outlives its parent and keeps writing can displace one.
    expect(r.ok).toBe(true);
    expect(r.ok && r.result).toMatch(/^late \d+$/);
    expect(elapsed).toBeLessThan(3000);
    expect(events.some((e) => e.kind === "script_line" && e.payload["line"] === "one line")).toBe(true);

    const atResolve = events.length;
    await new Promise((done) => setTimeout(done, 500));
    expect(events.length).toBe(atResolve);
  });

  it("registers each live process group and kills them all on demand", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", "-c", "import time; time.sleep(30)"] };
    const { emit } = collector();
    const pending = scriptExecutor(step, ctx, emit);

    const deadline = Date.now() + 5000;
    while (liveProcessGroups().length === 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(liveProcessGroups()).toHaveLength(1);
    expect(killLiveProcessGroups()).toBe(1);

    const r = await pending;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.startsWith("signal SIGKILL")).toBe(true);
    expect(liveProcessGroups()).toEqual([]);
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

  it("returns the last non-progress stdout line as the result", async () => {
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", fixture("prints-result.py")] };
    const { emit } = collector();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: true, result: "MIX_OK 12.3s -14.0 LUFS" });
  });

  it("reads the result after the pipes drain, not when the child exits", async () => {
    // Twenty thousand short lines with no flush between them, then the summary, then an immediate
    // exit: the burst leaves stdout in flight when the child goes, and the summary is the very last
    // line in it. Node emits 'exit' when the process ends, not when its stdio has been read — that
    // is why 'close' is a separate event — so the result is taken after the drain, never in the
    // exit handler. A reduced version of this program (one pipe, no detach) reads the wrong last
    // line in 31 of 40 runs on this machine; the executor's own shape happened to win it 40 of 40,
    // which is the point: the ordering is not ours to rely on. The trailing flush and os._exit are
    // load-bearing — without them python's exit flush blocks on the pipe until the parent has
    // drained it, which hides the hazard rather than exercising it.
    const program = "import sys, os\nfor i in range(20000): sys.stdout.write('line %d\\n' % i)\nsys.stdout.flush()\nprint('SUMMARY_OK', flush=True)\nos._exit(0)";
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", "-c", program] };
    const { emit } = collector();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: true, result: "SUMMARY_OK" });
  });

  it("fails fast when the executable does not exist", async () => {
    // The spawn-failure path: Node reports ENOENT on the child's 'error' event, never on 'exit',
    // so this is the one ending that reaches settle() without the child having run at all. It must
    // still resolve — an executor that only listened for 'exit' would hang the step forever — and
    // it must resolve with the reason, because "spawn failed: ... ENOENT" is how an operator learns
    // a script was renamed or a tool is missing from PATH rather than that the script itself failed.
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["no-such-binary-xyz"] };
    const { emit } = collector();
    const started = Date.now();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: false, error: "spawn failed: spawn no-such-binary-xyz ENOENT" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("returns no result key when the script printed only progress lines", async () => {
    // Not fixtures/progress.py: that one prints "starting" on stdout, which is a result. A script
    // whose whole stdout is progress lines has no summary line to hand the next step.
    const step: ScriptStep = { kind: "script", id: "s", argv: () => ["python3", "-c", "import json\nfor i in (1, 2): print('::progress ' + json.dumps({'done': i, 'total': 2, 'unit': 'things'}), flush=True)"] };
    const { emit } = collector();
    const r = await scriptExecutor(step, ctx, emit);
    expect(r).toEqual({ ok: true });
  });
});

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Emit, EventKind, Executors, RunContext, ScriptOutcome, ScriptStep } from "./steps.js";

const PROGRESS_PREFIX = "::progress ";

export interface ProgressLine { done: number; total: number; unit: string; message?: string }

export function parseProgressLine(line: string): ProgressLine | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const v = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as Record<string, unknown>;
    if (typeof v["done"] !== "number" || typeof v["total"] !== "number") return null;
    const out: ProgressLine = { done: v["done"], total: v["total"], unit: typeof v["unit"] === "string" ? v["unit"] : "" };
    if (typeof v["message"] === "string") out.message = v["message"];
    return out;
  } catch {
    return null;
  }
}

/** How long to wait, after the child exits, for its stdio pipes to drain before giving up on
 *  them — a grandchild that inherited the pipes can hold them open after the child is gone. */
const DRAIN_GRACE_MS = 2000;

/** The pids of the children this module has spawned and not yet seen exit. Every child is spawned
 *  detached, so it leads its own process group and its pid is also that group's id. */
const live = new Set<number>();

/** The live child pids, as a copy. A supervisor reads this to know what is still running; it
 *  cannot mutate the registry, which only spawn and exit may do. */
export function liveProcessGroups(): number[] {
  return [...live];
}

/** SIGKILL the whole process group of every live child, and report how many were signalled and
 *  how many could not be. This is the shutdown path: without it a worker going down leaves a
 *  render or an audio batch running with nothing reading its output. A group that has already
 *  gone (ESRCH) is neither killed nor failed; any other error is counted as failed and the loop
 *  continues, because stopping at the first refusal would leave every later group running. */
export function killLiveProcessGroups(): { killed: number; failed: number } {
  let killed = 0, failed = 0;
  for (const pid of live) {
    try { process.kill(-pid, "SIGKILL"); killed++; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") failed++; }
  }
  return { killed, failed };
}

/** Test-only: replace the registry's contents. Production code never calls it — the registry is
 *  written only by a spawn and an exit — and a test that fills it must empty it again, because a
 *  pid left behind is a real process group on the host that a later kill would signal. */
export function __setLiveForTest(pids: number[]): void { live.clear(); for (const p of pids) live.add(p); }

export const scriptExecutor: Executors["script"] = (step: ScriptStep, ctx: RunContext, emit: Emit) => {
  const argv = step.argv(ctx);
  const [cmd, ...args] = argv;
  if (!cmd) return Promise.resolve({ ok: false, error: "empty argv" });
  const env = { ...process.env, ...(step.env ? step.env(ctx) : {}) };
  // detached: the child leads its own process group, so a timeout can kill the whole group,
  // grandchildren included, rather than only the direct child.
  const child = spawn(cmd, args, { cwd: step.cwd ?? ctx.showRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  if (child.pid !== undefined) live.add(child.pid);
  const forget = () => { if (child.pid !== undefined) live.delete(child.pid); };

  let lastStderr = "";
  // The step's result: the last stdout line that was neither a progress line nor blank. A script
  // ends with a one-line summary — "MIX_OK 12.3s -14.0 LUFS" — and that line is what a later
  // prompt reads as {{results.<id>}}.
  let lastStdout = "";
  let emitError: unknown;
  // Set when the drain grace expires: the pipes are being abandoned, so anything a grandchild
  // writes after that point is dropped rather than logged under a step that has already settled.
  let abandoned = false;
  // Every event is queued behind the previous one: order is preserved, and a rejected write is
  // caught the moment it happens instead of surfacing as an unhandled rejection.
  let tail: Promise<void> = Promise.resolve();
  const queue = (kind: EventKind, payload: Record<string, unknown>) => {
    tail = tail.then(() => emit(kind, payload)).catch((e: unknown) => { emitError ??= e; });
  };
  const wire = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
    const rl = createInterface({ input: stream });
    rl.on("line", (line) => {
      if (abandoned) return;
      const progress = parseProgressLine(line);
      if (progress !== null && name === "stdout") {
        queue("step_progress", { ...progress });
        return;
      }
      // A `::progress` line on stderr is forwarded like any other stderr line, but it is never
      // recorded as `lastStderr`. It is a unit-of-work report, not a complaint, and a script that
      // writes its progress to stderr would otherwise fail with its own last progress line as the
      // step's error message — hiding the real message it printed before it.
      if (line.trim() !== "" && progress === null) {
        if (name === "stderr") lastStderr = line;
        else lastStdout = line;
      }
      queue("script_line", { stream: name, line });
    });
    return new Promise<void>((resolve) => rl.on("close", () => resolve()));
  };
  const outDone = wire(child.stdout, "stdout");
  const errDone = wire(child.stderr, "stderr");

  const killGroup = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };

  /** How the child ended — not what the step reports. The outcome is built from this only after
   *  the pipes have drained, because `lastStdout` and `lastStderr` are not final until then. */
  type Ending =
    | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
    | { kind: "spawnFailed"; message: string };

  return new Promise<ScriptOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    const timer = step.timeoutMs !== undefined
      ? setTimeout(() => { timedOut = true; killGroup(); }, step.timeoutMs)
      : undefined;
    const outcomeOf = (ending: Ending): ScriptOutcome => {
      if (ending.kind === "spawnFailed") return { ok: false, error: `spawn failed: ${ending.message}` };
      if (timedOut) return { ok: false, error: `timeout after ${step.timeoutMs}ms` };
      if (ending.code === 0) return { ok: true, ...(lastStdout !== "" ? { result: lastStdout } : {}) };
      const shown = ending.code === null ? `signal ${ending.signal ?? "unknown"}` : `exit ${ending.code}`;
      return { ok: false, error: `${shown}: ${lastStderr}` };
    };
    const settle = async (ending: Ending) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Drain what the pipes still hold, but never wait forever on a grandchild holding them
      // open. When the grace wins, the pipes are destroyed so the fds are released and this
      // process is not left reading a stream nobody is waiting on.
      const drained = Promise.all([outDone, errDone]).then(() => "drained" as const);
      const grace = new Promise<"grace">((r) => { const t = setTimeout(() => r("grace"), DRAIN_GRACE_MS); t.unref(); });
      if (await Promise.race([drained, grace]) === "grace") {
        abandoned = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      await tail;
      // Built here, after the drain, and never in the exit handler: Node emits 'exit' when the
      // process ends, not when its stdio has been read — that is why 'close' is a separate event —
      // so a child that printed its summary line and exited at once can still have that line
      // unparsed when 'exit' fires. Both the result a later step reads and the last stderr line a
      // failure is reported with are exactly the lines that arrived, which is only knowable now.
      // `timedOut` cannot move under this await: the timer is cleared at the top of settle.
      const outcome = outcomeOf(ending);
      if (emitError !== undefined && outcome.ok) {
        const msg = emitError instanceof Error ? emitError.message : String(emitError);
        resolve({ ok: false, error: `log write failed: ${msg}` });
        return;
      }
      resolve(outcome);
    };
    child.on("error", (err) => { forget(); void settle({ kind: "spawnFailed", message: err.message }); });
    child.on("exit", (code, signal) => { forget(); void settle({ kind: "exit", code, signal }); });
  });
};

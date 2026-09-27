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

export const scriptExecutor: Executors["script"] = (step: ScriptStep, ctx: RunContext, emit: Emit) => {
  const argv = step.argv(ctx);
  const [cmd, ...args] = argv;
  if (!cmd) return Promise.resolve({ ok: false, error: "empty argv" });
  const env = { ...process.env, ...(step.env ? step.env(ctx) : {}) };
  // detached: the child leads its own process group, so a timeout can kill the whole group,
  // grandchildren included, rather than only the direct child.
  const child = spawn(cmd, args, { cwd: step.cwd ?? ctx.showRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true });

  let lastStderr = "";
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
      const p = name === "stdout" ? parseProgressLine(line) : null;
      if (p) {
        queue("step_progress", { ...p });
      } else {
        if (name === "stderr" && line.trim() !== "") lastStderr = line;
        queue("script_line", { stream: name, line });
      }
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

  return new Promise<ScriptOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    const timer = step.timeoutMs !== undefined
      ? setTimeout(() => { timedOut = true; killGroup(); }, step.timeoutMs)
      : undefined;
    const settle = async (outcome: ScriptOutcome) => {
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
      if (emitError !== undefined && outcome.ok) {
        const msg = emitError instanceof Error ? emitError.message : String(emitError);
        resolve({ ok: false, error: `log write failed: ${msg}` });
        return;
      }
      resolve(outcome);
    };
    child.on("error", (err) => { void settle({ ok: false, error: `spawn failed: ${err.message}` }); });
    child.on("exit", (code, signal) => {
      if (timedOut) { void settle({ ok: false, error: `timeout after ${step.timeoutMs}ms` }); return; }
      if (code === 0) { void settle({ ok: true }); return; }
      const shown = code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
      void settle({ ok: false, error: `${shown}: ${lastStderr}` });
    });
  });
};

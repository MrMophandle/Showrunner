import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Emit, Executors, RunContext, ScriptStep } from "./steps.js";

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

export const scriptExecutor: Executors["script"] = (step: ScriptStep, ctx: RunContext, emit: Emit) => {
  const argv = step.argv(ctx);
  const [cmd, ...args] = argv;
  if (!cmd) return Promise.resolve({ ok: false, error: "empty argv" });
  const env = { ...process.env, ...(step.env ? step.env(ctx) : {}) };
  const child = spawn(cmd, args, { cwd: step.cwd ?? ctx.showRoot, env, stdio: ["ignore", "pipe", "pipe"] });

  let lastStderr = "";
  const pending: Promise<void>[] = [];
  const wire = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
    const rl = createInterface({ input: stream });
    rl.on("line", (line) => {
      const p = name === "stdout" ? parseProgressLine(line) : null;
      if (p) {
        pending.push(emit("step_progress", { ...p }));
      } else {
        if (name === "stderr" && line.trim() !== "") lastStderr = line;
        pending.push(emit("script_line", { stream: name, line }));
      }
    });
    return new Promise<void>((resolve) => rl.on("close", () => resolve()));
  };
  const outDone = wire(child.stdout, "stdout");
  const errDone = wire(child.stderr, "stderr");

  return new Promise((resolve) => {
    let timedOut = false;
    const timer = step.timeoutMs !== undefined
      ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, step.timeoutMs)
      : undefined;
    child.on("error", async (err) => {
      if (timer) clearTimeout(timer);
      await Promise.all(pending);
      resolve({ ok: false, error: `spawn failed: ${err.message}` });
    });
    child.on("close", async (code) => {
      if (timer) clearTimeout(timer);
      await Promise.all([outDone, errDone]);
      await Promise.all(pending);
      if (timedOut) return resolve({ ok: false, error: `timeout after ${step.timeoutMs}ms` });
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, error: `exit ${code}: ${lastStderr}` });
    });
  });
};

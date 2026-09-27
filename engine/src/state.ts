import type { Event } from "./events.js";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "waiting";

export interface GateState { stepId: string; attempt: number; message: string; openedAt: string }

export interface Progress { done: number; total: number; unit: string; message?: string }

export interface Position { stepId: string; startedAt: string; progress?: Progress }

export interface RunState {
  runId: string;
  finished: boolean;
  status?: "completed" | "failed";
  steps: Record<string, StepStatus>;
  results: Record<string, unknown>;
  openGate?: GateState;
  position?: Position;
  lastEventAt?: string;
  gateAttempts: Record<string, number>;
}

export function deriveRunState(events: Event[]): RunState {
  const s: RunState = { runId: events[0]?.runId ?? "", finished: false, steps: {}, results: {}, gateAttempts: {} };
  for (const e of events) {
    s.lastEventAt = e.ts;
    const id = e.stepId;
    switch (e.kind) {
      case "run_started":
        break;
      case "run_finished":
        s.finished = true;
        s.status = e.payload["status"] === "completed" ? "completed" : "failed";
        delete s.position;
        break;
      case "step_started":
        if (id) { s.steps[id] = "running"; s.position = { stepId: id, startedAt: e.ts }; }
        break;
      case "step_progress":
        if (id && s.position?.stepId === id) {
          const p = e.payload;
          const progress: Progress = { done: Number(p["done"]), total: Number(p["total"]), unit: String(p["unit"] ?? "") };
          if (typeof p["message"] === "string") progress.message = p["message"];
          s.position = { ...s.position, progress };
        }
        break;
      case "step_completed":
      case "step_cached":
        if (id) {
          s.steps[id] = "completed";
          if ("result" in e.payload) s.results[id] = e.payload["result"];
          if (s.position?.stepId === id) delete s.position;
        }
        break;
      case "step_failed":
        if (id) { s.steps[id] = "failed"; if (s.position?.stepId === id) delete s.position; }
        break;
      case "step_skipped":
        if (id) { s.steps[id] = "skipped"; if (s.position?.stepId === id) delete s.position; }
        break;
      case "gate_opened":
        if (id) {
          const attempt = Number(e.payload["attempt"] ?? 1);
          s.steps[id] = "waiting";
          s.gateAttempts[id] = attempt;
          s.openGate = { stepId: id, attempt, message: String(e.payload["message"] ?? ""), openedAt: e.ts };
          if (s.position?.stepId === id) delete s.position;
        }
        break;
      case "gate_answered":
        if (id) {
          if (s.openGate?.stepId === id) delete s.openGate;
          if (e.payload["approved"] === true) {
            s.steps[id] = "completed";
            s.results[id] = e.payload;
          } else {
            // A rejected gate leaves the step "running" with no open gate and no position.
            // The runner treats "running with no position" as mid-step and re-executes the
            // step, which for a gate runs the fix agent and reopens it (next attempt).
            s.steps[id] = "running";
          }
        }
        break;
      default:
        break;
    }
  }
  return s;
}

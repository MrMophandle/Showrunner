import type { Event } from "./events.js";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "waiting" | "bypassed";

/** The step_skipped reason that marks a step bypassed by its own `when` rather than skipped by a
 *  broken dependency. Written by the runner, read here; the two must not drift apart. */
export const BYPASS_REASON = "when: false";

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
        // A finished run has nothing open. A gate left open by a run that then failed would
        // otherwise be reported as still awaiting an answer that can never be acted on.
        delete s.openGate;
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
        if (id) {
          s.steps[id] = "failed";
          if (s.position?.stepId === id) delete s.position;
          // A gate that fails its attempt cap is failed, not waiting.
          if (s.openGate?.stepId === id) delete s.openGate;
        }
        break;
      case "step_skipped":
        // Two different outcomes share one event kind: a step its own `when` turned off is
        // "bypassed" and its dependents still run; a step a broken dependency took out is
        // "skipped" and its dependents do not.
        if (id) {
          s.steps[id] = e.payload["reason"] === BYPASS_REASON ? "bypassed" : "skipped";
          if (s.position?.stepId === id) delete s.position;
        }
        break;
      case "gate_opened":
        if (id) {
          // A malformed attempt must not poison the cap comparison with NaN, which would make
          // `attempts >= maxAttempts` false forever and let the gate reopen without limit.
          const raw = Number(e.payload["attempt"] ?? 1);
          const attempt = Number.isFinite(raw) ? raw : 1;
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
            // A rejected gate leaves the step "running" with no open gate. The runner
            // re-executes any step whose status is not terminal and does not consult
            // `position` to decide that, so the gate is re-executed: it runs the fix agent
            // and reopens at the next attempt.
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

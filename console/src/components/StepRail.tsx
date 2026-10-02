import type { RunView, StepRow, WireEvent } from "../../shared/types.js";
import { duration, elapsed, firstLine } from "../projections.js";
import { ProgressBar } from "./ProgressBar.js";

/** The step rail: every step of the pipeline, in pipeline order, one line each.
 *
 *  The rows come from the pipeline definition and not from the log (`server/runs.ts`'s
 *  `projectSteps`), which is what makes this a picture of the whole episode rather than of the
 *  part that has happened: a step the log has never mentioned is pending, and the operator can
 *  see what is still ahead of a run as well as what is behind it.
 *
 *  Three things are marked the moment they land, because each of them is a run going wrong in a
 *  way the status alone does not say. A loop iteration that called no tool **did nothing** — the
 *  shape of a draft loop about to exhaust its cap while reporting progress. An iteration that
 *  errored **failed**. And a `step_reset` says a step's finished work was thrown away, by a gate's
 *  rejection (`by` is the gate), by a withdrawal (`withdraw:<gate>`) or by an operator's re-run. */

/** A step's result as one line. The result is whatever the step returned — a verdict object, a
 *  guard's message, a script's stdout summary — so this reads the shapes the pipeline actually
 *  produces and falls back to compact JSON rather than printing nothing. */
export function resultLine(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return firstLine(result);
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (Array.isArray(result)) return `${result.length} ${result.length === 1 ? "item" : "items"}`;
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof record["pass"] === "boolean") parts.push(record["pass"] === true ? "pass" : "fail");
    const issues = record["issues"];
    if (Array.isArray(issues) && issues.length > 0) parts.push(`${issues.length} ${issues.length === 1 ? "issue" : "issues"}`);
    for (const key of ["message", "summary", "milestone", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value !== "") { parts.push(firstLine(value)); break; }
    }
    if (parts.length > 0) return parts.join(" · ");
    const json = JSON.stringify(result);
    return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  }
  return "";
}

/** How long a step took, or how long it has been going. */
function timing(row: StepRow, now: number): string {
  if (row.startedAt === undefined) return "";
  if (row.endedAt !== undefined) {
    const from = Date.parse(row.startedAt);
    const to = Date.parse(row.endedAt);
    return Number.isFinite(from) && Number.isFinite(to) ? duration(to - from) : "";
  }
  return row.status === "running" || row.status === "waiting" ? elapsed(row.startedAt, now) : "";
}

const FLAG_TEXT: Record<NonNullable<StepRow["flag"]>, string> = {
  "did-nothing": "did nothing",
  "failed-iteration": "failed iteration",
};

export interface StepRailProps {
  view: RunView;
  events: WireEvent[];
  now: number;
  /** Offered for a gate that was approved while no gate is open. Absent while one is. */
  onWithdraw?: (stepId: string) => void;
  withdrawing?: string | null;
}

export function StepRail({ view, events, now, onWithdraw, withdrawing = null }: StepRailProps) {
  // Every reset the log recorded, by the step it reset, and every resume the run has had. Read
  // from the events rather than from the step rows because a reset is a thing that *happened* and
  // the row only carries where the step ended up: a step that was reset and then completed again
  // looks exactly like one that completed the first time.
  const resets = new Map<string, { by: string; ts: string }[]>();
  const resumes: { by: string; ts: string }[] = [];
  for (const e of events) {
    const by = typeof e.payload["by"] === "string" ? e.payload["by"] : "someone";
    if (e.kind === "step_reset" && e.stepId !== undefined) {
      const list = resets.get(e.stepId) ?? [];
      list.push({ by, ts: e.ts });
      resets.set(e.stepId, list);
    } else if (e.kind === "run_resumed") {
      resumes.push({ by, ts: e.ts });
    }
  }

  return (
    <div className="rail">
      {resumes.length > 0 && (
        <ul className="rail-resumes">
          {resumes.map((r, i) => (
            <li key={i} className="rail-marker">resumed by {r.by} · <span className="mono">{r.ts.slice(11, 19)}</span></li>
          ))}
        </ul>
      )}
      <ol className="rail-steps">
        {view.steps.map((row) => {
          const current = view.position?.stepId === row.id;
          const resetList = resets.get(row.id) ?? [];
          const approvedGate = row.kind === "gate" && row.status === "completed";
          return (
            <li key={row.id} className={`rail-step rail-${row.status}${current ? " rail-current" : ""}`}>
              <div className="rail-line">
                <span className={`rail-dot rail-dot-${row.status}`} aria-hidden="true" />
                <span className="rail-id mono">{row.id}</span>
                <span className="rail-kind">{row.kind}</span>
                <span className="rail-status">{row.status}</span>
                <span className="rail-timing mono">{timing(row, now)}</span>
                {row.flag !== undefined && <span className={`rail-flag rail-flag-${row.flag}`}>{FLAG_TEXT[row.flag]}</span>}
                {row.toolCalls !== undefined && <span className="rail-tools mono">{row.toolCalls} tool calls</span>}
                {approvedGate && onWithdraw !== undefined && (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={withdrawing !== null}
                    onClick={() => { onWithdraw(row.id); }}
                  >
                    {withdrawing === row.id ? "withdrawing…" : "withdraw approval"}
                  </button>
                )}
              </div>
              {row.error !== undefined && row.error !== "" && <div className="rail-error">{firstLine(row.error)}</div>}
              {row.error === undefined && resultLine(row.result) !== "" && <div className="rail-result">{resultLine(row.result)}</div>}
              {row.progress !== undefined && <ProgressBar progress={row.progress} />}
              {resetList.map((reset, i) => (
                <div key={i} className="rail-marker">reset by {reset.by} · <span className="mono">{reset.ts.slice(11, 19)}</span></div>
              ))}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

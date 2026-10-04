import { useState } from "react";
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
 *  produces and falls back to compact JSON rather than printing nothing.
 *
 *  The key list below is `message` and `summary` only. It also carried `milestone` and `detail`,
 *  the two fields on the six retired `stamp-*` steps' results
 *  (`{ milestone: "outline", detail: "approved at outline-gate" }`); no step in any pipeline
 *  returns either key now, so both branches were unreachable, and a future step whose result
 *  happens to carry a `detail` field would have been absorbed into a dead stamp-era branch
 *  instead of being read as a new shape worth a branch of its own. A result carrying neither
 *  `message` nor `summary` falls through to the compact JSON below, which is what it should do. */
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
    for (const key of ["message", "summary"]) {
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
  /** Offered for the latest approved gate while no gate is open. Absent while one is. */
  onWithdraw?: (stepId: string) => void;
  withdrawing?: string | null;
}

/** The last approved gate in pipeline order, or undefined when none is approved — the one gate
 *  the rail offers "withdraw approval" on.
 *
 *  The affordance is restricted to it because the engine's withdrawal leaves every **downstream**
 *  gate at `completed` (ruling F-26, and the engine's standing rule that no reset touches a gate).
 *  Withdrawing an earlier gate therefore regenerates the work the later gates were approving and
 *  then walks past those approvals without re-asking: the showrunner's "yes" to the old script
 *  applied to a new one. That is a real move, and the route still performs it and names the
 *  surviving gates when it does; it is not a move to offer as one click beside every approved gate
 *  in a 73-row rail. */
export function latestApprovedGate(steps: StepRow[]): string | undefined {
  let latest: string | undefined;
  for (const row of steps) if (row.kind === "gate" && row.status === "completed") latest = row.id;
  return latest;
}

/** How many steps the rail shows beyond the run's current position when it is collapsed: the
 *  current step and the one after it, so the rail says what is next without listing the sixty
 *  pending steps behind that. */
const LOOKAHEAD = 1;

/** Where the collapsed rail stops: past the last row the log has anything to say about and past
 *  the run's current position, plus `LOOKAHEAD`. A run that has not started yet cuts at its first
 *  step, which reads as "next up" rather than as an empty rail. */
function collapseAt(view: RunView): number {
  let last = -1;
  for (let i = 0; i < view.steps.length; i++) {
    const row = view.steps[i];
    if (row === undefined) continue;
    if (row.status !== "pending" || view.position?.stepId === row.id) last = i;
  }
  return Math.min(view.steps.length, last + 1 + LOOKAHEAD);
}

export function StepRail({ view, events, now, onWithdraw, withdrawing = null }: StepRailProps) {
  // Collapsed by default: the episode pipeline is 73 steps, and a run three steps in drew seventy
  // rows of "pending" between the operator and the event feed. The toggle is the whole picture
  // back, because "what is still ahead" is the rail's other job.
  const [showAll, setShowAll] = useState(false);
  const cut = collapseAt(view);
  const collapsible = Math.max(0, view.steps.length - cut);
  const shown = showAll || collapsible === 0 ? view.steps : view.steps.slice(0, cut);
  const withdrawable = latestApprovedGate(view.steps);

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
        {shown.map((row) => {
          const current = view.position?.stepId === row.id;
          const resetList = resets.get(row.id) ?? [];
          const approvedGate = row.id === withdrawable;
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
      {collapsible > 0 && (
        <button type="button" className="btn btn-small rail-toggle" onClick={() => { setShowAll(!showAll); }}>
          {showAll ? "show only what has run" : `show all ${view.steps.length} steps (${collapsible} pending hidden)`}
        </button>
      )}
    </div>
  );
}

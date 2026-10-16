import { useEffect, useRef, useState } from "react";
import type { WireEvent } from "../../shared/types.js";
import { firstLine } from "../projections.js";
import { readVerdict } from "./Verdicts.js";

/** The run's log, newest last, auto-following.
 *
 *  It follows the bottom only while the operator is already at the bottom. A feed that scrolled
 *  itself whatever the reader was doing would make the one thing this page is for — reading the
 *  twenty lines before a failure — impossible during a run that is still writing.
 *
 *  `script_line` is collapsed per step behind a toggle. A render writes one a second for four
 *  hours and a Python step writes one per scene: left expanded, they are the whole feed, and the
 *  `step_failed` that says why the run stopped scrolls past at a hundred lines a minute. Collapsed
 *  by default, with the count, so the operator can see the chatter is there. */

/** How close to the bottom still counts as "at the bottom", in pixels. Generous, because a wheel
 *  or a touch scroll lands a few pixels short of the end. */
const FOLLOW_SLACK = 48;

/** One event as a line. Every kind the engine writes has a field that says what it did; the
 *  fallback is the payload as compact JSON, truncated — a kind this client does not know is still
 *  a line the operator can read, which is the point of a raw feed. */
export function eventSummary(e: WireEvent): string {
  const p = e.payload;
  const str = (key: string): string | undefined => (typeof p[key] === "string" ? p[key] as string : undefined);
  switch (e.kind) {
    case "script_line":
      return str("line") ?? str("text") ?? "";
    case "step_progress": {
      const unit = str("unit") ?? "";
      const message = str("message");
      return `${String(p["done"])}/${String(p["total"])} ${unit}${message !== undefined ? ` — ${message}` : ""}`.trim();
    }
    case "step_started":
      return str("kind") ?? "";
    case "step_completed":
    case "step_cached": {
      const result = p["result"];
      if (typeof result === "string") return firstLine(result);
      return result === undefined ? "" : JSON.stringify(result).slice(0, 160);
    }
    case "step_failed":
      return firstLine(str("error") ?? "");
    case "step_waiting":
      // The reason is already an operator sentence with the reset time and the weekly figure in
      // it; the rest of the payload (window, ceiling) is the engine's arithmetic, and the raw log
      // is one click away for anyone who wants it.
      return str("reason") ?? "";
    case "step_skipped":
      return str("reason") ?? "";
    case "panel_round": {
      // Plan J's review round came back red, which is the event the `step_reset` burst below it
      // belongs to. The payload carries every reset step's result so the next round's prompts can
      // read them back (`{{prior.<id>}}`, inventory J-14) — ten kilobytes of verdict objects on a
      // real run — so this case exists to keep that out of the feed: the fallback arm renders a
      // payload as truncated JSON, and for this one kind that would be the whole line and none of
      // the meaning.
      //
      // The reviewers that **failed**, not the ones that raised issues. `pass` and `issues` are
      // decoupled: on the measured s02e01 round `flow-check` passed carrying five pieces of craft
      // advice (inventory J-09, J-13), and naming it among the failures would send the reader
      // looking for a defect it did not claim. `readVerdict` is the console's one defensive reader
      // of a show's own verdict shape, shared with the gate's verdict board rather than copied.
      //
      // **And only an entry that is a verdict at all can be a failing one.** The event is keyed on
      // every step the round resets, and two of those results are not verdicts — the hand-edit
      // guard's JSON record and the canon ledger's result line (R-22; nine keys on the real
      // pipeline) — so a filter on `readVerdict(v).pass` alone named them among the failing
      // reviewers on every round, since a string reads as `pass: false`. The test for "is this a
      // verdict" is `server/gates.ts`' own: an object carrying a `pass`.
      const verdicts = p["verdicts"];
      const isVerdict = (v: unknown): boolean =>
        typeof v === "object" && v !== null && !Array.isArray(v) && "pass" in (v as Record<string, unknown>);
      const red = typeof verdicts === "object" && verdicts !== null && !Array.isArray(verdicts)
        ? Object.entries(verdicts).filter(([, v]) => isVerdict(v) && !readVerdict(v).pass).map(([id]) => id)
        : [];
      const costUsd = p["costUsd"];
      const cost = typeof costUsd === "number" ? ` · $${costUsd.toFixed(4)}` : "";
      return `round ${String(p["round"] ?? "?")} red${red.length > 0 ? ` — ${red.join(", ")}` : ""}${cost}`;
    }
    case "step_reset":
      return `by ${str("by") ?? "someone"}`;
    case "run_resumed":
      return `by ${str("by") ?? "someone"}`;
    case "gate_opened":
      return `attempt ${String(p["attempt"] ?? 1)}`;
    case "gate_answered":
      return `${p["approved"] === true ? "approved" : "rejected"} by ${str("by") ?? "someone"}${str("notes") !== undefined && str("notes") !== "" ? ` — ${firstLine(str("notes") ?? "")}` : ""}`;
    case "run_started":
      return `pipeline ${str("pipeline") ?? "?"}`;
    case "run_finished":
      return `status ${str("status") ?? "?"}`;
    case "loop_iteration": {
      const error = str("error");
      return `iteration ${String(p["iteration"] ?? "?")} · ${String(p["toolCalls"] ?? "?")} tool calls${error !== undefined && error !== "" ? ` · ${firstLine(error)}` : ""}`;
    }
    case "agent_query":
      return str("promptFile") ?? "";
    default: {
      const json = JSON.stringify(p);
      return json === "{}" ? "" : (json.length > 160 ? `${json.slice(0, 157)}…` : json);
    }
  }
}

/** The feed's rows: every event, except that a consecutive run of `script_line`s from one step
 *  becomes one collapsed row carrying them. Consecutive rather than per-step-overall, so the
 *  chatter stays where it happened in the log — a collapsed block between a step's start and its
 *  failure, rather than all of a step's output gathered at the top. */
interface Row {
  kind: "event";
  event: WireEvent;
  index: number;
}

interface Block {
  kind: "lines";
  stepId: string;
  events: WireEvent[];
  index: number;
}

export function feedRows(events: WireEvent[]): (Row | Block)[] {
  const rows: (Row | Block)[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue;
    if (e.kind !== "script_line") { rows.push({ kind: "event", event: e, index: i }); continue; }
    const stepId = e.stepId ?? "";
    const last = rows[rows.length - 1];
    if (last !== undefined && last.kind === "lines" && last.stepId === stepId) { last.events.push(e); continue; }
    rows.push({ kind: "lines", stepId, events: [e], index: i });
  }
  return rows;
}

export function EventFeed({ events, logUrl }: { events: WireEvent[]; logUrl: string }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  // Follow the bottom when the reader is at the bottom. Measured before the paint that added the
  // new rows would have moved it, which is why the check is in the same effect as the scroll.
  useEffect(() => {
    const el = scroller.current;
    if (el === null || !following.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events]);

  const rows = feedRows(events);

  return (
    <section className="feed">
      <div className="feed-head">
        <h2>the log</h2>
        <span className="quiet">{events.length} {events.length === 1 ? "event" : "events"}{events.length >= 2000 ? " (the last 2,000)" : ""}</span>
        <a className="btn btn-small" href={logUrl} download>download log</a>
      </div>
      <div
        className="feed-scroll mono"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el === null) return;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
        }}
      >
        {rows.length === 0 && <p className="quiet">no events yet</p>}
        {rows.map((row) => {
          if (row.kind === "event") {
            const { event } = row;
            return (
              <div className="feed-line" key={row.index}>
                <span className="feed-ts">{event.ts.slice(11, 23)}</span>
                <span className="feed-step">{event.stepId ?? "—"}</span>
                <span className={`feed-kind feed-kind-${event.kind}`}>{event.kind}</span>
                <span className="feed-text">{eventSummary(event)}</span>
              </div>
            );
          }
          const open = expanded.has(row.index);
          return (
            <div className="feed-block" key={row.index}>
              <button
                type="button"
                className="feed-toggle"
                aria-expanded={open}
                onClick={() => {
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(row.index)) next.delete(row.index); else next.add(row.index);
                    return next;
                  });
                }}
              >
                {open ? "▾" : "▸"} {row.events.length} script {row.events.length === 1 ? "line" : "lines"} from {row.stepId === "" ? "the run" : row.stepId}
              </button>
              {open && row.events.map((event, i) => (
                <div className="feed-line feed-line-quiet" key={i}>
                  <span className="feed-ts">{event.ts.slice(11, 23)}</span>
                  <span className="feed-text">{eventSummary(event)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

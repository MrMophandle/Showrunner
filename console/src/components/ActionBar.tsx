import { useState } from "react";
import { Link } from "react-router-dom";
import type { RunView } from "../../shared/types.js";
import { post, showHref, showPath, useConsole, useShowKey } from "../api.js";
import { readOnlyLine } from "../projections.js";

/** The recovery actions for one run, and the reason any of them is unavailable.
 *
 *  Every button here is one of the server's action routes, and every one of them obeys the same
 *  order on the far side — read the lock, append the engine's event, then spawn a worker
 *  (`server/app.ts`'s "the write side"). So the whole of this component's job is to offer the one
 *  move that fits the run's state and to show the server's refusal verbatim when it refuses: the
 *  engine words these messages ("gate \"image-gate\" is open; answer it or withdraw, not reset")
 *  and a console that paraphrased them would be telling the operator a second, less exact story.
 *
 *  A disabled button says why it is disabled rather than vanishing. "Re-run from here" that is
 *  simply absent while a worker holds the run teaches nothing; one that is there, greyed, saying
 *  "pid 4821 is holding this run" tells the operator what to wait for.
 *
 *  **A read-only show is the one case where the buttons are absent rather than greyed**, and the
 *  distinction is the point: a greyed button says "not yet, and here is what to wait for", while a
 *  read-only show will never accept any of these — the server answers 403 to every POST to it
 *  (ruling H-03). The two links that are GETs, the open gate and "what happened", stay: a
 *  read-only show is read, and reading is all of what it offers.
 *
 *  The show key and `readOnly` are read from the url and from `ConsoleContext` rather than passed
 *  in, because this component is only ever rendered inside one show's Run page and a prop would be
 *  a second copy of a fact the url already carries. */

export interface ActionBarProps {
  view: RunView;
  /** Called after any action is accepted: the Run page refetches the view and the events. */
  onDone: () => void;
}

export function ActionBar({ view, onDone }: ActionBarProps) {
  const { episodeId, runId } = view;
  const showKey = useShowKey();
  const { canAct, readOnly } = useConsole();
  const base = showPath(showKey, `/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmContinue, setConfirmContinue] = useState(false);
  const [resetStep, setResetStep] = useState("");

  const worker = view.worker;
  const liveWorker = worker !== undefined && worker.alive;
  const resetBlocked = view.openGate !== undefined
    ? `gate ${view.openGate.stepId} is open — answer it or withdraw it, not reset`
    : liveWorker && worker !== undefined
      ? `pid ${worker.pid} is holding this run`
      : null;

  async function run(name: string, path: string, body: unknown, done: (result: unknown) => string): Promise<void> {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const result = await post<unknown>(path, body);
      setNotice(done(result));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // The steps an operator may re-run from: gates are not among them, which is the engine's rule
  // and not a UI choice — a gate is answered or withdrawn, never reset.
  const pickable = view.steps.filter((s) => s.kind !== "gate");

  return (
    <section className="actions">
      <div className="action-row">
        {view.status === "waiting" && view.openGate !== undefined && (
          <Link className="btn btn-primary" to={showHref(showKey, `/episodes/${episodeId}/runs/${runId}/gate`)}>
            open gate · {view.openGate.stepId}
          </Link>
        )}

        {view.status === "failed" && canAct && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => { void run("resume", `${base}/resume`, {}, () => "resumed — a worker is on it"); }}
          >
            {busy === "resume" ? "resuming…" : "resume"}
          </button>
        )}

        {view.status === "crashed" && canAct && !confirmContinue && (
          <button type="button" className="btn btn-primary" onClick={() => { setConfirmContinue(true); }}>continue</button>
        )}

        <Link className="btn" to={showHref(showKey, `/episodes/${episodeId}/runs/${runId}/what-happened`)}>what happened</Link>
      </div>

      {readOnly && (
        <p className="action-reason">{readOnlyLine(showKey, "resume, continue, re-run from here and withdraw are all refused")}</p>
      )}

      {confirmContinue && (
        <div className="action-confirm">
          <p>
            Continuing replays the open step. {worker !== undefined && worker.groups.length > 0
              ? <>The dead worker recorded <span className="mono">{worker.groups.length}</span> live process {worker.groups.length === 1 ? "group" : "groups"} — <span className="mono">{worker.groups.join(", ")}</span> — and they are signalled first, because a replay starting while the old render is still writing would put two processes on one file.</>
              : <>The dead worker recorded no live process groups, so nothing is signalled.</>}
          </p>
          <div className="action-row">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy !== null}
              onClick={() => {
                setConfirmContinue(false);
                void run("continue", `${base}/continue`, {}, () => "continued — a worker is replaying the open step");
              }}
            >
              {busy === "continue" ? "continuing…" : worker !== undefined && worker.groups.length > 0 ? "kill the groups and continue" : "continue"}
            </button>
            <button type="button" className="btn" onClick={() => { setConfirmContinue(false); }}>cancel</button>
          </div>
        </div>
      )}

      {canAct && (
      <div className="action-row action-reset">
        <label htmlFor="reset-step">re-run from</label>
        <select
          id="reset-step"
          value={resetStep}
          disabled={resetBlocked !== null || busy !== null}
          onChange={(e) => { setResetStep(e.target.value); }}
        >
          <option value="">choose a step…</option>
          {pickable.map((s) => <option key={s.id} value={s.id}>{s.id} ({s.status})</option>)}
        </select>
        <button
          type="button"
          className="btn"
          disabled={resetBlocked !== null || busy !== null || resetStep === ""}
          onClick={() => {
            void run("reset", `${base}/reset`, { stepIds: [resetStep] }, (result) => {
              const reset = (result as { reset?: unknown } | undefined)?.reset;
              return Array.isArray(reset) ? `reset, and a worker is on it: ${reset.join(", ")}` : "reset, and a worker is on it";
            });
          }}
        >
          {busy === "reset" ? "resetting…" : "re-run from here"}
        </button>
        {resetBlocked !== null && <span className="action-reason">{resetBlocked}</span>}
        {resetBlocked === null && <span className="action-reason">everything downstream of the step goes back to pending</span>}
      </div>
      )}

      {notice !== null && <p className="notice-line">{notice}</p>}
      {error !== null && <p className="error-line">{error}</p>}
    </section>
  );
}

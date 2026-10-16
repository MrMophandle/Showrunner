import { useState } from "react";
import { Link } from "react-router-dom";
import type { RunView } from "../../shared/types.js";
import { post, showHref, showPath, useConsole, useShowKey } from "../api.js";
import { readOnlyLine } from "../projections.js";

/** The run's secondary moves: re-run from a step, and the troubleshooting page.
 *
 *  **The primary move is not here any more** (Ryan's ruling, 2026-10-15). Open-gate, Resume and
 *  Continue moved to the situation line at the top of the Run page, where the sentence that says
 *  the run needs answering, resuming or continuing is: a button beside the statement of the
 *  problem, instead of a row of buttons the reader has to match to a banner. What is left is the
 *  move that fits no particular state — re-run from here, which an operator may want at any time —
 *  and the "what happened" link.
 *
 *  **And no success notices.** This component used to say "resumed — a worker is on it" after a
 *  POST, which was true for a second and then sat there while the run went on to park itself at a
 *  gate. The situation line is the feedback now, because it states the run's state rather than
 *  recording what was asked of it: the reset's own result — every step downstream of the chosen one
 *  back to `pending` — is on the step rail a moment later, and the static reason beside the button
 *  says so before it is pressed. The server's **refusals** are still printed verbatim ("gate
 *  \"image-gate\" is open; answer it or withdraw, not reset"): the engine words those, and a console
 *  that paraphrased one would be telling the operator a second, less exact story.
 *
 *  A disabled button says why it is disabled rather than vanishing. "Re-run from here" that is
 *  simply absent while a worker holds the run teaches nothing; one that is there, greyed, saying
 *  "pid 4821 is holding this run" tells the operator what to wait for.
 *
 *  **A read-only show is the one case where the button is absent rather than greyed**, and the
 *  distinction is the point: a greyed button says "not yet, and here is what to wait for", while a
 *  read-only show will never accept any of these — the server answers 403 to every POST to it
 *  (ruling H-03). The links that are GETs stay, here and in the situation line: a read-only show is
 *  read, and reading is all of what it offers.
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
  const [resetStep, setResetStep] = useState("");

  const worker = view.worker;
  const liveWorker = worker !== undefined && worker.alive;
  const resetBlocked = view.openGate !== undefined
    ? `gate ${view.openGate.stepId} is open — answer it or withdraw it, not reset`
    : liveWorker && worker !== undefined
      ? `pid ${worker.pid} is holding this run`
      : null;

  async function run(name: string, path: string, body: unknown): Promise<void> {
    setBusy(name);
    setError(null);
    try {
      await post<unknown>(path, body);
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
        <Link className="btn" to={showHref(showKey, `/episodes/${episodeId}/runs/${runId}/what-happened`)}>what happened</Link>
      </div>

      {readOnly && (
        <p className="action-reason">{readOnlyLine(showKey, "re-run from here, resume, continue and withdraw are all refused")}</p>
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
          onClick={() => { void run("reset", `${base}/reset`, { stepIds: [resetStep] }); }}
        >
          {busy === "reset" ? "resetting…" : "re-run from here"}
        </button>
        {resetBlocked !== null && <span className="action-reason">{resetBlocked}</span>}
        {resetBlocked === null && <span className="action-reason">everything downstream of the step goes back to pending</span>}
      </div>
      )}

      {error !== null && <p className="error-line">{error}</p>}
    </section>
  );
}

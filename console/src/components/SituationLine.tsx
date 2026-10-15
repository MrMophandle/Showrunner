import { Link } from "react-router-dom";
import type { Situation } from "../projections.js";

/** The one status area: whether the system is working or waiting on the showrunner, and what for.
 *
 *  **Ryan's ruling of 2026-10-15.** The Run view had shown "resumed — a worker is on it" beside an
 *  open script gate: a notice left over from a POST that had been true for one second. One area,
 *  on the Run view and on the Board's row, that always says who holds the ball and on what — and
 *  because every word of it is derived from the view the page has just fetched (`runSituation`,
 *  `src/projections.ts`), it changes the moment the state does and there is nothing left to go
 *  stale.
 *
 *  **It renders and judges nothing.** The subject, the sentence and the name of the move are the
 *  projection's; whether the move may be offered is the caller's, because that is a question about
 *  the show and not about the run — the Run page offers the two POSTs only where it can act
 *  (`canAct`, ruling H-03), offers the open gate everywhere because that one is a GET, and the
 *  Board offers none of them because the row's own action button is unchanged. A component that
 *  read `canAct` itself would be a second place for that rule to be slightly different.
 *
 *  The amber comes from the action's presence rather than from a flag of its own: every situation
 *  that names a move is one the person reading is being asked about, and every situation that
 *  names none is one they can leave alone. */
export type SituationAction =
  /** A GET — the open gate — which is a link, so a read-only show keeps it. */
  | { label: string; href: string }
  /** A POST — resume, or the first click of continue — which is a button and can be mid-flight. */
  | { label: string; onClick: () => void; busy?: boolean };

export interface SituationLineProps {
  situation: Situation;
  /** The one primary move, when the caller is willing to offer it. Absent on the Board, on a
   *  read-only show's POSTs, and for every situation that needs nobody. */
  action?: SituationAction;
}

export function SituationLine({ situation, action }: SituationLineProps) {
  return (
    <p className={`situation${situation.action === undefined ? "" : " situation-needs"}`}>
      <strong className="situation-subject">{situation.subject}</strong>
      {situation.sentence !== "" && <span className="situation-sentence">{situation.sentence}</span>}
      {action !== undefined && ("href" in action
        ? <Link className="btn btn-primary" to={action.href}>{action.label}</Link>
        : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={action.busy === true}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
    </p>
  );
}

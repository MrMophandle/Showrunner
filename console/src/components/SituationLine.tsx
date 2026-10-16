import { Link } from "react-router-dom";
import type { RunStatus } from "../../shared/types.js";
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
 *  **The box comes from the action's presence and the colour from the run's status**, which are two
 *  different questions and are kept apart. Every situation that names a move is one the person
 *  reading is being asked about, so it is drawn as a bordered box and every other one is a plain
 *  line. The colour says *how bad* it is, and the line is where it now lives: the Run view's stage
 *  altitude used to carry a `chip chip-<status>` with five distinct colours, and collapsing
 *  waiting, failed and crashed into the one subject "Needs you." would otherwise have left one
 *  undifferentiated amber for an open gate, a crash and a failure (the review of `b912b3b`,
 *  finding 2). The border is `currentColor`, so the box takes the status's own colour: red for a
 *  failed run, amber for an open gate.
 *
 *  The status is a prop rather than something the projection carries, because a colour is a fact
 *  about this console's stylesheet and `runSituation` is the vocabulary — a projection that
 *  returned class names would be a judgment about the Board's palette made in a pure function that
 *  two surfaces share. */
export type SituationAction =
  /** A GET — the open gate — which is a link, so a read-only show keeps it. */
  | { label: string; href: string }
  /** A POST — resume, or the first click of continue — which is a button and can be mid-flight. */
  | { label: string; onClick: () => void; busy?: boolean };

/** The class each run status draws the line in, mirroring the `chip-<status>` colours the Run
 *  view's stage box carried before 2026-10-15: amber for a gate (`--needs`), red for a failure or
 *  a crash (`--danger`), blue for work in flight (`--draft`), green for a finished run
 *  (`--approved`), and nothing at all for an episode that has never run — whose line the Board does
 *  not draw and the Run view draws in the body colour.
 *
 *  A complete `Record` and not a `Partial` one, for the reason `PANEL_BY_STATE` is
 *  (`src/projections.ts`): an eighth `RunStatus` must fail to compile here rather than quietly
 *  render a colourless line. */
const CLASS_BY_STATUS: Record<RunStatus, string> = {
  waiting: "situation-needs-you",
  failed: "situation-failed",
  crashed: "situation-failed",
  running: "situation-working",
  completed: "situation-done",
  archived: "situation-done",
  none: "",
};

export interface SituationLineProps {
  situation: Situation;
  /** The run's own status, which decides the line's colour and nothing else. */
  status: RunStatus;
  /** The one primary move, when the caller is willing to offer it. Absent on the Board, on a
   *  read-only show's POSTs, and for every situation that needs nobody. */
  action?: SituationAction;
}

export function SituationLine({ situation, status, action }: SituationLineProps) {
  const classes = ["situation", CLASS_BY_STATUS[status], situation.action === undefined ? "" : "situation-needs"];
  return (
    <p className={classes.filter((c) => c !== "").join(" ")}>
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

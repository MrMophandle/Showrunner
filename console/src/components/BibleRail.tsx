import { Link } from "react-router-dom";
import type { BibleRow } from "../../shared/types.js";
import { bibleHref } from "../api.js";
import { bibleChipClass } from "../projections.js";

/** The rail of the Bible page: the fifteen files `BIBLE_FILES` names, in interview order, each
 *  with where it stands.
 *
 *  **Fifteen rows and not thirteen.** The two scaffold files (`continuity-ledger`,
 *  `voice-registry`) are drawn with the rest because they are part of the bible the operator is
 *  looking at; what they cannot do — be interviewed, be run, hold answers — is said on the row and
 *  refused by the server's POSTs. A rail that drew only the gated thirteen would leave the author
 *  wondering where the other two files came from the first time the pipeline wrote one.
 *
 *  The order is the server's (`engine/src/bible.ts`'s `BIBLE_FILES`, "the order an author can think
 *  in") and is never re-sorted here: an author part-way through a setup reads the rail as a queue,
 *  and a rail that sorted by state would move the row they are working on every time it changed.
 *
 *  The state chips are the Board's own colours through `bibleChipClass`, so one console does not
 *  mean two things by amber. */
export interface BibleRailProps {
  showKey: string;
  rows: BibleRow[] | null;
  /** The file whose panel is open, so the rail can mark it. Absent on `/shows/:show/bible`. */
  selected?: string | undefined;
}

export function BibleRail({ showKey, rows, selected }: BibleRailProps) {
  return (
    <ul className="bible-rail">
      {(rows ?? []).map((row) => (
        <li
          key={row.key}
          className={`bible-row bible-row-${row.state}${row.key === selected ? " bible-row-open" : ""}`}
        >
          <Link className="bible-row-link link-plain" to={bibleHref(showKey, row.key)}>
            <div className="bible-row-head">
              <span className="mono bible-row-key">{row.key}</span>
              <span className={bibleChipClass(row.state)}>{row.state}</span>
            </div>
            <div className="bible-row-purpose quiet">{row.purpose}</div>
            <div className="bible-row-meta quiet mono">
              {row.mode === "scaffold"
                ? "the pipeline writes this one"
                : row.mode === "default"
                  ? "a house template, yours to keep or replace"
                  : `${row.answered} of ${row.questions} answered`}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

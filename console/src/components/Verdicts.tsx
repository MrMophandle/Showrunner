import { useState } from "react";

/** The verdict board: one chip per reviewer whose result the run recorded, pass or fail, with the
 *  number of issues it raised. Ported in spirit from console v1's `VerdictBoard`, including the
 *  part that made it useful — clicking an issue quotes it into the notes field, so a rejection
 *  can be written out of what the reviewers already said instead of retyped.
 *
 *  The server decides what counts as a verdict, structurally: any step result that is an object
 *  carrying a `pass` field (`server/gates.ts`'s `isVerdict`). That means this component is handed
 *  whatever the show's schemas produce, which is why every field below is read defensively: an
 *  issue list may be strings, may be objects, and may not be there at all. */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One issue as a line of text. A reviewer's schema is the show's, not the engine's: an issue is
 *  a string in some schemas and an object with a note and a line number in others, and a verdict
 *  whose issues were silently dropped because they were the wrong shape would be the worst kind
 *  of empty-looking chip. */
export function issueText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
  if (isRecord(entry)) {
    for (const key of ["issue", "note", "message", "text", "problem", "detail"]) {
      const value = entry[key];
      if (typeof value === "string" && value !== "") {
        const where = entry["line"] ?? entry["scene"] ?? entry["shot"] ?? entry["id"];
        return where === undefined ? value : `${String(where)}: ${value}`;
      }
    }
  }
  return JSON.stringify(entry);
}

/** What one verdict says, read out of whatever shape it arrived in. */
export function readVerdict(value: unknown): { pass: boolean; issues: string[] } {
  if (!isRecord(value)) return { pass: false, issues: [] };
  const raw = value["issues"] ?? value["problems"] ?? value["findings"];
  const issues = Array.isArray(raw) ? raw.map(issueText) : [];
  return { pass: value["pass"] === true, issues };
}

export interface VerdictsProps {
  verdicts: Record<string, unknown>;
  /** Called with one issue's text when the operator clicks it: the Gate page appends it to the
   *  notes field. Absent on a page with no notes field to quote into. */
  onQuote?: (text: string) => void;
}

export function Verdicts({ verdicts, onQuote }: VerdictsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const ids = Object.keys(verdicts).sort();
  if (ids.length === 0) return <p className="quiet">no verdicts in this run's log — nothing has reviewed this yet</p>;

  return (
    <div className="verdicts">
      <div className="verdict-chips">
        {ids.map((id) => {
          const { pass, issues } = readVerdict(verdicts[id]);
          return (
            <button
              type="button"
              key={id}
              className={`verdict-chip ${pass ? "verdict-pass" : "verdict-fail"}${open === id ? " verdict-open" : ""}`}
              aria-expanded={open === id}
              onClick={() => { setOpen((current) => (current === id ? null : id)); }}
            >
              <span className="verdict-name mono">{id}</span>
              <span className="verdict-mark">{pass ? "pass" : "fail"}</span>
              {issues.length > 0 && <span className="verdict-count">{issues.length} {issues.length === 1 ? "issue" : "issues"}</span>}
            </button>
          );
        })}
      </div>
      {open !== null && (
        <div className="verdict-detail">
          <div className="verdict-detail-head mono">{open}</div>
          {readVerdict(verdicts[open]).issues.length === 0
            ? <p className="quiet">this reviewer listed no issues</p>
            : (
              <ul className="verdict-issues">
                {readVerdict(verdicts[open]).issues.map((issue, i) => (
                  <li key={i}>
                    <span>{issue}</span>
                    {onQuote !== undefined && (
                      <button type="button" className="btn btn-quote" onClick={() => { onQuote(issue); }}>quote</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          <details className="verdict-raw">
            <summary>the whole result, as the step recorded it</summary>
            <pre className="mono">{JSON.stringify(verdicts[open], null, 2)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

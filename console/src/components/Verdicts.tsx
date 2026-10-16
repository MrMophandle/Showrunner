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

/** What one verdict says, read out of whatever shape it arrived in: whether it passed, the issues
 *  that fail it, the notes that fail nothing, and the ids it recorded as closed.
 *
 *  **The last two are here because a panel can go green by capitulation and nothing used to say so**
 *  (the whole-branch review of 2026-10-15). The script gate opens only on a green panel, and the one
 *  way a green can be false is the writer declaring every issue a deliberate exception: the
 *  reviewers' close rule is unconditional, so a listed id goes in `prior.resolved` and out of
 *  `issues`, and a board that read only `issues` drew seven `pass · 0 issues` chips over a script
 *  nothing had fixed. `notes` is the other half: Plan J created that field and moved the
 *  non-blocking findings into it — on the one measured panel, 8 of one reviewer's 15 findings and
 *  all 5 of another's — and before this it was read by the writer and by no human surface, where the
 *  pre-Plan-J gate message had interpolated every one of them.
 *
 *  Every field is read defensively, because the shape is the show's and not the engine's
 *  (`server/gates.ts`'s `isVerdict` admits any object carrying a `pass`): an absent key, a key that
 *  is not an array, and an id that is not a string each read as nothing rather than throwing on a
 *  page the showrunner is deciding at. */
export function readVerdict(value: unknown): { pass: boolean; issues: string[]; notes: string[]; resolved: string[] } {
  if (!isRecord(value)) return { pass: false, issues: [], notes: [], resolved: [] };
  const raw = value["issues"] ?? value["problems"] ?? value["findings"];
  const issues = Array.isArray(raw) ? raw.map(issueText) : [];
  const rawNotes = value["notes"];
  const notes = Array.isArray(rawNotes) ? rawNotes.map(issueText) : [];
  const prior = value["prior"];
  const rawResolved = isRecord(prior) ? prior["resolved"] : undefined;
  const resolved = Array.isArray(rawResolved) ? rawResolved.filter((id): id is string => typeof id === "string") : [];
  return { pass: value["pass"] === true, issues, notes, resolved };
}

/** The chip's counts as one line: `0 issues · 3 notes`, and `0 issues` for a verdict with nothing
 *  beside its issues.
 *
 *  **The issue count prints at zero**, which it did not before. On a verdict with notes the zero is
 *  the whole point — `pass · 0 issues · 3 notes` is a reviewer that found things and blocked on
 *  none, which is a different fact from a reviewer that found nothing — and a count that vanished at
 *  zero made those two chips identical. */
function countText(issues: number, notes: number): string {
  const head = `${issues} ${issues === 1 ? "issue" : "issues"}`;
  return notes === 0 ? head : `${head} · ${notes} ${notes === 1 ? "note" : "notes"}`;
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
          const { pass, issues, notes } = readVerdict(verdicts[id]);
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
              <span className="verdict-count">{countText(issues.length, notes.length)}</span>
            </button>
          );
        })}
      </div>
      {open !== null && <VerdictDetail id={open} value={verdicts[open]} {...(onQuote !== undefined ? { onQuote } : {})} />}
    </div>
  );
}

/** One opened chip's detail: the issues that fail the verdict, the notes that fail nothing, and the
 *  ids this reviewer recorded as closed, then the whole result as the step wrote it.
 *
 *  A component of its own rather than a block inside `Verdicts` so that the verdict is read **once**
 *  — the version this replaced called `readVerdict` three times for one open chip — and so that the
 *  three lists are written beside each other, which is how the showrunner reads them: the issues are
 *  what blocks, the notes are what the reviewer would have said if it could, and a closed id is a
 *  finding that left the board without being fixed in the text. `quote` stays on the issues alone,
 *  because the notes field fails nothing and quoting one into a rejection would make it look as
 *  though it had. */
function VerdictDetail({ id, value, onQuote }: { id: string; value: unknown; onQuote?: (text: string) => void }) {
  const { issues, notes, resolved } = readVerdict(value);
  return (
    <div className="verdict-detail">
      <div className="verdict-detail-head mono">{id}</div>
      {issues.length === 0
        ? <p className="quiet">this reviewer listed no issues</p>
        : (
          <ul className="verdict-issues">
            {issues.map((issue, i) => (
              <li key={i}>
                <span>{issue}</span>
                {onQuote !== undefined && (
                  <button type="button" className="btn btn-quote" onClick={() => { onQuote(issue); }}>quote</button>
                )}
              </li>
            ))}
          </ul>
        )}
      {notes.length > 0 && (
        <>
          <p className="verdict-detail-sub">{notes.length === 1 ? "one note" : `${notes.length} notes`}, which fail nothing:</p>
          <ul className="verdict-notes">
            {notes.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        </>
      )}
      {resolved.length > 0 && (
        <p className="verdict-closed">
          closed this round: <span className="mono">{resolved.join(", ")}</span>
        </p>
      )}
      <details className="verdict-raw">
        <summary>the whole result, as the step recorded it</summary>
        <pre className="mono">{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}

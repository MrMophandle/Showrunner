import { useState } from "react";
import { AutoTextarea } from "./AutoTextarea.js";
import { Markdown } from "./Markdown.js";
import { GATE_BUTTONS, type GateChoiceKey } from "../projections.js";

/** One bible file's gate: the question the engine is asking, the whole file it is asking about, and
 *  the four answers the terminal offers.
 *
 *  **The file is shown whole, not linked to.** `tools/src/init/main.ts` records why for the
 *  terminal — "a bible file at its gate is printed whole … a pager would put the decision behind a
 *  program" — and the same holds here: the decision is about this file, and a panel that made the
 *  author click through to read it would be a panel that teaches them to approve without reading.
 *  The raw toggle is beside it because a bible file is Markdown that will be read by prompts as
 *  text, and its headings are what `bible-check` looks for.
 *
 *  **`expectedAttempt` is why this component takes the attempt as a prop and never derives it.**
 *  The author answers the attempt they *read*; the answer carries that number back, and the engine
 *  refuses an answer written against a message a rejection has since superseded ("gate … is open at
 *  attempt 2, not 1"). So the number on the screen and the number in the body must be the same one,
 *  which they are only if nothing recomputes it.
 *
 *  **Approve is disabled until the file has been read off disk.** `content` is `undefined` when the
 *  server could not read the file — it is written by the writer agent, so a gate can be open on a
 *  file that was never written — and approving a file nobody can see is the one answer of the four
 *  that cannot be taken back. The other three stay available, because each of them is a way out of
 *  exactly that state. */
export interface GatePanelProps {
  /** The gate's rendered message, from the run's `gate_opened` event. */
  message: string;
  /** The attempt the gate is open at, which the answer carries back as `expectedAttempt`. */
  attempt: number;
  /** How many attempts the gate allows before the run fails `rejected <n> times`, from the run
   *  view's `maxAttempts` — which reads it off the pipeline's own gate step.
   *
   *  A prop and not a literal. This panel drew "attempt 1 of 10" with the 10 typed into it, which
   *  is a number that goes on being drawn after the engine's has changed; the Gate page for an
   *  episode already took it from the server for the same reason. Absent when the gate declares no
   *  cap, which the panel says rather than implying an unbounded gate has one. */
  maxAttempts?: number | undefined;
  /** The file's text, or undefined when the server could not read it. */
  content: string | undefined;
  /** The file's path relative to the show root, as the label above it. */
  fileRel: string;
  /** `GET …/bible/:key/file` — the raw bytes, as a link and never as a second fetch: `content`
   *  above already carries them, and one address the operator can open or save is worth more than a
   *  duplicate read. */
  rawUrl: string;
  /** False on a read-only show, where the server answers 403 to the gate route. */
  canAct: boolean;
  onAnswer: (answer: { choice: GateChoiceKey; notes?: string; importPath?: string }) => void;
  /** Which answer is in flight, if any. */
  busy?: GateChoiceKey | null | undefined;
  /** What the server said about the last answer, verbatim. */
  error?: string | null | undefined;
  /** Set when the engine refused an answer because the gate had moved to a later attempt. */
  moved?: string | null | undefined;
  /** Set when this file's log grew while the gate was being read. A banner and not a refetch: see
   *  the `expectedAttempt` paragraph above. */
  changed?: boolean | undefined;
  onReload?: (() => void) | undefined;
  /** One line in place of the four buttons on a read-only show. */
  readOnlyNote?: string | undefined;
}

export function GatePanel({
  message, attempt, maxAttempts, content, fileRel, rawUrl, canAct, onAnswer,
  busy = null, error = null, moved = null, changed = false, onReload, readOnlyNote,
}: GatePanelProps) {
  const [notes, setNotes] = useState("");
  const [importPath, setImportPath] = useState("");
  const [raw, setRaw] = useState(false);

  /** Whether one of the four buttons may be pressed: the show is writable, nothing is in flight,
   *  and the answer's own field is filled in. The server refuses a rejection with blank notes (400)
   *  and an empty import path, and a button that is offered and then refused teaches the operator
   *  that the console has a move it does not have. */
  function enabled(choice: GateChoiceKey): boolean {
    if (!canAct || busy !== null) return false;
    if (choice === "approve") return content !== undefined;
    if (choice === "reject") return notes.trim() !== "";
    if (choice === "import") return importPath.trim() !== "";
    return true;
  }

  return (
    <section className="bible-gate">
      <div className="gate-head">
        <h2>the gate</h2>
        <div className="gate-meta mono">
          attempt {attempt}{maxAttempts !== undefined ? ` of ${maxAttempts}` : " (no cap)"}
        </div>
      </div>

      {moved !== null && moved !== undefined && (
        <div className="banner banner-amber">
          <strong>{moved}</strong>
          <span> Your answer was refused, not applied.</span>
        </div>
      )}
      {changed === true && (moved === null || moved === undefined) && (
        <div className="banner">
          <span>this file has written to its log since you opened the gate — the message here is still attempt {attempt}</span>
          {onReload !== undefined && (
            <button type="button" className="btn btn-small" onClick={onReload}>reload the gate</button>
          )}
        </div>
      )}

      <Markdown text={message} className="pane" />

      <div className="bible-file-head">
        <h2>{fileRel}</h2>
        <button type="button" className="btn btn-small" onClick={() => { setRaw((r) => !r); }}>
          {raw ? "rendered" : "raw"}
        </button>
        <a className="btn btn-small" href={rawUrl}>open the file</a>
      </div>
      {content === undefined && (
        <p className="error-line">
          this file could not be read, so there is nothing to approve — reject it with notes, import one you already
          have, or take it over yourself
        </p>
      )}
      {content !== undefined && (raw
        ? <pre className="pane pane-tall mono">{content}</pre>
        : <Markdown text={content} className="pane pane-tall" />)}

      <h2>your answer</h2>
      {!canAct && readOnlyNote !== undefined && <p className="action-reason">{readOnlyNote}</p>}

      {canAct && (
        <>
          <label htmlFor="bible-gate-notes">notes — what the writer should change</label>
          <AutoTextarea
            id="bible-gate-notes"
            value={notes}
            onChange={setNotes}
            placeholder="what is wrong with this file, in the words the writer should act on. Required to reject."
            rows={4}
          />

          <label htmlFor="bible-gate-import">a file to import over this one</label>
          <input
            id="bible-gate-import"
            className="mono bible-import"
            value={importPath}
            onChange={(e) => { setImportPath(e.target.value); }}
            placeholder="/Users/you/Documents/world-overview.md"
            autoComplete="off"
          />

          <div className="bible-gate-buttons">
            {GATE_BUTTONS.map((choice) => (
              <button
                key={choice.key}
                type="button"
                className={`btn btn-big${choice.key === "approve" ? " btn-primary" : ""}${choice.key === "reject" ? " btn-danger" : ""}`}
                disabled={!enabled(choice.key)}
                onClick={() => {
                  onAnswer({
                    choice: choice.key,
                    ...(choice.key === "reject" ? { notes } : {}),
                    ...(choice.key === "import" ? { importPath: importPath.trim() } : {}),
                  });
                }}
              >
                {busy === choice.key ? "answering…" : choice.label}
              </button>
            ))}
          </div>
          {content === undefined && <p className="action-reason">Approve is not offered for a file that could not be read.</p>}
          {notes.trim() === "" && <p className="action-reason">a rejection needs notes — the writer has nothing else to go on</p>}
          {importPath.trim() === "" && <p className="action-reason">an import needs a path — it is copied over the file and the gate is approved</p>}
        </>
      )}

      {error !== null && error !== undefined && <p className="error-line">{error}</p>}
    </section>
  );
}

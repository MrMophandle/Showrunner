import { useState } from "react";
import type { BibleFileView } from "../../shared/types.js";
import { AutoTextarea } from "./AutoTextarea.js";
import { answersDirty } from "../projections.js";

/** One bible file's questions as a form: one textarea per question the canon template asks,
 *  prefilled with whatever is on disk.
 *
 *  **The answers are the writer's input, and they are read off disk by a process that starts
 *  twenty minutes of work.** So the two buttons are not two ways of doing one thing. "Save answers"
 *  writes them and nothing else, which is what makes a tab safe to close (ruling H-06: the Bible
 *  page is the resume, and it needs no new persistence because every answer is on disk the moment
 *  it is saved). "Write it" saves them **first** when the form is dirty and then starts the run, so
 *  the writer cannot be started against answers that are still sitting in a textarea — the terminal
 *  writes every answer the moment it is given (`tools/src/init/interview.ts`'s `record()`), and a
 *  browser that did not would be the one way this surface is worse.
 *
 *  **A file with no questions renders no textareas and no "Save answers".** The three `default`
 *  files (`story-craft`, `pipeline-artifacts`, `readme`) are a house template and a gate over it:
 *  `POST bible/:key/answers` answers 409 for them ("`<key>` asks no questions"), and
 *  `POST bible/:key/runs` writes the template before it opens the gate. So the only move is "Write
 *  it", and the line above it says what that will do.
 *
 *  The component is remounted per file by its caller (`key={view.key}`), which is what keeps the
 *  drafts of two files from mixing: the state here is the author's typing, and it must not survive
 *  a navigation to another row. */
export interface QuestionFormProps {
  view: BibleFileView;
  /** False on a read-only show, where the server answers 403 to both of these POSTs. */
  canAct: boolean;
  /** Set while one of the two posts is in flight, which is also what disables both buttons. */
  busy: "save" | "write" | null;
  /** Writes the answers and nothing else. */
  onSave: (answers: Record<string, string>) => void;
  /** Saves them when they are dirty, then starts the file's run. */
  onWrite: (answers: Record<string, string>) => void;
  /** One line in place of the buttons on a read-only show. */
  readOnlyNote?: string | undefined;
}

export function QuestionForm({ view, canAct, busy, onSave, onWrite, readOnlyNote }: QuestionFormProps) {
  const initial: Record<string, string> = {};
  for (const q of view.questionsList) initial[q.heading] = q.answer;

  const [answers, setAnswers] = useState<Record<string, string>>(initial);
  // What is on disk, as far as this form knows: the view's own answers at mount, then whatever a
  // save posted. Held here rather than re-read from `view`, because the view is refetched while
  // this form is open and a refetch must not discard what the author has typed since.
  const [saved, setSaved] = useState<Record<string, string>>(initial);
  const dirty = answersDirty(saved, answers);
  const asks = view.questionsList.length > 0;

  function save(): void {
    onSave(answers);
    setSaved(answers);
  }

  return (
    <section className="bible-questions">
      <p className="bible-purpose">{view.purpose}</p>

      {asks && view.prior && (
        <p className="action-reason">
          {view.answered} of {view.questions} of these were answered in an earlier sitting and are prefilled from{" "}
          <span className="mono">answers.md</span>. Editing one and saving replaces it; the rest keep what they had.
        </p>
      )}

      {!asks && (
        <p className="quiet">
          This file asks nothing: it is a <span className="mono">{view.mode}</span> file with a house template, and its
          gate is the file itself. "Write it" writes the template over <span className="mono">{view.file}</span> if it is
          not there yet and opens the gate on it, where you can approve it, replace it with one of your own, or import
          one you already have.
        </p>
      )}

      {view.questionsList.map((q, i) => (
        <div className="bible-question" key={q.heading}>
          <label htmlFor={`answer-${i}`}>
            <span className="bible-question-heading mono">{q.heading}</span>
            <span className="bible-question-text">{q.question}</span>
          </label>
          <AutoTextarea
            id={`answer-${i}`}
            value={answers[q.heading] ?? ""}
            onChange={(value) => { setAnswers((current) => ({ ...current, [q.heading]: value })); }}
            rows={4}
          />
        </div>
      ))}

      <div className="action-row">
        {!canAct && readOnlyNote !== undefined && <span className="action-reason">{readOnlyNote}</span>}
        {canAct && asks && (
          <button
            type="button"
            className="btn"
            disabled={busy !== null || !dirty}
            onClick={save}
          >
            {busy === "save" ? "saving…" : "Save answers"}
          </button>
        )}
        {canAct && (
          <button
            type="button"
            className="btn btn-primary btn-big"
            disabled={busy !== null}
            onClick={() => { onWrite(answers); }}
          >
            {busy === "write" ? "starting the writer…" : "Write it"}
          </button>
        )}
        {canAct && dirty && (
          <span className="action-reason">unsaved — "Write it" saves them before it starts the writer</span>
        )}
        {canAct && asks && !dirty && view.answered === 0 && (
          <span className="action-reason">
            nothing is answered yet; the writer reads the answers file, so a blank one gets you a file of headings
          </span>
        )}
      </div>
    </section>
  );
}

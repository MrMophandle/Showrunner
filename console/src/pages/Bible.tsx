import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { BibleFileView, BibleRow, SetupRunView } from "../../shared/types.js";
import {
  ApiError, biblePath, post, showHref, showPath, useApi, useCoalesced, useConsole, useNow, useSSE,
  useShowKey,
} from "../api.js";
import {
  bibleFinishable, biblePanelFor, elapsed, readOnlyLine, showLabel, type GateChoiceKey,
} from "../projections.js";
import { BibleRail } from "../components/BibleRail.js";
import { GatePanel } from "../components/GatePanel.js";
import { Markdown } from "../components/Markdown.js";
import { QuestionForm } from "../components/QuestionForm.js";

/** The Bible page: the show's fifteen bible files as a rail, one file's panel beside it, and the
 *  Finish panel once every gated file is approved.
 *
 *  **This is the interview, in the browser.** The terminal's `showrunner-init` holds one process
 *  open for the hour the thirteen gated files take; this page holds nothing open at all. Each file's
 *  questions are a form whose answers land on disk the moment they are saved, each file's writing
 *  runs in a detached setup worker exactly as an episode step does (ruling H-04), and each gate is
 *  answered with the four answers the terminal offers. Closing the tab loses nothing and a second
 *  visit continues: the state of every row is derived from the answers file, the latest run log and
 *  the lock, and from nothing this page remembers (ruling H-06).
 *
 *  **Two routes, one component.** `/shows/:show/bible` is the rail and the Finish panel;
 *  `/shows/:show/bible/:key` is the same rail with that file's panel beside it. The rail stays
 *  mounted across a navigation between files, which is what makes the fifteen rows a queue the
 *  author works down rather than a page they keep going back to.
 *
 *  **How this page reads the live channel, and the one place it refuses to.** A `setup` notice
 *  carries `{show, key, runId, offset}`; this page drops every notice for another show, refetches
 *  the rail on all the rest (any file's run changes some row, and the rail is one request), and
 *  refetches the open file only for its own key — **except while that file's panel is showing a
 *  gate, where a notice raises a banner and changes nothing.** That exception is
 *  `console/src/pages/Gate.tsx`'s rule and it exists for `expectedAttempt`: the author answers the
 *  attempt they read, and a page that quietly swapped in a new message would defeat the protection
 *  in the one case it exists for — a rejection that landed in another tab, after which an "approve"
 *  would be approving prose nobody read.
 *
 *  **A read-only show renders every panel's content and none of its buttons**, with one line naming
 *  the key in their place: the server answers 403 to every POST to such a show, and the retired
 *  first repository's thirteen imported bible files are exactly what reading this page is for. */

/** What `POST bible/finish` answers: `tools/src/init/init.ts`'s `FinishResult` with the lines the
 *  phase would have printed to a terminal collected beside it.
 *
 *  Declared here rather than imported from `@showrunner/tools`, for the reason `showSlugFrom`
 *  records in `projections.ts`: that package's modules import `node:fs/promises` and the engine, and
 *  the client must not pull either into its bundle. Five fields, and the route is the only thing
 *  that answers them. */
interface FinishReport {
  stalled: string[];
  remote?: string;
  nextSteps: string;
  bibleCheck: { missingFiles: string[]; missingSections: { file: string; heading: string }[] };
  said: string[];
}

/** What is in flight, which is also what disables every button on the page: the two writes of the
 *  question form, one of the gate's four answers, a "start again", or the finish. */
type Busy = "save" | "write" | "finish" | GateChoiceKey | null;

/** The setup run's steps while the writer is working — one or two of them (`write` then `gate` for
 *  an interviewed file, the gate alone for a default one), with the elapsed time beside them.
 *
 *  The sentence is not decoration. A bible file's `write` step is declared with a twenty-minute
 *  timeout (`engine/src/pipelines/bible.ts`) and the one measured sample cost $2.24; an author who
 *  reads a spinner for four minutes and then reloads the page, or worse starts the file again, is
 *  the failure this panel exists to prevent. It says the number out loud. */
function RunningPanel({ run, now }: { run: SetupRunView | undefined; now: number }) {
  const startedAt = run?.steps.find((s) => s.startedAt !== undefined)?.startedAt;
  return (
    <section className="bible-running">
      <h2>the writer is working</h2>
      <p className="quiet">
        the writer is working; a file takes minutes, not seconds — up to twenty for one file, and this page keeps up with
        it on its own. You can close the tab: the run is a detached worker and nothing here is holding it.
      </p>
      <div className="bible-run-meta mono quiet">
        {run === undefined ? "no run" : `${run.runId} · ${run.status} · ${elapsed(startedAt, now)} elapsed`}
      </div>
      <ul className="rail-steps">
        {(run?.steps ?? []).map((step) => (
          <li className={`rail-step rail-${step.status}`} key={step.id}>
            <div className="rail-line">
              <span className={`rail-dot rail-dot-${step.status}`} />
              <span className="mono rail-id">{step.id}</span>
              <span className="rail-status">{step.status}</span>
              {step.startedAt !== undefined && (
                <span className="rail-timing">started {step.startedAt.slice(11, 19)} · {elapsed(step.startedAt, now)}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {run?.error !== undefined && <p className="error-line">{run.error}</p>}
    </section>
  );
}

/** One bible file, read-only: the finished file and the note that says which of the three ways it
 *  was approved.
 *
 *  The three are told apart on the server by the notes on the approving `gate_answered` — nothing,
 *  "imported from <path>", or "the author writes this file" — so a file approved from the terminal
 *  reads the same here as one approved from the browser. The note is the state's own sentence
 *  because "approved" alone does not tell the author whether the writer wrote this file or whether
 *  they still owe it a draft, and for `written-by-author` they do. */
function ApprovedPanel({ view, rawUrl }: { view: BibleFileView; rawUrl: string }) {
  const [raw, setRaw] = useState(false);
  const note = view.state === "imported"
    ? "imported: a file you already had was copied over this one, and its gate was approved with that path in the log."
    : view.state === "written-by-author"
      ? "you took this one over: the empty template was written over it and approved, so the headings the prompts read by name are there and the prose is yours to write."
      : "approved as the writer wrote it.";
  return (
    <section className="bible-approved">
      <div className="bible-file-head">
        <h2>{view.file}</h2>
        <span className="chip chip-approved">{view.state}</span>
        <button type="button" className="btn btn-small" onClick={() => { setRaw((r) => !r); }}>
          {raw ? "rendered" : "raw"}
        </button>
        <a className="btn btn-small" href={rawUrl}>open the file</a>
      </div>
      <p className="quiet">{note}</p>
      {view.content === undefined
        ? <p className="error-line">this file is approved in its log but could not be read off disk now</p>
        : raw
          ? <pre className="pane pane-tall mono">{view.content}</pre>
          : <Markdown text={view.content} className="pane pane-tall" />}
    </section>
  );
}

/** A bible file whose last run ended badly, with the reason and the one move the server will take.
 *
 *  `stalled` and `failed` are two different stories and the panel tells them apart. A stall is the
 *  gate rejected its ten times: the file on disk is the writer's last revision and the author can
 *  finish it by hand or start the writer again with better answers. A failure is the writer agent
 *  failing or the run crashing with no worker holding its lock, which is a run to start again
 *  rather than a file to finish. */
function TroublePanel(
  { view, canAct, busy, onStart, readOnlyNote }:
  { view: BibleFileView; canAct: boolean; busy: Busy; onStart: () => void; readOnlyNote: string },
) {
  return (
    <section className="bible-trouble">
      <h2>{view.state === "stalled" ? "this file's gate ran out of attempts" : "this file's last run ended badly"}</h2>
      {view.state === "stalled" && (
        <p className="quiet">
          The gate was rejected its ten times and the run gave up. <span className="mono">{view.file}</span> on disk is
          the last revision the writer made: finish it by hand, import one you already have, or answer the questions
          differently and start the writer again.
        </p>
      )}
      {view.state === "failed" && (
        <p className="error-line">
          {view.run?.error ?? (view.run?.status === "crashed"
            ? "the run's log stops mid-step with no worker holding its lock — the worker died"
            : "this file's latest run did not finish and recorded no error")}
        </p>
      )}
      <div className="bible-run-meta mono quiet">
        {view.runId === undefined ? "no run" : `${view.runId} · ${view.run?.status ?? "unknown"}`}
      </div>
      <div className="action-row">
        {!canAct && <span className="action-reason">{readOnlyNote}</span>}
        {canAct && (
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={onStart}>
            {busy === "write" ? "starting…" : "start again"}
          </button>
        )}
      </div>
      {view.content !== undefined && <Markdown text={view.content} className="pane pane-tall" />}
    </section>
  );
}

/** A scaffold file: the two the pipeline fills. There is nothing to interview and no run to start,
 *  which is what this panel says instead of offering a form the server would refuse.
 *
 *  `continuity-ledger` is written by the propose step as episodes are made, and `voice-registry` is
 *  prose beside `Production/voice-refs/refs.json`, which is the source of truth for the voices. Both
 *  rows read `pending` for the life of the show, because nothing ever writes a setup log for them. */
function ScaffoldPanel({ view, rawUrl }: { view: BibleFileView; rawUrl: string }) {
  const [raw, setRaw] = useState(false);
  return (
    <section className="bible-scaffold">
      <div className="bible-file-head">
        <h2>{view.file}</h2>
        <span className="chip chip-none">the pipeline writes this one</span>
        <button type="button" className="btn btn-small" onClick={() => { setRaw((r) => !r); }}>
          {raw ? "rendered" : "raw"}
        </button>
        <a className="btn btn-small" href={rawUrl}>open the file</a>
      </div>
      <p className="quiet">
        {view.purpose} There is nothing to interview here and no run to start: the episode pipeline writes this file as
        it goes, which is why its row stays <span className="mono">pending</span> for the life of the show.
      </p>
      {view.content === undefined
        ? <p className="quiet">not written yet</p>
        : raw
          ? <pre className="pane pane-tall mono">{view.content}</pre>
          : <Markdown text={view.content} className="pane pane-tall" />}
    </section>
  );
}

/** The end of a setup: the bible-check report, the GitHub choice, and the next steps out of the
 *  show's own README.
 *
 *  **Shown only when every gated file is approved** (`bibleFinishable`), which is also the server's
 *  own condition: `POST bible/finish` answers 409 with the unapproved keys otherwise, because
 *  `initFinish` would create the GitHub repository over a half-written bible and `gh repo create
 *  --push` cannot be asked to do that twice under one name. The panel can still be one approval
 *  stale — another tab, the terminal — so the 409's own list is rendered when it comes. */
function FinishPanel(
  { canAct, busy, github, onGithub, onFinish, report, error, readOnlyNote }: {
    canAct: boolean; busy: Busy; github: "private" | "public" | "none";
    onGithub: (value: "private" | "public" | "none") => void; onFinish: () => void;
    report: FinishReport | null; error: string | null; readOnlyNote: string;
  },
) {
  const check = report?.bibleCheck;
  return (
    <section className="bible-finish">
      <h2>every gated file is approved</h2>
      <p className="quiet">
        Finishing runs the bible check over the whole repository, creates the GitHub repository if you asked for one, and
        reads the next steps back out of the show's own README.
      </p>
      {report === null && (
        <>
          <fieldset className="new-show-github">
            <legend>a GitHub repository</legend>
            {(["private", "public", "none"] as const).map((choice) => (
              <label key={choice} className="new-show-radio">
                <input type="radio" name="finish-github" value={choice} checked={github === choice} onChange={() => { onGithub(choice); }} />
                {choice === "none" ? "none — keep it local" : choice}
              </label>
            ))}
          </fieldset>
          <div className="action-row">
            {!canAct && <span className="action-reason">{readOnlyNote}</span>}
            {canAct && (
              <button type="button" className="btn btn-primary btn-big" disabled={busy !== null} onClick={onFinish}>
                {busy === "finish" ? "finishing…" : "Finish the setup"}
              </button>
            )}
          </div>
          {error !== null && <p className="error-line">{error}</p>}
        </>
      )}
      {report !== null && (
        <>
          <h2>the bible check</h2>
          {check !== undefined && check.missingFiles.length === 0 && check.missingSections.length === 0
            ? <p className="notice-line">every bible file is on disk and every section the prompts read by name is in it.</p>
            : (
              <>
                {(check?.missingFiles ?? []).length > 0 && (
                  <p className="error-line">files missing: <span className="mono">{(check?.missingFiles ?? []).join(", ")}</span></p>
                )}
                {(check?.missingSections ?? []).length > 0 && (
                  <ul className="row-needs">
                    {(check?.missingSections ?? []).map((miss) => (
                      <li key={`${miss.file}:${miss.heading}`}><span className="mono">{miss.file}</span> has no "{miss.heading}" section</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          {report.stalled.length > 0 && (
            <p className="error-line">stalled: <span className="mono">{report.stalled.join(", ")}</span></p>
          )}
          {report.remote !== undefined && (
            <p className="notice-line">the repository is at <a href={report.remote}>{report.remote}</a></p>
          )}
          <h2>what the setup said</h2>
          <pre className="pane mono">{report.said.join("\n")}</pre>
          <h2>your first episode</h2>
          <Markdown text={report.nextSteps} className="pane pane-tall" />
        </>
      )}
    </section>
  );
}

export function Bible() {
  const showKey = useShowKey();
  const bibleKey = useParams()["key"];
  const { show, canAct, readOnly } = useConsole();
  const now = useNow();
  const rows = useApi<BibleRow[]>(biblePath(showKey));
  const file = useApi<BibleFileView>(bibleKey === undefined ? null : biblePath(showKey, bibleKey));

  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [github, setGithub] = useState<"private" | "public" | "none">("none");
  const [report, setReport] = useState<FinishReport | null>(null);

  const refetchRows = useCoalesced(() => { rows.refetch(); }, 250);
  const refetchFile = useCoalesced(() => { file.refetch(); }, 250);

  useSSE((message) => {
    if (message.type !== "setup" || message.show !== showKey) return;
    // Every one of this show's setup notices moves some row of the rail — a lock appearing, a gate
    // opening, a run finishing — and the rail is one request for all fifteen, so it is refetched
    // for any key rather than only for the open one.
    refetchRows();
    if (bibleKey === undefined || message.key !== bibleKey) return;
    // The one refusal: see this file's header. A gate on screen is a message somebody is reading,
    // and the attempt they read is the attempt their answer will carry.
    if (file.data?.state === "gate") { setChanged(true); return; }
    refetchFile();
  });

  const readOnlyNote = readOnlyLine(showKey, "the bible is read here and interviewed where the show is writable");
  const view = file.data;
  const rawUrl = bibleKey === undefined ? "" : biblePath(showKey, bibleKey, "/file");

  function after(): void {
    file.refetch();
    rows.refetch();
  }

  async function saveAnswers(answers: Record<string, string>): Promise<void> {
    if (bibleKey === undefined) return;
    setBusy("save");
    setError(null);
    try {
      await post(biblePath(showKey, bibleKey, "/answers"), { answers });
      after();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Saves the answers and then starts the run, in that order and in one click.
   *
   *  The answers are posted first whenever the file asks anything at all — not only when the form
   *  is dirty — because the write is a merge over what is on disk and costs one request, while the
   *  failure it rules out is a twenty-minute writer run against answers the author had changed and
   *  not saved. A file that asks nothing is skipped: `POST …/answers` answers 409 for a default or
   *  scaffold file, and `POST …/runs` writes its template itself. */
  async function writeIt(answers: Record<string, string>): Promise<void> {
    if (bibleKey === undefined) return;
    setBusy("write");
    setError(null);
    try {
      if ((view?.questionsList.length ?? 0) > 0) await post(biblePath(showKey, bibleKey, "/answers"), { answers });
      await post(biblePath(showKey, bibleKey, "/runs"), {});
      after();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startAgain(): Promise<void> {
    if (bibleKey === undefined) return;
    setBusy("write");
    setError(null);
    try {
      await post(biblePath(showKey, bibleKey, "/runs"), {});
      after();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function answerGate(answer: { choice: GateChoiceKey; notes?: string; importPath?: string }): Promise<void> {
    if (bibleKey === undefined || view?.runId === undefined) return;
    const attempt = view.run?.gate?.attempt ?? view.attempt ?? 1;
    setBusy(answer.choice);
    setError(null);
    setMoved(null);
    try {
      await post(biblePath(showKey, bibleKey, `/runs/${encodeURIComponent(view.runId)}/gate`), {
        choice: answer.choice,
        notes: answer.notes ?? "",
        expectedAttempt: attempt,
        ...(answer.importPath !== undefined ? { importPath: answer.importPath } : {}),
      });
      setChanged(false);
      after();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 409 && message.includes("is open at attempt")) {
        // Somebody — a fix agent, another tab, the terminal — answered this gate while it was being
        // read, and the engine refused an answer written against the superseded message.
        const which = /is open at attempt (\d+)/.exec(message)?.[1];
        setMoved(`the gate moved to attempt ${which ?? "a later one"} — read it again`);
        setChanged(false);
        file.refetch();
      } else {
        setError(message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function finishSetup(): Promise<void> {
    setBusy("finish");
    setError(null);
    try {
      // `showPath` and not `biblePath`: `finish` is a route under the bible and not one of the
      // fifteen keys, and spelling it as a key would be a url that happens to work.
      setReport(await post<FinishReport>(showPath(showKey, "/bible/finish"), { github }));
      rows.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const finishable = bibleFinishable(rows.data);
  const gated = (rows.data ?? []).filter((row) => row.mode !== "scaffold");
  const approved = gated.filter((row) => row.state === "approved" || row.state === "imported" || row.state === "written-by-author");

  return (
    <div className="bible">
      <div className="board-head">
        <h1>{show === null ? "the bible" : `${showLabel(show)} — the bible`}</h1>
        <Link className="btn" to={showHref(showKey)}>the board</Link>
      </div>

      {rows.error !== null && <p className="error-line">could not read the bible: {rows.error}</p>}
      {rows.data === null && rows.loading && <p className="quiet">reading the bible…</p>}

      <div className="bible-layout">
        <div className="bible-rail-pane">
          <p className="quiet mono">{approved.length} of {gated.length} gated files approved</p>
          <BibleRail showKey={showKey} rows={rows.data} selected={bibleKey} />
        </div>

        <div className="bible-pane">
          {bibleKey === undefined && (
            <>
              {finishable
                ? (
                  <FinishPanel
                    canAct={canAct} busy={busy} github={github} onGithub={setGithub}
                    onFinish={() => { void finishSetup(); }} report={report} error={error}
                    readOnlyNote={readOnlyNote}
                  />
                )
                : (
                  <section className="bible-intro">
                    <h2>the bible is the show</h2>
                    <p className="quiet">
                      Fifteen files: thirteen with a gate you answer and two the pipeline writes. Open a row to read its
                      questions, save the answers, and start the writer — each file is a detached run, so you can close
                      this tab and come back to it. When every gated file is approved, the Finish panel appears here.
                    </p>
                    {readOnly && <p className="action-reason">{readOnlyNote}</p>}
                  </section>
                )}
            </>
          )}

          {bibleKey !== undefined && file.error !== null && view === null && (
            <p className="error-line">
              {file.status === 404 ? `no bible file is keyed ${bibleKey}` : file.error}
            </p>
          )}
          {bibleKey !== undefined && view === null && file.loading && <p className="quiet">reading the file…</p>}

          {view !== null && (
            <>
              <div className="bible-pane-head">
                <h2 className="mono">{view.key}</h2>
                <span className="chip chip-inline">{view.mode}</span>
              </div>

              {biblePanelFor(view) === "questions" && (
                <QuestionForm
                  key={view.key}
                  view={view}
                  canAct={canAct}
                  busy={busy === "save" || busy === "write" ? busy : null}
                  onSave={(answers) => { void saveAnswers(answers); }}
                  onWrite={(answers) => { void writeIt(answers); }}
                  readOnlyNote={readOnly ? readOnlyNote : undefined}
                />
              )}

              {biblePanelFor(view) === "running" && <RunningPanel run={view.run} now={now} />}

              {biblePanelFor(view) === "gate" && (
                <GatePanel
                  message={view.gateMessage ?? "this gate recorded no message"}
                  attempt={view.run?.gate?.attempt ?? view.attempt ?? 1}
                  content={view.content}
                  fileRel={view.file}
                  rawUrl={rawUrl}
                  canAct={canAct}
                  onAnswer={(answer) => { void answerGate(answer); }}
                  busy={busy === "approve" || busy === "reject" || busy === "myself" || busy === "import" ? busy : null}
                  error={error}
                  moved={moved}
                  changed={changed}
                  onReload={() => { setChanged(false); setMoved(null); setError(null); file.refetch(); }}
                  readOnlyNote={readOnly ? readOnlyNote : undefined}
                />
              )}

              {biblePanelFor(view) === "approved" && <ApprovedPanel view={view} rawUrl={rawUrl} />}

              {biblePanelFor(view) === "trouble" && (
                <TroublePanel
                  view={view} canAct={canAct} busy={busy}
                  onStart={() => { void startAgain(); }} readOnlyNote={readOnlyNote}
                />
              )}

              {biblePanelFor(view) === "scaffold" && <ScaffoldPanel view={view} rawUrl={rawUrl} />}

              {/* The gate panel prints its own errors beside its own buttons; every other panel's
                  failures land here. */}
              {error !== null && biblePanelFor(view) !== "gate" && <p className="error-line">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

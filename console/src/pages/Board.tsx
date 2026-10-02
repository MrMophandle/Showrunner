import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { EpisodeRow } from "../../shared/types.js";
import { post, useConsole, useNow } from "../api.js";
import { elapsed, firstLine, stageLabel, stalled } from "../projections.js";
import { NewEpisode } from "../components/NewEpisode.js";

/** The Board: one row per episode, and the one question it answers is which of them wants the
 *  showrunner.
 *
 *  Everything on a row comes from `EpisodeRow` (`shared/types.ts`), which is deliberately the one
 *  shape that can be built without opening a run: the Board is the page that is left open on a
 *  tablet, and it re-reads every episode of the show on every change notification.
 *
 *  An episode whose directory carries an `archive.json` marker and no run logs is drawn at the
 *  marker's stage with an "archived" chip and the marker's one line, no reasons beside it, and no
 *  launch button. Season 1 was made by console v1, has no run logs and no `premise.md`, and would
 *  otherwise read NEEDS_IDEA · no runs for ten rows.
 *
 *  The stage and the gate are drawn side by side rather than one instead of the other, because
 *  they can disagree and both be right: `deriveStage` (`engine/src/stages.ts`) tests the NEEDS_
 *  rules *before* it looks at the open gate, so an episode parked at `image-gate` whose
 *  showrunner-made shots are not on disk is `NEEDS_IMAGES` **and** has a gate open at
 *  `image-gate`. A row that showed only the first would hide the answer the gate is waiting for;
 *  one that showed only the second would send the operator to a gate they cannot answer until
 *  they have made three images. */

/** What a row's status chip says, and the class that colours it. */
function statusChip(row: EpisodeRow, now: number): { text: string; className: string } {
  switch (row.status) {
    case "running": {
      const worker = row.worker;
      return {
        className: "chip chip-running",
        text: worker === undefined ? "running" : `running · pid ${worker.pid} · beat ${elapsed(worker.heartbeatAt, now)} ago`,
      };
    }
    case "waiting":
      return { className: "chip chip-waiting", text: "waiting on you" };
    case "failed":
      return {
        className: "chip chip-failed",
        text: row.failed === undefined ? "failed" : `failed · ${row.failed.stepId} — ${firstLine(row.failed.error)}`,
      };
    case "crashed": {
      const groups = row.worker?.groups.length ?? 0;
      return { className: "chip chip-crashed", text: `crashed${groups > 0 ? ` · ${groups} live process ${groups === 1 ? "group" : "groups"}` : ""}` };
    }
    case "completed":
      return { className: "chip chip-completed", text: "completed" };
    case "none":
      return { className: "chip chip-none", text: "no runs" };
    case "archived":
      // The note is the marker's own line — where the finished episode is and what made it —
      // because "archived" alone would leave the operator asking which archive.
      return {
        className: "chip chip-archived",
        text: row.archiveNote === undefined ? "archived" : `archived · ${row.archiveNote}`,
      };
    default:
      return { className: "chip", text: row.status };
  }
}

/** The reasons a NEEDS_ row is blocked, in the operator's words. The lists are on the row, not
 *  only the flags, so a row that says NEEDS_REFS names the three references that are not on disk
 *  instead of sending its reader looking for them. An archived episode's `needs` are empty by
 *  construction (`idleEpisodeRow`, `server/episodes.ts`), so an archived row prints no reasons. */
function needsLines(row: EpisodeRow, episodesDir: string): string[] {
  const lines: string[] = [];
  if (row.needs.ideaMissing) lines.push(`premise missing — write ${episodesDir}/${row.id}/premise.md`);
  if (row.needs.refsMissing.length > 0) lines.push(`references missing: ${row.needs.refsMissing.join("; ")}`);
  if (row.needs.imagesMissing.length > 0) lines.push(`your images missing: ${row.needs.imagesMissing.join("; ")}`);
  return lines;
}

export function Board() {
  const { show, rows, rowsError, rowsLoading, refetchRows } = useConsole();
  const navigate = useNavigate();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmContinue, setConfirmContinue] = useState<string | null>(null);
  const episodesDir = show?.episodesDir ?? "Episodes";

  async function launch(id: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      const { runId } = await post<{ runId: string }>(`/api/episodes/${encodeURIComponent(id)}/runs`, {});
      refetchRows();
      navigate(`/episodes/${id}/runs/${runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function continueRun(row: EpisodeRow): Promise<void> {
    if (row.runId === undefined) return;
    setBusy(row.id);
    setError(null);
    setConfirmContinue(null);
    try {
      await post(`/api/episodes/${encodeURIComponent(row.id)}/runs/${encodeURIComponent(row.runId)}/continue`, {});
      refetchRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="board">
      <div className="board-head">
        <h1>{show === null ? "the board" : `${show.showName} — the board`}</h1>
        <NewEpisode episodesDir={episodesDir} onCreated={() => { refetchRows(); }} />
      </div>

      {error !== null && <p className="error-line">{error}</p>}
      {rowsError !== null && <p className="error-line">could not read the episodes: {rowsError}</p>}
      {rows === null && rowsLoading && <p className="quiet">reading the show…</p>}
      {rows !== null && rows.length === 0 && <p className="quiet">no episodes yet — create one above</p>}

      <ul className="rows">
        {(rows ?? []).map((row) => {
          const stage = stageLabel(row.stage);
          const chip = statusChip(row, now);
          const reasons = needsLines(row, episodesDir);
          const quiet = stalled(row.lastEventAt, now) && (row.status === "running" || row.status === "crashed");
          const runHref = row.runId === undefined ? null : `/episodes/${row.id}/runs/${row.runId}`;
          return (
            <li className={`row row-${row.status}`} key={row.id}>
              <div className="row-name">
                {/* The title is the `# ` heading of the episode's outline, and `episodeTitle`
                    falls back to the id when there is no outline yet — so an episode with no
                    outline shows its id once rather than twice. */}
                {runHref === null
                  ? <span className="row-title"><span className="mono row-id">{row.id}</span> {row.title === row.id ? "" : row.title}</span>
                  : <Link className="row-title" to={runHref}><span className="mono row-id">{row.id}</span> {row.title === row.id ? "" : row.title}</Link>}
              </div>

              <div className="row-stage">
                <span className={`chip chip-stage chip-${stage.kind}`}>{stage.text}</span>
                {row.openGate !== undefined && (
                  <span className="chip chip-gate mono">{row.openGate.stepId} · attempt {row.openGate.attempt}</span>
                )}
                {reasons.length > 0 && (
                  <ul className="row-needs">
                    {reasons.map((line, i) => <li key={i}>{line}</li>)}
                  </ul>
                )}
              </div>

              <div className="row-status">
                <span className={chip.className}>{chip.text}</span>
                {row.lastEventAt !== undefined && (
                  <span className={`row-since${quiet ? " amber" : ""}`}>
                    {elapsed(row.lastEventAt, now)} since the last event
                  </span>
                )}
                {/* A log the store could not read to its end: this row is derived from the bytes
                    before the bad one and has stopped moving. Said here because the alternative is
                    a row that looks current and is not. */}
                {row.logError !== undefined && <span className="row-log-error">{row.logError}</span>}
              </div>

              <div className="row-actions">
                {row.status === "none" && (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={row.needs.ideaMissing || busy !== null}
                      onClick={() => { void launch(row.id); }}
                    >
                      {busy === row.id ? "launching…" : "launch"}
                    </button>
                    {row.needs.ideaMissing && (
                      <span className="action-reason">write {episodesDir}/{row.id}/premise.md first</span>
                    )}
                  </>
                )}
                {/* No launch button for an archived episode. The marker says the episode was
                    finished outside the engine, and what a run over a finished episode should do
                    is Plan F's question, not a button's. */}
                {row.status === "archived" && (
                  <span className="action-reason">archived; launch is not offered</span>
                )}
                {row.status === "waiting" && runHref !== null && (
                  <Link className="btn btn-primary" to={`${runHref}/gate`}>open gate</Link>
                )}
                {row.status === "crashed" && confirmContinue !== row.id && (
                  <button type="button" className="btn btn-primary" onClick={() => { setConfirmContinue(row.id); }}>continue</button>
                )}
                {row.status === "crashed" && confirmContinue === row.id && (
                  <>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy !== null}
                      onClick={() => { void continueRun(row); }}
                    >
                      {(row.worker?.groups.length ?? 0) > 0 ? `kill ${row.worker?.groups.length} and continue` : "continue"}
                    </button>
                    <button type="button" className="btn" onClick={() => { setConfirmContinue(null); }}>cancel</button>
                  </>
                )}
                {runHref !== null && <Link className="btn" to={runHref}>open run</Link>}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="legend">
        <span className="chip chip-stage chip-needs">NEEDS something</span> blocked on your own work ·
        <span className="chip chip-stage chip-draft">DRAFT something</span> in flight or at a gate ·
        <span className="chip chip-stage chip-approved">APPROVED</span> a milestone the episode has passed
      </p>
    </div>
  );
}

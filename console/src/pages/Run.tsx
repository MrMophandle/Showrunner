import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { EventBatch, RunView, WireEvent } from "../../shared/types.js";
import { getJson, post, useApi, useCoalesced, useConsole, useNow, useSSE } from "../api.js";
import { elapsed, stageLabel, stallState } from "../projections.js";
import { ActionBar } from "../components/ActionBar.js";
import { AutoTextarea } from "../components/AutoTextarea.js";
import { EventFeed } from "../components/EventFeed.js";
import { ProgressBar } from "../components/ProgressBar.js";
import { StepRail } from "../components/StepRail.js";

/** One run, at three altitudes and then at the bottom one.
 *
 *  The page holds two things the server serves separately and keeps them in step by hand: the
 *  middle-altitude view (`GET …/runs/:run`) and the run's raw events (`GET …/runs/:run/events`).
 *  Only the events are incremental — the client holds the byte offset its last batch was read to
 *  and asks for what has been appended since, so tailing a log that is growing by thousands of
 *  lines transfers the lines and not the log.
 *
 *  Two rules make that safe. The `?after=` value is always **this page's own cursor** and never
 *  the offset an SSE notice carried: notices are coalesced, so the offset of the notice that
 *  triggered a fetch may be newer than the client's cursor, and asking from it would skip
 *  everything in between. And a batch whose offset comes back *lower* than the cursor means the
 *  log was truncated or replaced under the reader (`server/runs.ts`'s `#tailOnce` third case), so
 *  the feed is discarded and read again from zero rather than appended to.
 *
 *  The fetches are coalesced into one per 250 ms. A render at full tilt appends ten times a
 *  second, and a fetch per notice would be ten requests a second to draw a page that changes
 *  once a frame. */

/** How many events the feed keeps. The spec's number: enough to hold a whole agent step's output
 *  and the failure after it, not enough for a four-hour render's line-per-second to cost the tab
 *  its memory. */
const MAX_EVENTS = 2_000;

function trimEvents(events: WireEvent[]): WireEvent[] {
  return events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
}

export function Run() {
  const params = useParams();
  const episodeId = params["id"] ?? "";
  const runId = params["run"] ?? "";
  const base = `/api/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}`;

  const view = useApi<RunView>(base);
  const { show } = useConsole();
  const now = useNow();
  const [events, setEvents] = useState<WireEvent[]>([]);
  const [feedError, setFeedError] = useState<string | null>(null);
  const offset = useRef(0);

  const [withdrawFor, setWithdrawFor] = useState<string | null>(null);
  const [withdrawNotes, setWithdrawNotes] = useState("");
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Reads everything appended since this page's cursor. */
  const pull = useCallback(async (): Promise<void> => {
    try {
      const batch = await getJson<EventBatch>(`${base}/events?after=${offset.current}`);
      if (batch.offset < offset.current) {
        // The log is shorter than the cursor: it was truncated or replaced, and what this page
        // holds describes bytes that no longer exist.
        offset.current = 0;
        const fresh = await getJson<EventBatch>(`${base}/events?after=0`);
        offset.current = fresh.offset;
        setEvents(trimEvents(fresh.events));
        setFeedError(null);
        return;
      }
      offset.current = batch.offset;
      if (batch.events.length > 0) setEvents((prev) => trimEvents([...prev, ...batch.events]));
      setFeedError(null);
    } catch (err) {
      setFeedError(err instanceof Error ? err.message : String(err));
    }
  }, [base]);

  // One fetch per 250 ms however many notices arrive in it, and the view is refetched on the same
  // tick: the status, the rail and the progress all change with the bytes the feed is reading.
  const refresh = useCoalesced(() => { view.refetch(); void pull(); }, 250);

  useSSE((message) => {
    if (message.type === "run" && message.episodeId === episodeId && message.runId === runId) refresh();
  });

  // The feed from the start, on mount and whenever the page is pointed at a different run.
  useEffect(() => {
    let cancelled = false;
    offset.current = 0;
    setEvents([]);
    setFeedError(null);
    getJson<EventBatch>(`${base}/events?after=0`)
      .then((batch) => {
        if (cancelled) return;
        offset.current = batch.offset;
        setEvents(trimEvents(batch.events));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFeedError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [base]);

  async function withdraw(stepId: string): Promise<void> {
    setWithdrawing(stepId);
    setError(null);
    setNotice(null);
    try {
      const result = await post<{ reset?: unknown; survivingGates?: unknown }>(`${base}/withdraw`, { stepId, notes: withdrawNotes });
      const reset = Array.isArray(result.reset) ? result.reset.map(String) : [];
      const surviving = Array.isArray(result.survivingGates) ? result.survivingGates.map(String) : [];
      setNotice([
        `${stepId}'s approval withdrawn — ${reset.length === 0 ? "nothing downstream had run" : `these run again: ${reset.join(", ")}`}`,
        // The gates the engine leaves approved. Named in the notice as well as in the
        // confirmation, because this is the half of the move that is easy to forget having made.
        ...(surviving.length > 0 ? [`these gates keep their approvals and will not be re-asked: ${surviving.join(", ")}`] : []),
      ].join(". "));
      setWithdrawFor(null);
      setWithdrawNotes("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWithdrawing(null);
    }
  }

  if (view.data === null) {
    return (
      <div className="run">
        <p className="quiet">{view.loading ? "reading the run…" : ""}</p>
        {view.error !== null && <p className="error-line">could not read this run: {view.error}</p>}
      </div>
    );
  }

  const run = view.data;
  const stage = stageLabel(run.stage);
  const stall = stallState(run, now);
  const current = run.position === undefined ? undefined : run.steps.find((s) => s.id === run.position?.stepId);
  const worker = run.worker;

  // One of the run's own files beside its log, as a url the artifact route serves — built the way
  // the What-happened page builds the troubleshooting log's. Both are null until `GET /api/show`
  // has answered, because the production directory's name is the show's and not this code's.
  const runFileUrl = (suffix: string): string | null => show === null
    ? null
    : `/api/episodes/${encodeURIComponent(episodeId)}/files/${encodeURIComponent(show.productionDir)}/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(`${runId}${suffix}`)}`;
  const workerLogUrl = runFileUrl(".worker.log");
  const workerOutUrl = runFileUrl(".worker.out");

  // The gates that would keep their approvals if this withdrawal went through: every approved gate
  // after the subject in pipeline order. The authoritative list comes back from the route, which
  // computes it from the pipeline's dependency edges; this is the pre-flight estimate the
  // confirmation shows, and it is empty whenever the rail's own rule held — the rail offers
  // withdraw only on the latest approved gate.
  const withdrawAt = withdrawFor === null ? -1 : run.steps.findIndex((s) => s.id === withdrawFor);
  const survivingIfWithdrawn = withdrawAt === -1
    ? []
    : run.steps.slice(withdrawAt + 1).filter((s) => s.kind === "gate" && s.status === "completed").map((s) => s.id);

  return (
    <div className="run">
      <div className="run-head">
        <h1>
          <Link className="link-plain" to="/">◂ the board</Link>
          {" "}
          <span className="mono">{run.episodeId}</span> · <span className="mono run-id">{run.runId}</span>
        </h1>
        <div className="run-pipeline quiet mono">
          {run.pipeline.name}
          {run.pipeline.hash !== undefined && ` · ${run.pipeline.hash.slice(0, 12)}`}
          {run.pipeline.engineVersion !== undefined && ` · engine ${run.pipeline.engineVersion}`}
          {/* The logged hash beside the hash of the pipeline the code builds today: the two
              differing is why this run has steps the code does not, and the first thing to know
              about a run whose rail does not look like the pipeline. Marked the way the
              What-happened page's prompt table marks a prompt that was edited after the run read
              it, because it is the same kind of fact about the same kind of drift. */}
          {run.pipeline.changed && (
            <span className="chip chip-needs chip-inline">pipeline changed since this run · now {run.pipeline.hashNow.slice(0, 12)}</span>
          )}
        </div>
      </div>

      <section className="altitudes">
        <div className="altitude">
          <div className="altitude-label">stage</div>
          <span className={`chip chip-stage chip-${stage.kind}`}>{stage.text}</span>
          <div className={`altitude-sub chip chip-${run.status}`}>{run.status}</div>
          {worker !== undefined && (
            <div className="altitude-sub quiet mono">
              pid {worker.pid} {worker.alive ? "live" : "dead"} · beat {elapsed(worker.heartbeatAt, now)} ago
              {worker.groups.length > 0 && ` · groups ${worker.groups.join(", ")}`}
            </div>
          )}
        </div>

        <div className="altitude">
          <div className="altitude-label">step</div>
          {current === undefined
            ? <div className="quiet">nothing in flight</div>
            : (
              <>
                <div className="altitude-step"><span className="mono">{current.id}</span> <span className="quiet">{current.kind}</span></div>
                <div className="altitude-sub mono">{elapsed(current.startedAt, now)} in this step</div>
              </>
            )}
        </div>

        <div className="altitude">
          <div className="altitude-label">progress</div>
          {current?.progress === undefined
            ? <div className="quiet">no progress reported</div>
            : <ProgressBar progress={current.progress} />}
        </div>

        <div className={`altitude altitude-stall${stall.amber ? " amber" : ""}`}>
          <div className="altitude-label">silence</div>
          <div className="altitude-stall-text">{stall.text}</div>
          {run.startedAt !== undefined && <div className="altitude-sub quiet mono">started {elapsed(run.startedAt, now)} ago</div>}
          {run.finishedAt !== undefined && <div className="altitude-sub quiet mono">finished {elapsed(run.finishedAt, now)} ago</div>}
        </div>
      </section>

      {run.openGate !== undefined && (
        <p className="gate-banner">
          <span className="mono">{run.openGate.stepId}</span> has been waiting for an answer since{" "}
          <span className="mono">{run.openGate.openedAt.slice(11, 19)}</span> (attempt {run.openGate.attempt}).{" "}
          <Link to={`/episodes/${run.episodeId}/runs/${run.runId}/gate`}>read it</Link>
        </p>
      )}
      {run.failed !== undefined && (
        <p className="error-line">
          <span className="mono">{run.failed.stepId}</span> failed: {run.failed.error.split("\n")[0]}
        </p>
      )}
      {/* A log the store could not read to its end. Everything above and below is derived from the
          bytes before the bad one, so the page says the run's picture has stopped rather than
          presenting a frozen view as a current one. */}
      {run.logError !== undefined && <p className="error-line">{run.logError}</p>}

      {/* The crashed run's own account. Ruling F-09: the worker catches a rejected `run()`, writes
          the error to `<runId>.worker.log` and exits 2 — and its `finally` removes the lock, so
          this file is the whole of the explanation. The two links are the full files, which carry
          the stack and anything the worker process printed before it could log a line. */}
      {run.status === "crashed" && (
        <section className="worker-exit">
          <h2>the worker's account</h2>
          {run.workerExit === undefined
            ? <p className="quiet">nothing in <span className="mono">{run.runId}.worker.log</span> — the worker died before it could write a line.</p>
            : <pre className="worker-exit-text">{run.workerExit}</pre>}
          {workerLogUrl !== null && workerOutUrl !== null && (
            <p className="quiet">
              <a href={workerLogUrl}>{run.runId}.worker.log</a>
              {" · "}
              <a href={workerOutUrl}>{run.runId}.worker.out</a>
              {" — the whole files, through the artifact route"}
            </p>
          )}
        </section>
      )}

      <ActionBar view={run} onDone={() => { refresh(); }} />

      {notice !== null && <p className="notice-line">{notice}</p>}
      {error !== null && <p className="error-line">{error}</p>}

      {withdrawFor !== null && (
        <div className="action-confirm">
          <p>
            Withdrawing <span className="mono">{withdrawFor}</span>'s approval resets everything downstream of it and
            answers the gate again as a rejection, so the next worker takes the ordinary rejection path — the fix
            agent, then the gate reopened at the next attempt. Say what is wrong, as you would in a rejection.
          </p>
          {/* The engine never resets a gate, so a gate downstream of this one keeps the approval it
              already has and the next worker walks straight past it — the showrunner's "yes" to the
              old work applied to the new. Named here because the operator cannot otherwise know. */}
          {survivingIfWithdrawn.length > 0 && (
            <p className="error-line">
              {survivingIfWithdrawn.length === 1 ? "This gate keeps its approval" : "These gates keep their approvals"} and
              will <strong>not</strong> be re-asked: <span className="mono">{survivingIfWithdrawn.join(", ")}</span>. The
              work they approved is about to be remade.
            </p>
          )}
          <AutoTextarea value={withdrawNotes} onChange={setWithdrawNotes} placeholder="what the fix agent should change" />
          <div className="action-row">
            <button
              type="button"
              className="btn btn-danger"
              disabled={withdrawing !== null}
              onClick={() => { void withdraw(withdrawFor); }}
            >
              {withdrawing !== null ? "withdrawing…" : "withdraw the approval"}
            </button>
            <button type="button" className="btn" onClick={() => { setWithdrawFor(null); }}>cancel</button>
          </div>
        </div>
      )}

      <section className="rail-section">
        <h2>the steps</h2>
        <StepRail
          view={run}
          events={events}
          now={now}
          withdrawing={withdrawing}
          {...(run.openGate === undefined ? { onWithdraw: (stepId: string) => { setWithdrawFor(stepId); setNotice(null); setError(null); } } : {})}
        />
      </section>

      {feedError !== null && <p className="error-line">could not read the log: {feedError}</p>}
      <EventFeed events={events} logUrl={`${base}/log`} />
    </div>
  );
}

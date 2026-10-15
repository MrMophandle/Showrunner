import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { EventBatch, RunView, WireEvent } from "../../shared/types.js";
import { getJson, post, showHref, showPath, useApi, useCoalesced, useConsole, useNow, useSSE, useShowKey } from "../api.js";
import { elapsed, iterationLabel, positionStep, runSituation, stageLabel, stallState } from "../projections.js";
import { ActionBar } from "../components/ActionBar.js";
import { AutoTextarea } from "../components/AutoTextarea.js";
import { EventFeed } from "../components/EventFeed.js";
import { ProgressBar } from "../components/ProgressBar.js";
import { SituationLine, type SituationAction } from "../components/SituationLine.js";
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
 *  once a frame.
 *
 *  **A notice is this page's only when it carries this page's show key** as well as its episode
 *  and run ids. The key comes from the url rather than from the fetched `ShowInfo`, so the filter
 *  is right on the first render: one channel carries every registered show's notices, two shows
 *  can each hold an `s02e01` with a run called `r1`, and a page that waited for a fetch before it
 *  could tell them apart would tail the wrong log for the length of that fetch (ruling H-12). */

/** How many events the feed keeps. The spec's number: enough to hold a whole agent step's output
 *  and the failure after it, not enough for a four-hour render's line-per-second to cost the tab
 *  its memory. */
const MAX_EVENTS = 2_000;

function trimEvents(events: WireEvent[]): WireEvent[] {
  return events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
}

export function Run() {
  const params = useParams();
  const showKey = useShowKey();
  const episodeId = params["id"] ?? "";
  const runId = params["run"] ?? "";
  const base = showPath(showKey, `/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}`);

  const view = useApi<RunView>(base);
  const { show, canAct } = useConsole();
  const now = useNow();
  const [events, setEvents] = useState<WireEvent[]>([]);
  const [feedError, setFeedError] = useState<string | null>(null);
  const offset = useRef(0);

  const [withdrawFor, setWithdrawFor] = useState<string | null>(null);
  const [withdrawNotes, setWithdrawNotes] = useState("");
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Resume and Continue live beside the situation line rather than in the action bar, because the
  // line is what says a run has failed or crashed and the move belongs with the statement of the
  // problem. The confirmation Continue needs is on the page for the same reason the withdrawal's
  // is: a confirmation that explains what it is about to kill is a paragraph, not a button.
  const [acting, setActing] = useState<string | null>(null);
  const [confirmContinue, setConfirmContinue] = useState(false);

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
    if (message.type === "run" && message.show === showKey && message.episodeId === episodeId && message.runId === runId) refresh();
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

  /** Resume or Continue: the engine's verb, then a refetch. **No success notice** — the situation
   *  line above is the feedback, and it says what the run is doing rather than what was asked of
   *  it a moment ago (Ryan's ruling, 2026-10-15). */
  async function act(name: "resume" | "continue"): Promise<void> {
    setActing(name);
    setError(null);
    setNotice(null);
    try {
      await post(`${base}/${name}`, {});
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  }

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
  const current = positionStep(run);
  const iteration = iterationLabel(current);
  const worker = run.worker;
  // The one thing the page says before anything else: is the system working, or is it waiting on
  // the showrunner, and for what. One projection, one vocabulary, three callers — this slot, the
  // Board's rows, and the tab title's five forms it is the in-page form of.
  const situation = runSituation(run, now);

  // One of the run's own files beside its log, as a url the artifact route serves — built the way
  // the What-happened page builds the troubleshooting log's. Both are null until
  // `GET /api/shows/<key>` has answered, because the production directory's name is the show's and
  // not this code's.
  const runFileUrl = (suffix: string): string | null => show === null
    ? null
    : showPath(showKey, `/episodes/${encodeURIComponent(episodeId)}/files/${encodeURIComponent(show.productionDir)}/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(`${runId}${suffix}`)}`);
  const workerLogUrl = runFileUrl(".worker.log");
  const workerOutUrl = runFileUrl(".worker.out");

  // The one move the situation names, as this page is able to offer it. The open gate is a GET and
  // so stays on a read-only show, which is the carve-out ruling H-03 makes for the two links that
  // only read; Resume and Continue are POSTs the server answers 403 to, so they are offered only
  // where the console can act.
  const gateHref = showHref(showKey, `/episodes/${run.episodeId}/runs/${run.runId}/gate`);
  const primary = ((): SituationAction | undefined => {
    switch (situation.action) {
      case "gate":
        return run.openGate === undefined ? undefined : { label: `open gate · ${run.openGate.stepId}`, href: gateHref };
      case "resume":
        return canAct ? { label: acting === "resume" ? "resuming…" : "resume", onClick: () => { void act("resume"); }, busy: acting !== null } : undefined;
      case "continue":
        // The first click opens the confirmation below, which is the one that posts: Continue
        // replays the open step and signals the dead worker's process groups first.
        return canAct && !confirmContinue ? { label: "continue", onClick: () => { setConfirmContinue(true); } } : undefined;
      default:
        return undefined;
    }
  })();

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
          <Link className="link-plain" to={showHref(showKey)}>◂ the board</Link>
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

      <SituationLine situation={situation} {...(primary === undefined ? {} : { action: primary })} />

      {confirmContinue && (
        <div className="action-confirm">
          <p>
            Continuing replays the open step. {worker !== undefined && worker.groups.length > 0
              ? <>The dead worker recorded <span className="mono">{worker.groups.length}</span> live process {worker.groups.length === 1 ? "group" : "groups"} — <span className="mono">{worker.groups.join(", ")}</span> — and they are signalled first, because a replay starting while the old render is still writing would put two processes on one file.</>
              : <>The dead worker recorded no live process groups, so nothing is signalled.</>}
          </p>
          <div className="action-row">
            <button
              type="button"
              className="btn btn-danger"
              disabled={acting !== null}
              onClick={() => { setConfirmContinue(false); void act("continue"); }}
            >
              {acting === "continue" ? "continuing…" : worker !== undefined && worker.groups.length > 0 ? "kill the groups and continue" : "continue"}
            </button>
            <button type="button" className="btn" onClick={() => { setConfirmContinue(false); }}>cancel</button>
          </div>
        </div>
      )}

      <section className="altitudes">
        <div className="altitude">
          <div className="altitude-label">stage</div>
          <span className={`chip chip-stage chip-${stage.kind}`}>{stage.text}</span>
          {/* The run's status is not a chip here any more. The one word — "waiting", "running",
              "failed" — was the page's only statement of who held the run, and the situation line
              above now says it in a sentence with the step, the age and the move (Ryan's ruling,
              2026-10-15). The stage chip stays: a stage is where the episode has got to, which is
              a different question from who holds it. */}
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
                {/* How close a loop is to exhausting its attempts, in the same words the situation
                    line uses (`iterationLabel`). It is not the progress bar's number: the draft
                    loop reports "2/12 scenes" against a cap of fifteen iterations. */}
                {iteration !== undefined && <div className="altitude-sub mono">{iteration}</div>}
                {/* Why this step has been in flight for ninety minutes without writing anything:
                    it is asleep until a Claude plan usage limit resets, and the worker will re-run
                    it on its own (Plan I). The engine's sentence verbatim — "waiting for the usage
                    limit to reset at 7:50pm America/New_York (weekly quota 41%)" — because the
                    elapsed time above is the whole of what this altitude otherwise says, and an
                    agent step silently counting past its timeout is the reading that costs the
                    operator an afternoon of looking for a hang. */}
                {current.note !== undefined && current.note !== "" && (
                  <div className="altitude-sub altitude-waiting">{current.note}</div>
                )}
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

      {/* The gate banner and the failed step's error line were here. Both said what the situation
          line at the top now says — the gate's step, age and attempt; the failed step and its
          first error line — and the line says it with the move beside it, so printing either here
          as well would be the one page saying one thing twice (Ryan's ruling, 2026-10-15). */}
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

      {withdrawFor !== null && canAct && (
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
          {...(run.openGate === undefined && canAct ? { onWithdraw: (stepId: string) => { setWithdrawFor(stepId); setNotice(null); setError(null); } } : {})}
        />
      </section>

      {feedError !== null && <p className="error-line">could not read the log: {feedError}</p>}
      <EventFeed events={events} logUrl={`${base}/log`} />
    </div>
  );
}

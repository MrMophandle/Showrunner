import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { WhatHappenedContext } from "../../shared/types.js";
import { getText, postStream, showHref, showPath, useApi, useConsole, useShowKey } from "../api.js";
import { readOnlyLine } from "../projections.js";
import { Markdown } from "../components/Markdown.js";

/** "What happened": the run's own record, and an agent that answers questions about it.
 *
 *  The context is shown before anything is asked, because the operator should be able to see what
 *  the agent will be reading — and because about half the questions answer themselves at that
 *  point. The prompt-hash comparison in particular: a step that behaved unlike its neighbours,
 *  beside a prompt whose file on disk is not the one the run read, is the whole answer, and it
 *  cost nothing to find out.
 *
 *  Every question and its answer are appended by the server to
 *  `<runs>/<runId>.troubleshooting.jsonl` — beside the run's log and never in it. This page reads
 *  that file back through the artifact route, which serves any file under the episode's own two
 *  trees, so the previous questions survive a reload and a restart. There is no second route for
 *  it: the file is one of the episode's own.
 *
 *  Cost is labelled estimated, always. It is `total_cost_usd` as the SDK reported it for one
 *  query, which is a number the model's own accounting produced; the invoice is Anthropic's.
 *
 *  **A read-only show renders the record and no question box.** Asking is a POST
 *  (`POST …/runs/:run/ask`, which appends to the troubleshooting log beside the run), and the
 *  server refuses every POST to a read-only show with 403 (ruling H-03) — so the box would be a
 *  question the console cannot ask. Everything above it is a GET and is shown in full. */

/** One row of the troubleshooting log, as the server writes it (`server/what-happened.ts`'s
 *  `record`). Read defensively: the file is append-only and a row from an older console is still
 *  a row this page must not choke on. */
interface AskedRow {
  ts: string;
  by: string;
  question: string;
  answer: string;
  costUsd?: number;
}

function parseLog(text: string): AskedRow[] {
  const rows: AskedRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (typeof row["question"] !== "string") continue;
    rows.push({
      ts: typeof row["ts"] === "string" ? row["ts"] : "",
      by: typeof row["by"] === "string" ? row["by"] : "",
      question: row["question"],
      answer: typeof row["answer"] === "string" ? row["answer"] : "",
      ...(typeof row["costUsd"] === "number" ? { costUsd: row["costUsd"] } : {}),
    });
  }
  return rows;
}

export function WhatHappened() {
  const params = useParams();
  const showKey = useShowKey();
  const episodeId = params["id"] ?? "";
  const runId = params["run"] ?? "";
  const base = showPath(showKey, `/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}`);
  const runHref = showHref(showKey, `/episodes/${episodeId}/runs/${runId}`);
  const { show } = useConsole();
  const canAct = show !== null && !show.readOnly;
  const readOnly = show !== null && show.readOnly;
  const context = useApi<WhatHappenedContext>(`${base}/context`);

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<AskedRow[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);

  // The troubleshooting log, through the artifact route: `Production/<id>/runs/<run>.troubleshooting.jsonl`.
  // A 404 is the ordinary case — nobody has asked anything about this run yet — and is not an error.
  const logUrl = show === null
    ? null
    : showPath(showKey, `/episodes/${encodeURIComponent(episodeId)}/files/${encodeURIComponent(show.productionDir)}/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(`${runId}.troubleshooting.jsonl`)}`);

  const readLog = useCallback(async (): Promise<void> => {
    if (logUrl === null) return;
    try {
      setAsked(parseLog(await getText(logUrl)));
      setLogError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAsked([]);
      setLogError(message.includes("no such artifact") ? null : message);
    }
  }, [logUrl]);

  useEffect(() => { void readLog(); }, [readLog]);

  async function ask(): Promise<void> {
    setAsking(true);
    setError(null);
    setAnswer("");
    try {
      await postStream(`${base}/ask`, { question }, (chunk) => {
        setAnswer((current) => current + chunk);
        // Follow the answer as it arrives: the first sentence is usually the answer, and the rest
        // is the citation, so the reader is at the top and the growth is at the bottom.
        const el = answerRef.current;
        if (el !== null) el.scrollTop = el.scrollHeight;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
      // The cost is only in the log — the stream carries the answer alone — so the log is re-read
      // once the answer is in.
      void readLog();
    }
  }

  const ctx = context.data;
  const estimated = asked.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);

  return (
    <div className="what-happened">
      <h1>
        <Link className="link-plain" to={runHref}>◂ the run</Link>{" "}
        what happened to <span className="mono">{episodeId}</span> · <span className="mono">{runId}</span>
      </h1>

      {context.error !== null && <p className="error-line">could not assemble the run's record: {context.error}</p>}
      {ctx === null && context.loading && <p className="quiet">assembling the run's record…</p>}

      {ctx !== null && (
        <section className="context">
          <h2>what the troubleshooter is handed</h2>
          <ul className="context-summary">
            <li>
              the pipeline <span className="mono">{ctx.pipeline.name}</span> as a document — {ctx.pipeline.steps.length} steps,
              every input, output and bound each one declares
              {/* The pipeline the code builds today, hashed, beside the hash this run recorded:
                  the same then-and-now comparison the prompt table makes below, for the shape of
                  the run itself. */}
              {ctx.run.pipeline.changed && <span className="chip chip-needs chip-inline">changed since the run</span>}
            </li>
            <li>
              the run at the middle altitude — status <span className="mono">{ctx.run.status}</span>, stage{" "}
              <span className="mono">{ctx.run.stage}</span>, {ctx.run.steps.filter((s) => s.status === "completed").length} completed,{" "}
              {ctx.run.steps.filter((s) => s.status === "failed").length} failed,{" "}
              {ctx.run.steps.filter((s) => s.status === "pending").length} never reached
            </li>
            <li>
              {ctx.events.length} events, with the chatter collapsed — the last fifty script lines of each step and
              each step's last progress, everything else whole
            </li>
            <li>{ctx.prompts.length} {ctx.prompts.length === 1 ? "prompt" : "prompts"} the run read, by hash</li>
            <li>{ctx.outputs.length} {ctx.outputs.length === 1 ? "file" : "files"} the run wrote</li>
          </ul>

          <h3>the prompts, then and now</h3>
          {ctx.prompts.length === 0
            ? <p className="quiet">this run ran no agent steps</p>
            : (
              <div className="table-scroll">
                <table className="table">
                  <thead><tr><th>step</th><th>prompt</th><th>at the run</th><th>now</th></tr></thead>
                  <tbody>
                    {ctx.prompts.map((p) => (
                      <tr key={`${p.stepId}:${p.promptFile}`} className={p.changed ? "row-changed" : ""}>
                        <td className="mono">{p.stepId}</td>
                        <td className="mono">{p.promptFile}</td>
                        <td className="mono">{p.hashAtRun.slice(0, 12)}</td>
                        <td className="mono">
                          {p.hashNow === null ? "gone" : p.hashNow.slice(0, 12)}
                          {p.changed && <span className="chip chip-needs chip-inline">changed since the run</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          <h3>what the run wrote</h3>
          {ctx.outputs.length === 0
            ? <p className="quiet">no step recorded an output hash</p>
            : (
              <ul className="outputs mono">
                {ctx.outputs.map((file) => <li key={file}>{file}</li>)}
              </ul>
            )}
        </section>
      )}

      <section className="ask">
        <h2>ask about this run</h2>
        {readOnly && <p className="action-reason">{readOnlyLine(showKey, "no question is asked here — asking appends to the run's troubleshooting log, which is a write")}</p>}
        {canAct && (
            <>
        <p className="quiet">
          The agent reads this run's log and the files above. It has Read, Glob and Grep and nothing else: it cannot
          change the show it is explaining.
        </p>
        <textarea
          className="ask-box"
          rows={3}
          placeholder="why did tts-generate fail on the second attempt but not the first?"
          value={question}
          onChange={(e) => { setQuestion(e.target.value); }}
        />
        <div className="action-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={asking || question.trim() === ""}
            onClick={() => { void ask(); }}
          >
            {asking ? "asking…" : "ask"}
          </button>
          <span className="action-reason">every question and its answer are appended to the run's troubleshooting log</span>
        </div>
        {error !== null && <p className="error-line">{error}</p>}
        {(answer !== "" || asking) && (
          <div className="answer pane" ref={answerRef}>
            {answer === "" ? <p className="quiet">thinking…</p> : <Markdown text={answer} />}
          </div>
        )}
            </>
        )}
      </section>

      <section className="asked">
        <h2>what has been asked before</h2>
        {logError !== null && <p className="error-line">could not read the troubleshooting log: {logError}</p>}
        {asked.length === 0 && logError === null && <p className="quiet">nothing has been asked about this run yet</p>}
        {asked.length > 0 && (
          <p className="quiet">
            {asked.length} {asked.length === 1 ? "question" : "questions"} · {estimated > 0 ? `$${estimated.toFixed(4)} estimated` : "no cost recorded"}
          </p>
        )}
        <ol className="asked-list">
          {[...asked].reverse().map((row, i) => (
            <li key={`${row.ts}:${i}`}>
              <div className="asked-head">
                <span className="mono quiet">{row.ts.slice(0, 19).replace("T", " ")}</span>
                <span className="quiet">{row.by}</span>
                {row.costUsd !== undefined && <span className="quiet">${row.costUsd.toFixed(4)} estimated</span>}
              </div>
              <div className="asked-question">{row.question}</div>
              <details>
                <summary>the answer</summary>
                <Markdown text={row.answer} className="pane" />
              </details>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

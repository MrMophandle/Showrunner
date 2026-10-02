import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { GateArtifact, GateView } from "../../shared/types.js";
import { ApiError, post, useApi, useSSE, useTextApi, type DirEntry } from "../api.js";
import { composeNotesWithFlags } from "../projections.js";
import { AudioSeek } from "../components/AudioSeek.js";
import { AutoTextarea } from "../components/AutoTextarea.js";
import { ContactSheet } from "../components/ContactSheet.js";
import { Diff } from "../components/Diff.js";
import { Markdown } from "../components/Markdown.js";
import { Verdicts } from "../components/Verdicts.js";

/** The Gate page: the question, the files it is about, the evidence behind it, and the answer.
 *
 *  The attempt is the load-bearing part and the reason this page refuses to refresh itself. The
 *  showrunner answers the attempt they **read**, and the answer carries that number back as
 *  `expectedAttempt`, which the engine checks against the gate's current attempt before applying
 *  it (`engine/src/runner.ts`: "gate … is open at attempt 2, not 1"). A page that quietly swapped
 *  in a new message when the log changed would defeat that protection in the one case it exists
 *  for: a rejection that landed while this tab was open, after which an "approve" would be
 *  approving prose nobody read. So an SSE notice for this run raises a banner and changes nothing
 *  else, and a stale answer is refused by the engine and reported here as what it is.
 *
 *  How long is between opening and answering: a gate is read on a couch, and the answer may be
 *  twenty minutes later. */

/** How long the page waits before taking the operator to the run view after the engine says the
 *  gate is not open at all — long enough to read the sentence that says why. */
const REDIRECT_MS = 2_000;

/** A gate's markdown artifact: the outline, the script, the image sheet, the canon ledger. In a
 *  pane with its own scrollbar, because a script is four hundred lines and the Approve button has
 *  to stay reachable. */
function MarkdownArtifact({ url }: { url: string }) {
  const file = useTextApi(url);
  if (file.error !== null && file.data === null) return <p className="error-line">{file.error}</p>;
  if (file.data === null) return <p className="quiet">reading…</p>;
  return <Markdown text={file.data} className="pane" />;
}

/** A diff artifact — `canon-gate`'s patch. */
function DiffArtifact({ url }: { url: string }) {
  const file = useTextApi(url);
  if (file.error !== null && file.data === null) return <p className="error-line">{file.error}</p>;
  if (file.data === null) return <p className="quiet">reading…</p>;
  return <div className="pane"><Diff text={file.data} /></div>;
}

/** A json or plain-text artifact: the tts script, the publish kit. Pretty-printed when it parses
 *  as JSON, shown as it came when it does not — a file that is nearly JSON is a file whose last
 *  line is the problem, and reformatting it would hide that. */
function TextArtifact({ url, json }: { url: string; json: boolean }) {
  const file = useTextApi(url);
  if (file.error !== null && file.data === null) return <p className="error-line">{file.error}</p>;
  if (file.data === null) return <p className="quiet">reading…</p>;
  let text = file.data;
  if (json) {
    try { text = JSON.stringify(JSON.parse(file.data), null, 2); } catch { /* shown as it came */ }
  }
  return <pre className="pane mono">{text}</pre>;
}

/** An audio artifact, which is either one file or a directory of them (`casting-gate`'s
 *  `guest-refs/`). The directory case is the reason `listUrl` exists: one route serves both a file
 *  and a listing, so the presence of `listUrl` is the only unambiguous test for a directory
 *  (`shared/types.ts`'s `GateArtifact`). */
function AudioArtifact({ artifact }: { artifact: GateArtifact }) {
  const listing = useApi<{ entries: DirEntry[] }>(artifact.listUrl ?? null);
  if (artifact.listUrl === undefined) return <AudioSeek src={artifact.url} label={artifact.label} />;
  if (listing.error !== null && listing.data === null) return <p className="error-line">{listing.error}</p>;
  if (listing.data === null) return <p className="quiet">reading the directory…</p>;
  const files = listing.data.entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length === 0) return <p className="quiet">nothing in this directory yet</p>;
  return (
    <div className="audio-list">
      {files.map((entry) => (
        <AudioSeek key={entry.name} src={`${artifact.url}/${encodeURIComponent(entry.name)}`} label={entry.name} />
      ))}
    </div>
  );
}

export function Gate() {
  const params = useParams();
  const episodeId = params["id"] ?? "";
  const runId = params["run"] ?? "";
  const base = `/api/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}`;
  const runHref = `/episodes/${episodeId}/runs/${runId}`;
  const gate = useApi<GateView>(`${base}/gate`);
  const navigate = useNavigate();

  const [notes, setNotes] = useState("");
  const [flags, setFlags] = useState<Record<string, string>>({});
  // The block this page last composed into the notes, so it can be replaced rather than appended
  // to. A ref and not state: nothing renders from it, and it must be current inside the same
  // handler that just set the notes.
  const composed = useRef("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const redirect = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (redirect.current !== null) clearTimeout(redirect.current); }, []);

  // A notice, never a refetch: see the file header.
  useSSE((message) => {
    if (message.type === "run" && message.episodeId === episodeId && message.runId === runId) setChanged(true);
  });

  function applyFlags(next: Record<string, string>): void {
    setFlags(next);
    setNotes((current) => {
      const result = composeNotesWithFlags(current, composed.current, next);
      composed.current = result.block;
      return result.notes;
    });
  }

  function quote(text: string): void {
    setNotes((current) => (current === "" ? text : `${current.replace(/\s*$/, "")}\n${text}`));
  }

  function reload(): void {
    setChanged(false);
    setMoved(null);
    setError(null);
    gate.refetch();
  }

  async function answer(approved: boolean): Promise<void> {
    const view = gate.data;
    if (view === null) return;
    setBusy(approved ? "approve" : "reject");
    setError(null);
    setMoved(null);
    try {
      await post(`${base}/gate`, { stepId: view.stepId, approved, notes, expectedAttempt: view.attempt });
      navigate(runHref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 409 && message.includes("is open at attempt")) {
        // Somebody — a fix agent, another tab — answered this gate while it was being read, and
        // the engine refused an answer written against the superseded message. The number in its
        // message is the attempt that is now open.
        const which = /is open at attempt (\d+)/.exec(message)?.[1];
        setMoved(`the gate moved to attempt ${which ?? "a later one"} — read it again`);
        setChanged(false);
        gate.refetch();
      } else if (status === 409 && message.includes("is not open")) {
        setGone(`${message} — taking you to the run`);
        redirect.current = setTimeout(() => { navigate(runHref); }, REDIRECT_MS);
      } else {
        setError(message);
      }
    } finally {
      setBusy(null);
    }
  }

  if (gate.data === null) {
    return (
      <div className="gate">
        <h1><Link className="link-plain" to={runHref}>◂ the run</Link> the gate</h1>
        {gate.loading && <p className="quiet">reading the gate…</p>}
        {gate.status === 404 && <p className="notice-line">no gate is open on this run. <Link to={runHref}>back to the run</Link></p>}
        {gate.error !== null && gate.status !== 404 && <p className="error-line">{gate.error}</p>}
      </div>
    );
  }

  const view = gate.data;
  const imagesArtifact = view.artifacts.find((a) => a.kind === "images");

  return (
    <div className="gate">
      <div className="gate-head">
        <h1>
          <Link className="link-plain" to={runHref}>◂ the run</Link>{" "}
          <span className="mono">{view.stepId}</span>
        </h1>
        <div className="gate-meta mono">
          {view.episodeId} · attempt {view.attempt}{view.maxAttempts !== undefined ? ` of ${view.maxAttempts}` : " (no cap)"} · opened {view.openedAt.slice(0, 19).replace("T", " ")}
        </div>
      </div>

      {moved !== null && (
        <div className="banner banner-amber">
          <strong>{moved}</strong>
          <span> Your answer was refused, not applied. The message below is attempt {view.attempt}.</span>
        </div>
      )}
      {changed && moved === null && (
        <div className="banner">
          <span>this run has written to its log since you opened the gate — the message here is still attempt {view.attempt}</span>
          <button type="button" className="btn btn-small" onClick={reload}>reload the gate</button>
        </div>
      )}
      {gone !== null && <div className="banner banner-amber"><strong>{gone}</strong></div>}

      <section className="gate-message">
        <Markdown text={view.message} className="pane pane-tall" />
      </section>

      {view.rejections.length > 0 && (
        <section className="gate-rejections">
          <h2>what you have already said about this one</h2>
          <ol className="rejection-list">
            {view.rejections.map((note, i) => (
              <li key={i}><span className="quiet mono">attempt {i + 1}</span><div className="rejection-note">{note}</div></li>
            ))}
          </ol>
        </section>
      )}

      <section className="gate-verdicts">
        <h2>what the reviewers found</h2>
        <Verdicts verdicts={view.verdicts} onQuote={quote} />
      </section>

      <section className="gate-artifacts">
        <h2>what the gate is about</h2>
        {view.artifacts.length === 0 && (
          <p className="quiet">
            this gate names no artifacts — the table in <span className="mono">server/gates.ts</span> is keyed on the
            gate's step id, so a renamed gate shows an empty list rather than the wrong file
          </p>
        )}
        {view.artifacts.map((artifact) => (
          <div className="artifact" key={`${artifact.kind}:${artifact.url}`}>
            <div className="artifact-head">
              <span className="artifact-kind">{artifact.kind}</span>
              <span className="artifact-label mono">{artifact.label}</span>
              {artifact.listUrl === undefined && (
                <a className="btn btn-small" href={artifact.url} download>download</a>
              )}
            </div>
            {artifact.kind === "markdown" && <MarkdownArtifact url={artifact.url} />}
            {artifact.kind === "diff" && <DiffArtifact url={artifact.url} />}
            {(artifact.kind === "json" || artifact.kind === "text") && <TextArtifact url={artifact.url} json={artifact.kind === "json"} />}
            {artifact.kind === "audio" && <AudioArtifact artifact={artifact} />}
            {artifact.kind === "video" && (
              <video className="artifact-video" src={artifact.url} controls preload="metadata" />
            )}
            {artifact.kind === "images" && artifact.listUrl !== undefined && (
              <ContactSheet
                url={artifact.url}
                listUrl={artifact.listUrl}
                flags={flags}
                onFlagsChange={applyFlags}
              />
            )}
            {artifact.kind === "images" && artifact.listUrl === undefined && (
              <p className="error-line">this images artifact names a file rather than a directory, which the gate table should never produce</p>
            )}
          </div>
        ))}
      </section>

      <section className="gate-answer">
        <h2>your answer</h2>
        {imagesArtifact !== undefined && (
          <p className="quiet">
            flagging a shot above writes a line into the notes, which is what the fix agent reads. Blank reasons mean
            "redo".
          </p>
        )}
        <label htmlFor="gate-notes">notes</label>
        <AutoTextarea
          id="gate-notes"
          value={notes}
          onChange={setNotes}
          placeholder="what is wrong, in the words the fix agent should act on. Required to reject; optional to approve."
          rows={4}
        />
        <div className="action-row">
          <button
            type="button"
            className="btn btn-primary btn-big"
            disabled={busy !== null || gone !== null}
            onClick={() => { void answer(true); }}
          >
            {busy === "approve" ? "approving…" : `approve attempt ${view.attempt}`}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-big"
            disabled={busy !== null || gone !== null || notes.trim() === ""}
            onClick={() => { void answer(false); }}
          >
            {busy === "reject" ? "rejecting…" : `reject attempt ${view.attempt}`}
          </button>
          {notes.trim() === "" && <span className="action-reason">a rejection needs notes — the fix agent has nothing else to go on</span>}
        </div>
        {error !== null && <p className="error-line">{error}</p>}
      </section>
    </div>
  );
}

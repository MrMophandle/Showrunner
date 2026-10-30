import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { GateArtifact, GateView } from "../../shared/types.js";
import { ApiError, editHref, post, showHref, showPath, useApi, useConsole, useSSE, useShowKey, useTextApi, type DirEntry } from "../api.js";
import { composeNotesWithFlags, gateSummaryLine, readOnlyLine } from "../projections.js";
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
 *  **The order of the page is a ruling** (2026-10-15, at the s02e01 script gate): the artifact
 *  panes first, then the reviewers' verdict board, then the notes of previous rejections, then the
 *  answer — and **the gate's message last, behind one expander**. The page used to open on the
 *  message, which for a script gate is a sentence naming the file and then seven reviewers'
 *  verdicts as raw JSON, with the script itself below the fold. The decision is about the artifact,
 *  so the artifact is what the page opens on; the message is one click away, and its summary line
 *  carries its first sentence so the collapsed state still says what the gate is about.
 *
 *  The three banners stay above all of it, because every one of them is about *which attempt* is
 *  being answered, which is the one thing on this page that must not be scrolled past.
 *
 *  How long is between opening and answering: a gate is read on a couch, and the answer may be
 *  twenty minutes later.
 *
 *  **A read-only show renders the gate and no answer**, with one line naming the key in place of
 *  the two buttons: the server answers 403 to every POST to such a show (ruling H-03), so the
 *  gate here is a record of a question somebody else answered rather than a question addressed to
 *  this reader. Every artifact url on this page is built by the server and already carries the
 *  show (`server/gates.ts`'s `artifactUrl`), so the panes need nothing of this page's. */

/** How long the page waits before taking the operator to the run view after the engine says the
 *  gate is not open at all — long enough to read the sentence that says why. */
const REDIRECT_MS = 2_000;

/** A gate's markdown artifact: the outline, the script, the image sheet, the canon ledger. In a
 *  pane with its own scrollbar, because a script is four hundred lines and the Approve button has
 *  to stay reachable.
 *
 *  `version` changes when a `file` message names this pane's path — the editor saved it — and the
 *  pane refetches, so the gate shows the saved text without a reload: one file, one version
 *  (Ryan, 2026-10-27).
 *
 *  Compared against a ref rather than taken as this component's `key`, which is the other way to
 *  make a prop force a reread. A changed key unmounts the pane and mounts a new one, and the new
 *  one starts with `useTextApi`'s `data` at null: the text vanishes for the length of the fetch
 *  and the reader's position inside a four-hundred-line script goes with it. Refetching in place
 *  leaves the old text on screen until the new bytes arrive. `seen` starts at the first `version`,
 *  so the mount's own fetch is not immediately followed by a second one. */
function MarkdownArtifact({ url, version }: { url: string; version: string }) {
  const file = useTextApi(url);
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    file.refetch();
  }, [version, file]);
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
/** A json or plain-text artifact is reference, not the thing the gate asks about — the manifest at
 *  the casting gate, the publish kit at the final gate — and several hundred lines of it above the
 *  takes was what the operator had to scroll past to reach the voices (Ryan, 2026-10-30). It opens
 *  collapsed, one click away, with its size in the summary so the click is informed. */
function TextArtifact({ url, json, label }: { url: string; json: boolean; label: string }) {
  const file = useTextApi(url);
  if (file.error !== null && file.data === null) return <p className="error-line">{file.error}</p>;
  if (file.data === null) return <p className="quiet">reading…</p>;
  let text = file.data;
  if (json) {
    try { text = JSON.stringify(JSON.parse(file.data), null, 2); } catch { /* shown as it came */ }
  }
  const lines = text.split("\n").length;
  return (
    <details className="gate-message">
      <summary>{label} — {lines} lines, collapsed</summary>
      <pre className="pane mono">{text}</pre>
    </details>
  );
}

/** An audio artifact, which is either one file or a directory of them (`casting-gate`'s
 *  `guest-refs/`). The directory case is the reason `listUrl` exists: one route serves both a file
 *  and a listing, so the presence of `listUrl` is the only unambiguous test for a directory
 *  (`shared/types.ts`'s `GateArtifact`). */
/** The files in a reference directory that are audio. A guest's directory also holds the
 *  transcript the showrunner wrote beside the take (`<guest-slug>.txt`, per the TTS script
 *  prompt's convention), and listing that as a player offered a text file to play (Ryan,
 *  2026-10-30). Exported for the test. */
export const AUDIO_FILE = /\.(wav|mp3|flac|m4a|ogg|aac)$/i;

/** The transcript file a take's name points at: `veleth-1.wav` and `veleth-2.wav` both belong to
 *  `veleth.txt` — the candidate number is stripped with the extension. Exported for the test. */
export function transcriptFor(audioName: string): string {
  return `${audioName.replace(/\.[^.]+$/, "").replace(/-\d+$/, "")}.txt`;
}

/** The transcript under a take: what the voice is saying in the reference, so the operator hears
 *  the words against the text while auditioning. */
function Transcript({ url }: { url: string }) {
  const file = useTextApi(url);
  if (file.data === null) return null;
  return <p className="quiet audio-transcript">{file.data.trim()}</p>;
}

/** The last segment of a show-relative path — `pim-2.wav` out of
 *  `Production/s02e01/guest-refs/pim-2.wav`. What the operator listened to is a take's name, so
 *  that is what a sentence about a casting says; the whole path is what the answer carries. */
function basename(showRelative: string): string {
  return showRelative.slice(showRelative.lastIndexOf("/") + 1);
}

/** The guest-reference directory at the casting gate: **a choice, not a listening test** (Ryan's
 *  ruling, 2026-10-30, "it was more 'listening to the choices' and less 'pick a choice' kinda
 *  page"). Each guest gets a fieldset with a radio per take, the manifest's take preselected, and
 *  Approve carries the picks into `tts-script.json` — the defect this closes is that an approve
 *  note naming takes ("approved, hallet2 and veleth2") was read by nothing and the render that
 *  followed used whatever the manifest already said.
 *
 *  **A take is grouped with a guest by the transcript its name points at**: `transcriptFor` strips
 *  the candidate number and the extension, so `warden-1.wav` and `warden-2.wav` both reduce to
 *  `warden.txt` and both belong to the guest whose slug is `warden` — the engine's own `slugName`,
 *  which is the function the `refs-ready` guard globs these files by (`shared/types.ts`'s
 *  `CastingGuest`). A take that reduces to no guest's slug belongs to nobody in this cast: it is
 *  listed after the fieldsets exactly as every take was listed before, audible and not pickable.
 *
 *  **Every url is the artifact's own and every pick value is `artifact.path`'s.** The casting
 *  block's `dir` is a show-relative path the server hands over unfenced, and the one place that
 *  knows the artifact route's shape is `artifactUrl` on the server (`server/gates.ts`) — so the
 *  listing, the players and the transcripts are built from `artifact.url`/`artifact.listUrl`, and
 *  a pick is `${artifact.path}/<take>`, which names the same file as the radio beside it. */
function AudioArtifact({ artifact, casting, picks, onPick }: {
  artifact: GateArtifact;
  casting: GateView["casting"];
  picks: Record<string, string>;
  onPick: (guest: string, take: string) => void;
}) {
  const listing = useApi<{ entries: DirEntry[] }>(artifact.listUrl ?? null);
  if (artifact.listUrl === undefined) return <AudioSeek src={artifact.url} label={artifact.label} />;
  if (listing.error !== null && listing.data === null) return <p className="error-line">{listing.error}</p>;
  if (listing.data === null) return <p className="quiet">reading the directory…</p>;
  const files = listing.data.entries.filter((e) => !e.isDir);
  const takes = files.filter((e) => AUDIO_FILE.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const transcripts = new Set(files.filter((e) => /\.txt$/i.test(e.name)).map((e) => e.name));
  if (takes.length === 0) return <p className="quiet">no audio in this directory yet</p>;

  /** One take as it sounds: the player and, under it, the words it was read from. The same two
   *  elements inside a guest's fieldset and outside every fieldset, so a take nobody claims is
   *  drawn exactly as it was before this page had a choice on it. */
  function player(entry: DirEntry) {
    const txt = transcriptFor(entry.name);
    return (
      <>
        <AudioSeek src={`${artifact.url}/${encodeURIComponent(entry.name)}`} label={entry.name} />
        {transcripts.has(txt) && <Transcript url={`${artifact.url}/${encodeURIComponent(txt)}`} />}
      </>
    );
  }

  const groups = (casting?.guests ?? []).map((guest) => ({
    guest,
    own: takes.filter((e) => transcriptFor(e.name) === `${guest.slug}.txt`),
  }));
  const claimed = new Set(groups.flatMap((g) => g.own.map((e) => e.name)));
  const unclaimed = takes.filter((e) => !claimed.has(e.name));

  return (
    <div className="audio-list">
      {groups.map(({ guest, own }) => {
        // The preselection is path equality with what the manifest casts, and nothing else: a
        // manifest naming a take that has been renamed or recorded elsewhere leaves every radio
        // unchecked and says so, because checking the first take instead would invent a choice
        // nobody made and Approve would then carry it.
        const cast = own.some((e) => `${artifact.path}/${e.name}` === guest.current);
        return (
          <fieldset className="cast-guest" key={guest.name}>
            <legend>{guest.name}</legend>
            {!cast && <p className="quiet">the manifest casts {basename(guest.current)}, which is not in this directory</p>}
            {own.length === 0 && <p className="quiet">no take in this directory is named for {guest.name}</p>}
            {own.map((entry) => {
              const take = `${artifact.path}/${entry.name}`;
              const id = `pick-${guest.slug}-${entry.name}`;
              return (
                <div className="cast-take" key={entry.name}>
                  <label htmlFor={id}>
                    <input
                      id={id}
                      type="radio"
                      name={`pick-${guest.slug}`}
                      value={take}
                      checked={picks[guest.name] === take}
                      onChange={() => { onPick(guest.name, take); }}
                    />
                    {" "}{entry.name}
                  </label>
                  {player(entry)}
                </div>
              );
            })}
          </fieldset>
        );
      })}
      {unclaimed.map((entry) => <div key={entry.name}>{player(entry)}</div>)}
    </div>
  );
}

export function Gate() {
  const params = useParams();
  const showKey = useShowKey();
  const episodeId = params["id"] ?? "";
  const runId = params["run"] ?? "";
  const base = showPath(showKey, `/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}`);
  const runHref = showHref(showKey, `/episodes/${episodeId}/runs/${runId}`);
  const gate = useApi<GateView>(`${base}/gate`);
  const navigate = useNavigate();
  const { canAct, readOnly } = useConsole();

  const [notes, setNotes] = useState("");
  const [flags, setFlags] = useState<Record<string, string>>({});
  // The block this page last composed into the notes, so it can be replaced rather than appended
  // to. A ref and not state: nothing renders from it, and it must be current inside the same
  // handler that just set the notes.
  const composed = useRef("");
  // Which take the showrunner has chosen for each guest at the casting gate, by the manifest's own
  // cast name. Approve carries this map; see the seeding effect below and `answer`.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  // The hash each edited file is at, by show-relative path, as the `file` messages for this run
  // have reported it. A pane reads its own path out of this map and refetches when the string it
  // finds there changes, so one save refetches one pane and leaves the others alone.
  const [fileVersions, setFileVersions] = useState<Record<string, string>>({});
  const redirect = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (redirect.current !== null) clearTimeout(redirect.current); }, []);

  // **The picker starts where the manifest is.** The radios are drawn from `picks` alone, so an
  // empty map would open a casting gate with nothing selected even though `tts-script.json`
  // already casts a take for every guest — the page would hide what is cast and the sentence
  // beside Approve would have nothing to name. Seeding also makes the posted picks a full
  // restatement of the casting rather than only the guests the operator happened to touch.
  //
  // Keyed on the casting block itself, which is a new object on every fetch of the gate view and
  // the same object between renders: a reload or a "the gate moved" refetch re-seeds from the
  // manifest as it now stands, and nothing else does.
  const casting = gate.data?.casting;
  useEffect(() => {
    if (casting === undefined) return;
    setPicks(Object.fromEntries(casting.guests.map((guest): [string, string] => [guest.name, guest.current])));
  }, [casting]);

  // A notice, never a refetch, for the run's log: see the file header. A `file` message is the one
  // exception, and it is not an exception to the ruling — it says a file this gate is about was
  // saved through the console's own editor, which is this page's reader editing the thing they are
  // reading, not the pipeline moving underneath them. `hello` and `episodes` carry no run, so both
  // kinds are narrowed before the run is compared.
  useSSE((message) => {
    if (message.type !== "run" && message.type !== "file") return;
    if (message.show !== showKey || message.episodeId !== episodeId || message.runId !== runId) return;
    if (message.type === "run") setChanged(true);
    else setFileVersions((versions) => ({ ...versions, [message.path]: message.hash }));
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
      await post(`${base}/gate`, {
        stepId: view.stepId, approved, notes, expectedAttempt: view.attempt,
        // The picks ride on an approval and on nothing else. A rejection sends the manifest back
        // to the casting fix agent, so writing a cast list into it on the way out would be editing
        // the file the agent is about to be told is wrong. The server writes an accepted pick
        // before it answers the gate, and refuses the whole answer for a bad one (`server/app.ts`).
        ...(approved && view.casting !== undefined ? { picks } : {}),
      });
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
  // What the collapsed message says about itself: its first line, which every gate template makes
  // the sentence naming what is ready and where ("Script drafted: Episodes/s02e01/script.md").
  const messageSummary = gateSummaryLine(view.message);

  return (
    <div className="gate">
      <div className="gate-head">
        <h1>
          <Link className="link-plain" to={runHref}>◂ the run</Link>{" "}
          <span className="mono">{view.stepId}</span>
        </h1>
        <div className="gate-meta mono">
          {view.episodeId} · attempt {view.attempt}{view.maxAttempts !== undefined ? ` of ${view.maxAttempts}` : " (no cap)"}
          {/* How many rounds the review panel took to come back green and what they cost. It sits
              beside the attempt because `script-gate` opens only on a green panel (Plan J, ruling
              7), so "how many rounds did this take" is the question that stands next to "which
              attempt am I answering" — and the head is the part of this page the ruling of
              2026-10-15 keeps above the fold. Four decimals, which is the format the console
              already prints a money figure in (`src/pages/WhatHappened.tsx`). Absent for every gate
              no panel precedes, which reads exactly as it did before Plan J. */}
          {view.round !== undefined && ` · round ${view.round.n} · $${view.round.costUsd.toFixed(4)}`}
          {" · "}opened {view.openedAt.slice(0, 19).replace("T", " ")}
        </div>
      </div>

      {moved !== null && (
        <div className="banner banner-amber">
          <strong>{moved}</strong>
          <span> Your answer was refused, not applied. What this page is showing you is attempt {view.attempt}.</span>
        </div>
      )}
      {changed && moved === null && (
        <div className="banner">
          <span>this run has written to its log since you opened the gate — the message here is still attempt {view.attempt}</span>
          <button type="button" className="btn btn-small" onClick={reload}>reload the gate</button>
        </div>
      )}
      {gone !== null && <div className="banner banner-amber"><strong>{gone}</strong></div>}

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
              {/* Editable from the gate it is being read at (Ryan's ruling, 2026-10-27), and only
                  where this console may write: a read-only show refuses the editor's POST the way
                  it refuses the answer (ruling H-03), so offering the link there would be offering
                  a button that is refused.

                  The link asks first when the notes box has words in it. Opening the editor is an
                  in-app navigation that unmounts this page, and a rejection's notes exist nowhere
                  but that box until the answer is posted — so the operator who types three
                  paragraphs and then clicks edit to look at the line they are describing would
                  lose all of it with nothing to fire on. */}
              {artifact.kind === "markdown" && canAct && (
                <Link
                  className="btn btn-small"
                  to={editHref(showKey, episodeId, runId, artifact.path)}
                  onClick={(e) => {
                    if (notes.trim() !== "" && !window.confirm("You have typed rejection notes. Leave them behind and open the editor?")) e.preventDefault();
                  }}
                >edit</Link>
              )}
            </div>
            {artifact.kind === "markdown" && <MarkdownArtifact url={artifact.url} version={fileVersions[artifact.path] ?? ""} />}
            {artifact.kind === "diff" && <DiffArtifact url={artifact.url} />}
            {(artifact.kind === "json" || artifact.kind === "text") && <TextArtifact url={artifact.url} json={artifact.kind === "json"} label={artifact.label} />}
            {artifact.kind === "audio" && (
              <AudioArtifact
                artifact={artifact}
                casting={view.casting}
                picks={picks}
                onPick={(guest, take) => { setPicks((current) => ({ ...current, [guest]: take })); }}
              />
            )}
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

      <section className="gate-verdicts">
        <h2>what the reviewers found</h2>
        <Verdicts verdicts={view.verdicts} onQuote={quote} />
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
        {/* What Approve is about to do, in words, immediately above the button that does it: the
            picks are radios several screens up by the time a directory of takes has been listened
            to, and "approve" with no restatement of the casting would be answered from memory. The
            take's name and not its path, because the name is what was listened to. A guest the
            operator has not touched reads as the manifest's own casting, which is what the seeded
            picks hold. */}
        {view.casting !== undefined && (
          <p className="quiet">
            Approve casts {view.casting.guests.map((guest) => `${guest.name} from ${basename(picks[guest.name] ?? guest.current)}`).join(", ")}.
          </p>
        )}
        <div className="action-row">
          {readOnly && <span className="action-reason">{readOnlyLine(showKey, "this gate is read here and answered where the show is writable")}</span>}
          {canAct && (
              <>
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
              </>
          )}
        </div>
        {error !== null && <p className="error-line">{error}</p>}
      </section>

      {/* The gate's message, last and collapsed: the ruling of 2026-10-15, made at the s02e01
          script gate, where this page opened on seven reviewers' verdicts as raw JSON and the
          script was below the fold. The artifact is what the decision is about; the message is the
          log-like text that says which artifact and what the reviewers made of it, and it is one
          click away rather than in the way.

          A native `details` and no state of this page's: the reader's own toggle is the browser's
          to remember, and React patches `open` only when the rendered value changes — which it
          does not do on an SSE notice, the one thing that re-renders this page (the file header's
          "a notice, never a refetch"). **Open only for a gate with no artifact at all**, so a gate
          whose step id the artifact table does not know still shows its message without a click.

          The summary carries the message's first line (`gateSummaryLine`), because a collapsed
          expander that said only "the gate's message" would hide the one sentence naming what is
          ready. The scrolling container inside it is what keeps a message with four-hundred-column
          verdict JSON from scrolling the whole page sideways. */}
      <details className="gate-message" open={view.artifacts.length === 0}>
        <summary>the gate's message{messageSummary === "" ? "" : ` — ${messageSummary}`}</summary>
        <div className="gate-message-scroll">
          <Markdown text={view.message} className="pane pane-tall" />
        </div>
      </details>
    </div>
  );
}

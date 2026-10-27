import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FileRead, FileWritten } from "../../shared/types.js";
import { ApiError, filePath, post, showHref, useApi, useConsole, useSSE, useShowKey } from "../api.js";
import { readOnlyLine } from "../projections.js";
import { Markdown } from "../components/Markdown.js";

/** The editor for one markdown artifact of a run's open gate — the outline, the script, the image
 *  sheet, the canon ledger — reached from the Edit link on the gate's pane.
 *
 *  **One file, one version (Ryan, 2026-10-27).** The box holds the file on disk and nothing else
 *  holds a copy: Save writes the file the gate page reads, the server publishes a `file` message,
 *  and the gate's pane refetches. The hash the page read goes back with the save as `baseHash`,
 *  so a save over a file that changed underneath — another tab, a worker — is refused (409) and
 *  the typed text stays in the box for the showrunner to reconcile, never silently overwritten and
 *  never silently discarded.
 *
 *  **Nothing takes the typed text out of the box without the showrunner saying so, by one of three
 *  paths.** The "load the current text" button discards it on purpose, and is the only path that
 *  does so without a second question. The "Back to the gate" link is an in-app navigation that
 *  unmounts this page, so the link itself asks before it goes — `beforeunload` does not fire on a
 *  `pushState`, and nothing else would notice. A document unload — a reload, a tab closed, an
 *  address typed over this one — is caught by the `beforeunload` handler below, which is the
 *  browser's own dialog.
 *
 *  **The browser's Back button is not guarded.** react-router's `useBlocker` is the thing that
 *  would guard it and it exists only on a data router; the console mounts `BrowserRouter` around
 *  `Routes` (`src/main.tsx`), so a popstate unmounts this page with no question asked. Converting
 *  the app to a data router is the fix and is not this page's to make.
 *
 *  Everything else that could reach into the box — a re-render, a `file` notice from another
 *  editor, a refused save — leaves it alone. The `loaded` ref is what enforces that: it holds the
 *  hash the box was last filled from, so the fill effect runs once per distinct read and never
 *  again, and clearing it is how the page says "the next read may refill the box".
 *
 *  The preview is the same renderer the gate's pane uses, fed from the box as it is typed: what
 *  the showrunner sees on the right is what the gate will show. */
export function Edit() {
  const params = useParams();
  const showKey = useShowKey();
  const episodeId = params["id"] ?? "";
  const runId = params["run"] ?? "";
  // The splat is the show-relative path, which react-router hands back decoded — the slashes are
  // separators again and a `%20` is a space, which is the form the server's `file` notice names
  // the file by and the form `filePath` re-encodes for the fetch.
  const showRelative = params["*"] ?? "";
  const { canAct, readOnly } = useConsole();
  const api = filePath(showKey, episodeId, runId, showRelative);
  const gateHref = showHref(showKey, `/episodes/${encodeURIComponent(episodeId)}/runs/${encodeURIComponent(runId)}/gate`);
  const file = useApi<FileRead>(api);

  /** What is in the box. Null until the first read answers. */
  const [text, setText] = useState<string | null>(null);
  /** What was last written or read — the text the box is compared against to know it is dirty. */
  const [saved, setSaved] = useState<string | null>(null);
  /** The hash of the bytes on disk as this page last knew them, which the next save carries back
   *  as `baseHash`. */
  const [hash, setHash] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The sentence beside the "load the current text" button: either the server's own refusal of a
   *  stale save, or this page's notice that the file was written elsewhere while it was being
   *  edited. Null when the box and the disk are not in conflict. */
  const [conflict, setConflict] = useState<string | null>(null);
  const loaded = useRef<string | null>(null);

  // The box is filled from the first successful read, and refilled only when the showrunner
  // asks ("load the current text") — a refetch must never replace what is being typed.
  useEffect(() => {
    if (file.data === null || loaded.current === file.data.hash) return;
    loaded.current = file.data.hash;
    setText(file.data.text);
    setSaved(file.data.text);
    setHash(file.data.hash);
    setConflict(null);
  }, [file.data]);

  const dirty = text !== null && text !== saved;

  // Another save of this file — another tab, another editor, the showrunner's own hand — arrives
  // as a `file` message. The message names no author, so the hash is the whole test: one the page
  // already holds is the echo of its own save. With nothing typed, follow the disk; with edits in
  // the box, say so and leave the box alone.
  useSSE((message) => {
    if (message.type !== "file" || message.show !== showKey || message.episodeId !== episodeId || message.runId !== runId || message.path !== showRelative) return;
    if (message.hash === hash) return;
    if (!dirty) { file.refetch(); return; }
    setConflict("This file was saved elsewhere while you were editing. Save will be refused until you load the current text; your edits stay in the box until then.");
  });

  // Unsaved text lives in this box and nowhere else. This handler covers the unload of the
  // document — a reload, a tab closed, an address typed over this one — and the browser puts up
  // its own dialog. The in-app route change is a different event and is guarded on the link
  // itself; the Back button is guarded by neither (see this page's header comment).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      // Safari acts on the legacy `returnValue` and not on `preventDefault` alone. The string is
      // never shown — every browser prints its own wording — so an empty one is the whole ask.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => { window.removeEventListener("beforeunload", warn); };
  }, [dirty]);

  async function save(): Promise<void> {
    if (text === null || hash === null || !dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const written = await post<FileWritten>(api, { text, baseHash: hash });
      setHash(written.hash);
      // The save's own `file` notice carries this hash; recording it here is what keeps that echo
      // from refilling the box.
      loaded.current = written.hash;
      setSaved(text);
      setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setConflict(null);
    } catch (err) {
      // The file route answers 409 for two refusals that have nothing to do with each other, and
      // the body is what tells them apart: the staleness refusal carries the file's current
      // `hash`, the worker-lock refusal carries no `hash` at all. Only the first is a fork in the
      // road rather than an error — it goes in the notice beside the button that acts on it, in
      // the server's own wording, and not in the error line as well, so the operator reads that
      // refusal once. Everything else, the lock 409 included, is an error line and leaves the box
      // and the notice as they were: a run that is busy is no reason to offer to discard an edit.
      if (err instanceof ApiError && err.status === 409 && typeof err.body?.["hash"] === "string") setConflict(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Cmd/Ctrl+S, because the habit is universal and the browser's own Save-page dialog over a
  // half-typed script is the worst answer to it. Registered on every render rather than once, so
  // the handler closes over the current text and hash.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  });

  /** The filename alone, which is what the box is labelled with; the whole path is beside it in
   *  the header for the reader who needs to know which `script.md` this is. */
  const label = showRelative.split("/").pop() ?? showRelative;

  if (file.error !== null && file.data === null) {
    return (
      <section className="editor">
        <p className="error-line">{file.error}</p>
        <Link to={gateHref}>Back to the gate</Link>
      </section>
    );
  }
  if (text === null) return <p className="quiet">reading…</p>;

  const status = busy ? "saving…"
    : dirty ? "unsaved changes"
    : savedAt !== null ? `saved ${savedAt}`
    : "no changes";

  return (
    <section className="editor">
      <header className="editor-head">
        {/* The one in-app navigation this page offers, and the one the showrunner is likeliest to
            take with a half-typed scene in the box. Leaving unmounts the page and the text is
            gone, so the link asks — `beforeunload` is not fired by a route change. */}
        <Link
          to={gateHref}
          className="btn btn-small"
          onClick={(e) => {
            if (dirty && !window.confirm("You have unsaved changes. Leave without saving?")) e.preventDefault();
          }}
        >Back to the gate</Link>
        <span className="mono editor-path">{showRelative}</span>
        {canAct && (
          <button type="button" className="btn" disabled={!dirty || busy} onClick={() => { void save(); }}>Save</button>
        )}
        <span className="quiet">{status}</span>
        {error !== null && <span className="error-line">{error}</span>}
        {/* A read that failed after the first one succeeded — the gate closed while the editor
            was open, so "load the current text" has nothing to load. The early return above
            covers only the first read, and without this line the button would do nothing visible
            at all. */}
        {file.error !== null && <span className="error-line">{file.error}</span>}
      </header>
      {readOnly && <p className="action-reason">{readOnlyLine(showKey, "this file is read here and edited where the show is writable")}</p>}
      {conflict !== null && (
        <p className="editor-notice">
          {conflict}{" "}
          <button type="button" className="btn btn-small" onClick={() => { loaded.current = null; file.refetch(); }}>load the current text</button>
        </p>
      )}
      <div className="editor-split">
        <textarea
          className="editor-text mono"
          aria-label={label}
          value={text}
          readOnly={!canAct}
          spellCheck
          onChange={(e) => { setText(e.target.value); }}
        />
        <Markdown text={text} className="editor-preview" />
      </div>
    </section>
  );
}

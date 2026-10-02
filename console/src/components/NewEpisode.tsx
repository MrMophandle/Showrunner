import { useState } from "react";
import { post } from "../api.js";

/** The New episode form: an id and a premise, which is the whole of what an episode is before a
 *  run has touched it.
 *
 *  It writes one file — `<episodesDir>/<id>/premise.md` — and the server writes it with the `wx`
 *  flag, so two operators creating the same episode cannot both believe they did. An id that
 *  already has a premise is refused with the server's own message ("edit the premise rather than
 *  creating the episode again"), and that refusal is shown as it came: this form is deliberately
 *  not an editor. Editing an existing premise is a file on a disk the operator has, and a console
 *  that offered to overwrite it would be the one thing in this program that could lose the
 *  showrunner's own writing. */
export function NewEpisode({ episodesDir, onCreated }: { episodesDir: string; onCreated: (id: string) => void }) {
  const [id, setId] = useState("");
  const [premise, setPremise] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await post("/api/episodes", { id: id.trim(), premise });
      setNotice(`${episodesDir}/${id.trim()}/premise.md written`);
      onCreated(id.trim());
      setId("");
      setPremise("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="new-episode">
      <summary>new episode</summary>
      <form
        className="new-episode-form"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <label htmlFor="new-id">id</label>
        <input
          id="new-id"
          className="mono"
          type="text"
          placeholder="s02e04"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={id}
          onChange={(e) => { setId(e.target.value); }}
        />
        <label htmlFor="new-premise">premise</label>
        <textarea
          id="new-premise"
          rows={4}
          placeholder="what the episode is about — the one paragraph the outline is written from"
          value={premise}
          onChange={(e) => { setPremise(e.target.value); }}
        />
        <div className="action-row">
          <button type="submit" className="btn btn-primary" disabled={busy || id.trim() === "" || premise.trim() === ""}>
            {busy ? "creating…" : "create the episode"}
          </button>
          <span className="action-reason">writes {episodesDir}/{id.trim() === "" ? "<id>" : id.trim()}/premise.md and nothing else</span>
        </div>
        {notice !== null && <p className="notice-line">{notice}</p>}
        {error !== null && <p className="error-line">{error}</p>}
      </form>
    </details>
  );
}

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, bibleHref, post, useSSE, useShows } from "../api.js";
import { showSlugFrom } from "../projections.js";

/** The New-show page: the seven fields that make a show, and the one POST that makes it.
 *
 *  This is the surface Plan G's setup was missing. `showrunner-init` asks the same questions on a
 *  terminal and then holds a thirteen-file interview open for the hour it takes; here the form
 *  creates the show and hands the author straight to its Bible page, where each file is interviewed
 *  one request at a time (ruling H-04: the writing itself runs in a detached setup worker, never in
 *  the server).
 *
 *  **`POST /api/shows` is written as a literal and not through `showPath`**, which is the one place
 *  in this client that is true: every other call addresses one registered show
 *  (`/api/shows/<key>/…`), and this one addresses the collection, because the show it is about does
 *  not exist yet.
 *
 *  **The three derived fields follow the name until the author edits one of them.** The slug, the
 *  NAS root and the registry key are all functions of what has been typed above them, and they are
 *  shown rather than derived silently because the slug is rendered into `output.mixFilename` and
 *  into the names of files on the NAS, and the key becomes the segment of every url for this show.
 *  Once a field has been touched it stops following, because a form that recomputed an edited field
 *  would overwrite the author's own slug on their next keystroke in the name.
 *
 *  **What this form deliberately does not offer.** No `engineRoot` field: the route takes it from
 *  the console's own `--engine-root` (`server/app.ts`'s `NewShowDeps`), and a form that let the
 *  author name a different engine would be a form that can scaffold a show against an engine this
 *  server is not running. No `resume` field either: resuming an interrupted setup *is* the Bible
 *  page (ruling H-06 — every answer is on disk the moment it is saved and the approval is in the
 *  log, so closing a tab loses nothing), and `POST /api/shows` does not accept the flag. */

/** The name of a field, which is also the key the body carries it under. `key` is the registry's
 *  and the other six are `InitOptions`'. */
type Field = "name" | "slug" | "path" | "nasRoot" | "key" | "importFrom";

/** The grammar the server applies to the registry key, copied here so the form can say "that is
 *  not a key" while it is being typed rather than after the POST.
 *
 *  A copy of `SHOW_KEY` in `console/server/registry.ts`, which the client cannot import (that
 *  module reads the filesystem). The server validates it again — this is a label, not a fence. */
const SHOW_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The NAS parent every show's own directory sits under, as `tools/src/init/init.ts`'s
 *  `NAS_PARENT` has it. Shown as a prefill and editable, because the mount is a property of the
 *  machine and a show made on a laptop with no NAS attached still has to be made. */
const NAS_PARENT = "/Volumes/media";

export function NewShow() {
  const navigate = useNavigate();
  const shows = useShows();
  const [values, setValues] = useState<Record<Field, string>>({
    name: "", slug: "", path: "", nasRoot: "", key: "", importFrom: "",
  });
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [github, setGithub] = useState<"private" | "public" | "none">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);

  // The channel, for the one reason this page needs it: it opens with its first subscriber, and
  // without one the header's live dot reads "offline" on a page that is perfectly connected (Task
  // 4's report, concern 2). A `hello` also carries the server's own list of shows, which is the
  // list the taken-key warning below is read against.
  useSSE((message) => {
    if (message.type === "hello") shows.refetch();
  });

  // The three derived fields. Each is the author's own value once they have touched it, and a
  // function of what is above it until then.
  const slug = touched.slug === true ? values.slug : showSlugFrom(values.name);
  const nasRoot = touched.nasRoot === true ? values.nasRoot : (slug === "" ? "" : `${NAS_PARENT}/${slug}`);
  const basename = values.path.replace(/\/+$/, "").split("/").pop() ?? "";
  const key = touched.key === true ? values.key : basename;

  function set(field: Field, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
    setTouched((current) => ({ ...current, [field]: true }));
  }

  const taken = (shows.data ?? []).some((show) => show.key === key);
  const keyShaped = key === "" || SHOW_KEY.test(key);
  const ready = values.name.trim() !== "" && values.path.trim() !== "" && key !== "" && keyShaped && !taken;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // Only the fields that were filled in are sent. The route refuses an optional field that is
      // present and empty (`"<field> must be a non-empty string when it is given"`), and an absent
      // `slug` or `nasRoot` is how `initScaffold` applies its own defaults — which are the two
      // values this form is showing, so sending them changes nothing but makes the request carry
      // what the author read.
      const created = await post<{ key: string }>("/api/shows", {
        name: values.name.trim(),
        path: values.path.trim(),
        github,
        ...(slug.trim() !== "" ? { slug: slug.trim() } : {}),
        ...(nasRoot.trim() !== "" ? { nasRoot: nasRoot.trim() } : {}),
        ...(values.importFrom.trim() !== "" ? { importFrom: values.importFrom.trim() } : {}),
        ...(key.trim() !== "" ? { key: key.trim() } : {}),
      });
      // `replace` and not `push`: the POST has already created a show, and a Back button that
      // returned the author to this form would invite a second one, which the route answers 409.
      navigate(bibleHref(created.key), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(err instanceof ApiError ? err.status : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="board">
      <div className="board-head">
        <h1>a new show</h1>
        <Link className="btn" to="/">the shows this console holds</Link>
      </div>

      <p className="quiet">
        This writes the show's repository — the config, the fifteen bible templates, the prompts, the first commit — and
        registers it with this console. Nothing is interviewed yet: the next page is the bible, one file at a time.
      </p>

      <form
        className="new-show-form"
        onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}
      >
        <label htmlFor="new-show-name">the show's name, as it is written</label>
        <input
          id="new-show-name"
          value={values.name}
          onChange={(e) => { set("name", e.target.value); }}
          placeholder="Harbor Lights"
          autoComplete="off"
        />

        <label htmlFor="new-show-slug">its slug — every non-alphanumeric character removed, and what names files on the NAS</label>
        <input
          id="new-show-slug"
          className="mono"
          value={slug}
          onChange={(e) => { set("slug", e.target.value); }}
          placeholder="HarborLights"
          autoComplete="off"
        />

        <label htmlFor="new-show-path">the directory the repository is created in</label>
        <input
          id="new-show-path"
          className="mono"
          value={values.path}
          onChange={(e) => { set("path", e.target.value); }}
          placeholder="/Users/you/GitHub/HarborLights"
          autoComplete="off"
        />
        <p className="action-reason">
          It must be empty or absent, and outside this engine's own repository and every show already registered — a show
          lives in a repository of its own.
        </p>

        <label htmlFor="new-show-nas">its NAS root — where the finished episodes are written</label>
        <input
          id="new-show-nas"
          className="mono"
          value={nasRoot}
          onChange={(e) => { set("nasRoot", e.target.value); }}
          placeholder={`${NAS_PARENT}/HarborLights`}
          autoComplete="off"
        />

        <label htmlFor="new-show-key">the registry key — the segment every url for this show carries</label>
        <input
          id="new-show-key"
          className="mono"
          value={key}
          onChange={(e) => { set("key", e.target.value); }}
          placeholder="HarborLights"
          autoComplete="off"
        />
        {/* Two shows can declare the same name and the same slug — both shows this console was
            measured against do (ruling H-02) — so the key is the operator's own name for the show
            and has to be unique. Said here, while it is being typed, rather than as a 409 after the
            author has filled in six other fields. */}
        {!keyShaped && (
          <p className="error-line">
            a key is one letter or digit then letters, digits, underscores and hyphens, up to 64 characters
          </p>
        )}
        {keyShaped && taken && (
          <p className="error-line">
            this console already holds a show keyed <span className="mono">{key}</span> — choose another key
          </p>
        )}

        <fieldset className="new-show-github">
          <legend>a GitHub repository, at the end of the setup</legend>
          {(["private", "public", "none"] as const).map((choice) => (
            <label key={choice} className="new-show-radio">
              <input
                type="radio"
                name="github"
                value={choice}
                checked={github === choice}
                onChange={() => { setGithub(choice); }}
              />
              {choice === "none" ? "none — keep it local" : `${choice}`}
            </label>
          ))}
        </fieldset>

        <label htmlFor="new-show-import">an existing show to offer bible files from, file by file (optional)</label>
        <input
          id="new-show-import"
          className="mono"
          value={values.importFrom}
          onChange={(e) => { set("importFrom", e.target.value); }}
          placeholder="/Users/you/GitHub/AnotherShow"
          autoComplete="off"
        />

        <div className="action-row">
          <button type="submit" className="btn btn-primary btn-big" disabled={!ready || busy}>
            {busy ? "making the show…" : "make the show"}
          </button>
          {!ready && !busy && (
            <span className="action-reason">a name, a directory and a key are required</span>
          )}
        </div>
      </form>

      {error !== null && (
        <p className="error-line">
          {error}
          {status === 409 && " — nothing was written."}
        </p>
      )}
      {shows.error !== null && (
        <p className="action-reason">
          the shows this console holds could not be read ({shows.error}), so a key already in use will be refused by the
          server rather than named here
        </p>
      )}
    </div>
  );
}

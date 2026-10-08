import { Link } from "react-router-dom";
import { bibleHref, showHref, useSSE, useShows } from "../api.js";
import { showsPageIsEmpty } from "../projections.js";

/** The Shows page: every show this console holds, and the way to start another.
 *
 *  This is the console's front door now, and it exists because one server holds every show on the
 *  machine (ruling H-01: a registry file, because it is the only form the New-show surface can
 *  append to and the only one that carries a key the operator chose). The page before this one was
 *  the Board, which could only ever be the Board of the one show the server was started with.
 *
 *  **The key is shown beside the name, in `mono`, and it is not decoration.** The two shows this
 *  console was measured against declare the **same** `showName` and the same `showSlug`, so the
 *  name alone cannot tell them apart (ruling H-02) — the key is the operator's own name for the
 *  show and the segment every url carries.
 *
 *  **A read-only show is marked here rather than only inside it**, because the mark is the answer
 *  to "why is there no Launch button in there": the server refuses every POST to a read-only show,
 *  which is how the retired first repository is listed beside the live instance without one launch
 *  writing over the instance's finals on the NAS root they share (ruling H-03).
 *
 *  **An entry the console could not load is a row here too**, below the shows, with its reason and
 *  no link. It is not a show — its own routes answer 404 — but a console that drew one fewer show
 *  and said nothing was the failure that mattered: the operator who hits it is the one who edits a
 *  `showrunner.json`, restarts the console detached with its output in a log file, and then looks
 *  at the browser rather than at the log. On a machine where every entry failed, this page used to
 *  read exactly like a machine with no shows on it, and the remedy that suggests — registering
 *  every show again — is the wrong one. */
export function Shows() {
  const shows = useShows();
  const rows = shows.data?.shows ?? null;
  const failed = shows.data?.failed ?? [];

  // The page subscribes to the one channel for two reasons, and the second is the smaller one.
  // The first: `hello` carries the server's own list of shows, sent on every connection, so a
  // console restarted with a different registry — or a show registered from another tab once Task
  // 6's form lands — reaches a Shows page that is already open. The second: the channel opens with
  // its first subscriber, and without one the header's live dot would read "offline" on the
  // console's own front page.
  //
  // The refetch is conditional on the keys having actually changed, so the `hello` that arrives
  // one moment after this page's own first fetch is not a second fetch of the same list.
  useSSE((message) => {
    if (message.type !== "hello") return;
    const held = shows.data;
    if (held === null) return;
    // Both lists are in the comparison: a console restarted against a registry whose third entry
    // has stopped loading announces the same two shows and a new `failed` row, and that is a change
    // this page draws.
    const signature = (keys: { key: string }[]) => keys.map((s) => s.key).join("\n");
    const announced = `${signature(message.shows)}\u0000${signature(message.failed)}`;
    if (announced !== `${signature(held.shows)}\u0000${signature(held.failed)}`) shows.refetch();
  });

  return (
    <div className="board">
      <div className="board-head">
        <h1>shows</h1>
        <Link className="btn btn-primary" to="/shows/new">new show</Link>
      </div>

      {shows.error !== null && <p className="error-line">could not read the shows: {shows.error}</p>}
      {rows === null && shows.loading && <p className="quiet">reading the registry…</p>}
      {/* The state a console on a fresh machine comes up in: the registry does not exist yet, the
          server says so on its startup line, and the New-show surface that writes the first entry
          is served by this same server. */}
      {showsPageIsEmpty(rows, failed) && (
        <p className="quiet">no shows are registered yet — start one above, or run the console with <span className="mono">--show &lt;root&gt;</span></p>
      )}

      <ul className="show-rows">
        {(rows ?? []).map((show) => (
          <li className={`show-row${show.readOnly ? " show-row-readonly" : ""}`} key={show.key}>
            <div>
              <Link className="row-title" to={showHref(show.key)}>
                <span className="mono row-id">{show.key}</span> {show.showName}
              </Link>
              <div className="quiet mono">{show.episodesDir} · {show.productionDir} · engine {show.engineVersion}</div>
            </div>
            <div>
              {show.readOnly
                ? <span className="chip chip-readonly">read-only</span>
                : <span className="chip chip-none">writable</span>}
            </div>
            <div className="row-actions">
              <Link className="btn" to={showHref(show.key)}>open the board</Link>
              {/* The bible beside the board, per show: a show whose setup is unfinished has an
                  empty Board and thirteen files waiting on their author, and sending them to the
                  Board first would show them nothing. */}
              <Link className="btn" to={bibleHref(show.key)}>the bible</Link>
            </div>
          </li>
        ))}
        {/* The entries the console holds and could not load, after the shows and in the same list.
            No `Link` on either side of the row: every route under the key answers 404, so a link
            would take the operator to the server's "no such show" instead of to the show. The
            reason is the loader's own words, because that is the sentence that names the file and
            says what is wrong with it. */}
        {failed.map((entry) => (
          <li className="show-row show-row-failed" key={`failed:${entry.key}`}>
            <div>
              <div className="row-title">
                <span className="mono row-id">{entry.key}</span> — could not be loaded: {entry.error}
              </div>
              <div className="quiet mono">{entry.root}</div>
            </div>
            <div><span className="chip chip-failed">not loaded</span></div>
            <div className="row-actions" />
          </li>
        ))}
      </ul>

      {rows !== null && rows.length > 0 && (
        <p className="legend">
          <span className="chip chip-readonly">read-only</span> the console refuses every POST to this show: no launch,
          no gate answer, no new episode. Registered so it can be read beside a show that shares its NAS root.
        </p>
      )}

      {failed.length > 0 && (
        <p className="legend">
          <span className="chip chip-failed">not loaded</span> this key is in the registry and its repository would not
          load, so the console holds no show for it and every address under it answers
          <span className="mono"> no such show</span>. Fix the repository and restart the console: the registry is read
          once, at startup.
        </p>
      )}
    </div>
  );
}

/** The one line for an address this client has no route for. Declared here and rendered twice —
 *  once beside the Shows page and once inside a show — so a mistyped path under a real show keeps
 *  that show's chrome and its link back to its own Board. */
export function NoSuchPage({ showKey }: { showKey?: string }) {
  return (
    <p className="quiet">
      no such page.{" "}
      {showKey === undefined
        ? <Link to="/">the shows</Link>
        : <><Link to={showHref(showKey)}>the board</Link> · <Link to="/">the shows</Link></>}
    </p>
  );
}

import { Link } from "react-router-dom";
import { bibleHref, showHref, useSSE, useShows } from "../api.js";

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
 *  writing over the instance's finals on the NAS root they share (ruling H-03). */
export function Shows() {
  const shows = useShows();
  const rows = shows.data;

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
    const announced = message.shows.map((s) => s.key).join("\n");
    if (announced !== held.map((s) => s.key).join("\n")) shows.refetch();
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
      {rows !== null && rows.length === 0 && (
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
      </ul>

      {rows !== null && rows.length > 0 && (
        <p className="legend">
          <span className="chip chip-readonly">read-only</span> the console refuses every POST to this show: no launch,
          no gate answer, no new episode. Registered so it can be read beside a show that shares its NAS root.
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

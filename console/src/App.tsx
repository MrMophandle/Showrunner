import { Link, Outlet, Route, Routes } from "react-router-dom";
import type { EpisodeRow, ShowInfo } from "../shared/types.js";
import {
  ConsoleContext, showHref, showPath, useApi, useCoalesced, useSSE, useSseLive, useShowKey,
  type ConsoleData,
} from "./api.js";
import { showLabel } from "./projections.js";
import { useDocTitle } from "./useDocTitle.js";
import { Board } from "./pages/Board.js";
import { Run } from "./pages/Run.js";
import { Gate } from "./pages/Gate.js";
import { WhatHappened } from "./pages/WhatHappened.js";
import { NewShowPlaceholder, NoSuchPage, Shows } from "./pages/Shows.js";

/** The app: the chrome, the shows list, and the four pages of one show.
 *
 *  **Every page of a show lives under `/shows/:show/`**, which is the client half of the registry
 *  (ruling H-02: the key is the operator's, and the url carries it). One console now holds every
 *  show on the machine, so there is no page that can be "the Board" without saying whose.
 *
 *  The routes are carried by two layouts, and which layout a page is under is the whole of how it
 *  learns its show:
 *
 *  - `ShowShell` matches `/shows/:show`, reads the key out of the url, fetches that show's
 *    `ShowInfo` and its Board rows once for every page beneath it, and provides both through
 *    `ConsoleContext`. A page beneath it therefore has the whole `ShowInfo` — which is how it
 *    knows `readOnly` without a second request — and `useShowKey()` for the paths it builds.
 *  - `ShowlessShell` carries the two pages that are about no show in particular, the shows list at
 *    `/` and the New-show placeholder, and the no-such-page line.
 *
 *  The show's identity and its rows are fetched by the layout rather than inside the Board for one
 *  reason, unchanged from before the registry: the document title is the whole alerting story on
 *  this network, and it has to be right on whatever page the operator happens to be looking at. An
 *  episode that starts waiting while a Run page is open must reach that tab's title, which it
 *  cannot do if the rows are only fetched by a page that is not mounted.
 *
 *  The rows' refetch is coalesced like the Run page's: `episodes` notices arrive for every lock
 *  appearing or disappearing and every new episode directory, and a Board that re-read every
 *  episode of the show per notice would scan the disk several times a second during a launch. */
export function App() {
  return (
    <Routes>
      <Route element={<ShowlessShell />}>
        <Route path="/" element={<Shows />} />
        {/* A static segment outranks a dynamic one in react-router's own matching, so this wins
            over `/shows/:show` below and no request for the New-show page is ever read as a
            request for a show keyed `new`. */}
        <Route path="/shows/new" element={<NewShowPlaceholder />} />
        <Route path="*" element={<NoSuchPage />} />
      </Route>
      <Route path="/shows/:show" element={<ShowShell />}>
        <Route index element={<Board />} />
        <Route path="episodes/:id/runs/:run" element={<Run />} />
        <Route path="episodes/:id/runs/:run/gate" element={<Gate />} />
        <Route path="episodes/:id/runs/:run/what-happened" element={<WhatHappened />} />
        <Route path="*" element={<ShowNoSuchPage />} />
      </Route>
    </Routes>
  );
}

/** The header every page carries: where the operator is, who the console thinks they are, and
 *  whether the live channel is open.
 *
 *  `show` is null on the pages that are about no show. On a show's pages the link reads
 *  **`<showName> · <key>`** (`showLabel`) and points at that show's Board, with a second link out
 *  to the shows list beside it: the key is in the header because two registered shows can declare
 *  the same `showName` — both shows this console was measured against do — and the name alone
 *  would leave the operator unable to tell which Board they are reading. */
function Chrome({ show }: { show: ShowInfo | null }) {
  const live = useSseLive();
  return (
    <header className="chrome">
      <Link className="chrome-home link-plain" to="/">{show === null ? "console" : "shows ▸"}</Link>
      {show !== null && (
        <Link className="chrome-name link-plain" to={showHref(show.key)}>{showLabel(show)}</Link>
      )}
      {show !== null && show.readOnly && <span className="chip chip-readonly">read-only</span>}
      <span className="chrome-meta quiet mono">
        {show !== null && `${show.operator} · engine ${show.engineVersion}`}
      </span>
      <span className={`chrome-live${live ? " chrome-live-on" : ""}`} title={live ? "the live channel is open" : "the live channel is not open — pages will not update by themselves"}>
        {live ? "live" : "offline"}
      </span>
    </header>
  );
}

/** The two pages that are about no show in particular, and the no-such-page line. The tab reads
 *  the neutral "console" here: this repository names no show, so there is nothing else to call a
 *  page that is not inside one. */
function ShowlessShell() {
  useDocTitle(null, null);
  return (
    <>
      <Chrome show={null} />
      <main className="main"><Outlet /></main>
    </>
  );
}

/** One show, for every page beneath `/shows/:show`: its `ShowInfo`, its Board rows, the document
 *  title, and the SSE filter that keeps another show's notices out.
 *
 *  **Every notice whose `show` is not this one is dropped here** (ruling H-12). One channel carries
 *  the notices of every registered show and two shows can each hold an `s02e01`, so without the
 *  test a Board left open on one show would re-read every episode of it on the other show's every
 *  heartbeat — the whole 68-step projection and the needs probes against disk, several times a
 *  second, for rows that cannot have changed. */
function ShowShell() {
  const key = useShowKey();
  const show = useApi<ShowInfo>(showPath(key));
  const episodes = useApi<EpisodeRow[]>(showPath(key, "/episodes"));

  const refetchRows = useCoalesced(() => { episodes.refetch(); }, 250);
  useSSE((message) => {
    if (message.type !== "episodes" && message.type !== "run") return;
    if (message.show !== key) return;
    // An "episodes" notice is the list itself changing — a new episode, or a lock appearing or
    // disappearing — and every row may have moved.
    if (message.type === "episodes") { refetchRows(); return; }
    // A "run" notice is a log that grew. It is the Board's only when the run is a row's latest
    // run: an operator reading an older run of some episode makes the store tail that log, and
    // re-reading every episode of the show for a run no row shows would be a full per-episode
    // projection — the 68-step pipeline, the needs probes against disk, the whole log — several
    // times a second for a row that cannot change. Before the first `/api/shows/<key>/episodes`
    // has answered there are no rows to test against, so the notice is taken.
    const rows = episodes.data;
    if (rows === null || rows.some((r) => r.id === message.episodeId && r.runId === message.runId)) refetchRows();
  });

  useDocTitle(show.data, episodes.data);

  const value: ConsoleData = {
    show: show.data,
    showError: show.error,
    // The two read-only facts, derived here and nowhere else: see `ConsoleData`'s own comments for
    // why `readOnly` is not the negation of `canAct`.
    canAct: show.data !== null && !show.data.readOnly,
    readOnly: show.data !== null && show.data.readOnly,
    rows: episodes.data,
    rowsError: episodes.error,
    rowsLoading: episodes.loading,
    refetchRows,
  };

  return (
    <ConsoleContext.Provider value={value}>
      <Chrome show={show.data} />
      {/* A key this console does not hold is a 404 from the show middleware, worded by the server
          ("no such show"), and it is the likeliest way to arrive here: a bookmark from a console
          whose registry has changed. The line carries the way out. */}
      {show.error !== null && (
        <p className="error-line">
          could not read the show <span className="mono">{key}</span>: {show.error}.{" "}
          <Link to="/">the shows this console holds</Link>
        </p>
      )}
      <main className="main"><Outlet /></main>
    </ConsoleContext.Provider>
  );
}

/** The no-such-page line inside a show, which keeps that show's own Board as the way back. */
function ShowNoSuchPage() {
  return <NoSuchPage showKey={useShowKey()} />;
}

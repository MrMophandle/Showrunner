import { Link, Route, Routes } from "react-router-dom";
import type { EpisodeRow } from "../shared/types.js";
import { ConsoleContext, useApi, useCoalesced, useSSE, useSseLive, type ConsoleData, type ShowInfo } from "./api.js";
import { useDocTitle } from "./useDocTitle.js";
import { Board } from "./pages/Board.js";
import { Run } from "./pages/Run.js";
import { Gate } from "./pages/Gate.js";
import { WhatHappened } from "./pages/WhatHappened.js";

/** The app: the chrome, the four routes, and the two things every page can read without asking
 *  for them again.
 *
 *  The show's identity and the Board's rows are fetched here rather than inside the Board for one
 *  reason: the document title is the whole alerting story on this network, and it has to be right
 *  on whatever page the operator happens to be looking at. An episode that starts waiting while a
 *  Run page is open must reach that tab's title, which it cannot do if the rows are only fetched
 *  by a page that is not mounted.
 *
 *  The rows' refetch is coalesced like the Run page's: `episodes` notices arrive for every lock
 *  appearing or disappearing and every new episode directory, and a Board that re-read every
 *  episode of the show per notice would scan the disk several times a second during a launch. */
export function App() {
  const show = useApi<ShowInfo>("/api/show");
  const episodes = useApi<EpisodeRow[]>("/api/episodes");
  const live = useSseLive();

  const refetchRows = useCoalesced(() => { episodes.refetch(); }, 250);
  useSSE((message) => {
    // A "run" notice is a log that grew, which changes that row's status, its last-event time and
    // possibly its stage; an "episodes" notice is the list itself changing. Both are the Board's.
    if (message.type === "run" || message.type === "episodes") refetchRows();
  });

  useDocTitle(show.data?.showName, episodes.data);

  const value: ConsoleData = {
    show: show.data,
    showError: show.error,
    rows: episodes.data,
    rowsError: episodes.error,
    rowsLoading: episodes.loading,
    refetchRows,
  };

  return (
    <ConsoleContext.Provider value={value}>
      <header className="chrome">
        <Link className="chrome-name link-plain" to="/">{show.data?.showName ?? "console"}</Link>
        <span className="chrome-meta quiet mono">
          {show.data !== null && `${show.data.operator} · engine ${show.data.engineVersion}`}
        </span>
        <span className={`chrome-live${live ? " chrome-live-on" : ""}`} title={live ? "the live channel is open" : "the live channel is not open — pages will not update by themselves"}>
          {live ? "live" : "offline"}
        </span>
      </header>
      {show.error !== null && <p className="error-line">could not read the show: {show.error}</p>}
      <main className="main">
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/episodes/:id/runs/:run" element={<Run />} />
          <Route path="/episodes/:id/runs/:run/gate" element={<Gate />} />
          <Route path="/episodes/:id/runs/:run/what-happened" element={<WhatHappened />} />
          <Route path="*" element={<p className="quiet">no such page. <Link to="/">the board</Link></p>} />
        </Routes>
      </main>
    </ConsoleContext.Provider>
  );
}

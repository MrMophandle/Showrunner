import { useEffect, useState } from "react";
import type { EpisodeRow } from "../shared/types.js";
import { titleFor, type TitleShow } from "./projections.js";

/** The browser tab as an alarm. Ported in purpose from console v1's `useDocTitle`: the spec rules
 *  out web notifications (a LAN console is served over http, which is not a secure context, so
 *  iPad Safari will not grant them) and the console is silent by ruling, which leaves the tab's
 *  own string as the whole alerting story on the home network.
 *
 *  Mounted exactly once, at the top of the app, so the title is the same on every page: a Run
 *  page open on one episode must still say that a different episode has started waiting. That is
 *  why the Board's rows are fetched by `App` rather than by `Board`.
 *
 *  `titleFor` is re-exported because it is the part of this module worth asserting, and
 *  `test/client/doc-title.test.ts` asserts it through this file — the hook itself is one
 *  assignment to `document.title`. */
export { titleFor };

/** Ticks once a minute so the running form's `· <N>m` advances while nobody touches the page.
 *  A minute, not a second: the title shows whole minutes, and a tab title rewritten every second
 *  is a tab title that flickers in some browsers' animation of it. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 60_000);
    return () => { clearInterval(timer); };
  }, []);
  return now;
}

/** Sets `document.title` from the show the page is looking at and that show's Board rows.
 *
 *  **`show` is the whole `ShowInfo` and not a name**, because the title carries the key as well
 *  (`titleFor` through `showLabel`): one console holds every show on the machine, and two of them
 *  can declare the same `showName`.
 *
 *  `null` is the two states that have no show — the Shows list at `/` and the New-show page — and
 *  the state before `GET /api/shows/<key>` has answered. All three leave the title the neutral
 *  "console": this repository names no show, and a placeholder would be a name invented in code.
 *
 *  `show.showName` and `show.key` are the dependencies rather than `show` itself, so the effect
 *  does not re-run on every refetch that returns an identical object. */
export function useDocTitle(show: TitleShow | null, rows: EpisodeRow[] | null): void {
  const now = useMinuteTick();
  const showName = show?.showName ?? "";
  const key = show?.key ?? "";
  useEffect(() => {
    document.title = showName === "" ? "console" : titleFor({ showName, key }, rows, now);
  }, [showName, key, rows, now]);
}

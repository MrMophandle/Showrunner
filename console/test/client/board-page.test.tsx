// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { EpisodeRow } from "../../shared/types.js";
import { ConsoleContext, type ConsoleData } from "../../src/api.js";
import { Board } from "../../src/pages/Board.js";

/** The Board's rows, rendered — and specifically which rows carry a situation line.
 *
 *  **Why this file exists.** The rule it asserts is a judgment the Board makes and the projection
 *  does not: `runSituation` answers "Not started." for an episode that has never run, correctly and
 *  by the brief's vocabulary table, and the *Board* declines to draw it because the row's own chip
 *  already reads "no runs" and the brief gives that row no sentence (the review of `b912b3b`,
 *  finding 1). A projection test cannot see that decision — it lives in the page's markup — and a
 *  fresh show is ten rows of it.
 *
 *  **The Board needs no network.** Its rows arrive on `ConsoleContext`, which the layout fetched
 *  (`src/api.ts`'s `ConsoleData`), and the page itself opens no SSE channel and makes no request
 *  until a button is pressed. So this test is the context, a router for the `:show` segment, and
 *  nothing else — unlike `test/client/gate-page.test.tsx`, which mounts a page that fetches.
 *
 *  The `// @vitest-environment jsdom` pragma on line 1 and the hand-registered `cleanup` are
 *  explained in `test/client/ProgressBar.test.tsx`'s header. Harbor Lights is the fixture show's
 *  world, as everywhere else in this suite. */
afterEach(cleanup);

function row(over: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    id: "s02e01", title: "A Week on the Water", stage: "IDEA", status: "none",
    needs: { ideaMissing: false, refsMissing: [], imagesMissing: [] },
    ...over,
  };
}

/** The Board with the rows the layout would have handed it. `canAct` is true, which is the state a
 *  writable show's Board is in — the one that draws a launch button beside a fresh row. */
function mount(rows: EpisodeRow[]) {
  const value: ConsoleData = {
    show: null, showError: null, canAct: true, readOnly: false,
    rows, rowsError: null, rowsLoading: false, refetchRows: () => {},
  };
  return render(
    <ConsoleContext.Provider value={value}>
      <MemoryRouter initialEntries={["/shows/harbor"]}>
        <Routes>
          <Route path="/shows/:show" element={<Board />} />
        </Routes>
      </MemoryRouter>
    </ConsoleContext.Provider>,
  );
}

describe("the Board's situation line", () => {
  it("draws no line for an episode that has never run — the chip already says so", () => {
    const { container } = mount([row({ status: "none", stage: "IDEA" })]);

    // The chip is the whole of what a fresh row has to say.
    expect(screen.getByText("no runs")).toBeInTheDocument();
    expect(container.querySelector("p.situation")).toBeNull();
    // And the subject the projection would have supplied is nowhere on the page, which is the
    // duplication this guard removes (ten rows of it on a fresh show).
    expect(screen.queryByText("Not started.")).toBeNull();
  });

  it("draws the line for a row whose run is doing something", () => {
    const working = row({
      status: "running",
      stage: "DRAFT_SCRIPT",
      position: { stepId: "draft", startedAt: new Date(Date.now() - 125_000).toISOString() },
      lastEventAt: new Date().toISOString(),
    });
    const { container } = mount([working]);

    expect(screen.getByText("A worker is on it.")).toBeInTheDocument();
    expect(screen.getByText(/^draft for 2m/)).toBeInTheDocument();
    // Blue, as the run's status chip is: the line carries the colour the Run view's stage box lost.
    expect(container.querySelector("p.situation")).toHaveClass("situation-working");
  });

  it("draws an archived row's marker line in the done colour, and no second copy in the chip", () => {
    const { container } = mount([row({
      status: "archived", stage: "APPROVED_FINAL", archiveNote: "final on the NAS, made by console v1",
    })]);

    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.getByText("final on the NAS, made by console v1")).toBeInTheDocument();
    // The chip is the bare word now; the marker's line is the situation sentence.
    expect(screen.getByText("archived")).toBeInTheDocument();
    expect(container.querySelector("p.situation")).toHaveClass("situation-done");
  });
});

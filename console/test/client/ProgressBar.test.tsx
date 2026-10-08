// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RunView, StepRow } from "../../shared/types.js";
import { ProgressBar } from "../../src/components/ProgressBar.js";
import { StepRail } from "../../src/components/StepRail.js";

/** The console's first render test (ruling H-10), and the one component whose job is a number the
 *  operator reads from across the room: a step's progress bar.
 *
 *  **Why a render test and not another projection test.** `test/client/projections.test.ts`
 *  already asserts `progressLabel`'s string for every shape of progress a log can carry. What it
 *  cannot assert is that the string reaches the screen, that the bar's width is the fraction the
 *  label describes, or that a progress with no total draws no bar — and that last one is the whole
 *  point of the component (`ProgressBar.tsx`: "a bar with a made-up denominator would be the one
 *  thing on this page that lies"). Those are facts about rendered output, so they need a DOM.
 *
 *  **Two subjects, because `StepRow` is a type and not a component.** `StepRow`
 *  (`shared/types.ts`) is one row of the rail, and two components divide the work of drawing one:
 *  `StepRail` draws the row — its id, kind, status and timing — and hands the row's `progress` to
 *  `ProgressBar`. The second `describe` below renders the rail with a single progressing row,
 *  which is what proves the rail passes a row's progress through rather than only that
 *  `ProgressBar` works when called directly.
 *
 *  **The environment and the transform.** The `// @vitest-environment jsdom` pragma on line 1 is
 *  this file's own (see `vitest.config.ts` for why it is per file and not per directory). The JSX
 *  is compiled by the automatic runtime because `tsconfig.server.json` — the project whose
 *  `include` covers `test/` — declares `"jsx": "react-jsx"`; that is also what typechecks this
 *  file under `npm run typecheck`, and it is why there is no `import React` here.
 *
 *  React Testing Library's automatic cleanup does not run under this suite: it installs itself
 *  into a **global** `afterEach`, and vitest's globals are off here (every test file imports
 *  `describe`/`it`/`expect` by name). So `cleanup` is registered by hand, once per file. Without
 *  it, each `render` would leave its tree in the document and `screen` would find two of
 *  everything. */
afterEach(cleanup);

/** A step's progress as the server reports it: seventeen of forty shots rendered, half a shot a
 *  second, forty-six seconds left. The numbers are chosen so that every assertion below is a
 *  different arithmetic — 17/40 is 0.425, which is a width that rounds (`42.5%`) rather than one
 *  that would pass with the fraction computed any of three wrong ways. */
const PROGRESS: NonNullable<StepRow["progress"]> = {
  done: 17, total: 40, unit: "shots", ratePerSec: 0.5, etaSec: 46,
};

describe("ProgressBar", () => {
  it("draws the server's label and a bar whose width is the fraction done", () => {
    render(<ProgressBar progress={PROGRESS} />);

    // The label is asserted as the rendered string and never recomputed here: it is
    // `progressLabel`'s output, and a test that built the same string from the same parts would
    // pass if the component stopped calling `progressLabel` at all.
    expect(screen.getByText("17/40 shots · 0.5/s · ETA 0m 46s")).toBeInTheDocument();

    // The bar is two elements: the track carries the role and the accessible numbers, the fill
    // carries the width as an inline style. The fill has no role and no name of its own, so it is
    // reached through the track rather than queried for directly.
    const track = screen.getByRole("progressbar");
    expect(track).toHaveAttribute("aria-valuenow", "17");
    expect(track).toHaveAttribute("aria-valuemin", "0");
    expect(track).toHaveAttribute("aria-valuemax", "40");
    const fill = track.querySelector(".progress-fill");
    expect(fill).not.toBeNull();
    expect(fill).toHaveStyle({ width: "42.5%" });
  });

  it("clamps a count past the total to a full bar rather than overflowing it", () => {
    // A loop that reported 44 of 40 — which happens when a script counts retries — must not draw
    // a fill 110% as wide as its track and push the page sideways.
    render(<ProgressBar progress={{ done: 44, total: 40, unit: "shots" }} />);
    expect(screen.getByRole("progressbar").querySelector(".progress-fill")).toHaveStyle({ width: "100.0%" });
  });

  it("draws no bar at all for a progress with no total, and still shows the count", () => {
    // `total: 0` is what the server reports when the log's total was not a number. There is no
    // denominator, so there is no fraction, so there is nothing a bar could honestly show.
    render(<ProgressBar progress={{ done: 17, unit: "shots", total: 0 }} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("17 shots")).toBeInTheDocument();
  });

  it("shows the step's own message under the label when the log carried one", () => {
    render(<ProgressBar progress={{ ...PROGRESS, message: "amb-04 at 1920x1080" }} />);
    expect(screen.getByText("amb-04 at 1920x1080")).toBeInTheDocument();
  });
});

/** One run as the rail reads it: a single step, in flight, with the progress above. Everything
 *  else is the minimum `RunView` the rail dereferences — the pipeline block it never draws and the
 *  offset no component reads — so that the assertions below are about the one row. */
function viewWith(row: StepRow): RunView {
  return {
    episodeId: "s02e01",
    runId: "r1",
    status: "running",
    stage: "RENDER",
    position: { stepId: row.id, startedAt: "2026-10-07T12:00:00.000Z" },
    steps: [row],
    pipeline: { name: "episode", hashNow: "abc123", changed: false },
    offset: 0,
  };
}

describe("StepRail", () => {
  it("draws a step row with its id, kind and status, and hands its progress to the bar", () => {
    const row: StepRow = {
      id: "render-shots", kind: "script", status: "running",
      startedAt: "2026-10-07T12:00:00.000Z", progress: PROGRESS,
    };
    render(<StepRail view={viewWith(row)} events={[]} now={Date.parse("2026-10-07T12:00:40.000Z")} />);

    expect(screen.getByText("render-shots")).toBeInTheDocument();
    expect(screen.getByText("script")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    // The elapsed time of a running step, from the `now` the page passes in rather than from the
    // clock — forty seconds after the step started.
    expect(screen.getByText("0m 40s")).toBeInTheDocument();
    // The row's progress, drawn by the same `ProgressBar` the first describe asserted directly:
    // the point here is that the rail passed the row's `progress` through at all.
    expect(screen.getByText("17/40 shots · 0.5/s · ETA 0m 46s")).toBeInTheDocument();
    expect(screen.getByRole("progressbar").querySelector(".progress-fill")).toHaveStyle({ width: "42.5%" });
  });

  it("draws no bar for a step the log has said nothing about", () => {
    render(<StepRail
      view={viewWith({ id: "render-shots", kind: "script", status: "pending" })}
      events={[]}
      now={Date.parse("2026-10-07T12:00:40.000Z")}
    />);
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

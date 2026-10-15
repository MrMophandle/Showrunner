// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SituationLine, type SituationAction } from "../../src/components/SituationLine.js";
import { runSituation } from "../../src/projections.js";

/** The one status area, rendered (Ryan's ruling, 2026-10-15).
 *
 *  **Why a render test and not another projection test.** The `describe("runSituation")` block in
 *  `test/client/projections.test.ts` already asserts the subject and the sentence for every state a
 *  run can be in. What it cannot assert is the half of the ruling that is about the screen: that the
 *  subject reaches it in bold, that a situation naming a move renders exactly one button, and —
 *  the load-bearing one — that a situation naming no move renders **none**. A status line that grew
 *  a button for a run nobody has to touch would be the action bar again, in a new place.
 *
 *  **Why `MemoryRouter`.** The open gate is a GET, so it is rendered as a `Link` and a `Link`
 *  outside a router throws. This is the suite's first router-wrapped render; it is also the reason
 *  the line is its own component rather than a slot inside `src/pages/Run.tsx`, which would have
 *  brought the view fetch, the event tail and the SSE channel with it to assert two sentences.
 *
 *  The `// @vitest-environment jsdom` pragma on line 1 and the hand-registered `cleanup` below are
 *  explained in `test/client/ProgressBar.test.tsx`'s header. */
afterEach(cleanup);

/** The line as the Run page mounts it: the projection's answer, and the move the page is willing to
 *  offer. `exactOptionalPropertyTypes` refuses an explicit `undefined` for `action`, so the absent
 *  case omits the prop rather than passing nothing to it. */
function mount(situation: ReturnType<typeof runSituation>, action?: SituationAction) {
  return render(
    <MemoryRouter>
      <SituationLine situation={situation} {...(action === undefined ? {} : { action })} />
    </MemoryRouter>,
  );
}

/** The gate the Run view was showing when the stale "resumed — a worker is on it" notice sat beside
 *  it. Harbor Lights is the fixture show's world, as everywhere else in this suite. */
const GATE = runSituation({
  status: "waiting",
  openGate: { stepId: "script-gate", attempt: 2, openedAt: "2026-10-15T14:05:00.000Z" },
});

describe("SituationLine", () => {
  it("draws the subject in bold, the sentence, and the one move a gate needs", () => {
    mount(GATE, { label: "open gate · script-gate", href: "/shows/harbor/episodes/s02e01/runs/r1/gate" });

    // The subject is the half read from across the room, so it is asserted as a `strong` and not
    // only as text on the page.
    const subject = screen.getByText("Needs you.");
    expect(subject.tagName).toBe("STRONG");
    expect(screen.getByText("script-gate has been waiting for an answer since 14:05:00 (attempt 2).")).toBeInTheDocument();

    // One move, as a link: the gate page is a GET, which is what lets a read-only show keep it.
    const link = screen.getByRole("link", { name: "open gate · script-gate" });
    expect(link).toHaveAttribute("href", "/shows/harbor/episodes/s02e01/runs/r1/gate");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("draws a working run's step and age and offers nothing to press", () => {
    const working = runSituation({
      status: "running",
      position: { stepId: "draft", startedAt: "2026-10-15T14:00:00.000Z" },
      steps: [{ id: "draft", kind: "loop", status: "running", iteration: { n: 3, max: 15 } }],
    }, Date.parse("2026-10-15T14:12:05.000Z"));

    mount(working);

    expect(screen.getByText("A worker is on it.")).toBeInTheDocument();
    expect(screen.getByText("draft for 12m 05s (iteration 3 of 15)")).toBeInTheDocument();
    // The whole of the second half of the ruling: a run that needs nobody is a sentence and not an
    // invitation. Both roles are checked, because the two kinds of move render as different
    // elements — a `Link` for a GET and a `button` for a POST.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("presses the one move it is given, once", () => {
    const onClick = vi.fn();
    const crashed = runSituation({ status: "crashed" });
    mount(crashed, { label: "continue", onClick });

    fireEvent.click(screen.getByRole("button", { name: "continue" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("says the same thing on a read-only show and withholds the POST", () => {
    // Plan H's rule, as the Run page applies it: Resume is a POST the server answers 403 to, so the
    // page passes no action — and the sentence that says the run has failed is unchanged, because
    // what has happened to a run does not depend on who is allowed to touch it (ruling H-03).
    const failed = runSituation({ status: "failed", failed: { stepId: "tts-generate", error: "429" } });
    mount(failed);

    expect(screen.getByText("Needs you.")).toBeInTheDocument();
    expect(screen.getByText("Failed at tts-generate: 429. Resume runs it again from there.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("keeps the gate link on a read-only show, because reading is what such a show offers", () => {
    // The carve-out ruling H-03 makes for the two links that are GETs. The Run page withholds
    // Resume and Continue on a read-only show and offers the gate, so the one surface that says a
    // gate is waiting is also the one that can reach it.
    mount(GATE, { label: "open gate · script-gate", href: "/shows/retired/episodes/s02e01/runs/r1/gate" });
    expect(screen.getByRole("link", { name: "open gate · script-gate" })).toBeInTheDocument();
  });
});

import { describe, expect, it } from "vitest";
import type { WireEvent } from "../../shared/types.js";
import { eventSummary } from "../../src/components/EventFeed.js";

/** The event feed's one line per event, for the kind Plan J added.
 *
 *  **Why this file exists at all.** `eventSummary` (`src/components/EventFeed.tsx`) is the feed's
 *  whole vocabulary — one case per event kind the engine writes, with the payload as truncated JSON
 *  for a kind it has not learnt — and until Plan J it had no test of its own: its output was only
 *  ever asserted through a rendered page, and no page test named a single summary. A kind added to
 *  the engine and *not* added here is silently correct, because the fallback arm renders it as JSON
 *  and nothing fails. `panel_round`'s payload is 10 kB of verdict objects on a real run, so the
 *  fallback arm is exactly the wrong outcome for this one and the case needs an assertion.
 *
 *  **No DOM.** `eventSummary` is a pure function of one event, so this file runs in the suite's
 *  default `environment: "node"` with no `// @vitest-environment jsdom` pragma, for the reason
 *  `test/client/projections.test.ts` states: a string is asserted as a string. It imports a `.tsx`
 *  module, whose JSX is compiled by the automatic runtime from `tsconfig.server.json`'s
 *  `"jsx": "react-jsx"` — the same transform `ProgressBar.test.tsx` documents. */

/** One `panel_round` as the panel writes it (`engine/src/runner.ts`'s `runPanelStep`): the round
 *  that came back red, every reset step's result the run had, and what the write phase had cost
 *  when it failed. The two reviewers that fail here are the two that failed on the measured s02e01
 *  round (inventory J-09: `tone-check` 15 issues, `repetition-check` 8, and `flow-check` passing
 *  *with* five issues — which is why the summary cannot be built from issue counts). */
function panelRound(over: Record<string, unknown> = {}): WireEvent {
  return {
    ts: "2026-10-15T18:00:06.000Z",
    stepId: "panel",
    kind: "panel_round",
    payload: {
      round: 2,
      green: false,
      costUsd: 6.066,
      weeklyUtilization: 0.41,
      by: "panel:panel:round-2",
      verdicts: {
        "tone-check": { pass: false, issues: [{ id: "T1", law: "Canon/style-guide.md:59", line: 41, text: "forty-one words" }] },
        "flow-check": { pass: true, issues: ["worth a listen-check"] },
        "repetition-check": { pass: false, issues: ["the tide-line simile, three times"] },
        "canon-review-script": { pass: true, deviations: [] },
      },
      ...over,
    },
  };
}

describe("eventSummary for panel_round", () => {
  it("names the round, the reviewers that failed and what the round had cost", () => {
    // A reviewer that passed is not named, however many issues it raised: `flow-check` delivered
    // five pieces of craft advice on a `pass: true` verdict on the measured run, and a line that
    // listed it among the failures would send the reader looking for a defect it did not claim.
    expect(eventSummary(panelRound())).toBe("round 2 red — tone-check, repetition-check · $6.0660");
  });

  it("still says the round and the cost when the verdicts are missing or the wrong shape", () => {
    // The feed is the surface a run is reconstructed from, so a payload a hand-edited log made
    // unreadable must still yield the two facts that are readable rather than falling through to
    // the raw-JSON arm.
    expect(eventSummary(panelRound({ verdicts: undefined }))).toBe("round 2 red · $6.0660");
    expect(eventSummary(panelRound({ verdicts: ["tone-check"] }))).toBe("round 2 red · $6.0660");
  });

  it("names every reviewer when the whole panel is red, in the payload's own key order", () => {
    expect(eventSummary(panelRound({
      round: 1,
      costUsd: 6.066,
      verdicts: { "tone-check": { pass: false }, "flow-check": { pass: false } },
    }))).toBe("round 1 red — tone-check, flow-check · $6.0660");
  });
});

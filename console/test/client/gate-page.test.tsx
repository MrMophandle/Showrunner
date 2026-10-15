// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { GateView } from "../../shared/types.js";
import { ConsoleContext, type ConsoleData } from "../../src/api.js";
import { Gate } from "../../src/pages/Gate.js";

/** The Gate page's order, rendered (Ryan's ruling, 2026-10-15, at the s02e01 script gate).
 *
 *  **Why the whole page and not a component below it.** Every fact the ruling is about is a fact
 *  about document order — the artifact's text before the message's text, the answer between them,
 *  the message's expander closed — and there is no component that holds two of those at once. The
 *  helper underneath is asserted as a projection in `test/client/projections.test.ts`
 *  (`describe("gateSummaryLine")`); what is left for a DOM is whether the page puts the pieces in
 *  the ruled order and whether the `details` starts closed.
 *
 *  **The four stubs, and why each is needed.** This is the first test in the suite to mount a page
 *  rather than a component, so it is the first to pay for a page's ambient dependencies:
 *
 *  - `fetch` is stubbed and keyed on the url, because the page reads two things over the network —
 *    the gate view as JSON and the artifact's text — through `getJson` and `getText` (`src/api.ts`),
 *    which are left entirely alone here. Each assertion therefore waits for the fetch it depends on.
 *  - `EventSource` is stubbed because jsdom implements none and `useSSE` opens the channel on mount
 *    (`src/api.ts`'s `connect`). Without it the first render throws a `ReferenceError`, and the
 *    channel is not what is being tested: an SSE notice on this page raises a banner and changes
 *    nothing else, by the page's own ruling about `expectedAttempt`.
 *  - `MemoryRouter` with a real route, because the page reads `:show`, `:id` and `:run` off
 *    `useParams` and builds every url it fetches from them.
 *  - `ConsoleContext.Provider`, because `canAct` is what decides whether Approve and Reject exist
 *    at all (ruling H-03), and the context's default is `canAct: false` — which is the read-only
 *    case, and would otherwise be the only case reachable.
 *
 *  The `// @vitest-environment jsdom` pragma on line 1 and the hand-registered `cleanup` are
 *  explained in `test/client/ProgressBar.test.tsx`'s header. Harbor Lights is the fixture show's
 *  world, as everywhere else in this suite. */
afterEach(cleanup);

/** The gate's one artifact: a markdown script, served by the artifact route. */
const SCRIPT_URL = "/api/shows/harbor/episodes/s02e01/files/Episodes/s02e01/script.md";

/** A line of the script the gate is about — the text that must reach the screen *before* anything
 *  the message says. */
const SCRIPT_LINE = "INT. HARBOR OFFICE — DAWN";

/** The message as the script gate's own template renders it
 *  (`tools/templates/prompts/script-gate.gate.md`): one sentence naming the file, then the
 *  reviewers' verdicts as the raw JSON Ryan opened the page on. */
const MESSAGE = [
  "Script drafted: Episodes/s02e01/script.md",
  'Panel verdict (review-gate all-pass): {"pass":true,"issues":[],"reviewers":["tone","flow","character","environment","structure","repetition","canon"]}',
  "Approve to commit. Reject with notes for a targeted revision.",
].join("\n");

/** The first line as the summary says it, which is `gateSummaryLine`'s answer for `MESSAGE`. */
const SUMMARY = "Script drafted: Episodes/s02e01/script.md";

function gateView(over: Partial<GateView> = {}): GateView {
  return {
    episodeId: "s02e01",
    runId: "20261015-120000-abcd",
    stepId: "script-gate",
    attempt: 1,
    maxAttempts: 10,
    openedAt: "2026-10-15T14:05:00.000Z",
    message: MESSAGE,
    artifacts: [{ kind: "markdown", label: "script.md", url: SCRIPT_URL }],
    verdicts: {},
    rejections: [],
    ...over,
  };
}

/** jsdom has no `EventSource`; the page opens the console's channel on mount. */
class FakeEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void { /* nothing to close */ }
}

/** The network, answered from the view under test: the gate route, the artifact, and 404 for
 *  anything this page should not be asking for. */
function stubFetch(view: GateView): void {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/gate")) return new Response(JSON.stringify(view), { status: 200 });
    if (url === SCRIPT_URL) return new Response(SCRIPT_LINE, { status: 200 });
    return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
  }));
}

/** The page at its own route, with the show's writability as the layout would have resolved it. */
function mount(view: GateView, console_: Partial<ConsoleData> = {}) {
  stubFetch(view);
  const value: ConsoleData = {
    show: null, showError: null, canAct: true, readOnly: false,
    rows: null, rowsError: null, rowsLoading: false, refetchRows: () => {},
    ...console_,
  };
  return render(
    <ConsoleContext.Provider value={value}>
      <MemoryRouter initialEntries={["/shows/harbor/episodes/s02e01/runs/20261015-120000-abcd/gate"]}>
        <Routes>
          <Route path="/shows/:show/episodes/:id/runs/:run/gate" element={<Gate />} />
        </Routes>
      </MemoryRouter>
    </ConsoleContext.Provider>,
  );
}

/** Where a string sits in the rendered page, so two of them can be put in order. A closed
 *  `details` still has its children in the DOM under jsdom, which is what makes this measurement of
 *  *order* independent of the measurement of *collapse* below. */
function positionOf(container: HTMLElement, text: string): number {
  const index = (container.textContent ?? "").indexOf(text);
  expect(index, `"${text}" is not on the page`).toBeGreaterThan(-1);
  return index;
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("the Gate page's order", () => {
  it("draws the artifact before the message, and the answer between them", async () => {
    const { container } = mount(gateView());

    // Two fetches, so both are waited for: the view, which carries the message, and the artifact's
    // own text, which arrives on a second request made by the pane.
    await waitFor(() => { expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument(); });

    // The answer section is anchored on its own heading and not on the textarea's placeholder,
    // which is an attribute and not text in the document.
    const script = positionOf(container, SCRIPT_LINE);
    const answer = positionOf(container, "your answer");
    const verdictJson = positionOf(container, "Panel verdict (review-gate all-pass)");
    expect(script).toBeLessThan(answer);
    expect(answer).toBeLessThan(verdictJson);
  });

  it("starts with the message collapsed, its first line as the summary", async () => {
    const { container } = mount(gateView());
    await waitFor(() => { expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument(); });

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);

    // The label and the message's first sentence, so the collapsed state still says what the gate
    // is about. One element, read as one string, because that is how it is read on the screen.
    const summary = container.querySelector("details > summary");
    expect(summary?.textContent).toBe(`the gate's message — ${SUMMARY}`);
  });

  it("opens the message for a gate that names no artifact, which has nothing else to show", async () => {
    const { container } = mount(gateView({ artifacts: [] }));
    await waitFor(() => { expect(screen.getByText(/this gate names no artifacts/)).toBeInTheDocument(); });

    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("keeps the order on a read-only show and offers no answer", async () => {
    const { container } = mount(gateView(), { canAct: false, readOnly: true });
    await waitFor(() => { expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument(); });

    // The same page, read rather than answered (ruling H-03): the artifact still comes first and
    // the message is still last, and neither button exists to be pressed.
    expect(positionOf(container, SCRIPT_LINE)).toBeLessThan(positionOf(container, "Panel verdict (review-gate all-pass)"));
    expect(screen.getByText(/answered where the show is writable/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve attempt/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject attempt/ })).toBeNull();
  });

  it("puts the notes of previous rejections above the answer and outside the collapse", async () => {
    const { container } = mount(gateView({ rejections: ["scene 4 reads as two scenes — split it"] }));
    await waitFor(() => { expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument(); });

    const rejection = positionOf(container, "scene 4 reads as two scenes");
    expect(positionOf(container, SCRIPT_LINE)).toBeLessThan(rejection);
    expect(rejection).toBeLessThan(positionOf(container, "your answer"));
    // The operator's own words are not behind the expander: they are short, and they are the half
    // of the page that says what was already asked for.
    const details = container.querySelector("details");
    expect(details?.textContent).not.toContain("scene 4 reads as two scenes");
  });
});

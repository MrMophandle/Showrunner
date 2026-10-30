// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
// The edit-link test spies on `window.confirm`; vitest is not configured to restore mocks between
// tests, so a spy left standing would answer the next test's confirm as well.
afterEach(() => { vi.restoreAllMocks(); });

/** The run the fixture gate belongs to. One constant, because three things have to agree about
 *  it: the view's `runId`, the `:run` segment of the route the page is mounted at, and the `runId`
 *  on a `file` notice — the page drops a notice whose run is not the one it is drawing. */
const RUN_ID = "20261015-120000-abcd";

/** The gate's one artifact: a markdown script, served by the artifact route. */
const SCRIPT_URL = "/api/shows/harbor/episodes/s02e01/files/Episodes/s02e01/script.md";

/** The script's show-relative path: the editor's address is built from it, and a `file` notice
 *  names it. */
const SCRIPT_PATH = "Episodes/s02e01/script.md";

/** Where the pane's edit link goes — `api.ts`'s `editHref` for this run and this path, which is
 *  `App.tsx`'s `/shows/:show/episodes/:id/runs/:run/edit/*` route. */
const EDIT_HREF = `/shows/harbor/episodes/s02e01/runs/${RUN_ID}/edit/${SCRIPT_PATH}`;

/** A line of the script the gate is about — the text that must reach the screen *before* anything
 *  the message says. */
const SCRIPT_LINE = "INT. HARBOR OFFICE — DAWN";

/** The message as the script gate's own template renders it
 *  (`tools/templates/prompts/script-gate.gate.md`): three lines — the script's path, what the panel
 *  cost to turn green, and the approve/reject line. The fixture used to carry the pre-Plan-J
 *  message, which interpolated the seven verdicts as raw JSON and which this engine can no longer
 *  produce; the tests only need *a* message, so nothing failed, and the cost was a reader taking the
 *  fixture for the current shape (the whole-branch review of 2026-10-15). */
const MESSAGE = [
  "Script drafted: Episodes/s02e01/script.md",
  "The panel is green after 2 round(s) ($12.1320 of review and revision).",
  "Approve to commit. Reject with notes for a targeted revision.",
].join("\n");

/** The message's second line — the one inside the collapse, since the first is the summary. It is
 *  what the order assertions below measure the message's position by. */
const MESSAGE_BODY = "The panel is green after 2 round(s)";

/** The first line as the summary says it, which is `gateSummaryLine`'s answer for `MESSAGE`. */
const SUMMARY = "Script drafted: Episodes/s02e01/script.md";

function gateView(over: Partial<GateView> = {}): GateView {
  return {
    episodeId: "s02e01",
    runId: RUN_ID,
    stepId: "script-gate",
    attempt: 1,
    maxAttempts: 10,
    openedAt: "2026-10-15T14:05:00.000Z",
    message: MESSAGE,
    artifacts: [{ kind: "markdown", label: "script.md", path: SCRIPT_PATH, url: SCRIPT_URL }],
    verdicts: {},
    rejections: [],
    ...over,
  };
}

/** The casting gate's one directory artifact: the episode's guest-reference directory, which the
 *  artifact route serves both as a listing and as the files beneath it — the same url twice, which
 *  is what marks a directory (`shared/types.ts`'s `GateArtifact`). `REFS_PATH` is the
 *  show-relative path the same artifact carries, and it is what a pick is built from: the page
 *  sends `${REFS_PATH}/<take>`, never a url and never the casting block's `dir`. */
const REFS_PATH = "Production/s02e01/guest-refs";
const REFS_URL = `/api/shows/harbor/episodes/s02e01/files/${REFS_PATH}`;

/** The directory as the listing route answers it: two takes for Pim, and the transcript she read
 *  them from — a text file, which `AUDIO_FILE` keeps out of the takes and `transcriptFor` puts
 *  under them.
 *
 *  Mutable for the reason `disk` is (below): one test adds a take that belongs to no guest in the
 *  cast, which is the case the page draws as a player and not as a choice. Reset in `beforeEach`. */
const REFS_ENTRIES = [
  { name: "pim-1.wav", size: 1, isDir: false },
  { name: "pim-2.wav", size: 1, isDir: false },
  { name: "pim.txt", size: 1, isDir: false },
];
const refsListing = { entries: [...REFS_ENTRIES] };

/** What `pim.txt` says, which the page reads under each of Pim's takes. */
const PIM_TRANSCRIPT = "The harbour never did keep a secret.";

/** The gate as `casting-gate` arrives: the guest-refs directory as its one artifact, and Task 1's
 *  casting block naming one guest with the take the manifest currently casts her from. */
function castingView(over: Partial<GateView> = {}): GateView {
  return gateView({
    stepId: "casting-gate",
    message: "Casting ready: Production/s02e01/tts-script.json",
    artifacts: [{ kind: "audio", label: "guest-refs/", path: REFS_PATH, url: REFS_URL, listUrl: REFS_URL }],
    casting: { dir: REFS_PATH, guests: [{ name: "Pim", slug: "pim", current: `${REFS_PATH}/pim-1.wav` }] },
    ...over,
  });
}

/** jsdom has no `EventSource`; the page opens the console's channel on mount. The instance is
 *  kept so a test can hand the page a notice, the way `test/client/edit-page.test.tsx` does. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeEventSource.last = this; }
  close(): void { /* nothing to close */ }
}

/** Delivers one line on the channel, as `api.ts`'s `connect` would receive it. */
function deliver(message: unknown): void {
  act(() => {
    FakeEventSource.last?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  });
}

/** What the artifact route is serving at this moment, as a mutable object rather than a constant,
 *  so a test can change the bytes on "disk" between the pane's first read and its refetch — which
 *  is the whole of what "the pane follows the save" means. Reset to `SCRIPT_LINE` in `beforeEach`,
 *  so every other test reads the same script it always did. `test/client/edit-page.test.tsx` keeps
 *  its file the same way. */
const disk = { script: SCRIPT_LINE };

/** The network, answered from the view under test: the gate route, the artifact as `disk` holds it,
 *  the guest-refs listing and one transcript, the answer's own POST, and 404 for anything this page
 *  should not be asking for.
 *
 *  **The mock is returned** so a test can read what the page posted. The answer is the one thing
 *  this page sends rather than reads, and the body it sends is the whole of what "Approve carries
 *  the picks" means; `mount` hands the same object back, because `mount` is what installs the stub
 *  and a second `stubFetch` call would replace the mock the page is actually calling.
 *
 *  The POST is matched on the method and not on a different url: the gate's answer route is the
 *  same address as the gate's view (`server/app.ts`), so the method is the only thing that tells
 *  the read from the write. It answers `{runId, pid}`, which is what the real route answers, and
 *  the page then navigates away from the gate. */
function stubFetch(view: GateView) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/gate") && init?.method === "POST") return new Response(JSON.stringify({ runId: RUN_ID, pid: 4242 }), { status: 200 });
    if (url.endsWith("/gate")) return new Response(JSON.stringify(view), { status: 200 });
    if (url === SCRIPT_URL) return new Response(disk.script, { status: 200 });
    if (url === REFS_URL) return new Response(JSON.stringify({ entries: refsListing.entries }), { status: 200 });
    if (url === `${REFS_URL}/pim.txt`) return new Response(PIM_TRANSCRIPT, { status: 200 });
    return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The body of the answer the page posted, or undefined while it has posted nothing. */
function postedBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> | undefined {
  const init = fetchMock.mock.calls.find((call) => call[1]?.method === "POST")?.[1];
  return init === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>);
}

/** The page at its own route, with the show's writability as the layout would have resolved it. */
function mount(view: GateView, console_: Partial<ConsoleData> = {}) {
  const fetchMock = stubFetch(view);
  const value: ConsoleData = {
    show: null, showError: null, canAct: true, readOnly: false,
    rows: null, rowsError: null, rowsLoading: false, refetchRows: () => {},
    ...console_,
  };
  return {
    ...render(
      <ConsoleContext.Provider value={value}>
        <MemoryRouter initialEntries={[`/shows/harbor/episodes/s02e01/runs/${RUN_ID}/gate`]}>
          <Routes>
            <Route path="/shows/:show/episodes/:id/runs/:run/gate" element={<Gate />} />
          </Routes>
        </MemoryRouter>
      </ConsoleContext.Provider>,
    ),
    fetchMock,
  };
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
  disk.script = SCRIPT_LINE;
  refsListing.entries = [...REFS_ENTRIES];
  vi.stubGlobal("EventSource", FakeEventSource);
});

describe("the verdict board at the gate", () => {
  /** A craft reviewer's verdict in the shape Plan J's six schemas now require: object issues with
   *  stable ids, the non-failing `notes`, and the by-id `prior` accounting. */
  const verdict = (over: Record<string, unknown> = {}) => ({
    pass: true,
    verdict: "DRAFT PASSED",
    issues: [] as unknown[],
    notes: [] as unknown[],
    prior: { resolved: [] as string[], unresolved: [] as string[] },
    ...over,
  });

  it("says what a reviewer noted and what it closed, so a green by declaration is visible", async () => {
    // The case the whole-branch review of 2026-10-15 named (I-4, I-5): the reviewers' close rule is
    // unconditional, so a writer that lists every finding under its round report's deliberate
    // exceptions turns the panel green in one round with nothing fixed in the text. The ids go to
    // `prior.resolved` and out of `issues`, the advisory findings go to `notes`, and the gate's
    // message no longer prints the verdicts — so before this the page showed `pass` and a cost, and
    // the one way a green can be false was invisible at the gate it opens.
    const { container } = mount(gateView({
      verdicts: {
        "tone-check": verdict({
          notes: [
            "Scene Nine reads a shade warmer than the register asks.",
            "The narrator's second paragraph could lose a clause.",
            "Two adjacent lines open on the same preposition.",
          ],
          prior: { resolved: ["tone-1", "tone-2", "tone-3"], unresolved: [] },
        }),
      },
    }));
    await waitFor(() => { expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument(); });

    // The chip: the issue count prints at zero, because `pass · 0 issues · 3 notes` is a reviewer
    // that found three things and blocked on none, which is not the same fact as finding nothing.
    const chip = container.querySelector(".verdict-chip");
    expect(chip?.textContent).toContain("pass");
    expect(container.querySelector(".verdict-count")?.textContent).toBe("0 issues · 3 notes");

    // And the detail, which is where the three notes and the three closed ids are readable.
    chip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => { expect(container.querySelector(".verdict-detail")).not.toBeNull(); });
    const detail = container.querySelector(".verdict-detail");
    expect(detail?.textContent).toContain("3 notes, which fail nothing");
    expect(detail?.textContent).toContain("Scene Nine reads a shade warmer");
    expect(detail?.textContent).toContain("Two adjacent lines open on the same preposition");
    expect(detail?.textContent).toContain("closed this round: tone-1, tone-2, tone-3");
  });

  it("a verdict with neither notes nor a prior reads as nothing raised, and draws neither block", async () => {
    const { container } = mount(gateView({ verdicts: { "flow-check": verdict() } }));
    await waitFor(() => { expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument(); });

    expect(container.querySelector(".verdict-count")?.textContent).toBe("0 issues");
    container.querySelector(".verdict-chip")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => { expect(container.querySelector(".verdict-detail")).not.toBeNull(); });
    expect(container.querySelector(".verdict-notes")).toBeNull();
    expect(container.querySelector(".verdict-closed")).toBeNull();
    expect(container.querySelector(".verdict-detail")?.textContent).toContain("this reviewer listed no issues");
  });

  it("counts an issue and a note in the singular, and keeps the issues quotable", async () => {
    const { container } = mount(gateView({
      verdicts: {
        "tone-check": verdict({
          pass: false,
          verdict: "DRAFT FAILED",
          issues: [{ id: "tone-1", law: "Canon/style-guide.md:## Cadence", line: "Scene Four — line 212", text: "The sentence runs past the cap that section sets." }],
          notes: ["One note, which fails nothing."],
          prior: { resolved: ["tone-2"], unresolved: ["tone-1"] },
        }),
      },
    }));
    await waitFor(() => { expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument(); });

    expect(container.querySelector(".verdict-count")?.textContent).toBe("1 issue · 1 note");
    container.querySelector(".verdict-chip")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => { expect(container.querySelector(".verdict-detail")).not.toBeNull(); });
    // The issue reads as the board's one-line form, and the quote button is still on it alone: a
    // note fails nothing, and quoting one into a rejection would read as though it had.
    expect(container.querySelector(".verdict-issues")?.textContent).toContain("Scene Four — line 212: The sentence runs past the cap");
    expect(container.querySelectorAll(".verdict-issues .btn-quote")).toHaveLength(1);
    expect(container.querySelectorAll(".verdict-notes .btn-quote")).toHaveLength(0);
    expect(container.querySelector(".verdict-closed")?.textContent).toContain("closed this round: tone-2");
  });
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
    const message = positionOf(container, MESSAGE_BODY);
    expect(script).toBeLessThan(answer);
    expect(answer).toBeLessThan(message);
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
    expect(positionOf(container, SCRIPT_LINE)).toBeLessThan(positionOf(container, MESSAGE_BODY));
    expect(screen.getByText(/answered where the show is writable/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve attempt/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject attempt/ })).toBeNull();
    // Nor the edit link: the file route refuses a write to a read-only show the same way the gate
    // refuses an answer (ruling H-03), and `canAct` is the only thing the link's existence hangs
    // on, so this is the assertion that exercises that guard.
    expect(screen.queryByRole("link", { name: /^edit$/i })).toBeNull();
  });

  it("prints the round the panel took and its cost beside the attempt, and nothing when no panel ran", async () => {
    // Plan J: `script-gate` opens only on a green panel, so the approver's first question beside
    // "which attempt is this" is "how many rounds did it take and what did it cost". Both live in
    // the head, which is the one part of the page the ruling of 2026-10-15 keeps above the fold.
    // Four decimals, the format `src/pages/WhatHappened.tsx` already prints a money figure in.
    const { container } = mount(gateView({ round: { n: 3, costUsd: 19.4812 } }));
    await waitFor(() => { expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument(); });

    const head = container.querySelector(".gate-meta");
    expect(head?.textContent).toContain("attempt 1 of 10 · round 3 · $19.4812 · opened");

    cleanup();

    // A gate no panel precedes — every gate but `script-gate`, and a `script-gate` whose panel went
    // green on its first round — reads exactly as it did before Plan J.
    const plain = mount(gateView());
    await waitFor(() => { expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument(); });
    const plainHead = plain.container.querySelector(".gate-meta");
    expect(plainHead?.textContent).toContain("attempt 1 of 10 · opened");
    expect(plainHead?.textContent).not.toContain("round");
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

  it("offers an edit link on the script's pane, to the editor's address", async () => {
    // Ryan's ruling of 2026-10-27: a markdown artifact is editable from the gate's own pane, so the
    // operator who finds a typo at the gate does not go to a terminal and lose the open gate.
    mount(gateView());
    await screen.findByText(SCRIPT_LINE);

    expect(screen.getByRole("link", { name: /^edit$/i })).toHaveAttribute("href", EDIT_HREF);
  });

  it("refetches the script's pane when a file message names it", async () => {
    // One file, one version (Ryan, 2026-10-27): the editor saved, the server published a `file`
    // notice naming this pane's path, and the pane shows the saved text without a reload. The
    // notice carries a hash and no text, so what the pane does with it is refetch.
    mount(gateView());
    await screen.findByText(SCRIPT_LINE);

    disk.script = "INT. HARBOR OFFICE — DUSK";
    deliver({ type: "file", show: "harbor", episodeId: "s02e01", runId: RUN_ID, path: SCRIPT_PATH, hash: "c".repeat(64) });

    await waitFor(() => { expect(screen.getByText("INT. HARBOR OFFICE — DUSK")).toBeInTheDocument(); });
  });

  it("asks before the edit link throws away typed rejection notes", async () => {
    // Opening the editor unmounts this page, and the notes box is the one place a rejection's
    // words exist — nothing has posted them yet. So the link asks, and a no leaves the page and
    // the words exactly where they were.
    mount(gateView());
    await screen.findByText(SCRIPT_LINE);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.change(screen.getByLabelText("notes"), { target: { value: "scene 4 reads as two scenes — split it" } });
    fireEvent.click(screen.getByRole("link", { name: /^edit$/i }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("notes")).toHaveValue("scene 4 reads as two scenes — split it");
    expect(screen.getByText(SCRIPT_LINE)).toBeInTheDocument();
  });
});

/** The casting gate as a choice (Ryan's ruling, 2026-10-30: "it was more 'listening to the
 *  choices' and less 'pick a choice' kinda page").
 *
 *  What these tests are about is the one fact the gate had no way to carry before: **which take
 *  the showrunner chose**. An approve note naming takes ("approved, hallet2 and veleth2") was read
 *  by nothing, and the render that followed used whatever the manifest already said. So the page
 *  draws a radio per take per guest and the answer carries the picks, which the server writes into
 *  `tts-script.json` before the gate is answered (`test/casting-picks.test.ts`).
 *
 *  Every url here is the artifact's own (`url`, `listUrl`), and every pick is
 *  `${artifact.path}/<take>`: the casting block's `dir` is a show-relative path the server does not
 *  build a url from, and a page that concatenated it would be a second declaration of the artifact
 *  route's shape (`server/gates.ts`'s `artifactUrl`). */
describe("the casting gate's choice", () => {
  it("at the casting gate, offers each guest's takes as a choice with the manifest's take preselected", async () => {
    mount(castingView());
    const pim = await screen.findByRole("group", { name: /Pim/ });

    // The fieldset's radios are the guest's own takes, in the order the listing is sorted in, and
    // their values are the show-relative paths a pick is made of — not urls.
    const radios = within(pim).getAllByRole("radio");
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual([`${REFS_PATH}/pim-1.wav`, `${REFS_PATH}/pim-2.wav`]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect((radios[1] as HTMLInputElement).checked).toBe(false);
    // `pim.txt` is a transcript and not a take: it is under both takes and is neither of them.
    expect(await screen.findAllByText(PIM_TRANSCRIPT)).toHaveLength(2);
  });

  it("sends the picks with Approve", async () => {
    const { fetchMock } = mount(castingView());
    const pim = await screen.findByRole("group", { name: /Pim/ });
    fireEvent.click(within(pim).getByLabelText("pim-2.wav"));

    // What Approve is about to do, in words, beside the button: the sentence names the take and
    // not the path, because the take's name is what the operator just listened to.
    expect(screen.getByText("Approve casts Pim from pim-2.wav.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => { expect(postedBody(fetchMock)).not.toBeUndefined(); });
    expect(postedBody(fetchMock)).toMatchObject({
      approved: true,
      expectedAttempt: 1,
      picks: { Pim: `${REFS_PATH}/pim-2.wav` },
    });
  });

  it("sends no picks with Reject", async () => {
    // A rejection sends the manifest back to the casting fix agent, so writing a cast list into it
    // on the way out would be editing the file the agent is about to be told is wrong.
    const { fetchMock } = mount(castingView());
    await screen.findByRole("group", { name: /Pim/ });
    fireEvent.change(screen.getByLabelText("notes"), { target: { value: "none of these — record Pim again" } });
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));

    await waitFor(() => { expect(postedBody(fetchMock)).not.toBeUndefined(); });
    const body = postedBody(fetchMock)!;
    expect(body["approved"]).toBe(false);
    expect("picks" in body).toBe(false);
  });

  /** The grouping rule, which is the engine's and not this page's: the `refs-ready` guard lowercases
   *  every WAV in the directory and matches a guest's take with `startsWith(slug)`
   *  (`engine/src/needs.ts:141,179`). So the page groups a take with the guest whose slug is the
   *  **longest** slug the take's lowercased name starts with — any other rule would draw a choice
   *  the guard does not see, and a take the operator picked would not be a take the pipeline counts
   *  as that guest's. Three names the old transcript-stem rule dropped on the floor: `hallet2.wav`
   *  (no hyphen before the number), `Hallet-1.wav` (capitalised) and `hallet_warm.wav` (a word where
   *  a number was expected). */
  it("groups every take the engine's guard would match, whatever the name after the slug", async () => {
    refsListing.entries = [
      { name: "hallet2.wav", size: 1, isDir: false },
      { name: "Hallet-1.wav", size: 1, isDir: false },
      { name: "hallet_warm.wav", size: 1, isDir: false },
    ];
    mount(castingView({
      casting: { dir: REFS_PATH, guests: [{ name: "Hallet", slug: "hallet", current: `${REFS_PATH}/Hallet-1.wav` }] },
    }));
    const hallet = await screen.findByRole("group", { name: "Hallet" });

    const radios = within(hallet).getAllByRole("radio") as HTMLInputElement[];
    // Sorted by code unit on both sides: the fieldset's own order is `localeCompare`'s, which puts
    // punctuation and digits where the platform's collation puts them, and that is not what this
    // test is about.
    expect(radios.map((r) => r.value).sort()).toEqual([
      `${REFS_PATH}/Hallet-1.wav`, `${REFS_PATH}/hallet2.wav`, `${REFS_PATH}/hallet_warm.wav`,
    ].sort());
    // And the preselection is still path equality with the manifest's take, which here is the
    // capitalised one.
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual([`${REFS_PATH}/Hallet-1.wav`]);
  });

  it("gives a take to the longest slug it starts with, so a junior does not land in the senior's fieldset", async () => {
    refsListing.entries = [
      { name: "hale-1.wav", size: 1, isDir: false },
      { name: "hale-junior-1.wav", size: 1, isDir: false },
    ];
    mount(castingView({
      casting: {
        dir: REFS_PATH,
        guests: [
          { name: "Hale", slug: "hale", current: `${REFS_PATH}/hale-1.wav` },
          { name: "Hale Junior", slug: "hale-junior", current: `${REFS_PATH}/hale-junior-1.wav` },
        ],
      },
    }));
    const hale = await screen.findByRole("group", { name: "Hale" });
    const junior = await screen.findByRole("group", { name: "Hale Junior" });

    expect((within(hale).getAllByRole("radio") as HTMLInputElement[]).map((r) => r.value))
      .toEqual([`${REFS_PATH}/hale-1.wav`]);
    expect((within(junior).getAllByRole("radio") as HTMLInputElement[]).map((r) => r.value))
      .toEqual([`${REFS_PATH}/hale-junior-1.wav`]);
  });

  /** The picks the page posts are exactly the takes it drew as radios, and nothing else (the fix
   *  wave's F2). The manifest can cast a guest from a file this directory does not hold — a take
   *  recorded for another episode, `Production/s01e07/guest-refs/hallet-1.wav` — and a page that
   *  seeded its picks from the manifest would post that path, which the answer route then refuses
   *  by the fence for a choice the operator never made. So no radio means no pick: the guest is
   *  absent from the posted map and the manifest's own `ref` for them is left alone. */
  it("posts a pick only for a guest whose cast take is one of the radios it drew", async () => {
    const { fetchMock } = mount(castingView({
      casting: {
        dir: REFS_PATH,
        guests: [
          { name: "Pim", slug: "pim", current: `${REFS_PATH}/pim-1.wav` },
          { name: "Hallet", slug: "hallet", current: "Production/s01e07/guest-refs/hallet-1.wav" },
        ],
      },
    }));
    await screen.findByRole("group", { name: "Pim" });

    // The sentence beside Approve still names the manifest's take for the guest with no radio,
    // through its `?? guest.current` fallback — what Approve does to that guest is nothing.
    expect(screen.getByText("Approve casts Pim from pim-1.wav, Hallet from hallet-1.wav.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => { expect(postedBody(fetchMock)).not.toBeUndefined(); });
    const body = postedBody(fetchMock)!;
    expect(body["picks"]).toEqual({ Pim: `${REFS_PATH}/pim-1.wav` });
    expect(body["approved"]).toBe(true);
    // The stub answers the POST 200, as the route does for picks it accepts, and the page shows no
    // refusal: the path the operator never chose was never sent to be refused.
    expect(screen.queryByText(/must begin with/)).toBeNull();
  });

  it("says no take is named for a guest this directory holds none for, and draws no radio there", async () => {
    mount(castingView({
      casting: {
        dir: REFS_PATH,
        guests: [
          { name: "Pim", slug: "pim", current: `${REFS_PATH}/pim-1.wav` },
          { name: "Hallet", slug: "hallet", current: `${REFS_PATH}/hallet-1.wav` },
        ],
      },
    }));
    const hallet = await screen.findByRole("group", { name: "Hallet" });

    expect(within(hallet).queryAllByRole("radio")).toHaveLength(0);
    expect(within(hallet).getByText("no take in this directory is named for Hallet")).toBeInTheDocument();
    // Pim's two are still the only radios on the page, so the empty fieldset took nothing from her.
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  /** A reload is the one thing on this page that throws a choice away: it refetches the gate and
   *  re-reads the casting from the manifest, so a take the operator picked and has not approved yet
   *  is gone. It asks first, in the wording family of the edit link's own guard, and a no does
   *  nothing at all — the radio the operator chose is still the radio that is checked. */
  it("asks before a reload drops a take the operator picked, and keeps the choice on a no", async () => {
    mount(castingView());
    const pim = await screen.findByRole("group", { name: "Pim" });
    fireEvent.click(within(pim).getByLabelText("pim-2.wav"));

    // The reload button exists only once the run has written to its log since the gate was opened,
    // which is what the notice banner is about.
    deliver({ type: "run", show: "harbor", episodeId: "s02e01", runId: RUN_ID, offset: 512 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: /reload the gate/i }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect((within(pim).getByLabelText("pim-2.wav") as HTMLInputElement).checked).toBe(true);
    expect((within(pim).getByLabelText("pim-1.wav") as HTMLInputElement).checked).toBe(false);
  });

  it("checks nothing and says so when the manifest casts a take this directory does not hold, and leaves a take no guest claims as a player", async () => {
    // Two cases the directory and the manifest can disagree about. The manifest's take is gone —
    // renamed, or recorded into another directory — so no radio can be preselected, and a page
    // that silently checked the first take would invent a choice nobody made. And a take whose
    // name matches no guest's slug belongs to nobody in this cast: it stays audible, outside every
    // fieldset, with no radio to pick it.
    refsListing.entries = [...REFS_ENTRIES, { name: "harbor-crowd.wav", size: 1, isDir: false }];
    mount(castingView({
      casting: { dir: REFS_PATH, guests: [{ name: "Pim", slug: "pim", current: `${REFS_PATH}/pim-7.wav` }] },
    }));
    const pim = await screen.findByRole("group", { name: /Pim/ });

    const radios = within(pim).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect(within(pim).getByText("the manifest casts pim-7.wav, which is not in this directory")).toBeInTheDocument();

    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByText("harbor-crowd.wav")).toBeInTheDocument();
  });
});

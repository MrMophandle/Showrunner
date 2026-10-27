// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConsoleContext, type ConsoleData } from "../../src/api.js";
import { Edit } from "../../src/pages/Edit.js";

/** The editor page, under Ryan's ruling of 2026-10-27: **one file, one version.** The box holds
 *  the file on disk, Save writes it, and a save over a file that changed underneath is refused
 *  with the typed text left in the box — never silently overwritten, never silently discarded.
 *
 *  Every test below is about one half of that ruling, which is why they are page tests and not
 *  component tests: the ruling is about what the box, the Save button and the notice are each
 *  holding at the same moment, and no component below the page holds two of those at once.
 *
 *  **The four stubs** are `gate-page.test.tsx`'s, and its header explains why each is needed:
 *  `fetch` keyed on the url (this page reads the file as JSON and writes it back to the same
 *  address), `EventSource` because jsdom implements none and `useSSE` opens the channel on mount,
 *  `MemoryRouter` with the real route because the page reads `:show`, `:id`, `:run` and the splat
 *  off `useParams` and builds every address from them, and `ConsoleContext.Provider` because
 *  `canAct` is what decides whether Save exists at all (ruling H-03) and the context's default is
 *  `canAct: false`.
 *
 *  This file keeps one addition to those four: `channel`, the `FakeEventSource` the page most
 *  recently opened, so a `file` notice can be delivered to the page the way the server would
 *  deliver it. The notice carries no author, so the two cases the page has to tell apart — the
 *  echo of its own save and someone else's write — are told apart by hash, and that is a thing
 *  only a delivered message can test. The channel is nulled between mounts by `api.ts`'s
 *  `closeIfIdle`, which runs when the last subscriber unmounts.
 *
 *  Harbor Lights is the fixture show's world, as everywhere else in this suite. */
afterEach(cleanup);
// The navigation tests spy on `window.confirm`; vitest is not configured to restore mocks between
// tests, so a spy left standing would answer the next test's confirm as well.
afterEach(() => { vi.restoreAllMocks(); });

const FILE_URL = "/api/shows/harbor/episodes/s02e01/runs/r1/files/Episodes/s02e01/script.md";
const EDIT_HREF = "/shows/harbor/episodes/s02e01/runs/r1/edit/Episodes/s02e01/script.md";
const TEXT = "## COLD OPEN\n\nVale checked the tide table twice.\n";
const HASH = "a".repeat(64);
const NEW_HASH = "b".repeat(64);
/** What the gate's route renders under `mount`. "Back to the gate" is an in-app navigation — no
 *  document unloads and no `beforeunload` fires — so the only way a test can see that the link was
 *  followed is that the other route's element is on the screen in the editor's place. */
const GATE_MARK = "the gate page, where the link goes";

/** What the file route answers a `GET` with, mutable so a test can change the file underneath the
 *  page the way another editor would. `stubFetch` resets it. */
const disk = { text: TEXT, hash: HASH };

/** jsdom has no `EventSource`; the page opens the console's channel on mount. The instance is
 *  kept so a test can hand the page a notice. */
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

/** The notice the server publishes after a successful save of this page's file. */
function fileNotice(hash: string, path = "Episodes/s02e01/script.md") {
  return { type: "file", show: "harbor", episodeId: "s02e01", runId: "r1", path, hash };
}

/** The network: the file read, and a POST that answers as `onPost` says. */
function stubFetch(onPost: (body: unknown) => Response): ReturnType<typeof vi.fn> {
  disk.text = TEXT;
  disk.hash = HASH;
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === FILE_URL && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ path: "Episodes/s02e01/script.md", text: disk.text, hash: disk.hash }), { status: 200 });
    }
    if (url === FILE_URL && init?.method === "POST") return onPost(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
  return fetchMock;
}

/** The page at its own route, with the show's writability as the layout would have resolved it. */
function mount(canAct = true) {
  const data: ConsoleData = {
    show: null, showError: null, canAct, readOnly: !canAct,
    rows: null, rowsError: null, rowsLoading: false, refetchRows: () => {},
  };
  return render(
    <ConsoleContext.Provider value={data}>
      <MemoryRouter initialEntries={[EDIT_HREF]}>
        <Routes>
          <Route path="/shows/:show/episodes/:id/runs/:run/edit/*" element={<Edit />} />
          <Route path="/shows/:show/episodes/:id/runs/:run/gate" element={<p>{GATE_MARK}</p>} />
        </Routes>
      </MemoryRouter>
    </ConsoleContext.Provider>,
  );
}

describe("the editor page", () => {
  it("shows the file's text in the box and renders its heading in the preview", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    expect(box).toHaveValue(TEXT);
    expect(screen.getByRole("heading", { name: "COLD OPEN" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the gate/i })).toHaveAttribute("href", "/shows/harbor/episodes/s02e01/runs/r1/gate");
  });

  it("saves the typed text against the hash it read, then shows the save", async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ path: "Episodes/s02e01/script.md", hash: NEW_HASH, bytes: 10 }), { status: 200 }));
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    const save = screen.getByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();
    fireEvent.change(box, { target: { value: TEXT + "\nMaeve said nothing.\n" } });
    expect(save).toBeEnabled();
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(/^saved/i)).toBeInTheDocument());
    const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({ text: TEXT + "\nMaeve said nothing.\n", baseHash: HASH });
    expect(save).toBeDisabled();
  });

  it("keeps the typed text and says so when the save is refused as stale", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "Episodes/s02e01/script.md changed on disk since the editor read it; reload to see the current text", hash: NEW_HASH }), { status: 409 }));
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    fireEvent.change(box, { target: { value: "my edit\n" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/changed on disk/i)).toBeInTheDocument());
    expect(box).toHaveValue("my edit\n");
    expect(screen.getByRole("button", { name: /load the current text/i })).toBeInTheDocument();
  });

  it("is read-only, with no Save, when the console cannot act on the show", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    mount(false);
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    expect(box).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });

  it("ignores the notice its own save publishes, and follows one for a hash it does not hold", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    // The echo of the page's own save: the hash it already holds, so nothing happens.
    deliver(fileNotice(HASH));
    expect(box).toHaveValue(TEXT);
    // Another show's file, and another file of this run: neither is this page's.
    disk.text = "written elsewhere\n";
    disk.hash = NEW_HASH;
    deliver({ ...fileNotice(NEW_HASH), show: "archive" });
    deliver(fileNotice(NEW_HASH, "Episodes/s02e01/outline.md"));
    expect(box).toHaveValue(TEXT);
    // This page's file, written elsewhere, with nothing typed: the box follows the disk.
    deliver(fileNotice(NEW_HASH));
    await waitFor(() => { expect(box).toHaveValue("written elsewhere\n"); });
  });

  it("keeps what is being typed when the file is written elsewhere, and offers the current text", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    fireEvent.change(box, { target: { value: "my edit\n" } });
    disk.text = "written elsewhere\n";
    disk.hash = NEW_HASH;
    deliver(fileNotice(NEW_HASH));
    await waitFor(() => expect(screen.getByText(/saved elsewhere/i)).toBeInTheDocument());
    // The ruling: a refetch never replaces what is being typed.
    expect(box).toHaveValue("my edit\n");
    // Until the showrunner asks for it, which is the one path that discards the typed text.
    fireEvent.click(screen.getByRole("button", { name: /load the current text/i }));
    await waitFor(() => { expect(box).toHaveValue("written elsewhere\n"); });
    expect(screen.queryByText(/saved elsewhere/i)).not.toBeInTheDocument();
  });

  it("sends a worker-lock refusal to the error line, with no offer to discard the edit", async () => {
    // The server answers 409 for two unrelated refusals: a file that changed on disk, which the
    // page resolves by offering the current text, and a live worker holding the run, which has
    // nothing to do with the file. The lock refusal carries no `hash`, and that is the test — so
    // the page must not offer to throw away the typed text over a run that is simply busy.
    stubFetch(() => new Response(JSON.stringify({ error: "run r1 is held by pid 4242" }), { status: 409 }));
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    fireEvent.change(box, { target: { value: "my edit\n" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => { expect(screen.getByText("run r1 is held by pid 4242")).toBeInTheDocument(); });
    expect(screen.queryByRole("button", { name: /load the current text/i })).toBeNull();
    expect(box).toHaveValue("my edit\n");
  });

  it("asks before the gate link discards unsaved text, and stays put when the answer is no", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    fireEvent.change(box, { target: { value: "my edit\n" } });
    fireEvent.click(screen.getByRole("link", { name: /back to the gate/i }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: /script\.md/i })).toHaveValue("my edit\n");
    expect(screen.queryByText(GATE_MARK)).toBeNull();
  });

  it("follows the gate link when the showrunner accepts the loss", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount();
    const box = await screen.findByRole("textbox", { name: /script\.md/i });
    fireEvent.change(box, { target: { value: "my edit\n" } });
    fireEvent.click(screen.getByRole("link", { name: /back to the gate/i }));

    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => { expect(screen.getByText(GATE_MARK)).toBeInTheDocument(); });
  });

  it("does not ask at all when nothing is typed, which is the ordinary way back", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();
    await screen.findByRole("textbox", { name: /script\.md/i });
    fireEvent.click(screen.getByRole("link", { name: /back to the gate/i }));

    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => { expect(screen.getByText(GATE_MARK)).toBeInTheDocument(); });
  });
});

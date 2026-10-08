// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BibleFileView } from "../../shared/types.js";
import { GatePanel, type GatePanelProps } from "../../src/components/GatePanel.js";
import { QuestionForm } from "../../src/components/QuestionForm.js";
import { ApprovedPanel } from "../../src/pages/Bible.js";
import { GATE_BUTTONS, readOnlyLine, type GateChoiceKey } from "../../src/projections.js";

/** The Bible page's gate panel (Task 6), rendered. This is the half of that page that cannot be
 *  tested as a projection: `test/client/bible-projection.test.ts` already covers `biblePanelFor`,
 *  `answersDirty` and the chip classes, which answer "which panel does this row get"; what is left
 *  is "and does that panel offer the right answers" — four buttons, one of them refused until the
 *  file can be read, each carrying its own field's content back to the caller.
 *
 *  **Why the disabled Approve is the load-bearing assertion.** A bible gate can be open on a file
 *  that was never written: the writer agent is what writes it, and `content` arrives as
 *  `undefined` when the server could not read it off disk. Approving a file nobody can see is the
 *  one answer of the four that cannot be taken back — the engine copies the approval into the
 *  show's git history and the interview moves on — so the button is not offered in that state
 *  while the other three, each of which is a way *out* of that state, stay available.
 *
 *  **`expectedAttempt` is not asserted here, because this component does not produce it.**
 *  `GatePanel` takes `attempt` as a prop and renders it, deliberately deriving nothing (its own
 *  doc comment says why: "the number on the screen and the number in the body must be the same
 *  one"). The page that owns the fetch, `src/pages/Bible.tsx`, is what puts `expectedAttempt` into
 *  the POST body. So the assertion available at this altitude is that the attempt the panel was
 *  handed is the attempt it displays, and that a click hands the caller the choice it was clicked
 *  for; the request body belongs to a test of the page, which needs the router and the console
 *  context and is not this file's subject.
 *
 *  `// @vitest-environment jsdom` on line 1 and the hand-registered `cleanup` below are explained
 *  in `test/client/ProgressBar.test.tsx`'s header. */
afterEach(cleanup);

/** One of the four answers' labels, by key, read from `GATE_BUTTONS` rather than retyped here.
 *  The labels are long sentences ("I will write this one myself — write the empty template over it
 *  and approve"), and a copy of one in this file would be a second place to edit and a test that
 *  passed while the screen said something else. */
function labelOf(key: GateChoiceKey): string {
  const found = GATE_BUTTONS.find((b) => b.key === key);
  if (found === undefined) throw new Error(`GATE_BUTTONS carries no ${key} button`);
  return found.label;
}

/** The file a gate is open on. Harbor Lights is the fixture show's world, as everywhere else in
 *  this suite — the engine repository names no real show. */
const CONTENT = "# Harbor Lights — the world\n\nThe harbor is the town's one employer.\n";

/** The gate's message. Its heading starts at `## ` so that `Markdown` renders it as an `h3` and it
 *  cannot be confused with the panel's own `h2`s when a query asks for a heading by name. */
const MESSAGE = "## what to check\n\nRead it against the answers before approving.";

/** The panel with everything a gate on `world-overview` carries, and whatever the test overrides.
 *  `exactOptionalPropertyTypes` refuses an explicit `undefined` for an optional prop, so overrides
 *  are spread rather than assigned — except `content`, which is declared `string | undefined` and
 *  is the one prop whose `undefined` is a state the component is built around. */
function panel(over: Partial<GatePanelProps> = {}) {
  const props: GatePanelProps = {
    message: MESSAGE,
    attempt: 1,
    content: CONTENT,
    fileRel: "Canon/world-overview.md",
    rawUrl: "/api/shows/show/bible/world-overview/file",
    canAct: true,
    onAnswer: vi.fn(),
    ...over,
  };
  return { props, ...render(<GatePanel {...props} />) };
}

describe("GatePanel", () => {
  it("offers the four answers the terminal offers, by the labels GATE_BUTTONS carries", () => {
    panel();
    expect(GATE_BUTTONS.length).toBe(4);
    for (const button of GATE_BUTTONS) {
      expect(screen.getByRole("button", { name: button.label })).toBeInTheDocument();
    }
  });

  it("shows the gate's message, the file's path and the file itself, with a raw toggle and a link", () => {
    const { container } = panel();
    expect(screen.getByRole("heading", { name: "what to check", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("Read it against the answers before approving.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Canon/world-overview.md" })).toBeInTheDocument();
    // Rendered first: the file is Markdown, and its headings are what `bible-check` looks for.
    expect(screen.getByRole("heading", { name: "Harbor Lights — the world" })).toBeInTheDocument();
    expect(container.querySelector("pre.pane-tall")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "raw" }));
    // Raw second: the same bytes, unrendered, because a bible file is read by prompts as text.
    expect(screen.queryByRole("heading", { name: "Harbor Lights — the world" })).toBeNull();
    expect(container.querySelector("pre.pane-tall")?.textContent).toBe(CONTENT);
    expect(screen.getByRole("button", { name: "rendered" })).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "open the file" }))
      .toHaveAttribute("href", "/api/shows/show/bible/world-overview/file");
  });

  it("displays the attempt and the cap it was handed, and never a number of its own", () => {
    // Both numbers come from the server now: the cap used to be the literal 10 in this panel, which
    // is a number that goes on being drawn after the engine's gate has changed. A gate that
    // declares no cap says so rather than being given one.
    panel({ attempt: 3, maxAttempts: 10 });
    expect(screen.getByText("attempt 3 of 10")).toBeInTheDocument();
    cleanup();
    panel({ attempt: 2, maxAttempts: 4 });
    expect(screen.getByText("attempt 2 of 4")).toBeInTheDocument();
    cleanup();
    panel({ attempt: 1 });
    expect(screen.getByText("attempt 1 (no cap)")).toBeInTheDocument();
  });

  it("disables Approve until the file has loaded, and leaves the other three answers available", () => {
    // The gate is open on a file the server could not read — the writer agent is what writes it,
    // so this is a real state and not a defensive branch.
    panel({ content: undefined });
    expect(screen.getByRole("button", { name: labelOf("approve") })).toBeDisabled();
    expect(screen.getByText(/this file could not be read, so there is nothing to approve/)).toBeInTheDocument();
    expect(screen.getByText("Approve is not offered for a file that could not be read.")).toBeInTheDocument();
    // "I will write this one myself" needs nothing typed, so it is the one way out that is offered
    // immediately; the other two need their own field filled in first (the next test).
    expect(screen.getByRole("button", { name: labelOf("myself") })).toBeEnabled();

    cleanup();
    panel({ content: CONTENT });
    expect(screen.getByRole("button", { name: labelOf("approve") })).toBeEnabled();
    expect(screen.queryByText("Approve is not offered for a file that could not be read.")).toBeNull();
  });

  it("refuses a rejection with no notes and an import with no path, and then offers each one", () => {
    panel();
    const reject = screen.getByRole("button", { name: labelOf("reject") });
    const importIt = screen.getByRole("button", { name: labelOf("import") });
    expect(reject).toBeDisabled();
    expect(importIt).toBeDisabled();

    fireEvent.change(screen.getByLabelText("notes — what the writer should change"), { target: { value: "the harbor is never described" } });
    expect(reject).toBeEnabled();
    expect(importIt).toBeDisabled();

    fireEvent.change(screen.getByLabelText("a file to import over this one"), { target: { value: "/Users/you/world-overview.md" } });
    expect(importIt).toBeEnabled();
  });

  it("hands one click's choice to the caller, and the answer's own field with it", () => {
    const onAnswer = vi.fn();
    panel({ onAnswer });

    fireEvent.click(screen.getByRole("button", { name: labelOf("myself") }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    // No `notes` and no `importPath`: the component spreads those in only for the two answers that
    // carry one, and a stray empty string would be a rejection note the writer had to read.
    expect(onAnswer).toHaveBeenCalledWith({ choice: "myself" });

    fireEvent.change(screen.getByLabelText("notes — what the writer should change"), { target: { value: "the harbor is never described" } });
    fireEvent.click(screen.getByRole("button", { name: labelOf("reject") }));
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith({ choice: "reject", notes: "the harbor is never described" });

    fireEvent.change(screen.getByLabelText("a file to import over this one"), { target: { value: "  /Users/you/world-overview.md  " } });
    fireEvent.click(screen.getByRole("button", { name: labelOf("import") }));
    // Trimmed: the path is handed to a route that resolves it, and a trailing space pasted out of
    // a terminal would be refused there with a message about a file nobody named.
    expect(onAnswer).toHaveBeenLastCalledWith({ choice: "import", importPath: "/Users/you/world-overview.md" });
  });

  it("offers nothing while an answer is in flight, and says which one", () => {
    panel({ busy: "approve" });
    expect(screen.getByRole("button", { name: "answering…" })).toBeInTheDocument();
    for (const key of ["reject", "myself", "import"] as const) {
      expect(screen.getByRole("button", { name: labelOf(key) })).toBeDisabled();
    }
  });

  it("offers no answer at all on a read-only show, and says why in its place", () => {
    // The server answers 403 to the gate route for a read-only show, so a button here would be a
    // move the console does not have.
    panel({ canAct: false, readOnlyNote: readOnlyLine("archive", "no gate is answered here") });
    for (const button of GATE_BUTTONS) {
      expect(screen.queryByRole("button", { name: button.label })).toBeNull();
    }
    expect(screen.getByText(readOnlyLine("archive", "no gate is answered here"))).toBeInTheDocument();
    // The file is still shown whole: a read-only show is one an operator reads.
    expect(screen.getByRole("heading", { name: "Harbor Lights — the world" })).toBeInTheDocument();
  });

  it("says that the engine refused an answer written against an older attempt, rather than hiding it", () => {
    panel({ moved: 'gate "world-overview" is open at attempt 2, not 1' });
    expect(screen.getByText('gate "world-overview" is open at attempt 2, not 1')).toBeInTheDocument();
    expect(screen.getByText("Your answer was refused, not applied.")).toBeInTheDocument();
  });

  it("offers a reload when the file's log grew while the gate was being read", () => {
    const onReload = vi.fn();
    panel({ changed: true, onReload });
    expect(screen.getByText(/this file has written to its log since you opened the gate/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "reload the gate" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

/** The approved panel, which is the Bible page's read-only end: the file as it stands, a chip
 *  naming which of the three approvals it was, and the sentence that says what that means for the
 *  author.
 *
 *  **The assertion that matters is the imported file's source path.** The sentence for `imported`
 *  promises the author that the gate "was approved with that path in the log", and until
 *  `BibleFileView.note` existed the panel had no field to read the path from — so the one state
 *  whose note carries information the sentence cannot restate was the one state that did not show
 *  it. For `written-by-author` the note is a constant the sentence already says in better words,
 *  and showing it would be the same thing twice. */
describe("ApprovedPanel", () => {
  const RAW = "/api/shows/show/bible/world-overview/file";

  /** An approved view. `content` is given as a flag rather than as an optional override, because
   *  `exactOptionalPropertyTypes` makes "absent" and "present and undefined" two different things —
   *  and "the file is approved in its log and cannot be read off disk now" is the absent one. */
  function approved(over: Partial<BibleFileView> = {}, readable = true): BibleFileView {
    return {
      key: "world-overview", file: "Canon/world-overview.md", mode: "interview",
      purpose: "The premise and the cast.", state: "approved", questions: 9, answered: 9,
      questionsList: [], prior: true, ...(readable ? { content: CONTENT } : {}),
      ...over,
    };
  }

  it("names the imported file's source path, from the notes on the approving gate", () => {
    render(<ApprovedPanel view={approved({ state: "imported", note: "imported from /elsewhere/world.md" })} rawUrl={RAW} />);
    expect(screen.getByText(/a file you already had was copied over this one/)).toBeInTheDocument();
    expect(screen.getByText("imported from /elsewhere/world.md")).toBeInTheDocument();
    expect(screen.getByText("imported")).toBeInTheDocument();
  });

  it("does not repeat the author's own note, or invent one for a plain approval", () => {
    // `written-by-author`'s note is the constant the panel's own sentence says at length.
    render(<ApprovedPanel view={approved({ state: "written-by-author", note: "the author writes this file" })} rawUrl={RAW} />);
    expect(screen.getByText(/you took this one over/)).toBeInTheDocument();
    expect(screen.queryByText("the author writes this file")).toBeNull();
    cleanup();
    // And a file the writer wrote records no notes at all.
    render(<ApprovedPanel view={approved()} rawUrl={RAW} />);
    expect(screen.getByText("approved as the writer wrote it.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Harbor Lights — the world" })).toBeInTheDocument();
  });

  it("says so when a file is approved in its log and cannot be read off disk now", () => {
    render(<ApprovedPanel view={approved({}, false)} rawUrl={RAW} />);
    expect(screen.getByText(/approved in its log but could not be read off disk/)).toBeInTheDocument();
  });
});

/** The question form's two buttons, and the one thing about them that was wrong: "Save answers"
 *  marked the form clean before the POST had answered.
 *
 *  `onSave` is `Bible.tsx`'s `saveAnswers`, which can fail — a 409 for a file that asks nothing, a
 *  read-only show's 403, a write that did not land. The form read clean afterwards and its button
 *  was disabled by `!dirty`, so the only remaining way to re-post the answers was "Write it", which
 *  starts a twenty-minute writer run against the answers that are on disk rather than the ones in
 *  the textarea. */
describe("QuestionForm's save", () => {
  function form(onSave: (answers: Record<string, string>) => Promise<void>) {
    const view: BibleFileView = {
      key: "world-overview", file: "Canon/world-overview.md", mode: "interview",
      purpose: "The premise and the cast.", state: "answering", questions: 1, answered: 0,
      questionsList: [{ heading: "The premise", question: "What is the show about?", answer: "" }],
      prior: false,
    };
    return render(
      <QuestionForm view={view} canAct={true} busy={null} onSave={onSave} onWrite={vi.fn()} />,
    );
  }

  /** Types into the one textarea, so the form is dirty and "Save answers" is live. */
  function type(text: string): void {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  }

  it("leaves the form dirty when the save fails, so the answers can be posted again", async () => {
    const onSave = vi.fn<(answers: Record<string, string>) => Promise<void>>()
      .mockRejectedValue(new Error("show is read-only"));
    form(onSave);
    type("A week on the water.");
    const button = screen.getByRole("button", { name: "Save answers" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1); });
    // Still live: the bytes never landed, so the form must not claim they did.
    expect(screen.getByRole("button", { name: "Save answers" })).toBeEnabled();
  });

  it("marks the answers saved once the write has landed", async () => {
    const onSave = vi.fn<(answers: Record<string, string>) => Promise<void>>().mockResolvedValue(undefined);
    form(onSave);
    type("A week on the water.");
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    await waitFor(() => { expect(screen.getByRole("button", { name: "Save answers" })).toBeDisabled(); });
    expect(onSave).toHaveBeenCalledWith({ "The premise": "A week on the water." });
  });
});

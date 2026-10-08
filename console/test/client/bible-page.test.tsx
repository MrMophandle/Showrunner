// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GatePanel, type GatePanelProps } from "../../src/components/GatePanel.js";
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

  it("displays the attempt it was handed, and never a number of its own", () => {
    panel({ attempt: 3 });
    expect(screen.getByText("attempt 3 of 10")).toBeInTheDocument();
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

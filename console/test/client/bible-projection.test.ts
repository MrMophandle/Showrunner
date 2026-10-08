import { describe, expect, it } from "vitest";
import { GATE_CHOICES, slugFrom } from "@showrunner/tools";
import type { BibleRow, BibleState } from "../../shared/types.js";
import {
  BIBLE_APPROVED_STATES, GATE_BUTTONS, answersDirty, bibleChipClass, bibleFinishable,
  biblePanelFor, showSlugFrom,
} from "../../src/projections.js";

/** The Bible page's pure projections: which panel a file gets, whether its form holds anything
 *  that is not on disk, whether the setup can be finished, and the two values the client has to
 *  **copy** out of `@showrunner/tools` because that package cannot be imported by a browser bundle.
 *
 *  The last two tests are the point of this file. `slugFrom` and `GATE_CHOICES` are exported from
 *  `@showrunner/tools`, but the modules declaring them import `node:fs/promises` and
 *  `@showrunner/engine`, so `console/src/` holds a copy of each (`showSlugFrom`, `GATE_BUTTONS`).
 *  This suite runs in Node (`vitest.config.ts`: `environment: "node"`), so it can import both the
 *  original and the copy and assert they agree — which is what keeps a copy from becoming a
 *  divergence. A show created through the browser form whose slug disagreed with the one `init`
 *  writes into `showrunner.json` would name its NAS files one way and its config another. */

function row(over: Partial<BibleRow> = {}): BibleRow {
  return {
    key: "world-overview", file: "Canon/world-overview.md", mode: "interview",
    purpose: "The premise, the tone, the rules of the world.", state: "pending",
    questions: 9, answered: 0,
    ...over,
  };
}

/** The fifteen rows as `GET /api/shows/:show/bible` answers them: thirteen gated, two scaffold,
 *  which is the shape `bibleFinishable` is asked about. */
function allFifteen(state: BibleState): BibleRow[] {
  const gated = [
    "world-overview", "series-arc", "episode-formula", "story-craft", "style-guide", "technology",
    "timeline", "season-1", "visual-style", "visual-audit-laws", "publishing-guide",
    "pipeline-artifacts", "readme",
  ];
  const rows = gated.map((key) => row({
    key, file: `Canon/${key}.md`, state,
    mode: ["story-craft", "pipeline-artifacts", "readme"].includes(key) ? "default" : "interview",
  }));
  for (const key of ["continuity-ledger", "voice-registry"]) {
    rows.push(row({ key, file: `Canon/${key}.md`, mode: "scaffold", state: "pending", questions: 0 }));
  }
  return rows;
}

describe("biblePanelFor", () => {
  it("gives each of the nine states its panel, for an interview file", () => {
    const panels = ([
      "pending", "answering", "running", "gate", "approved", "imported", "written-by-author",
      "stalled", "failed",
    ] as const).map((state) => biblePanelFor(row({ state })));
    expect(panels).toEqual([
      "questions", "questions", "running", "gate", "approved", "approved", "approved",
      "trouble", "trouble",
    ]);
  });

  it("gives a default file in pending the question form, which renders as the 'Write it' button alone", () => {
    expect(biblePanelFor(row({ key: "story-craft", mode: "default", state: "pending", questions: 0 }))).toBe("questions");
  });

  it("gives a scaffold file the scaffold panel even though its state reads pending", () => {
    // The one case where the mode beats the state: nothing ever writes a setup log for a scaffold
    // file, so its row says `pending` for the life of the show — and a question form there would
    // offer a "Write it" whose POST the server answers 409.
    expect(biblePanelFor(row({ key: "voice-registry", mode: "scaffold", state: "pending" }))).toBe("scaffold");
    expect(biblePanelFor(row({ key: "continuity-ledger", mode: "scaffold", state: "running" }))).toBe("scaffold");
  });
});

describe("bibleChipClass", () => {
  it("colours a gate amber, a run blue, an approval green and a failure red", () => {
    expect(bibleChipClass("gate")).toBe("chip chip-waiting");
    expect(bibleChipClass("running")).toBe("chip chip-running");
    expect(bibleChipClass("imported")).toBe("chip chip-approved");
    expect(bibleChipClass("stalled")).toBe("chip chip-failed");
    expect(bibleChipClass("pending")).toBe("chip chip-none");
  });
});

describe("answersDirty", () => {
  it("is clean for identical records", () => {
    expect(answersDirty({ a: "one", b: "two" }, { a: "one", b: "two" })).toBe(false);
  });

  it("is dirty when an answer changed", () => {
    expect(answersDirty({ a: "one" }, { a: "ONE" })).toBe(true);
  });

  it("treats absent, empty and whitespace-only as the same answer", () => {
    expect(answersDirty({ a: "one" }, { a: "one", b: "" })).toBe(false);
    expect(answersDirty({ a: "one", b: "   " }, { a: "one" })).toBe(false);
    expect(answersDirty({ a: "one" }, { a: "one\n" })).toBe(false);
  });

  it("is dirty for a heading the saved record never carried", () => {
    expect(answersDirty({}, { "The primary cast": "Vale — the keeper" })).toBe(true);
  });
});

describe("bibleFinishable", () => {
  it("is false before the rows have answered", () => {
    expect(bibleFinishable(null)).toBe(false);
    expect(bibleFinishable([])).toBe(false);
  });

  it("is false while any gated file is unapproved", () => {
    expect(bibleFinishable(allFifteen("pending"))).toBe(false);
    const nearly = allFifteen("approved");
    nearly[4] = row({ key: "style-guide", state: "gate" });
    expect(bibleFinishable(nearly)).toBe(false);
  });

  it("is true when every gated file is approved and only the two scaffolds are pending", () => {
    expect(bibleFinishable(allFifteen("approved"))).toBe(true);
  });

  it("counts the three approved states alike", () => {
    const mixed = allFifteen("approved");
    mixed[1] = row({ key: "series-arc", state: "written-by-author" });
    mixed[2] = row({ key: "episode-formula", state: "imported" });
    expect(bibleFinishable(mixed)).toBe(true);
    expect([...BIBLE_APPROVED_STATES]).toEqual(["approved", "imported", "written-by-author"]);
  });
});

describe("the two copies out of @showrunner/tools", () => {
  it("showSlugFrom agrees with the tools' own slugFrom", () => {
    for (const name of [
      "Harbor Lights", "Harbor-Lights", "harbor lights 2", "HarborLights", "A Show: The Sequel!",
      "  spaced  out  ", "", "1234", "Hãrbor Lights",
    ]) {
      expect(showSlugFrom(name)).toBe(slugFrom(name));
    }
  });

  it("GATE_BUTTONS is GATE_CHOICES, in order, keys and labels alike", () => {
    expect(GATE_BUTTONS.map((c) => c.key)).toEqual(GATE_CHOICES.map((c) => c.key));
    expect(GATE_BUTTONS.map((c) => c.label)).toEqual(GATE_CHOICES.map((c) => c.label));
    expect(GATE_BUTTONS).toHaveLength(4);
  });
});

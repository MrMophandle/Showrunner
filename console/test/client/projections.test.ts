import { describe, expect, it } from "vitest";
import type { EpisodeRow, RunView, StepRow } from "../../shared/types.js";
import {
  STALL_MS, composeNotesWithFlags, composeShotRejection, elapsed, firstLine, progressLabel,
  readOnlyLine, safeHref, showLabel, showReadFailure, stageLabel, stallState, stalled, titleFor,
} from "../../src/projections.js";

/** The client's pure helpers. Every one of them is a function of its arguments and a clock the
 *  caller passes in, which is the whole reason they live outside the components: a stall label
 *  that turns amber at fourteen minutes cannot be asserted through a rendered DOM without a
 *  fake timer, and this file runs with no DOM at all (`vitest.config.ts`: `environment: "node"` is
 *  this suite's default, and only the `.test.tsx` files beside this one opt into jsdom). */

/** A Board row with the fields a test cares about and nothing else. `exactOptionalPropertyTypes`
 *  refuses an explicit `undefined` for an optional field, so the overrides are spread rather than
 *  assigned. */
function row(over: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    id: "s02e01", title: "A Week on the Water", stage: "IDEA", status: "none",
    needs: { ideaMissing: false, refsMissing: [], imagesMissing: [] },
    ...over,
  };
}

function step(over: Partial<StepRow> = {}): StepRow {
  return { id: "outline", kind: "agent", status: "pending", ...over };
}

function view(over: Partial<RunView> = {}): RunView {
  return {
    episodeId: "s02e01", runId: "20261002-120000-abcd", status: "running", stage: "DRAFT_OUTLINE",
    steps: [], pipeline: { name: "episode", hashNow: "0".repeat(64), changed: false }, offset: 0,
    ...over,
  };
}

describe("elapsed", () => {
  it("reads minutes and zero-padded seconds", () => {
    expect(elapsed("2026-10-02T10:00:00Z", new Date("2026-10-02T10:12:05Z"))).toBe("12m 05s");
  });

  it("reads hours and zero-padded minutes once past an hour", () => {
    expect(elapsed("2026-10-02T10:00:00Z", new Date("2026-10-02T13:07:00Z"))).toBe("3h 07m");
  });

  it("clamps a clock that is behind the event to zero rather than reporting a negative age", () => {
    expect(elapsed("2026-10-02T10:00:00Z", new Date("2026-10-02T09:59:30Z"))).toBe("0m 00s");
  });

  it("says nothing it cannot know for an absent or unparseable timestamp", () => {
    expect(elapsed(undefined, new Date("2026-10-02T10:00:00Z"))).toBe("—");
    expect(elapsed("not a timestamp", new Date("2026-10-02T10:00:00Z"))).toBe("—");
  });
});

describe("stalled", () => {
  const at = "2026-10-02T10:00:00Z";
  const plus = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000);

  it("is true past the fourteen-minute threshold", () => {
    expect(stalled(at, plus(15))).toBe(true);
  });

  it("is false before it", () => {
    expect(stalled(at, plus(13))).toBe(false);
  });

  it("takes the threshold as a parameter, defaulting to fourteen minutes", () => {
    expect(STALL_MS).toBe(14 * 60_000);
    expect(stalled(at, plus(3), 2 * 60_000)).toBe(true);
    expect(stalled(at, plus(1), 2 * 60_000)).toBe(false);
  });

  it("is false for a run that has no last event at all", () => {
    expect(stalled(undefined, plus(99))).toBe(false);
  });
});

describe("stageLabel", () => {
  it("classes a NEEDS_ stage as needs and spaces its name", () => {
    expect(stageLabel("NEEDS_REFS")).toEqual({ kind: "needs", text: "NEEDS REFS" });
  });

  it("classes a DRAFT_ stage as draft", () => {
    expect(stageLabel("DRAFT_SCRIPT")).toEqual({ kind: "draft", text: "DRAFT SCRIPT" });
  });

  it("classes every other stage as approved", () => {
    expect(stageLabel("SCRIPT")).toEqual({ kind: "approved", text: "SCRIPT" });
    expect(stageLabel("PUBLISH_KIT")).toEqual({ kind: "approved", text: "PUBLISH KIT" });
    expect(stageLabel("COMPLETE")).toEqual({ kind: "approved", text: "COMPLETE" });
  });
});

describe("composeShotRejection", () => {
  it("writes one line per flagged shot and says redo where the operator said nothing", () => {
    // The brief's own example names a character of the show this repository is written for; the
    // engine repository names no show, so the shot ids here are the invented one's (`Harbor
    // Light`, `test/helpers.ts`). The assertion's shape is the brief's.
    expect(composeShotRejection({ "s03-vale-still": "she reads too large", "s05-harbor-wide": "" }))
      .toBe("s03-vale-still: she reads too large\ns05-harbor-wide: redo");
  });

  it("orders the lines by shot id rather than by the order they were flagged in", () => {
    expect(composeShotRejection({ "s05-wide": "too dark", "s03-still": "" }))
      .toBe("s03-still: redo\ns05-wide: too dark");
  });

  it("trims the note and is empty for no flags", () => {
    expect(composeShotRejection({ "s01-a": "  too dark  " })).toBe("s01-a: too dark");
    expect(composeShotRejection({})).toBe("");
  });
});

describe("composeNotesWithFlags", () => {
  it("puts the composed block above the operator's own prose", () => {
    const first = composeNotesWithFlags("", "", { "s03-still": "too large" });
    expect(first).toEqual({ notes: "s03-still: too large", block: "s03-still: too large" });

    const typed = `${first.notes}\n\nand the whole act reads cold`;
    const second = composeNotesWithFlags(typed, first.block, { "s03-still": "too large", "s05-wide": "" });
    expect(second.notes).toBe("s03-still: too large\ns05-wide: redo\n\nand the whole act reads cold");
    expect(second.block).toBe("s03-still: too large\ns05-wide: redo");
  });

  it("keeps prose the operator wrote before ever flagging anything", () => {
    const result = composeNotesWithFlags("the pacing is the problem", "", { "s01-a": "" });
    expect(result.notes).toBe("s01-a: redo\n\nthe pacing is the problem");
  });

  it("takes the block back out when the last flag is cleared", () => {
    const flagged = composeNotesWithFlags("mind the eyeline", "", { "s01-a": "" });
    const cleared = composeNotesWithFlags(flagged.notes, flagged.block, {});
    expect(cleared).toEqual({ notes: "mind the eyeline", block: "" });
  });

  it("leaves a note it did not compose alone", () => {
    const result = composeNotesWithFlags("s01-a: redo", "", {});
    expect(result).toEqual({ notes: "s01-a: redo", block: "" });
  });
});

describe("showLabel", () => {
  it("names a show by its name and its key, which is what tells two of them apart", () => {
    expect(showLabel({ showName: "Harbor Light", key: "HarborLight" })).toBe("Harbor Light · HarborLight");
    // The measured case: the live instance and the retired first repository declare the same
    // showName and the same showSlug (inventory §2.1), so the key is the only identity there is.
    expect(showLabel({ showName: "One Name", key: "live" })).not.toBe(showLabel({ showName: "One Name", key: "archive" }));
  });
});

describe("showReadFailure", () => {
  it("picks out the one row a show yields when its episodes could not be read at all", () => {
    // The server's shape (ruling H-14): an empty id, and the reason on `error`.
    expect(showReadFailure(row({ id: "", error: "broken: its episodes could not be read — Unexpected token" })))
      .toBe("broken: its episodes could not be read — Unexpected token");
  });

  it("leaves an ordinary episode row alone, including one whose own log went unreadable", () => {
    expect(showReadFailure(row({ id: "s02e01" }))).toBeUndefined();
    // `logError` is the narrower fact — this row's own log stopped being readable — and that row
    // is still an episode with a stage and an action, so it keeps the ordinary template.
    expect(showReadFailure(row({ id: "s02e01", logError: "this run's log could not be read past byte 400" }))).toBeUndefined();
    // An empty id with no reason is not a failure row either: there is nothing to print.
    expect(showReadFailure(row({ id: "" }))).toBeUndefined();
    expect(showReadFailure(row({ id: "", error: "   " }))).toBeUndefined();
  });
});

describe("readOnlyLine", () => {
  it("names the key, what is refused, and why a button is absent rather than greyed", () => {
    expect(readOnlyLine("HarborLight-archive", "no run is launched here")).toBe(
      "HarborLight-archive is read-only: no run is launched here. Two registered shows can name one NAS root, and a write in the wrong tree would overwrite a finished season.",
    );
  });
});

describe("titleFor", () => {
  const show = { showName: "Harbor Light", key: "HarborLight", readOnly: false };

  it("puts a waiting episode first, with the show's own name and key", () => {
    const rows = [row({ id: "s02e03", status: "running", stage: "DRAFT_SCRIPT" }), row({ id: "s02e01", status: "waiting", stage: "DRAFT_OUTLINE" })];
    expect(titleFor(show, rows)).toBe("⏸ s02e01 NEEDS YOU — Harbor Light · HarborLight");
  });

  it("is idle for a read-only show, because none of the other three forms is actionable there", () => {
    const archive = { ...show, key: "HarborLight-archive", readOnly: true };
    const rows = [row({ id: "s02e01", status: "waiting", stage: "DRAFT_OUTLINE" })];
    expect(titleFor(archive, rows)).toBe("Harbor Light · HarborLight-archive console");
    expect(titleFor(show, rows)).toBe("⏸ s02e01 NEEDS YOU — Harbor Light · HarborLight");
  });

  it("reports a running episode with its stage and the minutes since its last event", () => {
    const rows = [row({ id: "s02e02", status: "running", stage: "DRAFT_AUDIO", lastEventAt: "2026-10-02T10:00:00Z" })];
    expect(titleFor(show, rows, new Date("2026-10-02T10:03:40Z"))).toBe("● s02e02 DRAFT_AUDIO · 3m — Harbor Light · HarborLight");
  });

  it("ignores an archived episode: a finished season is not something the tab can ask for", () => {
    const rows = [
      row({ id: "ep01", status: "archived", stage: "COMPLETE", archiveNote: "Season 1, made by console v1; final on the NAS 2026-07-18" }),
      row({ id: "ep10", status: "archived", stage: "COMPLETE" }),
    ];
    expect(titleFor(show, rows)).toBe("Harbor Light · HarborLight console");
    // An archived row beside a waiting one leaves the waiting one's claim on the title intact.
    expect(titleFor(show, [...rows, row({ id: "s02e01", status: "waiting", stage: "DRAFT_OUTLINE" })]))
      .toBe("⏸ s02e01 NEEDS YOU — Harbor Light · HarborLight");
  });

  it("falls back to the show's console for an idle, empty or unread board", () => {
    expect(titleFor(show, [row({ status: "completed" })])).toBe("Harbor Light · HarborLight console");
    expect(titleFor(show, [])).toBe("Harbor Light · HarborLight console");
    expect(titleFor(show, null)).toBe("Harbor Light · HarborLight console");
    expect(titleFor({ showName: "Another Show", key: "another", readOnly: false }, null)).toBe("Another Show · another console");
  });
});

describe("stallState", () => {
  const at = "2026-10-02T10:00:00Z";
  const plus = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000);

  it("turns amber past fourteen minutes of silence", () => {
    const quiet = stallState(view({ lastEventAt: at, position: { stepId: "draft", startedAt: at } }), plus(15));
    expect(quiet.amber).toBe(true);
    expect(quiet.text).toBe("15m 00s since the last event");
  });

  it("stays calm before the threshold", () => {
    expect(stallState(view({ lastEventAt: at }), plus(2))).toEqual({ text: "2m 00s since the last event", amber: false });
  });

  it("excuses a render that has not reported progress yet, and says so", () => {
    const rendering = view({
      lastEventAt: at,
      position: { stepId: "render", startedAt: at },
      steps: [step({ id: "render", kind: "script", status: "running" })],
    });
    expect(stallState(rendering, plus(40))).toEqual({ text: "render running (silent)", amber: false });
  });

  it("holds a render to the threshold again once it reports progress", () => {
    const rendering = view({
      lastEventAt: at,
      position: { stepId: "render", startedAt: at },
      steps: [step({ id: "render", kind: "script", status: "running", progress: { done: 3, total: 9, unit: "frames" } })],
    });
    expect(stallState(rendering, plus(40)).amber).toBe(true);
  });

  it("says a run with no events has none rather than an age", () => {
    expect(stallState(view(), plus(1))).toEqual({ text: "no events yet", amber: false });
  });
});

describe("firstLine", () => {
  it("takes the first line of a multi-line error and trims it", () => {
    expect(firstLine("tts-generate failed: 429\n  at fetch (node:internal)\n")).toBe("tts-generate failed: 429");
  });

  it("is empty for nothing", () => {
    expect(firstLine(undefined)).toBe("");
    expect(firstLine("")).toBe("");
  });
});

describe("progressLabel", () => {
  it("reads done, total, unit, the rate and the ETA", () => {
    expect(progressLabel({ done: 12, total: 48, unit: "scenes", ratePerSec: 0.5, etaSec: 72 }))
      .toBe("12/48 scenes · 0.5/s · ETA 1m 12s");
  });

  it("leaves out a rate the log cannot support", () => {
    expect(progressLabel({ done: 12, total: 48, unit: "scenes" })).toBe("12/48 scenes");
  });

  it("reads a rate per minute when the step is slower than one unit a second", () => {
    expect(progressLabel({ done: 2, total: 9, unit: "shots", ratePerSec: 0.004 })).toBe("2/9 shots · 0.2/min");
  });
});

describe("safeHref", () => {
  it("keeps http, https, mailto and in-app paths", () => {
    expect(safeHref("https://example.test/x")).toBe("https://example.test/x");
    // The address shape the console actually serves since every route moved under its show: an
    // in-app path with no scheme, which is kept as it came.
    expect(safeHref("/api/shows/HarborLight/episodes/s02e01/files/Episodes/s02e01/outline.md"))
      .toBe("/api/shows/HarborLight/episodes/s02e01/files/Episodes/s02e01/outline.md");
    expect(safeHref("mailto:someone@example.test")).toBe("mailto:someone@example.test");
    expect(safeHref("outline.md")).toBe("outline.md");
  });

  it("refuses a scheme that executes", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("  JavaScript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeUndefined();
    expect(safeHref("vbscript:msgbox")).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });

  it("refuses a scheme split by the characters a browser strips from a url", () => {
    // `marked` keeps a tab inside an angle-bracketed markdown destination, so a gate's message can
    // produce this href verbatim. No scheme matches it, which classified it as a relative url —
    // and the browser then strips the tab and navigates to javascript:alert(1). The same holds
    // for a line feed and a carriage return.
    expect(safeHref("java\tscript:alert(1)")).toBeUndefined();
    expect(safeHref("java\nscript:alert(1)")).toBeUndefined();
    expect(safeHref("java\rscript:alert(1)")).toBeUndefined();
    // The stripped string is what comes back, so what React writes is what was judged.
    expect(safeHref("https://example.test/\tx")).toBe("https://example.test/x");
  });

  it("keeps a protocol-relative url, which is this console's own scheme and another host", () => {
    // Documented rather than refused: `//host/path` has no scheme to test and is kept as a
    // relative url. It is the smaller, separate wart the whole-branch review named beside the
    // tab case (2026-10-02 final-review.md, M-1) and left to the deferred list.
    expect(safeHref("//host.example/x")).toBe("//host.example/x");
  });
});

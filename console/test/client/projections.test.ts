import { describe, expect, it } from "vitest";
import type { EpisodeRow, RunView, StepRow } from "../../shared/types.js";
import {
  STALL_MS, composeNotesWithFlags, composeShotRejection, elapsed, firstLine, gateSummaryLine,
  iterationLabel, positionStep, progressLabel, quietRow, readOnlyLine, resetLabel, runSituation,
  safeHref, showLabel, showReadFailure, stageLabel, stallState, stalled, titleFor, waitingNote,
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

  it("is idle for a read-only show, because none of the other four forms is actionable there", () => {
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

describe("waitingNote", () => {
  /** The engine's sentence, as `step_waiting` writes it (Plan I). Quoted whole rather than
   *  paraphrased, because the console's rule for it is "verbatim" and a test that asserted a
   *  shortened version would not notice the console editing it. */
  const REASON = "waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)";

  it("answers the engine's sentence for a run asleep until a usage limit resets", () => {
    expect(waitingNote(row({ status: "running", waitingNote: REASON }))).toBe(REASON);
  });

  it("answers nothing for a row with no limit wait, including one parked at a gate", () => {
    // The gate's row is the case worth stating: its run's status is also "waiting", and the two
    // waits are told apart by the note and never by the status.
    expect(waitingNote(row({ status: "waiting", openGate: { stepId: "outline-gate", attempt: 1, openedAt: "2026-10-02T10:00:00Z" } }))).toBeUndefined();
    expect(waitingNote(row({ status: "running" }))).toBeUndefined();
    expect(waitingNote(row({ status: "running", waitingNote: "   " }))).toBeUndefined();
  });
});

describe("resetLabel", () => {
  it("renders a reset as a clock time, and says nothing about a time it cannot read", () => {
    // The zone is the browser's by design, so what is asserted is the shape rather than a
    // particular machine's answer: a test that pinned "7:50 PM" would pass only in one TZ.
    expect(resetLabel("2026-10-02T23:50:00.000Z")).toMatch(/^\d{1,2}:\d{2}(\s?[AP]M)?$/);
    // Absent, empty or unreadable renders nothing at all, which is what keeps `Invalid Date` out
    // of a tab title.
    expect(resetLabel(undefined)).toBeUndefined();
    expect(resetLabel("")).toBeUndefined();
    expect(resetLabel("not a time")).toBeUndefined();
  });
});

describe("quietRow", () => {
  const at = "2026-10-02T10:00:00Z";
  const plus = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000);
  const SLEEPING = "waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)";

  it("turns amber for a run that could be moving and has been silent past the threshold", () => {
    expect(quietRow(row({ status: "running", lastEventAt: at }), plus(15))).toBe(true);
    expect(quietRow(row({ status: "running", lastEventAt: at }), plus(13))).toBe(false);
    expect(quietRow(row({ status: "crashed", lastEventAt: at }), plus(15))).toBe(true);
  });

  it("colours nothing on a run that is not moving anyway", () => {
    // A completed run is quiet because it has finished, and a run parked at a gate is quiet
    // because it is waiting for the person reading the Board. Neither is a symptom.
    expect(quietRow(row({ status: "completed", lastEventAt: at }), plus(99))).toBe(false);
    expect(quietRow(row({ status: "waiting", lastEventAt: at }), plus(99))).toBe(false);
    expect(quietRow(row({ status: "none" }), plus(99))).toBe(false);
  });

  it("exempts a run asleep until a usage limit resets, however long the wait runs", () => {
    // Five hours of silence with a live worker holding the run: the sentence under the stage chip
    // says what the quiet is, and amber would read as "this may be stuck" (Plan I).
    const sleeping = row({ status: "running", lastEventAt: at, waitingNote: SLEEPING, waitingUntil: "2026-10-02T23:50:00.000Z" });
    expect(quietRow(sleeping, plus(295))).toBe(false);
    // A note the engine wrote blank is no note, here as everywhere else the note is read.
    expect(quietRow(row({ status: "running", lastEventAt: at, waitingNote: "  " }), plus(295))).toBe(true);
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

  it("excuses a step asleep until a usage limit resets, and still says how long it has been", () => {
    const sleeping = view({
      lastEventAt: at,
      position: { stepId: "draft", startedAt: at },
      steps: [step({ id: "draft", kind: "loop", status: "waiting", note: "waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)" })],
    });
    // The age is the number the operator wants and it is true, so it is printed; the colour that
    // means "this may be stuck" is withheld, exactly as it is for a silent render above.
    expect(stallState(sleeping, plus(295))).toEqual({ text: "4h 55m since the last event", amber: false });
  });

  it("says a run with no events has none rather than an age", () => {
    expect(stallState(view(), plus(1))).toEqual({ text: "no events yet", amber: false });
  });
});

describe("runSituation", () => {
  const NOTE = "waiting for the usage limit to reset at 7:50pm America/New_York (weekly quota 41%)";
  const at = "2026-10-15T14:00:00.000Z";
  const plus = (seconds: number) => new Date(Date.parse(at) + seconds * 1000);

  it("names the step in flight and how long it has been, for a run a worker is holding", () => {
    const running = view({
      status: "running",
      position: { stepId: "draft", startedAt: at },
      steps: [step({ id: "draft", kind: "loop", status: "running" })],
    });
    expect(runSituation(running, plus(725))).toEqual({ subject: "A worker is on it.", sentence: "draft for 12m 05s" });
  });

  it("adds the loop's iteration and the step's progress, which are two different numbers", () => {
    // The draft loop reports "2/12 scenes" against a cap of fifteen iterations: how much work is
    // done and how close the loop is to exhausting its attempts are not the same question, and a
    // line that printed only the first would hide a loop about to fail.
    const looping = view({
      status: "running",
      position: { stepId: "draft", startedAt: at },
      steps: [step({
        id: "draft", kind: "loop", status: "running",
        iteration: { n: 3, max: 15 },
        progress: { done: 2, total: 12, unit: "scenes" },
      })],
    });
    expect(runSituation(looping, plus(725))).toEqual({
      subject: "A worker is on it.",
      sentence: "draft for 12m 05s (iteration 3 of 15) · 2/12 scenes",
    });
  });

  it("says the engine's reason verbatim for a step asleep until a usage limit resets (Plan I)", () => {
    // The subject keeps its comma: the engine's sentence continues it. And the status is
    // `running`, correctly — a worker is holding the run and beating its lock — so this case has
    // to outrank the working sentence or the line would count a five-hour sleep as work.
    const sleeping = view({
      status: "running",
      position: { stepId: "draft", startedAt: at },
      steps: [step({ id: "draft", kind: "loop", status: "waiting", note: NOTE, waitingUntil: "2026-10-15T23:50:00.000Z" })],
    });
    expect(runSituation(sleeping, plus(17_700))).toEqual({ subject: "A worker is on it,", sentence: NOTE });
  });

  it("reads the same wait off a Board row, which carries the note and no steps", () => {
    // The Board's shape: `EpisodeRow.waitingNote` is the server's summary of the step row above
    // (`waitingOf`, `server/runs.ts`), and the row has no steps to look at. One sentence, so the
    // row says the wait once instead of printing it under the chip as well.
    const row_ = row({ status: "running", position: { stepId: "draft", startedAt: at }, waitingNote: NOTE });
    expect(runSituation(row_, plus(17_700))).toEqual({ subject: "A worker is on it,", sentence: NOTE });
  });

  it("falls back to 'a step is in flight' when the view names no position", () => {
    expect(runSituation(view({ status: "running" }), plus(60))).toEqual({
      subject: "A worker is on it.", sentence: "a step is in flight",
    });
  });

  it("asks for the showrunner by name for an open gate, with the gate's age and attempt", () => {
    const waiting = view({
      status: "waiting",
      openGate: { stepId: "script-gate", attempt: 2, message: "approve the script", openedAt: "2026-10-15T14:05:00.000Z" },
    });
    expect(runSituation(waiting, plus(3_600))).toEqual({
      subject: "Needs you.",
      sentence: "script-gate has been waiting for an answer since 14:05:00 (attempt 2).",
      action: "gate",
    });
  });

  it("names the failed step, its first error line and the remedy", () => {
    const failed = view({
      status: "failed",
      failed: { stepId: "tts-generate", error: "tts-generate failed: 429\n  at fetch (node:internal)" },
    });
    expect(runSituation(failed, plus(60))).toEqual({
      subject: "Needs you.",
      sentence: "Failed at tts-generate: tts-generate failed: 429. Resume runs it again from there.",
      action: "resume",
    });
  });

  it("still offers Resume for a failed run whose view names no step", () => {
    // `failedOf` (`server/runs.ts`) answers undefined when the run's state no longer calls the
    // logged failure a failure, and Resume is still the move.
    expect(runSituation(view({ status: "failed" }), plus(60))).toEqual({
      subject: "Needs you.",
      sentence: "This run failed. Resume runs it again from where it stopped.",
      action: "resume",
    });
  });

  it("says no process is holding a crashed run, and what Continue does about it", () => {
    expect(runSituation(view({ status: "crashed" }), plus(60))).toEqual({
      subject: "Needs you.",
      sentence: "No process is holding this run. Continue puts a worker back on it.",
      action: "continue",
    });
  });

  it("says a completed run needs nothing", () => {
    expect(runSituation(view({ status: "completed" }), plus(60))).toEqual({ subject: "Done.", sentence: "Nothing needs you." });
  });

  it("says an episode that has never run has not started, and offers no sentence", () => {
    expect(runSituation(row({ status: "none" }), plus(60))).toEqual({ subject: "Not started.", sentence: "" });
  });

  it("reads an archived episode as done, in the words of its own marker", () => {
    // The seventh `RunStatus`, which the Board has ten of: Season 1 was finished outside the
    // engine and says so in an `archive.json` marker instead of a log it never had.
    const archived = row({ status: "archived", stage: "APPROVED_FINAL", archiveNote: "final on the NAS, made by console v1" });
    expect(runSituation(archived, plus(60))).toEqual({ subject: "Done.", sentence: "final on the NAS, made by console v1" });
  });

  it("reads an archived episode whose marker says nothing as done all the same", () => {
    expect(runSituation(row({ status: "archived" }), plus(60))).toEqual({ subject: "Done.", sentence: "Finished outside the engine." });
  });

  it("is the same judgment on a read-only show, because who may act is the caller's question", () => {
    // Plan H's rule is about what is rendered: the projection carries no `canAct`, so a read-only
    // show's Board row says exactly what a writable one's does about the same run. The missing
    // button is asserted where it is withheld (`test/client/situation-line.test.tsx`).
    const waiting = view({
      status: "waiting",
      openGate: { stepId: "script-gate", attempt: 1, message: "approve the script", openedAt: at },
    });
    expect(runSituation(waiting, plus(60)).action).toBe("gate");
  });
});

describe("positionStep", () => {
  it("finds the in-flight step's own row", () => {
    const running = view({
      position: { stepId: "draft", startedAt: "2026-10-15T14:00:00.000Z" },
      steps: [step({ id: "outline", status: "completed" }), step({ id: "draft", kind: "loop", status: "running" })],
    });
    expect(positionStep(running)?.id).toBe("draft");
  });

  it("answers nothing for a run with nothing in flight, and for a Board row with no steps", () => {
    expect(positionStep(view({ steps: [step({ id: "draft" })] }))).toBeUndefined();
    expect(positionStep({ position: { stepId: "draft", startedAt: "2026-10-15T14:00:00.000Z" } })).toBeUndefined();
  });
});

describe("iterationLabel", () => {
  it("says which iteration of how many a loop is on", () => {
    expect(iterationLabel(step({ iteration: { n: 3, max: 15 } }))).toBe("iteration 3 of 15");
  });

  it("says nothing for a step that is not a loop or has had no iteration", () => {
    expect(iterationLabel(step())).toBeUndefined();
    expect(iterationLabel(undefined)).toBeUndefined();
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

describe("gateSummaryLine", () => {
  it("takes the sentence a gate template opens with, not the verdicts under it", () => {
    // The real shape of a script gate's message (`tools/templates/prompts/script-gate.gate.md`):
    // one sentence naming the file, then the reviewers' results, which is the half the expander
    // folds away.
    const message = [
      "Script drafted: Episodes/s02e01/script.md",
      'Panel verdict (review-gate all-pass): {"pass":true,"issues":[]}',
      "Approve to commit. Reject with notes for a targeted revision.",
    ].join("\n");
    expect(gateSummaryLine(message)).toBe("Script drafted: Episodes/s02e01/script.md");
  });

  it("skips blank lines rather than summarising a message as nothing", () => {
    expect(gateSummaryLine("\n   \n\nOutline ready: Episodes/s02e01/outline.md\n")).toBe("Outline ready: Episodes/s02e01/outline.md");
  });

  it("strips a markdown heading's markers, which a summary would otherwise print", () => {
    // The bible gate's message is written this way. A summary reading "## what to check" would be
    // the one place in the console that showed markdown source to the person reading it.
    expect(gateSummaryLine("## what to check\n\nRead it against the answers before approving.")).toBe("what to check");
  });

  it("strips a blockquote marker, a bullet and bold markers", () => {
    expect(gateSummaryLine("> ## quoted heading")).toBe("quoted heading");
    expect(gateSummaryLine("- Audio ready for s02e01")).toBe("Audio ready for s02e01");
    expect(gateSummaryLine("**Images ready** for s02e01")).toBe("Images ready for s02e01");
  });

  it("collapses runs of whitespace, so a tabbed line stays one line", () => {
    expect(gateSummaryLine("Canon updates proposed\tfor   s02e01.")).toBe("Canon updates proposed for s02e01.");
  });

  it("caps a message that has no line breaks at all, which is the case that would widen the page", () => {
    const wall = `Script drafted: ${"verdict ".repeat(60)}`;
    const summary = gateSummaryLine(wall);
    expect(summary.length).toBeLessThanOrEqual(140);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.startsWith("Script drafted: verdict")).toBe(true);
  });

  it("answers the empty string for a message with nothing in it, so the caller draws the bare label", () => {
    expect(gateSummaryLine("")).toBe("");
    expect(gateSummaryLine("   \n \t \n")).toBe("");
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

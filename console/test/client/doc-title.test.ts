import { describe, expect, it } from "vitest";
import type { EpisodeRow } from "../../shared/types.js";
import { titleFor } from "../../src/useDocTitle.js";

/** The document title is the whole alerting story on the home network: the spec rules out web
 *  notifications (LAN http is not a secure context) and the console makes no sound, so the tab's
 *  own string is what answers "does it need me?" from across the room. These assertions are the
 *  hook's pure part — `titleFor`, which `useDocTitle` sets `document.title` from — because that is
 *  the part that can be wrong in a way nobody notices. */

function row(over: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    id: "s02e01", title: "A Week on the Water", stage: "IDEA", status: "none",
    needs: { ideaMissing: false, refsMissing: [], imagesMissing: [] },
    ...over,
  };
}

describe("titleFor, the document title's pure part", () => {
  it("names the show it was given and never one of its own", () => {
    expect(titleFor("Harbor Light", [])).toBe("Harbor Light console");
    expect(titleFor("Second Show", [])).toBe("Second Show console");
  });

  it("asks for the showrunner the moment any episode is waiting, whatever else is running", () => {
    const rows = [
      row({ id: "s02e01", status: "running", stage: "DRAFT_SCRIPT", lastEventAt: "2026-10-02T10:00:00Z" }),
      row({ id: "s02e04", status: "waiting", stage: "DRAFT_IMAGES" }),
    ];
    expect(titleFor("Harbor Light", rows, new Date("2026-10-02T10:01:00Z"))).toBe("⏸ s02e04 NEEDS YOU — Harbor Light");
  });

  it("names the first waiting episode in board order when two are waiting", () => {
    const rows = [row({ id: "s02e02", status: "waiting" }), row({ id: "s02e05", status: "waiting" })];
    expect(titleFor("Harbor Light", rows)).toBe("⏸ s02e02 NEEDS YOU — Harbor Light");
  });

  it("reports a running episode's stage and the minutes since it last moved", () => {
    const rows = [row({ id: "s02e02", status: "running", stage: "DRAFT_AUDIO", lastEventAt: "2026-10-02T10:00:00Z" })];
    expect(titleFor("Harbor Light", rows, new Date("2026-10-02T10:14:59Z"))).toBe("● s02e02 DRAFT_AUDIO · 14m — Harbor Light");
  });

  it("reports zero minutes for a running episode whose log has no last event yet", () => {
    const rows = [row({ id: "s02e02", status: "running", stage: "IDEA" })];
    expect(titleFor("Harbor Light", rows)).toBe("● s02e02 IDEA · 0m — Harbor Light");
  });

  it("warns about a failed or a crashed run, which will not restart itself", () => {
    // The fourth form. A run that failed or crashed has stopped and nothing will move it until the
    // operator does, so a tab that reported it as idle would let an episode sit broken for as long
    // as nobody opened the Board.
    expect(titleFor("Harbor Light", [row({ id: "s02e07", status: "crashed", stage: "DRAFT_ASSEMBLY" })])).toBe("⚠ s02e07 CRASHED — Harbor Light");
    expect(titleFor("Harbor Light", [row({ id: "s02e08", status: "failed", stage: "CASTING" })])).toBe("⚠ s02e08 FAILED — Harbor Light");
  });

  it("asks for the showrunner before it warns, and warns before it reports a run that is working", () => {
    // Precedence, in the order of what the person at the tab can do about it: a gate is a question
    // addressed to them, a crash is a job waiting on them, and a run that is working wants nothing.
    const broken = row({ id: "s02e07", status: "crashed", stage: "DRAFT_ASSEMBLY" });
    const working = row({ id: "s02e02", status: "running", stage: "DRAFT_AUDIO", lastEventAt: "2026-10-02T10:00:00Z" });
    const asking = row({ id: "s02e04", status: "waiting", stage: "DRAFT_IMAGES" });
    expect(titleFor("Harbor Light", [working, broken])).toBe("⚠ s02e07 CRASHED — Harbor Light");
    expect(titleFor("Harbor Light", [broken, asking])).toBe("⏸ s02e04 NEEDS YOU — Harbor Light");
    // The first match in Board order, so a show with two broken episodes names the earlier one and
    // the title does not flicker between them.
    expect(titleFor("Harbor Light", [row({ id: "s02e05", status: "failed" }), broken])).toBe("⚠ s02e05 FAILED — Harbor Light");
  });

  it("is idle for a board of finished and never-run episodes, and for one it could not read", () => {
    expect(titleFor("Harbor Light", [row({ status: "completed" }), row({ id: "s02e09", status: "none" })])).toBe("Harbor Light console");
    expect(titleFor("Harbor Light", null)).toBe("Harbor Light console");
  });
});

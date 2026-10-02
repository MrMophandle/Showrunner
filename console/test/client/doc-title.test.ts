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

  it("keeps the three forms the spec names: a failed or crashed run is the Board's red, not the tab's", () => {
    // The brief's vocabulary is exactly "waiting", "running" and otherwise. A crash and a failure
    // are shown — in red, with their recovery action — on the Board and on the Run page; the tab
    // title claims only what the spec gave it, rather than inventing a fourth string.
    expect(titleFor("Harbor Light", [row({ id: "s02e07", status: "crashed", stage: "DRAFT_ASSEMBLY" })])).toBe("Harbor Light console");
    expect(titleFor("Harbor Light", [row({ id: "s02e08", status: "failed", stage: "CASTING" })])).toBe("Harbor Light console");
  });

  it("is idle for a board of finished and never-run episodes, and for one it could not read", () => {
    expect(titleFor("Harbor Light", [row({ status: "completed" }), row({ id: "s02e09", status: "none" })])).toBe("Harbor Light console");
    expect(titleFor("Harbor Light", null)).toBe("Harbor Light console");
  });
});

import { describe, expect, it } from "vitest";
import type { EpisodeRow } from "../../shared/types.js";
import type { TitleShow } from "../../src/projections.js";
import { titleFor } from "../../src/useDocTitle.js";

/** The document title is the whole alerting story on the home network: the spec rules out web
 *  notifications (LAN http is not a secure context) and the console makes no sound, so the tab's
 *  own string is what answers "does it need me?" from across the room. These assertions are the
 *  hook's pure part — `titleFor`, which `useDocTitle` sets `document.title` from — because that is
 *  the part that can be wrong in a way nobody notices.
 *
 *  **Every form carries the show's key as well as its name** (`showLabel`), because one console
 *  holds every show on the machine and two of them can declare the same `showName` — the two this
 *  console was measured against declare one name between them. A tab that asked for the
 *  showrunner without saying which show was asking would be the alerting story failing at the one
 *  moment it matters. */

/** The show every assertion below is about: the invented one `test/helpers.ts` uses, under the key
 *  an operator would have registered it with. */
const SHOW: TitleShow = { showName: "Harbor Light", key: "HarborLight" };

function row(over: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    id: "s02e01", title: "A Week on the Water", stage: "IDEA", status: "none",
    needs: { ideaMissing: false, refsMissing: [], imagesMissing: [] },
    ...over,
  };
}

describe("titleFor, the document title's pure part", () => {
  it("names the show it was given and never one of its own", () => {
    expect(titleFor(SHOW, [])).toBe("Harbor Light · HarborLight console");
    expect(titleFor({ showName: "Second Show", key: "second" }, [])).toBe("Second Show · second console");
  });

  it("tells two shows apart by their keys when they declare the same name", () => {
    // The measured case, and the whole reason the key is in the title: the live instance and the
    // retired first repository declare the same showName and the same showSlug (inventory §2.1),
    // so the name is not an identity and the key is.
    const live = { showName: "One Name", key: "live" };
    const archive = { showName: "One Name", key: "archive" };
    const rows = [row({ id: "s02e04", status: "waiting" })];
    expect(titleFor(live, rows)).toBe("⏸ s02e04 NEEDS YOU — One Name · live");
    expect(titleFor(archive, rows)).toBe("⏸ s02e04 NEEDS YOU — One Name · archive");
    expect(titleFor(live, rows)).not.toBe(titleFor(archive, rows));
  });

  it("asks for the showrunner the moment any episode is waiting, whatever else is running", () => {
    const rows = [
      row({ id: "s02e01", status: "running", stage: "DRAFT_SCRIPT", lastEventAt: "2026-10-02T10:00:00Z" }),
      row({ id: "s02e04", status: "waiting", stage: "DRAFT_IMAGES" }),
    ];
    expect(titleFor(SHOW, rows, new Date("2026-10-02T10:01:00Z"))).toBe("⏸ s02e04 NEEDS YOU — Harbor Light · HarborLight");
  });

  it("names the first waiting episode in board order when two are waiting", () => {
    const rows = [row({ id: "s02e02", status: "waiting" }), row({ id: "s02e05", status: "waiting" })];
    expect(titleFor(SHOW, rows)).toBe("⏸ s02e02 NEEDS YOU — Harbor Light · HarborLight");
  });

  it("reports a running episode's stage and the minutes since it last moved", () => {
    const rows = [row({ id: "s02e02", status: "running", stage: "DRAFT_AUDIO", lastEventAt: "2026-10-02T10:00:00Z" })];
    expect(titleFor(SHOW, rows, new Date("2026-10-02T10:14:59Z"))).toBe("● s02e02 DRAFT_AUDIO · 14m — Harbor Light · HarborLight");
  });

  it("reports zero minutes for a running episode whose log has no last event yet", () => {
    const rows = [row({ id: "s02e02", status: "running", stage: "IDEA" })];
    expect(titleFor(SHOW, rows)).toBe("● s02e02 IDEA · 0m — Harbor Light · HarborLight");
  });

  it("warns about a failed or a crashed run, which will not restart itself", () => {
    // The fourth form. A run that failed or crashed has stopped and nothing will move it until the
    // operator does, so a tab that reported it as idle would let an episode sit broken for as long
    // as nobody opened the Board.
    expect(titleFor(SHOW, [row({ id: "s02e07", status: "crashed", stage: "DRAFT_ASSEMBLY" })])).toBe("⚠ s02e07 CRASHED — Harbor Light · HarborLight");
    expect(titleFor(SHOW, [row({ id: "s02e08", status: "failed", stage: "CASTING" })])).toBe("⚠ s02e08 FAILED — Harbor Light · HarborLight");
  });

  it("asks for the showrunner before it warns, and warns before it reports a run that is working", () => {
    // Precedence, in the order of what the person at the tab can do about it: a gate is a question
    // addressed to them, a crash is a job waiting on them, and a run that is working wants nothing.
    const broken = row({ id: "s02e07", status: "crashed", stage: "DRAFT_ASSEMBLY" });
    const working = row({ id: "s02e02", status: "running", stage: "DRAFT_AUDIO", lastEventAt: "2026-10-02T10:00:00Z" });
    const asking = row({ id: "s02e04", status: "waiting", stage: "DRAFT_IMAGES" });
    expect(titleFor(SHOW, [working, broken])).toBe("⚠ s02e07 CRASHED — Harbor Light · HarborLight");
    expect(titleFor(SHOW, [broken, asking])).toBe("⏸ s02e04 NEEDS YOU — Harbor Light · HarborLight");
    // The first match in Board order, so a show with two broken episodes names the earlier one and
    // the title does not flicker between them.
    expect(titleFor(SHOW, [row({ id: "s02e05", status: "failed" }), broken])).toBe("⚠ s02e05 FAILED — Harbor Light · HarborLight");
  });

  it("is idle for a board of finished and never-run episodes, and for one it could not read", () => {
    expect(titleFor(SHOW, [row({ status: "completed" }), row({ id: "s02e09", status: "none" })])).toBe("Harbor Light · HarborLight console");
    expect(titleFor(SHOW, null)).toBe("Harbor Light · HarborLight console");
  });
});

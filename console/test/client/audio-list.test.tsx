// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { AUDIO_FILE, transcriptFor } from "../../src/pages/Gate.js";

/** The casting gate's reference directory holds takes and, beside them, the transcript the
 *  showrunner wrote (`<guest-slug>.txt`). Only the takes are players; the transcript is shown under
 *  the take it belongs to (Ryan, 2026-10-30: the gate offered a text file to play). The DOM test
 *  of the whole page lives in gate-page.test.tsx; these two are the projection, which is where the
 *  rule actually is. */
describe("the audio directory listing", () => {
  it("counts only audio files as takes", () => {
    const names = ["hallet-1.wav", "hallet-2.wav", "hallet.txt", "veleth-1.wav", "veleth.txt", "notes.md", ".DS_Store", "mix.mp3"];
    expect(names.filter((n) => AUDIO_FILE.test(n))).toEqual(["hallet-1.wav", "hallet-2.wav", "veleth-1.wav", "mix.mp3"]);
  });

  it("points every candidate of a guest at the guest's one transcript", () => {
    expect(transcriptFor("veleth-1.wav")).toBe("veleth.txt");
    expect(transcriptFor("veleth-2.wav")).toBe("veleth.txt");
    expect(transcriptFor("dockmaster-hale-3.wav")).toBe("dockmaster-hale.txt");
    expect(transcriptFor("bulletin-b3-clerk-1-FX.wav")).toBe("bulletin-b3-clerk-1-FX.txt");
  });
});

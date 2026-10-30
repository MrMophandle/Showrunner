// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CastingGuest } from "../../shared/types.js";
import { AUDIO_FILE, guestForTake, transcriptFor } from "../../src/pages/Gate.js";

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

/** Whose take a WAV is, which is the engine's question and not the page's: the `refs-ready` guard
 *  lowercases every file in the guest-reference directory and matches a guest's takes with
 *  `startsWith(slugName(name))` (`engine/src/needs.ts:141,179`). The page groups its radios by the
 *  same rule, so a take the operator can pick for a guest is a take the guard counts as that
 *  guest's — the transcript-stem rule this replaced dropped every name the guard accepts but that
 *  convention does not (`hallet2.wav`, `hallet_warm.wav`). */
describe("guestForTake", () => {
  const guest = (name: string, slug: string): CastingGuest => ({ name, slug, current: `x/${slug}-1.wav` });
  const guests = [guest("Hallet", "hallet"), guest("Hale", "hale"), guest("Hale Junior", "hale-junior")];

  it("claims every name the guard's prefix match claims, whatever follows the slug", () => {
    for (const name of ["hallet-1.wav", "hallet2.wav", "Hallet-1.wav", "hallet_warm.wav", "HALLET.wav"]) {
      expect(guestForTake(name, guests)?.name, name).toBe("Hallet");
    }
  });

  it("gives a take to the longest slug it starts with", () => {
    expect(guestForTake("hale-1.wav", guests)?.name).toBe("Hale");
    expect(guestForTake("hale-junior-1.wav", guests)?.name).toBe("Hale Junior");
  });

  it("claims nothing for a take that starts with no guest's slug, or for a guest with no slug", () => {
    expect(guestForTake("harbor-crowd.wav", guests)).toBeUndefined();
    expect(guestForTake("the-hallet-1.wav", guests)).toBeUndefined();
    // A cast name that slugs to nothing ("—") would otherwise match the empty prefix and claim
    // every take in the directory.
    expect(guestForTake("hale-1.wav", [guest("—", "")])).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import {
  parseEpisodeId, isEpisodeId, formatAired, compareEpisodeIds, InvalidEpisodeId,
} from "../src/ids.js";

describe("parseEpisodeId", () => {
  it("parses an aired slot", () => {
    expect(parseEpisodeId("s02e01")).toEqual({ kind: "aired", season: 2, episode: 1, raw: "s02e01" });
  });
  it("parses a production id", () => {
    expect(parseEpisodeId("ep98")).toEqual({ kind: "production", number: 98, raw: "ep98" });
  });
  it("rejects every other shape", () => {
    for (const bad of ["s2e1", "S02E01", "ep1", "ep001", "s02e01/", "../s02e01", "", "s02e01 x"]) {
      expect(() => parseEpisodeId(bad), bad).toThrow(InvalidEpisodeId);
    }
  });
  it("rejects ep00, because production numbers start at 1 just as aired ones do", () => {
    expect(() => parseEpisodeId("ep00")).toThrow(InvalidEpisodeId);
    expect(() => parseEpisodeId("ep00")).toThrow(/start at 1/);
    expect(parseEpisodeId("ep01")).toEqual({ kind: "production", number: 1, raw: "ep01" });
  });
  it("rejects a non-string at runtime, not only at compile time", () => {
    for (const bad of [undefined, null, 7, { raw: "s02e01" }]) {
      expect(() => parseEpisodeId(bad as unknown as string), String(bad)).toThrow(InvalidEpisodeId);
    }
    expect(() => parseEpisodeId(null as unknown as string)).toThrow(/not a string/);
  });
  it("round-trips a formatted aired slot", () => {
    expect(parseEpisodeId(formatAired(2, 1)).raw).toBe("s02e01");
  });
});

describe("isEpisodeId", () => {
  it("is true only for the two shapes", () => {
    expect(isEpisodeId("s10e20")).toBe(true);
    expect(isEpisodeId("ep99")).toBe(true);
    expect(isEpisodeId("ep9")).toBe(false);
    expect(isEpisodeId("s2e01")).toBe(false);
    expect(isEpisodeId("ep00")).toBe(false);
  });
});

describe("formatAired", () => {
  it("zero-pads", () => {
    expect(formatAired(2, 1)).toBe("s02e01");
    expect(formatAired(10, 20)).toBe("s10e20");
  });
  it("rejects out-of-range, naming the parameter that was out of range", () => {
    expect(() => formatAired(0, 1)).toThrow("invalid season 0: season must be 1..99");
    expect(() => formatAired(1, 100)).toThrow("invalid episode 100: episode must be 1..99");
  });
});

describe("compareEpisodeIds", () => {
  it("orders aired by season then episode, then production ids last by number", () => {
    const ids = ["ep99", "s02e01", "s01e10", "ep98", "s01e02"].map(parseEpisodeId);
    const sorted = [...ids].sort(compareEpisodeIds).map((i) => i.raw);
    expect(sorted).toEqual(["s01e02", "s01e10", "s02e01", "ep98", "ep99"]);
  });
});

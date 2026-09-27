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
});

describe("isEpisodeId", () => {
  it("is true only for the two shapes", () => {
    expect(isEpisodeId("s10e20")).toBe(true);
    expect(isEpisodeId("ep99")).toBe(true);
    expect(isEpisodeId("ep9")).toBe(false);
  });
});

describe("formatAired", () => {
  it("zero-pads", () => {
    expect(formatAired(2, 1)).toBe("s02e01");
    expect(formatAired(10, 20)).toBe("s10e20");
  });
  it("rejects out-of-range", () => {
    expect(() => formatAired(0, 1)).toThrow(InvalidEpisodeId);
    expect(() => formatAired(1, 100)).toThrow(InvalidEpisodeId);
  });
});

describe("compareEpisodeIds", () => {
  it("orders aired by season then episode, then production ids last by number", () => {
    const ids = ["ep99", "s02e01", "s01e10", "ep98", "s01e02"].map(parseEpisodeId);
    const sorted = [...ids].sort(compareEpisodeIds).map((i) => i.raw);
    expect(sorted).toEqual(["s01e02", "s01e10", "s02e01", "ep98", "ep99"]);
  });
});

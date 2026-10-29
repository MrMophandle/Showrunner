import { describe, it, expect } from "vitest";
import { ENGINE_VERSION } from "../src/index.js";

describe("engine package", () => {
  it("loads, and the barrel re-exports the derived version", () => {
    // The shape, not a literal: the version is derived from git by scripts/write-version.mjs, so a
    // pinned number would have to be edited on every commit. test/version.test.ts checks the parts.
    expect(ENGINE_VERSION).toMatch(/^(\d+)\.(\d+)\.(\d+)\+([0-9a-f]{7,40}|unknown)(\.dirty)?$/);
  });
});

import { describe, it, expect } from "vitest";
import { ENGINE_VERSION } from "../src/index.js";

describe("engine package", () => {
  it("loads", () => {
    expect(ENGINE_VERSION).toBe("0.0.1");
  });
});

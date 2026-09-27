import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFile, hashFiles, sameHashes } from "../src/hash.js";

describe("hashing", () => {
  it("hashes a file and returns null for a missing one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hash-"));
    await writeFile(path.join(dir, "a.txt"), "hello");
    const h = await hashFile(path.join(dir, "a.txt"));
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(await hashFile(path.join(dir, "missing"))).toBeNull();
  });

  it("hashes many relative paths under a root and compares maps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hash-"));
    await writeFile(path.join(dir, "a.txt"), "hello");
    const before = await hashFiles(dir, ["a.txt", "b.txt"]);
    expect(Object.keys(before)).toEqual(["a.txt", "b.txt"]);
    expect(before["b.txt"]).toBeNull();
    await writeFile(path.join(dir, "a.txt"), "changed");
    const after = await hashFiles(dir, ["a.txt", "b.txt"]);
    expect(sameHashes(before, after)).toBe(false);
    expect(sameHashes(before, { ...before })).toBe(true);
    expect(sameHashes(before, { "a.txt": before["a.txt"] ?? null })).toBe(false);
  });
});

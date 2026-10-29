import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_VERSION, readEngineVersion } from "../src/version.js";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)\+([0-9a-f]{7,40})(\.dirty)?$/;

describe("the derived engine version", () => {
  it("is written from git: major.minor from package.json, the patch is the commit count, the metadata is the short hash", async () => {
    execFileSync(process.execPath, [path.join(engineDir, "scripts", "write-version.mjs")], { cwd: engineDir });
    const written = JSON.parse(await readFile(path.join(engineDir, "version.json"), "utf8")) as { version: string; commits: number; commit: string; dirty: boolean };
    const m = SEMVER.exec(written.version);
    expect(m).not.toBeNull();
    const pkg = JSON.parse(await readFile(path.join(engineDir, "package.json"), "utf8")) as { version: string };
    const [major, minor] = pkg.version.split(".");
    expect(m![1]).toBe(major);
    expect(m![2]).toBe(minor);
    const count = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: engineDir }).toString().trim());
    expect(Number(m![3])).toBe(count);
    expect(written.commits).toBe(count);
    const short = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: engineDir }).toString().trim();
    expect(m![4]).toBe(short);
    expect(written.commit).toBe(short);
    expect(Boolean(m![5])).toBe(written.dirty);
  });

  it("reads the written file, and falls back to 0.0.0+unbuilt when there is none", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "engine-version-"));
    try {
      expect(readEngineVersion(path.join(dir, "version.json"))).toBe("0.0.0+unbuilt");
      await writeFile(path.join(dir, "version.json"), JSON.stringify({ version: "1.2.345+abcdef0" }));
      expect(readEngineVersion(path.join(dir, "version.json"))).toBe("1.2.345+abcdef0");
      await writeFile(path.join(dir, "version.json"), "not json");
      expect(readEngineVersion(path.join(dir, "version.json"))).toBe("0.0.0+unbuilt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ENGINE_VERSION is the written version under test (pretest writes it) and never the placeholder", () => {
    expect(ENGINE_VERSION).toMatch(SEMVER);
    expect(ENGINE_VERSION).not.toBe("0.0.1");
  });
});

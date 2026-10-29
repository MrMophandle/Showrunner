# The Derived Engine Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine's version increments with every commit by construction: it is derived from git at build and test time, so the console header and every run log name the exact commit of the engine that ran.

**Architecture:** A small Node script writes `engine/version.json` from `engine/package.json`'s major.minor, the count of commits reachable from HEAD, the short hash, and a dirty flag. `engine/src/version.ts` reads that file at module load and falls back to `0.0.0+unbuilt` when it is absent. The script runs before `build` and `test` through npm's `pre` hooks. Nothing else changes: `ENGINE_VERSION` keeps its name and its two readers (`runner.ts`'s `run_started` record and the console's `/api/shows/:show` answer).

**Tech Stack:** Node 22 ESM, TypeScript strict / NodeNext, vitest 4. No new dependencies.

**Spec:** Ryan's ruling of 2026-10-29: "derived" — the version is derived from git rather than bumped by a hook, after the header had read `engine 0.0.1` for 391 commits.

## Global Constraints

- **No show's name in `engine/`** — the grep `grep -rniwE 'dead ?light|deadlight|sarn|sable|opha|cricket|remo|trent|ilvaren|coalvane|the mute|ansa|mardo' engine/ --exclude-dir=node_modules --exclude-dir=dist` must print nothing.
- **`version.ts` imports nothing from the engine** (its own comment: `runner.ts` reads it, and importing the barrel would cycle). `node:fs` and `node:path`/`node:url` are allowed.
- **The version string is valid semver with build metadata:** `<major>.<minor>.<commits>+<shorthash>` or `…+<shorthash>.dirty`; the fallback is `0.0.0+unbuilt`.
- **Typecheck and tests green at the commit:** `npm run typecheck -w engine`, `npm test -w engine`, and `npm run typecheck -w console && npm test -w console` (the console imports `ENGINE_VERSION`).
- **Commits end with exactly one trailer:** `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: The version writer, the reader, and the hooks

**Files:**
- Create: `engine/scripts/write-version.mjs`
- Modify: `engine/src/version.ts`
- Modify: `engine/package.json` (scripts)
- Modify: `.gitignore` (root; add `engine/version.json`)
- Test: `engine/test/version.test.ts`

**Interfaces:**
- Consumes: `engine/package.json`'s `version` (today `0.0.1`; only its major and minor are used); git on PATH.
- Produces: `engine/version.json` (git-ignored) of the shape `{ "version": "0.0.391+236d9b3", "major": 0, "minor": 0, "commits": 391, "commit": "236d9b3", "dirty": false, "writtenAt": "<ISO>" }`; `ENGINE_VERSION: string` unchanged in name; a new export `readEngineVersion(file?: string): string` from `engine/src/version.ts` (re-exported by the barrel like everything in that file).

- [x] **Step 1: Write the failing tests.** Create `engine/test/version.test.ts`:

```ts
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
```

- [x] **Step 2: Run them to verify they fail.** `npm test -w engine -- test/version.test.ts` — expected: fails to import `readEngineVersion` / the script does not exist.

- [x] **Step 3: The writer.** Create `engine/scripts/write-version.mjs` (plain Node, no dependencies):

```js
// Writes engine/version.json from git: the engine's version is derived, never bumped by hand.
//   <major>.<minor> come from engine/package.json; the patch is the number of commits reachable
//   from HEAD; the build metadata is the short hash, with ".dirty" when the working tree has
//   uncommitted changes. Outside a git checkout (a tarball) the patch is 0 and the metadata
//   "unknown", so a build still has a version and a run log still records one.
// Run by npm's prebuild and pretest hooks (engine/package.json). Ryan-ruled 2026-10-29: derived.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(engineDir, "package.json"), "utf8"));
const [major, minor] = String(pkg.version).split(".").map((n) => Number(n));

function git(args) {
  return execFileSync("git", args, { cwd: engineDir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

let commits = 0, commit = "unknown", dirty = false;
try {
  commits = Number(git(["rev-list", "--count", "HEAD"]));
  commit = git(["rev-parse", "--short", "HEAD"]);
  dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
} catch {
  // not a git checkout, or git missing: keep the fallbacks above
}
const version = `${major}.${minor}.${commits}+${commit}${dirty ? ".dirty" : ""}`;
const out = { version, major, minor, commits, commit, dirty, writtenAt: new Date().toISOString() };
writeFileSync(path.join(engineDir, "version.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`engine version ${version}`);
```

Note on `dirty`: `--untracked-files=no`, so `engine/version.json` itself (git-ignored anyway) and an untracked scratch file never mark a build dirty; only modified tracked files do.

- [x] **Step 4: The reader.** Replace `engine/src/version.ts` with:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The version the build was given when `engine/version.json` is missing or unreadable: a checkout
 *  that has not run the writer, or a copy of `dist/` without the file beside it. Semver-valid, and
 *  visibly not a real version, so a header or a run log showing it says "unbuilt" rather than
 *  passing for a release. */
export const UNBUILT_VERSION = "0.0.0+unbuilt";

/** Reads the derived version the writer left in `engine/version.json` (`scripts/write-version.mjs`,
 *  run by npm's prebuild and pretest). Exported for the test, which points it at a file of its own. */
export function readEngineVersion(file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "version.json")): string {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { version?: unknown }).version === "string") {
      return (parsed as { version: string }).version;
    }
    return UNBUILT_VERSION;
  } catch {
    return UNBUILT_VERSION;
  }
}

/** The engine's version, recorded on every run_started beside the pipeline hash so a log says
 *  which engine wrote it, and shown in the console's header. **Derived, never bumped by hand**
 *  (Ryan-ruled 2026-10-29): `<major>.<minor>` from `package.json`, the patch is the count of
 *  commits reachable from the build's HEAD, the build metadata is the short hash, `.dirty` when the
 *  tree had uncommitted changes — so every commit increments it by construction. It lives in a
 *  module that imports nothing from the engine, because `runner.ts` reads it: taking it from the
 *  `index.ts` barrel would make runner.ts import index.ts while index.ts re-exports runner.ts, a
 *  cycle that drags the whole barrel into runner's evaluation. `index.ts` re-exports it, so the
 *  public name is unchanged. The file is resolved relative to this module, which sits one level
 *  below the package root in both `src/` (tests) and `dist/` (builds). */
export const ENGINE_VERSION: string = readEngineVersion();
```

- [x] **Step 5: The hooks and the ignore.** In `engine/package.json` `scripts`, add `"version:write": "node scripts/write-version.mjs"`, `"prebuild": "npm run version:write"`, `"pretest": "npm run version:write"`. In the root `.gitignore`, add a line `engine/version.json` with a comment line above it: `# derived by engine/scripts/write-version.mjs at build and test time; never committed`. Check whether `engine/package.json` has a `files` field that would need `version.json` listed for packaging; if it has none, leave it.

- [x] **Step 6: Run the tests.** `npm test -w engine -- test/version.test.ts` — expected: 3 passed (the `pretest` hook has written the file first). Then `npm test -w engine && npm run typecheck -w engine && npm run build -w engine && npm run typecheck -w console && npm test -w console`. Confirm `engine/version.json` is untracked-and-ignored: `git status --porcelain` shows no `version.json`. Confirm the console's smoke of the header is not asserting `0.0.1` anywhere: `grep -rn '"0.0.1"\|0\.0\.1' console/test engine/test` and fix any assertion that pinned the old constant (the two engine tests that import `ENGINE_VERSION`, `engine/test/smoke.test.ts` and `engine/test/runner.test.ts`, may compare against it by value — read them; comparing to the imported constant is fine, a literal `"0.0.1"` is not).

- [x] **Step 7: Commit.**

```bash
git add engine/scripts/write-version.mjs engine/src/version.ts engine/package.json .gitignore engine/test/version.test.ts
git commit -m "engine: the version is derived from git, so every commit increments it

ENGINE_VERSION was a constant that read 0.0.1 for 391 commits. It is now read from
engine/version.json, which scripts/write-version.mjs derives before every build and test:
major.minor from package.json, the patch is the count of commits reachable from HEAD, the
build metadata is the short hash, .dirty when the tree had uncommitted changes. A checkout
that has not run the writer reports 0.0.0+unbuilt rather than passing for a release. The
console header and every run_started record now name the exact engine commit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

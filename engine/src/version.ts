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

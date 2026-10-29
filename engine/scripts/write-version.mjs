// Writes engine/version.json from git: the engine's version is derived, never bumped by hand.
//   <major>.<minor> come from engine/package.json; the patch is the number of commits reachable
//   from HEAD; the build metadata is the short hash, with ".dirty" when the working tree has
//   uncommitted changes. Outside a git checkout (a tarball) the patch is 0 and the metadata
//   "unknown", so a build still has a version and a run log still records one.
// The count and the dirty flag are the REPOSITORY's, not this package's. Every git call below runs
//   without a pathspec: the patch counts every commit in the Showrunner repository, and a modified
//   tracked file anywhere in it -- console/, tools/, docs/, render/ -- marks the engine build
//   ".dirty". "engine" is the package that carries the number, not the scope the number measures.
//   That is deliberate (Ryan-ruled 2026-10-29): the string names a repository commit, so "dirty"
//   has to mean the repository's tracked tree differs from that commit. Scoping the dirty check to
//   engine/ while the patch counts every commit would make the two halves of one string disagree.
// If any one of the three git calls fails, all three fall back together, so a partial failure
//   degrades fully to <major>.<minor>.0+unknown rather than mixing a real count with an unknown hash.
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
  // Not a git checkout, git missing, or a failure part-way through the three calls: reset all
  // three together rather than keeping whichever ones had already succeeded, so the version is
  // wholly a fallback (<major>.<minor>.0+unknown) instead of a real count beside an unknown hash.
  commits = 0;
  commit = "unknown";
  dirty = false;
}
const version = `${major}.${minor}.${commits}+${commit}${dirty ? ".dirty" : ""}`;
const out = { version, major, minor, commits, commit, dirty, writtenAt: new Date().toISOString() };
writeFileSync(path.join(engineDir, "version.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`engine version ${version}`);

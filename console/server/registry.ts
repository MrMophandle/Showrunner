import path from "node:path";
import os from "node:os";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

/** The show registry: which shows this console holds, where each one's repository is, and whether
 *  the console may write to it.
 *
 *  **A file on the machine and not a flag**, for two measured reasons. The New-show surface has to
 *  be able to add a show it has just created without the operator restarting the console, and a
 *  list that lived only in `process.argv` cannot be appended to. And the key has to be the
 *  operator's: the two shows this console was measured against declare the **same** `showName`,
 *  the same `showSlug` and the same `output.nasRoot` — they are one show's repository and its
 *  successor — so no field of a `showrunner.json` can tell them apart and nothing derived from a
 *  config can key a URL (rulings H-01 and H-02).
 *
 *  The file is outside every show repository and outside the engine's, because the list of shows
 *  on a machine belongs to the machine; under either repository it would be a tracked file whose
 *  contents are one operator's local paths. */

/** One show in the registry. `root` is the show repository's path, made absolute when an entry is
 *  registered or loaded. A `readOnly` entry refuses every POST, which is how the retired first
 *  repository is listed beside the live instance without one launch there writing over the
 *  instance's finals: the two configs name the same NAS root and the same final filename pattern,
 *  so a finalize step run in the retired tree overwrites the live show's season (ruling H-03). */
export interface RegistryEntry {
  root: string;
  readOnly?: boolean;
}

/** The whole registry: shows by the operator's chosen key. One level of nesting rather than a bare
 *  map of key to entry, so a later top-level key — a default show, a file version — can be added
 *  without rewriting every registry on every machine. */
export interface Registry {
  shows: Record<string, RegistryEntry>;
}

/** What a show key may be: a leading letter or digit, then up to 63 more of letter, digit,
 *  underscore or hyphen.
 *
 *  The grammar is narrow because the key is the one string that reaches a URL path segment, a map
 *  lookup and a log line, and it is validated once — in the server's show middleware — for all of
 *  them (spec §4.4's fence). No dot, so a key can never be `.` or `..`; no slash, so it cannot
 *  become two segments; no leading hyphen or underscore, so a key cannot be read as a flag by
 *  anything that passes it on; and a bound of 64 characters, so a key cannot be the whole of a
 *  path length. */
export const SHOW_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Where the registry lives when `--registry` is not given: `~/.showrunner/shows.json`. */
export function defaultRegistryPath(): string {
  return path.join(os.homedir(), ".showrunner", "shows.json");
}

/** Whether a value is a plain object — not null, not an array. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One entry, validated. Shared by `readRegistry` and `registerShow` so the file and the surface
 *  that writes it can never disagree about what an entry is. `where` is how the message addresses
 *  the entry: `shows.<key>` when it came out of a file, the bare key when it was just handed in. */
function checkEntry(value: unknown, where: string): RegistryEntry {
  if (!isRecord(value)) throw new Error(`${where} must be an object with a root`);
  const root = value["root"];
  if (typeof root !== "string" || root.trim() === "") throw new Error(`${where}.root must be a non-empty path`);
  const readOnly = value["readOnly"];
  if (readOnly !== undefined && typeof readOnly !== "boolean") throw new Error(`${where}.readOnly must be true or false`);
  return { root, ...(readOnly === true ? { readOnly: true } : {}) };
}

/** The registry as it stands on disk.
 *
 *  **An absent file is an empty registry and not a refusal**, because a console started before any
 *  show is registered must come up: the New-show surface that registers the first one is served by
 *  this same server, so a refusal here would make the first show unregisterable from the browser.
 *
 *  **Everything else that is wrong is refused, by file name and by the key at fault**, and the
 *  refusal is fatal to startup rather than being a show quietly skipped. A registry the console
 *  read as empty because of a stray comma would look exactly like a machine with no shows on it,
 *  and the operator's remedy — registering the shows again — would be the wrong one. This is the
 *  opposite of `loadShows`' rule for a show whose *repository* will not load, which is reported by
 *  key and skipped: one bad repository must not take nine good ones off the air, while one bad
 *  registry file means nothing the console says about shows can be trusted.
 *
 *  A key the grammar rejects refuses the whole file for the same reason: a key that cannot be put
 *  in a URL is a show the operator registered and cannot reach, and skipping it silently is how it
 *  stays unreachable. */
export async function readRegistry(file: string): Promise<Registry> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { shows: {} };
    throw new Error(`${file}: could not be read — ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`${file}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new Error(`${file}: expected an object with a "shows" key`);
  const rawShows = parsed["shows"];
  if (rawShows === undefined) return { shows: {} };
  if (!isRecord(rawShows)) throw new Error(`${file}: "shows" must be an object of show keys`);
  const shows: Record<string, RegistryEntry> = {};
  for (const [key, value] of Object.entries(rawShows)) {
    if (!SHOW_KEY.test(key)) {
      throw new Error(`${file}: ${JSON.stringify(key)} is not a show key: expected [A-Za-z0-9][A-Za-z0-9_-]{0,63}`);
    }
    try {
      shows[key] = checkEntry(value, `shows.${key}`);
    } catch (err) {
      throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { shows };
}

/** Writes the registry to a temporary file beside the target and renames it over it.
 *
 *  The rename is what makes the write safe to do while the console is serving: `rename` within one
 *  directory is atomic, so a reader arriving mid-write sees either the old file whole or the new
 *  one whole, never a truncated object it would refuse to parse. The parent directory is created
 *  when it is absent, which is the ordinary case the first time a show is registered on a machine.
 *
 *  Keys are written sorted, so registering a show produces a one-line diff rather than reordering
 *  the file, and `readOnly` is omitted for a writable show so the file reads as "these two are
 *  read-only" instead of as a column of booleans. */
export async function writeRegistry(file: string, reg: Registry): Promise<void> {
  const shows: Record<string, RegistryEntry> = {};
  for (const key of Object.keys(reg.shows).sort()) {
    const entry = reg.shows[key];
    if (entry === undefined) continue;
    shows[key] = { root: entry.root, ...(entry.readOnly === true ? { readOnly: true } : {}) };
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, `${JSON.stringify({ shows }, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    // A rename that failed leaves the temporary file in the operator's registry directory, where
    // nothing would ever read it again.
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Adds one show to the registry on disk: read, refuse, write.
 *
 *  Three refusals, each because the mistake would otherwise be discovered as two Board columns
 *  over one repository:
 *
 *  - **a key the grammar rejects**, which could not be reached in a URL;
 *  - **a key already registered**, because overwriting it moves every bookmarked
 *    `/shows/<key>/…` address to a different repository with no notice;
 *  - **a root already registered under another key**, compared as resolved absolute paths so that
 *    the path, the path with a trailing slash and a relative walk to the same place are one root.
 *    Two keys over one repository would be two `ShowContext`s, two `RunStore`s and two `fs.watch`
 *    sets on the same run logs, and a launch under each key would be two workers on one episode —
 *    the failure the launch route's own refusal exists to prevent.
 *
 *  What this does **not** check is that the root exists or that its config loads. That is
 *  `loadShows`' job at startup: a registry that refused a root whose NAS volume happened to be
 *  unmounted would be a registry the operator could not add a show to. */
export async function registerShow(file: string, key: string, entry: RegistryEntry): Promise<void> {
  if (!SHOW_KEY.test(key)) {
    throw new Error(`${JSON.stringify(key)} is not a show key: expected [A-Za-z0-9][A-Za-z0-9_-]{0,63}`);
  }
  const checked = checkEntry(entry, key);
  const root = path.resolve(checked.root);
  const reg = await readRegistry(file);
  const existing = reg.shows[key];
  if (existing !== undefined) throw new Error(`${key} is already registered, at ${path.resolve(existing.root)}`);
  for (const [otherKey, other] of Object.entries(reg.shows)) {
    if (path.resolve(other.root) === root) throw new Error(`${root} is already registered as ${otherKey}`);
  }
  reg.shows[key] = { root, ...(checked.readOnly === true ? { readOnly: true } : {}) };
  await writeRegistry(file, reg);
}

/** The registry `--show <root>` means: one writable show, keyed by the root's own directory name.
 *
 *  Builds a value and writes nothing, so `--show` behaves exactly as it did before the registry
 *  existed — a console pointed at one repository, leaving no trace on the machine.
 *
 *  A directory name the grammar rejects is refused rather than sanitised. A sanitised key would
 *  give the show a URL the operator did not choose and cannot predict, and the remedy the message
 *  names — a registry file with a chosen key — is the one the registry exists for. */
export function singleShowRegistry(root: string): Registry {
  const resolved = path.resolve(root);
  const key = path.basename(resolved);
  if (!SHOW_KEY.test(key)) {
    throw new Error(
      `--show ${resolved}: its directory name ${JSON.stringify(key)} is not a show key `
      + `(expected [A-Za-z0-9][A-Za-z0-9_-]{0,63}), and --show takes the directory name as the key. `
      + `Register the show under a key you choose in a registry file and start with --registry instead.`,
    );
  }
  return { shows: { [key]: { root: resolved } } };
}

import path from "node:path";
import { readFile } from "node:fs/promises";
import { resolveShowPath, type ShowConfig } from "./show-config.js";

/** The show's one record of who has a sheet, a face and a voice: `Canon/cast.json` (spec
 *  2026-10-31 §1.2). Keys are `slugName(name)`; `the-<slug>` is accepted on read. */
export interface CastVoice { ref: string; ref_text: string; direction: string; fx?: string | null; speed?: number; status: string; note?: string }
export interface CastFace { ref?: string; gallery?: string[]; locked?: string }
export interface CastEntry {
  name: string; kind: string; speaks: boolean; silent?: boolean; debut?: string; sheet?: string;
  identity?: string; baseline_prompt?: string; face?: CastFace; voice?: CastVoice | null; status?: string;
}
export interface CastIndex { version: number; audio?: { engine?: string; model?: string; note?: string }; cast: Record<string, CastEntry> }

export class CastIndexError extends Error { override readonly name = "CastIndexError"; }

/** "the Warden" → "warden"; "Dock Hand Pim" → "dock-hand-pim". The index's keys are slugs and the
 *  outline's `## Cast` lines are display names, so both sides are normalised the same way. It
 *  lives here rather than in needs.ts, where it was written, because the index is what every
 *  caller now slugs **for** — `needs.ts` re-exports it so its public name is unchanged — and
 *  because a copy of it in each file would be two rules for one thing. `scripts/lib/castindex.py`
 *  ports it and is tested against the same cases. */
export function slugName(name: string): string {
  return name.trim().toLowerCase().replace(/^the[ -]/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The index's path, show-relative: `cast.index` where the config names one, and
 *  `<canonDir>/cast.json` otherwise. Every message the reference probe writes names the value
 *  this function returned, so the file an author is sent to edit is the file the engine read. */
export function castIndexPath(show: ShowConfig): string {
  const configured = (show as { cast?: { index?: unknown } }).cast?.index;
  if (typeof configured === "string" && configured !== "") return configured;
  return path.posix.join(show.canonDir ?? "Canon", "cast.json");
}

/** The one sentence an absent index is reported with, wherever it is reported. Both of its
 *  readers write this line and no other: `missingRefs`'s NEEDS_REFS report (`needs.ts`) and the
 *  `bible-ready` guard, which refuses an unmigrated show two steps into the run
 *  (`pipelines/episode.ts`). It is a function here rather than a literal at the two call sites
 *  because the two sites are in different files and an operator who meets the refusal at either
 *  step must be sent to the same command; a second spelling of it would be a second remedy for
 *  one fact. The path is the caller's — always the value `castIndexPath` returned — so the file
 *  the author is sent to edit is the file the engine looked for. */
export function noCastIndexLine(indexRel: string): string {
  return `no cast index at ${indexRel} — run scripts/cast-index-build.py --write`;
}

/** Undefined when the file is absent — the probe turns that into its one-line remedy — and an
 *  error, never a guess, when it is present and not an index.
 *
 *  The two cases are different facts with different remedies, which is why they are not one
 *  return value. Absent means the show has not been migrated and there is exactly one thing to do
 *  (`scripts/cast-index-build.py --write`), so the probe reports that and nothing else. Present
 *  and unreadable means the engine cannot tell who is cast: an `undefined` there would print
 *  "build the index" over a file that already exists and invite an overwrite of it, and an empty
 *  cast would report every subject on the page as unregistered. The throw reaches the operator as
 *  a failed `refs-ready` step (`runner.ts`'s guard catch records `guard threw: …`), which is the
 *  honest shape for a file somebody has to look at. */
export async function loadCastIndex(showRoot: string, show: ShowConfig): Promise<CastIndex | undefined> {
  const rel = castIndexPath(show);
  let text: string;
  try { text = await readFile(resolveShowPath(showRoot, rel), "utf8"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) { throw new CastIndexError(`${rel}: not JSON (${(err as Error).message})`); }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { cast?: unknown }).cast !== "object" || (parsed as { cast?: unknown }).cast === null) {
    throw new CastIndexError(`${rel}: expected an object with a "cast" map`);
  }
  return parsed as CastIndex;
}

/** The key one cast name is filed under, in three steps: the name's slug, then `the-<slug>`, then
 *  the entry whose own `name` field slugs to the same thing.
 *
 *  The third step is what the outline's cast lines need. An entry's key is whatever it was filed
 *  under — the migration writes `pim` — while the outline names the character the way the script
 *  does, "Dock Hand Pim", and neither `dock-hand-pim` nor `the-dock-hand-pim` is a key. Without
 *  the scan that subject reads as unregistered and `refs-ready` stops a run over a character who
 *  is fully cast. The key is returned rather than only the entry because every message the probe
 *  writes names it, and an author sent to `Canon/cast.json` must be pointed at the line that is
 *  there. `castEntry` is this function plus the lookup, so the two can never disagree about which
 *  entry a name found. */
export function castKey(index: CastIndex, name: string): string | undefined {
  const slug = slugName(name);
  if (index.cast[slug] !== undefined) return slug;
  const prefixed = `the-${slug}`;
  if (index.cast[prefixed] !== undefined) return prefixed;
  for (const [key, entry] of Object.entries(index.cast)) {
    if (typeof entry.name === "string" && slugName(entry.name) === slug) return key;
  }
  return undefined;
}

export function castEntry(index: CastIndex, name: string): CastEntry | undefined {
  const key = castKey(index, name);
  return key === undefined ? undefined : index.cast[key];
}

/** Whether a subject's voice is cast: an object whose `status` says LOCKED. `includes` rather than
 *  an equality test because the status carries its own note — `"LOCKED (speed 1.1)"` — and the
 *  ruling in it is the word. An absent `voice` (never cast) and a `null` one (silent by design)
 *  are both not ready, and the probe tells them apart before it asks this. */
export function voiceReady(entry: CastEntry): boolean {
  const v = entry.voice;
  return typeof v === "object" && v !== null && typeof v.status === "string" && v.status.includes("LOCKED");
}

import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { resolveShowPath, type ShowConfig } from "./show-config.js";
import { castIndexPath, castKey, loadCastIndex, noCastIndexLine, slugName, voiceReady } from "./cast.js";
import type { Needs } from "./stages.js";

/** Re-exported rather than defined here: the rule moved to cast.ts with the index it slugs for
 *  (Plan L1, 2026-10-31), and the name stays `slugName` from `needs.js` because that is the name
 *  the console imports it under (`console/server/gates.ts:5`, through the package's barrel). The
 *  console's own citations of the rule name `engine/src/cast.ts:23`, where it now lives. */
export { slugName };

/** One line of the outline's `## Cast` section: the name as the writer wrote it and the tags in
 *  its parentheses. Named `OutlineCastEntry` rather than `CastEntry` since Plan L1 (2026-10-31),
 *  because `CastEntry` now means an entry of `Canon/cast.json` (cast.ts) — one is a claim an
 *  outline makes about who is in an episode, the other is the show's record of who is cast, and
 *  `missingRefs` exists to compare the two. */
export interface OutlineCastEntry { name: string; tags: string[] }

/** The outline's `## Cast` section, split into the lines that parse and the lines that do not.
 *  The section is the pipeline's only knowledge of who is in an episode before a script exists,
 *  which is why the outline prompt requires it and the canon reviewer checks it (F-01). Lines
 *  outside the section are ignored; a non-blank line inside it that does not match
 *  `- <Name> (<tag>, <tag>)` is returned in `malformed` rather than dropped, because a dropped
 *  line is a cast member the reference probe never checks — an em-dash instead of parentheses
 *  used to pass `refs-ready` silently and take an unregistered subject into synthesis.
 *
 *  **A line that is entirely an HTML comment is layout, like a blank line, and is skipped.** The
 *  outline template the engine ships writes the section's instructions as exactly that — a
 *  `<!-- … -->` line under `## Cast` saying what the tags are — so an outline written from the
 *  template carried a line this parser reported as missing the grammar, and `missingRefs` turned
 *  the template's own instructions into a NEEDS_REFS stop. The test is per-line and not across
 *  lines on purpose: a comment opened on one line and closed on another has swallowed whatever is
 *  between them, cast lines included, and must still be reported rather than skipped.
 *
 *  **A heading of any level ends the section, and is never itself an entry.** The section used to
 *  be closed only by the next level-2 heading, and the shipped outline template puts its
 *  `### Beat 1` and `### Beat 2` headings between `## Cast` and the next `## ` one — so those two
 *  headings fell inside the cast section and were reported as missing the grammar, which is the
 *  same NEEDS_REFS stop the comment skip above was added to remove and was only half of. Treating
 *  every heading as a boundary is the conservative reading in both directions: a heading line can
 *  never be `- <Name> (<tags>)`, so nothing that was an entry stops being one, and a cast list that
 *  a heading has interrupted is over whatever the heading's depth, so no line under some later
 *  subsection is read as cast. */
export function parseCastSection(outline: string): { entries: OutlineCastEntry[]; malformed: string[] } {
  const entries: OutlineCastEntry[] = [];
  const malformed: string[] = [];
  let inSection = false;
  for (const line of outline.split("\n")) {
    if (/^#{1,6} /.test(line)) { inSection = /^## Cast\b/.test(line); continue; }
    if (!inSection || line.trim() === "" || /^<!--.*-->$/.test(line.trim())) continue;
    const m = /^- (.+?) \(([^)]*)\)\s*$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) { malformed.push(line.trim()); continue; }
    entries.push({ name: m[1].trim(), tags: m[2].split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== "") });
  }
  return { entries, malformed };
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await readFile(p, "utf8")) as unknown;
}
function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }

function dirs(show: ShowConfig) {
  return {
    episodes: show.episodesDir ?? "Episodes",
    production: show.productionDir ?? "Production",
  };
}

/** One line per reference the outline's cast needs and the show does not have, every subject
 *  looked up in the cast index the same way: a face for everybody on the page — a character, a
 *  location, a ship — and for everybody the outline tags `speaks`, a voice that is LOCKED in the
 *  index with its WAV on disk. Recurring and guest are not two paths any more (Plan L1,
 *  2026-10-31): a guest used to pass on a WAV whose filename began with their slug sitting in the
 *  episode's `guest-refs` directory, which is a candidate take and not a casting decision, so a
 *  guest could reach synthesis with nobody having ruled on the voice and no face at all. Two
 *  authoring slips are reported the same way, because a cast line this probe cannot read is a
 *  subject it cannot check: a line inside the section that misses the grammar, and an entry whose
 *  tags name none of `recurring`, `guest` or `location`.
 *
 *  A show with no index at all is the one case that reports a single line and stops looking, and
 *  the line carries the command that builds it: there is one remedy, and a list of subjects that
 *  nothing could have registered would bury it.
 *
 *  An outline with no readable `## Cast` section is refused rather than passed (Plan H's H-09), in
 *  both shapes: no `## Cast` heading at all, and a heading with nothing under it that
 *  `parseCastSection` can read as either an entry or a malformed line. The canon reviewer prompt
 *  flags a missing section, which puts it in an agent's `issues` array; a guard must refuse it, or
 *  synthesis runs with an unchecked cast — every subject unregistered, every voice unverified, and
 *  `refs-ready` reporting "all references present" having looked at nothing.
 *
 *  Empty when the outline does not exist, which is a different thing and stays a different thing:
 *  an episode with no outline is the `premise` guard's finding (NEEDS_IDEA), five steps upstream of
 *  `refs-ready`, and the console puts this list on every Board row whatever the row's stage. */
export async function missingRefs(showRoot: string, episodeId: string, show: ShowConfig): Promise<string[]> {
  const d = dirs(show);
  const outlinePath = path.join(showRoot, d.episodes, episodeId, "outline.md");
  if (!(await exists(outlinePath))) return [];
  const { entries: cast, malformed } = parseCastSection(await readFile(outlinePath, "utf8"));
  if (cast.length === 0 && malformed.length === 0) {
    return ['the outline has no readable ## Cast section (write one line per subject as "- <Name> (<tags>)")'];
  }
  const indexRel = castIndexPath(show);
  const index = await loadCastIndex(showRoot, show);
  if (index === undefined) return [noCastIndexLine(indexRel)];

  const missing: string[] = [];
  for (const line of malformed) missing.push(`${line}: not in the \`- <Name> (<tags>)\` grammar`);
  for (const entry of cast) {
    const slug = slugName(entry.name);
    const tags = new Set(entry.tags);
    const speaks = tags.has("speaks");
    // A tag set naming none of the three the probe routes on reaches no check below, so the
    // entry would pass without ever being looked up. `- Vale (lead, speaks)` is the shape.
    if (!tags.has("recurring") && !tags.has("guest") && !tags.has("location")) {
      missing.push(`${entry.name}: tags name none of recurring, guest, location (got ${entry.tags.join(", ")})`);
      continue;
    }
    const key = castKey(index, entry.name);
    const found = key === undefined ? undefined : index.cast[key];
    if (found === undefined) { missing.push(`${entry.name}: no entry in ${indexRel} (tried ${slug}, the-${slug})`); continue; }
    // A face: every subject on the page has one — a character, a location, a ship.
    const faceRef = found.face?.ref;
    if (typeof faceRef !== "string" || !(await exists(resolveShowPath(showRoot, faceRef)))) {
      missing.push(`${entry.name}: reference image missing at ${typeof faceRef === "string" ? faceRef : "(no ref)"} (${indexRel} key ${key})`);
    }
    // A voice: every speaking subject has one, LOCKED, with its WAV on disk.
    if (speaks) {
      const v = found.voice;
      if (v === undefined || v === null) missing.push(`${entry.name}: no voice in ${indexRel} (key ${key})`);
      else if (!voiceReady(found)) missing.push(`${entry.name}: voice is not LOCKED in ${indexRel} (key ${key})`);
      else if (typeof v.ref !== "string" || !(await exists(resolveShowPath(showRoot, v.ref)))) missing.push(`${entry.name}: voice WAV missing at ${typeof v.ref === "string" ? v.ref : "(no ref)"} (${indexRel} key ${key})`);
    }
  }
  return missing;
}

/** The shot ids the showrunner said he would make by hand (`source: "showrunner"` in the shot
 *  list) whose PNG is not on disk yet. Empty before a shot list exists: the stage before the
 *  images is AUDIO, and NEEDS_IMAGES must not fire for an episode that has no shots. */
export async function missingShowrunnerImages(showRoot: string, episodeId: string, show: ShowConfig): Promise<string[]> {
  const d = dirs(show);
  const imagesDir = path.join(showRoot, d.production, episodeId, "images");
  const listPath = path.join(imagesDir, "prompts.json");
  if (!(await exists(listPath))) return [];
  const doc = await readJson(listPath);
  const shots = isRecord(doc) && Array.isArray(doc["shots"]) ? doc["shots"] : [];
  const missing: string[] = [];
  for (const shot of shots) {
    if (!isRecord(shot) || shot["source"] !== "showrunner" || typeof shot["id"] !== "string") continue;
    if (!(await exists(path.join(imagesDir, `${shot["id"]}.png`)))) missing.push(shot["id"]);
  }
  return missing;
}

/** The three Needs flags for an episode, each derived from disk and nothing else (spec §3.3). */
export async function episodeNeeds(showRoot: string, episodeId: string, show: ShowConfig): Promise<Needs> {
  const d = dirs(show);
  const premise = path.join(showRoot, d.episodes, episodeId, "premise.md");
  const ideaMissing = !(await exists(premise)) || (await readFile(premise, "utf8")).trim() === "";
  return {
    ideaMissing,
    refsMissing: (await missingRefs(showRoot, episodeId, show)).length > 0,
    imagesMissing: (await missingShowrunnerImages(showRoot, episodeId, show)).length > 0,
  };
}

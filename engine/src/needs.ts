import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { formatFilename, resolveShowPath, type ShowConfig } from "./show-config.js";
import type { Needs } from "./stages.js";

export interface CastEntry { name: string; tags: string[] }

/** The outline's `## Cast` section, split into the lines that parse and the lines that do not.
 *  The section is the pipeline's only knowledge of who is in an episode before a script exists,
 *  which is why the outline prompt requires it and the canon reviewer checks it (F-01). Lines
 *  outside the section are ignored; a non-blank line inside it that does not match
 *  `- <Name> (<tag>, <tag>)` is returned in `malformed` rather than dropped, because a dropped
 *  line is a cast member the reference probe never checks — an em-dash instead of parentheses
 *  used to pass `refs-ready` silently and take an unregistered subject into synthesis. */
export function parseCastSection(outline: string): { entries: CastEntry[]; malformed: string[] } {
  const entries: CastEntry[] = [];
  const malformed: string[] = [];
  let inSection = false;
  for (const line of outline.split("\n")) {
    if (/^## /.test(line)) { inSection = /^## Cast\b/.test(line); continue; }
    if (!inSection || line.trim() === "") continue;
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

/** "the Warden" → "warden"; "Dock Hand Pim" → "dock-hand-pim". The bible's keys are slugs and
 *  the voice cast's keys are display names, so both sides are normalised the same way. */
export function slugName(name: string): string {
  return name.trim().toLowerCase().replace(/^the[ -]/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function dirs(show: ShowConfig) {
  return {
    episodes: show.episodesDir ?? "Episodes",
    production: show.productionDir ?? "Production",
    voiceRefs: typeof show.audio?.["voiceRefsDir"] === "string" ? show.audio["voiceRefsDir"] : "Production/voice-refs",
    visualRefs: typeof show.visual?.["refs"] === "string" ? show.visual["refs"] : "Canon/refs.json",
  };
}

/** One episode's guest-reference directory, show-relative: `audio.guestRefsDir` with its
 *  `{episodeId}` token replaced by the run's id, through the same `formatFilename` grammar the
 *  output filenames use, so a config that writes `{epId}` fails by name instead of leaving a brace
 *  in a path. A function rather than a field of `dirs()` because this is the only show path that is
 *  per-episode, and `dirs()` takes no id. Defaulted to `<productionDir>/<episodeId>/guest-refs` --
 *  the literal this probe hardcoded before Plan F -- rather than required, because a show that
 *  never casts a speaking guest should not have to name a directory it will never fill. */
function guestRefsDir(show: ShowConfig, episodeId: string): string {
  const configured = show.audio?.["guestRefsDir"];
  if (typeof configured === "string" && configured !== "") return formatFilename(configured, { episodeId });
  return path.posix.join(dirs(show).production, episodeId, "guest-refs");
}

/** One line per reference the outline's cast needs and the show does not have: a recurring
 *  subject without an entry or an image in the visual bible, a speaking recurring character
 *  whose voice is not LOCKED or whose WAV is absent, a speaking guest with no WAV under the
 *  episode's guest-refs. Two authoring slips are reported the same way, because a cast line this
 *  probe cannot read is a subject it cannot check: a line inside the section that misses the
 *  grammar, and an entry whose tags name none of `recurring`, `guest` or `location`. Empty when
 *  the outline has no `## Cast` section — the section's absence is the canon reviewer's finding,
 *  not this probe's. */
export async function missingRefs(showRoot: string, episodeId: string, show: ShowConfig): Promise<string[]> {
  const d = dirs(show);
  const outlinePath = path.join(showRoot, d.episodes, episodeId, "outline.md");
  if (!(await exists(outlinePath))) return [];
  const { entries: cast, malformed } = parseCastSection(await readFile(outlinePath, "utf8"));
  if (cast.length === 0 && malformed.length === 0) return [];

  const biblePath = resolveShowPath(showRoot, d.visualRefs);
  const bibleRaw = (await exists(biblePath)) ? await readJson(biblePath) : {};
  const bible: Record<string, Record<string, unknown>> = {};
  if (isRecord(bibleRaw)) for (const [k, v] of Object.entries(bibleRaw)) if (!k.startsWith("_") && isRecord(v)) bible[k] = v;

  const voicesPath = path.join(resolveShowPath(showRoot, d.voiceRefs), "refs.json");
  const voicesRaw = (await exists(voicesPath)) ? await readJson(voicesPath) : {};
  const voices: Record<string, Record<string, unknown>> = {};
  if (isRecord(voicesRaw) && isRecord(voicesRaw["cast"])) for (const [k, v] of Object.entries(voicesRaw["cast"])) if (isRecord(v)) voices[k] = v;

  // One value for the directory the probe reads and the directory its refusal names, so the two
  // can never disagree about where a guest WAV belongs.
  const guests = guestRefsDir(show, episodeId);
  const guestDir = resolveShowPath(showRoot, guests);
  const guestWavs = (await exists(guestDir)) ? (await readdir(guestDir)).filter((f) => f.toLowerCase().endsWith(".wav")).map((f) => f.toLowerCase()) : [];

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
    if (tags.has("recurring") || tags.has("location")) {
      const key = [slug, `the-${slug}`].find((k) => Object.prototype.hasOwnProperty.call(bible, k));
      if (key === undefined) {
        missing.push(`${entry.name}: no entry in ${d.visualRefs} (tried ${slug}, the-${slug})`);
      } else {
        const ref = bible[key]?.["ref"];
        if (typeof ref !== "string" || !(await exists(resolveShowPath(showRoot, ref)))) {
          missing.push(`${entry.name}: reference image missing at ${typeof ref === "string" ? ref : "(no ref)"} (${d.visualRefs} key ${key})`);
        }
      }
    }
    if (tags.has("recurring") && speaks) {
      const voiceKey = Object.keys(voices).find((k) => slugName(k) === slug);
      const voice = voiceKey !== undefined ? voices[voiceKey] : undefined;
      if (voice === undefined) {
        missing.push(`${entry.name}: no voice in ${path.posix.join(d.voiceRefs, "refs.json")} cast`);
      } else {
        const status = typeof voice["status"] === "string" ? voice["status"] : "";
        const ref = voice["ref"];
        if (!status.includes("LOCKED")) missing.push(`${entry.name}: voice is not LOCKED in ${path.posix.join(d.voiceRefs, "refs.json")} (cast key ${voiceKey})`);
        else if (typeof ref !== "string" || !(await exists(resolveShowPath(showRoot, ref)))) missing.push(`${entry.name}: voice WAV missing at ${typeof ref === "string" ? ref : "(no ref)"}`);
      }
    }
    if (tags.has("guest") && speaks) {
      if (!guestWavs.some((f) => f.startsWith(slug))) {
        missing.push(`${entry.name}: no guest voice at ${guests}/${slug}*.wav`);
      }
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

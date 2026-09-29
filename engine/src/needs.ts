import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolveShowPath, type ShowConfig } from "./show-config.js";
import type { Needs } from "./stages.js";

export interface CastEntry { name: string; tags: string[] }

/** The outline's `## Cast` section, one entry per line of the form `- <Name> (<tag>, <tag>)`.
 *  The section is the pipeline's only knowledge of who is in an episode before a script exists,
 *  which is why the outline prompt requires it and the canon reviewer checks it (F-01). Lines
 *  outside the section, and lines inside it that do not match the grammar, are ignored. */
export function parseCastSection(outline: string): CastEntry[] {
  const out: CastEntry[] = [];
  let inSection = false;
  for (const line of outline.split("\n")) {
    if (/^## /.test(line)) { inSection = /^## Cast\b/.test(line); continue; }
    if (!inSection) continue;
    const m = /^- (.+?) \(([^)]*)\)\s*$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.push({ name: m[1].trim(), tags: m[2].split(",").map((t) => t.trim().toLowerCase()).filter((t) => t !== "") });
  }
  return out;
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

/** One line per reference the outline's cast needs and the show does not have: a recurring
 *  subject without an entry or an image in the visual bible, a speaking recurring character
 *  whose voice is not LOCKED or whose WAV is absent, a speaking guest with no WAV under the
 *  episode's guest-refs. Empty when the outline has no `## Cast` section — the section's absence
 *  is the canon reviewer's finding, not this probe's. */
export async function missingRefs(showRoot: string, episodeId: string, show: ShowConfig): Promise<string[]> {
  const d = dirs(show);
  const outlinePath = path.join(showRoot, d.episodes, episodeId, "outline.md");
  if (!(await exists(outlinePath))) return [];
  const cast = parseCastSection(await readFile(outlinePath, "utf8"));
  if (cast.length === 0) return [];

  const biblePath = resolveShowPath(showRoot, d.visualRefs);
  const bibleRaw = (await exists(biblePath)) ? await readJson(biblePath) : {};
  const bible: Record<string, Record<string, unknown>> = {};
  if (isRecord(bibleRaw)) for (const [k, v] of Object.entries(bibleRaw)) if (!k.startsWith("_") && isRecord(v)) bible[k] = v;

  const voicesPath = path.join(resolveShowPath(showRoot, d.voiceRefs), "refs.json");
  const voicesRaw = (await exists(voicesPath)) ? await readJson(voicesPath) : {};
  const voices: Record<string, Record<string, unknown>> = {};
  if (isRecord(voicesRaw) && isRecord(voicesRaw["cast"])) for (const [k, v] of Object.entries(voicesRaw["cast"])) if (isRecord(v)) voices[k] = v;

  const guestDir = path.join(showRoot, d.production, episodeId, "guest-refs");
  const guestWavs = (await exists(guestDir)) ? (await readdir(guestDir)).filter((f) => f.toLowerCase().endsWith(".wav")).map((f) => f.toLowerCase()) : [];

  const missing: string[] = [];
  for (const entry of cast) {
    const slug = slugName(entry.name);
    const tags = new Set(entry.tags);
    const speaks = tags.has("speaks");
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
        missing.push(`${entry.name}: no guest voice at ${path.posix.join(d.production, episodeId, "guest-refs")}/${slug}*.wav`);
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

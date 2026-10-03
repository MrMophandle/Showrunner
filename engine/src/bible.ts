import path from "node:path";
import { readFile } from "node:fs/promises";
import type { ShowConfig } from "./show-config.js";

/** How `init` produces a bible file. "interview": an agent writes it from the author's answers and
 *  a gate shows it. "default": the template is a complete file the author keeps, edits or replaces
 *  at its gate — the three files that state the house's craft or the engine's facts rather than
 *  the show's. "scaffold": written with its headings and no gate, because the pipeline fills it. */
export type BibleMode = "interview" | "default" | "scaffold";

export interface BibleFile {
  /** A path-safe key: the template's basename, the log directory's name, the step's var. */
  key: string;
  /** The file, relative to the show root. The season file is named by the season the author starts. */
  file: string;
  mode: BibleMode;
  /** One sentence the interview shows before asking: what the file is for. */
  purpose: string;
}

/** The bible, in interview order — the order an author can think in: the world, then the arc,
 *  then the shape of an episode, then the voice, then the world's rules and history, then the
 *  first season, then the picture, then publishing, then the two house documents. The
 *  continuity ledger and the voice registry are scaffolds: `propose` writes the first and the
 *  NEEDS_REFS stop fills the second. Every `file` here is one the episode pipeline declares or a
 *  prompt reads by name (inventory §1), so `missingBibleFiles` is the pipeline's own list. */
export const BIBLE_FILES: readonly BibleFile[] = [
  { key: "world-overview", file: "Canon/world-overview.md", mode: "interview", purpose: "The premise, the tone, the rules of the world, and who the recurring cast are." },
  { key: "series-arc", file: "Canon/series-arc.md", mode: "interview", purpose: "The long thread under the episodes: what is true, who learns it, and how slowly." },
  { key: "episode-formula", file: "Canon/episode-formula.md", mode: "interview", purpose: "The shape every episode shares: length, beats, what varies, who can die." },
  { key: "story-craft", file: "Canon/story-craft.md", mode: "default", purpose: "The craft rules the structure auditor holds every script to. A house default you may keep or replace." },
  { key: "style-guide", file: "Canon/style-guide.md", mode: "interview", purpose: "The narration's voice: how it sounds, what it never does, and a sample of it." },
  { key: "technology", file: "Canon/technology.md", mode: "interview", purpose: "What is possible in this world and what is not: tools, travel, communication, the environment's rules." },
  { key: "timeline", file: "Canon/timeline.md", mode: "interview", purpose: "The world's history: its eras, the fixed events, and when the present day is." },
  { key: "season-1", file: "Canon/season-1.md", mode: "interview", purpose: "The first season's laws and, if you have it, its slate." },
  { key: "visual-style", file: "Canon/visual-style.md", mode: "interview", purpose: "The look of every frame: palette, composition, the scaffolding every image prompt carries." },
  { key: "visual-audit-laws", file: "Canon/visual-audit-laws.md", mode: "interview", purpose: "The numbered laws the image audit rejects a frame for breaking." },
  { key: "publishing-guide", file: "Canon/publishing-guide.md", mode: "interview", purpose: "How an episode is published: the standing copy, the choices made once, the series structure." },
  { key: "pipeline-artifacts", file: "Canon/pipeline-artifacts.md", mode: "default", purpose: "What the pipeline writes where, and the dialogue-attribution convention the audio step reads. The engine's facts." },
  { key: "readme", file: "Canon/README.md", mode: "default", purpose: "The index of the bible and the rules for writing to it. The house format." },
  { key: "continuity-ledger", file: "Canon/continuity-ledger.md", mode: "scaffold", purpose: "What happened, episode by episode. The pipeline writes it." },
  { key: "voice-registry", file: "Canon/voice-registry.md", mode: "scaffold", purpose: "Prose about the voices; the source of truth is Production/voice-refs/refs.json." },
];

/** The `BIBLE_FILES` key whose row stands for a season file rather than for one fixed path. The
 *  row is written as season 1 because season 1 is what `init` scaffolds; `missingBibleFiles`
 *  rewrites it to the season of the episode being made, and drops it for an episode that has no
 *  season at all. Kept as a constant so the two places that special-case that row cannot drift. */
const SEASON_FILE_KEY = "season-1";

export interface RequiredSection { file: string; heading: string; readBy: string }

/** The level-2 headings a prompt template reads by name (inventory F-09). A file that lacks one
 *  gives that prompt a silent partial read, so `bible-check` refuses it and the canon templates
 *  carry every one. Names match the first show's headings wherever that heading was generic, so
 *  an imported file passes with few renames. `Canon/season-{season}.md` stands for the season
 *  file of the episode being made. */
export const REQUIRED_SECTIONS: readonly RequiredSection[] = [
  { file: "Canon/world-overview.md", heading: "Logline", readBy: "outline.md" },
  { file: "Canon/world-overview.md", heading: "Premise", readBy: "outline.md" },
  { file: "Canon/world-overview.md", heading: "Tone and genre", readBy: "outline.md, tone-check.md" },
  { file: "Canon/world-overview.md", heading: "The rules of the universe", readBy: "outline.md, canon-review-outline.md, canon-review-script.md" },
  { file: "Canon/world-overview.md", heading: "The primary cast", readBy: "character-check.md" },
  { file: "Canon/world-overview.md", heading: "Recurring engine for stories", readBy: "outline.md" },
  { file: "Canon/style-guide.md", heading: "Narration", readBy: "draft.md, tone-check.md" },
  { file: "Canon/style-guide.md", heading: "The retention contract", readBy: "script-gate.reject.md, tone-check.md" },
  { file: "Canon/style-guide.md", heading: "Rules of voice", readBy: "draft.md, repetition-check.md" },
  { file: "Canon/style-guide.md", heading: "Cadence", readBy: "flow-check.md, tone-check.md" },
  { file: "Canon/style-guide.md", heading: "Character voices", readBy: "character-check.md" },
  { file: "Canon/style-guide.md", heading: "Register sample", readBy: "draft.md, tone-check.md (when no script exists yet)" },
  { file: "Canon/episode-formula.md", heading: "Target", readBy: "outline.md, outline-gate.reject.md" },
  { file: "Canon/episode-formula.md", heading: "Beats", readBy: "outline.md, flow-check.md" },
  { file: "Canon/episode-formula.md", heading: "Death rules", readBy: "structure-check.md" },
  { file: "Canon/story-craft.md", heading: "The causality law", readBy: "structure-check.md" },
  { file: "Canon/story-craft.md", heading: "Endings", readBy: "structure-check.md, outline.md" },
  { file: "Canon/technology.md", heading: "Governing principle", readBy: "environment-check.md" },
  { file: "Canon/technology.md", heading: "Environment rules", readBy: "environment-check.md" },
  { file: "Canon/timeline.md", heading: "Eras", readBy: "canon-review-outline.md" },
  { file: "Canon/timeline.md", heading: "Present-day baseline", readBy: "canon-review-outline.md" },
  { file: "Canon/season-{season}.md", heading: "Season laws", readBy: "outline.md, canon-review-outline.md" },
  { file: "Canon/visual-style.md", heading: "The look", readBy: "visual-direction.md" },
  { file: "Canon/visual-style.md", heading: "Palette", readBy: "visual-direction.md" },
  { file: "Canon/visual-style.md", heading: "Composition rules", readBy: "visual-direction.md" },
  { file: "Canon/visual-style.md", heading: "Mandatory prompt scaffolding", readBy: "visual-direction.md" },
  { file: "Canon/publishing-guide.md", heading: "Standing choices", readBy: "publish-copy.md" },
  { file: "Canon/publishing-guide.md", heading: "Series structure", readBy: "publish-copy.md" },
  { file: "Canon/continuity-ledger.md", heading: "Open threads", readBy: "propose.md" },
  { file: "Canon/continuity-ledger.md", heading: "Episode log", readBy: "propose.md" },
  { file: "Canon/pipeline-artifacts.md", heading: "Script dialogue attribution", readBy: "tts-script.md" },
];

const normalise = (s: string): string => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** True when `line` is a level-2 heading whose normalised text begins with the normalised
 *  `heading`: case, `&`/"and", quotes, dashes and parentheticals do not count, so
 *  "## The rules of the universe (load-bearing — do not contradict)" carries "The rules of the
 *  universe". A prefix match on whole words: "## Cast" does not carry "Casting". */
export function headingMatches(line: string, heading: string): boolean {
  const m = /^##\s+(.+?)\s*$/.exec(line);
  if (!m) return false;
  const have = normalise(m[1]!);
  const want = normalise(heading);
  return have === want || have.startsWith(want + " ");
}

/** Every file the episode pipeline reads from the bible, as paths relative to the show root,
 *  de-duplicated and in the order the checks are declared: the `BIBLE_FILES` rows with
 *  `Canon/` rewritten to the show's canon directory, the four files the config names
 *  (`visual.style`, `visual.auditLaws`, `audio.voiceRegistry`, `publish.guide`), and the outline
 *  template. `season` governs the season file exactly as the episode pipeline's canon spine does:
 *  a number means `<canon>/season-<season>.md` is in the list and no other season's file is, and
 *  `undefined` — a production id the air map does not map, for which `seasonOf` throws — means no
 *  season file is in it at all.
 *
 *  It is split out of `missingBibleFiles` and touches no disk so that the episode pipeline's
 *  declared inputs can be tested against the guard's list. The two agree only by hand, and the
 *  asymmetry matters: a `Canon/` input some step declares that this list omits hashes null and
 *  runs that step against nothing (inventory F-01, the hole `bible-ready` exists to close), while
 *  a file in this list that no step declares merely refuses a run that would have worked. A test
 *  that walks the pipeline's steps can hold both lines only if the list is callable without a
 *  show on disk. */
export function bibleFilesFor(show: ShowConfig, season?: number): string[] {
  const canon = show.canonDir ?? "Canon";
  const episodes = show.episodesDir ?? "Episodes";
  const str = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);
  const files = new Set<string>();
  for (const b of BIBLE_FILES) {
    if (b.key === SEASON_FILE_KEY) {
      if (season !== undefined) files.add(`${canon}/season-${season}.md`);
      continue;
    }
    files.add(b.file.replace(/^Canon\//, `${canon}/`));
  }
  for (const rel of [
    str(show.visual?.["style"], `${canon}/visual-style.md`),
    str(show.visual?.["auditLaws"], `${canon}/visual-audit-laws.md`),
    str(show.audio?.["voiceRegistry"], `${canon}/voice-registry.md`),
    str(show.publish?.["guide"], `${canon}/publishing-guide.md`),
    `${episodes}/_TEMPLATE/outline.md`,
  ]) files.add(rel);
  return [...files];
}

/** Every file of `bibleFilesFor(show, season)` that is absent or empty: each must exist and carry
 *  something. Returned sorted, `<path>` for an absent file and `<path> (empty)` for an empty one,
 *  so the `bible-ready` guard's message names what to write. `season` is the season of the
 *  episode being made and reaches `bibleFilesFor` unchanged. */
export async function missingBibleFiles(showRoot: string, show: ShowConfig, season?: number): Promise<string[]> {
  const out: string[] = [];
  for (const rel of bibleFilesFor(show, season)) {
    let text: string | undefined;
    try { text = await readFile(path.join(showRoot, rel), "utf8"); } catch { text = undefined; }
    if (text === undefined) out.push(rel);
    else if (text.trim() === "") out.push(`${rel} (empty)`);
  }
  return out.sort();
}

/** Every required section absent from a file that exists. An absent file is not reported here —
 *  that is `missingBibleFiles`' report, and reporting it twice would make one fault look like
 *  thirty. `season` names the season `Canon/season-{season}.md` stands for, defaulting to 1, the
 *  season `init` scaffolds. */
export async function missingSections(showRoot: string, show: ShowConfig, season = 1): Promise<RequiredSection[]> {
  const canon = show.canonDir ?? "Canon";
  const out: RequiredSection[] = [];
  const byFile = new Map<string, RequiredSection[]>();
  for (const s of REQUIRED_SECTIONS) {
    const file = s.file.replace("{season}", String(season)).replace(/^Canon\//, `${canon}/`);
    const list = byFile.get(file) ?? [];
    list.push({ ...s, file });
    byFile.set(file, list);
  }
  for (const [file, sections] of byFile) {
    let text: string;
    try { text = await readFile(path.join(showRoot, file), "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (const s of sections) if (!lines.some((l) => headingMatches(l, s.heading))) out.push(s);
  }
  return out;
}

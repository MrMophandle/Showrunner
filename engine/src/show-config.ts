import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseEpisodeId, type EpisodeId } from "./ids.js";

export class ShowConfigError extends Error { override readonly name = "ShowConfigError"; }

export const SHOW_CONFIG_FILE = "showrunner.json";

/** The show repository's root config. The engine reads promptsDir, models and airMap; the Python
 *  scripts read the rest through scripts/lib/showconfig.py against the same file. Paths are
 *  relative to the show root unless absolute. */
export interface ShowConfig {
  showName: string;
  showSlug: string;
  promptsDir: string;
  canonDir?: string;
  episodesDir?: string;
  productionDir?: string;
  models: { medium: string; large: string; writer: string; small?: string };
  /** Production id → [season, episode], for ids that aired under a production name. Plan F's
   *  rename to sXXeYY empties it. */
  airMap: Record<string, [number, number]>;
  output: { nasMount?: string; nasRoot: string; finalFilename?: string; mixFilename?: string; videoFilename?: string };
  audio?: Record<string, unknown>;
  visual?: Record<string, unknown>;
  video?: Record<string, unknown>;
  publish?: Record<string, unknown>;
}

/** One key of `showrunner.json`, as a dotted path, with who requires it and the default where one
 *  exists. `requiredBy: "both"` is one of the eight keys both loaders refuse to run without;
 *  `"engine"` and `"scripts"` name a reader that fails by name when the key is absent and no default
 *  applies; `"none"` is a key with a default on every reader. **No row is `"engine"` today** — the
 *  sixty rows are eight `both`, forty-four `scripts` and eight `none` — and the member is kept
 *  rather than dropped because the asymmetry is an accident of which reader grew first: the engine
 *  reads its own keys through optional accessors with fallbacks, and the first engine key that
 *  refuses a run by name belongs in this class rather than in a widened `"both"`. `readBy` names the readers in prose
 *  (a file name, or "engine"), so an author who sees the key in a config can find what it feeds.
 *  `init` writes every key here, and the test beside this file greps every `sc.value`/`sc.path`
 *  site in scripts/ to refuse a key the list does not carry. */
export interface ShowConfigKey { path: string; requiredBy: "engine" | "scripts" | "both" | "none"; default?: unknown; readBy: string }

/** Every key a show config carries, measured on 2026-10-03 from the readers themselves: the eight
 *  both loaders require, the keys the Python steps read through `sc.value`/`sc.path`, and the keys
 *  only the engine reads. It exists because the keys were discoverable nowhere but in the readers,
 *  so a new show's config could only be written by copying an existing one — `init` builds a config
 *  from these rows instead, and the grep test next door keeps the rows honest as the scripts change.
 *
 *  `default` is recorded only where a reader of that key supplies a fallback for it in code (an
 *  engine `??`/`str(...)` default, or a Python `default=` at every site of the key). The four
 *  `"none"` rows with no `default` are keys nothing reads yet, so no reader has a fallback to
 *  record; the eight required keys carry no `default` because no reader has one — `init` must
 *  obtain them. A `"scripts"` row can still carry a `default`: the engine defaults the key and a
 *  script requires it, which is why `requiredBy` and `default` are separate columns. */
export const SHOW_CONFIG_KEYS: readonly ShowConfigKey[] = [
  { path: "showName", requiredBy: "both", readBy: "engine (the loader below); scripts/publish-kit.py:89, scripts/nano-banana-generate.py:428" },
  { path: "showSlug", requiredBy: "both", readBy: "engine/src/show-config.ts (mixFilename, below); scripts/audio-mix.py:30, scripts/build-timeline.py:62, scripts/finalize-video.py:139, scripts/season-status.py:192" },
  { path: "promptsDir", requiredBy: "both", readBy: "engine/src/agent-step.ts:148 (where every agent step finds its prompt); no script reads it, and the scripts' loader requires it" },
  { path: "canonDir", requiredBy: "scripts", default: "Canon", readBy: "engine/src/pipelines/episode.ts:60 (defaulted); scripts/canon-diff.py:64, scripts/finalize-video.py:166, scripts/season-status.py:148 (no default)" },
  { path: "episodesDir", requiredBy: "scripts", default: "Episodes", readBy: "engine/src/pipelines/episode.ts:61, engine/src/needs.ts:45 (defaulted); scripts/check_layout.py:36, scripts/publish-kit.py:98, scripts/season-status.py:149, scripts/status.py:40 (no default); scripts/canon-ledger.py:66 defaults it" },
  { path: "productionDir", requiredBy: "scripts", default: "Production", readBy: "engine/src/pipelines/episode.ts:62, engine/src/needs.ts:46 (defaulted); scripts/check_layout.py:37, scripts/season-status.py:150 (no default)" },
  { path: "models.small", requiredBy: "none", readBy: "nothing yet: engine/src/agent-step.ts:252 resolves a step's tier name through models, and no step declares the small tier" },
  { path: "models.medium", requiredBy: "both", readBy: "engine/src/agent-step.ts:251-252 (the tier seven steps declare); console/server/what-happened.ts:223" },
  { path: "models.large", requiredBy: "both", readBy: "engine/src/agent-step.ts:251-252 (the tier one step declares)" },
  { path: "models.writer", requiredBy: "both", readBy: "engine/src/agent-step.ts:251-252 (the tier four steps declare)" },
  { path: "airMap", requiredBy: "both", readBy: "engine/src/show-config.ts (seasonOf, mixFilename), engine/src/pipelines/episode.ts:76; scripts/lib/showconfig.py (season_of)" },
  { path: "output.nasMount", requiredBy: "scripts", readBy: "scripts/finalize-video.py:164 (sc.path, no default); the loader accepts it and no engine step reads it" },
  { path: "output.nasRoot", requiredBy: "both", readBy: "engine/src/pipelines/episode.ts:332 (the nas-mounted guard); scripts/finalize-video.py:165, scripts/season-status.py:151" },
  { path: "output.finalFilename", requiredBy: "scripts", readBy: "scripts/finalize-video.py:138, scripts/season-status.py:191" },
  { path: "output.mixFilename", requiredBy: "scripts", default: "{slug} S{season:02d}E{episode:02d}.wav", readBy: "engine/src/show-config.ts (DEFAULT_MIX_PATTERN, below — defaulted); scripts/audio-mix.py:29, scripts/build-timeline.py:61 (no default)" },
  { path: "output.videoFilename", requiredBy: "scripts", default: "episode.mp4", readBy: "engine/src/pipelines/episode.ts:74 (defaulted); scripts/finalize-video.py:167, scripts/master-video.py:74 (no default)" },
  { path: "audio.sampleRate", requiredBy: "scripts", readBy: "scripts/audio-mix.py:44, scripts/design-voice.py:29, scripts/pace-qc.py:47, scripts/tts-generate.py:73" },
  { path: "audio.loudness.i", requiredBy: "scripts", readBy: "scripts/audio-mix.py:51, scripts/master-video.py:70 (the integrated-loudness target)" },
  { path: "audio.loudness.tp", requiredBy: "scripts", readBy: "scripts/audio-mix.py:52, scripts/master-video.py:71 (the true-peak ceiling)" },
  { path: "audio.loudness.lra", requiredBy: "scripts", readBy: "scripts/audio-mix.py:53, scripts/master-video.py:72 (the loudness range)" },
  { path: "audio.voiceDesignLoudnessI", requiredBy: "scripts", readBy: "scripts/design-voice.py:30" },
  { path: "audio.roomToneDb", requiredBy: "none", default: null, readBy: "scripts/audio-mix.py:46 (default=None — a show that wants no room-tone bed omits the key)" },
  { path: "audio.roomToneFundamentalHz", requiredBy: "scripts", readBy: "scripts/audio-mix.py:48, with no default and only when audio.roomToneDb is set: a show that asks for a bed must say what it is pitched at" },
  { path: "audio.tailOutSeconds", requiredBy: "scripts", readBy: "scripts/audio-mix.py:45, scripts/build-timeline.py:101" },
  { path: "audio.titleCardGapSeconds", requiredBy: "none", readBy: "nothing yet: only the ceiling audio.titleCardGapMaxSeconds is read (scripts/validate-manifest.py:70); a prompt can reach the key as {{show.audio.titleCardGapSeconds}} (engine/src/prompt-template.ts:66)" },
  { path: "audio.titleCardGapMaxSeconds", requiredBy: "scripts", readBy: "scripts/validate-manifest.py:70 (the manifest's title-card gap ceiling)" },
  { path: "audio.sceneTransitionGapSeconds", requiredBy: "none", readBy: "nothing yet: only the ceiling audio.sceneTransitionGapMaxSeconds is read (scripts/validate-manifest.py:71); a prompt can reach the key as {{show.audio.sceneTransitionGapSeconds}}" },
  { path: "audio.sceneTransitionGapMaxSeconds", requiredBy: "scripts", readBy: "scripts/validate-manifest.py:71 (the manifest's scene-transition gap ceiling)" },
  { path: "audio.authoredPauseRangeSeconds", requiredBy: "scripts", readBy: "scripts/validate-manifest.py:72 (the [PAUSE n] range, read as a two-element list)" },
  { path: "audio.narratorSpeakerKey", requiredBy: "scripts", readBy: "scripts/audio-mix.py:50, scripts/breath-qc.py:109, scripts/pace-qc.py:46" },
  { path: "audio.mainCast", requiredBy: "scripts", readBy: "scripts/validate-manifest.py:73 (the speaker keys a manifest may use without a guest WAV)" },
  { path: "audio.voiceRefsDir", requiredBy: "none", default: "Production/voice-refs", readBy: "engine/src/pipelines/episode.ts:67, engine/src/needs.ts:47 (both defaulted); no script site names it" },
  { path: "audio.guestRefsDir", requiredBy: "none", readBy: "nothing yet: engine/src/needs.ts:77 hardcodes <productionDir>/<episodeId>/guest-refs instead of reading the key. The value carries a literal `{episodeId}` placeholder, which nothing substitutes because nothing reads it; a reader that wires this key must replace that token with the run's episode id, and the value is written with it so the key records that it is per-episode" },
  { path: "audio.voiceRegistry", requiredBy: "scripts", default: "Canon/voice-registry.md", readBy: "engine/src/pipelines/episode.ts:68 (defaulted to <canonDir>/voice-registry.md); scripts/validate-manifest.py:74 (sc.path, no default)" },
  { path: "visual.refs", requiredBy: "scripts", default: "Canon/refs.json", readBy: "engine/src/pipelines/episode.ts:69, engine/src/needs.ts:48 (defaulted); scripts/design-visual.py:61, scripts/image-generate.py:78, scripts/nano-banana-generate.py:423, scripts/registry-append.py:117 (sc.path, no default)" },
  { path: "visual.style", requiredBy: "scripts", default: "Canon/visual-style.md", readBy: "engine/src/pipelines/episode.ts:70 (defaulted); scripts/image-sheet.py:72, scripts/nano-banana-generate.py:426, scripts/populator-check.py:69 (no default)" },
  { path: "visual.auditLaws", requiredBy: "scripts", readBy: "scripts/nano-banana-generate.py:425 (sc.path)" },
  { path: "visual.castingPileDir", requiredBy: "scripts", default: "Canon/characters", readBy: "engine/src/pipelines/episode.ts:71 (defaulted); scripts/design-visual.py:63, scripts/image-sheet.py:71, scripts/registry-append.py:118 (no default)" },
  { path: "visual.candidatesDir", requiredBy: "scripts", readBy: "scripts/design-visual.py:62 (sc.path)" },
  { path: "visual.shotFrame", requiredBy: "scripts", readBy: "scripts/build-timeline.py:102, scripts/design-visual.py:64, scripts/image-generate.py:74 (the frame size, read as a list)" },
  { path: "visual.characterKinds", requiredBy: "scripts", readBy: "scripts/registry-append.py:119" },
  { path: "visual.ambientPromptScaffold", requiredBy: "none", default: [], readBy: "scripts/image-sheet.py:70 (default=[])" },
  { path: "visual.styleConstants", requiredBy: "scripts", readBy: "scripts/nano-banana-generate.py:424" },
  { path: "visual.collectivePopulatorBans", requiredBy: "scripts", readBy: "scripts/nano-banana-generate.py:427, scripts/populator-check.py:68" },
  { path: "video.fps", requiredBy: "scripts", readBy: "scripts/build-timeline.py:99, scripts/shot-sheet.py:45" },
  { path: "video.crossfadeSeconds", requiredBy: "scripts", readBy: "scripts/build-timeline.py:100, scripts/shot-sheet.py:46" },
  { path: "video.compositionId", requiredBy: "none", default: "Episode", readBy: "nothing yet (O-03)" },
  { path: "video.titleCard", requiredBy: "scripts", readBy: "scripts/build-timeline.py:72, which refuses a value that is not an object" },
  { path: "video.titleCard.text", requiredBy: "scripts", readBy: "scripts/build-timeline.py:79" },
  { path: "video.titleCard.fontFamily", requiredBy: "scripts", readBy: "scripts/build-timeline.py:80" },
  { path: "video.titleCard.colors", requiredBy: "scripts", readBy: "scripts/build-timeline.py:81" },
  { path: "video.titleCard.fadeSeconds", requiredBy: "scripts", readBy: "scripts/build-timeline.py:78 (multiplied by video.fps into fadeFrames)" },
  { path: "publish.channelName", requiredBy: "scripts", readBy: "scripts/publish-kit.py:90" },
  { path: "publish.playlistUrl", requiredBy: "scripts", readBy: "scripts/publish-kit.py:91" },
  { path: "publish.playlistName", requiredBy: "scripts", readBy: "scripts/publish-kit.py:92" },
  { path: "publish.tags", requiredBy: "scripts", readBy: "scripts/publish-kit.py:93" },
  { path: "publish.category", requiredBy: "scripts", readBy: "scripts/publish-kit.py:94" },
  { path: "publish.standingCopy.weekly", requiredBy: "scripts", readBy: "scripts/publish-kit.py:95" },
  { path: "publish.standingCopy.aiDisclosure", requiredBy: "scripts", readBy: "scripts/publish-kit.py:96" },
  { path: "publish.guide", requiredBy: "scripts", default: "Canon/publishing-guide.md", readBy: "engine/src/pipelines/episode.ts:72 (defaulted); scripts/publish-kit.py:97 (no default)" },
];

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }

function str(obj: Record<string, unknown>, key: string, at: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") throw new ShowConfigError(`${SHOW_CONFIG_FILE}: ${at}${key} must be a non-empty string`);
  return v;
}
function optStr(obj: Record<string, unknown>, key: string, at: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ShowConfigError(`${SHOW_CONFIG_FILE}: ${at}${key} must be a string`);
  return v;
}
function rec(obj: Record<string, unknown>, key: string, at: string): Record<string, unknown> {
  const v = obj[key];
  if (!isRecord(v)) throw new ShowConfigError(`${SHOW_CONFIG_FILE}: ${at}${key} must be an object`);
  return v;
}
function optRec(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new ShowConfigError(`${SHOW_CONFIG_FILE}: ${key} must be an object`);
  return v;
}

export async function loadShowConfig(showRoot: string): Promise<ShowConfig> {
  const file = path.join(showRoot, SHOW_CONFIG_FILE);
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (err) { throw new ShowConfigError(`${SHOW_CONFIG_FILE} could not be read at ${file}: ${(err as Error).message}`, { cause: err }); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new ShowConfigError(`${SHOW_CONFIG_FILE} at ${file} is not valid JSON: ${(err as Error).message}`, { cause: err }); }
  if (!isRecord(parsed)) throw new ShowConfigError(`${SHOW_CONFIG_FILE} must be a JSON object`);

  const models = rec(parsed, "models", "");
  const airRaw = rec(parsed, "airMap", "");
  const airMap: Record<string, [number, number]> = {};
  for (const [id, v] of Object.entries(airRaw)) {
    // The key is checked before the value: airMap answers "which season did this production id air
    // in", so every key must be a production id and nothing else. An aired id (sXXeYY) is refused
    // because it already carries its season in the id — seasonOf reads it off the id and never
    // consults the map (see seasonOf below), so a mapping for one could only ever be a second,
    // silently disagreeing answer. Anything parseEpisodeId refuses outright ("ep1") is refused here
    // with the key named, so the operator is pointed at the line rather than at the whole file.
    let parsedKey: EpisodeId | undefined;
    try { parsedKey = parseEpisodeId(id); } catch { parsedKey = undefined; }
    if (parsedKey === undefined || parsedKey.kind !== "production") {
      throw new ShowConfigError(`${SHOW_CONFIG_FILE}: airMap.${id} must be a production id (epNN)`);
    }
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isInteger(n) && (n as number) > 0)) {
      throw new ShowConfigError(`${SHOW_CONFIG_FILE}: airMap.${id} must be [season, episode] with positive integers`);
    }
    airMap[id] = [v[0] as number, v[1] as number];
  }
  const output = rec(parsed, "output", "");
  const small = optStr(models, "small", "models.");
  const nasMount = optStr(output, "nasMount", "output.");
  const finalFilename = optStr(output, "finalFilename", "output.");
  const mixFilename = optStr(output, "mixFilename", "output.");
  const videoFilename = optStr(output, "videoFilename", "output.");
  const cfg: ShowConfig = {
    showName: str(parsed, "showName", ""),
    showSlug: str(parsed, "showSlug", ""),
    promptsDir: str(parsed, "promptsDir", ""),
    models: {
      medium: str(models, "medium", "models."),
      large: str(models, "large", "models."),
      writer: str(models, "writer", "models."),
      ...(small !== undefined ? { small } : {}),
    },
    airMap,
    output: {
      nasRoot: str(output, "nasRoot", "output."),
      ...(nasMount !== undefined ? { nasMount } : {}),
      ...(finalFilename !== undefined ? { finalFilename } : {}),
      ...(mixFilename !== undefined ? { mixFilename } : {}),
      ...(videoFilename !== undefined ? { videoFilename } : {}),
    },
  };
  for (const key of ["canonDir", "episodesDir", "productionDir"] as const) {
    const v = optStr(parsed, key, "");
    if (v !== undefined) cfg[key] = v;
  }
  for (const key of ["audio", "visual", "video", "publish"] as const) {
    const v = optRec(parsed, key);
    if (v !== undefined) cfg[key] = v;
  }
  return cfg;
}

/** The numeric season of an episode: read off an aired id, or looked up in the air map for a
 *  production id. Throws ShowConfigError when neither applies, so a prompt's {{season}} is never
 *  rendered from a guess. */
export function seasonOf(episodeId: string, airMap: Record<string, [number, number]>): number {
  const id = parseEpisodeId(episodeId);
  if (id.kind === "aired") return id.season;
  const mapped = airMap[id.raw];
  if (!mapped) throw new ShowConfigError(`no season for production id ${id.raw}: it is not in airMap`);
  return mapped[0];
}

export function resolveShowPath(showRoot: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(showRoot, p);
}


/** Renders an output-filename pattern the way scripts/lib/showconfig.py's format_filename does,
 *  so the engine and the scripts name the same file: `{name}` substitutes as is and `{name:02d}`
 *  zero-pads a number to that width. Nothing else of Python's format grammar is supported, and
 *  an unknown name is an error rather than a hole in a path. */
export function formatFilename(pattern: string, vars: Record<string, string | number>): string {
  return pattern.replace(/\{([A-Za-z_][A-Za-z0-9_]*)(?::0(\d+)d)?\}/g, (_whole, name: string, width?: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new ShowConfigError(`filename pattern ${JSON.stringify(pattern)}: unknown name ${JSON.stringify(name)}`);
    const v = vars[name];
    return width !== undefined ? String(v).padStart(Number(width), "0") : String(v);
  });
}

const DEFAULT_MIX_PATTERN = "{slug} S{season:02d}E{episode:02d}.wav";
/** scripts/audio-mix.py's name for the mix of an episode that has no season: a production id
 *  the air map does not place. Mirrored here so the pipeline can declare the file as an input. */
const UNMAPPED_MIX = "episode.wav";

/** The basename of an episode's mixed WAV, as scripts/audio-mix.py writes it. */
export function mixFilename(show: ShowConfig, episodeId: string): string {
  const id = parseEpisodeId(episodeId);
  const slot = id.kind === "aired" ? [id.season, id.episode] as const : show.airMap[id.raw];
  if (!slot) return UNMAPPED_MIX;
  return formatFilename(show.output.mixFilename ?? DEFAULT_MIX_PATTERN, { slug: show.showSlug, season: slot[0], episode: slot[1], episodeId });
}

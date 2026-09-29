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

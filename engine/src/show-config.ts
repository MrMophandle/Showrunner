import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseEpisodeId } from "./ids.js";

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

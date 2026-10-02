import path from "node:path";
import { readdir } from "node:fs/promises";
import { parseEpisodeId } from "./ids.js";

/** A run id names a directory entry, so it is held to the same alphabet as an episode id. It
 *  lives here rather than in events.ts because listRuns applies the same alphabet to the names it
 *  reads back off disk, and one regexp is the only way the writer and the reader agree. */
export const RUN_ID = /^[A-Za-z0-9_-]+$/;

/** A run id that sorts by creation time: a UTC timestamp to the second, then four random
 *  characters so two launches in one second stay distinct. Lexical order is creation order, so
 *  "the latest run" is the last id and `priorLogs` is every earlier one — the only ordering the
 *  engine's resume contract gets, since readdir order is not one. */
export function mintRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `${stamp}-${rand}`;
}

/** The ids of an episode's runs, ascending — every `<id>.jsonl` under the episode's runs
 *  directory; locks, worker logs and anything else are not runs. Empty when the directory does
 *  not exist, which is every episode that has never run. */
export async function listRuns(showRoot: string, episodeId: string, productionDir = "Production"): Promise<string[]> {
  parseEpisodeId(episodeId);
  const dir = path.join(showRoot, productionDir, episodeId, "runs");
  let names: string[];
  try { names = await readdir(dir); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length)).filter((id) => RUN_ID.test(id)).sort();
}

/** The id of the episode's most recent run, or undefined for an episode that has never run. */
export async function latestRunId(showRoot: string, episodeId: string, productionDir = "Production"): Promise<string | undefined> {
  const runs = await listRuns(showRoot, episodeId, productionDir);
  return runs[runs.length - 1];
}

/** The log paths of an episode's runs, ascending, for `RunOptions.priorLogs`. */
export async function runLogPaths(showRoot: string, episodeId: string, productionDir = "Production"): Promise<string[]> {
  const runs = await listRuns(showRoot, episodeId, productionDir);
  return runs.map((r) => path.join(showRoot, productionDir, episodeId, "runs", `${r}.jsonl`));
}

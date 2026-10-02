import path from "node:path";
import { readdir } from "node:fs/promises";
import { compareEpisodeIds, isEpisodeId, parseEpisodeId } from "./ids.js";
import type { ShowConfig } from "./show-config.js";

/** Every episode the show has, in id order: the union of the directory names under the
 *  episodes directory (where a premise lives) and the production directory (where runs live)
 *  that parse as episode ids. `_TEMPLATE`, `_retired`, `voice-refs` and the like fall out of the
 *  filter. The Board's first job is this list, and nothing else in the engine had it. */
export async function listEpisodeIds(showRoot: string, show: ShowConfig): Promise<string[]> {
  const ids = new Set<string>();
  for (const dir of [show.episodesDir ?? "Episodes", show.productionDir ?? "Production"]) {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(path.join(showRoot, dir), { withFileTypes: true }); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const e of entries) if (e.isDirectory() && isEpisodeId(e.name)) ids.add(e.name);
  }
  return [...ids].sort((a, b) => compareEpisodeIds(parseEpisodeId(a), parseEpisodeId(b)));
}

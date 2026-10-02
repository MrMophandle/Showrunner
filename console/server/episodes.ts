import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  EPISODE_STAGE_MAP, deriveRunState, deriveStage, missingRefs, missingShowrunnerImages, parseEpisodeId, type Needs,
} from "@showrunner/engine";
import type { EpisodeRow } from "../shared/types.js";
import type { ShowContext } from "./show.js";

/** The parts of a Board row that come from the episode's files rather than from a run log: what
 *  the episode is called, what it is missing, and the row for an episode that has never run at
 *  all. `RunStore.episodeRow` joins these to a run's view. */

/** The episode's title: the `# ` heading of its outline, else of its script, else the id itself.
 *  The outline is asked first because it exists first and because its heading is the one the
 *  showrunner approved at `outline-gate`; the script's heading is a copy of it. An episode with
 *  neither file is shown under its id, which is what the Board shows before an idea exists. */
export async function episodeTitle(ctx: ShowContext, episodeId: string): Promise<string> {
  parseEpisodeId(episodeId);
  for (const name of ["outline.md", "script.md"]) {
    let text: string;
    try { text = await readFile(path.join(ctx.showRoot, ctx.episodesDir, episodeId, name), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const m = /^# (.+)$/.exec(line);
      if (m?.[1] !== undefined) return m[1].trim();
    }
  }
  return episodeId;
}

/** The needs of an episode, in both shapes the console wants them: `flags` is what
 *  `deriveStage` consults, `detail` is what the Board shows. Both come from one pass over the
 *  disk, so the stage and the reasons beside it can never disagree — a row that reads
 *  NEEDS_REFS with an empty `refsMissing` would send the operator looking for a reference that
 *  the probe had, on a second pass, found.
 *
 *  This is `episodeNeeds` with its reasons kept: the engine's version returns the three booleans
 *  and throws the lists away, so calling it and then calling the two probes again would scan the
 *  same files twice per episode on every Board refresh. The premise test is the engine's —
 *  missing or blank. */
export async function readNeeds(ctx: ShowContext, episodeId: string): Promise<{ flags: Needs; detail: EpisodeRow["needs"] }> {
  parseEpisodeId(episodeId);
  const premise = path.join(ctx.showRoot, ctx.episodesDir, episodeId, "premise.md");
  let ideaMissing: boolean;
  try { ideaMissing = (await readFile(premise, "utf8")).trim() === ""; } catch { ideaMissing = true; }
  const detail: EpisodeRow["needs"] = {
    ideaMissing,
    refsMissing: await missingRefs(ctx.showRoot, episodeId, ctx.show),
    imagesMissing: await missingShowrunnerImages(ctx.showRoot, episodeId, ctx.show),
  };
  return {
    flags: { ideaMissing, refsMissing: detail.refsMissing.length > 0, imagesMissing: detail.imagesMissing.length > 0 },
    detail,
  };
}

/** The row for an episode with no runs: a directory under `Episodes/` or `Production/` and
 *  nothing more. Its stage is what `deriveStage` makes of an empty run — IDEA when a premise
 *  exists, NEEDS_IDEA when one does not — and its status is "none", the one status that is not
 *  a state of a run but the absence of one. */
export async function idleEpisodeRow(ctx: ShowContext, episodeId: string): Promise<EpisodeRow> {
  const { flags, detail } = await readNeeds(ctx, episodeId);
  return {
    id: episodeId,
    title: await episodeTitle(ctx, episodeId),
    stage: deriveStage(deriveRunState([]), EPISODE_STAGE_MAP, flags),
    status: "none",
    needs: detail,
  };
}

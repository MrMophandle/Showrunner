import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  EPISODE_STAGE_MAP, deriveRunState, deriveStage, isStage, missingRefs, missingShowrunnerImages, parseEpisodeId, type Needs,
} from "@showrunner/engine";
import type { EpisodeRow } from "../shared/types.js";
import type { ShowContext } from "./show.js";

/** The parts of a Board row that come from the episode's files rather than from a run log: what
 *  the episode is called, what it is missing, whether it is archived, and the row for an episode
 *  that has never run at all. `RunStore.episodeRow` joins these to a run's view. */

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

/** The name of the archive marker, read from the episode's directory under `episodesDir`. */
const ARCHIVE_FILE = "archive.json";

/** What an episode's `archive.json` says, once read: the stage to show it at, and the one line of
 *  prose the Board puts beside the "archived" chip. */
export interface ArchiveMarker {
  /** A `Stage` string the engine's `isStage` accepted. */
  stage: string;
  note?: string;
}

/** The episode's archive marker, the reason it could not be read, or neither.
 *
 *  Three outcomes, kept apart because they are three different rows: `undefined` is an episode
 *  with no marker (the ordinary idle row), a `marker` is an episode finished outside the engine,
 *  and an `error` is a marker that exists and is wrong — which the Board says out loud rather
 *  than treating as absent, because a marker nobody is told about is a Season 1 row that silently
 *  goes back to reading NEEDS_IDEA after someone edits a comma. */
export async function readArchiveMarker(
  ctx: ShowContext, episodeId: string,
): Promise<{ marker: ArchiveMarker } | { error: string } | undefined> {
  parseEpisodeId(episodeId);
  const file = path.join(ctx.showRoot, ctx.episodesDir, episodeId, ARCHIVE_FILE);
  let text: string;
  try { text = await readFile(file, "utf8"); } catch { return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) {
    return { error: `${ARCHIVE_FILE}: not valid JSON — ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${ARCHIVE_FILE}: expected an object with a stage, not ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}` };
  }
  const { stage, note } = parsed as { stage?: unknown; note?: unknown };
  if (typeof stage !== "string") {
    return { error: `${ARCHIVE_FILE}: no stage — the marker needs {"stage": "COMPLETE", "note": "…"}` };
  }
  if (!isStage(stage)) return { error: `${ARCHIVE_FILE}: ${JSON.stringify(stage)} is not a stage` };
  if (note !== undefined && typeof note !== "string") {
    return { error: `${ARCHIVE_FILE}: the note must be a string, not ${JSON.stringify(note)}` };
  }
  const trimmed = note?.trim();
  return { marker: { stage, ...(trimmed !== undefined && trimmed !== "" ? { note: trimmed } : {}) } };
}

/** The row for an episode with no runs: a directory under `Episodes/` or `Production/` and
 *  nothing more. Its stage is what `deriveStage` makes of an empty run — IDEA when a premise
 *  exists, NEEDS_IDEA when one does not — and its status is "none", the one status that is not
 *  a state of a run but the absence of one.
 *
 *  **This is also the only place an `archive.json` marker is read**, which is the whole of the
 *  rule that a run is the truth: `RunStore.episodeRow` reaches this function only when the
 *  episode has no run logs at all, so no marker can mask a run that is waiting, failed, crashed
 *  or running. An episode with a valid marker is shown at the marker's stage with
 *  `status: "archived"`, the marker's note, and an empty `needs` — it was finished outside the
 *  engine and needs nothing, however little of a premise or a reference is on disk. A marker that
 *  cannot be read leaves the derived stage and status alone and reports itself in `logError`. */
export async function idleEpisodeRow(ctx: ShowContext, episodeId: string): Promise<EpisodeRow> {
  const { flags, detail } = await readNeeds(ctx, episodeId);
  const archive = await readArchiveMarker(ctx, episodeId);
  const row: EpisodeRow = {
    id: episodeId,
    title: await episodeTitle(ctx, episodeId),
    stage: deriveStage(deriveRunState([]), EPISODE_STAGE_MAP, flags),
    status: "none",
    needs: detail,
  };
  if (archive === undefined) return row;
  if ("error" in archive) {
    row.logError = archive.error;
    return row;
  }
  row.stage = archive.marker.stage;
  row.status = "archived";
  row.needs = { ideaMissing: false, refsMissing: [], imagesMissing: [] };
  if (archive.marker.note !== undefined) row.archiveNote = archive.marker.note;
  return row;
}

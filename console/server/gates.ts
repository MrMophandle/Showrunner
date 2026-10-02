import path from "node:path";
import { stat } from "node:fs/promises";
import {
  deriveRunState, describePipeline, episodePipeline, mixFilename, parseEpisodeId,
} from "@showrunner/engine";
import type { GateArtifact, GateView } from "../shared/types.js";
import type { RunStore } from "./runs.js";
import type { ShowContext } from "./show.js";

/** The gate view: what the showrunner is being asked, and the file the question is about.
 *
 *  A gate's message is prose the pipeline rendered, and prose alone is not a decision — "approve
 *  the outline" means nothing without the outline. So every one of the eight gates is mapped here
 *  to the artifacts it refers to, as urls the artifact route serves. The table is the only place
 *  in the console that knows which file a gate is about, and it is keyed on the gate's step id so
 *  a pipeline that renames a gate loses its artifacts loudly (an empty list) rather than silently
 *  showing the wrong file. */

/** Which `results` entries of a run are verdicts, and so belong in the gate view.
 *
 *  The test is structural — a result that is an object carrying a `pass` field — rather than a
 *  list of step ids. The verdict-shaped results of the episode pipeline are the six reviewers
 *  (`tone-check`, `flow-check`, `character-check`, `structure-check`, `environment-check`,
 *  `repetition-check`), the two canon reviews (`canon-review-outline`, `canon-review-script`) and
 *  the three image audits, every one of which is an agent step with a `schemaFile` whose schema
 *  has a `pass`. A hard-coded id list would be a second place to edit whenever a reviewer is
 *  added, and the one that nobody remembers: the gate view would then quietly stop showing the
 *  new reviewer's verdict. A gate's own answer payload (`{approved, waitedMs, attempt, …}`) and a
 *  guard's message string both fail this test, which is what keeps them out. */
function isVerdict(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "pass" in value;
}

/** A show-relative path as a url the artifact route serves. Each segment is encoded on its own,
 *  so a separator stays a separator and a space in a filename — the mix is
 *  `<Slug> S02E01.wav` — does not break the url. */
export function artifactUrl(episodeId: string, showRelative: string): string {
  const encoded = showRelative.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `/api/episodes/${encodeURIComponent(episodeId)}/files/${encoded}`;
}

/** Whether a path exists, used for the one artifact whose identity depends on the disk: the final
 *  gate shows the mastered video when mastering has run and the raw render when it has not. */
async function exists(absolute: string): Promise<boolean> {
  try { await stat(absolute); return true; } catch { return false; }
}

/** A file artifact: one url, no listing. */
function file(episodeId: string, kind: GateArtifact["kind"], showRelative: string, label?: string): GateArtifact {
  return { kind, label: label ?? path.posix.basename(showRelative), url: artifactUrl(episodeId, showRelative) };
}

/** A directory artifact: the same url twice, which is what marks it as a directory. See
 *  `GateArtifact` in `shared/types.ts` for why `listUrl` is not a different address. */
function dir(episodeId: string, kind: GateArtifact["kind"], showRelative: string, label: string): GateArtifact {
  const url = artifactUrl(episodeId, showRelative);
  return { kind, label, url, listUrl: url };
}

/** The artifacts one gate refers to, every path relative to the show root and under one of the
 *  episode's own two trees — `<episodesDir>/<id>/` or `<productionDir>/<id>/` — because those are
 *  the only two the artifact route serves.
 *
 *  `Canon/` is deliberately absent even from `canon-gate`, whose whole subject is a change to the
 *  shared canon: the reviewable form of that change is the patch the `canon-diff` step writes
 *  into the episode's production directory and the ledger row the pipeline writes into the
 *  episode's own directory, so the gate is fully answerable without the route ever handing out
 *  the show's shared canon tree. */
export async function gateArtifacts(ctx: ShowContext, episodeId: string, gateId: string): Promise<GateArtifact[]> {
  const ep = `${ctx.episodesDir}/${episodeId}`;
  const prod = `${ctx.productionDir}/${episodeId}`;
  switch (gateId) {
    case "outline-gate":
      return [file(episodeId, "markdown", `${ep}/outline.md`)];
    case "script-gate":
      return [file(episodeId, "markdown", `${ep}/script.md`)];
    case "casting-gate":
      return [
        file(episodeId, "json", `${prod}/tts-script.json`),
        dir(episodeId, "audio", `${prod}/guest-refs`, "guest-refs/"),
      ];
    case "audio-gate":
      return [file(episodeId, "audio", `${prod}/audio/${mixFilename(ctx.show, episodeId)}`)];
    case "nano-banana-gate":
      return [
        dir(episodeId, "images", `${prod}/images`, "images/"),
        file(episodeId, "markdown", `${prod}/images/IMAGE-SHEET.md`),
      ];
    case "image-gate":
      return [dir(episodeId, "images", `${prod}/images`, "images/")];
    case "final-gate": {
      const mastered = `${prod}/video/episode-mastered.mp4`;
      const rendered = `${prod}/video/${ctx.show.output.videoFilename ?? "episode.mp4"}`;
      const video = (await exists(path.join(ctx.showRoot, mastered))) ? mastered : rendered;
      return [file(episodeId, "video", video), file(episodeId, "json", `${ep}/publish.json`)];
    }
    case "canon-gate":
      return [
        file(episodeId, "diff", `${prod}/canon-diff.patch`),
        file(episodeId, "markdown", `${ep}/canon-ledger.md`),
      ];
    default:
      return [];
  }
}

/** The open gate of one run as the Gate page draws it, or undefined when no gate is open — which
 *  is every run that is working, finished or crashed, and is a 404 on the route.
 *
 *  The attempt comes from the log and is handed back to the client, which returns it as
 *  `expectedAttempt` on the answer: that round trip is what makes an answer written against a
 *  superseded message refusable rather than silently applied to a newer ask. */
export async function gateView(ctx: ShowContext, store: RunStore, episodeId: string, runId: string): Promise<GateView | undefined> {
  parseEpisodeId(episodeId);
  const { events } = await store.get(episodeId, runId);
  const state = deriveRunState(events);
  const gate = state.openGate;
  if (gate === undefined) return undefined;

  const verdicts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state.results)) if (isVerdict(value)) verdicts[key] = value;
  const rejected = state.results[`${gate.stepId}:rejections`];
  const rejections = Array.isArray(rejected) ? rejected.map((note) => String(note)) : [];

  // Built per episode, never cached: every step's paths are the episode's own. The description is
  // consulted for one field — the gate's attempt cap — which the operator needs to know how many
  // rejections are left before the gate gives up.
  const description = describePipeline(episodePipeline({ show: ctx.show, episodeId, engineRoot: ctx.engineRoot }));
  const maxAttempts = description.steps.find((s) => s.id === gate.stepId)?.maxAttempts;

  return {
    episodeId,
    runId,
    stepId: gate.stepId,
    attempt: gate.attempt,
    openedAt: gate.openedAt,
    message: gate.message,
    artifacts: await gateArtifacts(ctx, episodeId, gate.stepId),
    verdicts,
    rejections,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  };
}

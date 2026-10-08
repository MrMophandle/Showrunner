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
 *  showing the wrong file.
 *
 *  Every url carries the show key, because every api route lives under `/api/shows/:show/` and
 *  these urls are handed to the client complete. `artifactUrl` is the one builder, and it takes
 *  the key from the `ShowContext` this table is already given. */

/** Which `results` entries of a run are verdicts, and so belong in the gate view.
 *
 *  Two tests, both of them derived from the pipeline rather than from a list of step ids. The
 *  step must be an **agent step the pipeline description marks with a `schemaFile`** — which is
 *  what a verdict is: the parsed output of a schema whose shape the pipeline declared. And the
 *  result must be shaped like one, an object carrying a `pass` field, since a schema-bearing step
 *  whose log predates its schema would otherwise put an arbitrary result on the verdict board.
 *
 *  The verdict-shaped results of the episode pipeline are the six reviewers (`tone-check`,
 *  `flow-check`, `character-check`, `structure-check`, `environment-check`, `repetition-check`),
 *  the two canon reviews (`canon-review-outline`, `canon-review-script`) and the three image
 *  audits — every one of them an agent step with a `schemaFile`. A hard-coded id list would be a
 *  second place to edit whenever a reviewer is added, and the one nobody remembers: the gate view
 *  would quietly stop showing the new reviewer's verdict. The structural test alone was the other
 *  extreme: a guard whose `check` happens to return `{pass, message}` is not a verdict the
 *  showrunner is being asked to weigh, and neither is anything a future step returns that merely
 *  looks like one. A gate's own answer payload (`{approved, waitedMs, attempt, …}`) fails both. */
function isVerdict(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "pass" in value;
}

/** A show-relative path as a url the artifact route serves. Each segment is encoded on its own,
 *  so a separator stays a separator and a space in a filename — the mix is
 *  `<Slug> S02E01.wav` — does not break the url.
 *
 *  **The show key is built in here rather than prefixed by the client**, because this is the only
 *  function in the console that knows the artifact route's address and the route's shape has to
 *  live in exactly one place. A client that prefixed a server-given url would be a second
 *  declaration of that shape, and the gate view's urls are handed out already complete — the Gate
 *  page fetches them verbatim, with nothing of its own to add.
 *
 *  The parameters are in the url's own order (`shows/<key>/episodes/<id>/files/<path>`), so a call
 *  site reads as the address it produces. */
export function artifactUrl(showKey: string, episodeId: string, showRelative: string): string {
  const encoded = showRelative.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  return `/api/shows/${encodeURIComponent(showKey)}/episodes/${encodeURIComponent(episodeId)}/files/${encoded}`;
}

/** Whether a path exists, used for the one artifact whose identity depends on the disk: the final
 *  gate shows the mastered video when mastering has run and the raw render when it has not. */
async function exists(absolute: string): Promise<boolean> {
  try { await stat(absolute); return true; } catch { return false; }
}

/** A file artifact: one url, no listing. */
function file(showKey: string, episodeId: string, kind: GateArtifact["kind"], showRelative: string, label?: string): GateArtifact {
  return { kind, label: label ?? path.posix.basename(showRelative), url: artifactUrl(showKey, episodeId, showRelative) };
}

/** A directory artifact: the same url twice, which is what marks it as a directory. See
 *  `GateArtifact` in `shared/types.ts` for why `listUrl` is not a different address. */
function dir(showKey: string, episodeId: string, kind: GateArtifact["kind"], showRelative: string, label: string): GateArtifact {
  const url = artifactUrl(showKey, episodeId, showRelative);
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
      return [file(ctx.key, episodeId, "markdown", `${ep}/outline.md`)];
    case "script-gate":
      return [file(ctx.key, episodeId, "markdown", `${ep}/script.md`)];
    case "casting-gate":
      return [
        file(ctx.key, episodeId, "json", `${prod}/tts-script.json`),
        dir(ctx.key, episodeId, "audio", `${prod}/guest-refs`, "guest-refs/"),
      ];
    case "audio-gate":
      return [file(ctx.key, episodeId, "audio", `${prod}/audio/${mixFilename(ctx.show, episodeId)}`)];
    case "nano-banana-gate":
      return [
        dir(ctx.key, episodeId, "images", `${prod}/images`, "images/"),
        file(ctx.key, episodeId, "markdown", `${prod}/images/IMAGE-SHEET.md`),
      ];
    case "image-gate":
      return [dir(ctx.key, episodeId, "images", `${prod}/images`, "images/")];
    case "final-gate": {
      const mastered = `${prod}/video/episode-mastered.mp4`;
      const rendered = `${prod}/video/${ctx.show.output.videoFilename ?? "episode.mp4"}`;
      const video = (await exists(path.join(ctx.showRoot, mastered))) ? mastered : rendered;
      return [file(ctx.key, episodeId, "video", video), file(ctx.key, episodeId, "json", `${ep}/publish.json`)];
    }
    case "canon-gate":
      return [
        file(ctx.key, episodeId, "diff", `${prod}/canon-diff.patch`),
        file(ctx.key, episodeId, "markdown", `${ep}/canon-ledger.md`),
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

  // Built per episode, never cached: every step's paths are the episode's own. The description is
  // consulted for two things — the gate's attempt cap, which the operator needs to know how many
  // rejections are left before the gate gives up, and which steps are schema-bearing agent steps,
  // which is what makes a result a verdict.
  const description = describePipeline(episodePipeline({ show: ctx.show, episodeId, engineRoot: ctx.engineRoot }));
  const maxAttempts = description.steps.find((s) => s.id === gate.stepId)?.maxAttempts;
  const schemaBearing = new Set(
    description.steps.filter((s) => s.kind === "agent" && s.schemaFile !== undefined).map((s) => s.id),
  );

  const verdicts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state.results)) {
    if (schemaBearing.has(key) && isVerdict(value)) verdicts[key] = value;
  }
  const rejected = state.results[`${gate.stepId}:rejections`];
  const rejections = Array.isArray(rejected) ? rejected.map((note) => String(note)) : [];

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

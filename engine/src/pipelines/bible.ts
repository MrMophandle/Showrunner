import path from "node:path";
import type { BibleFile } from "../bible.js";
import { RESERVED_EPISODE_ID } from "../ids.js";
import type { NestedAgentStep, Pipeline, Step } from "../steps.js";

const MIN = 60_000;

/** The reserved id the interview runs under. It never matches the episode-id grammar, so
 *  `listEpisodeIds` never lists it and the console never shows it as an episode (Plan H may).
 *  It is the same string as `RESERVED_EPISODE_ID` by construction rather than by coincidence:
 *  `run` and the agent executor exempt that constant from episode-id validation, and a second
 *  spelling here would exempt one string while the interview ran under another. */
export const SETUP_ID = RESERVED_EPISODE_ID;

/** `<productionDir>/setup/<key>/runs` — one log directory per bible file, beside the answers.
 *  Absolute, because it is what the interview hands `new EventLog(...)`. The shape is the
 *  episode's own (`<productionDir>/<id>/runs`) with the bible file's key where the episode id
 *  would be, one level down from the reserved id, so one setup directory holds every file's
 *  record and nothing collides with an episode. `EventLog.logPath` cannot build it — that
 *  function validates the episode id and the reserved id is not one — so the caller joins the
 *  run id onto this directory itself. */
export function bibleLogDir(showRoot: string, key: string, productionDir = "Production"): string {
  return path.join(showRoot, productionDir, SETUP_ID, key, "runs");
}

/** `<productionDir>/setup/<key>/answers.md` — relative to the show root, because it is both the
 *  `write` step's declared input (inputs are hashed relative to the show root) and the path the
 *  prompt tells the agent to read. The answers sit beside the runs that were made from them, so
 *  the record of one interviewed file is one directory. */
export function answersPath(key: string, productionDir = "Production"): string {
  return `${productionDir}/${SETUP_ID}/${key}/answers.md`;
}

export interface BibleFilePipelineOptions {
  /** The bible file this pipeline makes: its key, its path and its mode (bible.ts). */
  entry: BibleFile;
  /** The values every step of this pipeline renders as `{{vars.<name>}}`: the file, its key, its
   *  purpose, the answers path, the canon template's absolute path and the interview's date. One
   *  object for all three steps, so `write.md`, `gate.md` and `revise.md` are written once and
   *  serve every bible file. */
  vars: Record<string, string>;
  /** The show's production directory, for the answers path. Defaults to `Production`. */
  productionDir?: string;
}

/** One bible file's pipeline: for an interviewed file, `write` (an agent that turns the author's
 *  answers into the file in the house format) then `gate`; for a default file, `gate` alone over
 *  the template `init` already wrote. The gate's fix agent revises the file against the notes
 *  and the gate reopens; `rerunOnReject` is empty because the fix agent is the whole repair.
 *  `vars` carries the file, its key, its purpose, the answers path, the template path and the
 *  date, so the three prompt files under tools/templates/interview/ serve every file. */
export function bibleFilePipeline(opts: BibleFilePipelineOptions): Pipeline {
  const { entry, vars } = opts;
  const answers = answersPath(entry.key, opts.productionDir);
  const revise: NestedAgentStep = {
    kind: "agent", id: "revise", promptFile: "revise.md", model: "writer", allowedTools: ["Read", "Edit", "Write"],
    context: "fresh", inputs: [entry.file], outputs: [entry.file], timeoutMs: 20 * MIN, vars,
  };
  const steps: Step[] = [];
  if (entry.mode === "interview") {
    steps.push({
      kind: "agent", id: "write", promptFile: "write.md", model: "writer", allowedTools: ["Read", "Write"],
      context: "fresh", inputs: [answers], outputs: [entry.file], timeoutMs: 20 * MIN, vars,
    });
  }
  steps.push({
    kind: "gate", id: "gate", ...(entry.mode === "interview" ? { dependsOn: ["write"] } : {}), messageFile: "gate.md",
    maxAttempts: 10, onReject: revise, rerunOnReject: [], vars,
  });
  return { name: `bible-${entry.key}`, steps };
}

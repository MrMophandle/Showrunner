import type { StageCatalogue } from './step.ts'

/**
 * The stage catalogue: the map from a persisted `run.stage` back to the TypeScript that
 * is the stage. A restarted process has a row saying `stage = 'produce-shot-images'` and
 * needs the function again; this file is that lookup, and it is the only thing it is.
 *
 * **Archon.** A stage is added here by writing TypeScript and a test — never by adding a
 * row, a YAML file, a JSON pipeline, or an upload. If this file ever grows a loader, a
 * schema, or a way to describe a stage in data, that is the failure mode this project
 * exists to escape, and it should be deleted rather than extended.
 *
 * It is empty on purpose. The real stages arrive with the work they do:
 *   E3 · write   — premise, outline, script, scene delineation
 *   E4 · canon   — checks, proposals, ratification sweeps
 *   E6 · produce — shot manifest, image generation, TTS takes, mix
 *   E7 · assemble — timeline, render, publish kit
 */
export const STAGES: StageCatalogue = {}

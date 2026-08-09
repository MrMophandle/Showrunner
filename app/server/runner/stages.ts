import { boardStages } from './board-step.ts'
import { scriptGateStages } from './script-gate-step.ts'
import type { StageCatalogue } from './step.ts'
import { textCheckStages } from './text-check-step.ts'
import { writeStages } from './write-step.ts'
import type { LibraryPaths } from '../library.ts'

/**
 * The stage catalogue: the map from a persisted `run.stage` back to the TypeScript that
 * is the stage. A restarted process has a row saying `stage = 'produce-shot-images'` and
 * needs the function again; this file is that lookup, and nothing else.
 *
 * **Archon.** A stage is added here by writing TypeScript and a test — never by adding a
 * row, a YAML file, a JSON pipeline, or an upload. If this file ever grows a loader, a
 * schema, or a way to describe a stage in data, that is the failure mode this project
 * exists to escape, and it should be deleted rather than extended. The one thing the
 * catalogue takes is the library volume, because steps write files into it and a stage
 * that reached for `process.env` instead could not be run against a temp volume in a test.
 *
 * The stages still to arrive, with the work they do:
 *   E4 · write   — the outline and script steps beside the premise, scene delineation
 *   E6 · produce — shot manifest, image generation, TTS takes, mix
 *   E7 · assemble — timeline, render, publish kit
 *
 * ── `demo` was retired here, and what that means ────────────────────────────────
 * E1 shipped one stage called `demo`: one small Opus call, one artifact, one gate, one
 * ledger row, so that Ryan had something to operate before there was anything real to run.
 * E4-1 replaced it with the premise stage and took it out of this file, because two writers
 * of a premise-brief side by side would make "which button?" ambiguous every time.
 *
 * **Retired means unoffered, never erased.** Rows are records: the demo runs, steps, gates,
 * rulings, cost entries and artifacts in Ryan's library are still there and still render —
 * a run whose stage this build has no code for is left alone by the runner (`advance`) and
 * read back by every surface that reads rows. What is gone is the offer. Nothing here, and
 * nothing anywhere else, may bring a stage back for a test's convenience: a stage that
 * exists only so tests have something cheap to run is a lie in the catalogue, and the tests
 * that leaned on `demo` run against the premise stage with the fake adapter instead.
 */
export function stageCatalogue(library: LibraryPaths): StageCatalogue {
  // E3-1's two, and the split between them is the point: `continuity-board` reads the
  // script with a model and costs money, `continuity-board-checks` re-runs the same
  // deterministic rules over the rows it wrote for nothing. Both are TypeScript in
  // `board-step.ts` — the catalogue is a lookup, never a place stages are described.
  //
  // `text-checks` is the semantic tier beside them, and it has no free half: a category
  // check is a reading, and every re-check is a call (`text-check-step.ts`). E3-4 grew it
  // into a PANEL — the categories, the arc positions and the craft reviewers convened as
  // one verdict board (4.5) — which changed what one run of the stage convenes and not what
  // the stage is. The deterministic rules stay on their own free stage above; the board
  // reads them where they stand rather than paying to re-run them.
  //
  // `script-gate` is E3-7's, and it is the only stage here that produces nothing at all: it
  // presents what stands for Ryan's ruling. It exists because the wall has three doors and
  // one of them is a gate (D12) — without a gate over the script there is no override to take
  // and the door is a route only a test can walk. E3-7's own note says E4 decides its fate;
  // E4-1 leaves it standing, because the gate it convenes is over the SCRIPT and the only
  // writing gate this build has is over the premise-brief. E4-3 is where that call is made.
  //
  // `write-the-premise` is E4-1's, and the first stage in this app that writes from canon:
  // the writer's desk (E4-0), one call, the panel over what came back, and Ryan's ruling —
  // which is also the only thing that moves an episode's lifecycle (`domain/lifecycle.ts`).
  return {
    ...writeStages(library),
    ...boardStages(library),
    ...textCheckStages(library),
    ...scriptGateStages(),
  }
}

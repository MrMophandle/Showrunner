import { boardStages } from './board-step.ts'
import { presentingStages } from './present-step.ts'
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
  // `premise-gate`, `outline-gate` and `script-gate` are the stages that produce nothing at
  // all: they present what stands for Ryan's ruling (`present-step.ts`). E3-7 built the third
  // one because the wall has three doors and one of them is a gate (D12), and left its fate to
  // E4. **E4-3 made the call: generalized, not retired** — a writing gate exists only while its
  // run does, and "rule on it at its gate" has to stay true for a script the fixture wrote, an
  // E7 import, or a re-ruling after a rewrite. `script-gate` keeps E3-7's name because rows are
  // records and there are runs under it. Two gates over one artifact is prevented by D7's
  // one-run-per-episode; two SCREENS over one artifact by the payload both doors compose from
  // the same function (`correction-loop.ts`).
  //
  // `write-the-premise`, `write-the-outline` and `write-the-script` are E4-1's, E4-2's and
  // E4-3's, and they are the same TypeScript three times (`write-step.ts`): the writer's desk
  // (E4-0), one call, the panel over what came back, and Ryan's ruling — which is also the only
  // thing that moves an episode's lifecycle (`domain/lifecycle.ts`). They differ in what the
  // model is asked for and, for the script alone, in the scenes its draft is delineated into
  // (D3) — and that is not machinery of its own either: `domain/delineate.ts` is the one
  // convention, and the fixture's loader reads ep01's scenes through it too.
  return {
    ...writeStages(library),
    ...boardStages(library),
    ...textCheckStages(library),
    ...presentingStages(),
  }
}

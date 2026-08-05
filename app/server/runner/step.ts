import type { Store } from '../db/store.ts'

/**
 * What a step IS (2.2): a TypeScript function that declares its inputs and outputs, is
 * idempotent, and records what it consumed.
 *
 * A step is an object with a `name`, an optional `lock`, a declared `inputs` list, and an
 * `execute` function. That is the whole vocabulary. There is no condition, no branch, no
 * loop, no `when`, no `retryPolicy`, no `onFailure` — the runner owns retry (bounded at
 * two, invariant 5) and Ryan owns every decision. If a step needs to decide something,
 * it decides in TypeScript, inside `execute`, where the decision is readable and testable.
 */

/**
 * The named locks (D7, amended by D20). A const array and a union type — never a TS
 * `enum`: the server runs its TypeScript under Node's type stripping, which only erases.
 *
 * - `gpu` — local image generation AND TTS. They must never run concurrently (the Metal
 *   corruption lesson: ep04's "helium gulp" pitch glitches, 2026-07-25).
 * - `image-api` — cloud image steps. Hold no GPU; expected to run alongside audio.
 */
export const LOCK_NAME = ['gpu', 'image-api'] as const
export type LockName = (typeof LOCK_NAME)[number]

/**
 * What a step is handed. It gets the store (so it persists through the one seam, like
 * everything else), the run it belongs to, and the outputs of the steps it declared it
 * consumes — asking for an undeclared one throws, because provenance that is optional
 * to declare is provenance nobody declares.
 */
export interface StepContext {
  readonly runId: string
  readonly episodeId: string
  readonly store: Store
  /** Which try this is, 1-based. A step that streams can say "attempt 2 of 3". */
  readonly attempt: number
  /** The output of an earlier step in this run. Must be named in this step's `inputs`. */
  input<T>(stepName: string): T
  /**
   * What this step is doing right now, in Ryan's words — "Shot 8 of 14 — scene 2, the
   * corridor". Appends a `step-progress` event.
   *
   * **Latest-wins.** The floor and the episode room render the most recent one and
   * discard what came before; every one is kept in the log, but only the last is on
   * screen. A step name alone cannot say this, which is why the method exists.
   */
  progress(text: string): void
  /**
   * A piece of live model output, for the italic line under the progress line — "streams,
   * not spinners" (2.3). Appends a `step-chunk` event.
   *
   * **Accumulating.** Chunks concatenate in order into one growing line, unlike
   * `progress`. Coalesce at the producer: E1-6's `LLMAdapter` calls this once per
   * sentence-ish piece, not once per token, because a sentence is what the line wants and
   * because the event log stores what it is handed rather than second-guessing it.
   */
  chunk(text: string): void
}

export interface Step<Out = unknown> {
  /** Stable across code changes — resume matches persisted rows to code by this name. */
  readonly name: string
  /**
   * The scarce resource this step takes for its whole execution, if any.
   *
   * **Singular on purpose.** One lock, held for exactly as long as the step runs, means
   * nothing ever holds a lock while waiting for another — so deadlock is impossible by
   * construction and the runner needs no detection for it. If this ever becomes a list,
   * that property dies the same day: acquire an ordering discipline or deadlock
   * detection before you make the change, not after.
   */
  readonly lock?: LockName
  /** Names of earlier steps in this stage whose output this step reads. */
  readonly inputs?: readonly string[]
  /** Idempotent: re-running it after a crash must be safe, because it will happen. */
  execute(context: StepContext): Promise<Out>
}

/**
 * A stage (write, produce, canon, assemble, season review) is an ordered list of steps.
 * Ordered, not a graph — the next step runs when the previous one is done, and that is
 * the only control flow there is.
 */
export interface Stage {
  readonly name: string
  readonly steps: readonly Step[]
}

/**
 * The map from a persisted `run.stage` back to code. A restart has a row saying
 * `stage = 'produce-shot-images'` and needs the function again; this is that lookup and
 * nothing more. It is a TypeScript object in a TypeScript file — adding a stage is a code
 * change with a test, never a row, a YAML file, or an upload.
 */
export type StageCatalogue = Readonly<Record<string, Stage>>

/**
 * Thrown by `pauseRun` to park a run on a decision. The runner catches it, persists the
 * step and run as paused, releases the lock, and stops — and the run resumes only when
 * something calls `resumeRun`.
 *
 * This is the seam E1-4 hangs gates off: a gate step creates (or finds) its gate, then
 * pauses; when Ryan rules, E1-4 resumes the run and the same step runs again, finds the
 * ruling, and returns. Which is why steps must be idempotent.
 */
export class RunPaused extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`run paused: ${reason}`)
    this.name = 'RunPaused'
    this.reason = reason
  }
}

/** Parks the run here, waiting on Ryan. Never returns. */
export function pauseRun(reason: string): never {
  throw new RunPaused(reason)
}

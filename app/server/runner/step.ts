import type { Store } from '../db/store.ts'
import type { Episode } from '../domain/spine.ts'
import type { BoundLLM } from '../llm/adapter.ts'
import type { GateDraft, GateStanding } from './gate.ts'

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
  /** This step's row. It is what a cost is charged to — the narrowest of 2.4's four levels. */
  readonly stepId: string
  readonly store: Store
  /** Which try this is, 1-based. A step that streams can say "attempt 2 of 3". */
  readonly attempt: number
  /**
   * Claude, already tied to this step (D6). What it streams goes to `chunk`; what it
   * costs lands on this step, this run, this episode, and this show before `complete`
   * returns.
   *
   * Bound rather than imported so that a step cannot make a call that streams nowhere or
   * bills nowhere — there is no unbound adapter in reach of a step, and the ledger is
   * therefore complete by construction rather than by everyone remembering.
   */
  readonly llm: BoundLLM
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
  /**
   * This step's gate as it stands, or undefined if it has never opened one — its rounds,
   * their rulings, and the notes on them.
   *
   * A step reads this on the way back IN. It is how a step that was resumed tells why:
   * `standing.ruling` is the latest round's verdict, so an approval (or an override) means
   * carry on, and a rejection means do the work again with `standing.ruling.notes` as
   * input and present the next round.
   */
  gate(): GateStanding | undefined
  /**
   * Present the artifact for Ryan's ruling and park the run. **Never returns.**
   *
   * It writes the gate (or re-presents into the round already open), appends `gate-opened`,
   * and then throws `RunPaused` — the same seam, the same catch site in the runner, one
   * pause protocol rather than two. A gate IS a run paused on a decision (2.2), so there is
   * deliberately no way to open one and keep working.
   *
   * Do not wrap this in a `try/catch`. `RunPaused` is an Error, and a `catch` around a
   * step's work — the most natural thing to write around an LLM call — will swallow the
   * pause and leave a gate open on a run that carried on without it. The runner checks for
   * exactly that after every step that returns normally, and fails the run loudly rather
   * than parking it quietly: a step that caught its own pause did not finish, so whatever
   * it returned is meaningless.
   */
  openGate(draft: GateDraft): never
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
 * **What a stage does with an episode's material** — and therefore whether D12's wall stands
 * in front of it.
 *
 * `produces` — it writes the next artifact FROM the material. A deterministic contradiction
 *   standing against that material is exactly the thing the next stage must not be built on,
 *   which is the whole of D12, and `launchBlockedBecause` refuses one while the wall is up.
 *
 * `reads` — it reads the material and records what it found: the check stages, and the gate
 *   stage that presents an artifact for Ryan's ruling. The wall never stands in front of one,
 *   and that is not an exemption — it is the wall's own sentence kept honest. It ends "fix it
 *   and re-run the checks — the deterministic ones cost nothing", and a wall that refused the
 *   button it just recommended would be a dead end built out of its own advice. The gate half
 *   is D12 read literally: deterministic findings block the next stage and **never Ryan's
 *   gate** (invariant 3), so a stage whose work is to present something for a ruling can no
 *   more be walled than the ruling can.
 *
 * A const array and a union type, never a TS `enum` — the server runs its TypeScript under
 * Node's type stripping, which only erases.
 */
export const STAGE_WORK = ['reads', 'produces'] as const
export type StageWork = (typeof STAGE_WORK)[number]

/**
 * **What a stage says about itself before it is run on one episode** (E3-7): the whole of the
 * button, declared where the stage is written.
 *
 * ## Why the stage declares this rather than the page composing it
 *
 * Until E3-1 every stage called a model, so `launchBlockedBecause` (operating.ts) refused
 * EVERY run when the adapter was unready — and the day a free stage arrived, that refusal
 * started lying: `continuity-board-checks` re-runs deterministic rules over rows and reaches
 * for nothing, and a process with no backend at all was told "Nothing to call" about a stage
 * that calls nothing. The fix could not be a list of exempt stage names, because such a list
 * is wrong the day a stage is added and nobody remembers it exists. So the stage says what it
 * spends, and the refusal consults the declaration.
 *
 * It carries the sentence and the cost as well as `callsModel`, because those are the same
 * fact asked three ways: "verb + object + scope + cost" is one declaration, and a stage that
 * declared its spend to the refusal while the page composed its cost line separately would be
 * two answers that can disagree. The page adds only what it owns — whether the button is
 * pressable, and why not (`operating.ts`'s `Offer`).
 *
 * **The Archon rule holds.** This is a TypeScript method on a TypeScript object; adding a
 * stage is still a code change with a test. It is not a description of a stage in data, and
 * nothing reads it to decide what to run.
 */
export interface StageOffer {
  /** Verb + object + scope, in one sentence. Never "Run", never "Go". */
  readonly sentence: string
  /**
   * What one run of it costs, in the same arithmetic the ledger will use afterwards — or
   * `FREE` (cost.ts) when it costs nothing. The page appends whose money it is and when.
   */
  readonly cost: string
  /**
   * Whether one run of it calls a model at all.
   *
   * False is a claim with teeth rather than a hint: a stage that declares zero spend runs, and
   * is drillable, on a process with no usable backend configured.
   */
  readonly callsModel: boolean
  /**
   * Why this stage has nothing to do on this episode, in words — an episode with no script to
   * check, a board that has never been built. Null when there is something to do.
   *
   * Stated here so it reaches the button before the click. Every step below still checks its
   * own preconditions and throws: "preconditions before the button" is a promise about
   * screens, and a step that trusted a screen to have kept it would be a step that fails
   * differently when the API is called directly.
   */
  readonly nothingToDoBecause: string | null
}

/**
 * A stage (write, produce, canon, assemble, season review) is an ordered list of steps.
 * Ordered, not a graph — the next step runs when the previous one is done, and that is
 * the only control flow there is.
 */
export interface Stage {
  readonly name: string
  /** What it does with the material, which is what decides whether the wall refuses it. */
  readonly work: StageWork
  readonly steps: readonly Step[]
  /**
   * What running it on this episode would say, cost, and need — read by the button and by the
   * refusal behind it, so the two cannot tell Ryan different stories.
   *
   * It takes the resolved episode rather than an id because every implementation needs the
   * label and the title, and resolving it once at the call site is what keeps "there is no
   * such episode" a question the page answers rather than one four stages each answer badly.
   */
  offerOn(store: Store, episode: Episode): StageOffer
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

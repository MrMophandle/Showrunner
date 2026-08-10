import { FREE } from '../cost.ts'
import type { Store } from '../db/store.ts'
import type { ArtifactKind } from '../domain/artifact.ts'
import { episodeInShow, episodeLabel, type EpisodeInShow } from '../domain/spine.ts'
import { WRITE_STEP, producedBy, type WriteStep } from '../domain/write-context.ts'
import { draftsUnderReview, type CorrectionReport } from './correction-loop.ts'
import type { Stage, StageCatalogue, StageOffer, Step, StepContext } from './step.ts'
import { artifactOf, noArtifactBecause } from './text-check-step.ts'

/**
 * **Presenting a written artifact for Ryan's ruling** (4.6, D15) — the stage that produces
 * nothing, generalized in E4-3 from E3-7's `script-gate`.
 *
 * ## Why it exists: the wall has three doors and one of them is a gate
 *
 * D12's wall comes down three ways (`stage-wall.ts`): Ryan overrides at a gate, he puts the
 * finding down with a note, or a rewrite lands and the free tier re-reads the new draft. E3-5
 * built the second and third as buttons behind a finding. The first needs **a gate over the
 * artifact the finding is anchored in** — `overriddenThrough` is asked per artifact, so an
 * override at some other gate is not an override of anything standing on the script — and
 * until E3-7 there was no such gate anywhere in the app.
 *
 * So: one stage per written kind, one step, no producer, no model call. It reads what stands,
 * presents the artifact with its drafts and its board under it, and parks on Ryan.
 *
 * ## The collision E3-7 left for E4, and how it is resolved (E4-3, #63/#66)
 *
 * The moment E4's writing line opened a gate over the script, there were two stages able to put
 * one artifact in front of Ryan — the correction loop's gate and this one — which is the state
 * the E3 constraints ledger forbids. **The affordance is kept and generalized rather than
 * retired**, and the argument is that retiring it makes two sentences this app already says
 * into lies: `write-step.ts` refuses a stage on an episode that has one of these already with
 * "rule on it at its gate, or edit it directly", and there IS no gate for an artifact whose
 * writing run is long gone — the fixture's hand-written ep01 script, an E7 import, a re-ruling
 * after a rewrite. Retiring it would also take away the only reachable override door on ep01,
 * which is what the E3 drill operates.
 *
 * Two gates over one artifact are prevented by two different things, and both are load-bearing:
 *
 *   * **Never at once.** A gate belongs to a STEP (`gate.ts`), so these are genuinely different
 *     gates — and D7's one-run-per-episode is what stops both being open: `launchBlockedBecause`
 *     refuses every stage on an episode whose run is queued, running or paused, with the same
 *     string the API refuses with. While a writing run waits at its gate, this stage cannot be
 *     started; while this one waits, the writing stage cannot.
 *   * **Never two screens.** The payload is `DraftsUnderReview`, composed by the same function
 *     the correction loop composes its own from (`correction-loop.ts`) — every draft that has
 *     been read, the verdict board over the current one, and the deterministic findings
 *     standing on it. Only the SENTENCE differs, because only the sentence is about why this
 *     particular gate opened. That is what "one artifact, one ruling" means at the payload
 *     layer, and it is why this file composes no shape of its own.
 *
 * ## Nothing may block it, and the declaration is where that is said
 *
 * `work: 'reads'`, which is D12 read literally: deterministic findings block the next stage and
 * **never Ryan's gate** (invariant 3). A stage whose whole work is convening a ruling can no
 * more be walled than the ruling itself can, and the wall standing in front of the one door
 * that takes it down would be a check vetoing him by the longest available route.
 *
 * The three verbs still take no preconditions of their own (`gate.ts`). What this step decides
 * is when to present, never whether he may rule.
 */

/**
 * The stage names, as they are persisted on `run.stage` and as the API takes them.
 *
 * `script-gate` keeps the name E3-7 gave it, and that is deliberate rather than tidy: rows are
 * records, there are `script-gate` runs in Ryan's library from the E3 drill, and a run whose
 * stage this build has no code for holds its episode forever (`stages.ts`, E4-1's note).
 * Renaming it to match its two new siblings would retire a stage that is still parked on a
 * decision.
 */
export const PREMISE_GATE_STAGE = 'premise-gate'
export const OUTLINE_GATE_STAGE = 'outline-gate'
export const SCRIPT_GATE_STAGE = 'script-gate'

/** The presenting stage for each step of the writing line — one door per written kind. */
export const PRESENTING_STAGE: Record<WriteStep, string> = {
  premise: PREMISE_GATE_STAGE,
  outline: OUTLINE_GATE_STAGE,
  script: SCRIPT_GATE_STAGE,
}

/** What the step returns once a ruling has sent the run onward. */
export interface Presentation {
  artifactId: string
  /** The version that was under review when he ruled. */
  version: number
  round: number
  /** 'approve' or 'override' — a rejection re-presents rather than returning. */
  verdict: 'approve' | 'override'
  /** How many deterministic findings his override was standing over. 0 on a plain approval. */
  stoodOver: number
  sentence: string
}

/**
 * They take no library volume, unlike every other stage in the catalogue, and that is the
 * declaration rather than an oversight: these stages write no file. The gate renders the
 * artifact off the volume (`operating.ts` reads it), and nothing here opens one.
 */
export function presentingStages(): StageCatalogue {
  return Object.fromEntries(
    WRITE_STEP.map((step) => [PRESENTING_STAGE[step], presentingStage(step)]),
  )
}

function presentingStage(step: WriteStep): Stage {
  const kind = producedBy(step)
  return {
    name: PRESENTING_STAGE[step],
    work: 'reads',
    steps: [presentForYourRuling(kind)],
    offerOn: (store, episode): StageOffer => {
      const label = episodeLabel(episode.number)
      const artifact = artifactOf(store, episode.id, kind)
      if (!artifact) {
        return {
          sentence: `Present the ${label} ${kind} for your ruling`,
          cost: FREE,
          callsModel: false,
          nothingToDoBecause: noArtifactBecause(label, kind),
        }
      }

      const standing = draftsUnderReview(store, artifact.id).blocking.length
      return {
        sentence:
          `Present the ${label} ${kind} v${artifact.version} for your ruling — ` +
          (standing === 0
            ? 'what the panel found is under it, and nothing deterministic stands'
            : `${standing} deterministic finding${standing === 1 ? '' : 's'} stand${
                standing === 1 ? 's' : ''
              } on it, and approving over ${standing === 1 ? 'it' : 'them'} is recorded as ` +
              'your override'),
        // It reads rows and opens a decision. There is nothing here to call and nothing to
        // bill, which is why it is drillable on a process with no backend at all.
        cost: FREE,
        callsModel: false,
        nothingToDoBecause: null,
      }
    },
  }
}

/**
 * Presents what is on the volume, with its drafts and its board under it, and parks.
 *
 * A gate belongs to the step that produced its artifact (`gate.ts`) and this step produced
 * nothing — which changes nothing about the mechanism and is worth saying once: the gate is
 * this STEP's, a ruling sends the run back into it, and a rejection re-presents the same draft
 * as the next round with his notes recorded against it. There is no writer on this run to route
 * a note to, and the note landing and riding is what D21 asks: reject is routed, not rewound,
 * and nothing regenerates until the routing lands somewhere that can act — which for a written
 * artifact is now the writing stage's own gate, or E4-5's direct edit.
 */
export function presentForYourRuling(kind: ArtifactKind): Step<Presentation> {
  return {
    name: `present-the-${kind}-for-your-ruling`,

    async execute(context: StepContext): Promise<Presentation> {
      const where = requireEpisode(context.store, context.episodeId)
      const label = episodeLabel(where.episode.number)
      const artifact = artifactOf(context.store, context.episodeId, kind)
      if (!artifact) throw new Error(noArtifactBecause(label, kind))

      const standing = context.gate()
      const ruled = standing?.ruling

      // ── Back in on a ruling ──────────────────────────────────────────────────
      // Approved, or approved OVER something. Either way the decision is made and the run
      // carries on; what he stood over is counted here rather than re-derived later, because
      // by the time anything reads this the override has already taken the wall down.
      if (ruled && ruled.verdict !== 'reject') {
        const stoodOver = draftsUnderReview(context.store, artifact.id).blocking.length
        const sentence =
          ruled.verdict === 'override'
            ? `Overridden at round ${standing!.round} — recorded as an override, and the next ` +
              'stage is no longer refused on the findings you ruled over'
            : `Approved at round ${standing!.round}`
        context.progress(sentence)
        return {
          artifactId: artifact.id,
          version: artifact.version,
          round: standing!.round,
          verdict: ruled.verdict,
          stoodOver,
          sentence,
        }
      }

      const round = ruled ? standing!.round + 1 : (standing?.round ?? 1)
      const under = draftsUnderReview(context.store, artifact.id)
      const sentence =
        `Presenting the ${label} ${kind} v${artifact.version} for your ruling — round ${round}. ` +
        `${under.board.sentence}` +
        (under.blocking.length === 0
          ? ''
          : ` ${under.blocking.length} of them block the next stage and none of them blocks ` +
            'this gate (D12): approving over one is recorded as your override.')

      context.progress(sentence)
      // The same shape the correction loop's gate carries over the same artifact, and its own
      // sentence — nothing here is written twice (`correction-loop.ts`, `DraftsUnderReview`).
      const payload: CorrectionReport = { ...under, sentence }
      context.openGate({ artifactId: artifact.id, payload, reason: sentence })
    },
  }
}

function requireEpisode(store: Store, episodeId: string): EpisodeInShow {
  const where = episodeInShow(store, episodeId)
  if (!where) throw new Error(`no such episode: ${episodeId}`)
  return where
}

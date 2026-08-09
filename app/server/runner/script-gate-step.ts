import { FREE } from '../cost.ts'
import type { Store } from '../db/store.ts'
import type { ArtifactKind } from '../domain/artifact.ts'
import { verdictBoard, type VerdictBoard } from '../domain/panel.ts'
import { episodeInShow, episodeLabel, type EpisodeInShow } from '../domain/spine.ts'
import { artifactOf, noArtifactBecause } from './text-check-step.ts'
import type { Stage, StageCatalogue, StageOffer, Step, StepContext } from './step.ts'
import { stageBlockingFindings } from './stage-wall.ts'

/**
 * **Presenting the script for Ryan's ruling** (4.6, D15) — the stage that produces nothing.
 *
 * ## Why it exists: the wall has three doors and one of them is a gate
 *
 * D12's wall comes down three ways (`stage-wall.ts`): Ryan overrides at a gate, he puts the
 * finding down with a note, or a rewrite lands and the free tier re-reads the new draft.
 * E3-5 built the second and third as buttons behind a finding. The first needs **a gate over
 * the artifact the finding is anchored in** — `overriddenThrough` is asked per artifact, so an
 * override at the demo's premise gate is not an override of anything standing on the script —
 * and until this stage there was no such gate anywhere in the app. The door existed as a route
 * only a test could walk, which is the exact shape of thing this epic's operated exit is for.
 *
 * So: one stage, one step, no producer, no model call. It reads what stands, presents the
 * script with the verdict board under it, and parks on Ryan.
 *
 * ## It is not the correction loop, and it is not E4's script gate
 *
 * `correction-loop.ts` composes produce → check → correct → gate, and E4 wires it when there
 * is a writer to correct. This is the standing half of that with nothing to produce: what is
 * on the volume, presented as it is. When E4's writing line lands, the loop's gate is the one
 * the script arrives at and this stage is what stays for ruling on a draft nobody is rewriting
 * — a hand-made script, an import, a re-ruling after a rewrite.
 *
 * ## Nothing may block it, and the declaration is where that is said
 *
 * `work: 'reads'`, which is D12 read literally: deterministic findings block the next stage
 * and **never Ryan's gate** (invariant 3). A stage whose whole work is convening a ruling can
 * no more be walled than the ruling itself can, and the wall standing in front of the one
 * door that takes it down would be a check vetoing him by the longest available route.
 *
 * The three verbs still take no preconditions of their own (`gate.ts`). What this step decides
 * is when to present, never whether he may rule.
 */

/** The stage name, as it is persisted on `run.stage` and as the API takes it. */
export const SCRIPT_GATE_STAGE = 'script-gate'

/** The artifact kind it presents. A sibling for the outline is this file with a kind and a test. */
export const SCRIPT_GATE_KIND: ArtifactKind = 'script'

/** What the step returns once a ruling has sent the run onward. */
export interface ScriptRuling {
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
 * It takes no library volume, unlike every other stage in the catalogue, and that is the
 * declaration rather than an oversight: this stage writes no file. The gate renders the
 * artifact off the volume (`operating.ts` reads it), and nothing here opens one.
 */
export function scriptGateStages(): StageCatalogue {
  return { [SCRIPT_GATE_STAGE]: scriptGateStage() }
}

function scriptGateStage(): Stage {
  return {
    name: SCRIPT_GATE_STAGE,
    work: 'reads',
    steps: [presentTheScriptForRuling(SCRIPT_GATE_KIND)],
    offerOn: (store, episode): StageOffer => {
      const label = episodeLabel(episode.number)
      const artifact = artifactOf(store, episode.id, SCRIPT_GATE_KIND)
      if (!artifact) {
        return {
          sentence: `Present the ${label} ${SCRIPT_GATE_KIND} for your ruling`,
          cost: FREE,
          callsModel: false,
          nothingToDoBecause: noArtifactBecause(label, SCRIPT_GATE_KIND),
        }
      }

      const standing = stageBlockingFindings(store, episode.id).length
      return {
        sentence:
          `Present the ${label} ${SCRIPT_GATE_KIND} v${artifact.version} for your ruling — ` +
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
 * Presents what is on the volume, with the verdict board under it, and parks.
 *
 * A gate belongs to the step that produced its artifact (`gate.ts`) and this step produced
 * nothing — which changes nothing about the mechanism and is worth saying once: the gate is
 * this STEP's, a ruling sends the run back into it, and a rejection re-presents the same draft
 * as the next round with his notes recorded against it. There is no writer to route a note to
 * yet (E4), and the note landing and riding is what D21 asks of this build: reject is routed,
 * not rewound, and nothing regenerates until the routing lands somewhere that can act.
 */
export function presentTheScriptForRuling(kind: ArtifactKind): Step<ScriptRuling> {
  return {
    name: `present-the-${kind}-for-your-ruling`,

    async execute(context: StepContext): Promise<ScriptRuling> {
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
        const stoodOver = stageBlockingFindings(context.store, context.episodeId).length
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
      const board = verdictBoard(context.store, artifact)
      const blocking = stageBlockingFindings(context.store, context.episodeId)

      context.progress(
        `Presenting the ${label} ${kind} v${artifact.version} for your ruling — round ${round}. ` +
          `${board.sentence}` +
          (blocking.length === 0
            ? ''
            : ` ${blocking.length} of them block the next stage and none of them blocks this ` +
              'gate (D12): approving over one is recorded as your override.'),
      )

      context.openGate({
        artifactId: artifact.id,
        payload: {
          round,
          board: boardPayload(board),
          // A SNAPSHOT, and allowed to be one for `panel.ts`'s reason: it is the record of
          // what he was shown at this round, like `gate_round.artifact_version`, and the live
          // answer can always be recomputed and compared against it.
          blocking: blocking.map((block) => ({
            findingId: block.finding.id,
            checkKey: block.finding.checkKey,
            scene: block.scene,
            concern: block.finding.concern,
          })),
        },
      })
    },
  }
}

/** The board as the round records it — rows and the sentence above them, nothing computed. */
function boardPayload(board: VerdictBoard): Pick<VerdictBoard, 'version' | 'sentence'> & {
  rows: { checkKey: string; verdict: string; what: string }[]
} {
  return {
    version: board.version,
    sentence: board.sentence,
    rows: board.rows.map((row) => ({
      checkKey: row.checkKey,
      verdict: row.verdict,
      what: row.what,
    })),
  }
}

function requireEpisode(store: Store, episodeId: string): EpisodeInShow {
  const where = episodeInShow(store, episodeId)
  if (!where) throw new Error(`no such episode: ${episodeId}`)
  return where
}

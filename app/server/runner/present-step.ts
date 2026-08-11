import { FREE } from '../cost.ts'
import type { Store } from '../db/store.ts'
import type { Artifact, ArtifactKind } from '../domain/artifact.ts'
import { advanceOnPresentedApproval, stayedAt, type LifecycleMove } from '../domain/lifecycle.ts'
import { landsOn } from '../domain/routing.ts'
import { episodeInShow, episodeLabel, type EpisodeInShow } from '../domain/spine.ts'
import { WRITE_STEP, producedBy, type WriteStep } from '../domain/write-context.ts'
import { draftsUnderReview, type CorrectionReport } from './correction-loop.ts'
import { carriesTheRunOn } from './gate.ts'
import type { Stage, StageCatalogue, StageOffer, Step, StepContext } from './step.ts'
import { noArtifactBecause } from './text-check-step.ts'
import { writtenOfKind } from './write-step.ts'

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
 * ## And it moves the episode on, which is issue #76 (E4-7)
 *
 * **A ruling is a ruling, whichever door convened it.** This stage opens a real gate over a
 * real artifact and takes a real verdict, so approving here is the approval of that stage's
 * work and it carries the lifecycle seam the writing stage's own gate carries — the same
 * function, `advanceOnPresentedApproval` (`domain/lifecycle.ts`), where the one extra test
 * this door owes is argued: **the episode has to be standing AT the stage that produces what
 * he ruled on.** Every other gate in this app got that test before the click, from a stage
 * that refuses an episode it has not reached; this one is free, never walled, and renders
 * whatever is on the volume, so it makes the test for itself.
 *
 * Two things follow, and they are the whole of what changed:
 *
 *   * **A script approved here has had no extraction run.** E4-4's paid reading is a step of
 *     the WRITING run; the claims of a script ruled at this door are unraised and Ryan is told
 *     so in the sentence, with the bench as their door (#39) — `edit.ts`'s recorded choice,
 *     reached by a second route (`unextractedNote` below).
 *   * **Nothing is retroactive.** This runs when a ruling lands and never when one is read
 *     back: the E1-era approvals sitting in Ryan's library move nothing, and an episode holding
 *     a pre-E4 artifact leaves its stop when he rules again at this door, not because two old
 *     rulings were replayed. The record is never the state (2.3).
 *
 * ## Nothing may block it, and the declaration is where that is said
 *
 * `work: 'reads'`, which is D12 read literally: deterministic findings block the next stage and
 * **never Ryan's gate** (invariant 3). A stage whose whole work is convening a ruling can no
 * more be walled than the ruling itself can, and the wall standing in front of the one door
 * that takes it down would be a check vetoing him by the longest available route.
 *
 * The verbs still take no preconditions of their own (`gate.ts`). What this step decides is
 * when to present, never whether he may rule.
 *
 * ## The one exit it did not have, and now does (E5-3, #83)
 *
 * The E4 ledger inherited this to E5 as a decision rather than a discovery: **"A presenting
 * gate has one exit, and it is approve."** Everything above is why — no producer, so a
 * rejection about the presented draft re-presents the same file, and D7 holds the episode
 * while the gate stands open, so the rewrite the note asked for cannot happen until Ryan
 * approves the draft he rejected.
 *
 * `close` is the answer, and it is a ruling about what the ledger's verbs mean rather than a
 * special case here (0015, `gate.ts`). What this file owes it is four lines: on a close, end.
 * The draft is unchanged, the lifecycle is unchanged, the findings are unchanged, and the note
 * stands where every other note stands.
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
  /**
   * How the round that closed it was ruled. A rejection whose notes are about THIS draft
   * re-presents rather than returning; `reject` is E4-5's — every note was routed to another
   * artifact, so the run ends and nothing is re-presented (D21). `close` is E5-3's: he put the
   * draft down, and that ends the run whatever the notes name.
   */
  verdict: 'approve' | 'override' | 'reject' | 'close'
  /** How many deterministic findings his override was standing over. 0 on a plain approval. */
  stoodOver: number
  /**
   * Where the ruling left the episode, and why (#76, `domain/lifecycle.ts`). The same shape the
   * writing stage's closing step carries, because it is the same seam.
   */
  lifecycle: LifecycleMove
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
    steps: [presentForYourRuling(step)],
    offerOn: (store, episode): StageOffer => {
      const label = episodeLabel(episode.number)
      const artifact = presentable(store, episode.id, kind)
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
export function presentForYourRuling(step: WriteStep): Step<Presentation> {
  const kind = producedBy(step)
  return {
    name: `present-the-${kind}-for-your-ruling`,

    async execute(context: StepContext): Promise<Presentation> {
      const where = requireEpisode(context.store, context.episodeId)
      const label = episodeLabel(where.episode.number)
      const artifact = presentable(context.store, context.episodeId, kind)
      if (!artifact) throw new Error(noArtifactBecause(label, kind))

      const standing = context.gate()
      const ruled = standing?.ruling

      // ── Back in on a ruling ──────────────────────────────────────────────────
      // Approved, or approved OVER something. Either way the decision is made and the run
      // carries on; what he stood over is counted here rather than re-derived later, because
      // by the time anything reads this the override has already taken the wall down.
      //
      // **And the episode moves on** (#76): a ruling is a ruling whichever door convened it,
      // so this carries the lifecycle seam the writing stage's own gate carries, through the
      // same function. The one test this door owes for itself — that the episode is standing
      // AT the stage that produces what he ruled on — is `advanceOnPresentedApproval`'s, where
      // it is argued (`domain/lifecycle.ts`).
      //
      // **Asked as "did it carry the run on"** (E5-3): with a fourth verb in the ledger, the
      // negative form would let a close fall through into the approval arm and advance the
      // lifecycle on a draft Ryan had just put down. `carriesTheRunOn` names the two that do.
      if (ruled && carriesTheRunOn(ruled.verdict)) {
        const stoodOver = draftsUnderReview(context.store, artifact.id).blocking.length
        const lifecycle = advanceOnPresentedApproval(context.store, context.episodeId, step)
        const sentence =
          (ruled.verdict === 'override'
            ? `Overridden at round ${standing!.round} — recorded as an override, and the next ` +
              'stage is no longer refused on the findings you ruled over'
            : `Approved at round ${standing!.round}`) +
          ` · ${lifecycle.sentence}${unextractedNote(step)}`
        context.progress(sentence)
        return {
          artifactId: artifact.id,
          version: artifact.version,
          round: standing!.round,
          verdict: ruled.verdict,
          stoodOver,
          lifecycle,
          sentence,
        }
      }

      // ── Back in on a close: the exit this gate did not have (E5-3, #83) ──────
      //
      // The E4 ledger recorded the gap by name: **"A presenting gate has one exit, and it is
      // approve."** There is no producer here, so a rejection about the draft in front of him
      // re-presents the same bytes — and D7 holds the episode while this gate is open, so the
      // rewrite the note asked for cannot happen until he approves the thing he just rejected.
      // Round 2 of this gate can never show him anything round 1 did not.
      //
      // So this is the exit, and it is the smallest one there is: return. The run ends, the
      // episode is free, the draft is byte for byte as he ruled on it, and the note stands
      // against it — which reopens the stage that writes it with his words quoted on the
      // button (`domain/routing.ts`, `runner/write-step.ts`). Nothing regenerates until he
      // clicks, which is D21 arriving at the one gate that had no way to say it.
      if (ruled?.verdict === 'close') {
        const sentence =
          `Put down at round ${standing!.round} — the ${label} ${kind} is exactly as you ruled ` +
          `on it, ${label} is free, and your ${ruled.notes.length === 1 ? 'note stands' : 'notes stand'} ` +
          'against it until something answers. Nothing regenerates until you ask for it (D21).'
        context.progress(sentence)
        return {
          artifactId: artifact.id,
          version: artifact.version,
          round: standing!.round,
          verdict: 'close',
          stoodOver: 0,
          // Putting a draft down is not an approval, so it moves nothing — said through the
          // verb that says where the episode stayed, exactly as E4-5's rejection is.
          lifecycle: stayedAt(context.store, context.episodeId, sentence),
          sentence,
        }
      }

      // ── Back in on a rejection routed to another artifact (E4-5, D21) ────────
      // There is no producer behind this gate, so a rejection has always re-presented the same
      // draft as the next round — right for a note about THIS draft, wrong for one Ryan sent
      // somewhere else. Re-presenting a script he has just routed back to the outline would
      // park his episode on a decision he has already made, and the work he asked for is
      // behind a different stage's button. So the run ends and the note stands where it was
      // addressed (`domain/routing.ts`).
      const landsHere = ruled?.notes.some((note) => landsOn(note, artifact.id)) ?? false
      if (ruled && ruled.verdict === 'reject' && !landsHere) {
        const sentence =
          `Rejected at round ${standing!.round}, and every note was routed elsewhere — the ` +
          `${label} ${kind} is exactly as you ruled on it, and nothing regenerates until you ` +
          'ask for it (D21).'
        context.progress(sentence)
        return {
          artifactId: artifact.id,
          version: artifact.version,
          round: standing!.round,
          verdict: 'reject',
          stoodOver: 0,
          // A rejection is not an approval, so it is said through the verb that moves nothing
          // rather than passed through the one that advances on approvals (E4-5's rule,
          // `domain/lifecycle.ts`).
          lifecycle: stayedAt(context.store, context.episodeId, sentence),
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

/**
 * **What a script approved at THIS door did not buy** (#76, corollary 1) — said out loud,
 * every time, because a silence that reads as "nothing to raise" is invariant 4 broken one
 * layer out from the checks.
 *
 * `extractTheCanonClaims` is a step of the WRITING run and there is no such step here: the
 * click that bought the writing run is what pays for the reading past its gate (E4-4,
 * `claim-step.ts`), and this stage's whole promise is that it costs nothing (`FREE`, above).
 * Spending a model call on the far side of a ruling nobody was told about would break that
 * promise silently, which is the one way to break it that Ryan cannot see.
 *
 * So the claims of a script ruled here are unraised, and the door for them is the bench's
 * add-a-fact (#39) — the same choice `edit.ts` recorded for his own hand and for the same
 * reason. E4-6's sweep collects whatever is riding the episode either way.
 */
const unextractedNote = (step: WriteStep): string =>
  step === 'script'
    ? ' · No claims were read out of it — this door runs no extraction, and what the script ' +
      'claims of canon is yours to raise at the bench (#39).'
    : ''

/**
 * The artifact this stage would put in front of Ryan — **whatever slot it sits in.**
 *
 * The checks' `artifactOf` asks the narrower question (the singular slot the producer owns),
 * and that is right for a check: it reads the draft a writer wrote. This stage's question is
 * the one the WRITING stage's refusal asks — "is there one of these to rule on" — and the two
 * have to be the same question, because that refusal promises this gate ("rule on it at its
 * gate, or edit it directly"). ep02's demo-era premise-brief in Ryan's own library is the case
 * that makes the difference real: written into slot `demo` by a stage E4-1 retired, refused by
 * the writing stage naming its slot, and unopenable here until E4-5 asked the wider question.
 *
 * A recorded artifact nobody has produced still has nothing to present, and that is unchanged.
 */
function presentable(store: Store, episodeId: string, kind: ArtifactKind): Artifact | undefined {
  const artifact = writtenOfKind(store, episodeId, kind)
  return artifact?.filePath ? artifact : undefined
}

function requireEpisode(store: Store, episodeId: string): EpisodeInShow {
  const where = episodeInShow(store, episodeId)
  if (!where) throw new Error(`no such episode: ${episodeId}`)
  return where
}

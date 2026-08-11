import type { Store } from '../db/store.ts'
import { findArtifact, revisionsOf, type Artifact } from '../domain/artifact.ts'
import {
  checkPassesOf,
  findingsIn,
  gapsOfPass,
  type CheckGapReason,
  type CheckTier,
  type Finding,
  type FindingConfidence,
  type FindingSeverity,
} from '../domain/finding.ts'
import { verdictBoard, type VerdictBoard } from '../domain/panel.ts'
import { landsOn, notesOwedBy } from '../domain/routing.ts'
import { episodeLabel, findEpisode, scenesOf } from '../domain/spine.ts'
import { carriesTheRunOn, type GateNote, type GateRound } from './gate.ts'
import { stageBlockingFindings } from './stage-wall.ts'
import type { Step, StepContext } from './step.ts'

/**
 * The correction loop (4.4): **produce → check → correct, then Ryan.**
 *
 * A stage that writes something composes a producer with a check, and this is that
 * composition: write a draft, run the tier over it, and if the tier has something to say,
 * write it again with what the tier said. Bounded at three drafts — invariant 5's number,
 * spent on corrections — with every draft and every reading kept, and whatever the loop ends
 * on presented at a gate with the whole history under it.
 *
 * It is a STEP, not a new runner primitive. The runner's only control flow is still "run the
 * stage's steps in array order" and it gained nothing to build this; the loop decides what it
 * decides in TypeScript, inside `execute`, where it is readable and has a test (runner.ts,
 * "What it is not"). There is no retry policy here, no `onFailure`, no configurable rounds.
 *
 * ## The two loops, and why they are never one counter
 *
 * `MAX_ATTEMPTS_PER_STEP` (runner.ts) bounds a step that is FAILING: a broken reply, a dead
 * adapter, a 429. Nothing was produced, nothing was judged, and re-running is re-running the
 * SAME work. `MAX_CORRECTION_ROUNDS` bounds a step that is WORKING: it produced something,
 * a check read it and disagreed, and re-running is re-running with NEW INFORMATION.
 *
 * They are the same number today and they are deliberately not the same constant.
 * `handoff/docs/README.md` ("Transport retry is not correction retry") says what happens when
 * the day comes that rate limits bite: a bounded transport retry in the runner, counted
 * separately — **not** a raised correction bound. One constant would make that a change to
 * both, which is exactly the collapse the note is warning about.
 *
 * The loop therefore spends no attempts of its own. A tier that throws mid-loop throws out of
 * this step, the runner records a failed attempt and re-runs the step, and the loop rebuilds
 * its state from rows — so the round it was in is the round it resumes, and the count is
 * untouched. That is also why every decision below is a fresh read rather than a variable
 * carried across an await: a crash between a draft and its reading is the same case.
 *
 * ## Where the rounds are remembered: nowhere
 *
 * There is no round column. A round IS a version of the artifact that a check has read, and
 * the rounds are computed from `check_pass` rows every time they are asked for — the
 * freshness pattern (1.3), one more time. The consequences are all the good kind: a resumed
 * step knows what it did, a re-check that has already been paid for is not paid for twice,
 * and the gate payload cannot disagree with the ledger it is composed from.
 *
 * **That predicate is why the check step is tier-atomic** (`text-check-step.ts`'s ruling).
 * "Has this draft been read" is answered by "a pass exists at this version", and a panel that
 * recorded some of its reviewers before failing would make it answer yes about a draft three
 * reviewers never saw — on exactly the resumed path this design exists for. The loop stays
 * generic and reads rows; the panel guarantees the rows are whole or absent.
 *
 * ## Nothing here blocks a gate
 *
 * A producer still red after its last draft reaches Ryan LOUD, with every attempt's artifact
 * and every round's findings in the payload — and reaches him exactly as fast as one that
 * converged. Checks argue, they never veto (invariant 3). The gaps ride beside the findings
 * for the same reason: a draft that converged with something its checks could not look at is
 * not clean, and rendering it clean would be invariant 4's own failure mode.
 */

/**
 * One draft and the two corrections invariant 5 allows, then it is Ryan's.
 *
 * The same number as `MAX_ATTEMPTS_PER_STEP` and deliberately not the same constant — see the
 * header. Raising this one is a decision about how long the machine argues with itself before
 * asking; raising that one is a decision about flaky transport.
 */
export const MAX_CORRECTION_ROUNDS = 3

/**
 * One finding, composed as a note for the producer's next attempt.
 *
 * It is not a `GateNote`: that is Ryan's sentence with the depth HE routed it to (D21), and
 * this is a check's sentence with the anchor IT found. Keeping them apart is what lets a
 * producer render "the checks said" and "the showrunner said" as the different things they
 * are — and what stops a machine-written note ever being read back as a ruling.
 */
export interface CorrectionNote {
  checkKey: string
  tier: CheckTier
  severity: FindingSeverity
  confidence: FindingConfidence
  /** The scene it sits in, as the episode numbers it. Null: it is about the whole artifact. */
  scene: number | null
  /** The span it lands on, quoted from the artifact. '' when there is none to highlight. */
  quote: string
  concern: string
  /** The canon it argues with, in the order the finding quotes it. */
  facts: string[]
}

/** What one round could not check at all. Never folded into the findings (0012). */
export interface CorrectionGap {
  checkKey: string
  reason: CheckGapReason
  detail: string
}

/** One draft, and what the checks said about it. */
export interface CorrectionRound {
  /** 1 is the first draft anything read. Counted across the artifact's whole life. */
  round: number
  artifactVersion: number
  /** What the producer said it did for this version — the revision's own summary. */
  summary: string
  /** How many checks read this draft — the denominator of its silence (0010). */
  checks: number
  /** Still-open findings anchored in this draft. Empty is the round that converged. */
  findings: CorrectionNote[]
  gaps: CorrectionGap[]
}

/** One deterministic finding standing on the draft, as the round records it. */
export interface BlockingSnapshot {
  findingId: string
  checkKey: string
  /** The scene it sits in, as the episode numbers it. Null: it is about the whole artifact. */
  scene: number | null
  concern: string
}

/**
 * **What a ruling on a written artifact is made of** — every draft that has been read, the
 * verdict board over the one it ends on, and what stands on it (E4-3).
 *
 * ## One artifact, one payload, two doors
 *
 * A gate belongs to a STEP (`gate.ts`), and two steps can present one artifact: the correction
 * loop's, when a writing run produced the draft, and the presenting stage's, when the run that
 * wrote it is long gone (`present-step.ts` — a fixture-written script, a hand-made one, a
 * re-ruling after a rewrite). D7's one-run-per-episode is what stops both being open at once;
 * this type is what stops them being two different screens over one thing. **Whichever door
 * Ryan comes in by, he is handed the same shape** — the drafts, the board, the wall — and only
 * the sentence differs, because only the sentence is about why this gate opened.
 *
 * Every field is a SNAPSHOT of a read and never a source of truth. `verdictBoard`,
 * `historyOf` and `stageBlockingFindings` all compute fresh from rows whenever anybody asks;
 * what lands in the payload is what Ryan was shown at this round, the same kind of record as
 * `gate_round.artifact_version`. A disposition that lands afterwards changes the live answer
 * and does not change this one, which is right: this is history, and the screen recomputes.
 */
export interface DraftsUnderReview {
  artifactId: string
  /** Every draft that has been read, in order — "every attempt kept" (4.4). */
  rounds: CorrectionRound[]
  /** One row per convened reviewer over the draft this ends on (4.5, E3-4). */
  board: VerdictBoard
  /** The last draft read left no findings. An artifact nothing checks converges vacuously. */
  converged: boolean
  /** Converged, checked, and with nothing it could not look at. Never a synonym for the above. */
  clean: boolean
  /**
   * The deterministic findings standing on this draft — what an approval here would be an
   * override OF (D12). None of them blocks this gate, ever: they block the next STAGE.
   */
  blocking: BlockingSnapshot[]
}

/** The loop history, as the gate renders it beside the artifact. */
export interface CorrectionReport extends DraftsUnderReview {
  /** Why this gate is open, in the words the floor shows while it waits. */
  sentence: string
}

/**
 * What the step returns once Ryan has ruled, which is the only way it returns at all.
 *
 * `reject` is the third verdict this can end on, and it is E4-5's: **every note was routed
 * away from the draft under review** (D21), so there is nothing here to write again and the
 * run ends with the note standing against whatever it named. A rejection whose notes land HERE
 * does not return at all — it writes the draft again and presents the next round, which is
 * what the loop has always done.
 */
export interface CorrectionOutcome extends CorrectionReport {
  /**
   * How the round that closed it was ruled.
   *
   * `reject`: routed away, and nothing was rewritten. `close`: **he put the draft down**
   * (E5-3, 0015) — the notes may name anything at all, this loop rewrites nothing either way,
   * and the two words stay two because "you sent it elsewhere" and "you stopped" are two
   * things for every reader downstream.
   */
  verdict: 'approve' | 'override' | 'reject' | 'close'
  gateRound: number
  /** The notes that were routed elsewhere, or the ones he put it down with. */
  routed: readonly GateNote[]
}

/** Why the producer is being called, and with what. Round 1 carries no notes at all. */
export interface ProducerBrief {
  /** Which draft this will be. Matches the round it becomes in the history. */
  round: number
  /** What the checks said about the last draft (4.4's "findings as rejection notes"). */
  findings: readonly CorrectionNote[]
  /** Ryan's own notes, when his rejection is what sent the work back. Keeps his depth (D21). */
  ruling: readonly GateNote[]
}

/**
 * The producing half of a stage. E4's writer is what really goes here; the loop is built and
 * tested against a fake one, because a loop that can only be proved by spending money on Opus
 * is a loop nobody re-proves (fixtures before features).
 *
 * Two rules, and the loop enforces the second one rather than trusting it:
 *
 *   * **Idempotent.** Called again for a round it has already written — a crash, a resumed
 *     step — it keeps what is on the volume and makes no second call (D20).
 *   * **A correction writes a NEW VERSION.** The round history IS the artifact's versions, so
 *     a producer that rewrote a draft in place would leave the loop with no way to tell one
 *     attempt from the next, and the check it already paid for would answer for both.
 */
export interface Producer {
  /** The step name it lends the loop. Stable across code changes — resume matches by it. */
  readonly name: string
  /** The artifact it writes, or undefined before it has written one. */
  find(context: StepContext): Artifact | undefined
  /** Writes the draft. It returns nothing: the rows it wrote are what the loop reads back. */
  produce(context: StepContext, brief: ProducerBrief): Promise<void>
}

/**
 * The composition: one step that produces, checks, corrects, and presents.
 *
 * `check` is a step and is run as one, whole — "a correction round re-runs the tier as the
 * tier defines itself". The semantic tier makes every call and then records in one
 * transaction (`text-check-step.ts`), which is what makes a broken reply mid-round leave
 * nothing behind for the resumed loop to half-believe.
 *
 * It runs inside THIS step's context, which is the right answer to all three of the questions
 * that raises: its calls are billed to this step (2.4), its progress lines are this step's,
 * and it reads what it needs out of the store rather than through `context.input` — a check
 * that declared an input would be asking this step's row for a step of its own.
 */
export function correctionLoop(produce: Producer, check: Step): Step<CorrectionOutcome> {
  return {
    name: produce.name,

    async execute(context: StepContext): Promise<CorrectionOutcome> {
      const store = context.store
      const standing = context.gate()
      const ruled = standing?.ruling

      // ── Back in on a ruling ──────────────────────────────────────────────────
      // Approved, or approved over the findings still standing. The work is done and on the
      // volume: nothing is re-produced, nothing re-checked, nothing re-spent.
      //
      // **Asked as "did it carry the run on", never as "was it not a rejection"** (E5-3). The
      // negative form was correct while there were three verbs and is a bug the moment there
      // are four: a close would fall through it and be treated as an approval, which would
      // advance the lifecycle on a draft Ryan had just put down. `carriesTheRunOn` names the
      // two that do, so a fifth verb has to declare itself rather than inherit an approval.
      if (standing && ruled && carriesTheRunOn(ruled.verdict)) {
        const report = reportOf(store, standing.gate.artifactId)
        context.progress(
          `${ruled.verdict === 'override' ? 'Overridden' : 'Approved'} at round ${standing.round}` +
            ' — nothing rewritten, nothing re-checked, nothing re-spent',
        )
        return { ...report, verdict: ruled.verdict, gateRound: standing.round, routed: [] }
      }

      // ── Back in on a close: he put the draft down (E5-3, #83) ────────────────
      // The one verdict that needs no question asked about its notes. A rejection is read for
      // where it was routed, because a note that lands here is work for this producer; a close
      // says the work stops, whatever it names. So nothing is written, nothing is re-checked,
      // nothing is re-spent, the run ends, and his note stands against the artifact — which is
      // what makes the stage that writes it offerable again (`domain/routing.ts`).
      if (standing && ruled?.verdict === 'close') {
        const report = reportOf(store, standing.gate.artifactId)
        context.progress(
          `Put down at round ${standing.round} — nothing is rewritten, this episode is free, ` +
            'and your note stands against the draft until something answers it',
        )
        return {
          ...report,
          verdict: 'close',
          gateRound: standing.round,
          routed: ruled.notes,
        }
      }

      // ── Back in on a rejection that was routed elsewhere (E4-5, D21) ─────────
      // Every note names ANOTHER artifact — the outline, the premise. There is nothing here
      // for this producer to answer: writing this draft again against a note about the
      // artifact above it is precisely the rewind D21 replaced. So the run ends, the note
      // stands against what it named, and **nothing regenerates until Ryan clicks** the stage
      // that writes it (`domain/routing.ts` reopens that offer with the note in its sentence).
      //
      // A MIXED rejection is not this case and is deliberately not treated as one: a note that
      // lands here is work for this producer whatever else he wrote beside it, so the loop
      // takes the ones that landed and writes the draft again against exactly those.
      const landed =
        ruled?.verdict === 'reject'
          ? ruled.notes.filter((note) => landsOn(note, standing!.gate.artifactId))
          : []
      if (ruled?.verdict === 'reject' && landed.length === 0) {
        const report = reportOf(store, standing!.gate.artifactId)
        context.progress(
          `Rejected at round ${standing!.round}, and every note was routed elsewhere — nothing ` +
            'here is rewritten, and nothing regenerates until you ask for it',
        )
        return {
          ...report,
          verdict: 'reject',
          gateRound: standing!.round,
          routed: ruled.notes,
        }
      }

      // The draft Ryan last ruled on. He has had his opinion of it, so the next thing that
      // happens to it is a rewrite — never another reading of the same words. His rulings are
      // not capped (gate.ts) and they start the machine's own count over: the correction
      // budget bounds how long it argues with itself unattended, and it is not unattended any
      // more once he has spoken.
      //
      // **A note standing against this draft from ANOTHER gate counts as one of those
      // rulings** (E4-5, D21). He read this draft while standing at a different gate and sent
      // it back; the version it landed on is a version he has had his opinion of, so the loop
      // owes a rewrite rather than a re-presentation of the words he just argued with.
      // Unanswered ones only — a note a newer version already answered is history, and
      // re-opening on it would make this stage rewrite itself forever.
      //
      // "Another gate" includes the PRESENTING gate over this very artifact (#76), which is
      // why this reads `notesOwedBy` rather than the desk's reader: that gate is not this
      // step's, so its rounds are not in `standing.rounds`, and without it the button that
      // reopened saying "write it again, rewriting reads it" would hand back the same draft.
      // A note at this step's OWN gate needs nothing here — `lastRuledVersion` already has it,
      // at the same version, so the two agree by construction rather than by coincidence.
      const routedHere = notesOwedBy(store, produce.find(context)?.id ?? '')
      const ruledVersion = Math.max(
        lastRuledVersion(standing?.rounds),
        ...routedHere.map((note) => note.landedAtVersion),
        0,
      )
      const rulingNotes = landed

      // Every iteration re-derives where it stands from rows, and holds nothing across an
      // await. That is what makes a resumed step — after a crash, after a failed attempt —
      // pick up the round it was in rather than starting the loop again.
      let unchecked = false
      for (;;) {
        const artifact = produce.find(context)
        const history = artifact ? historyOf(store, artifact) : []
        const spent = history.filter((round) => round.artifactVersion > ruledVersion).length

        // Nothing yet, or nothing since his ruling: write the draft.
        if (!artifact || artifact.version <= ruledVersion) {
          await draft(context, produce, history, [], rulingNotes)
          continue
        }

        // A draft nobody has read. This is also what a resumed step lands on after a
        // transport failure, and re-reading it is the whole of the recovery.
        if (!checked(history, artifact)) {
          context.progress(
            `Checking the ${subjectOf(store, artifact)} v${artifact.version} — ` +
              `round ${history.length + 1}`,
          )
          await check.execute(context)
          // A check step that convened nothing recorded nothing (4.1: an artifact whose kind
          // and provenance reach no category is vanilla). Without this the loop would ask for
          // a reading that is never coming, forever.
          if (!checked(historyOf(store, artifact), artifact)) {
            unchecked = true
            break
          }
          continue
        }

        const latest = history.at(-1)!
        if (latest.findings.length === 0) break
        if (spent >= MAX_CORRECTION_ROUNDS) break
        await draft(context, produce, history, latest.findings, rulingNotes)
      }

      const report = reportOf(store, produce.find(context)!.id, unchecked)
      context.progress(report.sentence)
      // Loud or clean, it reaches him the same way and at the same speed. The findings do not
      // gate the gate — they are what he is reading (invariant 3).
      context.openGate({
        artifactId: report.artifactId,
        payload: report,
        reason: report.sentence,
      })
    },
  }
}

/**
 * One draft, and the guard that the loop can only end.
 *
 * A producer that returned without moving the version would leave every read below answering
 * about the draft that has already been checked, and the loop would ask it again forever. It
 * is a step's bug rather than a run's, so it fails loudly with the sentence that names it —
 * the same way the runner treats a step that swallowed its own pause.
 */
async function draft(
  context: StepContext,
  produce: Producer,
  history: CorrectionRound[],
  findings: readonly CorrectionNote[],
  ruling: readonly GateNote[],
): Promise<void> {
  const before = produce.find(context)?.version ?? 0
  const round = history.length + 1

  context.progress(
    round === 1
      ? `${produce.name} — round 1`
      : ruling.length > 0
        ? `${produce.name} — round ${round}, against your ${ruling.length} note(s)`
        : `Round ${round - 1} left ${findings.length} finding(s) — writing it again, ` +
          `round ${round} of ${MAX_CORRECTION_ROUNDS}`,
  )

  await produce.produce(context, { round, findings, ruling })

  const after = produce.find(context)
  if (!after || after.version <= before) {
    throw new Error(
      `${produce.name} was asked for round ${round} and left the artifact at version ` +
        `${after?.version ?? 0}. A correction round writes a NEW draft — the round history is ` +
        'the artifact’s versions, and a rewrite in place would make two attempts one row.',
    )
  }
}

// ── Reading the rounds back ─────────────────────────────────────────────────────

/**
 * Every draft of this artifact a check has read, in order.
 *
 * Findings are counted where they are ANCHORED, which is not always where the pass ran: a
 * continuity-board rule reads the board and lands in the script's scene 4 (E3-1), and a
 * producer rewriting the script is owed that note as much as the ones from the tier the loop
 * itself ran. Closed findings are not: a disposition is Ryan's answer to one, and re-writing
 * against something he has already put down would spend a call to undo his ruling.
 */
export function historyOf(store: Store, artifact: Artifact): CorrectionRound[] {
  const passes = checkPassesOf(store, artifact.id)
  const versions = [...new Set(passes.map((pass) => pass.artifactVersion))].sort((a, b) => a - b)
  const findings = findingsIn(store, artifact.id)
  const scenes = new Map(scenesOf(store, artifact.episodeId).map((scene) => [scene.id, scene.ordinal]))
  // What each draft says about itself, from the rows the producer wrote. A round rendered as
  // a bare version number is a history Ryan has to reconstruct, which is the archaeology the
  // HIL contract forbids.
  const revisions = new Map(
    revisionsOf(store, artifact.id).map((revision) => [revision.version, revision.summary]),
  )

  return versions.map((version, index) => {
    const read = passes.filter((pass) => pass.artifactVersion === version)
    return {
      round: index + 1,
      artifactVersion: version,
      summary: revisions.get(version) ?? '',
      checks: read.length,
      findings: findings
        .filter((finding) => finding.anchor.version === version && finding.status === 'open')
        .map((finding) => noteOf(finding, scenes)),
      gaps: read.flatMap((pass) =>
        gapsOfPass(store, pass.id).map((gap) => ({
          checkKey: gap.checkKey,
          reason: gap.reason,
          detail: gap.detail,
        })),
      ),
    }
  })
}

/** Has this draft been read at all? A round is a version a check has answered about. */
const checked = (history: CorrectionRound[], artifact: Artifact): boolean =>
  history.some((round) => round.artifactVersion === artifact.version)

function noteOf(finding: Finding, scenes: Map<string, number>): CorrectionNote {
  return {
    checkKey: finding.checkKey,
    tier: finding.tier,
    severity: finding.severity,
    confidence: finding.confidence,
    scene: finding.anchor.sceneId === null ? null : (scenes.get(finding.anchor.sceneId) ?? null),
    quote: finding.anchor.quote,
    concern: finding.concern,
    facts: finding.facts.map((fact) => fact.statement),
  }
}

/**
 * Everything a ruling on this artifact is made of, composed fresh from rows.
 *
 * Exported because the presenting stage composes the same value over an artifact whose writing
 * run is long gone (`present-step.ts`). One composer, two doors — see `DraftsUnderReview`.
 */
export function draftsUnderReview(store: Store, artifactId: string): DraftsUnderReview {
  const artifact = findArtifact(store, artifactId)
  if (!artifact) throw new Error(`No such artifact: ${artifactId}`)

  const rounds = historyOf(store, artifact)
  const latest = rounds.at(-1)
  const converged = latest === undefined || latest.findings.length === 0

  return {
    artifactId,
    rounds,
    // Computed here, at the moment the gate is presented, out of the same rows the rounds
    // above came from — so the board and the history can never disagree about one draft.
    board: verdictBoard(store, artifact),
    converged,
    // An artifact nothing read is not clean, and neither is one whose checks reached a hole.
    // "Never render a weak check as a green checkmark" is the same rule said about silence.
    clean: converged && latest !== undefined && (latest?.gaps.length ?? 0) === 0,
    blocking: stageBlockingFindings(store, artifact.episodeId)
      .filter((block) => block.artifact.id === artifact.id)
      .map((block) => ({
        findingId: block.finding.id,
        checkKey: block.finding.checkKey,
        scene: block.scene,
        concern: block.finding.concern,
      })),
  }
}

/** The history, and the three sentences it can end on. */
function reportOf(store: Store, artifactId: string, unchecked = false): CorrectionReport {
  const under = draftsUnderReview(store, artifactId)
  const latest = under.rounds.at(-1)

  return {
    ...under,
    sentence: sentenceFor({
      subject: subjectOf(store, findArtifact(store, artifactId)!),
      rounds: under.rounds,
      converged: under.converged,
      gaps: latest?.gaps.length ?? 0,
      unchecked,
    }),
  }
}

function sentenceFor(state: {
  subject: string
  rounds: CorrectionRound[]
  converged: boolean
  gaps: number
  unchecked: boolean
}): string {
  const latest = state.rounds.at(-1)
  if (!latest || state.unchecked) {
    return (
      `Nothing checks the ${state.subject}: no check was called over it at all. That is a ` +
      'kind of artifact no check reads, which is not a failure. It is also not a clean ' +
      'reading, because nothing read it. Waiting on your ruling.'
    )
  }
  if (!state.converged) {
    return (
      `The ${state.subject} still has ${latest.findings.length} finding(s) after ` +
      `${latest.round} drafts, so the correction budget is spent. This is ` +
      'where the machine stops arguing with itself. Every round is under it. Waiting on your ' +
      'ruling.'
    )
  }
  const read =
    `The ${state.subject} read clean at round ${latest.round} — ${latest.checks} check(s), ` +
    'nothing found'
  return state.gaps === 0
    ? `${read}. Waiting on your ruling.`
    : `${read}, and ${state.gaps} thing(s) they could not check at all — canon has not decided ` +
      'them, so no rewrite would answer one. Waiting on your ruling.'
}

/** The newest version Ryan has actually ruled on, or 0 before he ever has. */
function lastRuledVersion(rounds: readonly GateRound[] = []): number {
  return rounds.reduce(
    (highest, round) => (round.ruling ? Math.max(highest, round.artifactVersion) : highest),
    0,
  )
}

/** "ep02 outline" — what the sentences above are about. */
function subjectOf(store: Store, artifact: Artifact): string {
  const episode = findEpisode(store, artifact.episodeId)
  const label = episode ? `${episodeLabel(episode.number)} ` : ''
  return `${label}${artifact.kind}${artifact.slot ? ` ${artifact.slot}` : ''}`
}

// ── The notes, as a producer sends them ─────────────────────────────────────────

/**
 * The brief as prompt lines: what the checks said, and what Ryan said, kept apart.
 *
 * Composed here rather than in each producer so that every writing step in this app hands a
 * model the same shape — severity and confidence side by side and never collapsed (invariant
 * 4), the span quoted so the rewrite knows where to land, and the canon the finding argues
 * with quoted with it, because "it contradicts a fact" is not something a model can act on
 * without the fact.
 *
 * These are NOT E3-5's prior dismissal notes. Those are Ryan's rulings on findings from
 * EARLIER runs and they ride a different seam (`text-check-step.ts`'s `priorNotes`, still
 * unfetched). These are this loop's own last round, and they die with it.
 */
export function correctionNoteLines(brief: ProducerBrief): string[] {
  const lines: string[] = []

  if (brief.findings.length > 0) {
    lines.push(
      '',
      `The checks read round ${brief.round - 1} and this is what they said. Answer every one ` +
        'of them, and change nothing they did not ask about.',
      '',
    )
    for (const note of brief.findings) {
      const where = [
        note.scene === null ? '' : `scene ${note.scene}`,
        note.quote === '' ? '' : `“${note.quote}”`,
      ]
        .filter((part) => part !== '')
        .join(' · ')
      lines.push(
        `- the ${note.checkKey} check · severity ${note.severity} · confidence ${note.confidence}` +
          (where === '' ? '' : ` · ${where}`),
        `  ${note.concern}`,
        ...note.facts.map((fact) => `  It argues with canon: “${fact}”`),
      )
    }
  }

  if (brief.ruling.length > 0) {
    lines.push('', 'The showrunner rejected the last round. His notes, verbatim:', '')
    for (const note of brief.ruling) {
      const routed = [note.depth, note.target].filter((part) => part).join(' ')
      lines.push(`- ${routed === '' ? '' : `(${routed}) `}${note.note}`)
    }
  }

  if (lines.length > 0) lines.push('', 'Write it again, and return the artifact and nothing else.')
  return lines
}

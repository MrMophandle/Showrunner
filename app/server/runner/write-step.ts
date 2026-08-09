import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { costOfRun, projectLLMCost, spentSentence, type CostTotals } from '../cost.ts'
import type { Store } from '../db/store.ts'
import {
  artifactsOf,
  declareProvenance,
  recordArtifact,
  reviseArtifact,
  type Artifact,
  type ArtifactKind,
} from '../domain/artifact.ts'
import { positionsOf } from '../domain/arc.ts'
import { categoriesForArtifactKind } from '../domain/category.ts'
import { craftChecksFor } from '../domain/craft.ts'
import { advanceOnApproval, type LifecycleMove } from '../domain/lifecycle.ts'
import { episodeInShow, episodeLabel, type Episode, type EpisodeInShow } from '../domain/spine.ts'
import {
  composeWriteContext,
  nameAppearingIn,
  producedBy,
  type ArcInContext,
  type EntityInContext,
  type WriteContext,
  type WriteStep,
} from '../domain/write-context.ts'
import { writeIfAbsent, type LibraryPaths } from '../library.ts'
import type { LLMEffort } from '../llm/adapter.ts'
import {
  correctionLoop,
  correctionNoteLines,
  MAX_CORRECTION_ROUNDS,
  type CorrectionOutcome,
  type Producer,
  type ProducerBrief,
} from './correction-loop.ts'
import type { Stage, StageCatalogue, StageOffer, Step, StepContext } from './step.ts'
import { checkTextAgainstCanon, TEXT_CHECK_CALL } from './text-check-step.ts'

/**
 * **The writing line, as stages** (E4-1, 1.1, 4.4) — the first of them being the premise.
 *
 * One stage is one writing step: compose the desk, make one call, file what came back, run
 * the panel over it, correct it while the panel has something to say, and present whatever
 * it ends on for Ryan's ruling. Then, and only then, the episode moves on.
 *
 * ## The desk is the only door onto canon, and that is the whole point
 *
 * `composeWriteContext` (E4-0) is what this reads, and it reads nothing else: no
 * `canonAsOf`, no `entitiesOfShow`, no `factsInScope`, no query of its own. A second
 * composer that "happens to agree" is the failure E4-0 exists to prevent — it agrees until
 * the day one of them learns something (the audience filter, a new inclusion door, a note
 * origin) and then two writers are handed two different worlds. If a later step needs
 * something canon-shaped that the desk does not carry, it goes in the desk.
 *
 * The proof is a captured prompt, not a comment: `write-step.test.ts` asserts that a fact a
 * LATER episode ratified is absent from the prompt while one an EARLIER episode ratified is
 * present, and that no entity the desk left out appears anywhere in it. Only a prompt
 * composed from the desk passes all of those at once.
 *
 * ## Ryan's notes arrive through the desk too — there is no second channel
 *
 * The correction loop hands a producer `brief.ruling`, and this producer deliberately does
 * not read it. A rejection is a `gate_note` row; the desk reads those rows and composes the
 * sentence around them ("your round 1 rejection of the ep02 premise-brief, routed at premise
 * depth"), which is what a rewrite needs and what a bare array of strings cannot say. Reading
 * both would print his note twice; reading the argument instead of the record would lose the
 * attribution. What DOES come off the brief is `brief.findings` — the checks' own words about
 * the last draft, which are this loop's and die with it (`correction-loop.ts`).
 *
 * ## Provenance is declared out of what was WRITTEN
 *
 * Invariant 2 runs the other way for a writer: there is no upstream declaration to read,
 * because this step is what writes one. So the draft is matched against the entities the desk
 * handed over, through the desk's own matcher (`nameAppearingIn`), and what it names is what
 * it declares it touches. Two consequences, both wanted: a brief about Ilse convenes the
 * character check and nothing else (4.1), and an entity the writer was never handed can never
 * end up in provenance — a check would then be reading canon the writer never saw.
 *
 * It is additive across rounds, like every provenance write. A rewrite that stops mentioning
 * somebody has not un-touched them: the artifact is the record of what it has been about, and
 * the desk reads exactly that back so a rewrite does not forget a character the last draft
 * invented (write-context.ts).
 *
 * ## Where "it already has one" is enforced, and where it deliberately is not
 *
 * An episode that already has a premise-brief has nothing for this stage to do, and that is
 * said in `offerOn` — which is where a run is started from, and which the API refuses with the
 * same string (D15, `operating.ts`). It is **not** re-checked inside the producer, which
 * breaks the usual "every step checks its own preconditions" rule on purpose: once the loop
 * owns a draft it must be free to rewrite it, and there is no honest way for a producer to
 * tell its own draft from one that was there before the run — every discriminator available
 * (a gate that has not opened yet, an attempt counter, a file path) is wrong on the resumed
 * path this app is built for. The precondition is about whether a run should START, so it
 * lives where runs start.
 *
 * What holds unconditionally is the rule underneath it: **files are never overwritten.** Each
 * round writes its own path through `writeIfAbsent`, so a hand-made draft survives on the
 * volume whatever anybody enqueues — D20 is kept by the bytes, not by the button.
 *
 * ## The lifecycle seam is structural, not a convention
 *
 * Every writing stage is built by `writingStage` below, and it puts the closing step on
 * every one of them: a gate approved (or overridden) is what moves the episode on, through
 * `advanceOnApproval` (domain/lifecycle.ts), which owns the four rules. A stage cannot be
 * added to this file without it, which is the difference between a seam and a habit.
 *
 * ## The smoke path, documented and not run
 *
 * `npm test` never reaches the network. To watch a real premise get written, on real money,
 * by hand:
 *
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm run fixture:load
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm start
 *     # then POST the run: {"episodeId": "<ep02>", "stage": "write-the-premise"}
 *
 * **Always with `LIBRARY_DIR` at a scratch path and never on 4455** — a bare boot migrates
 * and writes Ryan's own library (#49).
 */

/** The stage name, as it is persisted on `run.stage` and as the API takes it. */
export const PREMISE_STAGE = 'write-the-premise'

/**
 * What one writing call costs, deliberately generous against what it really sends: the desk
 * carries every core entity's prose, its facts and the season's arcs. Over-stating is the
 * safe direction for a number on a button and the ledger afterwards is what was spent
 * (cost.ts).
 */
export const WRITE_CALL = { promptTokens: 8000, outputTokens: 1200 } as const

/**
 * The ceiling on one draft, and the effort behind it.
 *
 * Higher than the demo's 700 because a premise-brief is prose with a shape rather than a
 * paragraph, and because Opus thinks by default and thinking is billed as output — a ceiling
 * that a model's reasoning eats before a word is written is a truncated artifact that looks
 * finished. `medium` is the writing tier: below the checks' `high` (4.2 gives thinking to the
 * pass that has to hold three facts and a scene in mind at once) and well above extraction's
 * `low`, because this one is neither transcription nor adjudication.
 */
export const WRITE_MAX_TOKENS = 4000
export const WRITE_EFFORT: LLMEffort = 'medium'

/** What the closing step returns: the ruling, where it left the episode, and what it cost. */
export interface WriteClose {
  artifactId: string
  /** How the round that closed the gate was ruled: 'approve' or 'override'. */
  verdict: 'approve' | 'override'
  gateRound: number
  /** Where the approval left the episode on the lifecycle, and why (domain/lifecycle.ts). */
  lifecycle: LifecycleMove
  spend: CostTotals
  sentence: string
}

/**
 * The writing stages this build ships. E4-2 and E4-3 add `outline` and `script` by adding a
 * line here and an entry to `WRITING` below — TypeScript and a test, never a row (Archon).
 */
export function writeStages(library: LibraryPaths): StageCatalogue {
  return { [PREMISE_STAGE]: writingStage(library, 'premise', PREMISE_STAGE) }
}

/**
 * What each writing step is asked for, in the words the model is asked in.
 *
 * A TypeScript object in a TypeScript file, like `CRAFT_REVIEWER` and for the same reason
 * (craft.ts): what a premise IS reads the same for Grey Harbor and for Dead Light, there is
 * no sheet for it to live on, and nothing reads this to decide what to run. It is not a
 * stage described in data — the stages are the functions below (Archon).
 */
const WRITING: Record<WriteStep, { instructions: string[] }> = {
  premise: {
    instructions: [
      'Write the premise-brief for this episode: what goes wrong, who it goes wrong for, and',
      'why it matters now rather than in some other episode. Prose — 150 to 300 words, no',
      'headings, no bullet points, no preamble, and no title.',
      '',
      'Three things it has to do:',
      '',
      '1. **Stand on the canon above and not beside it.** Use the entities you have been',
      '   given, by the names they carry, so that what this brief touches is readable from',
      '   the brief itself. What you were not given, you were not given: do not reach for a',
      '   character, a place or a rule that is not above.',
      '2. **Be about a change.** Say what is true at the start and what is true at the end.',
      '   A situation is not a premise.',
      '3. **Obey the world rules and the house style exactly.** They are the prose the show',
      '   does not get to bend.',
      '',
      'You may invent what the episode needs — a fault, an object, a piece of weather. What',
      'you invent is a CLAIM and not canon: nothing here writes canon, and only Ryan ruling a',
      'proposal ever does (invariant 1).',
      '',
      'Return the brief and nothing else.',
    ],
  },
  // Written by E4-2 and E4-3, which is also when `writeStages` gains their stages. The
  // entries are here rather than absent because the record is exhaustive over `WriteStep`,
  // and a partial one would let a stage be registered with nothing to ask the model for.
  outline: { instructions: ['E4-2 writes the outline step.'] },
  script: { instructions: ['E4-3 writes the script step.'] },
}

const SYSTEM =
  'You are writing episodes of a television show with its showrunner. You are handed the ' +
  'canon this episode’s audience already knows, the arcs it is written under, and whatever ' +
  'the showrunner has already said about it. Answer with the artifact you were asked for and ' +
  'nothing else: no preamble, no explanation of your choices, no notes to the showrunner.'

// ── The stage ───────────────────────────────────────────────────────────────────

function writingStage(library: LibraryPaths, step: WriteStep, name: string): Stage {
  const producer = writer(library, step)
  return {
    name,
    // It writes the next artifact, which is what puts D12's wall in front of it (step.ts).
    // The premise is the first thing an episode has, so in practice there is never material
    // of its own standing against it — the wall gets a real button back with E4-2's outline.
    work: 'produces',
    steps: [
      correctionLoop(producer, checkTextAgainstCanon(library, producedBy(step))),
      advancePastTheGate(step, producer.name),
    ],
    offerOn: (store, episode): StageOffer => offerFor(store, episode, step),
  }
}

/**
 * What running this stage on this episode would say, cost and need — E3-7's declaration, and
 * the whole of the button (step.ts, `StageOffer`).
 *
 * **The reviewers can only be an upper bound, and it says so.** How many category checks
 * convene depends on who the brief turns out to be about (4.1), and the brief does not exist
 * yet; what is knowable before the click is how many categories DECLARE this kind, how many
 * arc positions the episode declares, and the craft reviewers the kind is read by. Counting
 * the declared categories over-states, which is the safe direction — a button that
 * under-states is a button that lies cheaply.
 */
function offerFor(store: Store, episode: Episode, step: WriteStep): StageOffer {
  const kind = producedBy(step)
  const label = episodeLabel(episode.number)
  const where = episodeInShow(store, episode.id)
  const reviewers =
    where === undefined
      ? 0
      : categoriesForArtifactKind(store, where.show.id, kind).length +
        positionsOf(store, episode.id).length +
        craftChecksFor(kind).length

  const write = projectLLMCost(WRITE_CALL)
  const panel = projectLLMCost({ ...TEXT_CHECK_CALL, calls: reviewers })
  const standing = alreadyWritten(store, episode.id, kind)

  return {
    sentence:
      `Write the ${label} ${kind} from the writer’s desk and present it for your ruling — ` +
      `“${episode.title}”, one call, then up to ${reviewers} reviewer${
        reviewers === 1 ? '' : 's'
      } read it`,
    cost:
      `${write.sentence} + up to ${panel.sentence} to check it, per draft — and the loop ` +
      `stops at ${MAX_CORRECTION_ROUNDS} drafts (invariant 5)`,
    callsModel: true,
    nothingToDoBecause: standing === undefined ? null : alreadyWrittenBecause(label, standing),
  }
}

/**
 * The episode's artifact of this kind, whatever slot it sits in — and therefore whether this
 * stage has anything to do at all.
 *
 * **Slot-agnostic on purpose, and deliberately wider than what the producer looks for.** The
 * producer owns the singular slot and writes only there; this question is "does a premise for
 * this episode exist", and a brief E1's retired demo stage wrote into its own slot is still a
 * premise for this episode. A hand-made asset always wins and re-runs fill gaps only (D20):
 * the answer to "there is one already" is to rule on it or edit it, never to write a second.
 */
function alreadyWritten(store: Store, episodeId: string, kind: ArtifactKind): Artifact | undefined {
  return artifactsOf(store, episodeId).find((artifact) => artifact.kind === kind)
}

/** One sentence, two readers — the disabled button states it and the API refuses with it. */
const alreadyWrittenBecause = (label: string, standing: Artifact): string =>
  `${label} already has a ${standing.kind}${
    standing.slot === '' ? '' : `, in slot “${standing.slot}”`
  } — rule on it at its gate, or edit it directly (E4-5).`

// ── The producer ────────────────────────────────────────────────────────────────

/**
 * The writing half of the stage: compose the desk, make one call, file the draft.
 *
 * The two rules the loop enforces rather than trusts (`correction-loop.ts`) are both kept
 * here: a round whose draft is already on the volume makes no second call, and every round
 * writes a NEW VERSION of the artifact, because the round history IS the versions.
 */
function writer(library: LibraryPaths, step: WriteStep): Producer {
  const kind = producedBy(step)
  const find = (context: StepContext): Artifact | undefined =>
    // The singular slot, and only it. What the OFFER asks is a wider question — see
    // `alreadyWritten` — and answering both with one read would have this producer adopt a
    // demo-era artifact as the draft it is rewriting.
    artifactsOf(context.store, context.episodeId).find(
      (artifact) => artifact.kind === kind && artifact.slot === '',
    )

  return {
    name: `write-the-${kind}`,
    find,

    async produce(context: StepContext, brief: ProducerBrief): Promise<void> {
      const desk = composeWriteContext(context.store, library, {
        episodeId: context.episodeId,
        step,
      })
      const where = desk.where
      const filePath = join(
        where.show.key,
        `s${pad(where.season.number)}e${pad(where.episode.number)}`,
        `${kind}-round-${brief.round}.md`,
      )
      const onDisk = join(library.artifactDir, filePath)

      // ── The draft for this round ─────────────────────────────────────────────
      // Already there — a crash between writing it and recording the row, or Ryan's own
      // hand? It is what he rules on, and no call is made for it. Re-runs fill gaps only
      // (D20), and here that rule is worth money as well as bytes.
      let text: string
      if (existsSync(onDisk)) {
        context.progress(
          `Round ${brief.round}’s draft was already in the library — kept as it stands, and no ` +
            'call made for it',
        )
        text = readFileSync(onDisk, 'utf8')
      } else {
        context.progress(desk.sentence)
        const completion = await context.llm.complete({
          system: SYSTEM,
          prompt: composeWritePrompt(desk, brief),
          maxTokens: WRITE_MAX_TOKENS,
          effort: WRITE_EFFORT,
        })
        text = `${completion.text.trim()}\n`
        // 'max_tokens' means the brief stops mid-sentence. It was paid for and it is real, so
        // it is filed and it goes to the panel and to Ryan like any other draft — but he is
        // told, rather than handed something truncated that reads as finished (invariant 4).
        if (completion.stopReason === 'max_tokens') {
          context.progress(
            `The model stopped at the ${WRITE_MAX_TOKENS}-token ceiling — the draft below ` +
              'stops mid-sentence',
          )
        }
        mkdirSync(dirname(onDisk), { recursive: true })
        // Belt and braces with the check above: the same rule, once for the money and once
        // for the bytes. Nothing this app writes may land on a file already there.
        writeIfAbsent(onDisk, text)
      }

      // ── The row, and what it declares it touches ─────────────────────────────
      const touches = desk.entities
        .filter((held) => nameAppearingIn(text, held.entity) !== undefined)
        .map((held) => held.entity.id)

      const standing = find(context)
      if (!standing) {
        recordArtifact(context.store, {
          episodeId: context.episodeId,
          kind,
          filePath,
          touches,
        })
        return
      }
      declareProvenance(context.store, standing.id, touches)
      reviseArtifact(context.store, standing.id, {
        summary:
          brief.findings.length > 0
            ? `rewritten against ${brief.findings.length} finding(s) from round ${brief.round - 1}`
            : `rewritten against your ruling on round ${brief.round - 1}`,
        filePath,
      })
    },
  }
}

// ── The closing step: the ruling moves the episode on ───────────────────────────

/**
 * What happens on the far side of the gate: the episode moves, and the run says what it
 * spent doing it.
 *
 * It is a second step rather than a tail on the first for the reason E1's demo already had
 * one — a ruling has to visibly send the run ONWARD rather than merely un-pause it — and for
 * a second reason that is E4's: `advanceOnApproval` runs exactly once per approval, on a step
 * that is idempotent and re-runnable, and never inside the loop that may still be arguing
 * with itself.
 */
function advancePastTheGate(step: WriteStep, producerName: string): Step<WriteClose> {
  return {
    name: `advance-past-the-${step}-gate`,
    inputs: [producerName],

    async execute(context: StepContext): Promise<WriteClose> {
      const outcome = context.input<CorrectionOutcome>(producerName)
      const lifecycle = advanceOnApproval(context.store, context.episodeId, step)
      const spend = costOfRun(context.store, context.runId)
      const sentence =
        `${outcome.verdict === 'override' ? 'Overridden' : 'Approved'} at round ` +
        `${outcome.gateRound} · ${lifecycle.sentence} · ${spentSentence(spend)}`

      context.progress(sentence)
      return {
        artifactId: outcome.artifactId,
        verdict: outcome.verdict,
        gateRound: outcome.gateRound,
        lifecycle,
        spend,
        sentence,
      }
    },
  }
}

// ── The prompt ──────────────────────────────────────────────────────────────────

/**
 * The desk, as the words a model is handed — **composed out of the `WriteContext` and out of
 * nothing else.**
 *
 * Exported so a test can read it without a runner, and so E4-7's "what the writer was handed"
 * inspector renders the same string that was sent rather than a reconstruction of it.
 */
export function composeWritePrompt(context: WriteContext, brief: ProducerBrief): string {
  const label = episodeLabel(context.where.episode.number)
  const kind = producedBy(context.step)
  const asked = WRITING[context.step]

  return [
    ...identity(context.where),
    '',
    `── WHAT YOU ARE WRITING FROM ──`,
    context.upstream.text === null
      ? (context.upstream.note ?? 'Nothing.')
      : `The ${label} ${context.upstream.expected}, whole:\n\n${context.upstream.text}`,
    '',
    `── CANON, AS THE ${label} AUDIENCE KNOWS IT ──`,
    'This is everything you have. It is what this episode’s audience already knows and no',
    'more — a later episode’s canon is not on this page, deliberately.',
    ...context.entities.flatMap((held) => entityLines(held)),
    '',
    `── THE ARCS ${label} IS WRITTEN UNDER ──`,
    ...arcLines(context.arcs, context.vanilla, label),
    ...noteLines(context.notes),
    // The CHECKS' half of the brief, and deliberately only that half: `brief.ruling` is
    // Ryan's, and it has already arrived above through the desk, with its round on it.
    ...correctionNoteLines({ ...brief, ruling: [] }),
    '',
    `── WRITE THE ${label} ${kind.toUpperCase()} ──`,
    ...asked.instructions,
  ].join('\n')
}

const identity = (where: EpisodeInShow): string[] => [
  `Show: “${where.show.title}”.`,
  `Season ${where.season.number}${where.season.title ? ` — “${where.season.title}”` : ''}, ` +
    `episode ${where.episode.number}: “${where.episode.title}”.`,
  `That episode is at the “${where.episode.lifecycle}” stage of its lifecycle, which is the ` +
    'stage it is DOING and not one it has finished.',
]

/** One entity: why it is here, its prose, what it brings, and what it could not answer. */
function entityLines(held: EntityInContext): string[] {
  const entity = held.entity
  const also = entity.aliases.length === 0 ? '' : ` · also called ${entity.aliases.join(', ')}`
  const lines = [
    '',
    `### ${entity.name} — ${entity.categoryKey}, standing ${entity.standing ?? 'undeclared'}${also}`,
    `On your desk because: ${held.reasons.map((reason) => reason.because).join('; ')}.`,
  ]
  if (entity.body.trim() !== '') lines.push('', entity.body.trim())

  if (held.facts.length > 0) {
    lines.push('', 'What is true about them:')
    for (const fact of held.facts) {
      const from =
        fact.inherited === null
          ? ''
          : ` — inherited from “${fact.inherited.source.name}”, along \`${fact.inherited.via}\``
      lines.push(`- ${fact.fact.statement} (${REACH[fact.reach]}${from})`)
    }
  }
  // Never folded into the facts. A writer told "her species is undecided" writes differently
  // from one told nothing at all (invariant 4, one layer off the checks).
  if (held.gaps.length > 0) {
    lines.push('', 'What canon has not decided about them:')
    for (const gap of held.gaps) lines.push(`- ${gap.because}.`)
  }
  return lines
}

/** The audience-knowledge door a fact came through, in words a writer can act on. */
const REACH: Record<string, string> = {
  'show-level': 'show canon, true before the first episode',
  'established-earlier': 'established in an earlier episode, already on screen',
  'established-here': 'established in this episode',
  riding: 'claimed by this episode and not yet ruled — provisional, and yours to keep true',
}

function arcLines(arcs: ArcInContext[], vanilla: boolean, label: string): string[] {
  if (arcs.length === 0) return ['This show declares no arcs.']

  const lines = arcs.flatMap((held) => [
    '',
    `### ${held.arc.name} — a ${held.arc.kind} arc, scoped to the ${held.arc.scope}`,
    held.arc.statement,
    ...held.waypoints.map(
      (waypoint) =>
        `- waypoint ${waypoint.ordinal}, ${waypoint.name}: ${waypoint.description} ` +
        `Landing it looks like: ${waypoint.landingCriteria}`,
    ),
    held.position === null
      ? `${label} declares no position on this arc.`
      : `${label} is declared at waypoint ${held.position.waypoint.ordinal} — ` +
        `${held.position.waypoint.name}. Land it.`,
  ])

  if (vanilla) {
    lines.push(
      '',
      `${label} declares no position on any arc. That is **vanilla** — legal, tracked, and ` +
        'never a failure state. Do not invent a landing to have one.',
    )
  }
  return lines
}

/**
 * What Ryan has already said, newest first — his rejections of this artifact and the findings
 * he has put down elsewhere, each carrying the sentence the desk composed around it.
 *
 * The sentence is the load-bearing part: "your round 2 rejection of the ep02 outline, routed
 * at scene depth" is a different instruction from the same words with no attribution, and it
 * is why this is read off the desk rather than off the loop's `brief.ruling`.
 */
function noteLines(notes: WriteContext['notes']): string[] {
  if (notes.length === 0) return []
  return [
    '',
    '── WHAT THE SHOWRUNNER HAS ALREADY SAID ──',
    'Answer every one of these. They are his, verbatim, with where each was given.',
    '',
    ...notes.map((note) => `- ${note.sentence}: “${note.note}”`),
  ]
}

const pad = (n: number): string => String(n).padStart(2, '0')

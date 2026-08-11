import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  claimScope,
  parseClaimExtraction,
  raiseWhatItClaims,
  type ClaimScope,
  type ClaimsRaised,
} from '../claim.ts'
import { projectLLMCost, type CostProjection } from '../cost.ts'
import { episodeLabel } from '../domain/spine.ts'
import { writeIfAbsent, type LibraryPaths } from '../library.ts'
import type { LLMEffort } from '../llm/adapter.ts'
import type { CorrectionOutcome } from './correction-loop.ts'
import { putsTheWorkDown } from './gate.ts'
import type { Step, StepContext } from './step.ts'

/**
 * **Fact extraction, as a step** (E4-4, 1.2, D8) — the paid reading that turns a script Ryan
 * has just approved into proposals riding its episode.
 *
 * ## Why it lives INSIDE the script run, after the gate
 *
 * It is the script stage's third step, between the correction loop and the lifecycle close.
 * That placement is three decisions:
 *
 *   * **After the gate, so it reads the draft Ryan APPROVED.** Extraction inside the loop
 *     would read round 1, raise a stack of proposals about prose, and then round 2 would
 *     rewrite the prose out from under them — spend and noise for a draft nobody kept. The
 *     loop argues; this reads the argument's outcome.
 *   * **Inside the run, so one click covers it.** E1's pattern: the gate parks the run and
 *     the approval carries it on, so the launch click Ryan already made is the click that
 *     pays for this. The button's cost sentence says so before he presses it
 *     (`write-step.ts`'s `offerFor`) — "+ 1 more … after you approve it" — because a spend
 *     that arrives after a ruling is still a spend he agreed to, and it may not be a surprise.
 *     A stage of its own would need a second button, a second sentence, and a second click in
 *     the drill for a reading that has exactly one moment it can honestly happen at.
 *   * **Before the lifecycle close, so the run's own spend sentence covers it.** The closing
 *     step reports `costOfRun`, and a step that spent money after it would be money the run's
 *     own sentence never mentioned. It also keeps the module header's promise literally true:
 *     the episode moves on last, when the stage's work is actually finished. The consequence
 *     is deliberate and worth stating — an extraction that fails all three attempts fails the
 *     run, and ep02 stays at `script` with its approval recorded on the gate. That is the
 *     honest state: Ryan ruled, and the stage did not finish. Invariant 5 hands him the
 *     attempt history and he decides.
 *
 * ## Idempotent, and re-runnable without a second call
 *
 * A step is re-run after a crash, so this one may not buy a second reading of the same draft.
 * The reply is filed beside the script on the volume, keyed to the version it read (D2), and
 * a re-entry that finds it re-raises from those bytes instead of calling. That is the
 * producer's own rule (`write-step.ts`: a round whose draft is already in the library makes no
 * second call) and D20's "re-runs fill gaps only" applied to tokens.
 *
 * The raising is idempotent underneath it as well, which is belt and braces on purpose: a
 * claim an earlier attempt raised is a provisional fact riding the episode, so the verbatim
 * check skips it, and `landPosition` stands on the landing already raised (`claim.ts`).
 *
 * ## No lock, and nothing rules
 *
 * A cloud model call holds no GPU, and `image-api` is for cloud IMAGE steps (D20). And every
 * line downstream of this step raises: it imports no ruling verb, and the proposals it leaves
 * behind wait for Ryan at the completion sweep (`domain/episode-canon.ts`).
 */

/** The step name, as it is persisted on `step.name`. Stable — resume matches rows by it. */
export const EXTRACT_CLAIMS_STEP = 'extract-the-canon-claims'

/**
 * One reading of a whole script plus the canon its provenance loads, answering with a short
 * structured list. Generous against what is really sent, which is the safe direction for a
 * number on a button — the ledger afterwards is what was actually spent (cost.ts).
 */
export const CLAIM_EXTRACTION: CostProjection = projectLLMCost({
  promptTokens: 14000,
  outputTokens: 1500,
})

/**
 * **Above the board's `low` and below the checks' `high`**, and the difference from
 * `BOARD_EFFORT` is worth the sentence.
 *
 * The continuity board is transcription — where a body is, what it is wearing — and a model
 * that thinks hard about that is a model inventing. This is not only transcription: it has to
 * decide whether a claim ARGUES with a fact it was handed rather than merely sitting beside
 * it, and, for a story arc, which of the entities on the page a landing actually reads on —
 * the writing judgement nobody else can supply (the E2-3 constraint). At `low` both of those
 * are answered by picking the first plausible thing. It stays below the checks because it
 * never adjudicates anything: it proposes, and Ryan rules.
 */
export const CLAIM_EFFORT: LLMEffort = 'medium'

/** A dozen claims and a landing or two is a page of JSON; the ceiling is generous against it. */
export const CLAIM_MAX_TOKENS = 6000

/** What the step hands on, plus whether it bought the reading or read one back off the volume. */
export interface ClaimExtractionOutcome extends ClaimsRaised {
  /** Relative to the library's artifact dir — the reply, filed (D2). */
  filePath: string
  /** False when the reply was already on the volume and no call was made for it. */
  called: boolean
}

/**
 * Reads the approved draft into the claims it makes, and raises them.
 *
 * It declares the producer as its input rather than looking the artifact up itself, because
 * the artifact it must read is the one the loop presented and Ryan ruled — provenance that is
 * optional to declare is provenance nobody declares (step.ts).
 */
export function extractTheCanonClaims(
  library: LibraryPaths,
  producerName: string,
): Step<ClaimExtractionOutcome | null> {
  return {
    name: EXTRACT_CLAIMS_STEP,
    inputs: [producerName],

    async execute(context: StepContext): Promise<ClaimExtractionOutcome | null> {
      const outcome = context.input<CorrectionOutcome>(producerName)
      // **It reads the draft Ryan APPROVED, and a rejection is not one** (E4-5, D21). A
      // rejection whose notes were all routed elsewhere ends the stage with the draft standing
      // exactly as it was, so there is nothing here that has been ruled into the episode — and
      // spending a paid reading on a draft he sent back would be money on prose he has already
      // said is wrong. Nothing downstream reads this step's output, so `null` is the honest
      // answer rather than an empty extraction pretending a reading happened.
      //
      // **A close is the same answer for the same reason** (E5-3, 0015): he put the draft
      // down, so nothing was approved into this episode and a paid reading of it would be
      // money spent on prose he has stopped on. `putsTheWorkDown` is the two verbs said once.
      if (putsTheWorkDown(outcome.verdict)) {
        context.progress(
          outcome.verdict === 'close'
            ? 'Nothing to read for canon claims — you closed the gate, so no draft was ' +
              'approved into this episode and none of it is claiming anything of canon yet.'
            : 'Nothing to read for canon claims — the draft was rejected and the notes were ' +
              'routed elsewhere, so no draft was approved into this episode.',
        )
        return null
      }

      const scope = claimScope(context.store, library, outcome.artifactId)
      const label = episodeLabel(scope.where.episode.number)
      const subject = `the ${label} ${scope.artifact.kind}`

      const filePath = join(
        scope.where.show.key,
        `s${pad(scope.where.season.number)}e${pad(scope.where.episode.number)}`,
        `${scope.artifact.kind}-claims-v${scope.artifact.version}.json`,
      )
      const onDisk = join(library.artifactDir, filePath)

      // Already read, at this version? Then nothing is re-read and nothing re-spent. A crash
      // between the call and the raising is exactly the case this exists for.
      let reply: string
      let called = false
      if (existsSync(onDisk)) {
        context.progress(
          `${capitalise(subject)} v${scope.artifact.version} has already been read for its ` +
            'claims — kept as it stands, and no second call made for it',
        )
        reply = readFileSync(onDisk, 'utf8')
      } else {
        context.progress(
          `Reading ${subject} v${scope.artifact.version} for what it claims of canon — ` +
            `${scope.subjects.length} ${scope.subjects.length === 1 ? 'entity' : 'entities'} in ` +
            `provenance, ${scope.positions.length} declared arc ` +
            `${scope.positions.length === 1 ? 'position' : 'positions'}, ${CLAIM_EXTRACTION.sentence}`,
        )
        const completion = await context.llm.complete({
          system: CLAIM_SYSTEM,
          prompt: claimPrompt(scope, label),
          maxTokens: CLAIM_MAX_TOKENS,
          effort: CLAIM_EFFORT,
        })
        reply = completion.text
        called = true
      }

      // Parsed and validated BEFORE the bytes land, the same way a script's scenes are
      // (`write-step.ts`): a reply nobody can read is not worth keeping, and failing before the
      // file is what makes the runner's retry buy a NEW reading rather than re-parse a broken
      // one three times.
      const extraction = parseClaimExtraction(reply, subject)
      const raised = raiseWhatItClaims(context.store, library, {
        artifactId: outcome.artifactId,
        extraction,
      })

      if (called) {
        mkdirSync(dirname(onDisk), { recursive: true })
        // Nothing this app writes may land on a file already there (D20) — belt and braces
        // with the check above, once for the money and once for the bytes.
        writeIfAbsent(onDisk, `${reply.trim()}\n`)
      }

      context.progress(raised.sentence)
      for (const skipped of raised.skipped) context.progress(skipped.because)
      return { ...raised, filePath, called }
    },
  }
}

// ── The prompt ─────────────────────────────────────────────────────────────────

const CLAIM_SYSTEM =
  'You read finished television scripts and report what they have asserted about the show’s ' +
  'world. You report what the script says and never what it implies, and you never decide ' +
  'anything: everything you report is put to the showrunner as a proposal for him to rule on. ' +
  'Return one JSON object and nothing else: no preamble, no code fence, no commentary.'

/**
 * The draft, **exactly the canon its provenance loads** (invariant 2), and the arc positions
 * it declares — composed out of the one `ClaimScope` the validation is held to, so the model
 * is asked for exactly what will be accepted and nothing else (`claim.ts`).
 *
 * The facts arrive with their ids in brackets for the reason the board's do: it makes a
 * citation in the answer a copy rather than a guess.
 */
function claimPrompt(scope: ClaimScope, label: string): string {
  return [
    `Show: “${scope.where.show.title}” · season ${scope.where.season.number}, episode ` +
      `${scope.where.episode.number}, “${scope.where.episode.title}”.`,
    '',
    '## The canon this script declares it touches',
    '',
    'These are the only entities you may say anything about, and the only facts loaded with',
    'them. Name an entity exactly as it is written here. Cite a fact by the id in brackets;',
    'never cite one that is not listed.',
    '',
    ...scope.subjects.flatMap((held) => [
      `### ${held.entity.name} — ${held.entity.categoryKey}${
        held.entity.aliases.length > 0 ? ` (also: ${held.entity.aliases.join(', ')})` : ''
      }`,
      ...(held.facts.length === 0
        ? ['- (canon says nothing about them yet)']
        : held.facts.map((fact) => `- [${fact.id}] ${fact.statement}`)),
      '',
    ]),
    '## The arc positions this episode declares',
    '',
    ...(scope.positions.length === 0
      ? [
          `${label} declares no position on any arc, so it is **vanilla**. Not every episode`,
          'advances an arc. Return an empty `landings` list; do not invent one.',
          '',
        ]
      : scope.positions.flatMap((position) => [
          `### ${position.arc.id} — “${position.arc.name}”, a ${position.arc.kind} arc`,
          position.arc.statement,
          `Waypoint ${position.waypoint.ordinal}, “${position.waypoint.name}”: ` +
            `${position.waypoint.description}`,
          `What landing it looks like: ${position.waypoint.landingCriteria}`,
          '',
        ])),
    '## The script',
    '',
    scope.text.trim(),
    '',
    '## What to return',
    '',
    ...SHAPE,
  ].join('\n')
}

/**
 * The shape, in the prompt rather than in a schema object — one system prompt, one user
 * prompt, one answer (llm/adapter.ts). **Every line here is a rule the parser enforces**, and
 * asking for anything looser would only produce replies that fail the step.
 *
 * The two hardest instructions are the two the app cannot check for itself. "Only what the
 * script states" is the difference between a claim and an inference, and an inference raised
 * as a proposal is a ruling asked for something nobody wrote. And the landing's subject is the
 * one genuinely open question in the whole answer — the schema cannot supply it, the arc does
 * not carry it, and it is stated here as the judgement it is (the E2-3 constraint).
 */
const SHAPE = [
  '```',
  '{',
  '  "claims": [{                     // [] when the script asserts nothing canon does not say',
  '    "entity": "Ilse Renn",         // exactly as named above. NOTHING ELSE MAY BE NAMED.',
  '    "statement": "…",              // ONE atomic, checkable thing this script has made true',
  '    "field": "",                   // the sheet field it belongs under, or ""',
  '    "quote": "…",                  // the words FROM THE SCRIPT that make it, copied exactly',
  '    "contradicts": "fact_…"        // omit unless the claim ARGUES with a fact listed above.',
  '                                   //   Not "is about the same subject as" — argues with:',
  '                                   //   both cannot be true of this show at once.',
  '  }],',
  '  "landings": [{                   // EXACTLY ONE per arc position listed above, and no more',
  '    "arc": "arc_…",                // the arc id above',
  '    "subject": "Ilse Renn",        // WHICH ENTITY this landing is a claim about. A landing',
  '                                   //   becomes a FACT, and a fact is about an entity — for a',
  '                                   //   character arc it is that character; for a story arc',
  '                                   //   it is whoever on the page the landing really reads',
  '                                   //   on. Nobody downstream can answer this; you can.',
  '    "quote": "…"                   // the words from the script where it lands',
  '  }]',
  '}',
  '```',
  '',
  'Report only what the script STATES. What it implies, hints at, or leaves open is not a',
  'claim: the showrunner is being asked to rule these into canon, and a ruling on something',
  'nobody wrote is a ruling on your reading rather than on his episode. A script that asserts',
  'nothing new returns an empty list, and that is a real answer.',
]

const pad = (n: number): string => String(n).padStart(2, '0')

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

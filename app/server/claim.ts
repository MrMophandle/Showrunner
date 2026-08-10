import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { proposeFactChange, proposeNewFact } from './canon-bench.ts'
import type { Store } from './db/store.ts'
import { positionsOf, type ArcPosition } from './domain/arc.ts'
import { findArtifact, provenanceOf, type Artifact } from './domain/artifact.ts'
import type { CanonEntity } from './domain/canon.ts'
import { landPosition, type Landing } from './domain/episode-canon.ts'
import { factsInScope, type Fact } from './domain/fact.ts'
import type { Proposal } from './domain/proposal.ts'
import { episodeInShow, episodeLabel, scenesOf, type EpisodeInShow, type Scene } from './domain/spine.ts'
import { sceneSpans } from './domain/text-check.ts'
import type { LibraryPaths } from './library.ts'
import { quotedLines } from './remediation.ts'

/**
 * **What writing does to canon** (E4-4, 1.2, D8) — the claims a landed draft makes, read out
 * of it and raised as proposals riding the episode.
 *
 * **Every line in this file RAISES. Nothing here rules, and nothing here writes canon.** It
 * imports no ruling verb — not `createProposalRulings`, not `ratify` — and the fact that it
 * does not is the enforcement, the same way `remediation.ts` enforces it (invariant 1). What
 * comes out the far end is rows in `proposal`, provisional claims riding ep02, and a `sweep`
 * (`domain/episode-canon.ts`) that will collect them when Ryan approves the episode.
 *
 * ## Nothing trusts the model — the board's rules, at the canon layer
 *
 * `domain/board.ts` set the pattern and this inherits it whole: an extraction is model
 * output, so every part of it is checked against something the app already knows before a
 * row is written. Four laws, and each is a refusal in words rather than a dropped element:
 *
 *   1. **A claim cites its span, and the span must resolve in the draft.** A quote nobody
 *      wrote is a claim about a script nobody wrote; there is nothing to salvage in it.
 *   2. **A claim's subject must be in the draft's PROVENANCE.** Invariant 2 runs backwards
 *      for a writer — the draft declares what it touched (E4-1) — so a claim about an entity
 *      the writer was never handed is a claim about canon nobody read. It fails the step
 *      loudly rather than raising a proposal Ryan would have to reject for a reason no
 *      screen could show him.
 *   3. **A claim already standing VERBATIM is not raised.** Canon already says it; a
 *      proposal to say it again is a ruling asked for nothing.
 *   4. **A claim that CONTRADICTS a standing fact is raised as a delta with its before.**
 *      The model names the fact by the id it was handed, and the id is checked against the
 *      very list the prompt gave it. The before is what makes it a delta rather than a
 *      second, silently disagreeing fact on the same sheet.
 *
 * A malformed answer fails the step. It is never a silent zero-claims pass, because a
 * zero-claims pass is a real and legal answer — a draft that invents nothing — and a broken
 * reply that rendered as one would tell Ryan the episode claimed nothing when nobody read it.
 * The runner's three attempts (invariant 5) are exactly the budget for a reply that came back
 * wrong, and then it is his with the attempt history.
 *
 * ## One scope, read twice — which is what makes law 2 and law 4 honest
 *
 * `claimScope` is composed once and handed to BOTH the prompt composer (`runner/claim-step.ts`)
 * and the validation below. So "an entity not in provenance" and "a fact not on the list" are
 * refusals against the exact list the model was given, rather than against a second query that
 * happens to agree today. A prompt built from one read and a parser built from another is the
 * failure `domain/write-context.ts` exists to prevent one layer up.
 *
 * ## The usage context is quoted, not cited — and by ONE composer
 *
 * The second of the five parts is "the passage that made it necessary" (1.2), and E3-5 already
 * ruled what that looks like: the span with the lines around it, blockquoted, with the span's
 * own line marked. `quotedLines` (remediation.ts) is that composer and this is its second
 * caller. A ruling on "Ilse keeps a second ledger" with nothing under it is a ruling on a
 * sentence; the same ruling with the three lines the scene spends on the drawer is a ruling on
 * the episode, which is what Ryan is being asked for.
 *
 * ## Landings: the E2-3 seam, wired at last
 *
 * A landing is a fact and a fact is about an ENTITY, but an arc carries no entity — so
 * `landPosition` takes the subject from its caller, and until this file there was no caller
 * (the fixture loader declares its pin and raises nothing, and E2-4 left it that way
 * deliberately). **The writer answers it, per position, at extraction time**: for a character
 * arc the character; for a story arc, whichever entity on the page the landing actually reads
 * on, which is a writing judgement and not a lookup. The same provenance law applies — a
 * subject the draft never touched is refused exactly like a claim's subject is.
 *
 * Every declared position must be answered and no other may be: an episode declaring two arcs
 * and getting one landing back has had one of its positions silently dropped, and a landing on
 * an arc it never declared is a pin nobody moved.
 */

// ── What comes back off the wire ────────────────────────────────────────────────

/** One thing the draft asserts about an entity it touched. */
export interface ExtractedClaim {
  /** An entity NAME or alias, from the provenance list the prompt handed over. */
  entity: string
  /** The claim, atomic and checkable — what canon would say once Ryan ruled it. */
  statement: string
  /** The sheet field it belongs under, when it belongs under one. */
  field?: string
  /** The words in the draft that make the claim. Must resolve in it. */
  quote: string
  /** A fact id from the list, when the claim argues with one. The delta's before. */
  contradicts?: string
}

/** What one declared arc position's landing reads on — the subject only the writer can pick. */
export interface ExtractedLanding {
  /** An arc id, from the declared positions the prompt handed over. */
  arc: string
  /** An entity NAME or alias, from the provenance list. The fact's subject. */
  subject: string
  /** The words in the draft that land the waypoint. Must resolve in it. */
  quote: string
}

export interface ClaimExtraction {
  claims: ExtractedClaim[]
  landings: ExtractedLanding[]
}

/**
 * The reply as a value, or a refusal naming what is wrong with it.
 *
 * `parseExtraction`'s shape (board.ts), for the reason that one has it: a reply that is not
 * JSON, or that carries neither of the two arrays, is not half an answer to be salvaged. Both
 * arrays are required even when both are empty — a draft that invents nothing and lands
 * nothing says so with `{"claims": [], "landings": []}`, and an answer that simply omits a key
 * is indistinguishable from a model that forgot it was asked.
 */
export function parseClaimExtraction(text: string, subject: string): ClaimExtraction {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim())
  const body = (fenced ? fenced[1]! : text).trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(
      `The answer about ${subject} did not come back as an extraction — it is not JSON. It ` +
        `began: “${body.slice(0, 80)}…”`,
    )
  }
  const shape = parsed as Partial<ClaimExtraction>
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(shape.claims)) {
    throw new Error(
      `The answer about ${subject} has no \`claims\` array. A draft that claims nothing says ` +
        'so with an empty one — an answer missing the key is an answer nobody read back, and ' +
        'raising nothing on the strength of it would tell the showrunner this episode touched ' +
        'no canon.',
    )
  }
  if (!Array.isArray(shape.landings)) {
    throw new Error(
      `The answer about ${subject} has no \`landings\` array. An episode that declares no arc ` +
        'position says so with an empty one; a missing key is silence about the waypoints this ' +
        'episode was written to land (D8).',
    )
  }
  return { claims: shape.claims, landings: shape.landings }
}

// ── The scope: what the prompt hands over, and what the parser is held to ───────

/** One entity the draft declares it touched, with everything loaded with it (invariant 2). */
export interface ClaimSubject {
  entity: CanonEntity
  /** `factsInScope` — own, inherited, and this episode's own riding claims (3.3). */
  facts: Fact[]
}

export interface ClaimScope {
  artifact: Artifact
  where: EpisodeInShow
  /** The draft, whole, off the volume (D2). */
  text: string
  scenes: Scene[]
  /** Provenance, in the order the artifact declares it. The only entities in play. */
  subjects: ClaimSubject[]
  /** Every arc position this episode declares — each one owes a landing. */
  positions: ArcPosition[]
}

/**
 * What the extraction reads and what it is allowed to say — composed once, and read by the
 * prompt and by the validation below. See the header: two reads of this would make the
 * refusals argue with the list the model was actually given.
 */
export function claimScope(store: Store, library: LibraryPaths, artifactId: string): ClaimScope {
  const artifact = findArtifact(store, artifactId)
  if (!artifact) throw new Error(`No such artifact: ${artifactId}`)
  const where = episodeInShow(store, artifact.episodeId)
  if (!where) throw new Error(`no such episode: ${artifact.episodeId}`)
  if (!artifact.filePath) {
    throw new Error(
      `The ${episodeLabel(where.episode.number)} ${artifact.kind} has never been produced, so ` +
        'there is nothing to read the episode’s claims out of.',
    )
  }

  return {
    artifact,
    where,
    text: readFileSync(join(library.artifactDir, artifact.filePath), 'utf8'),
    scenes: scenesOf(store, artifact.episodeId),
    subjects: provenanceOf(store, artifact.id).map((entity) => ({
      entity,
      facts: factsInScope(store, entity.id).inScope,
    })),
    positions: positionsOf(store, artifact.episodeId),
  }
}

// ── What the raising produced ──────────────────────────────────────────────────

/** One fact delta raised, and what it is about — the progress line and the test read these. */
export interface RaisedClaim {
  proposal: Proposal
  entityName: string
  statement: string
  /** The ratified fact it argues with, when it argues with one. Null when it only adds. */
  before: string | null
}

/** A claim the extraction made that raised nothing, and why — never silently dropped. */
export interface SkippedClaim {
  entityName: string
  statement: string
  because: string
}

export interface ClaimsRaised {
  artifactId: string
  /** Fact deltas riding the episode: provisional, visible to its checks, invisible to canon. */
  deltas: RaisedClaim[]
  /** One per declared arc position, with the subject the writer answered (D8). */
  landings: Landing[]
  skipped: SkippedClaim[]
  /** The episode room's own line, composed on the server where it has a test. */
  sentence: string
}

/**
 * **Raises what the draft claims, and stops.**
 *
 * The four laws in the header, in order, and then two calls: `proposeFactChange` for a claim
 * with a before and `proposeNewFact` for one without. Both are `canon-bench.ts`'s builders and
 * neither is re-implemented here, for the reason that file gives — two builders for one
 * payload eventually build two payloads, and the refusals a closed or provisional fact earns
 * must be the same wherever the claim came from.
 *
 * **Idempotent, and it has to be**: a step is re-run after a crash and this is one. Law 3 is
 * what makes it so — a claim raised by an earlier attempt is a provisional fact riding the
 * episode, `factsInScope` hands it back, and the second attempt skips it verbatim. Landings
 * are idempotent in `landPosition` itself, which stands on the landing already raised rather
 * than raising a second.
 *
 * Law 3 is applied twice for the same reason: the scope is read ONCE, before anything is
 * raised, so a model that said the same thing twice in one answer would slip past a check
 * that only looked at the store. The second reading is over what this pass has already
 * raised.
 */
export function raiseWhatItClaims(
  store: Store,
  library: LibraryPaths,
  request: { artifactId: string; extraction: ClaimExtraction },
): ClaimsRaised {
  const scope = claimScope(store, library, request.artifactId)
  const subject = `the ${episodeLabel(scope.where.episode.number)} ${scope.artifact.kind}`

  return store.transaction(() => {
    const deltas: RaisedClaim[] = []
    const skipped: SkippedClaim[] = []

    for (const claim of request.extraction.claims) {
      const held = requireInProvenance(scope, claim.entity, subject)
      const statement = requireStatement(claim, subject)
      const span = requireSpan(scope, claim.quote, statement, subject)

      const standing = held.facts.find((fact) => same(fact.statement, statement))
      if (standing) {
        skipped.push({
          entityName: held.entity.name,
          statement,
          because:
            `Canon already says “${standing.statement}” — the claim stands verbatim, so there ` +
            'is nothing for you to rule on.',
        })
        continue
      }
      // The same law, applied inside one answer. `held.facts` was read before any of this
      // raised anything, so a model that said the same thing twice would get two proposals
      // out of it and Ryan would rule one claim two evenings running.
      const twice = deltas.some(
        (raised) => raised.entityName === held.entity.name && same(raised.statement, statement),
      )
      if (twice) {
        skipped.push({
          entityName: held.entity.name,
          statement,
          because:
            'The extraction claimed this twice in one answer — raised once, and the second is ' +
            'the same ruling asked for again.',
        })
        continue
      }

      const before =
        claim.contradicts === undefined
          ? undefined
          : requireCitedFact(held, claim.contradicts, subject)

      const usageContext = usageContextFor(scope, span, {
        subject,
        statement,
        before: before?.statement,
      })

      if (before) {
        deltas.push({
          proposal: proposeFactChange(store, before.id, {
            statement,
            ...(claim.field !== undefined && claim.field !== '' && { field: claim.field }),
            usageContext,
            raisedBy: 'writer',
            episodeId: scope.artifact.episodeId,
            alternatives: CONTRADICTION_ALTERNATIVES,
          }),
          entityName: held.entity.name,
          statement,
          before: before.statement,
        })
        continue
      }

      deltas.push({
        proposal: proposeNewFact(store, held.entity.id, {
          statement,
          ...(claim.field !== undefined && claim.field !== '' && { field: claim.field }),
          usageContext,
          raisedBy: 'writer',
          episodeId: scope.artifact.episodeId,
          alternatives: ADDITION_ALTERNATIVES,
        }),
        entityName: held.entity.name,
        statement,
        before: null,
      })
    }

    const landings = landEveryDeclaredPosition(store, scope, request.extraction.landings, subject)
    return {
      artifactId: request.artifactId,
      deltas,
      landings,
      skipped,
      sentence: raisedSentence(subject, deltas, landings, skipped),
    }
  })
}

/**
 * The two other things Ryan could do with a claim that argues with canon, so the ruling is a
 * choice (1.2's fourth part). They are the two verbs beside `ratify`, said as what they mean
 * here: a contradiction is either the script's fault or the world's, and this proposal is the
 * claim that it is the world's.
 */
const CONTRADICTION_ALTERNATIVES = [
  'reject it — the script is what is wrong here, not the world; the note rides the next writer ' +
    'run and the draft is rewritten against it (3.3)',
  'defer it — leave canon standing and let the episode go on arguing with it until something ' +
    'forces the question',
]

const ADDITION_ALTERNATIVES = [
  'reject it — canon saying nothing about this is an answer, and the note says why it stays ' +
    'silent; the claim stops riding the episode',
  'defer it — park it until the episode is approved, and the completion sweep asks again',
]

// ── The four laws ──────────────────────────────────────────────────────────────

/**
 * Law 2. **An entity the writer was never handed can never enter provenance** (E4-1), so a
 * claim about one is a claim about canon nobody read — and refusing it here is the difference
 * between a step that failed loudly and a queue with a proposal in it that no screen can
 * explain.
 */
function requireInProvenance(scope: ClaimScope, name: string, subject: string): ClaimSubject {
  const wanted = (name ?? '').trim().toLowerCase()
  const held = scope.subjects.find((one) =>
    [one.entity.name, ...one.entity.aliases].some((alias) => alias.toLowerCase() === wanted),
  )
  if (!held) {
    throw new Error(
      `The extraction claims about “${name}”, and ${subject} does not declare it touches ` +
        'anybody by that name. A writer declares provenance out of what it WROTE (E4-1), and a ' +
        'claim about an entity the writer was never handed is a claim about canon nobody read. ' +
        `${subject} touches: ${scope.subjects.map((one) => one.entity.name).join(', ') || 'nothing'}.`,
    )
  }
  return held
}

function requireStatement(claim: ExtractedClaim, subject: string): string {
  const statement = (claim.statement ?? '').trim()
  if (statement === '') {
    throw new Error(
      `The extraction raised a claim about ${subject} with no statement on it. A fact is one ` +
        'atomic, checkable thing canon would say; an empty one is not something to rule.',
    )
  }
  return statement
}

/**
 * Law 1. The span, located in the draft that is on the volume right now.
 *
 * There is no "quoted as the check recorded it" fallback here, and the difference from
 * `remediation.ts` is the whole reason: a finding's span may have been rewritten away between
 * the reading and the ruling, but an extraction reads the draft it is quoting, in the same
 * step, seconds earlier. A quote that does not resolve is not a stale record — it is words
 * nobody wrote.
 */
function requireSpan(
  scope: ClaimScope,
  quote: string,
  statement: string,
  subject: string,
): { from: number; to: number } {
  const wanted = (quote ?? '').trim()
  const at = wanted === '' ? -1 : scope.text.indexOf(wanted)
  if (at < 0) {
    throw new Error(
      `The extraction cites “${wanted}” as the passage that claims “${statement}”, and those ` +
        `words are not in ${subject}. A claim quotes the line that makes it, from the draft ` +
        'itself — a citation that does not resolve is a claim about a script nobody wrote.',
    )
  }
  return { from: at, to: at + wanted.length }
}

/**
 * Law 4's half that is not the model's to decide: the cited fact has to be one the prompt
 * actually handed over for this entity. Whether a fact may carry a delta at all — closed,
 * provisional — is `proposeFactChange`'s refusal and is deliberately not re-worded here, so
 * the sentence Ryan reads is the same one the bench's disabled button shows.
 */
function requireCitedFact(held: ClaimSubject, factId: string, subject: string): Fact {
  const cited = held.facts.find((fact) => fact.id === factId)
  if (!cited) {
    throw new Error(
      `The extraction says a claim about “${held.entity.name}” contradicts ${factId}, which is ` +
        `not among the facts ${subject} was handed for them. Facts are cited by the id in ` +
        'brackets and never invented: an id off the list is a contradiction with something ' +
        'nobody loaded.',
    )
  }
  return cited
}

/** Whitespace is formatting; everything else is the claim. "Standing verbatim" means this. */
const same = (one: string, other: string): boolean => normalise(one) === normalise(other)

const normalise = (statement: string): string => statement.trim().replace(/\s+/g, ' ')

// ── The landings (D8, the E2-3 seam) ───────────────────────────────────────────

/**
 * One landing per declared position, with the subject the writer answered — and a refusal for
 * every way that correspondence can be wrong.
 *
 * All three refusals are the same rule from three sides: a position is a thing Ryan declared
 * this episode would land, and the extraction's job is to say what each one reads on. It is
 * not the extraction's job to decide WHICH arcs this episode is on — that is a declared
 * position, and the door for declaring one is on the canon bench.
 */
function landEveryDeclaredPosition(
  store: Store,
  scope: ClaimScope,
  answered: ExtractedLanding[],
  subject: string,
): Landing[] {
  const declared = new Map(scope.positions.map((position) => [position.arc.id, position]))
  const seen = new Set<string>()

  for (const landing of answered) {
    const arcId = (landing.arc ?? '').trim()
    if (!declared.has(arcId)) {
      throw new Error(
        `The extraction lands an arc “${arcId}” that ` +
          `${episodeLabel(scope.where.episode.number)} declares no position on. A landing is a ` +
          'claim that a waypoint Ryan pinned has been reached; an arc nobody pinned has no ' +
          'waypoint for this episode to have reached.',
      )
    }
    if (seen.has(arcId)) {
      throw new Error(
        `The extraction lands “${declared.get(arcId)!.arc.name}” twice. One episode declares ` +
          'one position per arc, so there is one landing to answer for it.',
      )
    }
    seen.add(arcId)
  }

  const missed = scope.positions.filter((position) => !seen.has(position.arc.id))
  if (missed.length > 0) {
    throw new Error(
      `${episodeLabel(scope.where.episode.number)} declares a position on ` +
        `${missed.map((position) => `“${position.arc.name}”`).join(', ')} and the extraction ` +
        'answered nothing for it. A landing is a fact and a fact is about an ENTITY, and which ' +
        'entity a landing reads on is the writer’s judgement — nobody else can supply it ' +
        '(the E2-3 constraint). An unanswered position is a waypoint nobody said anything about.',
    )
  }

  return answered.map((landing) => {
    const position = declared.get(landing.arc.trim())!
    const held = requireInProvenance(scope, landing.subject, subject)
    const span = requireSpan(
      scope,
      landing.quote,
      `“${position.arc.name}” reached waypoint ${position.waypoint.ordinal}`,
      subject,
    )
    return landPosition(store, {
      episodeId: scope.artifact.episodeId,
      arcId: position.arc.id,
      waypointId: position.waypoint.id,
      subject: held.entity.id,
      raisedBy: 'writer',
      usageContext: landingContextFor(scope, span, position, held.entity),
    })
  })
}

// ── The usage context: the second of the five parts (1.2) ──────────────────────

/**
 * The span with the lines around it, then what the draft claimed with it — through
 * `quotedLines`, which is the ONE composer in this app for "a passage, quoted" (remediation.ts
 * owns it and this is its second caller).
 *
 * The scene is named where there is one, because a scene is how everything else in this app
 * says which part of an episode it means (`domain/delineate.ts`).
 */
function usageContextFor(
  scope: ClaimScope,
  span: { from: number; to: number },
  said: { subject: string; statement: string; before?: string },
): string {
  return [
    `${said.subject}${whereIn(scope, span)} reads:`,
    '',
    quotedLines(scope.text, span),
    '',
    `The draft claims with the marked line: “${said.statement}”`,
    '',
    said.before === undefined
      ? 'Canon has said nothing about it so far, and every artifact written until now was ' +
        'checked against that silence.'
      : `Canon says “${said.before}” — so this is the world changing rather than the script ` +
        'agreeing with it, and it is raised as a delta carrying that fact as its before.',
  ].join('\n')
}

/** The same passage, under a waypoint — with the criteria Ryan wrote for landing it (D24). */
function landingContextFor(
  scope: ClaimScope,
  span: { from: number; to: number },
  position: ArcPosition,
  subject: CanonEntity,
): string {
  return [
    `${episodeLabel(scope.where.episode.number)}${whereIn(scope, span)} reads:`,
    '',
    quotedLines(scope.text, span),
    '',
    `The draft lands “${position.arc.name}” at waypoint ${position.waypoint.ordinal}, ` +
      `“${position.waypoint.name}”, and the writer answers that it reads on ${subject.name}.`,
    '',
    `What you wrote that landing it looks like: ${position.waypoint.landingCriteria}`,
  ].join('\n')
}

/** " · scene 2", or the artifact alone when the span sits outside every scene. */
function whereIn(scope: ClaimScope, span: { from: number; to: number }): string {
  const sitting = sceneSpans(scope.text, scope.scenes).find(
    (scene) => span.from >= scene.from && span.from < scene.to,
  )
  return sitting ? ` · scene ${sitting.scene.ordinal}` : ''
}

// ── The sentence ───────────────────────────────────────────────────────────────

/** "The ep02 script claims 2 things of canon — 1 delta, 1 waypoint landing. None is ruled." */
function raisedSentence(
  subject: string,
  deltas: RaisedClaim[],
  landings: Landing[],
  skipped: SkippedClaim[],
): string {
  const raised = landings.filter((landing) => landing.raised)
  const parts: string[] = []
  if (deltas.length > 0) {
    const contradicting = deltas.filter((delta) => delta.before !== null).length
    parts.push(
      `${deltas.length} fact delta${deltas.length === 1 ? '' : 's'}` +
        (contradicting === 0 ? '' : ` (${contradicting} with a before)`),
    )
  }
  if (raised.length > 0) {
    parts.push(`${raised.length} waypoint landing${raised.length === 1 ? '' : 's'}`)
  }

  const already = skipped.length === 0 ? '' : ` ${skipped.length} already stood verbatim.`
  if (parts.length === 0) {
    return (
      `${capitalise(subject)} claims nothing canon does not already say — nothing raised, and ` +
      `no canon written.${already}`
    )
  }
  return (
    `${capitalise(subject)} raises ${parts.join(' and ')}, riding the episode — provisional, ` +
    `visible to its own checks and invisible to canon until you rule them.${already}`
  )
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

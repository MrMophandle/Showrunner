import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../db/store.ts'
import type { LibraryPaths } from '../library.ts'
import type { NoteDepth } from '../runner/gate.ts'
import {
  arcsOf,
  positionsOf,
  waypointsOf,
  type Arc,
  type ArcPosition,
  type ArcWaypoint,
} from './arc.ts'
import { findArtifact, provenanceOf, type Artifact, type ArtifactKind } from './artifact.ts'
import { landsOn, routedNotesTo } from './routing.ts'
import { entitiesOfShow, type CanonEntity } from './canon.ts'
import { factsInScope, factsOfEntity, findFact, type Fact } from './fact.ts'
import { dismissalNotes, type CheckGapReason } from './finding.ts'
import { episodeLabel, episodeInShow, type EpisodeInShow } from './spine.ts'

/**
 * The writer's desk (E4-0, 1.1–1.2, 4.4): **everything a writing step is handed, composed
 * fresh out of records five epics already laid down.**
 *
 * Nothing here calls a model, writes a row, or caches an answer. It is one function — the
 * premise step, the outline step and the script step all call it, and the only thing the
 * step decides is which artifact it reads from. If a later session finds itself writing a
 * second composer for one of the three, the parameterization has failed the way a second
 * parser would have failed E3-2.
 *
 * **Computed, never remembered.** There is no `write_context` table and there must never be
 * one: a cached desk is stale the moment Ryan dismisses a finding, rejects a round, or
 * ratifies a proposal, and the failure would be silent — a writer arguing against a note
 * that has been answered. The shape is artifact freshness's (1.3) and arc drift's (D8), one
 * layer up.
 *
 * ## Canon as the AUDIENCE of this episode knows it — the rule, in one sentence
 *
 * > A fact reaches ep**N**'s desk when its own lineage is already on screen — no
 * > establishing episode at all (founding or the bench: show-level canon, the audience's
 * > from the start), or an establishing episode that is epN itself or runs before it — and
 * > when whatever ENDED it is not: a supersession is dated by its successor's lineage, and a
 * > closure with no successor is a revert, which is a correction to the record and lands
 * > everywhere. A provisional claim is the one exception in both directions: it reaches the
 * > desk only while riding THIS episode, and never another's.
 *
 * **It is a lineage question, never a clock question, and that is the whole difficulty.**
 * `canonAsOf(now)` is wrong here and `canonAsOf({ruling: R})` is wrong here too. Episodes
 * parallelize (D7): ep03 can be ratified on a Tuesday while ep02 is being written, so its
 * rulings sit BELOW any ceiling ep02 could pick and a ceiling would hand ep02's writer next
 * month's episode. `canon_ruling.seq` orders Ryan's opinions; it does not order the show.
 *
 * Four consequences fall out of the sentence rather than being coded beside it, and each has
 * a test:
 *
 *   * a fact ep01 established is on ep02's desk;
 *   * a fact ep03 established is not, though `canonAsOf(now)` shows it;
 *   * a fact ruled at the bench, riding no episode, is on every desk — show-level canon is
 *     the audience's to know, and a FIRST episode's desk is exactly that plus nothing else;
 *   * ep02's own provisional claims are on ep02's desk, so scene 9 cannot contradict what
 *     scene 4 established (1.2), and no other episode's ever are.
 *
 * And the fifth, which is why own facts are read from the entity's whole history rather than
 * from what stands now: a fact ep01 established and ep03 superseded is still what the ep02
 * audience knows. Reading only open facts would leave ep02's writer holding neither version.
 *
 * **Two things this deliberately does not do.** An abandoned earlier episode's ratified facts
 * stay on the desk — abandonment RAISES a revert per fact (3.3) and only Ryan ruling one
 * takes canon away, so a composer that dropped them would be removing canon nobody ruled on.
 * And INHERITED facts (D22) come through `factsInScope`, which reads what stands now, so a
 * species fact a future episode superseded is not recovered the way an own fact is. That
 * narrowing is named rather than hidden; the fix is a lineage-aware read inside fact.ts, not
 * a second inheritance traversal in this file.
 *
 * ## The entity slice, and why the composition confesses it
 *
 * A writer is not a check. Invariant 2's "exactly the entities in scope" is defined by
 * PROVENANCE for checking — but a writer WRITES the provenance, so the question runs the
 * other way and there is no declaration to read. Three doors, and the whole bible is not one
 * of them:
 *
 *   1. **provenance** — what the upstream artifact declares it touches, and what the draft
 *      this step is rewriting already declared. The second half is what stops a rewrite
 *      forgetting a character the last draft invented.
 *   2. **named** — every entity whose name or alias appears in the upstream text. Lexical,
 *      and deliberately so: it is the only signal that exists before a model has read
 *      anything, it is cheap, and it is auditable — the matched term is recorded. It misses
 *      an unnamed reference and it over-includes a coincidence; both are visible in the
 *      record rather than argued about afterwards.
 *   3. **core** — every entity the show declares core-standing. **This is the door the house
 *      style and the world rules come through, and there is no fourth door for them.** They
 *      are entities in categories a show declares as data (3.2), so a composer that reached
 *      for `house-style` or `world-rules` by key would hardcode two categories into a system
 *      whose whole point is that adding one is an edit — the line `text-check.ts` already
 *      holds. Nothing in this file knows either word. A show whose house style is not
 *      core-standing does not get it, and `leftOut` says exactly that.
 *
 * A caller may **add** an entity outright, recorded as its own reason. Four reasons, all of
 * them kept, because E4-7's "what the writer was handed" inspector renders them.
 *
 * `leftOut` is the other half and the more important one: every entity of the show that did
 * NOT make the slice, with the rule that kept it out in words. "Why did the writer not know
 * about X" has to be answerable from the composed value with no archaeology (4.6), and it is
 * not answerable from a list of what was included. It carries identity only — no prose, no
 * facts — so a prompt composer iterating the slice cannot leak it into a call.
 *
 * ## Notes: one record, many readers, and the origin travels with them
 *
 * There is no note table here and there must never be one. A rejection note is a `gate_note`
 * row (E1-4); a dismissal note is a `finding_disposition` row read by `dismissalNotes`
 * (E3-5), the same rows the checks read. This is the third reader of the second, after the
 * panel and cried-wolf. Both arrive in ONE stream carrying where they came from — which
 * gate, which round, which routing depth; which finding, which check, which episode — so a
 * prompt can say "your round-2 rejection said X" rather than flattening two different acts
 * into a bag of sentences. E4-5's routed rejects land in this same stream by adding an origin,
 * not a list.
 *
 * The gate rows are read here with SQL rather than through `runner/gate.ts`, for the reason
 * `proposal.ts` states where it reads the same table: **the domain does not depend on the
 * runner.** The one thing taken from it is the erased TYPE of the `depth` column, because a
 * second `NOTE_DEPTH` vocabulary would be two names for one thing.
 */

/**
 * The three steps of the writing line, in the order it runs (1.1). A const array and a
 * union, never a TS `enum` — the server runs its TypeScript under Node's type stripping.
 *
 * **This is the only thing that varies by step, and all it decides is which artifact is
 * upstream** — which falls out of the order rather than being a second table to keep in
 * step with this one. Adding a step is a code change with a test (the Archon rule).
 */
export const WRITE_STEP = ['premise', 'outline', 'script'] as const
export type WriteStep = (typeof WRITE_STEP)[number]

/** What each step produces. Its upstream is what the step before it produces. */
const PRODUCES: Record<WriteStep, ArtifactKind> = {
  premise: 'premise-brief',
  outline: 'outline',
  script: 'script',
}

/**
 * The artifact kind a writing step writes.
 *
 * Exported because the STEP needs the same answer this file already computes: a producer
 * has to know which artifact to file, and the composer has to know which one is upstream of
 * the next. One map, read twice — a second `Record<WriteStep, ArtifactKind>` beside a stage
 * would be the one that drifts, and it would drift silently into a step writing an artifact
 * the next step does not read.
 */
export const producedBy = (step: WriteStep): ArtifactKind => PRODUCES[step]

export interface WriteContextRequest {
  episodeId: string
  step: WriteStep
  /**
   * Entities to put on the desk whatever the slice rule says — a landing's subject, or
   * something Ryan pinned. Recorded as `added`, never silently merged into another reason.
   */
  include?: readonly string[]
}

/** Which door an entity came through. Kept in this order wherever reasons are listed. */
export const INCLUSION_REASON = ['provenance', 'named', 'core', 'added'] as const
export type InclusionReason = (typeof INCLUSION_REASON)[number]

export interface Inclusion {
  reason: InclusionReason
  /** The words: which artifact declared it, which term named it, which standing. */
  because: string
}

/**
 * Which door in TIME a fact came through — the audience-knowledge rule, made renderable.
 * `riding` is the provisional claim of this very episode; the other three are canon.
 */
export const FACT_REACH = [
  'show-level',
  'established-earlier',
  'established-here',
  'riding',
] as const
export type FactReach = (typeof FACT_REACH)[number]

export interface ContextFact {
  fact: Fact
  reach: FactReach
  /** Where it travelled from (D22), or null when the fact is the entity's own. */
  inherited: { source: CanonEntity; via: string } | null
}

/**
 * A fact-carrying edge that brought nothing, and which nothing it was. A writer told "her
 * species is undecided" writes differently from one told nothing at all (invariant 4, one
 * layer off the checks).
 *
 * The vocabulary is `CheckGapReason`, borrowed rather than re-declared: a gap on the desk and
 * a gap in a check's scope are the same three kinds of nothing, out of the same
 * `factsInScope` edges, and a third copy of that closed set would be a third name for one
 * thing. This filter adds no fourth case — a source whose facts are all still in the future
 * is a source carrying nothing THIS audience knows, which is `source-has-no-facts` said
 * exactly, and the `because` is where that gets said in words.
 */
export interface ContextGap {
  /** The declared relation type whose far end was empty. */
  via: string
  reason: CheckGapReason
  because: string
}

export interface EntityInContext {
  entity: CanonEntity
  /** Every door it came through, in `INCLUSION_REASON` order. Never empty. */
  reasons: Inclusion[]
  /** Its own facts first, then what it inherits — all of them audience-filtered. */
  facts: ContextFact[]
  gaps: ContextGap[]
}

/**
 * An entity of this show that did not make the slice. Identity and the rule that kept it
 * out, and deliberately nothing else — this is the answer to "why did the writer not know
 * about X", not a second copy of the bible.
 */
export interface EntityLeftOut {
  id: string
  name: string
  categoryKey: string
  status: CanonEntity['status']
  because: string
}

/** What the step reads from, and which kind of nothing it is when there is nothing. */
export interface Upstream {
  /** The artifact kind the step before this one produces. NULL for the premise step. */
  expected: ArtifactKind | null
  artifact: Artifact | null
  /** Its text off the volume. */
  text: string | null
  /** Why there is no text, when there is none. NULL when there is. */
  note: string | null
}

export interface ArcInContext {
  arc: Arc
  waypoints: ArcWaypoint[]
  /** This episode's declared position, or null. Null on every arc is vanilla (1.1). */
  position: ArcPosition | null
}

/**
 * Where a note came from. A discriminated union so a third origin is an arm, not a list —
 * and E4-5 is the third.
 *
 * The three are three different AUTHORITIES and a writer's prompt has to be able to say which:
 * "your round-2 rejection of this draft" is Ryan's opinion of the thing being rewritten;
 * "your note from the ep02 script gate, routed here" is his opinion of THIS artifact, given
 * while he was standing at a later one (D21); "a finding you dismissed" is his ruling on a
 * check, which is a different act again. Flattened into a bag of sentences they would all read
 * as instructions with no provenance.
 */
export type NoteOrigin =
  | {
      kind: 'gate-rejection'
      gateId: string
      artifactId: string
      round: number
      depth: NoteDepth | null
      target: string | null
      /**
       * Which verb wrote it (0015). The AUTHORITY is the same — Ryan, at this artifact's own
       * gate, about the thing being rewritten — which is why a close is not a fourth origin;
       * what differs is what he did next, and a writer told "he rejected round 2" when he
       * actually stopped is being handed the wrong instruction in the right words.
       */
      verdict: 'reject' | 'close'
    }
  | {
      /** Written at another artifact's gate and addressed HERE (E4-5, `domain/routing.ts`). */
      kind: 'routed-rejection'
      gateId: string
      round: number
      depth: NoteDepth
      /** The artifact the gate was over — where he was standing when he wrote it. */
      fromArtifactId: string
      fromKind: ArtifactKind
      /** The version THIS artifact stood at when the note landed. */
      routedAtVersion: number
      /** A newer version of this artifact exists. Computed, never a flag. */
      addressed: boolean
    }
  | {
      kind: 'finding-dismissal'
      findingId: string
      checkKey: string
      quote: string
      episodeId: string
      entityId: string | null
    }

export interface WriteNote {
  note: string
  /** For humans and for the ordering below. Never an identity. */
  at: string
  /** "your round 2 rejection of the ep02 outline, routed at scene depth". */
  sentence: string
  origin: NoteOrigin
}

/** Everything a writing step sees. A value a surface renders, and E4-7's panel depends on it. */
export interface WriteContext {
  step: WriteStep
  where: EpisodeInShow
  /** The artifact this step produces, when a draft of it already exists. */
  producing: Artifact | null
  upstream: Upstream
  entities: EntityInContext[]
  leftOut: EntityLeftOut[]
  arcs: ArcInContext[]
  /** No declared position on any arc — legal, tracked, never a failure state (1.1). */
  vanilla: boolean
  /** Rejections and dismissals in one stream, newest first. */
  notes: WriteNote[]
  sentence: string
}

// ── The composition ─────────────────────────────────────────────────────────────

export function composeWriteContext(
  store: Store,
  library: LibraryPaths,
  request: WriteContextRequest,
): WriteContext {
  const where = episodeInShow(store, request.episodeId)
  if (!where) throw new Error(`No such episode: ${request.episodeId}`)

  const onScreen = episodesOnScreen(store, where)
  const producing = artifactOf(store, where.episode.id, PRODUCES[request.step])
  const upstream = readUpstream(store, library, where, request.step)

  const entities = entitiesOfShow(store, where.show.id)
  const doors = slice(store, { where, upstream, producing, entities, include: request.include })

  // The audience-knowledge rule, bound once and handed to every read below — own facts and
  // inherited facts alike, because a species fact from the future is as wrong on this desk
  // as one of the character's own.
  const known = (fact: Fact): boolean => audienceKnows(store, fact, where.episode.id, onScreen)

  const inScope: EntityInContext[] = []
  const leftOut: EntityLeftOut[] = []
  for (const entity of entities) {
    const reasons = doors.get(entity.id)
    if (reasons === undefined) {
      leftOut.push({
        id: entity.id,
        name: entity.name,
        categoryKey: entity.categoryKey,
        status: entity.status,
        because: keptOut(entity, where, upstream),
      })
      continue
    }
    inScope.push({ entity, reasons, ...factsAndGaps(store, entity, known, where) })
  }

  const arcs = arcsInContext(store, where)
  const notes = notesFor(store, where, producing)

  return {
    step: request.step,
    where,
    producing,
    upstream,
    entities: inScope,
    leftOut,
    arcs,
    vanilla: arcs.every((arc) => arc.position === null),
    notes,
    sentence: deskSentence(request.step, where, upstream, inScope, leftOut, arcs, notes),
  }
}

// ── Canon as the audience knows it ──────────────────────────────────────────────

/**
 * Every episode of this show already on screen when this one is written: everything before
 * it in the running order, and itself. Ordered by season then number, which is the order an
 * audience watches in and the only order that means anything here — `canon_ruling.seq` is
 * the order RYAN ruled in, and the two come apart the moment two episodes are in flight.
 */
function episodesOnScreen(store: Store, where: EpisodeInShow): Set<string> {
  const rows = store.all<{ id: string }>(
    `SELECT e.id
       FROM episode e
       JOIN season s ON s.id = e.season_id
      WHERE s.show_id = ?
        AND (s.number < ? OR (s.number = ? AND e.number <= ?))
      ORDER BY s.number, e.number`,
    where.show.id,
    where.season.number,
    where.season.number,
    where.episode.number,
  )
  return new Set(rows.map((row) => row.id))
}

/** Whether a lineage is already on screen. No establishing episode is show-level canon. */
const lineageOnScreen = (establishedIn: string | null, onScreen: Set<string>): boolean =>
  establishedIn === null || onScreen.has(establishedIn)

/** The rule in the module header, as code. Every other reader of a fact goes through it. */
function audienceKnows(
  store: Store,
  fact: Fact,
  episodeId: string,
  onScreen: Set<string>,
): boolean {
  if (fact.ratifiedBy === null) {
    // A claim nobody has ruled. It reaches the desk only while riding THIS episode, and a
    // closed one has been put down by a rejection or a deferral, or has become the canon
    // fact that succeeded it — either way what stands is the successor, not the claim.
    return fact.establishedIn === episodeId && fact.closure === null
  }
  if (!lineageOnScreen(fact.establishedIn, onScreen)) return false
  if (fact.closure === null) return true

  // Closed. A supersession is dated by what replaced it, so a change a future episode made
  // has not reached this audience and the fact it replaced is still what they know. A
  // closure with NO successor is a revert (3.3) — a correction to the record rather than
  // something that happened on screen — and it lands on every desk at once.
  if (fact.closure.supersededBy === null) return false
  const successor = findFact(store, fact.closure.supersededBy)
  return successor !== undefined && !lineageOnScreen(successor.establishedIn, onScreen)
}

const reachOf = (fact: Fact, episodeId: string): FactReach => {
  if (fact.ratifiedBy === null) return 'riding'
  if (fact.establishedIn === null) return 'show-level'
  return fact.establishedIn === episodeId ? 'established-here' : 'established-earlier'
}

/**
 * What this entity brings to the desk: its own facts across its whole history, filtered;
 * then what travels a declared fact-carrying edge into it (D22), filtered the same way.
 *
 * The own half reads `factsOfEntity` — the history — because a fact a future episode
 * superseded is still what this audience knows, and a read of what stands now cannot say
 * so. The inherited half comes off `factsInScope`, which owns the traversal, the
 * cardinality and the D22 exceptions; re-deriving any of that here is the rebuild this
 * issue exists not to do.
 */
function factsAndGaps(
  store: Store,
  entity: CanonEntity,
  known: (fact: Fact) => boolean,
  where: EpisodeInShow,
): { facts: ContextFact[]; gaps: ContextGap[] } {
  const facts: ContextFact[] = factsOfEntity(store, entity.id)
    .filter(known)
    .map((fact) => ({ fact, reach: reachOf(fact, where.episode.id), inherited: null }))

  const gaps: ContextGap[] = []
  const label = episodeLabel(where.episode.number)

  for (const edge of factsInScope(store, entity.id).inheritance) {
    if (edge.source === null) {
      gaps.push({
        via: edge.type.name,
        reason: edge.case === 'declared-unknown' ? 'declared-unknown' : 'undeclared',
        because:
          edge.case === 'declared-unknown'
            ? `\`${edge.type.name}\` is declared unknown — somebody looked, and the ` +
              'world has not decided'
            : `no \`${edge.type.name}\` is declared on the sheet`,
      })
      continue
    }

    const travelled = edge.facts.filter(known)
    if (travelled.length === 0) {
      gaps.push({
        via: edge.type.name,
        reason: 'source-has-no-facts',
        because: `“${edge.source.name}” carries no facts the ${label} audience knows`,
      })
      continue
    }
    for (const fact of travelled) {
      facts.push({
        fact,
        reach: reachOf(fact, where.episode.id),
        inherited: { source: edge.source, via: edge.type.name },
      })
    }
  }

  return { facts, gaps }
}

// ── The entity slice ────────────────────────────────────────────────────────────

/** Every entity that made the slice, and every door it came through, in reason order. */
function slice(
  store: Store,
  what: {
    where: EpisodeInShow
    upstream: Upstream
    producing: Artifact | null
    entities: CanonEntity[]
    include: readonly string[] | undefined
  },
): Map<string, Inclusion[]> {
  const doors = new Map<string, Inclusion[]>()
  const open = (entityId: string, reason: InclusionReason, because: string): void => {
    doors.set(entityId, [...(doors.get(entityId) ?? []), { reason, because }])
  }

  const number = what.where.episode.number
  for (const source of [what.upstream.artifact, what.producing]) {
    if (!source) continue
    for (const entity of provenanceOf(store, source.id)) {
      open(entity.id, 'provenance', `the ${subjectLabel(number, source)} declares it`)
    }
  }

  if (what.upstream.text !== null && what.upstream.artifact !== null) {
    const text = what.upstream.text
    for (const entity of what.entities) {
      const term = nameAppearingIn(text, entity)
      if (term !== undefined) {
        open(
          entity.id,
          'named',
          `“${term}” appears in the ${subjectLabel(number, what.upstream.artifact)}`,
        )
      }
    }
  }

  for (const entity of what.entities) {
    if (entity.standing === 'core') open(entity.id, 'core', 'standing core')
  }

  // Refused rather than dropped. The slice below is built by walking this show's entities,
  // so an id from somewhere else would vanish silently — and a caller that asked for an
  // entity and did not get it is exactly the "why did the writer not know about X" this
  // whole record exists to answer.
  const ofThisShow = new Set(what.entities.map((entity) => entity.id))
  for (const entityId of what.include ?? []) {
    if (!ofThisShow.has(entityId)) {
      throw new Error(
        `${what.where.show.title} has no canon entity ${entityId}, so the ${
          what.where.episode.title
        } desk cannot be handed it.`,
      )
    }
    open(entityId, 'added', 'the caller added it')
  }

  // Reason order, not discovery order: a rendered list of doors that changed order with the
  // shape of a premise would make two desks look different for no reason.
  for (const [entityId, reasons] of doors) {
    doors.set(
      entityId,
      [...reasons].sort(
        (a, b) => INCLUSION_REASON.indexOf(a.reason) - INCLUSION_REASON.indexOf(b.reason),
      ),
    )
  }
  return doors
}

/** The rule that kept an entity off the desk, in the words the inspector renders. */
function keptOut(entity: CanonEntity, where: EpisodeInShow, upstream: Upstream): string {
  const label =
    upstream.artifact === null
      ? null
      : subjectLabel(where.episode.number, upstream.artifact)

  const clauses = [
    label === null
      ? 'nothing upstream declares provenance'
      : `not in the ${label}’s provenance`,
    label === null || upstream.text === null
      ? 'nothing upstream to be named in'
      : 'not named in it',
    `standing ${entity.standing ?? 'undeclared'} · status ${entity.status}, so not core`,
  ]
  return clauses.join(', ')
}

/**
 * The name or alias of this entity that appears in the text, or undefined — the `named`
 * door's whole rule, and the one place this app decides what "named in" means.
 *
 * **Exported because a writing step needs it pointing the other way.** The desk names
 * entities out of what it READS; a producer has to declare provenance out of what it WROTE
 * (invariant 2), and there is no upstream to read for the draft it just made. Two matchers
 * would make "named in the upstream" and "named in the draft" quietly different questions —
 * the second-parser failure, at the lexical layer. So the caller is lent this one, and the
 * term it answers with is what a reason (or a provenance record) quotes.
 */
export function nameAppearingIn(
  text: string,
  entity: { name: string; aliases: readonly string[] },
): string | undefined {
  return [entity.name, ...entity.aliases].find((one) => appearsIn(text, one))
}

/**
 * Whether a name or an alias actually appears. Bounded on both sides by letters and digits
 * rather than by `\b`, so "the harbour" does not match inside "the harbourmaster" and a term
 * that ends in punctuation still matches at all. Case-insensitive; the term is escaped
 * because an entity is named by a person, not by a regular expression.
 */
function appearsIn(text: string, term: string): boolean {
  if (term.trim() === '') return false
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text)
}

// ── The upstream artifact ───────────────────────────────────────────────────────

/**
 * What this step writes from, read off the volume — the same read `operating.ts` does at a
 * gate, and for the same reason: a desk hands over the premise, not its path (D15). The
 * three ways there can be no text are three different pieces of news and each says which.
 *
 * The path comes off the artifact ROW. Nothing a caller passes chooses which file is opened.
 */
function readUpstream(
  store: Store,
  library: LibraryPaths,
  where: EpisodeInShow,
  step: WriteStep,
): Upstream {
  const previous = WRITE_STEP[WRITE_STEP.indexOf(step) - 1]
  if (previous === undefined) {
    return {
      expected: null,
      artifact: null,
      text: null,
      note:
        'The premise step reads from nothing — it is the first step of the line, and ' +
        'what it writes from is the canon and the arcs below.',
    }
  }

  const expected = PRODUCES[previous]
  const artifact = artifactOf(store, where.episode.id, expected)
  const label = episodeLabel(where.episode.number)
  if (!artifact) {
    return {
      expected,
      artifact: null,
      text: null,
      note: `${label} has no ${expected} yet — the ${previous} step has not written one.`,
    }
  }
  if (artifact.filePath === null) {
    return {
      expected,
      artifact,
      text: null,
      note: `The ${label} ${expected} has been recorded but not produced yet.`,
    }
  }
  try {
    return {
      expected,
      artifact,
      text: readFileSync(join(library.artifactDir, artifact.filePath), 'utf8'),
      note: null,
    }
  } catch (error) {
    return {
      expected,
      artifact,
      text: null,
      note:
        `${artifact.filePath} is recorded on the artifact but could not be read from ` +
        `${library.artifactDir} — ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * The singular artifact of a kind for this episode — the three writing kinds carry no slot.
 * Found by id and then hydrated through `findArtifact`, so growing the artifact row never
 * leaves a second hand-built copy of it behind in here.
 */
function artifactOf(store: Store, episodeId: string, kind: ArtifactKind): Artifact | null {
  const row = store.get<{ id: string }>(
    'SELECT id FROM artifact WHERE episode_id = ? AND kind = ? ORDER BY slot LIMIT 1',
    episodeId,
    kind,
  )
  return row ? (findArtifact(store, row.id) ?? null) : null
}

// ── Arcs ────────────────────────────────────────────────────────────────────────

/**
 * The arcs this episode is written under: every show-scoped arc, and every arc of its own
 * season. A season's arcs are on the desk whether or not this episode declares a position on
 * one — a writer who cannot see waypoint 3 is the one who lands it by accident (D8).
 */
function arcsInContext(store: Store, where: EpisodeInShow): ArcInContext[] {
  const positions = new Map(
    positionsOf(store, where.episode.id).map((position) => [position.arc.id, position]),
  )
  return arcsOf(store, where.show.id)
    .filter((arc) => arc.scope === 'show' || arc.seasonId === where.season.id)
    .map((arc) => ({
      arc,
      waypoints: waypointsOf(store, arc.id),
      position: positions.get(arc.id) ?? null,
    }))
}

// ── Notes ───────────────────────────────────────────────────────────────────────

/**
 * Every note Ryan has already written that this step must answer, newest first.
 *
 * Merged with a STABLE sort on `at` alone: within each source the order is already the one
 * its own ledger keeps (round descending; the dismissal reader's own tie-break), and both
 * clocks have millisecond resolution, so two notes written in one sitting collide routinely.
 * A stable merge keeps each source's order intact where they collide, which is what makes
 * two compositions of one desk identical.
 *
 * **The dismissal half is bounded** — `dismissalNotes` drops past `PRIOR_NOTE_LIMIT` rather
 * than summarising, which is finding.ts's ruling and the reason newest-first is not a
 * presentation choice here: it decides which notes survive the bound. The rejection half is
 * not bounded, because rounds count Ryan's opinions of ONE artifact and there are never many.
 */
function notesFor(store: Store, where: EpisodeInShow, producing: Artifact | null): WriteNote[] {
  const label = episodeLabel(where.episode.number)
  const rejections: WriteNote[] =
    producing === null
      ? []
      : store
          .all<RejectionRow>(
            `SELECT g.id AS gate_id, g.artifact_id, n.round, n.note, n.depth, n.target,
                    n.target_version, r.ruled_at, r.verdict
               FROM gate_note n
               JOIN gate g ON g.id = n.gate_id
               JOIN gate_ruling r ON r.gate_id = n.gate_id AND r.round = n.round
              -- Both verbs that leave a note (0015). A note he put the draft down with is
              -- his opinion of the thing being rewritten exactly as a rejection's is, and
              -- the reason the writing stage became offerable again at all.
              WHERE g.artifact_id = ? AND r.verdict IN ('reject', 'close')
              ORDER BY n.round DESC, n.seq DESC`,
            producing.id,
          )
          // A note Ryan wrote at THIS artifact's gate and routed somewhere ELSE is not this
          // writer's to answer — it is the target's, and it arrives on the target's desk
          // below. Handing it over here as well would be the rewind D21 replaced, printed
          // twice (E4-5, `domain/routing.ts`).
          .filter((row) => landsOn({ ...row, targetVersion: row.target_version }, producing.id))
          .map((row) => ({
            note: row.note,
            at: row.ruled_at,
            sentence:
              (row.verdict === 'close'
                ? `the note you put the ${label} ${producing.kind} down with at round ${row.round}`
                : `your round ${row.round} rejection of the ${label} ${producing.kind}`) +
              (row.depth === null ? '' : `, routed at ${row.depth} depth`),
            origin: {
              kind: 'gate-rejection' as const,
              gateId: row.gate_id,
              artifactId: row.artifact_id,
              round: row.round,
              depth: row.depth,
              target: row.target,
              verdict: row.verdict,
            },
          }))

  // **The third origin** (E4-5): notes written at a LATER artifact's gate and addressed here.
  // They ride until they are answered and then keep riding — the desk hands over everything
  // Ryan has said about this artifact, and `addressed` is what the OFFER reads, not the
  // prompt. A note dropped from the desk the moment v2 landed would vanish from round 2 of
  // the very rewrite it asked for.
  const routed: WriteNote[] =
    producing === null
      ? []
      : routedNotesTo(store, producing.id).map((one) => ({
          note: one.note,
          at: one.ruledAt,
          sentence: `your note from the ${label} ${one.fromKind} gate, routed here`,
          origin: {
            kind: 'routed-rejection' as const,
            gateId: one.gateId,
            round: one.round,
            depth: one.depth,
            fromArtifactId: one.fromArtifactId,
            fromKind: one.fromKind,
            routedAtVersion: one.routedAtVersion,
            addressed: one.addressed,
          },
        }))

  // The show's whole stream, not one check's: a writer is not a reviewer (finding.ts).
  const dismissals: WriteNote[] = dismissalNotes(store, { showId: where.show.id }).map((one) => ({
    note: one.note,
    at: one.at,
    sentence: `a ${one.checkKey} finding you dismissed in ${episodeLabelOf(store, one.episodeId)}`,
    origin: {
      kind: 'finding-dismissal' as const,
      findingId: one.findingId,
      checkKey: one.checkKey,
      quote: one.quote,
      episodeId: one.episodeId,
      entityId: one.entityId,
    },
  }))

  return [...rejections, ...routed, ...dismissals].sort((a, b) =>
    a.at === b.at ? 0 : a.at < b.at ? 1 : -1,
  )
}

function episodeLabelOf(store: Store, episodeId: string): string {
  const row = store.get<{ number: number }>('SELECT number FROM episode WHERE id = ?', episodeId)
  return row ? episodeLabel(row.number) : 'an episode that is gone'
}

// ── Sentences ───────────────────────────────────────────────────────────────────

/**
 * "the ep02 premise-brief" — what an artifact is called in a reason. **No version**: an
 * inclusion reason is about the artifact, because provenance is declared on the artifact and
 * not on one of its versions, and a reason carrying a version would go quietly wrong the
 * moment a rewrite lands. Only the reading clause below is version-scoped, because only it
 * is about the bytes.
 */
const subjectLabel = (episodeNumber: number, artifact: Artifact): string =>
  `${episodeLabel(episodeNumber)} ${artifact.kind}${artifact.slot ? ` ${artifact.slot}` : ''}`

const artifactLabel = (episodeNumber: number, artifact: Artifact): string =>
  `${subjectLabel(episodeNumber, artifact)} v${artifact.version}`

/** The line E4-7's inspector renders over the desk. Composed here, where it has a test. */
function deskSentence(
  step: WriteStep,
  where: EpisodeInShow,
  upstream: Upstream,
  entities: EntityInContext[],
  leftOut: EntityLeftOut[],
  arcs: ArcInContext[],
  notes: WriteNote[],
): string {
  const label = episodeLabel(where.episode.number)
  const reading =
    upstream.artifact === null
      ? upstream.expected === null
        ? 'writing from canon alone'
        : `no ${upstream.expected} to read`
      : `reading the ${artifactLabel(where.episode.number, upstream.artifact)}`

  const declared = arcs.filter((arc) => arc.position !== null).length
  const arcClause =
    arcs.length === 0
      ? 'no arcs'
      : `${arcs.length} arc${arcs.length === 1 ? '' : 's'} (${
          declared === 0 ? 'vanilla' : `${declared} declared`
        })`

  return (
    `The ${label} ${step} desk — ${reading}, ${entities.length} canon ` +
    `entit${entities.length === 1 ? 'y' : 'ies'} in scope and ${leftOut.length} left out, ` +
    `canon as the audience knows it at ${label}, ${arcClause}, ` +
    `${
      notes.length === 0 ? 'no notes' : `${notes.length} note${notes.length === 1 ? '' : 's'}`
    } standing.`
  )
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface RejectionRow {
  gate_id: string
  artifact_id: string
  round: number
  note: string
  depth: NoteDepth | null
  target: string | null
  target_version: number | null
  ruled_at: string
  verdict: 'reject' | 'close'
}

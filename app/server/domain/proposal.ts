import type { Store } from '../db/store.ts'
import type { EventKind, EventLog } from '../events.ts'
import {
  addReference,
  amendEntity,
  findEntityById,
  type CanonEntity,
  type EntityStanding,
  type ReferenceKind,
  type ReferenceStance,
} from './canon.ts'
import { positionsOf, type Arc, type ArcWaypoint } from './arc.ts'
import { findCategoryById, findRelationType } from './category.ts'
import {
  canonAsOf,
  closeFact,
  establishFact,
  findFact,
  recordRuling,
  type CanonRuling,
  type Fact,
} from './fact.ts'
import { newId } from './id.ts'
import { findRelation, relate, relationsFrom, unrelate, UNKNOWN_TARGET } from './relation.ts'
import { episodeLabel, findEpisode, type Episode } from './spine.ts'

/**
 * Proposals: the only way canon changes (invariant 1, 1.2, 3.3).
 *
 * Everything else in this app *proposes*. An agent, a check remediation, a loader (E2-4),
 * an import (E7), a new show (E8) and the runner itself all end at a row in `proposal`;
 * Ryan ruling it at its gate is what writes canon, and this module is where that ruling
 * lands. Founding is not an exception (D25): the Grey Harbor sheets are promotion proposals
 * ruled through this same API, which is why there is no bulk-write path here and no `force`
 * argument anywhere.
 *
 * **The boundary, stated once.** `registerEntity` (canon.ts) is the identity insert BENEATH
 * this flow — it makes a `candidate`, a row nobody has ruled on that looks like one — never
 * a way around it. `establishFact`, `relate`, `unrelate`, `amendEntity` and `addReference`
 * are the writes ratification calls. This module is their one legitimate caller outside
 * tests, and a second caller that appears later has written canon nobody ruled on.
 *
 * ## The five parts (1.2)
 *
 * 1. **The change** — a fact delta (entity + field, before → after), a relation delta, or an
 *    entity promotion carrying the full initial sheet. All three are rows in the same three
 *    part tables, because a promotion *is* facts and relations and a sheet raised together.
 * 2. **Usage context** — the passage that made it necessary.
 * 3. **Implications** — the blast radius, and it is **computed, never stored**
 *    (`blastRadius`): which ratified facts, which arcs, which prior episodes. A stored
 *    answer is one that goes wrong the moment anything it summarised moves, which is the
 *    call artifact freshness (1.3) and arc drift (D8) already made.
 * 4. **Alternatives** — what else could have been done, so the ruling is a choice.
 * 5. **Origin & disposition** — who raised it, and what Ryan decided. Kept forever, both.
 *
 * ## Riding, and not riding
 *
 * A proposal with an episode RIDES it: its facts are written provisionally — no ratification,
 * so invisible to `canonAsOf` and visible to `factsInScope`, which is what "visible to
 * checks" means (3.3). A proposal without one rides nothing, and `episode_id` is nullable
 * because **founding is the reason**: the Grey Harbor sheets have no episode, a premise
 * pitched before an episode exists has none (5.7), and neither has a run or a gate either.
 * Nothing here requires any of the three to rule a proposal — a gate CONVENES a ruling, it
 * is never a precondition for one.
 *
 * **Relations do not ride.** A fact has a provisional mode because E2-1 built it one — a row
 * with no ratification. An edge has no such thing, and inventing one would mean writing to
 * `relation` before anyone ruled: canon nobody approved, in the graph checks traverse. So a
 * proposed edge stays a proposal row until ratification writes it, and the asymmetry is the
 * honest one.
 *
 * ## What ratification does, and in what order
 *
 * Relations first, then the sheet, then facts, then references — the order matters exactly
 * once and it is D22's: an exception (a fact that `overrides` an inherited one) can only be
 * written once the edge it is inherited across exists, and a promotion's edges arrive in the
 * same ruling. Then completeness is checked, and this is **D22's enforcement point**: a
 * character promoted without its required `species` is refused here, which is what E2-0
 * deferred (relation.ts's header says so, and names this module). A candidate may be ragged;
 * canon may not. `unknown` — a relation row with a NULL target — satisfies it: declared
 * unknown is legal canon, and absent is not.
 */

/**
 * What a proposal proposes. A promotion is the first two plus a sheet, raised together.
 *
 * **E2-3 widened this, and the widening cost no migration** — which is the whole reason
 * 0007 and 0008 refused a CHECK on the column. `revert` overturns a ratified fact instead
 * of writing one (3.3): abandoning an episode raises one per fact whose lineage names it,
 * and ratifying one closes that fact with NO successor. `landing` is D8's — an episode
 * declaring an arc position raises it, and Ryan ratifying it turns "arc1 reached waypoint2
 * in ep01" into a fact with lineage. Both are raised by domain/episode-canon.ts and ruled
 * by the same three verbs below, because there is one ruling API and a kind of change is
 * not a surface.
 */
export const PROPOSAL_KIND = [
  'fact-delta',
  'relation-delta',
  'promotion',
  'revert',
  'landing',
] as const
export type ProposalKind = (typeof PROPOSAL_KIND)[number]

/**
 * Who raised it (1.2's fifth part). `loader` is E2-4 founding a show from its sheets and
 * `import` is E7 bringing Dead Light across — they are named here because D25 rules that
 * both raise proposals like everyone else, and a queue that could not say where a founding
 * proposal came from would make that indistinguishable from a bulk write.
 */
export const PROPOSAL_ORIGIN = ['writer', 'check', 'ryan', 'loader', 'import'] as const
export type ProposalOrigin = (typeof PROPOSAL_ORIGIN)[number]

/**
 * Derived from the disposition, never stored. `raised` is a proposal nobody has ruled on;
 * the other three are the kinds of ruling that dispose of one (3.3).
 */
export const PROPOSAL_STATUS = ['raised', 'ratified', 'rejected', 'deferred'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUS)[number]

/** One fact the change would write. */
export interface ProposalFactPart {
  ordinal: number
  field: string | null
  statement: string
  /** The "before": the ratified fact this closes. NULL adds rather than replaces. */
  supersedes: string | null
  /** The inherited fact this displaces — an individual exception (D22 addendum). */
  overrides: string | null
  /** The provisional row riding the episode. NULL when the proposal rides nothing. */
  factId: string | null
}

/** One edge the change would write or withdraw. */
export interface ProposalRelationPart {
  ordinal: number
  op: 'add' | 'remove'
  /** The declared type's name, on an `add` (D23). '' on a `remove`, which names an edge. */
  typeName: string
  /** On an `add`, NULL is the declared `unknown` — `relation`'s own spelling of it (D22). */
  toEntityId: string | null
  /** On a `remove`, the edge to withdraw. */
  relationId: string | null
}

export interface ProposalReferencePart {
  ordinal: number
  kind: ReferenceKind
  filePath: string
  stance: ReferenceStance
  label: string
}

/** The first of the five parts, whole. The identity fields are a promotion's sheet. */
export interface ProposalChange {
  facts: ProposalFactPart[]
  relations: ProposalRelationPart[]
  references: ProposalReferencePart[]
  /** NULL means the change does not touch it — what `amendEntity` does with a field left out. */
  standing: EntityStanding | null
  aliases: string[] | null
  body: string | null
}

export interface Proposal {
  id: string
  entityId: string
  showId: string
  kind: ProposalKind
  /** The episode it rides. NULL is founding, or a premise pitched before an episode (5.7). */
  episodeId: string | null
  raisedBy: ProposalOrigin
  change: ProposalChange
  usageContext: string
  alternatives: string[]
  status: ProposalStatus
  /** The ruling that disposed of it, carrying Ryan's note and the gate it was ruled at. */
  disposition: CanonRuling | null
  createdAt: string
}

export interface FactPartDraft {
  statement: string
  field?: string
  supersedes?: string
  overrides?: string
}

export interface RelationPartDraft {
  op: 'add' | 'remove'
  /** On an `add`: the declared type name. */
  type?: string
  /** On an `add`: a target entity's id, or `UNKNOWN_TARGET` — `relate`'s own argument. */
  to?: string
  /** On a `remove`: the edge. */
  relationId?: string
}

export interface ReferencePartDraft {
  kind: ReferenceKind
  filePath: string
  stance: ReferenceStance
  label?: string
}

export interface ProposalDraft {
  entityId: string
  kind: ProposalKind
  raisedBy: ProposalOrigin
  /** Left out, the proposal rides nothing — founding (D25) and pre-episode pitches (5.7). */
  episodeId?: string
  usageContext?: string
  alternatives?: string[]
  facts?: FactPartDraft[]
  relations?: RelationPartDraft[]
  references?: ReferencePartDraft[]
  /** A promotion's sheet: standing, aliases, prose body. */
  standing?: EntityStanding
  aliases?: string[]
  body?: string
}

// ── Raising ─────────────────────────────────────────────────────────────────────

/**
 * Raises a proposal. Writes no canon — that is the point of the whole module — with one
 * exception that is not one: a proposal riding an episode writes its facts PROVISIONALLY,
 * which is a claim with no ratification on it, visible to checks and invisible to
 * `canonAsOf`.
 *
 * What is refused here is what one write can answer for itself, the same line relation.ts
 * and fact.ts hold: the subject exists, the change has something in it, a promotion promotes
 * a candidate rather than something already active, and a delta's "before" belongs to the
 * subject. Completeness (D22) is not refused here — it is ruled at ratification, because a
 * proposal being drafted is allowed to be as ragged as the candidate it describes.
 */
export function raiseProposal(store: Store, draft: ProposalDraft): Proposal {
  return store.transaction(() => {
    const entity = findEntityById(store, draft.entityId)
    if (!entity) throw new Error(`No such canon entity: ${draft.entityId}`)

    const facts = draft.facts ?? []
    const relations = draft.relations ?? []
    if (facts.length === 0 && relations.length === 0 && draft.kind !== 'promotion') {
      throw new Error(
        `A ${draft.kind} proposing nothing is not a proposal. State the change: a fact with ` +
          'its before, or an edge to write or withdraw.',
      )
    }
    if (draft.kind === 'promotion' && entity.status === 'active') {
      throw new Error(
        `“${entity.name}” is already active canon, so there is nothing to promote. A change ` +
          'to an entity that has been ruled on is a fact or relation delta, with a before.',
      )
    }
    if (draft.kind === 'revert' && facts.some((part) => part.supersedes === undefined)) {
      throw new Error(
        'A revert names the ratified fact it overturns, and that is its whole content. ' +
          'Put the fact in `supersedes`; there is no "after" to write.',
      )
    }
    for (const part of facts) {
      if (part.supersedes === undefined) continue
      const before = findFact(store, part.supersedes)
      if (!before) throw new Error(`No such fact: ${part.supersedes}`)
      if (before.entityId !== entity.id) {
        throw new Error(
          `“${entity.name}” cannot supersede a fact belonging to another entity. A delta's ` +
            'before and after are two statements about one subject.',
        )
      }
    }

    const id = newId('prop')
    store.run(
      `INSERT INTO proposal (id, entity_id, kind, episode_id, raised_by, usage_context,
                             standing, aliases, body)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entity.id,
      draft.kind,
      draft.episodeId ?? null,
      draft.raisedBy,
      draft.usageContext ?? '',
      draft.standing ?? null,
      draft.aliases === undefined ? null : draft.aliases.join(', '),
      draft.body ?? null,
    )

    facts.forEach((part, index) => {
      // The claim that rides the episode. A part carrying an exception rides nothing: an
      // override names a fact the entity INHERITS, and the edge it inherits across is
      // written by the ratification that writes this — so there is nothing yet to except.
      const claim =
        draft.episodeId !== undefined && part.overrides === undefined
          ? establishFact(store, {
              entityId: entity.id,
              statement: part.statement,
              ...(part.field !== undefined && { field: part.field }),
              establishedIn: draft.episodeId,
            })
          : undefined

      store.run(
        `INSERT INTO proposal_fact (proposal_id, ordinal, field, statement, supersedes,
                                    overrides, fact_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        index + 1,
        part.field ?? null,
        part.statement,
        part.supersedes ?? null,
        part.overrides ?? null,
        claim?.id ?? null,
      )
    })

    relations.forEach((part, index) => {
      if (part.op === 'add' && part.type === undefined) {
        throw new Error('An added edge needs the relation type its category declares.')
      }
      if (part.op === 'remove' && part.relationId === undefined) {
        throw new Error('A withdrawn edge needs to name which edge.')
      }

      // A withdrawal describes itself in words as well as by id, because ratifying it
      // DELETES the edge and takes the id with it (0008). "withdrew `species` → Halvani"
      // has to still render in the gate room afterwards.
      const withdrawn =
        part.relationId === undefined ? undefined : findRelation(store, part.relationId)
      if (part.op === 'remove' && !withdrawn) throw new Error(`No such relation: ${part.relationId}`)

      store.run(
        `INSERT INTO proposal_relation (proposal_id, ordinal, op, type_name, to_entity_id,
                                        relation_id)
              VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        index + 1,
        part.op,
        withdrawn?.type.name ?? part.type ?? '',
        withdrawn
          ? withdrawn.toEntityId
          : part.to === undefined || part.to === UNKNOWN_TARGET
            ? null
            : part.to,
        part.relationId ?? null,
      )
    })

    ;(draft.references ?? []).forEach((part, index) => {
      store.run(
        `INSERT INTO proposal_reference (proposal_id, ordinal, kind, file_path, stance, label)
              VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        index + 1,
        part.kind,
        part.filePath,
        part.stance,
        part.label ?? '',
      )
    })
    ;(draft.alternatives ?? []).forEach((alternative, index) => {
      store.run(
        'INSERT INTO proposal_alternative (proposal_id, ordinal, alternative) VALUES (?, ?, ?)',
        id,
        index + 1,
        alternative,
      )
    })

    return findProposal(store, id)!
  })
}

// ── Reading ─────────────────────────────────────────────────────────────────────

export function findProposal(store: Store, id: string): Proposal | undefined {
  const row = store.get<ProposalRow>(`${SELECT} WHERE p.id = ?`, id)
  return row && hydrate(store, row)
}

/**
 * The proposals riding an episode, oldest first — what the gate room renders beside the
 * artifact, and what a check scope has to know about (3.3).
 */
export function proposalsRiding(store: Store, episodeId: string): Proposal[] {
  return store
    .all<ProposalRow>(`${SELECT} WHERE p.episode_id = ? ORDER BY p.rowid`, episodeId)
    .map((row) => hydrate(store, row))
}

/**
 * Every proposal this show has raised and nobody has ruled — the canon library's queue, and
 * the bench's work list (E2-6). Founding proposals are in it: they ride nothing, so this is
 * the only place they are visible before they are ruled.
 */
export function openProposals(store: Store, showId: string): Proposal[] {
  return store
    .all<ProposalRow>(
      `${SELECT} WHERE e.show_id = ?
         AND NOT EXISTS (SELECT 1 FROM canon_ruling WHERE proposal_id = p.id)
       ORDER BY p.rowid`,
      showId,
    )
    .map((row) => hydrate(store, row))
}

/**
 * Everything ever proposed about one entity, ruled or not — the canon library's "1 pending
 * proposal touches this" beside an entity's facts, and the history behind it.
 */
export function proposalsOfEntity(store: Store, entityId: string): Proposal[] {
  return store
    .all<ProposalRow>(`${SELECT} WHERE p.entity_id = ? ORDER BY p.rowid`, entityId)
    .map((row) => hydrate(store, row))
}

// ── Implications: the blast radius, computed (1.2) ──────────────────────────────

/** Why a ratified fact is in the radius. Three ways a change reaches one. */
export const TOUCHED_REASON = ['superseded', 'same-field', 'inherited'] as const
export type TouchedReason = (typeof TOUCHED_REASON)[number]

export interface TouchedFact {
  fact: Fact
  /** The episode that established it — "ep02:" in the gate room's sentence. */
  episode: Episode | null
  why: TouchedReason
}

/** An arc the change reaches, and the position that reaches it. */
export interface BrushedArc {
  arc: Arc
  waypoint: ArcWaypoint
  /** The episode whose declared position brushed it. */
  episode: Episode
}

export interface BlastRadius {
  proposalId: string
  /** Ratified facts only. A provisional claim is not canon and cannot be disturbed. */
  facts: TouchedFact[]
  arcs: BrushedArc[]
  /** Prior episodes that read on the subject — provenance, which is invariant 2's answer. */
  episodes: Episode[]
  /** The gate room's own sentence, composed where it has a test. */
  sentence: string
}

/**
 * The third part of a proposal, and **it is computed at read time, never stored** — the
 * freshness pattern (1.3), for the same reason: a blast radius written down at the moment a
 * proposal was raised is wrong the moment anything it summarised moves, and it would be
 * wrong silently, under Ryan's hand, at the gate where he rules.
 *
 * Three sources, which is what "computed from relations + provenance + facts" means:
 *
 * - **facts** — the ratified fact a delta names as its before (`superseded`); any ratified
 *   fact standing on the same field, which is the one the proposer did not notice
 *   (`same-field`); and, across an edge whose declaration says facts travel it, everything
 *   that would start or stop loading with the subject (`inherited`, D22).
 * - **arcs** — the positions declared by the episode it rides and by every episode that has
 *   already read on the subject. "Brushes" is the honest word: whether it moves the arc is
 *   Ryan's call, and the radius only says the arc is in the blast.
 * - **episodes** — provenance. Which prior episodes were written against this entity.
 *
 * What is NOT here is whether any of it CONTRADICTS anything. The gate room's third line
 * reads "no prior-episode contradictions", and that is a check's answer (E3), argued with a
 * severity and a confidence. A radius states reach; it never renders a verdict.
 */
export function blastRadius(store: Store, proposalId: string): BlastRadius {
  const proposal = findProposal(store, proposalId)
  if (!proposal) throw new Error(`No such proposal: ${proposalId}`)

  const touched = new Map<string, TouchedFact>()
  const touch = (fact: Fact, why: TouchedReason): void => {
    if (fact.ratifiedBy === null || fact.closure !== null || touched.has(fact.id)) return
    touched.set(fact.id, {
      fact,
      episode: fact.establishedIn === null ? null : (findEpisode(store, fact.establishedIn) ?? null),
      why,
    })
  }

  for (const part of proposal.change.facts) {
    if (part.supersedes === null) continue
    const before = findFact(store, part.supersedes)
    if (before) touch(before, 'superseded')
  }

  const standing = canonAsOf(store, { entityId: proposal.entityId }, 'now')
  for (const part of proposal.change.facts) {
    if (part.field === null) continue
    for (const fact of standing.filter((canon) => canon.field === part.field)) {
      touch(fact, 'same-field')
    }
  }

  for (const source of inheritanceSources(store, proposal)) {
    for (const fact of canonAsOf(store, { entityId: source }, 'now')) touch(fact, 'inherited')
  }

  const readOnBy = episodesTouching(store, proposal.entityId)
  const episodes = readOnBy.filter((episode) => episode.id !== proposal.episodeId)

  const riding = proposal.episodeId === null ? undefined : findEpisode(store, proposal.episodeId)
  const arcs: BrushedArc[] = []
  const seen = new Set<string>()
  for (const episode of [...(riding ? [riding] : []), ...readOnBy]) {
    for (const position of positionsOf(store, episode.id)) {
      if (seen.has(position.arc.id)) continue
      seen.add(position.arc.id)
      arcs.push({ arc: position.arc, waypoint: position.waypoint, episode })
    }
  }

  const facts = [...touched.values()]
  return { proposalId, facts, arcs, episodes, sentence: radiusSentence(facts, arcs, episodes) }
}

/**
 * The entities whose facts would start or stop loading with the subject: the far end of
 * every proposed edge whose declaration says facts travel it (D22, D23). An edge that
 * carries no facts changes what the graph says and nothing about what a check reads, so it
 * is not in the radius — which is exactly the distinction `inheritsFacts` exists to draw.
 */
function inheritanceSources(store: Store, proposal: Proposal): string[] {
  const entity = findEntityById(store, proposal.entityId)
  const sources: string[] = []
  for (const part of proposal.change.relations) {
    if (part.op === 'remove') {
      const edge = part.relationId === null ? undefined : findRelation(store, part.relationId)
      if (edge?.type.inheritsFacts && edge.toEntityId !== null) sources.push(edge.toEntityId)
      continue
    }
    if (part.toEntityId === null || !entity?.categoryId) continue
    const type = findRelationType(store, entity.categoryId, part.typeName)
    if (type?.inheritsFacts) sources.push(part.toEntityId)
  }
  return sources
}

/**
 * The episodes an entity has been written into, by provenance — the one edge that says an
 * artifact touched a canon entity (invariant 2), in story order.
 *
 * **Exported for the canon library's appearances panel** (E5-4, `canon-library.ts`), which
 * asks this exact question of one entity rather than of a proposal's subject. It lives here
 * rather than beside `provenanceOf` in `domain/artifact.ts` because it walks up to the
 * episode and the season to order the answer, and `spine.ts` already imports `artifact.ts` —
 * one walk, one home, and no cycle.
 */
export function episodesTouching(store: Store, entityId: string): Episode[] {
  return store
    .all<{ id: string }>(
      `SELECT DISTINCT a.episode_id AS id
         FROM artifact a
         JOIN artifact_provenance p ON p.artifact_id = a.id
         JOIN episode e ON e.id = a.episode_id
         JOIN season s ON s.id = e.season_id
        WHERE p.entity_id = ?
        ORDER BY s.number, e.number`,
      entityId,
    )
    .map((row) => findEpisode(store, row.id)!)
}

/**
 * "touches 1 ratified fact (ep02: “Mara refuses to carry arms.”), brushes 1 arc (…)" — the
 * gate room's Implications line, composed on the server where it has a test, the way
 * operating.ts composes its button sentences. A single fact or arc names itself, because
 * one thing is worth reading; a list of them is a count and a panel.
 */
function radiusSentence(
  facts: TouchedFact[],
  arcs: BrushedArc[],
  episodes: Episode[],
): string {
  const clauses: string[] = []

  if (facts.length > 0) {
    const only = facts.length === 1 ? facts[0]! : undefined
    const named = only
      ? ` (${only.episode ? `${episodeLabel(only.episode.number)}: ` : ''}“${only.fact.statement}”)`
      : ''
    clauses.push(`touches ${facts.length} ratified fact${facts.length === 1 ? '' : 's'}${named}`)
  }

  if (arcs.length > 0) {
    const only = arcs.length === 1 ? arcs[0]! : undefined
    const named = only ? ` (“${only.arc.name}” waypoint ${only.waypoint.ordinal})` : ''
    clauses.push(`brushes ${arcs.length} arc${arcs.length === 1 ? '' : 's'}${named}`)
  }

  if (episodes.length > 0) {
    clauses.push(
      episodes.length === 1
        ? '1 prior episode reads on it'
        : `${episodes.length} prior episodes read on it`,
    )
  }

  return clauses.length === 0 ? 'touches nothing ratified yet' : clauses.join(', ')
}

// ── Ruling ──────────────────────────────────────────────────────────────────────

/**
 * Why a rejection with nothing typed in the box is refused — the sentence the refusal
 * throws AND the sentence the bench's disabled button shows (E2-6).
 *
 * It is a constant rather than a string literal for the reason `launchBlockedBecause` is a
 * function: a precondition the API enforced in one wording and the button stated in another
 * is a failure after a click wearing a different coat. One string, two readers.
 */
export const REJECTION_NEEDS_A_NOTE =
  'Rejecting a proposal needs the reason — "reject with note" is the verb, and the note is ' +
  'what the next writer run reads (3.3).'

/**
 * The ruling API: three verbs, and the only thing in this app that writes canon.
 *
 * **Every surface convenes the same three.** The gate room rules a proposal riding the
 * script it is presented beside; the canon bench (E2-6) rules from the queue; the founding
 * flow (E2-4) rules a stack of promotions with no episode in sight. None of that changes
 * what a ruling is, so none of it gets an API of its own — `gateId` says where Ryan was
 * standing, and nothing here requires a gate, a run, or an episode to accept a verdict.
 * That is deliberate and it is the shape gate.ts already holds: nothing may block a ruling.
 *
 * A factory for the same reason `createRulings` is — a ruling writes the ledger, writes
 * canon, and appends to the log, and those are one act.
 *
 * **All three kinds are kept forever** (3.3). Only `ratify` writes canon; `reject` and
 * `defer` write nothing at all, and their whole substance is the disposition they leave on
 * the ledger: a rejection's note is what E4's writer context reads back so the next draft
 * knows why Trent stays mortal. Both also stop the proposal riding — its provisional facts
 * are closed by the ruling, so a check reading that episode tomorrow does not still see a
 * claim Ryan put down.
 */
export interface ProposalRulings {
  /** Ryan approving the change. **This, and only this, writes canon** (invariant 1). */
  ratify(proposalId: string, ruling?: { note?: string; gateId?: string }): Proposal
  /** No, with the reason — kept forever, and read by future writer runs. */
  reject(proposalId: string, ruling: { note: string; gateId?: string }): Proposal
  /** Not now: parks it. It stops riding, and the checks stop seeing it. */
  defer(proposalId: string, ruling?: { note?: string; gateId?: string }): Proposal
}

export function createProposalRulings(store: Store, events: EventLog): ProposalRulings {
  function rule(
    proposalId: string,
    kind: 'ratification' | 'rejection' | 'deferral',
    given: { note?: string; gateId?: string },
  ): Proposal {
    const before = findProposal(store, proposalId)
    if (!before) throw new Error(`No such proposal: ${proposalId}`)
    if (before.disposition) {
      throw new Error(
        `That proposal was ${before.status} at ruling ${before.disposition.seq}, and a ` +
          'proposal is ruled once. A later opinion is a NEW proposal — raise one, citing ' +
          'this note: “' + before.disposition.note + '”',
      )
    }
    if (kind === 'rejection' && (given.note ?? '').trim() === '') {
      throw new Error(REJECTION_NEEDS_A_NOTE)
    }

    const ruling = store.transaction(() => {
      const recorded = recordRuling(store, kind, {
        proposalId,
        ...(given.gateId !== undefined && { gateId: given.gateId }),
        ...(given.note !== undefined && { note: given.note }),
      })
      if (kind === 'ratification') writeCanon(store, before, recorded)
      else putDownClaims(store, before, recorded)
      return recorded
    })

    const after = findProposal(store, proposalId)!
    // Appended after the transaction commits, never inside it: `append` notifies its
    // subscribers as it writes, and a rollback cannot un-tell a browser (E1-5).
    announce(store, events, after, ruling)
    return after
  }

  return {
    ratify: (proposalId, ruling) => rule(proposalId, 'ratification', ruling ?? {}),
    reject: (proposalId, ruling) => rule(proposalId, 'rejection', ruling),
    defer: (proposalId, ruling) => rule(proposalId, 'deferral', ruling ?? {}),
  }
}

/**
 * What a ratification writes, in the one order that matters.
 *
 * Relations first: an exception (a fact that `overrides` an inherited one, D22) can only be
 * written once the edge it is inherited across exists, and a promotion's edges arrive in
 * this same ruling. Then the sheet, then the facts, then the references.
 *
 * Each fact part writes ONE canon fact and closes up to TWO under this ruling: the
 * provisional claim that was riding the episode, and the ratified fact it argued with. Both
 * name the same heir, because both gave way to it at the same tick — which is what makes a
 * point-in-time read answer differently on either side of the ruling (D9).
 */
function writeCanon(store: Store, proposal: Proposal, ruling: CanonRuling): void {
  const entity = findEntityById(store, proposal.entityId)!

  for (const part of proposal.change.relations) {
    if (part.op === 'remove') {
      // NULL here means the edge is already gone — another ruling withdrew it first, and
      // the end state this one asked for already holds. `unrelate` on nothing is nothing.
      if (part.relationId !== null) unrelate(store, part.relationId)
    } else {
      relate(store, {
        fromEntityId: entity.id,
        type: part.typeName,
        to: part.toEntityId ?? UNKNOWN_TARGET,
      })
    }
  }

  const sheet = proposal.change
  if (
    proposal.kind === 'promotion' ||
    sheet.standing !== null ||
    sheet.aliases !== null ||
    sheet.body !== null
  ) {
    amendEntity(store, entity.id, {
      // A promotion is what turns a candidate into canon. Everything else leaves standing
      // alone — what is left out of a sheet is left alone, never blanked.
      ...(proposal.kind === 'promotion' && { status: 'active' as const }),
      ...(sheet.standing !== null && { standing: sheet.standing }),
      ...(sheet.aliases !== null && { aliases: sheet.aliases }),
      ...(sheet.body !== null && { body: sheet.body }),
    })
  }

  for (const part of proposal.change.facts) {
    // A REVERT overturns canon instead of writing it (3.3, E2-3). The part names a ratified
    // fact in `supersedes` and this ruling closes it with NO SUCCESSOR — which is what
    // `reverted` means and what makes an as-of read before the ruling still answer with it.
    // No new row: there is no "after" to a revert, and writing one would make it a
    // supersession wearing the wrong word. The rest of this function is a no-op for the
    // kind — a revert carries no relations, no sheet and no references — so the branch is
    // here, where the facts are, rather than as a second ratification path.
    if (proposal.kind === 'revert') {
      if (part.supersedes !== null) {
        closeFact(store, { factId: part.supersedes, ruling: ruling.seq, note: ruling.note })
      }
      continue
    }

    const written = establishFact(store, {
      entityId: entity.id,
      statement: part.statement,
      ratifiedBy: ruling.seq,
      ...(part.field !== null && { field: part.field }),
      ...(proposal.episodeId !== null && { establishedIn: proposal.episodeId }),
      ...(part.overrides !== null && { overrides: part.overrides }),
    })
    if (part.factId !== null) {
      closeFact(store, {
        factId: part.factId,
        ruling: ruling.seq,
        supersededBy: written.id,
        note: 'ratified — the claim that rode the episode became canon',
      })
    }
    if (part.supersedes !== null) {
      closeFact(store, {
        factId: part.supersedes,
        ruling: ruling.seq,
        supersededBy: written.id,
        note: ruling.note,
      })
    }
  }

  for (const reference of proposal.change.references) {
    addReference(store, {
      entityId: entity.id,
      kind: reference.kind,
      filePath: reference.filePath,
      stance: reference.stance,
      label: reference.label,
    })
  }

  requireCompleteCanon(store, findEntityById(store, entity.id)!)
}

/**
 * What a rejection and a deferral do, which is nothing to canon: they put down the claims
 * the proposal was riding with. The fact rows stay — a fact is never deleted (D9) — closed
 * with no successor, by a ruling whose kind says which of the two it was.
 */
function putDownClaims(store: Store, proposal: Proposal, ruling: CanonRuling): void {
  for (const part of proposal.change.facts) {
    if (part.factId === null) continue
    closeFact(store, { factId: part.factId, ruling: ruling.seq, note: ruling.note })
  }
}

/**
 * **D22's enforcement point, and the one E2-0 deferred to here** (relation.ts names this
 * module). A candidate may be ragged — it is written one edge at a time and is incomplete
 * in between — and canon may not be. So `required` is checked at the moment a sheet becomes
 * canon, never at the insert.
 *
 * A NULL-target row SATISFIES it: `unknown` is a declared answer (D22), tracked and visible
 * on the gaps list. What is refused is *absence* — a sheet nobody finished.
 *
 * Checked on any ratification whose subject ends up active, not only on a promotion: a
 * relation delta that withdraws a required edge would otherwise leave canon incomplete by
 * the back door.
 */
function requireCompleteCanon(store: Store, entity: CanonEntity): void {
  if (entity.status !== 'active' || !entity.categoryId) return
  const category = findCategoryById(store, entity.categoryId)
  if (!category) return

  const edges = relationsFrom(store, entity.id)
  for (const type of category.relationTypes.filter((declared) => declared.required)) {
    if (edges.some((edge) => edge.type.id === type.id)) continue
    throw new Error(
      `“${entity.name}” cannot become canon without a \`${type.name}\`: the ${category.key} ` +
        `category declares it required, so every ${category.key} has one. Add the edge ` +
        `to the sheet — or declare it \`${UNKNOWN_TARGET}\`, which is a real answer and ` +
        'satisfies this. A candidate may be half-written; canon may not.',
    )
  }
}

/**
 * The ruling on the wire (E1-5). **A gate is what makes this possible, and its absence is
 * not a gap:** `event.run_id` is NOT NULL, the bench and the founding flow have no run, and
 * the episode-less run is a relaxation E1-5 deliberately deferred (see the README's
 * constraints). So a ruling convened at a gate is announced there, and every ruling — gate
 * or no gate — is recorded on the ledger, which is where canon reads it back from anyway.
 *
 * The gate's own coordinates are read here with one query rather than through
 * `runner/gate.ts`: the domain does not depend on the runner, and a gate is where a ruling
 * was convened, never what it is.
 */
function announce(store: Store, events: EventLog, proposal: Proposal, ruling: CanonRuling): void {
  if (ruling.gateId === null) return
  const gate = store.get<{ run_id: string; step_id: string; episode_id: string }>(
    'SELECT run_id, step_id, episode_id FROM gate WHERE id = ?',
    ruling.gateId,
  )
  if (!gate) return

  const kind: EventKind =
    ruling.kind === 'ratification'
      ? 'proposal-ratified'
      : ruling.kind === 'rejection'
        ? 'proposal-rejected'
        : 'proposal-deferred'

  events.append({
    kind,
    runId: gate.run_id,
    stepId: gate.step_id,
    episodeId: gate.episode_id,
    summary: sentenceFor(store, proposal, ruling),
    detail: {
      proposalId: proposal.id,
      entityId: proposal.entityId,
      ruling: ruling.seq,
      note: ruling.note,
      gateId: ruling.gateId,
    },
  })
}

/** The machine-written sentence a ruling puts on the floor and in the episode room. */
function sentenceFor(store: Store, proposal: Proposal, ruling: CanonRuling): string {
  const name = findEntityById(store, proposal.entityId)?.name ?? 'the entity'
  if (ruling.kind === 'ratification') {
    return `ratified the ${name} proposal — canon as of ruling ${ruling.seq}`
  }
  if (ruling.kind === 'rejection') {
    return `rejected the ${name} proposal — the note rides future writer runs`
  }
  const episode = proposal.episodeId === null ? null : findEpisode(store, proposal.episodeId)
  return `deferred the ${name} proposal — parked${
    episode ? `, and it stops riding ${episodeLabel(episode.number)}` : ''
  }`
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface ProposalRow {
  id: string
  entity_id: string
  show_id: string
  kind: ProposalKind
  episode_id: string | null
  raised_by: ProposalOrigin
  usage_context: string
  standing: EntityStanding | null
  aliases: string | null
  body: string | null
  created_at: string
}

interface FactPartRow {
  ordinal: number
  field: string | null
  statement: string
  supersedes: string | null
  overrides: string | null
  fact_id: string | null
}

interface RelationPartRow {
  ordinal: number
  op: 'add' | 'remove'
  type_name: string
  to_entity_id: string | null
  relation_id: string | null
}

interface ReferencePartRow {
  ordinal: number
  kind: ReferenceKind
  file_path: string
  stance: ReferenceStance
  label: string
}

interface RulingRow {
  seq: number
  kind: CanonRuling['kind']
  at: string
  proposal_id: string | null
  gate_id: string | null
  note: string
}

/** The show comes off the subject entity — the proposal carries no second copy of it. */
const SELECT = `
  SELECT p.id, p.entity_id, e.show_id, p.kind, p.episode_id, p.raised_by, p.usage_context,
         p.standing, p.aliases, p.body, p.created_at
    FROM proposal p
    JOIN canon_entity e ON e.id = p.entity_id`

function hydrate(store: Store, row: ProposalRow): Proposal {
  const ruling = store.get<RulingRow>(
    'SELECT seq, kind, at, proposal_id, gate_id, note FROM canon_ruling WHERE proposal_id = ?',
    row.id,
  )

  return {
    id: row.id,
    entityId: row.entity_id,
    showId: row.show_id,
    kind: row.kind,
    episodeId: row.episode_id,
    raisedBy: row.raised_by,
    change: {
      facts: store
        .all<FactPartRow>(
          `SELECT ordinal, field, statement, supersedes, overrides, fact_id
             FROM proposal_fact WHERE proposal_id = ? ORDER BY ordinal`,
          row.id,
        )
        .map((part) => ({
          ordinal: part.ordinal,
          field: part.field,
          statement: part.statement,
          supersedes: part.supersedes,
          overrides: part.overrides,
          factId: part.fact_id,
        })),
      relations: store
        .all<RelationPartRow>(
          `SELECT ordinal, op, type_name, to_entity_id, relation_id
             FROM proposal_relation WHERE proposal_id = ? ORDER BY ordinal`,
          row.id,
        )
        .map((part) => ({
          ordinal: part.ordinal,
          op: part.op,
          typeName: part.type_name,
          toEntityId: part.to_entity_id,
          relationId: part.relation_id,
        })),
      references: store
        .all<ReferencePartRow>(
          `SELECT ordinal, kind, file_path, stance, label
             FROM proposal_reference WHERE proposal_id = ? ORDER BY ordinal`,
          row.id,
        )
        .map((part) => ({
          ordinal: part.ordinal,
          kind: part.kind,
          filePath: part.file_path,
          stance: part.stance,
          label: part.label,
        })),
      standing: row.standing,
      aliases:
        row.aliases === null
          ? null
          : row.aliases
              .split(',')
              .map((alias) => alias.trim())
              .filter((alias) => alias !== ''),
      body: row.body,
    },
    usageContext: row.usage_context,
    alternatives: store
      .all<{ alternative: string }>(
        'SELECT alternative FROM proposal_alternative WHERE proposal_id = ? ORDER BY ordinal',
        row.id,
      )
      .map((alternative) => alternative.alternative),
    status: statusOf(ruling),
    disposition: ruling
      ? {
          seq: ruling.seq,
          kind: ruling.kind,
          at: ruling.at,
          proposalId: ruling.proposal_id,
          gateId: ruling.gate_id,
          note: ruling.note,
        }
      : null,
    createdAt: row.created_at,
  }
}

/**
 * Derived from the ledger, never stored. Unruled is `raised`; the three ruling kinds that
 * dispose of a proposal are the other three. A `revert` never disposes of a proposal — it
 * overturns canon that was already ratified (3.3, E2-3) — so it cannot appear here.
 */
function statusOf(ruling: { kind: string } | undefined): ProposalStatus {
  if (!ruling) return 'raised'
  if (ruling.kind === 'ratification') return 'ratified'
  if (ruling.kind === 'rejection') return 'rejected'
  if (ruling.kind === 'deferral') return 'deferred'
  throw new Error(`A ${ruling.kind} ruling does not dispose of a proposal.`)
}

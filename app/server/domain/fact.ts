import type { Store } from '../db/store.ts'
import { findEntityById, type CanonEntity } from './canon.ts'
import { findCategoryById, type RelationType } from './category.ts'
import { newId } from './id.ts'
import { relationsFrom } from './relation.ts'

/**
 * Facts, and time (3.1, D9): the atomic checkable statements an entity is made of, kept
 * append-only with validity ranges so "canon as of episode 4" is answerable.
 *
 * **These are the low-level writes beneath ratification, the way `registerEntity` and
 * `relate` are.** A fact legitimately comes into being one way — Ryan ruling a proposal at
 * its gate (invariant 1) — and E2-2's ruling API is the only legitimate caller of anything
 * here outside tests and E2-4's founding. A loader, an import (E7), a check remediation or
 * an agent that calls `establishFact` directly has written canon nobody ruled on, which is
 * the one thing invariant 1 forbids. Founding is not an exception (D25): it raises
 * promotion proposals and ratifies them through that same API, and what that API calls is
 * this module.
 *
 * ## The shape of time
 *
 * A fact is valid over a HALF-OPEN RANGE of rulings: `[ratified_by, closed_by)`. Ruling
 * numbers are the clock — `canon_ruling.seq`, monotonic by AUTOINCREMENT — because E1-5
 * proved timestamps collide inside one millisecond and clocks step backwards. Reading as
 * of a date is a convenience that maps the date onto that clock first (`rulingAsOfDate`)
 * and then queries by number. Dates are for humans; the ruling is the truth.
 *
 * Half-open matters at exactly one moment: the ruling that supersedes a fact both closes
 * the predecessor and opens the successor. As of that ruling you get the successor, which
 * is what "as of ruling R" means — after R was ruled.
 *
 * **`canonAsOf` returns ratified facts only.** A provisional fact is not canon; it rides
 * its episode and is visible to checks (3.3), which is `factsInScope`'s job, not this one.
 * That is also why a provisional fact needs no place on the clock: it has no ruling, so
 * there is nothing to read it as of.
 *
 * ## Append-only, with one transition, and the transition is a row
 *
 * The rows are FULLY IMMUTABLE — no UPDATE path, no DELETE path, both refused by triggers
 * in 0007. The one state change a fact has, open validity becoming closed, is a row in
 * `fact_closure` recording the ruling that closed it and the successor that replaced it (or
 * no successor, which is the revert).
 *
 * The alternative was a guarded one-way UPDATE — a trigger whose WHEN clause permits only
 * open→closed, once. It was rejected because a WHEN clause has to ENUMERATE the columns it
 * protects, and tables in this schema grow by ADD COLUMN: 0006 added five columns to
 * `canon_entity`, and a column added after such a trigger is a column the trigger silently
 * stops covering. A blanket ABORT cannot rot that way, and "closed once, one way" becomes a
 * PRIMARY KEY on `fact_closure.fact_id` rather than trigger logic nobody re-reads. The cost
 * is one LEFT JOIN on a primary key per read.
 *
 * **The consequence, and it is deliberate: ratifying a provisional fact writes a new row.**
 * The provisional claim is closed by the ruling, and the canon fact it became is the
 * successor — `supersedeFact` does both under one ruling. Two rows, because they are two
 * different things: a draft's claim riding an episode, and the fact Ryan ruled. Their
 * lineages differ, and a history view that showed only the second would have lost the fact
 * that anyone ever proposed it.
 *
 * **Status is derived, never stored.** `ratified_by IS NULL` already says provisional and
 * the closure already says reverted or superseded; a `status` column would be a second name
 * for both, and two names for one thing eventually disagree (the lesson 0006 spent two
 * triggers on). `statusOf` computes it, and inside an as-of read the answer is only ever
 * `provisional` or `ratified` — the closed labels belong to the history view.
 *
 * ## Inheritance is declared (D22, D23)
 *
 * "The species' facts load into check scope with its members." The mechanism is general and
 * the word `species` is not — it is a key on a Grey Harbor sheet. So a category declares
 * that facts travel an edge (`inherits facts: yes` on the declaration, `RelationType`'s
 * `inheritsFacts`), the same way it declares cardinality and an inverse. D22 compliance for
 * the shipped categories is data: the character category's `species` line carries the flag,
 * and the fixture round-trip test in category.test.ts is what pins it. A category author
 * who leaves the flag off gets an edge facts do not travel — legal, visible in the
 * declaration, and exactly how it should fail.
 *
 * Facts travel the DECLARED edge only, one way: a character inherits from the species it
 * points at. A species inherits nothing from its members, and two members inherit nothing
 * from each other.
 *
 * ## Three kinds of nothing
 *
 * `factsInScope` never collapses an empty inheritance into an empty array. E3's
 * honest-confidence tiers (invariant 4) have to tell these apart, so each edge reports
 * which case it hit: `undeclared` (no relation row — a sheet somebody did not finish),
 * `declared-unknown` (a row with a NULL target: somebody looked, and the world has not
 * decided — D22), and `source-has-no-facts` (a species that exists and carries nothing
 * yet). A fourth is visible without a case: an entity whose category declares no
 * fact-carrying edge at all has an empty `inheritance` list, which is not a gap.
 */

/**
 * The dispositions that touch a fact's validity. E2-2 grows this union as it grows
 * `canon_ruling` — 3.3's `rejected` and `deferred` close a provisional fact that was only
 * ever riding an episode. Adding one is a code change with a test (the Archon rule), which
 * is why there is no CHECK on the column and no kinds table.
 */
export const CANON_RULING_KIND = ['ratification', 'revert'] as const
export type CanonRulingKind = (typeof CANON_RULING_KIND)[number]

/** Ryan approving or overturning something, and the clock canon is read by. */
export interface CanonRuling {
  /** Monotonic. The number every validity range is measured in. */
  seq: number
  kind: CanonRulingKind
  /** For humans, and for `rulingAsOfDate`. Never for ordering. */
  at: string
}

/** What a fact is at a moment. Derived from lineage and closure, never stored. */
export const FACT_STATUS = ['provisional', 'ratified', 'reverted', 'superseded'] as const
export type FactStatus = (typeof FACT_STATUS)[number]

/** The end of a validity range, and the lineage of that end. */
export interface FactClosure {
  /** The ruling that closed it. */
  closedBy: number
  /** The fact that replaced it. NULL is the revert — closed with no successor (3.3). */
  supersededBy: string | null
  note: string
  at: string
}

export interface Fact {
  id: string
  entityId: string
  /** Which of the category's fields this is about. NULL when the sheet did not say. */
  field: string | null
  statement: string
  /** The episode that established it. NULL for a founding or pre-episode fact. */
  establishedIn: string | null
  /** The ruling that ratified it. NULL means provisional — riding its episode (3.3). */
  ratifiedBy: number | null
  /** The inherited fact this one displaces (D22 addendum). */
  overrides: string | null
  status: FactStatus
  /** Present only once a ruling closed it. */
  closure: FactClosure | null
  createdAt: string
}

export interface FactDraft {
  entityId: string
  statement: string
  /** One of the category's fields. Left out when the sheet did not say which. */
  field?: string
  /** The episode that established it. Left out for founding and pre-episode facts. */
  establishedIn?: string
  /** The ratification. Left out, the fact is provisional and rides its episode. */
  ratifiedBy?: number
  /** The inherited fact this one displaces — an individual exception (D22 addendum). */
  overrides?: string
}

/** When to read canon. `now` is the canon library's default control. */
export type AsOf = 'now' | { ruling: number } | { date: string }

/** Whose canon to read: one entity's sheet, or the whole show's. */
export type CanonScope = { entityId: string } | { showId: string }

// ── Rulings ─────────────────────────────────────────────────────────────────────

/**
 * Records a ruling — the anchor a fact's lineage points at, and one tick of the clock canon
 * is read by. E2-2's ruling API is what calls this; it is not itself a ruling any more than
 * `registerEntity` is a ratification, and E2-2 grows the row it writes (the proposal it
 * disposed of, the gate it was ruled at, Ryan's note) by ADD COLUMN on the same table.
 */
export function recordRuling(store: Store, kind: CanonRulingKind): CanonRuling {
  const row = store.get<RulingRow>(
    'INSERT INTO canon_ruling (kind) VALUES (?) RETURNING seq, kind, at',
    kind,
  )!
  return { seq: row.seq, kind: row.kind, at: row.at }
}

export function findRuling(store: Store, seq: number): CanonRuling | undefined {
  const row = store.get<RulingRow>('SELECT seq, kind, at FROM canon_ruling WHERE seq = ?', seq)
  return row && { seq: row.seq, kind: row.kind, at: row.at }
}

/**
 * The last ruling made at or before `date` — how a date becomes a place on the clock. An
 * ISO-8601 string, compared as text the way every timestamp in this schema is stored.
 * `undefined` means no ruling had been made yet, and canon as of then was empty.
 */
export function rulingAsOfDate(store: Store, date: string): CanonRuling | undefined {
  const row = store.get<RulingRow>(
    'SELECT seq, kind, at FROM canon_ruling WHERE at <= ? ORDER BY at DESC, seq DESC LIMIT 1',
    date,
  )
  return row && { seq: row.seq, kind: row.kind, at: row.at }
}

// ── Writing facts ───────────────────────────────────────────────────────────────

/**
 * Writes a fact. With a ratification it is canon from that ruling on; without one it is
 * provisional — raised, riding its episode, visible to checks and invisible to `canonAsOf`.
 *
 * What is enforced here is everything one write can answer for itself, because a refusal at
 * the store binds every caller:
 *
 * - a ratification is a `ratification` — a revert never opens a fact;
 * - an `overrides` names a fact this entity actually **inherits**, never one of its own and
 *   never one from an entity it has no fact-carrying edge to (D22 addendum).
 */
export function establishFact(store: Store, draft: FactDraft): Fact {
  return store.transaction(() => {
    const entity = findEntityById(store, draft.entityId)
    if (!entity) throw new Error(`No such canon entity: ${draft.entityId}`)

    if (draft.ratifiedBy !== undefined) {
      const ruling = findRuling(store, draft.ratifiedBy)
      if (!ruling) throw new Error(`No such ruling: ${draft.ratifiedBy}`)
      if (ruling.kind !== 'ratification') {
        throw new Error(
          `Ruling ${ruling.seq} is a ${ruling.kind}, and only a ratification opens a fact. ` +
            'Canon is what Ryan approved at a gate (invariant 1).',
        )
      }
    }

    if (draft.overrides !== undefined) requireInherited(store, entity, draft.overrides)

    const id = newId('fact')
    store.run(
      `INSERT INTO fact (id, entity_id, field, statement, established_in, ratified_by, overrides)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      entity.id,
      draft.field ?? null,
      draft.statement,
      draft.establishedIn ?? null,
      draft.ratifiedBy ?? null,
      draft.overrides ?? null,
    )
    return findFact(store, id)!
  })
}

/**
 * Closes a fact and writes what replaces it, under one ruling — the ep02 statement ending
 * and the ep05 statement beginning at the same tick, which is what makes a point-in-time
 * read answer differently on either side of it.
 *
 * The successor is ratified by the closing ruling; that is not a default but the shape of
 * the act, so passing a different `ratifiedBy` is refused rather than quietly honoured.
 * Ratifying a provisional fact is this same call: the provisional claim is what closes.
 */
export function supersedeFact(
  store: Store,
  change: { factId: string; successor: FactDraft; ruling: number; note?: string },
): { closed: Fact; successor: Fact } {
  return store.transaction(() => {
    const predecessor = requireOpen(store, change.factId)
    if (
      change.successor.ratifiedBy !== undefined &&
      change.successor.ratifiedBy !== change.ruling
    ) {
      throw new Error(
        `A supersession closes one fact and opens the next at ONE ruling — ruling ` +
          `${change.ruling} here — and the successor was handed ruling ` +
          `${change.successor.ratifiedBy}. Two rulings are two proposals.`,
      )
    }

    const successor = establishFact(store, { ...change.successor, ratifiedBy: change.ruling })
    close(store, predecessor.id, change.ruling, successor.id, change.note ?? '')
    return { closed: findFact(store, predecessor.id)!, successor }
  })
}

/**
 * Closes a fact with nothing in its place. The ruling's kind says why: a `revert` ruling
 * over ratified canon — an abandoned episode's facts are reverted one by one, never removed
 * (3.3) — or, once E2-2 exists, a rejection or deferral putting down a provisional fact that
 * was only riding an episode. Structurally the same act, which is why there is one function
 * and the lineage carries the difference.
 *
 * The fact does not disappear. It stops being valid, and a read as of any earlier ruling
 * still returns it.
 */
export function closeFact(
  store: Store,
  closure: { factId: string; ruling: number; note?: string },
): Fact {
  return store.transaction(() => {
    const fact = requireOpen(store, closure.factId)
    close(store, fact.id, closure.ruling, null, closure.note ?? '')
    return findFact(store, fact.id)!
  })
}

// ── Reading facts ───────────────────────────────────────────────────────────────

export function findFact(store: Store, id: string): Fact | undefined {
  const row = store.get<FactRow>(`${SELECT} WHERE f.id = ?`, id)
  return row && hydrate(row)
}

/**
 * Every fact this entity has ever carried, open and closed, in the order they were written
 * — the history the canon library's lineage column reads from. `canonAsOf` is what a check
 * or a screen asking "what is true" wants instead.
 */
export function factsOfEntity(store: Store, entityId: string): Fact[] {
  return store
    .all<FactRow>(`${SELECT} WHERE f.entity_id = ? ORDER BY f.rowid`, entityId)
    .map(hydrate)
}

/**
 * The ratified facts valid at a moment, for one entity or a whole show (D9) — what the
 * canon library's "Canon as of · now" control feeds, at `now` and at every other setting.
 *
 * As of a ruling, the range is half-open: a fact ratified at that very ruling is in, and one
 * closed at it is out. As of a date, the date resolves to the last ruling at or before it
 * first — if no ruling had been made yet, canon was empty and this returns nothing.
 */
export function canonAsOf(store: Store, scope: CanonScope, at: AsOf): Fact[] {
  let ceiling: number | undefined
  if (at !== 'now') {
    if ('ruling' in at) {
      ceiling = at.ruling
    } else {
      const ruling = rulingAsOfDate(store, at.date)
      if (!ruling) return []
      ceiling = ruling.seq
    }
  }

  const where = 'entityId' in scope ? 'f.entity_id = ?' : 'e.show_id = ?'
  const subject = 'entityId' in scope ? scope.entityId : scope.showId

  // Two shapes rather than one clever parameterised string: as of now, a closed fact is
  // simply out; as of a ruling, it is out only if it was closed by then.
  const valid =
    ceiling === undefined
      ? 'f.ratified_by IS NOT NULL AND c.fact_id IS NULL'
      : 'f.ratified_by IS NOT NULL AND f.ratified_by <= ? AND (c.fact_id IS NULL OR c.closed_by > ?)'

  const params = ceiling === undefined ? [subject] : [subject, ceiling, ceiling]
  return store
    .all<FactRow>(`${SELECT} WHERE ${where} AND ${valid} ORDER BY e.name, f.rowid`, ...params)
    .map(hydrate)
}

// ── Check scope: what loads with an entity (invariant 2, D22) ───────────────────

/** What an inheriting edge carried: the one kind of something, and three kinds of nothing. */
export const INHERITANCE_CASE = [
  'inherited',
  'source-has-no-facts',
  'declared-unknown',
  'undeclared',
] as const
export type InheritanceCase = (typeof INHERITANCE_CASE)[number]

/** One fact-carrying edge, and what came across it. */
export interface Inheritance {
  /** The declaration facts travelled — or would have (D23). */
  type: RelationType
  case: InheritanceCase
  /** The entity the facts came from. NULL when there was nothing at the far end. */
  source: CanonEntity | null
  /** What reached this entity: the source's valid facts, minus the ones it overrides. */
  facts: Fact[]
}

/**
 * An individual exception: a fact on this entity that displaces an inherited one (D22).
 *
 * **An exception displaces the lineage, not the row.** Edit the species fact and every
 * member inherits the change — except this one, whose exception carries forward onto the
 * successor. The alternative was tried and is worse: an exception that names one row stops
 * displacing anything the moment the species is edited, and the entity's scope then holds
 * both "Tobin holds against vacuum for a minute" and the new Halvani fact saying he does
 * not. Handing a check a contradiction is the failure mode invariant 2 exists to prevent.
 *
 * What is NOT inferred is that the exception still makes sense. The species may have been
 * edited into something the exception never contemplated, so `stale` says the ground moved
 * and E3 gets to surface it. Computed, never remembered — the shape artifact freshness and
 * arc-waypoint drift already use (1.3, D8).
 */
export interface Override {
  /** The exception. */
  by: Fact
  /** The inherited fact it names — the row, which never changes. */
  overridden: Fact
  /**
   * What it actually removes from scope today: the named fact, or whatever superseded it.
   * NULL when there is nothing left to displace — the named fact was reverted, or the edge
   * it was inherited across now points somewhere else.
   */
  displaces: Fact | null
  /**
   * The named fact is no longer what stands in scope. The exception is still canon and
   * still applies; what it was written against has moved, and revisiting it is a ruling.
   */
  stale: boolean
}

/**
 * Everything a check reads for one entity (invariant 2): its own facts, the facts it
 * inherits, and what its exceptions displace.
 *
 * Read as of now, and provisional facts are included on purpose — a proposal riding its
 * episode is visible to checks (3.3), which is exactly the difference between this and
 * `canonAsOf`. Scoping a re-check to an earlier ruling is E3's call to make; `canonAsOf` is
 * the primitive it would compose with, and a provisional fact has no place on that clock.
 */
export interface FactScope {
  entity: CanonEntity
  /** Its own facts, still valid. */
  own: Fact[]
  /** One per fact-carrying edge the entity's category declares. Empty when none does. */
  inheritance: Inheritance[]
  /** Own + inherited, displaced facts removed. The list a check is handed. */
  inScope: Fact[]
  overrides: Override[]
}

export function factsInScope(store: Store, entityId: string): FactScope {
  const entity = findEntityById(store, entityId)
  if (!entity) throw new Error(`No such canon entity: ${entityId}`)

  const own = openFactsOf(store, entity.id)
  const inheritance = inheritanceOf(store, entity)

  const inherited = inheritance.flatMap((edge) => edge.facts)
  const inheritedIds = new Set(inherited.map((fact) => fact.id))
  const overrides = own
    .filter((fact) => fact.overrides !== null)
    .map((fact) => {
      const overridden = findFact(store, fact.overrides!)!
      // Follow the supersession chain: the exception displaces what stands in the named
      // fact's place today, which after a species edit is the successor.
      const standing = standingHeirOf(store, overridden)
      const displaces = standing && inheritedIds.has(standing.id) ? standing : null
      return { by: fact, overridden, displaces, stale: displaces?.id !== overridden.id }
    })

  const displaced = new Set(
    overrides.map((override) => override.displaces?.id).filter((id) => id !== undefined),
  )
  for (const edge of inheritance) {
    edge.facts = edge.facts.filter((fact) => !displaced.has(fact.id))
  }

  return {
    entity,
    own,
    inheritance,
    inScope: [...own, ...inherited.filter((fact) => !displaced.has(fact.id))],
    overrides,
  }
}

/**
 * The fact-carrying edges of an entity's category, walked once. An entity registered before
 * its show declared categories has none — not a gap in a sheet, just a category link that
 * has not arrived (0006), so the list is empty rather than a case.
 */
function inheritanceOf(store: Store, entity: CanonEntity): Inheritance[] {
  if (!entity.categoryId) return []
  const category = findCategoryById(store, entity.categoryId)
  if (!category) return []

  const edges = relationsFrom(store, entity.id)
  const inheritance: Inheritance[] = []

  for (const type of category.relationTypes.filter((declared) => declared.inheritsFacts)) {
    const declared = edges.filter((edge) => edge.type.id === type.id)
    if (declared.length === 0) {
      inheritance.push({ type, case: 'undeclared', source: null, facts: [] })
      continue
    }

    for (const edge of declared) {
      if (edge.toEntityId === null) {
        inheritance.push({ type, case: 'declared-unknown', source: null, facts: [] })
        continue
      }
      const source = findEntityById(store, edge.toEntityId)!
      const facts = openFactsOf(store, source.id)
      inheritance.push({
        type,
        case: facts.length === 0 ? 'source-has-no-facts' : 'inherited',
        source,
        facts,
      })
    }
  }
  return inheritance
}

/**
 * The still-open fact standing in this one's place: itself if it is open, otherwise
 * whatever superseded it, and so on down. `undefined` when the line ends in a revert —
 * closed with no successor, and nothing took its place.
 *
 * The `seen` guard is not for a cycle the schema allows (a successor is always written
 * after its predecessor); it is so a corrupted file fails a read rather than hanging one.
 */
function standingHeirOf(store: Store, fact: Fact): Fact | undefined {
  const seen = new Set<string>()
  let standing: Fact | undefined = fact
  while (standing?.closure) {
    if (standing.closure.supersededBy === null) return undefined
    if (seen.has(standing.id)) throw new Error(`Supersession loops at fact ${standing.id}`)
    seen.add(standing.id)
    standing = findFact(store, standing.closure.supersededBy)
  }
  return standing
}

/** The facts an entity carries right now — ratified or provisional, none of them closed. */
function openFactsOf(store: Store, entityId: string): Fact[] {
  return store
    .all<FactRow>(
      `${SELECT} WHERE f.entity_id = ? AND c.fact_id IS NULL ORDER BY f.rowid`,
      entityId,
    )
    .map(hydrate)
}

// ── The refusals ────────────────────────────────────────────────────────────────

function requireOpen(store: Store, factId: string): Fact {
  const fact = findFact(store, factId)
  if (!fact) throw new Error(`No such fact: ${factId}`)
  if (fact.closure) {
    throw new Error(
      `“${fact.statement}” was already closed at ruling ${fact.closure.closedBy}. A fact ` +
        'closes once, one way — reopening canon is a new fact under a new ruling (D9).',
    )
  }
  return fact
}

/**
 * An exception may only displace a fact the entity actually inherits. The check is here
 * rather than in the schema because which facts an entity inherits depends on a relation
 * and on the declaration behind it — two tables SQLite cannot consult from a constraint,
 * the same reason relation cardinality is counted in `relate`.
 */
function requireInherited(store: Store, entity: CanonEntity, overridden: string): void {
  const displaced = findFact(store, overridden)
  if (!displaced) throw new Error(`No such fact: ${overridden}`)
  if (displaced.entityId === entity.id) {
    throw new Error(
      `“${entity.name}” cannot override its own fact. An exception displaces an INHERITED ` +
        'fact (D22); replacing one of its own is a supersession, with a before and an after.',
    )
  }

  const sources = inheritanceOf(store, entity)
    .map((edge) => edge.source?.id)
    .filter((id) => id !== undefined)
  if (!sources.includes(displaced.entityId)) {
    const source = findEntityById(store, displaced.entityId)
    throw new Error(
      `“${entity.name}” inherits nothing from “${source?.name ?? displaced.entityId}”, so it ` +
        'has no exception to make to it. An override names a fact that loads with this ' +
        'entity — check the edge, and that its category declares that facts travel it.',
    )
  }
}

/** The one place a closure row is written. Both callers are above; there is no other. */
function close(
  store: Store,
  factId: string,
  ruling: number,
  supersededBy: string | null,
  note: string,
): void {
  if (!findRuling(store, ruling)) throw new Error(`No such ruling: ${ruling}`)
  store.run(
    'INSERT INTO fact_closure (fact_id, closed_by, superseded_by, note) VALUES (?, ?, ?, ?)',
    factId,
    ruling,
    supersededBy,
    note,
  )
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface RulingRow {
  seq: number
  kind: CanonRulingKind
  at: string
}

interface FactRow {
  id: string
  entity_id: string
  field: string | null
  statement: string
  established_in: string | null
  ratified_by: number | null
  overrides: string | null
  created_at: string
  /** From the LEFT JOIN. NULL in all four when the fact is still open. */
  closed_by: number | null
  superseded_by: string | null
  closure_note: string | null
  closure_at: string | null
}

/**
 * One SELECT, joining the closure that may not exist and the entity whose name orders a
 * show-wide read. The entity join is carried even for a single-entity read: one shape means
 * one hydrator, and a fact that grows a column never leaves a second hand-built copy behind.
 */
const SELECT = `
  SELECT f.id, f.entity_id, f.field, f.statement, f.established_in, f.ratified_by,
         f.overrides, f.created_at,
         c.closed_by, c.superseded_by, c.note AS closure_note, c.at AS closure_at
    FROM fact f
    JOIN canon_entity e ON e.id = f.entity_id
    LEFT JOIN fact_closure c ON c.fact_id = f.id`

function hydrate(row: FactRow): Fact {
  const closure: FactClosure | null =
    row.closed_by === null
      ? null
      : {
          closedBy: row.closed_by,
          supersededBy: row.superseded_by,
          note: row.closure_note ?? '',
          at: row.closure_at!,
        }

  return {
    id: row.id,
    entityId: row.entity_id,
    field: row.field,
    statement: row.statement,
    establishedIn: row.established_in,
    ratifiedBy: row.ratified_by,
    overrides: row.overrides,
    status: statusOf(row.ratified_by, closure),
    closure,
    createdAt: row.created_at,
  }
}

/**
 * Derived, never stored. A closed fact says which way it ended; an open one says whether a
 * ruling has reached it yet. Inside an as-of read only the two open answers can appear.
 */
function statusOf(ratifiedBy: number | null, closure: FactClosure | null): FactStatus {
  if (closure) return closure.supersededBy === null ? 'reverted' : 'superseded'
  return ratifiedBy === null ? 'provisional' : 'ratified'
}

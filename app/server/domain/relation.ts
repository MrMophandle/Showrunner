import type { Store } from '../db/store.ts'
import { findEntityById, type CanonEntity } from './canon.ts'
import {
  findCategoryById,
  findRelationType,
  findRelationTypeById,
  relationTypeByInverse,
  type RelationType,
} from './category.ts'
import { newId } from './id.ts'

/**
 * The edges themselves: typed relations between canon entities (3.1, D23).
 *
 * **This is the low-level write beneath the flow, the way `registerEntity` is.** Relations
 * legitimately change through proposals ruled at a gate (E2-2) — `relate` and `unrelate`
 * are what a ratification calls, not a way around one. An agent, a check remediation, an
 * import (E7) or a loader (E2-4) that calls these directly has written canon nobody ruled
 * on, which is invariant 1's one prohibition.
 *
 * What IS enforced here is everything a single write can answer for itself, because a
 * refusal at the store binds every caller, including the ones that never came from a sheet:
 *
 * - the type is **declared by the entity's category** — free verbs are refused (D23);
 * - the target is **an entity of the declared target category**, and of the same show;
 * - there is **room under the cardinality** — `exactly-one` and `at-most-one` both refuse
 *   a second edge.
 *
 * What is NOT enforced here is `required`. An entity is written one edge at a time and is
 * ragged in between; D22's "every character declares a species" is enforced at
 * ratification (E2-2), where canon must be complete and a candidate may still be partial.
 *
 * ## `unknown` (D22)
 *
 * A character whose species genuinely is not decided declares it as `unknown` — legal,
 * tracked, never blank. A relation row wants a target entity and `unknown` points at
 * nothing, so something had to give. **The ruling: the edge is a row with a NULL target.**
 *
 *     no row          nobody has said. A sheet somebody did not finish.
 *     row, NULL to    declared unknown. Somebody looked; the world has not decided.
 *     row, real to    the edge.
 *
 * The alternative was a sentinel `unknown` entity in the Species category. It was rejected
 * for three reasons: it would be a canon row no proposal ever ratified (invariant 1); it
 * would show up in the species list as a thing in the world, so the canon library would
 * have to special-case it back out; and every character pointing at it would be claiming
 * to share a species with every other one, which is a lie a check could act on.
 *
 * The consequences of the ruling, all of them wanted: cardinality counts rows, so an
 * unknown occupies the slot and resolving it is a replacement with a before (which is what
 * a proposal needs); the gaps list is `WHERE to_entity_id IS NULL` — one query, no join,
 * no sentinel to remember; and NULL is unreachable by accident, because the column is
 * RESTRICT (no deletion can make a target NULL) and `relate` takes the word `unknown`
 * rather than an omitted argument.
 */

/**
 * The one legal non-entity target (D22). It is the literal word the sheets use, so a
 * loader hands `relate` what it read without translating — and an entity id can never
 * collide with it, since ids are prefixed (`ent_…`).
 */
export const UNKNOWN_TARGET = 'unknown'

export interface Relation {
  id: string
  /** The declaration this edge was written under — its name, cardinality and inverse. */
  type: RelationType
  fromEntityId: string
  /** NULL only when the edge is a declared `unknown` (D22). */
  toEntityId: string | null
  createdAt: string
}

/** One step across the graph, from whichever end you started at. */
export interface Traversal {
  /** The name traversed by: the declared type from the near end, the inverse from the far end. */
  name: string
  direction: 'declared' | 'inverse'
  type: RelationType
  relationId: string
  /** The entity at the other end. NULL only for a declared `unknown`. */
  entity: CanonEntity | null
}

/** An entity that declared an edge and said the answer is not known yet (D22). */
export interface DeclaredUnknown {
  entity: CanonEntity
  type: RelationType
  relationId: string
}

/**
 * Writes an edge. `to` is a target entity's id, or `UNKNOWN_TARGET` when the answer is
 * genuinely undecided and the sheet says so.
 */
export function relate(
  store: Store,
  edge: { fromEntityId: string; type: string; to: string },
): Relation {
  return store.transaction(() => {
    const from = findEntityById(store, edge.fromEntityId)
    if (!from) throw new Error(`No such canon entity: ${edge.fromEntityId}`)
    if (!from.categoryId) {
      throw new Error(
        `“${from.name}” is registered as a ${from.categoryKey}, and this show has not declared ` +
          `a \`${from.categoryKey}\` category. A relation type is declared by a category ` +
          '(D23), so there is nothing yet for this edge to be an instance of.',
      )
    }

    const category = findCategoryById(store, from.categoryId)!
    const type = findRelationType(store, category.id, edge.type)
    if (!type) {
      const declared = category.relationTypes.map((t) => t.name)
      throw new Error(
        `\`${edge.type}\` is not a relation type the ${category.key} category declares. ` +
          `It declares: ${declared.length > 0 ? declared.join(', ') : 'nothing yet'}. A relation ` +
          'type is data (D23) — declare it on the category, with a target, a cardinality ' +
          'and an inverse, or the edge is invalid.',
      )
    }

    const to = edge.to === UNKNOWN_TARGET ? null : requireTarget(store, from, type, edge.to)
    const standing = relationsFrom(store, from.id).filter((r) => r.type.id === type.id)
    const named = (entityId: string | null): string =>
      entityId === null ? UNKNOWN_TARGET : findEntityById(store, entityId)!.name

    // Cardinality, counted inside the writing transaction because it cannot be an index:
    // the limit lives on `relation_type`, one table over. `exactly-one` and `at-most-one`
    // are the same refusal here; what separates them is E2-2's required-at-ratification.
    if (type.cardinality !== 'any' && standing.length > 0) {
      throw new Error(
        `“${from.name}” already declares a \`${type.name}\` → “${named(standing[0]!.toEntityId)}”, ` +
          `and the ${category.key} category allows ${type.cardinality}. Changing it means ` +
          'replacing that edge, which is a proposal with a before and an after (E2-2).',
      )
    }
    if (standing.some((relation) => relation.toEntityId === to)) {
      throw new Error(`“${from.name}” already declares \`${type.name}\` → “${named(to)}”.`)
    }

    const id = newId('rel')
    store.run(
      'INSERT INTO relation (id, relation_type_id, from_entity_id, to_entity_id) VALUES (?, ?, ?, ?)',
      id,
      type.id,
      from.id,
      to,
    )
    return findRelation(store, id)!
  })
}

/**
 * Removes an edge. Called by a ratified proposal that replaces or withdraws a relation —
 * resolving an `unknown` into a real species is exactly this, followed by a `relate`.
 */
export function unrelate(store: Store, relationId: string): void {
  store.run('DELETE FROM relation WHERE id = ?', relationId)
}

export function findRelation(store: Store, id: string): Relation | undefined {
  const row = store.get<RelationRow>(`${SELECT} WHERE r.id = ?`, id)
  return row && hydrate(store, row)
}

/** The edges this entity declares, in the order it declared them — the order its sheet reads in. */
export function relationsFrom(store: Store, entityId: string): Relation[] {
  return store
    .all<RelationRow>(`${SELECT} WHERE r.from_entity_id = ? ORDER BY r.rowid`, entityId)
    .map((row) => hydrate(store, row))
}

/**
 * The edges pointing at this entity, each carrying the inverse name it is navigable by.
 * Ordered by the far entity's name rather than by arrival: a species' members is a list
 * somebody reads, and the order two characters happened to be written in says nothing.
 */
export function relationsTo(store: Store, entityId: string): Relation[] {
  return store
    .all<RelationRow>(
      `${SELECT} JOIN canon_entity e ON e.id = r.from_entity_id
        WHERE r.to_entity_id = ? ORDER BY e.name`,
      entityId,
    )
    .map((row) => hydrate(store, row))
}

/**
 * One step by name, from either end. `relatedBy(halvani, 'members')` reaches every
 * character that declared it, without the species category declaring anything — that is
 * what an inverse is for (D23), and why blast radius is computable from both sides.
 *
 * A name neither end knows is a refusal rather than an empty list: "nothing is related by
 * `keeps`" and "`keeps` means nothing here" are answers a caller must not confuse.
 */
export function relatedBy(store: Store, entityId: string, name: string): Traversal[] {
  const entity = findEntityById(store, entityId)
  if (!entity) throw new Error(`No such canon entity: ${entityId}`)
  if (!entity.categoryId) {
    throw new Error(
      `“${entity.name}” is registered as a ${entity.categoryKey}, and this show has not ` +
        'declared that category — so nothing names an edge it could have.',
    )
  }

  const declared = findRelationType(store, entity.categoryId, name)
  if (declared) {
    return relationsFrom(store, entityId)
      .filter((relation) => relation.type.id === declared.id)
      .map((relation) => ({
        name,
        direction: 'declared',
        type: relation.type,
        relationId: relation.id,
        entity: relation.toEntityId === null ? null : findEntityById(store, relation.toEntityId)!,
      }))
  }

  const inverse = relationTypeByInverse(store, entity.categoryId, name)
  if (!inverse) {
    const category = findCategoryById(store, entity.categoryId)!
    throw new Error(
      `\`${name}\` is neither a relation type the ${category.key} category declares nor an ` +
        'inverse any category made navigable from it. Free verbs are refused rather than ' +
        'guessed at (D23).',
    )
  }

  return relationsTo(store, entityId)
    .filter((relation) => relation.type.id === inverse.id)
    .map((relation) => ({
      name,
      direction: 'inverse',
      type: relation.type,
      relationId: relation.id,
      entity: findEntityById(store, relation.fromEntityId)!,
    }))
}

/**
 * The show's declared unknowns — the canon library's gaps list (D22). One query, because
 * `unknown` is a NULL target rather than a sentinel entity somebody has to remember.
 */
export function declaredUnknowns(store: Store, showId: string): DeclaredUnknown[] {
  return store
    .all<RelationRow>(
      `${SELECT} JOIN canon_entity e ON e.id = r.from_entity_id
        WHERE e.show_id = ? AND r.to_entity_id IS NULL
        ORDER BY e.name`,
      showId,
    )
    .map((row) => {
      const relation = hydrate(store, row)
      return {
        entity: findEntityById(store, relation.fromEntityId)!,
        type: relation.type,
        relationId: relation.id,
      }
    })
}

/**
 * The target must exist, belong to this show, and be of the category the type declares.
 * Checked by `categoryKey` rather than `categoryId`, so an edge may point at an identity
 * registered before the show declared its categories — the key is what has been the
 * category's name since 0001, and the trigger on `canon_entity` keeps the two agreeing.
 */
function requireTarget(
  store: Store,
  from: CanonEntity,
  type: RelationType,
  toEntityId: string,
): string {
  const to = findEntityById(store, toEntityId)
  if (!to) throw new Error(`No such canon entity: ${toEntityId}`)
  if (to.showId !== from.showId) {
    throw new Error(
      `“${to.name}” belongs to another show. Canon is scoped to a show, so an edge never ` +
        'leaves one.',
    )
  }
  if (to.categoryKey !== type.targetCategory) {
    throw new Error(
      `\`${type.name}\` must point at a ${type.targetCategory}, and “${to.name}” is a ` +
        `${to.categoryKey}.`,
    )
  }
  return to.id
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface RelationRow {
  id: string
  relation_type_id: string
  from_entity_id: string
  to_entity_id: string | null
  created_at: string
}

const SELECT = 'SELECT r.id, r.relation_type_id, r.from_entity_id, r.to_entity_id, r.created_at FROM relation r'

function hydrate(store: Store, row: RelationRow): Relation {
  return {
    id: row.id,
    // The foreign key guarantees the declaration is there, so a miss is a corrupted
    // database rather than a case to handle.
    type: findRelationTypeById(store, row.relation_type_id)!,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    createdAt: row.created_at,
  }
}

import type { Store } from '../db/store.ts'
import { findCategory } from './category.ts'
import { newId } from './id.ts'

/**
 * The anatomy of a canon entity (3.1): identity, standing, status, aliases, prose body,
 * and the references that hang off it. Its edges are domain/relation.ts and its facts are
 * E2-1's; both point back here.
 *
 * **These are the low-level writes beneath the flow, never a way around it.** E1-2 built
 * `registerEntity` so `artifact_provenance` could carry a real foreign key, and said what
 * it is not: registering an identity is not ratification. E2-0 grows the table without
 * changing that sentence. `amendEntity` is what E2-2's ratification calls once Ryan has
 * ruled a promotion proposal; nothing else may call it to make canon, and an import (E7),
 * a fixture load (E2-4), or a new show (E8) raises proposals instead (D25, invariant 1).
 *
 * Two consequences of that, both deliberate and both load-bearing:
 *
 * - **A registered entity is a `candidate`.** That is the truthful default for a row
 *   nothing has ruled on, it is what E1's existing rows became when 0006 applied, and it
 *   is what makes "visibly unofficial until promoted" renderable rather than inferred.
 * - **Standing is NULL until declared.** `one-shot` would be a claim about the show
 *   nobody made. Not-declared and declared-one-shot are different, so they look different.
 *
 * `registerEntity` also refuses nothing about completeness. A character with no species is
 * legal here and illegal at ratification (D22, enforced by E2-2) — canon must be complete,
 * and a candidate is allowed to be half-written on its way there.
 */

/** Declared intent, not a count — appearance history is computed from provenance (3.1). */
export const ENTITY_STANDING = ['core', 'recurring', 'one-shot', 'retired'] as const
export type EntityStanding = (typeof ENTITY_STANDING)[number]

export const ENTITY_STATUS = ['active', 'historical', 'candidate'] as const
export type EntityStatus = (typeof ENTITY_STATUS)[number]

/** What a reference is: a face to match, a voice to match, a board to shoot toward. */
export const REFERENCE_KIND = ['image', 'voice', 'style-board'] as const
export type ReferenceKind = (typeof REFERENCE_KIND)[number]

/** `locked` is what a generation must match; `aspirational` is what somebody hopes for. */
export const REFERENCE_STANCE = ['locked', 'aspirational'] as const
export type ReferenceStance = (typeof REFERENCE_STANCE)[number]

export interface CanonEntity {
  id: string
  showId: string
  /** The category's stable key — the identity handle since 0001, and part of its UNIQUE. */
  categoryKey: string
  /** The declared category, once the show has one. NULL for an identity registered before it. */
  categoryId: string | null
  name: string
  /** NULL until somebody declares it. Not the same as `one-shot`. */
  standing: EntityStanding | null
  status: EntityStatus
  /** What else the scripts call them. */
  aliases: string[]
  /** The prose sheet that makes drafts good (3.1), sectioned by the category's fields. */
  body: string
  createdAt: string
}

export interface EntityReference {
  id: string
  entityId: string
  kind: ReferenceKind
  /** Relative to the library's artifact dir. The file itself is E6's; the model is E2's. */
  filePath: string
  stance: ReferenceStance
  label: string
  createdAt: string
}

interface EntityRow {
  id: string
  show_id: string
  category_key: string
  category_id: string | null
  name: string
  standing: EntityStanding | null
  status: EntityStatus
  aliases: string
  body: string
  created_at: string
}

const hydrate = (row: EntityRow): CanonEntity => ({
  id: row.id,
  showId: row.show_id,
  categoryKey: row.category_key,
  categoryId: row.category_id,
  name: row.name,
  standing: row.standing,
  status: row.status,
  aliases: row.aliases
    .split(',')
    .map((alias) => alias.trim())
    .filter((alias) => alias !== ''),
  body: row.body,
  createdAt: row.created_at,
})

const SELECT =
  'SELECT id, show_id, category_key, category_id, name, standing, status, aliases, body, created_at FROM canon_entity'

/**
 * Registers an identity: a name, in a category, in a show. Nothing else.
 *
 * If the show has declared that category, the row is linked to it; if it has not — every
 * E1 test, and any loader that registers before it declares — the key stands alone and the
 * link arrives when the category does. A trigger keeps the two from ever disagreeing.
 */
export function registerEntity(
  store: Store,
  entity: { showId: string; categoryKey: string; name: string },
): CanonEntity {
  return store.transaction(() => {
    const id = newId('ent')
    const category = findCategory(store, entity.showId, entity.categoryKey)
    store.run(
      'INSERT INTO canon_entity (id, show_id, category_key, category_id, name) VALUES (?, ?, ?, ?, ?)',
      id,
      entity.showId,
      entity.categoryKey,
      category?.id ?? null,
      entity.name,
    )
    return hydrate(store.get<EntityRow>(`${SELECT} WHERE id = ?`, id)!)
  })
}

/**
 * Points an already-registered identity at its category. **This writes no canon**, and the
 * distinction is worth being exact about: `category_key` has said which category this is
 * since 0001, and `category_id` is the same answer as an edge the graph can join on. A row
 * that has only the key is one registered before its show declared its categories — every
 * E1-era library, including Ryan's — and nothing about it may be traversed or inherited
 * until the link exists (`relate` and `factsInScope` both start at `categoryId`).
 *
 * Idempotent, and it refuses rather than clears: linking a row whose show still has no such
 * category is a caller who declared nothing, not a row to blank.
 */
export function linkCategory(store: Store, id: string): CanonEntity {
  return store.transaction(() => {
    const entity = findEntityById(store, id)
    if (!entity) throw new Error(`No such canon entity: ${id}`)

    const category = findCategory(store, entity.showId, entity.categoryKey)
    if (!category) {
      throw new Error(
        `“${entity.name}” is registered as a ${entity.categoryKey}, and this show has not ` +
          `declared a \`${entity.categoryKey}\` category. Declare it first — a category is ` +
          'a row rather than code, so that is an edit rather than engineering.',
      )
    }

    store.run('UPDATE canon_entity SET category_id = ? WHERE id = ?', category.id, id)
    return findEntityById(store, id)!
  })
}

/**
 * Writes the sheet onto an identity — standing, status, aliases, prose. **This is what a
 * ratified promotion proposal calls** (E2-2), and it is not itself a ratification: calling
 * it directly writes canon nobody ruled on, which is the one thing invariant 1 forbids.
 *
 * Every part is optional and what is left out is left alone, so ratifying a proposal that
 * only moves an entity from candidate to active cannot silently blank its prose.
 */
export function amendEntity(
  store: Store,
  id: string,
  sheet: {
    standing?: EntityStanding
    status?: EntityStatus
    aliases?: string[]
    body?: string
  },
): CanonEntity {
  return store.transaction(() => {
    const before = findEntityById(store, id)
    if (!before) throw new Error(`No such canon entity: ${id}`)

    store.run(
      'UPDATE canon_entity SET standing = ?, status = ?, aliases = ?, body = ? WHERE id = ?',
      sheet.standing ?? before.standing,
      sheet.status ?? before.status,
      (sheet.aliases ?? before.aliases).join(', '),
      sheet.body ?? before.body,
      id,
    )
    return findEntityById(store, id)!
  })
}

export function findEntity(
  store: Store,
  where: { showId: string; categoryKey: string; name: string },
): CanonEntity | undefined {
  const row = store.get<EntityRow>(
    `${SELECT} WHERE show_id = ? AND category_key = ? AND name = ?`,
    where.showId,
    where.categoryKey,
    where.name,
  )
  return row === undefined ? undefined : hydrate(row)
}

export function findEntityById(store: Store, id: string): CanonEntity | undefined {
  const row = store.get<EntityRow>(`${SELECT} WHERE id = ?`, id)
  return row === undefined ? undefined : hydrate(row)
}

export function entitiesOfShow(store: Store, showId: string): CanonEntity[] {
  return store
    .all<EntityRow>(`${SELECT} WHERE show_id = ? ORDER BY category_key, name`, showId)
    .map(hydrate)
}

/**
 * The entities behind a set of ids, hydrated whole. This is what an artifact's provenance
 * resolves through (invariant 2) and what E3's check scope will load: one place that knows
 * how to turn an entity row into a `CanonEntity`, so growing the anatomy never leaves a
 * second hand-built copy behind somewhere.
 */
export function entitiesByIds(store: Store, ids: string[]): CanonEntity[] {
  if (ids.length === 0) return []
  return store
    .all<EntityRow>(
      `${SELECT} WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY category_key, name`,
      ...ids,
    )
    .map(hydrate)
}

// ── References ──────────────────────────────────────────────────────────────────

export function addReference(
  store: Store,
  reference: {
    entityId: string
    kind: ReferenceKind
    filePath: string
    stance: ReferenceStance
    label?: string
  },
): EntityReference {
  const id = newId('ref')
  store.run(
    'INSERT INTO entity_reference (id, entity_id, kind, file_path, stance, label) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    reference.entityId,
    reference.kind,
    reference.filePath,
    reference.stance,
    reference.label ?? '',
  )
  return hydrateReference(store.get<ReferenceRow>('SELECT * FROM entity_reference WHERE id = ?', id)!)
}

export function referencesOf(store: Store, entityId: string): EntityReference[] {
  return store
    .all<ReferenceRow>(
      'SELECT * FROM entity_reference WHERE entity_id = ? ORDER BY kind, file_path',
      entityId,
    )
    .map(hydrateReference)
}

export function removeReference(store: Store, id: string): void {
  store.run('DELETE FROM entity_reference WHERE id = ?', id)
}

interface ReferenceRow {
  id: string
  entity_id: string
  kind: ReferenceKind
  file_path: string
  stance: ReferenceStance
  label: string
  created_at: string
}

const hydrateReference = (row: ReferenceRow): EntityReference => ({
  id: row.id,
  entityId: row.entity_id,
  kind: row.kind,
  filePath: row.file_path,
  stance: row.stance,
  label: row.label,
  createdAt: row.created_at,
})

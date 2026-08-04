import type { Store } from '../db/store.ts'
import { newId } from './id.ts'

/**
 * The identity of a canon entity — and nothing else.
 *
 * E1-2 needs this table so artifact provenance can be a real foreign key: invariant 2
 * says checks load exactly the entities in scope, and an unenforced reference can
 * silently load nothing. Registering an identity is not writing canon and not a
 * ratification — the prose body, facts, standing, references, and relations are E2's,
 * and they arrive only through ratified proposals (invariant 1).
 */
export interface CanonEntity {
  id: string
  showId: string
  categoryKey: string
  name: string
  createdAt: string
}

interface EntityRow {
  id: string
  show_id: string
  category_key: string
  name: string
  created_at: string
}

const hydrate = (row: EntityRow): CanonEntity => ({
  id: row.id,
  showId: row.show_id,
  categoryKey: row.category_key,
  name: row.name,
  createdAt: row.created_at,
})

const SELECT = 'SELECT id, show_id, category_key, name, created_at FROM canon_entity'

export function registerEntity(
  store: Store,
  entity: { showId: string; categoryKey: string; name: string },
): CanonEntity {
  const id = newId('ent')
  store.run(
    'INSERT INTO canon_entity (id, show_id, category_key, name) VALUES (?, ?, ?, ?)',
    id,
    entity.showId,
    entity.categoryKey,
    entity.name,
  )
  return hydrate(store.get<EntityRow>(`${SELECT} WHERE id = ?`, id)!)
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

export function entitiesOfShow(store: Store, showId: string): CanonEntity[] {
  return store
    .all<EntityRow>(`${SELECT} WHERE show_id = ? ORDER BY category_key, name`, showId)
    .map(hydrate)
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, migrationsOnDisk, RESERVED_TABLE_NAME } from './migrate.ts'
import { openStore, type Store } from './store.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
})

afterEach(() => {
  store.close()
})

/** The tables E1-2 owns. E2 adds to this list; it never alters what is here. */
const SPINE_TABLE = [
  'arc',
  'arc_edit',
  'arc_waypoint',
  'artifact',
  'artifact_input',
  'artifact_provenance',
  'artifact_revision',
  'canon_entity',
  'episode',
  'episode_arc_position',
  'scene',
  'schema_migration',
  'season',
  'show',
]

function tableNames(s: Store): string[] {
  return s
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((row) => row.name)
}

describe('the migrations runner', () => {
  it('applies every numbered file in order and records what it applied', () => {
    const applied = migrate(store)

    expect(applied.map((m) => m.number)).toEqual(migrationsOnDisk().map((m) => m.number))
    expect(applied.map((m) => m.number)).toEqual([...applied.map((m) => m.number)].sort((a, b) => a - b))
    expect(applied.length).toBeGreaterThan(0)

    const recorded = store.all<{ number: number; name: string }>(
      'SELECT number, name FROM schema_migration ORDER BY number',
    )
    expect(recorded.map((r) => r.number)).toEqual(applied.map((m) => m.number))
  })

  it('is idempotent — a second run applies nothing', () => {
    migrate(store)

    expect(migrate(store)).toEqual([])
  })

  it('creates exactly the spine tables E1-2 owns', () => {
    migrate(store)

    expect(tableNames(store)).toEqual(SPINE_TABLE)
  })

  it('leaves E2’s reserved names unclaimed', () => {
    migrate(store)

    const claimed = tableNames(store).filter((name) => RESERVED_TABLE_NAME.includes(name))
    expect(claimed).toEqual([])
    expect(RESERVED_TABLE_NAME).toContain('fact')
    expect(RESERVED_TABLE_NAME).toContain('proposal')
    expect(RESERVED_TABLE_NAME).toContain('relation')
    expect(RESERVED_TABLE_NAME).toContain('relation_type')
  })
})

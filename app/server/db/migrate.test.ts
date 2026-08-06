import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, MIGRATION_DIR, migrationsOnDisk, RESERVED_TABLE_NAME } from './migrate.ts'
import { openStore, type Store } from './store.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
})

afterEach(() => {
  store.close()
})

/** The tables E1-2 owns. A later epic adds to this list; it never alters what is here. */
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
  'season',
  'show',
]

/** The tables E1-3 owns: the run ledger and the named locks. No pipeline lives here. */
const RUNNER_TABLE = ['resource_lock', 'run', 'step', 'step_attempt']

/**
 * The tables E1-5 owns: the append-only log, and (from 0004) the kinds it will accept.
 * Still no topic and no subscription beside them.
 */
const EVENT_TABLE = ['event', 'event_kind']

/** The tables E1-4 owns: the decision object, its rounds, their rulings, and the notes. */
const GATE_TABLE = ['gate', 'gate_note', 'gate_round', 'gate_ruling']

/**
 * The tables E1-6 owns: what every call cost, and what a show may spend in a week. E6
 * writes its image and audio rows into `cost_entry` too — that is why there is no second
 * table waiting to be added for them.
 */
const COST_TABLE = ['cost_entry', 'show_budget']

/**
 * The tables E2-0 owns: the canon graph. `canon_entity` is NOT here — 0006 grows E1-2's
 * table with ADD COLUMN and never rebuilds it, because `artifact_provenance` holds a
 * foreign key into it and SQLite has no ADD CONSTRAINT.
 */
const CANON_TABLE = [
  'canon_category',
  'category_artifact_kind',
  'category_field',
  'entity_reference',
  'relation',
  'relation_type',
]

const EVERY_TABLE = [
  ...SPINE_TABLE,
  ...RUNNER_TABLE,
  ...EVENT_TABLE,
  ...GATE_TABLE,
  ...COST_TABLE,
  ...CANON_TABLE,
  'schema_migration',
].sort()

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

  it('creates exactly the spine tables and the run ledger, and nothing else', () => {
    migrate(store)

    expect(tableNames(store)).toEqual(EVERY_TABLE)
  })

  it('leaves the names still reserved unclaimed, and claims the three 0006 took', () => {
    migrate(store)

    // What is left: E2-1's facts and E2-2's proposals. 0006 took the other three.
    const claimed = tableNames(store).filter((name) => RESERVED_TABLE_NAME.includes(name))
    expect(claimed).toEqual([])
    expect(RESERVED_TABLE_NAME).toContain('fact')
    expect(RESERVED_TABLE_NAME).toContain('proposal')
    expect(RESERVED_TABLE_NAME).not.toContain('relation')
    expect(tableNames(store)).toEqual(expect.arrayContaining(['relation', 'relation_type', 'canon_category']))
  })
})

/**
 * 0004 rebuilds `event` to trade the `kind` CHECK for a foreign key into `event_kind`.
 * Rebuilding the audit trail is the one thing in this schema that could quietly lose
 * history, so it is proved rather than trusted: a log written under 0003 has to come out
 * the other side byte for byte, still numbered the same, still un-editable.
 */
/** Everything up to `upTo`, applied by hand, so a later migration meets a library with rows in it. */
function applyThrough(upTo: number): void {
  store.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    number INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`)
  for (const migration of migrationsOnDisk().filter((m) => m.number <= upTo)) {
    store.exec(readFileSync(join(MIGRATION_DIR, migration.file), 'utf8'))
    store.run(
      'INSERT INTO schema_migration (number, name) VALUES (?, ?)',
      migration.number,
      migration.name,
    )
  }
}

describe('0004 · rebuilding the event log', () => {
  function writeThreeEvents(): void {
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")
    store.run("INSERT INTO episode (id, season_id, number, title) VALUES ('ep5', 'season1', 5, 'The Quiet Deck')")
    store.run("INSERT INTO run (id, episode_id, stage) VALUES ('run1', 'ep5', 'write')")
    for (const [kind, summary] of [
      ['run-queued', 'write is queued'],
      ['run-started', 'write is running'],
      ['step-chunk', 'Debt has a temperature.'],
    ]) {
      store.run(
        'INSERT INTO event (kind, run_id, episode_id, summary, detail) VALUES (?, ?, ?, ?, ?)',
        kind!,
        'run1',
        'ep5',
        summary!,
        '{"stage":"write"}',
      )
    }
  }

  it('carries every row across with its seq, and keeps numbering above the highest', () => {
    applyThrough(3)
    writeThreeEvents()
    const before = store.all('SELECT * FROM event ORDER BY seq')

    // Everything from 0004 on, whatever has been added since — the subject here is that
    // 0004 ran against a log with rows in it, not how many migrations exist today.
    expect(migrate(store).map((m) => m.number)).toEqual(
      migrationsOnDisk()
        .map((m) => m.number)
        .filter((number) => number > 3),
    )

    expect(store.all('SELECT * FROM event ORDER BY seq')).toEqual(before)
    // AUTOINCREMENT reads sqlite_sequence, and the explicit-seq copy has to have moved it —
    // otherwise the next append reuses seq 1 and every SSE id a browser holds goes stale.
    expect(
      store.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'event'"),
    ).toEqual({ seq: 3 })
    store.run(
      "INSERT INTO event (kind, run_id, episode_id, summary) VALUES ('gate-opened', 'run1', 'ep5', 'the ep05 script gate is open')",
    )
    expect(store.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM event')).toEqual({ seq: 4 })
  })

  it('leaves the log append-only — the triggers survive the rebuild', () => {
    applyThrough(3)
    writeThreeEvents()
    migrate(store)

    expect(() => store.run("UPDATE event SET summary = 'never happened' WHERE seq = 1")).toThrow(
      /append-only/,
    )
    expect(() => store.run('DELETE FROM event WHERE seq = 1')).toThrow(/append-only/)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM event')).toEqual({ n: 3 })
  })
})

/**
 * 0006 grows `canon_entity` rather than rebuilding it. The reason is one table over:
 * `artifact_provenance` carries a foreign key into it, put there in E1-2 precisely because
 * SQLite has no ADD CONSTRAINT — rebuild the entity table and that edge is what breaks.
 * Ryan's library already holds entities and provenance from the E1 drill, so this is proved
 * against rows rather than against an empty file.
 */
describe('0006 · growing canon_entity, not rebuilding it', () => {
  function writeAnEntityWithProvenance(): void {
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")
    store.run("INSERT INTO episode (id, season_id, number, title) VALUES ('ep1', 'season1', 1, 'The Long Pier')")
    store.run(
      "INSERT INTO canon_entity (id, show_id, category_key, name) VALUES ('ent1', 'show1', 'character', 'Tobin Wick')",
    )
    store.run("INSERT INTO artifact (id, episode_id, kind) VALUES ('art1', 'ep1', 'script')")
    store.run("INSERT INTO artifact_provenance (artifact_id, entity_id) VALUES ('art1', 'ent1')")
  }

  it('keeps every entity row and the provenance edge pointing at it', () => {
    applyThrough(5)
    writeAnEntityWithProvenance()

    expect(migrate(store).map((m) => m.number)).toEqual(
      migrationsOnDisk().map((m) => m.number).filter((number) => number > 5),
    )

    expect(store.get('SELECT id, show_id, category_key, name FROM canon_entity')).toEqual({
      id: 'ent1',
      show_id: 'show1',
      category_key: 'character',
      name: 'Tobin Wick',
    })
    expect(store.get('SELECT * FROM artifact_provenance')).toEqual({
      artifact_id: 'art1',
      entity_id: 'ent1',
    })
    // The edge is still ENFORCED, not merely still present: RESTRICT is what makes an
    // entity an episode was built on undeletable, and a rebuilt table loses it silently.
    expect(() => store.run("DELETE FROM canon_entity WHERE id = 'ent1'")).toThrow(/FOREIGN KEY/i)
  })

  it('gives an entity registered before E2 the anatomy it never declared', () => {
    applyThrough(5)
    writeAnEntityWithProvenance()
    migrate(store)

    // `candidate` is the truthful default: nothing ratified this row (invariant 1). Standing
    // is NULL because "not declared yet" and "declared one-shot" are different states.
    expect(
      store.get('SELECT category_id, standing, status, aliases, body FROM canon_entity'),
    ).toEqual({ category_id: null, standing: null, status: 'candidate', aliases: '', body: '' })
  })
})

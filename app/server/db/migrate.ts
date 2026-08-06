import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from './store.ts'

/**
 * Plain numbered SQL files, applied in order, recorded when applied. That is the whole
 * migration system — no framework, no DSL, no generated schema (the Archon rule).
 *
 * A migration is `NNNN_name.sql`. It is applied once, inside a transaction, and never
 * edited afterwards: change the schema by adding the next number.
 */

export const MIGRATION_DIR = join(import.meta.dirname, 'migrations')

/**
 * Table names E2 owns and has not built yet. E1-2 must not create them — that is what keeps
 * E2 from having to ALTER (or in SQLite, rebuild) E1-2's tables to fit canon in. See
 * 0001_spine.sql, whose reserved block lists all five and is not edited: 0006 took
 * `relation`, `relation_type` and `canon_category`, and says so in its own header. What is
 * left is `fact` (E2-1) and `proposal` (E2-2).
 */
export const RESERVED_TABLE_NAME: readonly string[] = ['fact', 'proposal']

export interface Migration {
  number: number
  name: string
  file: string
}

export interface AppliedMigration {
  number: number
  name: string
  appliedAt: string
}

const FILENAME = /^(\d{4})_([a-z0-9-]+)\.sql$/

/** Every migration file on disk, in number order. */
export function migrationsOnDisk(): Migration[] {
  const migrations = readdirSync(MIGRATION_DIR)
    .map((file) => {
      const match = FILENAME.exec(file)
      if (!match) return undefined
      return { number: Number(match[1]), name: match[2]!, file }
    })
    .filter((m) => m !== undefined)
    .sort((a, b) => a.number - b.number)

  const numbers = new Set(migrations.map((m) => m.number))
  if (numbers.size !== migrations.length) {
    throw new Error(`Two migrations share a number in ${MIGRATION_DIR}`)
  }
  return migrations
}

export function appliedMigrations(store: Store): AppliedMigration[] {
  ensureLedger(store)
  return store.all<{ number: number; name: string; applied_at: string }>(
    'SELECT number, name, applied_at FROM schema_migration ORDER BY number',
  ).map((row) => ({ number: row.number, name: row.name, appliedAt: row.applied_at }))
}

/** Applies every migration not yet applied. Returns the ones it applied — empty on a no-op. */
export function migrate(store: Store): AppliedMigration[] {
  ensureLedger(store)
  const already = new Set(appliedMigrations(store).map((m) => m.number))

  const applied: AppliedMigration[] = []
  for (const migration of migrationsOnDisk()) {
    if (already.has(migration.number)) continue
    const sql = readFileSync(join(MIGRATION_DIR, migration.file), 'utf8')
    store.transaction(() => {
      store.exec(sql)
      store.run(
        'INSERT INTO schema_migration (number, name) VALUES (?, ?)',
        migration.number,
        migration.name,
      )
    })
    applied.push({
      number: migration.number,
      name: migration.name,
      appliedAt: store.get<{ applied_at: string }>(
        'SELECT applied_at FROM schema_migration WHERE number = ?',
        migration.number,
      )!.applied_at,
    })
  }
  return applied
}

function ensureLedger(store: Store): void {
  store.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      number      INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
}

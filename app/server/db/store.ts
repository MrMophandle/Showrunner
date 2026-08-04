import { DatabaseSync } from 'node:sqlite'

/**
 * The one seam onto SQLite. `node:sqlite` is imported here and nowhere else — schema,
 * spine, artifact, and arc code all take a `Store` and never touch a database handle.
 * That is what makes a driver swap a one-module change instead of a migration.
 *
 * The API is deliberately dumb: hand-written SQL in, typed rows out. No query builder,
 * no ORM, no schema DSL (the Archon rule).
 */

/** Everything SQLite will bind to a `?` placeholder. */
export type SqlValue = string | number | bigint | null | Uint8Array

export interface Store {
  /** The first row, or undefined. */
  get<T>(sql: string, ...params: SqlValue[]): T | undefined
  /** Every row. */
  all<T>(sql: string, ...params: SqlValue[]): T[]
  /** A statement that returns no rows. */
  run(sql: string, ...params: SqlValue[]): { changes: number }
  /** One or more statements with no parameters — migrations and pragmas. */
  exec(sql: string): void
  /** Runs `body` in a transaction; any throw rolls the whole thing back. */
  transaction<T>(body: () => T): T
  close(): void
}

/**
 * Opens the library database. `':memory:'` gives a throwaway one for tests.
 * WAL keeps readers off the writer's back; foreign keys are on so a dangling
 * reference is refused at the door rather than discovered by a check.
 */
export function openStore(databaseFile: string): Store {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  let depth = 0

  // The driver hands back null-prototype rows; plain objects are what the rest of
  // the app (and `toEqual`) expects.
  const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T

  return {
    get<T>(sql: string, ...params: SqlValue[]): T | undefined {
      const row = db.prepare(sql).get(...params)
      return row === undefined ? undefined : plain<T>(row)
    },
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return db.prepare(sql).all(...params).map((row) => plain<T>(row))
    },
    run(sql: string, ...params: SqlValue[]) {
      const result = db.prepare(sql).run(...params)
      return { changes: Number(result.changes) }
    },
    exec(sql: string) {
      db.exec(sql)
    },
    transaction<T>(body: () => T): T {
      // Nested calls join the outer transaction rather than starting a second one.
      if (depth > 0) return body()
      db.exec('BEGIN')
      depth += 1
      try {
        const result = body()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        depth -= 1
      }
    },
    close() {
      db.close()
    },
  }
}

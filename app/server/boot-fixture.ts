import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appliedMigrations, MIGRATION_DIR, migrationsOnDisk } from './db/migrate.ts'
import { libraryPaths, openLibraryStore } from './library.ts'

/**
 * The two libraries a boot test needs to talk about: one an older build left behind, and
 * the question "what number is this file at". Shared by `boot.test.ts` and `index.test.ts`
 * — the window and the entry point ask the same thing of the same volume, and a second
 * copy of this would be the thing that quietly drifts.
 *
 * Not a test file (vitest collects `*.test.ts` only) and not a fixture show — the Grey
 * Harbor fixture is `fixture/`, and this is about the schema underneath it.
 */

/**
 * A library as an older build left it: the migrations up to `through` applied and recorded,
 * nothing after them. Written the way `migrate` writes them — the file, then its ledger row,
 * in one transaction — because a library that lied about where it stood would prove nothing
 * about a boot that reads it and says `starting — migrating N → M`.
 */
export function libraryBehindSchema(root: string, through: number): void {
  const paths = libraryPaths(root)
  mkdirSync(paths.artifactDir, { recursive: true })
  const store = openLibraryStore(paths)
  try {
    appliedMigrations(store) // creates the ledger, exactly as `migrate` does
    for (const migration of migrationsOnDisk().filter((m) => m.number <= through)) {
      store.transaction(() => {
        store.exec(readFileSync(join(MIGRATION_DIR, migration.file), 'utf8'))
        store.run(
          'INSERT INTO schema_migration (number, name) VALUES (?, ?)',
          migration.number,
          migration.name,
        )
      })
    }
  } finally {
    store.close()
  }
}

/** What schema number the file on disk is at — 0 if nothing has ever migrated it. */
export function schemaOf(root: string): number {
  const store = openLibraryStore(libraryPaths(root))
  try {
    return appliedMigrations(store).at(-1)?.number ?? 0
  } finally {
    store.close()
  }
}

/** The schema number this build's migration files go up to. */
export const CURRENT_SCHEMA = migrationsOnDisk().at(-1)?.number ?? 0

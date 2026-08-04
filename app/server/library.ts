import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { migrate } from './db/migrate.ts'
import { openStore, type Store } from './db/store.ts'

/**
 * The library volume (D2): SQLite for structure, plain files for heavy artifacts,
 * all of it on a mounted volume so it stays human-readable and git-versionable.
 * In the container this is `/app/library`, bind-mounted from `./library` on the host.
 */
export interface LibraryPaths {
  /** The mount point itself. */
  root: string
  /** The one SQLite file, carrying the schema in `db/migrations/`. */
  databaseFile: string
  /** Where artifacts land as plain files. */
  artifactDir: string
}

/** Where the library lives. `LIBRARY_DIR` is set by compose; `./library` is the local default. */
export function libraryRoot(): string {
  return process.env.LIBRARY_DIR ?? join(process.cwd(), 'library')
}

export function libraryPaths(root: string): LibraryPaths {
  const abs = resolve(root)
  return {
    root: abs,
    databaseFile: join(abs, 'showrunner.db'),
    artifactDir: join(abs, 'artifact'),
  }
}

/** Opens (creating if absent) the library database. Callers close it. */
export function openLibraryStore(paths: LibraryPaths): Store {
  return openStore(paths.databaseFile)
}

/**
 * Writes a file only when nothing is there. A hand-made asset always wins (D20):
 * existing files are never overwritten, re-runs fill gaps only.
 */
export function writeIfAbsent(path: string, contents: string): 'written' | 'kept' {
  if (existsSync(path)) return 'kept'
  writeFileSync(path, contents, 'utf8')
  return 'written'
}

const SCAFFOLD_ARTIFACT = `Showrunner — scaffold artifact (E1-1)

If you are reading this on the host, the library volume is mounted correctly:
the SQLite file and every artifact live out here, not inside the container.

This file is not canon. Only ratification writes canon.
`

/**
 * Creates the library layout, migrates the SQLite file to the current schema, and writes
 * one sample artifact. Idempotent — run it on every boot.
 */
export function initLibrary(root: string = libraryRoot()): LibraryPaths {
  const paths = libraryPaths(root)
  mkdirSync(paths.artifactDir, { recursive: true })
  const store = openLibraryStore(paths)
  try {
    migrate(store)
  } finally {
    store.close()
  }
  writeIfAbsent(join(paths.artifactDir, 'hello.txt'), SCAFFOLD_ARTIFACT)
  return paths
}

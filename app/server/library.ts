import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appliedMigrations, migrate, migrationsOnDisk } from './db/migrate.ts'
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

/** Where the SQLite file stands, and where this build needs it to. */
export interface LibraryStanding {
  /** The one store, open. The caller closes it. */
  store: Store
  /** The schema number the file is at — 0 on a library nothing has ever migrated. */
  from: number
  /** The schema number this build's migration files go up to. */
  to: number
}

/**
 * The first half of opening a library: the layout, the store, and what bringing it to this
 * build's schema will take — **without taking it**.
 *
 * The halves are separate for one reason (#49): the boot has to say `starting — migrating
 * N → M` *before* it starts, and a function that migrated on its way to telling you could
 * only ever announce the past. `boot.ts` is the caller that needs the gap; `initLibrary`
 * below is the same two acts with nobody to tell.
 *
 * **Everything this touches on disk is created here** — the directories, and `showrunner.db`
 * itself, which `node:sqlite` creates the moment it is opened. That is why the boot does not
 * call it until the port is bound: a process that was always going to lose the port must not
 * leave a file behind on its way down.
 */
export function openLibraryForBoot(paths: LibraryPaths): LibraryStanding {
  mkdirSync(paths.artifactDir, { recursive: true })
  const store = openLibraryStore(paths)
  return {
    store,
    from: appliedMigrations(store).at(-1)?.number ?? 0,
    to: migrationsOnDisk().at(-1)?.number ?? 0,
  }
}

/** The second half: every migration not yet applied, in order, then the sample artifact. */
export function migrateLibrary(store: Store, paths: LibraryPaths): void {
  migrate(store)
  writeIfAbsent(join(paths.artifactDir, 'hello.txt'), SCAFFOLD_ARTIFACT)
}

/**
 * Creates the library layout, migrates the SQLite file to the current schema, and writes
 * one sample artifact. Idempotent — run it on every boot.
 */
export function initLibrary(root: string = libraryRoot()): LibraryPaths {
  const paths = libraryPaths(root)
  const { store } = openLibraryForBoot(paths)
  try {
    migrateLibrary(store, paths)
  } finally {
    store.close()
  }
  return paths
}

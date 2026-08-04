import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore } from './db/store.ts'
import { initLibrary, libraryPaths, openLibraryStore, writeIfAbsent } from './library.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-library-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the library volume', () => {
  it('creates the SQLite file and a sample artifact under the mount', () => {
    const paths = initLibrary(root)

    expect(paths.root).toBe(root)
    expect(statSync(paths.databaseFile).size).toBeGreaterThan(0)
    expect(readFileSync(join(paths.artifactDir, 'hello.txt'), 'utf8')).toContain('Showrunner')
  })

  it('is idempotent — a second boot changes nothing', () => {
    initLibrary(root)
    const stamped = statSync(join(root, 'artifact', 'hello.txt')).mtimeMs

    initLibrary(root)

    expect(statSync(join(root, 'artifact', 'hello.txt')).mtimeMs).toBe(stamped)
  })

  it('never overwrites a hand-made asset', () => {
    const paths = initLibrary(root)
    const artifact = join(paths.artifactDir, 'hello.txt')
    writeFileSync(artifact, 'Ryan wrote this by hand.', 'utf8')

    expect(writeIfAbsent(artifact, 'the generated version')).toBe('kept')
    initLibrary(root)

    expect(readFileSync(artifact, 'utf8')).toBe('Ryan wrote this by hand.')
  })

  it('opens the database in WAL mode with foreign keys on', () => {
    const paths = libraryPaths(root)
    initLibrary(root)
    const store = openLibraryStore(paths)

    try {
      expect(store.get('PRAGMA journal_mode')).toMatchObject({ journal_mode: 'wal' })
      expect(store.get('PRAGMA foreign_keys')).toMatchObject({ foreign_keys: 1 })
    } finally {
      store.close()
    }
  })

  it('migrates on boot, so the app never comes up on a schema-less file', () => {
    const paths = initLibrary(root)
    const migrated = openLibraryStore(paths)
    const untouched = openStore(join(root, 'never-booted.db'))

    try {
      expect(
        migrated.all('SELECT number FROM schema_migration ORDER BY number'),
      ).not.toHaveLength(0)
      expect(
        untouched.get("SELECT name FROM sqlite_master WHERE name = 'schema_migration'"),
      ).toBeUndefined()
    } finally {
      migrated.close()
      untouched.close()
    }
  })
})

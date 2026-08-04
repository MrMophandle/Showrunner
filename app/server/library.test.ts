import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLibrary, libraryPaths, openDatabase, writeIfAbsent } from './library.ts'

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
    const db = openDatabase(paths)

    try {
      expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
    } finally {
      db.close()
    }
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { arcsOf, isVanilla, positionsOf, waypointsOf } from '../domain/arc.ts'
import { artifactsOf, provenanceOf } from '../domain/artifact.ts'
import { entitiesOfShow } from '../domain/canon.ts'
import { episodesOf, findShowByKey, scenesOf, seasonsOf } from '../domain/spine.ts'
import { initLibrary, libraryPaths, openLibraryStore, type LibraryPaths } from '../library.ts'
import { loadFixture } from './load.ts'

/**
 * `npm run fixture:load`, against a real library volume in a temp directory.
 *
 * The load is held to two things at once: that it puts the whole fixture in — every
 * shape the sheets declare, through the same typed domain functions the app uses — and
 * that running it a second time changes nothing. Idempotent here means re-runnable, not
 * guarded: the second load walks every sheet, finds every row, and writes none.
 */

let root: string
let paths: LibraryPaths
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-fixture-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** Every row of every table, so "identical state" means identical, not "close enough". */
function dump(store: Store): Record<string, unknown[]> {
  const tables = store.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  return Object.fromEntries(
    tables.map(({ name }) => [name, store.all<unknown>(`SELECT * FROM ${name}`)]),
  )
}

describe('loading the Grey Harbor fixture', () => {
  it('seeds the show, its season, and both episodes at their own lifecycles', () => {
    const report = loadFixture(store, paths)

    expect(report.show.key).toBe('greyharbor')
    expect(findShowByKey(store, 'greyharbor')).toBeDefined()

    const season = seasonsOf(store, report.show.id)[0]!
    expect(season.title).toBe('Slack Water')
    expect(episodesOf(store, season.id).map((e) => [e.number, e.title, e.lifecycle])).toEqual([
      [1, 'The Long Pier', 'script'],
      [2, 'Dry Stores', 'premise'],
    ])
  })

  it('registers six canon entity identities — and only identities (invariant 1)', () => {
    const report = loadFixture(store, paths)

    expect(entitiesOfShow(store, report.show.id).map((e) => [e.categoryKey, e.name])).toEqual([
      ['character', 'Ilse Renn'],
      ['character', 'Tobin Wick'],
      ['location', 'Grey Harbor Station'],
      ['species', 'Halvani'],
      ['technology', 'Kestrel-pattern containment collar'],
      ['world-rules', 'The hull and the void'],
    ])

    // The sheets carry facts, relations, standings and prose bodies. None of that is in
    // the database, because writing it would be canon written by an import — which is
    // the one thing the first invariant names outright. E2's proposal flow puts it in.
    expect(report.entities.created).toBe(6)
    expect(
      store.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('fact','relation','relation_type','proposal','canon_category')",
      ),
    ).toEqual([])
  })

  it('derives episode 1’s scenes from its script, in order, with their summaries', () => {
    const report = loadFixture(store, paths)
    const episode = episodeOne(store, report.show.id)

    const scenes = scenesOf(store, episode)
    expect(scenes.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6])
    expect(scenes[3]!.heading).toBe('EXT. THE LONG PIER — 07:07')
    expect(scenes[3]!.summary).toMatch(/relay housing at the head of the pier/)
    expect(report.scenes).toBe(6)
  })

  it('records the artifacts with their provenance and freshness edges, and writes the files', () => {
    const report = loadFixture(store, paths)
    const episode = episodeOne(store, report.show.id)

    const artifacts = artifactsOf(store, episode)
    expect(artifacts.map((a) => a.kind).sort()).toEqual(['outline', 'premise-brief', 'script'])

    const script = artifacts.find((a) => a.kind === 'script')!
    expect(script.filePath).toBe('greyharbor/s01e01/script.md')
    expect(readFileSync(join(paths.artifactDir, script.filePath!), 'utf8')).toMatch(
      /four Kestrel collars hang closed on their pegs/,
    )
    expect(provenanceOf(store, script.id).map((e) => e.name)).toEqual([
      'Ilse Renn',
      'Tobin Wick',
      'Grey Harbor Station',
      'Halvani',
      'Kestrel-pattern containment collar',
      'The hull and the void',
    ])

    const outline = artifacts.find((a) => a.kind === 'outline')!
    expect(
      store.all<{ input_artifact_id: string }>(
        'SELECT input_artifact_id FROM artifact_input WHERE artifact_id = ?',
        script.id,
      ),
    ).toEqual([{ input_artifact_id: outline.id }])

    // The un-started episode produces nothing. Not an empty file, not a null-path row.
    expect(artifactsOf(store, episodeTwo(store, report.show.id))).toEqual([])
  })

  it('builds the arc with its statement and landing criteria, and puts episode 1 on waypoint 2', () => {
    const report = loadFixture(store, paths)

    const arc = arcsOf(store, report.show.id)[0]!
    expect(report.arcs).toEqual({ created: 1, found: 0 })
    expect(arc.name).toBe('What the harbor is for')
    expect(arc.scope).toBe('season')
    expect(arc.statement).toMatch(/what the harbour is actually for/)

    const waypoints = waypointsOf(store, arc.id)
    expect(waypoints.map((w) => w.name)).toEqual([
      'The harbor is a job',
      'The harbor is worth spending on',
      'The harbor is hers',
    ])
    for (const waypoint of waypoints) {
      expect(waypoint.description).not.toBe('')
      expect(waypoint.landingCriteria).not.toBe('')
    }

    const position = positionsOf(store, episodeOne(store, report.show.id))[0]!
    expect([position.arc.name, position.waypoint.ordinal]).toEqual(['What the harbor is for', 2])
    expect(isVanilla(store, episodeTwo(store, report.show.id))).toBe(true)
  })
})

describe('loading the Grey Harbor fixture twice', () => {
  it('leaves every row exactly as it was, having looked at every one of them', () => {
    const first = loadFixture(store, paths)
    const before = dump(store)

    const second = loadFixture(store, paths)

    expect(dump(store)).toEqual(before)

    // Not a guard: the second load walked the whole fixture and found what the first
    // one wrote. An `if (alreadyLoaded) return` would report nothing found at all.
    expect(first.entities).toEqual({ created: 6, found: 0 })
    expect(second.entities).toEqual({ created: 0, found: 6 })
    expect(second.episodes).toEqual({ created: 0, found: 2 })
    expect(second.waypoints).toEqual({ created: 0, found: 3 })
    expect(second.artifacts).toEqual({ created: 0, found: 3 })
    expect(second.scenes).toBe(6)
  })

  it('keeps the artifact files it already wrote, and says so', () => {
    const first = loadFixture(store, paths)
    expect(first.files.map((f) => f.state)).toEqual(['written', 'written', 'written'])

    const second = loadFixture(store, paths)
    expect(second.files.map((f) => f.state)).toEqual(['kept', 'kept', 'kept'])
  })

  it('reports a hand-edited artifact as kept rather than overwriting it (D20)', () => {
    loadFixture(store, paths)
    const script = join(paths.artifactDir, 'greyharbor/s01e01/script.md')
    writeFileSync(script, 'Ryan rewrote this by hand.\n', 'utf8')

    const second = loadFixture(store, paths)

    expect(second.files.find((f) => f.path.endsWith('script.md'))!.state).toBe('differs')
    expect(readFileSync(script, 'utf8')).toBe('Ryan rewrote this by hand.\n')
  })

  it('rebuilds what went missing, because it reconciles rather than skips', () => {
    const first = loadFixture(store, paths)
    const before = dump(store)
    store.run('DELETE FROM episode WHERE number = 2')

    const second = loadFixture(store, paths)

    expect(second.episodes).toEqual({ created: 1, found: 1 })
    const after = dump(store)
    expect(Object.keys(after).map((table) => [table, after[table]!.length])).toEqual(
      Object.keys(before).map((table) => [table, before[table]!.length]),
    )
    expect(episodesOf(store, seasonsOf(store, first.show.id)[0]!.id).map((e) => e.title)).toEqual([
      'The Long Pier',
      'Dry Stores',
    ])
  })
})

describe('loading the fixture into a library that is not empty', () => {
  it('is safe beside another show, and touches nothing of its own outside greyharbor', () => {
    const other = openLibraryStore(libraryPaths(root))
    try {
      other.run("INSERT INTO show (id, key, title) VALUES ('show_x', 'deadlight', 'Dead Light')")
    } finally {
      other.close()
    }

    const report = loadFixture(store, paths)

    expect(store.all<{ key: string }>('SELECT key FROM show ORDER BY key')).toEqual([
      { key: 'deadlight' },
      { key: 'greyharbor' },
    ])
    expect(report.show.key).toBe('greyharbor')
  })
})

function episodeOne(store: Store, showId: string): string {
  return episodesOf(store, seasonsOf(store, showId)[0]!.id)[0]!.id
}

function episodeTwo(store: Store, showId: string): string {
  return episodesOf(store, seasonsOf(store, showId)[0]!.id)[1]!.id
}

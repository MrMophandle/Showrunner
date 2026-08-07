import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { artifactsOf, reviseArtifact, staleArtifacts, type Artifact } from './artifact.ts'
import { factsOfEntity } from './fact.ts'
import {
  boardOf,
  recordExtractedBoard,
  type Board,
  type BoardExtraction,
} from './board.ts'
import { delineateScenes, scenesOf } from './spine.ts'

/**
 * The continuity board (3.2b) as rows: the episode room's scene grid, derived from the
 * script, recorded as an artifact so that a scene edit makes it stale by the machinery E1-2
 * already built.
 *
 * Everything here runs against the REAL Grey Harbor fixture, founded — the script as
 * written, the canon as Ryan would have ruled it. The extraction is hand-scripted
 * (`fixture/long-pier-board.ts`) because extraction is the paid half and no test in this
 * repo spends a cent; what is under test is the half that is free.
 */

let root: string
let paths: LibraryPaths
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-board-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

interface LongPier {
  harbor: FoundedFixture
  episodeId: string
  script: Artifact
  board: Board
}

/** Grey Harbor founded, ep01's script on the volume, and its board extracted by hand. */
function theLongPier(): LongPier {
  const harbor = greyHarborFounded(store, paths)
  const episodeId = store.get<{ id: string }>(
    "SELECT id FROM episode WHERE title = 'The Long Pier'",
  )!.id
  const script = artifactsOf(store, episodeId).find((a) => a.kind === 'script')!

  const board = extractTheLongPier(episodeId, script.id)
  return { harbor, episodeId, script, board }
}

/** The hand-scripted extraction, recorded — the one call a rebuild makes a second time. */
function extractTheLongPier(episodeId: string, scriptId: string): Board {
  return recordExtractedBoard(store, {
    episodeId,
    scriptId,
    extraction: theLongPierExtraction({
      lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factOf('Halvani', 'loses consciousness'),
    }),
  })
}

/** The id of one fact, found by a phrase of its statement — the way the prompt hands it over. */
function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)
  if (!row) throw new Error(`Grey Harbor has no entity called “${entity}”`)
  const fact = factsOfEntity(store, row.id).find((f) => f.statement.includes(needle))
  if (!fact) throw new Error(`${entity} has no fact saying “${needle}”`)
  return fact.id
}

describe('the board is the scene grid', () => {
  it('derives one row per scene, in scene order, in the shape the grid renders', () => {
    const { board } = theLongPier()

    expect(
      board.scenes.map((scene) => ({
        scene: scene.ordinal,
        location: scene.location,
        present: scene.present.map((who) => who.characterName).join(', '),
        environment: scene.environment,
        ship: scene.shipPosition,
        elapsed: scene.elapsedLabel,
      })),
    ).toEqual([
      { scene: 1, location: 'Mess deck', present: 'Ilse Renn, Tobin Wick', environment: 'inside', ship: '', elapsed: '06:10' },
      { scene: 2, location: "Harbourmaster's office", present: 'Ilse Renn, Tobin Wick', environment: 'inside', ship: '', elapsed: '06:40' },
      { scene: 3, location: 'No. 4 lock', present: 'Tobin Wick', environment: 'inside', ship: '', elapsed: '07:05' },
      { scene: 4, location: 'The Long Pier', present: 'Tobin Wick', environment: 'exposed', ship: '', elapsed: '07:07' },
      { scene: 5, location: "Harbourmaster's office", present: 'Ilse Renn, Tobin Wick', environment: 'inside', ship: '', elapsed: '07:20' },
      { scene: 6, location: 'The Long Pier', present: 'Ilse Renn', environment: 'exposed', ship: '', elapsed: 'CONTINUOUS' },
    ])
  })

  it('ties each row to its scene and each body to its canon entity', () => {
    const { harbor, episodeId, board } = theLongPier()
    const scenes = scenesOf(store, episodeId)

    expect(board.scenes.map((scene) => scene.sceneId)).toEqual(scenes.map((scene) => scene.id))
    const tobin = board.scenes[3]!.present[0]!
    expect(tobin).toEqual({
      characterName: 'Tobin Wick',
      entityId: harbor.entity('Tobin Wick').id,
      protection: 'none',
      arrives: true,
    })
    expect(board.scenes[5]!.present[0]!.protection).toEqual('hardsuit')
  })

  it('carries the geography it will compare, both ways, with the fact behind the number', () => {
    const { board } = theLongPier()

    expect(
      board.transits.map((transit) => [transit.from, transit.to, transit.seconds]),
    ).toEqual([
      ["Harbourmaster's office", 'The Long Pier', 90],
      ['No. 4 lock', 'The Long Pier', 90],
      ['The Long Pier', "Harbourmaster's office", 90],
      ['The Long Pier', 'No. 4 lock', 90],
    ])
    expect(board.transits.every((transit) => transit.factId !== null)).toBe(true)
  })

  it('names the fact that makes the void lethal, and never states it itself', () => {
    const { harbor, board } = theLongPier()

    expect(board.hazards).toEqual([
      {
        entityId: harbor.entity('Halvani').id,
        hazard: 'lethal-in-vacuum',
        factId: factOf('Halvani', 'loses consciousness'),
      },
    ])
  })

  it('is read back by episode, because the episode room asks for it that way', () => {
    const { episodeId, board } = theLongPier()

    expect(boardOf(store, episodeId)!.artifact.id).toEqual(board.artifact.id)
    expect(board.artifact.kind).toEqual('continuity-board')
  })
})

describe('nothing here trusts the model', () => {
  /** The Long Pier, extracted, with one thing about it changed. */
  function extractedWith(change: (extraction: BoardExtraction) => void): () => Board {
    greyHarborFounded(store, paths)
    const episodeId = store.get<{ id: string }>(
      "SELECT id FROM episode WHERE title = 'The Long Pier'",
    )!.id
    const script = artifactsOf(store, episodeId).find((a) => a.kind === 'script')!
    const extraction = theLongPierExtraction({
      lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factOf('Halvani', 'loses consciousness'),
    })
    change(extraction)
    return () => recordExtractedBoard(store, { episodeId, scriptId: script.id, extraction })
  }

  it('refuses a grid with a hole in it — a rule cannot see a row that is not there', () => {
    const record = extractedWith((extraction) => {
      extraction.scenes = extraction.scenes.filter((scene) => scene.scene !== 3)
    })

    expect(record).toThrow(/skipped scene 3/)
  })

  it('refuses a protection it does not know, rather than storing the word', () => {
    const record = extractedWith((extraction) => {
      extraction.scenes[3]!.present[0]!.protection = 'a heavy coat' as never
    })

    expect(record).toThrow(/is not a protection/)
  })

  it('refuses an invented entity — the prompt handed over the ones in scope', () => {
    const record = extractedWith((extraction) => {
      extraction.scenes[0]!.present[0]!.entity = 'Vessa Kohl'
    })

    expect(record).toThrow(/no entity by that name or alias/)
  })

  it('refuses a cited fact that does not exist', () => {
    const record = extractedWith((extraction) => {
      extraction.hazards![0]!.fact = 'fact_neversaidit'
    })

    expect(record).toThrow(/does not exist/)
  })
})

describe('the board is an artifact, and E1 already built its freshness', () => {
  it('declares what it consumed, per scene, so one scene edit is one stale board', () => {
    const { episodeId, script, board } = theLongPier()
    expect(staleArtifacts(store, episodeId)).toEqual([])

    const scene3 = scenesOf(store, episodeId)[2]!
    reviseArtifact(store, script.id, {
      summary: 'the lock counter now starts at sixty',
      touchedScenes: [scene3.id],
    })

    const stale = staleArtifacts(store, episodeId)
    expect(stale.map((s) => s.artifact.id)).toEqual([board.artifact.id])
    expect(stale[0]!.reasons[0]).toMatchObject({
      kind: 'input-moved-on',
      consumedVersion: 1,
      currentVersion: 2,
      sceneId: scene3.id,
    })
    // The words the Artifacts panel says: "rebuilt from script v1 · your scene-3 edit made v2".
    expect(stale[0]!.reasons[0]).toMatchObject({
      revisions: [{ version: 2, summary: 'the lock counter now starts at sixty' }],
    })
  })

  it('is fresh again when it is rebuilt, without any freshness code of its own', () => {
    const { episodeId, script, board } = theLongPier()
    const scene3 = scenesOf(store, episodeId)[2]!
    reviseArtifact(store, script.id, { summary: 'a rewrite', touchedScenes: [scene3.id] })
    expect(staleArtifacts(store, episodeId).map((s) => s.artifact.id)).toEqual([board.artifact.id])

    const rebuilt = extractTheLongPier(episodeId, script.id)

    expect(rebuilt.artifact.id).toEqual(board.artifact.id)
    expect(rebuilt.artifact.version).toEqual(2)
    expect(staleArtifacts(store, episodeId)).toEqual([])
  })

  it('leaves no edge behind when the writer cuts a scene', () => {
    const { episodeId, script, board } = theLongPier()
    const scenes = scenesOf(store, episodeId)

    // The last scene goes. Scenes are derived from the script (D3), so re-delineating a
    // shorter episode deletes it — and the board's edge for it must go too, or the board
    // stays stale forever on account of a scene nobody can point at.
    delineateScenes(
      store,
      episodeId,
      scenes.slice(0, 5).map((scene) => ({ heading: scene.heading, summary: scene.summary })),
    )
    const shorter = theLongPierExtraction({
      lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factOf('Halvani', 'loses consciousness'),
    })
    shorter.scenes = shorter.scenes.filter((scene) => scene.scene <= 5)
    const rebuilt = recordExtractedBoard(store, {
      episodeId,
      scriptId: script.id,
      extraction: shorter,
    })

    expect(rebuilt.scenes).toHaveLength(5)
    expect(
      store.get('SELECT COUNT(*) AS n FROM artifact_input WHERE artifact_id = ?', board.artifact.id),
    ).toEqual({ n: 5 })
    expect(staleArtifacts(store, episodeId)).toEqual([])
  })
})

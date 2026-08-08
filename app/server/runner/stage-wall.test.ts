import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, reviseArtifact, type Artifact } from '../domain/artifact.ts'
import { runBoardRules } from '../domain/board-rules.ts'
import { recordExtractedBoard } from '../domain/board.ts'
import { factsOfEntity } from '../domain/fact.ts'
import { dismissFinding, findingsIn, recordCheckPass } from '../domain/finding.ts'
import { scenesOf } from '../domain/spine.ts'
import { greyHarborFounded } from '../fixture/founded.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { stageBlockedBecause, stageBlockingFindings } from './stage-wall.ts'

/**
 * The D12 wall: **deterministic findings block the next stage, and never Ryan's gate.**
 *
 * Everything here is computed off live rows. There is no `blocked` column to set and none to
 * clear, so every test below moves the world — a dismissal, a rewrite, an override — and asks
 * the same question again rather than watching a flag flip.
 *
 * The finding it asks about is the real one: The Long Pier's planted scenes 5–6 contradiction,
 * raised by `runBoardRules` over the hand-written extraction, with no model and no money.
 */

let root: string
let paths: LibraryPaths
let store: Store
let episodeId: string
let script: Artifact

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-stage-wall-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  greyHarborFounded(store, paths)
  episodeId = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'The Long Pier'")!.id
  script = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'script')!
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** The board as the fixture extracted it by hand, and the four rules over it. Free, both. */
function checkTheBoard(): void {
  const board = recordExtractedBoard(store, {
    episodeId,
    scriptId: script.id,
    extraction: theLongPierExtraction({
      lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factOf('Halvani', 'loses consciousness'),
    }),
    filePath: 'greyharbor/s01e01/continuity-board-v1.md',
  })
  runBoardRules(store, board.artifact.id)
}

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

function findingOf(checkKey: string): string {
  return findingsIn(store, script.id).find((finding) => finding.checkKey === checkKey)!.id
}

describe('a deterministic finding refuses the next stage', () => {
  it('names the check, the scene and the artifact — the words a disabled button renders', () => {
    checkTheBoard()

    const blocked = stageBlockedBecause(store, episodeId)

    // The specific finding out of the rows it computed from, never "checks failed". Two of
    // The Long Pier's rules fire, so the sentence names the first in document order and says
    // how many stand behind it — a button has room for one claim.
    expect(blocked).toContain('ep01 is blocked')
    expect(blocked).toContain('vacuum-without-protection')
    expect(blocked).toContain('scene 4 of the ep01 script')
    expect(blocked).toContain('Tobin Wick is outside the pressure hull in scene 4')
    expect(blocked).toContain('1 more deterministic finding stands with it')
    // And what to do about it, because a refusal with no way out is a dead end.
    expect(blocked).toContain('D12')
  })

  it('stands every deterministic finding up, in document order, and nothing else', () => {
    checkTheBoard()

    const standing = stageBlockingFindings(store, episodeId)

    expect(standing.map((block) => [block.finding.checkKey, block.scene, block.subject])).toEqual([
      ['vacuum-without-protection', 4, 'the ep01 script'],
      ['dual-presence', 6, 'the ep01 script'],
    ])
    expect(standing.every((block) => block.artifact.id === script.id)).toBe(true)
    // Four rules ran and two of them found nothing. A measured silence walls nothing.
    expect(findingsIn(store, script.id)).toHaveLength(2)
  })

  it('lets a text finding argue without vetoing — invariant 3', () => {
    recordCheckPass(store, {
      checkKey: 'world-rules',
      tier: 'text',
      artifactId: script.id,
      findings: [
        {
          concern: 'Three minutes outside the pressure hull in coveralls.',
          severity: 'high',
          confidence: 'high',
          anchor: { sceneId: scenesOf(store, episodeId)[3]!.id, quote: '' },
        },
      ],
    })

    expect(stageBlockingFindings(store, episodeId)).toEqual([])
    expect(stageBlockedBecause(store, episodeId)).toBeNull()
  })

  it('stands down on an episode nothing has checked', () => {
    expect(stageBlockedBecause(store, episodeId)).toBeNull()
  })
})

describe('the wall falls without an unblocking write', () => {
  it('falls one finding at a time as Ryan puts each down with a note', () => {
    checkTheBoard()

    dismissFinding(store, findingOf('vacuum-without-protection'), 'Coveralls are sealed in ep01.')

    // Recomputed, not decremented: the sentence is now about the finding still standing.
    const blocked = stageBlockedBecause(store, episodeId)
    expect(blocked).toContain('dual-presence')
    expect(blocked).toContain('scene 6 of the ep01 script')
    expect(blocked).toContain('Ilse Renn is in two places at one time')
    expect(blocked).not.toContain('more deterministic finding')

    dismissFinding(store, findingOf('dual-presence'), 'Scene 6 is a flash-forward and reads as one.')

    expect(stageBlockedBecause(store, episodeId)).toBeNull()
  })

  it('falls when the draft it argued with is gone — a finding is about a version', () => {
    checkTheBoard()
    expect(stageBlockedBecause(store, episodeId)).not.toBeNull()

    reviseArtifact(store, script.id, { summary: 'scenes 4 and 6 rewritten' })

    // The finding rows are still there, still open, still a record of what was true at v1.
    expect(stageBlockingFindings(store, episodeId)).toEqual([])
    expect(findingsIn(store, script.id).map((finding) => finding.status)).toEqual(['open', 'open'])
  })
})

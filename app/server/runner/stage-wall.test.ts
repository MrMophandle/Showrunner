import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, reviseArtifact, type Artifact } from '../domain/artifact.ts'
import { runBoardRules } from '../domain/board-rules.ts'
import { boardOf, recordExtractedBoard } from '../domain/board.ts'
import { inheritedDismissal } from '../domain/concern.ts'
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

/**
 * The board as the fixture extracted it by hand, and the four rules over it. Free, both.
 *
 * `ilseUnprotected` strips scene 6's hardsuit, which is a change to the SCRIPT as extraction
 * read it — the vacuum rule then finds a second body on the pier, with words no ruling has
 * ever been put on. Nothing else in the grid moves, so every other finding is word-for-word
 * the one it was.
 */
function checkTheBoard(change: { ilseUnprotected?: boolean } = {}): void {
  const extraction = theLongPierExtraction({
    lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
    halvaniVacuum: factOf('Halvani', 'loses consciousness'),
  })
  if (change.ilseUnprotected) {
    for (const scene of extraction.scenes) {
      for (const who of scene.present) {
        if (who.character === 'Ilse Renn' && scene.environment === 'exposed') who.protection = 'none'
      }
    }
  }

  const board = recordExtractedBoard(store, {
    episodeId,
    scriptId: script.id,
    extraction,
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

/**
 * **E3-6's twin-dismissal ruling, at the one place it changes behaviour** (`domain/concern.ts`).
 *
 * E3-5's one-motion apply re-runs the free tier on every rewrite, so the rule re-reads rows
 * nothing touched and raises a fresh open twin of the finding Ryan put down last week. The
 * wall consults finding identity, and it does it by READING — no disposition is copied onto
 * the twin, the twin stays open, and its firing is still counted in D11's denominator.
 */
describe('a twin of a dismissed concern does not put the wall back up', () => {
  it('stays down when the free tier re-raises the same words at the same span', () => {
    checkTheBoard()
    dismissFinding(store, findingOf('vacuum-without-protection'), 'Coveralls are sealed in ep01.')
    dismissFinding(store, findingOf('dual-presence'), 'Scene 6 is a flash-forward and reads as one.')
    expect(stageBlockedBecause(store, episodeId)).toBeNull()

    // A rewrite lands somewhere else in the episode and the free tier reads the board again,
    // off rows nobody changed. Both rules fire again, at the new version.
    reviseArtifact(store, script.id, { summary: 'scene 2 rewritten' })
    runBoardRules(store, boardOf(store, episodeId)!.artifact.id)

    const twins = findingsIn(store, script.id).filter((finding) => finding.anchor.version === 2)
    expect(twins.map((finding) => finding.checkKey).sort()).toEqual([
      'dual-presence',
      'vacuum-without-protection',
    ])
    // Recorded, open, and counted — and not one of them holds the wall.
    expect(twins.every((finding) => finding.status === 'open')).toBe(true)
    expect(stageBlockingFindings(store, episodeId)).toEqual([])
    expect(stageBlockedBecause(store, episodeId)).toBeNull()
  })

  it('goes back up for a genuinely new contradiction the same rule finds', () => {
    checkTheBoard()
    dismissFinding(store, findingOf('vacuum-without-protection'), 'Coveralls are sealed in ep01.')
    dismissFinding(store, findingOf('dual-presence'), 'Scene 6 is a flash-forward and reads as one.')
    expect(stageBlockedBecause(store, episodeId)).toBeNull()

    // The script is rewritten and re-extracted, and this time Ilse is on the pier in scene 6
    // with nothing on. Tobin's scene 4 concern is word-for-word the one Ryan put down; hers
    // has never been ruled on by anybody, and the same rule raised both.
    reviseArtifact(store, script.id, { summary: 'scene 6 rewritten' })
    checkTheBoard({ ilseUnprotected: true })

    const blocked = stageBlockedBecause(store, episodeId)
    expect(blocked).not.toBeNull()
    expect(blocked).toContain('vacuum-without-protection')
    expect(blocked).toContain('Ilse Renn is outside the pressure hull in scene 6')
    // Only hers. Tobin's twin and the dual-presence twin both read his standing notes.
    expect(stageBlockingFindings(store, episodeId)).toHaveLength(1)
  })

  it('is his note, attributed to the finding he actually ruled on', () => {
    checkTheBoard()
    const original = findingOf('vacuum-without-protection')
    dismissFinding(store, original, 'Coveralls are sealed in ep01.')

    reviseArtifact(store, script.id, { summary: 'scene 2 rewritten' })
    runBoardRules(store, boardOf(store, episodeId)!.artifact.id)

    const findings = findingsIn(store, script.id)
    const twin = findings.find(
      (finding) => finding.checkKey === 'vacuum-without-protection' && finding.anchor.version === 2,
    )!

    expect(inheritedDismissal(findings, twin)).toEqual({
      findingId: original,
      version: 1,
      note: 'Coveralls are sealed in ep01.',
      at: expect.any(String),
    })
  })
})

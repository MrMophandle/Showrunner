import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { promotionFromSheet } from '../fixture/load.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { readFixture } from '../fixture/read.ts'
import { createEventLog } from '../events.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { artifactsOf, type Artifact } from './artifact.ts'
import { recordExtractedBoard, type Board, type BoardExtraction } from './board.ts'
import { runBoardRules } from './board-rules.ts'
import { factsOfEntity } from './fact.ts'
import { checkPassesOf, findingsIn, findingsOfPass } from './finding.ts'
import { createProposalRulings, raiseProposal } from './proposal.ts'
import { relationsFrom } from './relation.ts'
import { scenesOf } from './spine.ts'

/**
 * The four deterministic rules of 3.2b — dual presence, impossible adjacency, duplicate
 * arrival, vacuum without protection — run over The Long Pier's board.
 *
 * **Every one of these runs for free.** Not one test here calls a model, and that is the
 * property under test as much as the findings are: the rules read stored rows, so a re-check
 * after a rewrite costs nothing and can be run as often as anyone likes.
 *
 * The script is the fixed point. Two of the four fire on defects planted in it on purpose
 * (`episode.md`) and two are silent on a script that obeys them — and the silence is
 * measured, not assumed, because `recordCheckPass` writes the row at zero findings.
 */

let root: string
let paths: LibraryPaths
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-board-rules-'))
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

/**
 * Grey Harbor founded, ep01's board extracted by hand — optionally with one thing about the
 * extraction changed, which is how a rule that the real script obeys is proved able to fire.
 */
function theLongPier(
  change?: (extraction: BoardExtraction, harbor: FoundedFixture) => void,
): LongPier {
  const harbor = greyHarborFounded(store, paths)
  const episodeId = store.get<{ id: string }>(
    "SELECT id FROM episode WHERE title = 'The Long Pier'",
  )!.id
  const script = artifactsOf(store, episodeId).find((a) => a.kind === 'script')!

  const extraction = theLongPierExtraction({
    lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
    halvaniVacuum: factOf('Halvani', 'loses consciousness'),
  })
  change?.(extraction, harbor)
  const board = recordExtractedBoard(store, { episodeId, scriptId: script.id, extraction })
  return { harbor, episodeId, script, board }
}

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((f) => f.statement.includes(needle))!.id
}

describe('the tier runs whole, and records what each rule said', () => {
  it('records one pass per rule against the board — including the ones that found nothing', () => {
    const { board } = theLongPier()

    const passes = runBoardRules(store, board.artifact.id)

    expect(passes.map((pass) => [pass.checkKey, pass.tier, pass.findingCount])).toEqual([
      ['dual-presence', 'deterministic', 1],
      ['impossible-adjacency', 'deterministic', 0],
      ['duplicate-arrival', 'deterministic', 0],
      ['vacuum-without-protection', 'deterministic', 1],
    ])
    expect(passes.every((pass) => pass.artifactId === board.artifact.id)).toBe(true)
    expect(checkPassesOf(store, board.artifact.id)).toHaveLength(4)
  })

  it('costs nothing to run again — the rows are already there, and no model is called', () => {
    const { board } = theLongPier()
    runBoardRules(store, board.artifact.id)

    const again = runBoardRules(store, board.artifact.id)

    expect(again.map((pass) => pass.findingCount)).toEqual([1, 0, 0, 1])
    // Eight passes, not four rewritten: a check pass is a record of a run (0010).
    expect(checkPassesOf(store, board.artifact.id)).toHaveLength(8)
    expect(store.get('SELECT COUNT(*) AS n FROM cost_entry')).toEqual({ n: 0 })
  })
})

describe('dual presence — scenes 5 and 6', () => {
  it('reports one woman in two places on one clock, anchored in the script', () => {
    const { harbor, episodeId, script, board } = theLongPier()
    const scenes = scenesOf(store, episodeId)

    const [dualPresence] = runBoardRules(store, board.artifact.id)
    const [finding] = findingsOfPass(store, dualPresence!.id)

    expect(finding).toMatchObject({
      checkKey: 'dual-presence',
      tier: 'deterministic',
      severity: 'high',
      // The tier's identity. Nothing was read and nothing was judged: two rows disagree.
      confidence: 'certain',
      entityId: harbor.entity('Ilse Renn').id,
      status: 'open',
    })
    expect(finding!.concern).toContain('Ilse Renn')
    expect(finding!.concern).toContain("Harbourmaster's office")
    expect(finding!.concern).toContain('The Long Pier')

    // "Clicking lands on the material, highlighted" (4.3) — and the material is the SCRIPT,
    // even though the pass read the board (0010's note about exactly this).
    expect(finding!.anchor).toEqual({
      artifactId: script.id,
      version: 1,
      sceneId: scenes[5]!.id,
      quote: 'EXT. THE LONG PIER — CONTINUOUS',
    })
    expect(findingsIn(store, script.id, { sceneId: scenes[5]!.id })).toHaveLength(1)
  })

  it('says nothing about two scenes that merely follow each other', () => {
    const { board } = theLongPier()

    const findings = findingsOfPass(store, runBoardRules(store, board.artifact.id)[0]!.id)

    // Scenes 1 and 2 are Ilse and Tobin in two places at 06:10 and 06:40, which is people
    // walking through doors. Only scene 6's CONTINUOUS shares a clock, and it is the only
    // one in the script — the fixture's own guard against a false positive it could not
    // tell from the planted one.
    expect(findings).toHaveLength(1)
  })

  it('abstains where a scene does not say when it happens', () => {
    const { board } = theLongPier((extraction) => {
      extraction.scenes[5]!.elapsedSeconds = null
      extraction.scenes[5]!.elapsed = 'LATER'
    })

    expect(runBoardRules(store, board.artifact.id)[0]!.findingCount).toEqual(0)
  })
})

describe('vacuum without protection — scene 4', () => {
  it('fires on an exposed, unprotected body whose species fact says the void kills', () => {
    const { harbor, episodeId, script, board } = theLongPier()
    const scenes = scenesOf(store, episodeId)

    const passes = runBoardRules(store, board.artifact.id)
    const [finding] = findingsOfPass(store, passes[3]!.id)

    expect(finding).toMatchObject({
      checkKey: 'vacuum-without-protection',
      severity: 'high',
      confidence: 'certain',
      entityId: harbor.entity('Tobin Wick').id,
    })
    expect(finding!.anchor).toMatchObject({
      artifactId: script.id,
      sceneId: scenes[3]!.id,
      quote: 'EXT. THE LONG PIER — 07:07',
    })
    // The card quotes the fact with its lineage, and the fact is the SPECIES' — in Tobin's
    // scope only because his sheet declares `species: Halvani` (D22).
    expect(finding!.facts.map((fact) => fact.statement)).toEqual([
      store.get<{ statement: string }>('SELECT statement FROM fact WHERE id = ?', factOf('Halvani', 'loses consciousness'))!.statement,
    ])
  })

  it('says nothing about the suited woman on the same pier', () => {
    const { board } = theLongPier()

    const findings = findingsOfPass(store, runBoardRules(store, board.artifact.id)[3]!.id)

    // Scene 6 is exposed too, and Ilse is Halvani too. She is in a hardsuit, which is one of
    // the two exceptions *The hull and the void* names — so the rule is silent, and its
    // silence is the difference between a check and an alarm.
    expect(findings).toHaveLength(1)
  })

  it('says nothing about a species declared unknown — that is E3-2 to say, not this tier', () => {
    const { board } = theLongPier((extraction, harbor) => {
      // The body on the pier is Sefa Doule, whose sheet declares `species: unknown` — a
      // relation row with a NULL target, which is somebody having looked and the world not
      // having decided (D22). She inherits nothing, so the Halvani fact the board names is
      // not in her scope, so the rule has nothing certain to say. It is not a hedge and not
      // a guess: the semantic checker owns the honest "could not check" (E3-2).
      promoteSefa(harbor)
      extraction.scenes[3]!.present = [
        { character: 'Sefa Doule', entity: 'Sefa Doule', protection: 'none', arrives: true },
      ]
    })

    expect(relationsFrom(store, entityNamed('Sefa Doule')).map((r) => r.toEntityId)).toEqual([null])
    expect(runBoardRules(store, board.artifact.id)[3]!.findingCount).toEqual(0)
  })

  it('says nothing when the script did not say what someone was wearing', () => {
    const { board } = theLongPier((extraction) => {
      extraction.scenes[3]!.present[0]!.protection = 'unknown'
    })

    expect(runBoardRules(store, board.artifact.id)[3]!.findingCount).toEqual(0)
  })
})

describe('the rules the script obeys — the controls, measured', () => {
  it('impossible adjacency: silent on The Long Pier, and it fires when the numbers do not fit', () => {
    const { board } = theLongPier()
    // Tobin leaves the lock at 07:05 and is on the pier at 07:07 — one hundred and twenty
    // seconds against a ninety-second lock cycle. A man walking through a door.
    expect(runBoardRules(store, board.artifact.id)[1]!.findingCount).toEqual(0)

    const tight = theLongPierWithTightCrossing()
    const [, adjacency] = runBoardRules(store, tight.board.artifact.id)
    const [finding] = findingsOfPass(store, adjacency!.id)

    expect(finding).toMatchObject({ checkKey: 'impossible-adjacency', confidence: 'certain' })
    expect(finding!.concern).toContain('90')
    expect(finding!.facts.map((fact) => fact.statement)).toEqual([
      'Cycling the No. 4 lock takes ninety seconds in either direction, and it cannot be cycled with both doors open.',
    ])
  })

  it('impossible adjacency: abstains on a crossing canon states no number for', () => {
    // Nothing in canon says what it costs to get from the mess deck to the office, so the
    // board carries no transit for it and the rule has nothing to compare. Silence, not a
    // guess: unknown is not certain.
    const { board } = theLongPier((extraction) => {
      extraction.scenes[1]!.elapsedSeconds = extraction.scenes[0]!.elapsedSeconds! + 1
    })

    expect(runBoardRules(store, board.artifact.id)[1]!.findingCount).toEqual(0)
  })

  it('duplicate arrival: silent on The Long Pier, and it fires on an arrival nobody left', () => {
    const { board } = theLongPier()
    // Tobin arrives at the office in scene 5 having arrived there once before — and the lock
    // and the pier in between say he left. That is a man doing his job.
    expect(runBoardRules(store, board.artifact.id)[2]!.findingCount).toEqual(0)

    const twice = theLongPier((extraction) => {
      extraction.scenes[1]!.present[1]!.arrives = true
      extraction.scenes[2]!.present = []
      extraction.scenes[3]!.present = []
    })
    const [, , duplicate] = runBoardRules(store, twice.board.artifact.id)
    const [finding] = findingsOfPass(store, duplicate!.id)

    expect(finding).toMatchObject({
      checkKey: 'duplicate-arrival',
      severity: 'medium',
      confidence: 'certain',
    })
    expect(finding!.concern).toContain('Tobin Wick')
    expect(finding!.concern).toContain("Harbourmaster's office")
  })
})

/** The Long Pier with Tobin on the pier thirty seconds after leaving the lock. */
function theLongPierWithTightCrossing(): LongPier {
  return theLongPier((extraction) => {
    extraction.scenes[3]!.elapsedSeconds = extraction.scenes[2]!.elapsedSeconds! + 30
    extraction.scenes[3]!.elapsed = '07:05:30'
  })
}

/**
 * Sefa Doule, promoted through the real ruling API — because only a ratification writes a
 * relation (invariant 1), and her `species: unknown` edge has to be real canon for the rule
 * to be silent for the right reason.
 */
function promoteSefa(harbor: FoundedFixture): void {
  const sheet = readFixture().entities.find((entity) => entity.name === 'Sefa Doule')!
  const proposal = raiseProposal(
    store,
    promotionFromSheet(sheet, harbor.entity('Sefa Doule').id, harbor.entities),
  )
  createProposalRulings(store, createEventLog(store)).ratify(proposal.id, {
    note: 'Sefa walks the pier in this test; promote the sheet',
  })
}

function entityNamed(name: string): string {
  return store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', name)!.id
}

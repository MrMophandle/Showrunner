import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, reviseArtifact, staleArtifacts, type Artifact } from '../domain/artifact.ts'
import { boardOf } from '../domain/board.ts'
import { factsOfEntity } from '../domain/fact.ts'
import { checkPassesOf, findingsIn } from '../domain/finding.ts'
import { scenesOf } from '../domain/spine.ts'
import { createEventLog } from '../events.ts'
import { greyHarborFounded } from '../fixture/founded.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { BOARD_CHECK_STAGE, BOARD_EXTRACTION, BOARD_STAGE, boardStages } from './board-step.ts'
import { findStepByName } from './run.ts'
import { createRunner, type Runner } from './runner.ts'

/**
 * The continuity board's extraction, as a step (2.2) — **the paid half of 3.2b**.
 *
 * The split this file exists to prove is the one that decides whether re-checking costs
 * Ryan money: the model reads the script ONCE, into rows; the rules run over those rows for
 * nothing, as often as anyone likes. So there are two stages, and the second one calls no
 * model at all.
 *
 * Every call here goes through `createFakeLLM` — the only backend allowed in `npm test`.
 * What it proves is the wiring, the ledger arithmetic and the freshness; what a real
 * extraction reads out of a real script is `smoke:llm`'s business, by hand, with Ryan's money.
 */

let root: string
let paths: LibraryPaths
let store: Store
let llm: FakeLLM
let runner: Runner
let episodeId: string
let script: Artifact

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-board-step-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  greyHarborFounded(store, paths)
  episodeId = store.get<{ id: string }>(
    "SELECT id FROM episode WHERE title = 'The Long Pier'",
  )!.id
  script = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'script')!

  llm = createFakeLLM()
  runner = createRunner(store, boardStages(paths), createEventLog(store), llm)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** What a good extraction of The Long Pier looks like coming back off the wire. */
function queueTheExtraction(): void {
  llm.reply({
    text: JSON.stringify(
      theLongPierExtraction({
        lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
        halvaniVacuum: factOf('Halvani', 'loses consciousness'),
      }),
    ),
    usage: { uncachedInput: 5200, output: 1900 },
  })
}

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

async function build(stage: string = BOARD_STAGE): Promise<void> {
  const run = runner.enqueueRun({ episodeId, stage })
  const settled = await runner.settled(run.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? 'the run failed')
}

describe('extraction is a step, and it is the half that costs money', () => {
  it('reads the script once and lands the board with its deterministic findings', async () => {
    queueTheExtraction()

    await build()

    const board = boardOf(store, episodeId)!
    expect(board.scenes).toHaveLength(6)
    expect(llm.calls).toHaveLength(1)

    // Four passes, and the two the script obeys recorded their silence (0010).
    expect(
      checkPassesOf(store, board.artifact.id).map((pass) => [pass.checkKey, pass.findingCount]),
    ).toEqual([
      ['dual-presence', 1],
      ['impossible-adjacency', 0],
      ['duplicate-arrival', 0],
      ['vacuum-without-protection', 1],
    ])

    // Both findings landed in the SCRIPT, at their scenes — which is what the gate renders.
    const scenes = scenesOf(store, episodeId)
    expect(findingsIn(store, script.id, { sceneId: scenes[3]!.id })).toHaveLength(1)
    expect(findingsIn(store, script.id, { sceneId: scenes[5]!.id })).toHaveLength(1)
  })

  it('bills the call against the step, the run, the episode and the show', async () => {
    queueTheExtraction()

    await build()

    const spend = store.get<{ n: number; micro: number }>(
      'SELECT COUNT(*) AS n, SUM(micro_dollars) AS micro FROM cost_entry',
    )!
    expect(spend.n).toEqual(1)
    expect(spend.micro).toBeGreaterThan(0)
    expect(
      store.get('SELECT COUNT(*) AS n FROM cost_entry WHERE episode_id = ? AND step_id IS NOT NULL', episodeId),
    ).toEqual({ n: 1 })
  })

  it('writes the grid to the volume, readable, one file per build', async () => {
    queueTheExtraction()

    await build()

    const board = boardOf(store, episodeId)!
    expect(board.artifact.filePath).toEqual('greyharbor/s01e01/continuity-board-v1.md')
    const written = readFileSync(join(paths.artifactDir, board.artifact.filePath!), 'utf8')
    expect(written).toContain('| 6 | The Long Pier | Ilse Renn | suited · exposed |')
    expect(written).toContain('CONTINUOUS')
  })

  it('does not re-extract a board the script has not moved past — nothing re-spent', async () => {
    queueTheExtraction()
    await build()

    // No second reply is queued: a second call would throw inside the fake rather than
    // quietly costing anything, which is the assertion under the assertion.
    await build()

    expect(llm.calls).toHaveLength(1)
    expect(store.get('SELECT COUNT(*) AS n FROM cost_entry')).toEqual({ n: 1 })
    expect(boardOf(store, episodeId)!.artifact.version).toEqual(1)
  })

  it('re-extracts when a scene edit moved the script on, and the board comes back fresh', async () => {
    queueTheExtraction()
    await build()

    reviseArtifact(store, script.id, {
      summary: 'Ilse stays in the office',
      touchedScenes: [scenesOf(store, episodeId)[5]!.id],
    })
    expect(staleArtifacts(store, episodeId).map((s) => s.artifact.kind)).toEqual([
      'continuity-board',
    ])

    queueTheExtraction()
    await build()

    expect(llm.calls).toHaveLength(2)
    expect(boardOf(store, episodeId)!.artifact.version).toEqual(2)
    expect(staleArtifacts(store, episodeId)).toEqual([])
    expect(existsSync(join(paths.artifactDir, 'greyharbor/s01e01/continuity-board-v2.md'))).toBe(true)
  })

  it('states what it will cost before the click, in the words the button says', () => {
    expect(BOARD_EXTRACTION.calls).toEqual(1)
    expect(BOARD_EXTRACTION.priced).toEqual('rate-card')
    expect(BOARD_EXTRACTION.sentence).toMatch(/^1 Opus call, ~\$\d/)
  })

  it('fails loudly on an answer that is not an extraction', async () => {
    llm.reply('Certainly! Here is a lovely summary of the episode.')
    llm.reply('Certainly! Here is a lovely summary of the episode.')
    llm.reply('Certainly! Here is a lovely summary of the episode.')

    await expect(build()).rejects.toThrow(/did not come back as an extraction/)
    expect(boardOf(store, episodeId)).toBeUndefined()
  })
})

describe('the rules are the free half, and they have a stage of their own', () => {
  it('re-checks an existing board without reading the script or spending a cent', async () => {
    queueTheExtraction()
    await build()
    const board = boardOf(store, episodeId)!

    await build(BOARD_CHECK_STAGE)

    expect(llm.calls).toHaveLength(1)
    expect(store.get('SELECT COUNT(*) AS n FROM cost_entry')).toEqual({ n: 1 })
    // Eight passes: the four from the build, and four more that cost nothing.
    expect(checkPassesOf(store, board.artifact.id)).toHaveLength(8)
    expect(boardOf(store, episodeId)!.artifact.version).toEqual(1)
  })

  it('says so rather than guessing when there is no board to check', async () => {
    await expect(build(BOARD_CHECK_STAGE)).rejects.toThrow(/has no continuity board/)
  })

  it('hands the run a tally of what the rules said', async () => {
    queueTheExtraction()
    await build()

    const step = findStepByName(
      store,
      store.get<{ id: string }>('SELECT id FROM run ORDER BY rowid DESC LIMIT 1')!.id,
      'run-the-board-rules',
    )!
    expect(step.output).toMatchObject({ findings: 2, rules: 4 })
  })
})

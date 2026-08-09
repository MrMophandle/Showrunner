import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, type Artifact } from '../domain/artifact.ts'
import { runBoardRules } from '../domain/board-rules.ts'
import { recordExtractedBoard } from '../domain/board.ts'
import { factsOfEntity } from '../domain/fact.ts'
import { findingsIn } from '../domain/finding.ts'
import { findEpisode } from '../domain/spine.ts'
import { createEventLog, type EventLog } from '../events.ts'
import { greyHarborFounded } from '../fixture/founded.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { describeLLMBackend } from '../llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { launchBlockedBecause, runView } from '../operating.ts'
import { createRulings, openGates, type Rulings } from './gate.ts'
import { createRunner, type Runner } from './runner.ts'
import { SCRIPT_GATE_STAGE } from './script-gate-step.ts'
import { stageBlockedBecause } from './stage-wall.ts'
import { stageCatalogue } from './stages.ts'
import { PREMISE_STAGE } from './write-step.ts'

/**
 * The gate over the script (E3-7): **the stage that produces nothing, and the door the wall's
 * override is behind.**
 *
 * D12 says a deterministic finding blocks the next stage and never Ryan's gate. Both halves
 * are asserted here against the fixture's own planted contradiction, and the second half is
 * the one that needed a stage built for it: `overriddenThrough` is asked per artifact, so an
 * override is only an override of what is standing on the artifact under review — and until
 * this stage there was no gate anywhere in the app over the ep01 script.
 */

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
let episodeId: string
let script: Artifact

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-script-gate-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  greyHarborFounded(store, paths)
  episodeId = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'The Long Pier'")!.id
  script = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'script')!

  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const factOf = (entity: string, needle: string): string => {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

/** The fixture's planted contradictions, raised for nothing by the rules that read rows. */
function theBoard(): void {
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

async function present(): Promise<string> {
  const run = runner.enqueueRun({ episodeId, stage: SCRIPT_GATE_STAGE })
  await runner.settled(run.id)
  return run.id
}

describe('the script gate — presenting what stands', () => {
  it('opens a gate over the script with the verdict board under it, and calls nothing', async () => {
    theBoard()

    const runId = await present()

    expect(llm.calls).toEqual([])
    const gate = openGates(store)[0]!
    expect(gate.subject).toBe('the ep01 script')
    expect(gate.round).toBe(1)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_entry')!.n).toBe(0)

    // The round records what he was shown: a snapshot of the board, and the findings the wall
    // is standing on, so the ruling is readable a season later against a live recomputation.
    const view = runView(store, paths, runId)!
    const payload = view.gate!.rounds[0]!.payload as {
      board: { rows: { checkKey: string }[] }
      blocking: { checkKey: string; scene: number | null }[]
    }
    expect(payload.board.rows.map((row) => row.checkKey)).toContain('dual-presence')
    expect(payload.blocking.map((one) => [one.checkKey, one.scene])).toEqual([
      ['vacuum-without-protection', 4],
      ['dual-presence', 6],
    ])
  })

  it('is never itself walled — a deterministic finding blocks the next stage, not a ruling', () => {
    theBoard()

    // The wall is up, and it is what refuses a stage that would PRODUCE from this episode's
    // material. That refusal is asserted on ep02 in `operating.test.ts`: E4-1 retired `demo`,
    // and the only producer this build ships is the premise stage, which on ep01 is refused
    // for having nothing to do — the fixture wrote ep01's premise by hand — before the wall
    // is ever consulted (`operating.ts`).
    expect(stageBlockedBecause(store, episodeId)).toContain('ep01 is blocked')
    expect(
      launchBlockedBecause(
        store,
        describeLLMBackend({ ANTHROPIC_API_KEY: 'k' }),
        episodeId,
        stageCatalogue(paths)[PREMISE_STAGE]!,
      ),
    ).toContain('already has a premise-brief')
    // And the gate is not. Refusing it would be a check vetoing Ryan by the longest route.
    expect(
      launchBlockedBecause(store, describeLLMBackend({ PATH: '' }), episodeId, stageCatalogue(paths)[SCRIPT_GATE_STAGE]!),
    ).toBeNull()
  })

  it('names on the button what an approval would be standing over', async () => {
    theBoard()

    const offered = stageCatalogue(paths)[SCRIPT_GATE_STAGE]!.offerOn(
      store,
      findEpisode(store, episodeId)!,
    )
    expect(offered.sentence).toContain('2 deterministic findings stand on it')
    expect(offered.sentence).toContain('approving over them is recorded as your override')
    expect(offered.callsModel).toBe(false)
  })
})

describe('the script gate — the three verdicts, and what each leaves behind', () => {
  it('takes the wall down on an override, and writes nothing to any finding', async () => {
    theBoard()
    const runId = await present()
    const standing = findingsIn(store, script.id).map((one) => [one.id, one.status])

    rulings.override(openGates(store)[0]!.gate.id, { comment: 'shooting it as written' })
    await runner.settled(runId)

    expect(stageBlockedBecause(store, episodeId)).toBeNull()
    // The findings are exactly as the checks left them. Nothing wrote an unblock: the wall is
    // a read, and one of its five conditions stopped being true (`stage-wall.ts`).
    expect(findingsIn(store, script.id).map((one) => [one.id, one.status])).toEqual(standing)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM finding_disposition')!.n).toBe(0)
    expect(store.get<{ verdict: string }>('SELECT verdict FROM gate_ruling')!.verdict).toBe('override')
  })

  it('leaves the wall up on a plain approval — the two verbs are two rulings, forever', async () => {
    theBoard()
    const runId = await present()

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'read it, carry on' })
    await runner.settled(runId)

    // An approval is not an override, and folding them would spend invariant 3's distinction
    // at the one place it is load-bearing.
    expect(stageBlockedBecause(store, episodeId)).toContain('ep01 is blocked')
  })

  it('reopens as the next round on a rejection, with the notes recorded against it', async () => {
    theBoard()
    const runId = await present()

    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'scene 6 has to move; she cannot be on the pier', depth: 'scene', target: 'scene-6' }],
    })
    await runner.settled(runId)

    const view = runView(store, paths, runId)!
    expect(view.gate!.round).toBe(2)
    expect(view.gate!.isOpen).toBe(true)
    expect(view.gate!.rounds[0]!.ruling!.notes[0]!.note).toContain('scene 6 has to move')
    expect(view.gate!.rounds[0]!.ruling!.notes[0]!.depth).toBe('scene')
    // Round 1 is kept exactly as it was ruled, marked rather than replaced.
    expect(view.gate!.rounds[0]!.stale).toBe(true)
    // Rejecting a presentation costs nothing: there is no producer behind this gate to re-run,
    // and the button says that rather than promising a rewrite nothing is going to do.
    expect(view.gate!.reject.cost).toBe('No model call · $0.00')
    expect(view.gate!.reject.sentence).toContain('presents it again with them recorded against it')
    expect(view.gate!.reject.sentence).not.toContain('writes it again')
    expect(llm.calls).toEqual([])
  })
})

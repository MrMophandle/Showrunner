import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FREE } from '../cost.ts'
import type { Store } from '../db/store.ts'
import { recordArtifact, type Artifact } from '../domain/artifact.ts'
import { episodesOf, findEpisode, seasonsOf } from '../domain/spine.ts'
import { createEventLog, type EventLog } from '../events.ts'
import { loadFixture } from '../fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { describeLLMBackend, type LLMReadiness } from '../llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { findStage, operatingView, runView } from '../operating.ts'
import { BOARD_CHECK_STAGE, BOARD_STAGE } from './board-step.ts'
import { createRulings, presentForRuling } from './gate.ts'
import { findStepByName, markRunDone, reconcileSteps, recordRun, stepsOf } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import { SCRIPT_GATE_STAGE } from './script-gate-step.ts'
import { scaffoldStage } from './stage-fixture.ts'
import { stageCatalogue } from './stages.ts'
import { STAGE_WORK } from './step.ts'
import { TEXT_CHECK_STAGE } from './text-check-step.ts'
import { PREMISE_STAGE } from './write-step.ts'

/**
 * The stage catalogue: what this build ships, and what it no longer offers.
 *
 * It used to be the demo stage's test file — `demo` was E1's placeholder writer and the
 * cheap thing every other test reached for. E4-1 retired it and gave the premise stage its
 * behaviours (`write-step.test.ts`); what is left here is the catalogue itself, and the
 * half of the retirement that is easy to get wrong: **unoffered is not erased.** A demo run
 * in Ryan's library still renders, still carries its gate and its ruling, and is still left
 * alone by a runner that has no code for it.
 */

const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-catalogue-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  loadFixture(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)

  const show = store.get<{ id: string }>("SELECT id FROM show WHERE key = 'greyharbor'")!
  ep02 = episodesOf(store, seasonsOf(store, show.id)[0]!.id).find((one) => one.number === 2)!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/**
 * A demo-era run, as Ryan's own library holds one: the retired stage's name on the row, its
 * artifact in its own slot, its gate, and his ruling on it. Planted through the real ledger
 * functions, because what is under test is whether the RECORD still reads once the code is
 * gone — and a hand-INSERTed row would prove nothing about that.
 */
function aDemoEraRun(): { runId: string; artifact: Artifact } {
  const filePath = join('greyharbor', 's01e02', 'demo', 'premise-round-1.md')
  const onDisk = join(paths.artifactDir, filePath)
  mkdirSync(dirname(onDisk), { recursive: true })
  writeFileSync(onDisk, 'The exchanger fails on a Tuesday.\n', 'utf8')
  const artifact = recordArtifact(store, {
    episodeId: ep02,
    kind: 'premise-brief',
    slot: 'demo',
    filePath,
  })

  const stage = scaffoldStage('demo', [
    { name: 'write-the-demo-premise', execute: async () => ({}) },
  ])
  const run = recordRun(store, stage, ep02)
  reconcileSteps(store, run.id, stage)
  const step = findStepByName(store, run.id, 'write-the-demo-premise')!
  const standing = presentForRuling(
    store,
    { runId: run.id, stepId: step.id, episodeId: ep02 },
    { artifactId: artifact.id, payload: { round: 1, calledTheModel: true } },
  )
  createRulings(store, events, runner).approve(standing.gate.id, { comment: 'that reads.' })
  markRunDone(store, run.id)
  return { runId: run.id, artifact }
}

describe('what this build ships', () => {
  it('is these five stages, and adding one is a code change with a test', () => {
    expect(Object.keys(stageCatalogue(paths)).sort()).toEqual(
      [PREMISE_STAGE, BOARD_STAGE, BOARD_CHECK_STAGE, TEXT_CHECK_STAGE, SCRIPT_GATE_STAGE].sort(),
    )
  })

  it('has every one of them declaring its work, its sentence, its cost and its precondition', () => {
    const episode = findEpisode(store, ep02)!

    for (const stage of Object.values(stageCatalogue(paths))) {
      const declared = stage.offerOn(store, episode)
      expect(STAGE_WORK).toContain(stage.work)
      expect(declared.sentence).not.toMatch(/^(Launch|Run|Go|Do|Start)\b/)
      expect(declared.sentence).toContain('ep02')
      if (!declared.callsModel) expect(declared.cost).toBe(FREE)
      else expect(declared.cost).toMatch(/~\$|cost unknown/)
    }
  })
})

describe('the retired demo stage', () => {
  it('is offered nowhere, by name or by lookup', () => {
    expect(stageCatalogue(paths)['demo']).toBeUndefined()
    expect(findStage(paths, 'demo')).toBeUndefined()
    // And nothing kept it alive for tests. A stage that exists only so tests have something
    // cheap to run is a lie in the catalogue: the premise stage, on the fake adapter, is
    // what the E1-era tests run on now.
    expect(Object.keys(stageCatalogue(paths))).not.toContain('demo')
  })

  it('keeps its run, its steps, its gate, its ruling and its artifact readable', () => {
    const { runId, artifact } = aDemoEraRun()

    const view = runView(store, paths, runId)!
    expect(view.run.stage).toBe('demo')
    expect(view.steps.map((step) => step.name)).toEqual(['write-the-demo-premise'])
    // The gate renders its artifact off the volume, exactly as it did when the stage existed.
    expect(view.gate!.subject).toBe('the ep02 premise-brief demo')
    expect(view.gate!.artifact.text).toBe('The exchanger fails on a Tuesday.\n')
    expect(view.gate!.rounds[0]!.ruling).toMatchObject({ verdict: 'approve' })
    // Both verdicts are closed, because the round was ruled — not because the stage is gone.
    expect(view.gate!.approve.blockedBecause).toContain('already ruled')
    // And the reject button says the truth about a gate with no code behind it any more.
    expect(view.gate!.reject.sentence).toContain('this build has no code for the stage')
    expect(view.gate!.reject.cost).toBe(FREE)

    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact WHERE id = ?', artifact.id)!.n)
      .toBe(1)
  })

  it('still shows on the episode it ran on, and the card offers the premise stage now', () => {
    const { runId } = aDemoEraRun()

    const episode = operatingView(store, paths, READY).shows[0]!.episodes[1]!
    expect(episode.run).toMatchObject({ id: runId, stage: 'demo' })
    expect(episode.launchStage).toBe(PREMISE_STAGE)
    // ep02's demo-era brief is a premise-brief, so the premise stage says so rather than
    // writing a second one over the top of it (D20).
    expect(episode.launch.blockedBecause).toContain('already has a premise-brief')
  })

  /**
   * `advance` (runner.ts) skips a run whose stage this build has no code for, deliberately:
   * "a click Ryan already made is not something a deploy gets to throw away."
   *
   * The other half of that is written down here rather than discovered: such a run stays
   * queued forever, and D7's one-run-per-episode then refuses every stage on that episode
   * with a sentence that says "rule on it, or let it finish" — neither of which is possible
   * once the code is gone. It is not new to E4-1 (it has been true of any retired stage
   * since E1-3) and it is not fixed here; `handoff/docs/README.md` carries it as an E4
   * constraint, because the fix is an affordance for putting a run down, not a change to
   * this refusal.
   */
  it('leaves a run of it queued rather than failing it, and that run holds its episode', () => {
    const stage = scaffoldStage('demo', [{ name: 'write-the-demo-premise', execute: async () => ({}) }])
    const run = recordRun(store, stage, ep02)

    expect(runner.resumeInterrupted().map((one) => one.id)).not.toContain(run.id)
    expect(store.get<{ status: string }>('SELECT status FROM run WHERE id = ?', run.id)!.status).toBe(
      'queued',
    )
    // Nothing ran: the steps are reconciled rows and every one of them is still pending.
    expect(stepsOf(store, run.id).map((step) => step.status)).toEqual(['pending'])
    expect(llm.calls).toHaveLength(0)

    const episode = operatingView(store, paths, READY).shows[0]!.episodes[1]!
    expect(episode.launch.blockedBecause).toContain('already has a demo run')
    expect(episode.launch.blockedBecause).toContain('One run per episode')
  })
})

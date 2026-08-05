import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { costOfRun } from '../cost.ts'
import type { Store } from '../db/store.ts'
import { artifactsOf } from '../domain/artifact.ts'
import { episodesOf, seasonsOf } from '../domain/spine.ts'
import { createEventLog, eventsOfRun, type EventLog } from '../events.ts'
import { loadFixture } from '../fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { createRulings, gateStanding, openGates, type Rulings } from './gate.ts'
import { findStepByName, stepsOf } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import { DEMO_STAGE, stageCatalogue, type DemoClose } from './stages.ts'

/**
 * The demo stage — E1's one stage, and the thing Ryan operates for the epic exit: one
 * model call, one artifact on the volume, one gate, one ruling, and a run that carries on
 * past it.
 *
 * Every test here runs the REAL stage through the REAL runner against a REAL library
 * volume in a temp directory, with the Grey Harbor fixture in it and the fake backend in
 * front of the model. Nothing in `npm test` may spend a cent (fixtures before features) —
 * the two real backends are Ryan's to exercise, by hand, through the page and through
 * `scripts/smoke-llm.ts`.
 */

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
/** ep02 "Dry Stores" — the un-started episode, so nothing here disturbs ep01's script. */
let ep02: string

const FIRST = 'Three weeks after the harbourmaster took the spare, the water plant gives out.'
const SECOND = 'The exchanger fails on a Tuesday, and nobody is willing to say whose fault it is.'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-demo-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  loadFixture(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)

  const show = store.get<{ id: string }>("SELECT id FROM show WHERE key = 'greyharbor'")!
  const season = seasonsOf(store, show.id)[0]!
  ep02 = episodesOf(store, season.id).find((episode) => episode.number === 2)!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the demo stage — one call, one artifact, one gate', () => {
  it('writes a premise, files it on the volume, and parks on Ryan', async () => {
    llm.reply(FIRST)

    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)

    // One call, small and bounded — this is Ryan's money on a real backend.
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).toMatchObject({ maxTokens: 700, effort: 'low' })
    expect(llm.calls[0]!.prompt).toContain('"Dry Stores"')
    // No canon in the prompt: that is what makes the artifact's empty provenance honest.
    expect(llm.calls[0]!.prompt).not.toContain('Ilse Renn')

    // The artifact is a real row with a real file, in its own slot — the fixture's own
    // premise-brief for other episodes is untouched (D20, and UNIQUE (episode, kind, slot)).
    const artifact = demoArtifact()
    expect(artifact).toMatchObject({ kind: 'premise-brief', slot: 'demo', version: 1 })
    expect(artifact.filePath).toBe('greyharbor/s01e02/demo/premise-round-1.md')
    expect(readFileSync(join(paths.artifactDir, artifact.filePath!), 'utf8')).toBe(`${FIRST}\n`)

    // Parked on a decision, with the gate open on that artifact at round 1.
    const standing = gateStanding(store, openGates(store)[0]!.gate.id)!
    expect(standing).toMatchObject({ round: 1, isOpen: true, subject: 'the ep02 premise-brief demo' })
    expect(standing.rounds[0]).toMatchObject({
      artifactVersion: 1,
      payload: { round: 1, calledTheModel: true, truncated: false },
    })
    expect(stepsOf(store, run.id).map((step) => [step.name, step.status])).toEqual([
      ['write-the-demo-premise', 'paused'],
      ['tally-the-demo-spend', 'pending'],
    ])

    // And it cost something, on the run, before anything was rendered.
    expect(costOfRun(store, run.id).calls).toBe(1)
  })

  it('streams what the model wrote while it is writing it', async () => {
    llm.reply(FIRST)
    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)

    const prose = eventsOfRun(store, run.id).filter((event) => event.kind === 'step-chunk')
    expect(prose.map((event) => event.summary).join(' ')).toBe(FIRST)
  })
})

describe('the demo stage — the ruling', () => {
  it('a rejection reopens the same step, writes again against the notes, and presents round 2', async () => {
    llm.reply(FIRST)
    llm.reply(SECOND)

    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)
    const gateId = openGates(store)[0]!.gate.id

    rulings.reject(gateId, {
      notes: [{ note: 'Too tidy. Nobody in Grey Harbor says whose fault it is.' }],
    })
    await runner.settled(run.id)

    // The notes reached the model verbatim — that is what "reject with notes" buys.
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]!.prompt).toContain('Nobody in Grey Harbor says whose fault it is.')

    // Round 2 of the SAME gate, on version 2 of the SAME artifact. Round 1 is kept and
    // marked stale, never overwritten.
    const standing = gateStanding(store, gateId)!
    expect(standing.round).toBe(2)
    expect(standing.rounds.map((round) => [round.round, round.artifactVersion, round.stale])).toEqual([
      [1, 1, true],
      [2, 2, false],
    ])
    expect(standing.rounds[0]!.ruling).toMatchObject({ verdict: 'reject' })

    // Each round has its own file. Round 1's draft is still there, exactly as ruled on.
    expect(readFileSync(join(paths.artifactDir, 'greyharbor/s01e02/demo/premise-round-1.md'), 'utf8'))
      .toBe(`${FIRST}\n`)
    expect(demoArtifact().filePath).toBe('greyharbor/s01e02/demo/premise-round-2.md')
    expect(readFileSync(join(paths.artifactDir, demoArtifact().filePath!), 'utf8')).toBe(`${SECOND}\n`)

    // Both attempts are on the ledger. A rejection is not a failure — it is a second call
    // Ryan asked for, and the button that asked for it said so.
    expect(costOfRun(store, run.id).calls).toBe(2)
  })

  it('an approval carries the run past the gate and closes it with what it spent', async () => {
    llm.reply(FIRST)

    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that reads.' })
    const settled = await runner.settled(run.id)

    expect(settled.status).toBe('done')
    expect(stepsOf(store, run.id).map((step) => step.status)).toEqual(['done', 'done'])

    // Coming back in on an approval re-runs nothing and re-spends nothing — which is
    // exactly what the kill-and-resume drill watches for.
    expect(llm.calls).toHaveLength(1)
    expect(costOfRun(store, run.id).calls).toBe(1)

    const close = findStepByName(store, run.id, 'tally-the-demo-spend')!.output as DemoClose
    expect(close.verdict).toBe('approve')
    expect(close.round).toBe(1)
    expect(close.sentence).toMatch(/^Approved at round 1 · 1 call · \$\d+\.\d\d$/)
  })
})

describe('the demo stage — a draft already on the volume', () => {
  it('keeps it, presents it, and makes no second call for it (D20)', async () => {
    // What a crash between writing the draft and recording the gate leaves behind — and
    // what a hand-made asset looks like. Either way it wins, and it is not paid for twice.
    const at = join(paths.artifactDir, 'greyharbor/s01e02/demo/premise-round-1.md')
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, 'The one Ryan wrote himself.\n', 'utf8')

    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)

    expect(llm.calls).toHaveLength(0)
    expect(costOfRun(store, run.id).calls).toBe(0)
    expect(readFileSync(at, 'utf8')).toBe('The one Ryan wrote himself.\n')

    const standing = gateStanding(store, openGates(store)[0]!.gate.id)!
    expect(standing.isOpen).toBe(true)
    expect(standing.rounds[0]!.payload).toMatchObject({ calledTheModel: false })
    expect(eventsOfRun(store, run.id).map((event) => event.summary)).toContain(
      "Round 1's draft was already in the library — kept as it stands, and no second call made for it",
    )
  })
})

function demoArtifact() {
  return artifactsOf(store, ep02).find(
    (artifact) => artifact.kind === 'premise-brief' && artifact.slot === 'demo',
  )!
}

import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { recordArtifact, reviseArtifact, type Artifact } from '../domain/artifact.ts'
import { createEpisode, createSeason, createShow, delineateScenes } from '../domain/spine.ts'
import { createEventLog, eventsOfRun, type EventLog } from '../events.ts'
import { createRulings, gateOfStep, gateStanding, openGates, type GateNote } from './gate.ts'
import { findRun } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import type { StageCatalogue, Step, StepContext } from './step.ts'
import { scaffoldStage } from './stage-fixture.ts'

/**
 * The gate primitive, proved against the sentences the gate room has to say
 * (mockups/gate-room.html):
 *
 *   "Round 2 · open 38 min"
 *   "script v2 under review · writer re-ran with your round-1 notes"
 *   "Round 1 · stale — from before your last rejection"
 *   "rejected Jul 31 · your note: 'Ferro folds too fast in scene 5…'"
 *
 * Every test here runs a REAL step through the REAL runner, because the thing under test
 * is a round trip: a step presents, the run parks, Ryan rules, the run re-enters the same
 * step, and the step finds out what he said. Asserting on the tables alone would prove the
 * ledger and miss the loop.
 *
 * There is not one sleep in this file — steps park on the gate, which is a persisted fact,
 * and `untilSettled` drains the microtask queue until the database stops changing.
 */

let store: Store
let events: EventLog
let ep05: string
let ep06: string
let sceneId: string

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  events = createEventLog(store)
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  ep05 = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' }).id
  ep06 = createEpisode(store, { seasonId: season.id, number: 6, title: 'Cold Ledger' }).id
  sceneId = delineateScenes(store, ep06, [
    { heading: 'INT. VERGE STATION, TRADE RING — LEDGER OFFICE' },
  ])[0]!.id
})

describe('the gate — a run parks on a decision and comes back through the same step', () => {
  it('reject with notes reopens the producing step with the notes as input', async () => {
    const writer = writerStage(ep06)
    const { runner, rulings } = wire(writer.stages)

    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)

    // Round 1: the step wrote, presented, and parked. Nothing ran twice.
    expect(writer.log).toEqual(['wrote v1 with 0 notes'])
    expect(findRun(store, run.id)!.status).toBe('paused')
    expect(findRun(store, run.id)!.pauseReason).toBe('the ep06 script gate is open')

    const gate = gateOfStep(store, writer.stepId())!
    rulings.reject(gate.id, {
      notes: [{ note: 'Ferro folds too fast in scene 5 — make him leave unconvinced.' }],
    })
    await untilSettled(store)

    // The same step ran again, and it was handed Ryan's note to write against.
    expect(writer.log).toEqual([
      'wrote v1 with 0 notes',
      'wrote v2 with 1 notes',
    ])
    expect(writer.notesSeen).toEqual([
      [], // round 1: nothing had been said yet
      ['Ferro folds too fast in scene 5 — make him leave unconvinced.'],
    ])
    expect(findRun(store, run.id)!.status).toBe('paused')

    const standing = gateStanding(store, gate.id)!
    expect(standing.round).toBe(2)
    expect(standing.isOpen).toBe(true)
    // "script v2 under review · writer re-ran with your round-1 notes"
    expect(standing.rounds.at(-1)!.artifactVersion).toBe(2)

    // And approving lets the step return its own result and the run finish.
    rulings.approve(gate.id, { comment: 'better — he leaves cold.' })
    await untilSettled(store)
    expect(findRun(store, run.id)!.status).toBe('done')
    expect(writer.log.at(-1)).toBe('returned the approved script')
  })

  it('round 2 carries round-1 history, marked stale rather than replaced', async () => {
    const writer = writerStage(ep06)
    const { runner, rulings } = wire(writer.stages)
    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)

    const gate = gateOfStep(store, writer.stepId())!
    rulings.reject(gate.id, { notes: [{ note: 'the beacon answer lands too early.' }] })
    await untilSettled(store)

    const standing = gateStanding(store, gate.id)!
    expect(standing.rounds).toHaveLength(2)

    const [first, second] = standing.rounds
    // "Round 1 · stale — from before your last rejection" — still exactly as it was ruled.
    expect(first).toMatchObject({ round: 1, artifactVersion: 1, stale: true })
    expect(first!.ruling).toMatchObject({ verdict: 'reject', comment: null })
    expect(first!.ruling!.notes.map((note) => note.note)).toEqual([
      'the beacon answer lands too early.',
    ])
    // "Round 2 · current · open"
    expect(second).toMatchObject({ round: 2, artifactVersion: 2, stale: false })
    expect(second!.ruling).toBeUndefined()
    expect(standing.ruling).toBeUndefined()

    // A ruling is history, and history does not move: the database refuses the edit.
    expect(() =>
      store.run("UPDATE gate_ruling SET verdict = 'approve' WHERE gate_id = ?", gate.id),
    ).toThrow(/a ruling is history/)
    // Nor may round 2 be written over round 1's verdict.
    expect(() =>
      store.run(
        "INSERT INTO gate_ruling (gate_id, round, verdict) VALUES (?, 1, 'approve')",
        gate.id,
      ),
    ).toThrow(/UNIQUE|PRIMARY KEY/i)
  })

  it('does not read as a retry on the way back in — a round is not an attempt', async () => {
    const writer = writerStage(ep06)
    const { runner, rulings } = wire(writer.stages)
    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)
    const gate = gateOfStep(store, writer.stepId())!

    rulings.reject(gate.id, { notes: [{ note: 'again, colder.' }] })
    await untilSettled(store)
    rulings.reject(gate.id, { notes: [{ note: 'colder still.' }] })
    await untilSettled(store)

    // "write-script — attempt 3 of 3" over Ryan's third opinion would say the system is
    // about to give up on him. The retry budget is spent by FAILURES, and he has spent none.
    expect(
      eventsOfRun(store, run.id)
        .filter((event) => event.kind === 'step-started')
        .map((event) => event.summary),
    ).toEqual(['write-script', 'write-script', 'write-script'])
    expect(
      store.all<{ outcome: string }>('SELECT outcome FROM step_attempt ORDER BY attempt')
        .map((row) => row.outcome),
    ).toEqual(['paused', 'paused', 'paused'])
  })

  it('does not cap rounds — three attempts bounds a FAILING step, never Ryan’s opinions', async () => {
    const writer = writerStage(ep06)
    const { runner, rulings } = wire(writer.stages)
    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)
    const gate = gateOfStep(store, writer.stepId())!

    // Four rejections — one more than MAX_ATTEMPTS_PER_STEP would ever allow a failure.
    for (let round = 1; round <= 4; round += 1) {
      expect(gateStanding(store, gate.id)!.round).toBe(round)
      rulings.reject(gate.id, { notes: [{ note: `still not it, round ${round}` }] })
      await untilSettled(store)
      expect(findRun(store, run.id)!.status).toBe('paused')
    }

    const standing = gateStanding(store, gate.id)!
    expect(standing.round).toBe(5)
    expect(standing.rounds.filter((r) => r.ruling?.verdict === 'reject')).toHaveLength(4)
    expect(standing.rounds.at(-1)!.artifactVersion).toBe(5)
  })
})

describe('the gate — rejection notes carry routing depth (4.7, D21)', () => {
  it('round-trips a rejection carrying two notes at different depths with both targets intact', async () => {
    const writer = writerStage(ep06)
    const { runner, rulings } = wire(writer.stages)
    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)
    const gate = gateOfStep(store, writer.stepId())!

    rulings.reject(gate.id, {
      notes: [
        { note: 'send scene 4 back to writing — she is in two places.', depth: 'scene', target: sceneId },
        { note: 'the ledger-office shot is the wrong lens.', depth: 'shot', target: 'shot-05' },
      ],
    })
    await untilSettled(store)

    const expected: GateNote[] = [
      {
        note: 'send scene 4 back to writing — she is in two places.',
        depth: 'scene',
        target: sceneId,
        // A scene is a scene OF this artifact, so there is no other artifact's version for it
        // to have moved past — that stamp belongs to a note routed to another written kind
        // (`domain/routing.ts`, 0014).
        targetVersion: null,
      },
      {
        note: 'the ledger-office shot is the wrong lens.',
        depth: 'shot',
        target: 'shot-05',
        targetVersion: null,
      },
    ]

    // Out of the ledger, in the order Ryan wrote them.
    expect(gateStanding(store, gate.id)!.rounds[0]!.ruling!.notes).toEqual(expected)
    // Into the step that reopened, which is what E4 and E6 will route on.
    expect(writer.notesSeen.at(-1)).toEqual(expected.map((note) => note.note))
    expect(writer.routingSeen.at(-1)).toEqual([
      ['scene', sceneId],
      ['shot', 'shot-05'],
    ])
    // And onto the wire, because that is where E1-8 and E5 read a rejection as it lands.
    const rejected = eventsOfRun(store, run.id).find((e) => e.kind === 'gate-rejected')!
    expect(rejected.detail).toMatchObject({ notes: expected })
  })

  it('takes a single unrouted note — the legal default', async () => {
    const writer = writerStage(ep06)
    const { runner, rulings } = wire(writer.stages)
    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)
    const gate = gateOfStep(store, writer.stepId())!

    rulings.reject(gate.id, { notes: [{ note: 'not yet.' }] })
    await untilSettled(store)

    expect(gateStanding(store, gate.id)!.rounds[0]!.ruling!.notes).toEqual([
      { note: 'not yet.', depth: null, target: null, targetVersion: null },
    ])
  })

  it('refuses a target with no depth — a route has to say how deep it goes', async () => {
    const writer = writerStage(ep06)
    const { runner } = wire(writer.stages)
    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)
    const gate = gateOfStep(store, writer.stepId())!

    store.run("INSERT INTO gate_ruling (gate_id, round, verdict) VALUES (?, 1, 'reject')", gate.id)
    expect(() =>
      store.run(
        "INSERT INTO gate_note (gate_id, round, note, target) VALUES (?, 1, 'sharpen it', 'shot-05')",
        gate.id,
      ),
    ).toThrow(/CHECK/i)
  })
})

describe('the gate — the three verbs', () => {
  it('tells an override apart from an approval in the log, forever', async () => {
    const approved = writerStage(ep05, 'write-ep05')
    const overridden = writerStage(ep06, 'write-ep06')
    const { runner, rulings } = wire({ ...approved.stages, ...overridden.stages })

    const clean = runner.enqueueRun({ episodeId: ep05, stage: 'write-ep05' })
    const loud = runner.enqueueRun({ episodeId: ep06, stage: 'write-ep06' })
    await runner.settled(clean.id)
    await runner.settled(loud.id)

    rulings.approve(gateOfStep(store, approved.stepId())!.id)
    rulings.override(gateOfStep(store, overridden.stepId())!.id, {
      comment: 'the continuity finding is wrong about the bridge rail.',
    })
    await untilSettled(store)

    expect(kindsAndSummaries(clean.id).filter(([kind]) => kind!.startsWith('gate'))).toEqual([
      ['gate-opened', 'the ep05 script gate is open'],
      ['gate-approved', 'approved the ep05 script'],
    ])
    expect(kindsAndSummaries(loud.id).filter(([kind]) => kind!.startsWith('gate'))).toEqual([
      ['gate-opened', 'the ep06 script gate is open'],
      ['gate-overridden', 'approved the ep06 script as an explicit override — recorded'],
    ])

    // Both let the run through; only one says so in a way an audit can find.
    expect(findRun(store, clean.id)!.status).toBe('done')
    expect(findRun(store, loud.id)!.status).toBe('done')
    const override = eventsOfRun(store, loud.id).find((e) => e.kind === 'gate-overridden')!
    expect(override.detail).toMatchObject({
      verdict: 'override',
      comment: 'the continuity finding is wrong about the bridge rail.',
    })
  })

  it('accepts a verdict with nothing standing in its way (D12, invariant 3)', async () => {
    const writer = writerStage(ep06)
    const { runner, rulings } = wire(writer.stages)
    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)
    const gate = gateOfStep(store, writer.stepId())!

    // A rejection has to carry the notes the step reopens with — that is the verb, not a
    // precondition on the verdict.
    expect(() => rulings.reject(gate.id, { notes: [] })).toThrow(/at least one note/)

    // No comment, no notes, no preconditions, no findings check — the verb is the whole API.
    expect(() => rulings.approve(gate.id)).not.toThrow()
    await untilSettled(store)
    expect(findRun(store, run.id)!.status).toBe('done')

    // The only two errors: nothing to rule on, and nothing left open. Neither declines a
    // verdict — one has no gate and the other has no open round.
    expect(() => rulings.approve('gate_nope')).toThrow(/no such gate/)
    expect(() => rulings.approve(gate.id)).toThrow(/no open round/)
  })
})

describe('the gate — what it leaves for the floor', () => {
  it('lists every gate waiting on Ryan, with what waits and whose it is', async () => {
    const ep05Writer = writerStage(ep05, 'write-ep05')
    const ep06Writer = writerStage(ep06, 'write-ep06')
    const { runner, rulings } = wire({ ...ep05Writer.stages, ...ep06Writer.stages })

    const first = runner.enqueueRun({ episodeId: ep05, stage: 'write-ep05' })
    const second = runner.enqueueRun({ episodeId: ep06, stage: 'write-ep06' })
    await runner.settled(first.id)
    await runner.settled(second.id)

    expect(
      openGates(store).map((open) => [open.episodeNumber, open.subject, open.round, open.stepName]),
    ).toEqual([
      [5, 'the ep05 script', 1, 'write-script'],
      [6, 'the ep06 script', 1, 'write-script'],
    ])

    rulings.approve(gateOfStep(store, ep05Writer.stepId())!.id)
    await untilSettled(store)

    // A ruled gate is no longer "needs you" — and a rejected one is, again, at round 2.
    expect(openGates(store).map((open) => open.episodeNumber)).toEqual([6])
    rulings.reject(gateOfStep(store, ep06Writer.stepId())!.id, { notes: [{ note: 'again.' }] })
    await untilSettled(store)
    expect(openGates(store).map((open) => [open.episodeNumber, open.round])).toEqual([[6, 2]])
  })

  it('holds no lock while it waits — one open gate must not starve every other episode', async () => {
    const writer = writerStage(ep06, 'write-ep06', 'image-api')
    const { runner } = wire(writer.stages)
    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write-ep06' })
    await runner.settled(run.id)

    expect(findRun(store, run.id)!.status).toBe('paused')
    expect(store.all('SELECT * FROM resource_lock')).toEqual([])
  })
})

describe('the gate — misuse the runner has to catch', () => {
  it('fails loudly, without retrying, when a step swallows its own pause', async () => {
    const artifact = script(ep06)
    const swallowing: Step = {
      name: 'write-script',
      async execute(context) {
        try {
          context.openGate({ artifactId: artifact.id })
        } catch {
          // The most natural thing to write around an LLM call, and it eats the pause.
        }
        return { script: 'v1' }
      },
    }
    const { runner } = wire({ write: scaffoldStage('write', [swallowing]) })

    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)

    const failed = findRun(store, run.id)!
    expect(failed.status).toBe('failed')
    expect(failed.failure).toMatch(/opened a gate and then returned — it caught the RunPaused/)
    // One attempt, not three: the bug is deterministic and the retry is another Opus call.
    expect(
      store.all<{ attempt: number; outcome: string }>(
        'SELECT attempt, outcome FROM step_attempt ORDER BY attempt',
      ),
    ).toEqual([{ attempt: 1, outcome: 'failed' }])
  })

  it('re-presents into the round already open rather than opening a second one', async () => {
    const writer = writerStage(ep06)
    const { runner } = wire(writer.stages)
    const run = runner.enqueueRun({ episodeId: ep06, stage: 'write' })
    await runner.settled(run.id)
    const gate = gateOfStep(store, writer.stepId())!

    // Resumed with no ruling — what a step re-entered after a crash does. It writes again
    // and presents again, and that is the same open round presenting a newer version.
    runner.resumeRun(run.id)
    await untilSettled(store)

    const standing = gateStanding(store, gate.id)!
    expect(standing.rounds).toHaveLength(1)
    expect(standing.round).toBe(1)
    expect(standing.isOpen).toBe(true)
    expect(standing.rounds[0]!.artifactVersion).toBe(2)
  })
})

// ── Test kit ────────────────────────────────────────────────────────────────────

function wire(stages: StageCatalogue): { runner: Runner; rulings: ReturnType<typeof createRulings> } {
  const runner = createRunner(store, stages, events)
  return { runner, rulings: createRulings(store, events, runner) }
}

function script(episodeId: string): Artifact {
  return recordArtifact(store, { episodeId, kind: 'script' })
}

/**
 * A writer step that behaves the way E3's will: it reads its gate on the way in, writes
 * against Ryan's notes if it was rejected, presents what it wrote, and returns its own
 * result once he has approved.
 */
function writerStage(episodeId: string, stageName = 'write', lock?: 'gpu' | 'image-api') {
  const artifact = script(episodeId)
  const log: string[] = []
  const notesSeen: string[][] = []
  const routingSeen: [string | null, string | null][][] = []
  let stepId = ''

  const step: Step = {
    name: 'write-script',
    lock,
    async execute(context: StepContext) {
      const standing = context.gate()
      const ruling = standing?.ruling
      if (ruling && ruling.verdict !== 'reject') {
        log.push('returned the approved script')
        return { script: `v${standing!.rounds.at(-1)!.artifactVersion}`, ruling: ruling.verdict }
      }

      const notes = ruling?.notes ?? []
      notesSeen.push(notes.map((note) => note.note))
      routingSeen.push(notes.map((note) => [note.depth, note.target]))
      // Round 1 is the artifact as first recorded; every re-run publishes a new version.
      if (standing) reviseArtifact(store, artifact.id, { summary: 'rewritten against the notes' })
      const version = store.get<{ version: number }>(
        'SELECT version FROM artifact WHERE id = ?',
        artifact.id,
      )!.version
      log.push(`wrote v${version} with ${notes.length} notes`)

      context.openGate({ artifactId: artifact.id, payload: { scenes: 6, pages: 14 } })
    },
  }

  return {
    stages: { [stageName]: scaffoldStage(stageName, [step]) } as StageCatalogue,
    log,
    notesSeen,
    routingSeen,
    stepId: () => {
      stepId ||= store.get<{ id: string }>(
        "SELECT id FROM step WHERE name = 'write-script' AND run_id IN (SELECT id FROM run WHERE episode_id = ?)",
        episodeId,
      )!.id
      return stepId
    },
  }
}

function kindsAndSummaries(runId: string): (string | null)[][] {
  return eventsOfRun(store, runId).map((event) => [event.kind, event.summary])
}

/** Yields to the macrotask queue until the runner stops changing the database. No timers. */
async function untilSettled(against: Store): Promise<void> {
  let previous = ''
  for (;;) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    const now = JSON.stringify([
      against.all('SELECT id, status FROM step ORDER BY id'),
      against.all('SELECT id, status FROM run ORDER BY id'),
      against.all('SELECT gate_id, round FROM gate_round ORDER BY gate_id, round'),
    ])
    if (now === previous) return
    previous = now
  }
}

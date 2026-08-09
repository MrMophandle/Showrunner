import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { eventsOfRun } from '../events.ts'
import { openStore, type Store } from '../db/store.ts'
import { createEpisode, createSeason, createShow } from '../domain/spine.ts'
import {
  attemptsOf,
  findRun,
  lockHolders,
  queuedBehind,
  stepsOf,
  waitingOn,
} from './run.ts'
import { createRunner } from './runner.ts'
import { pauseRun, type LockName, type Stage, type Step, type StageCatalogue } from './step.ts'
import { scaffoldStage } from './stage-fixture.ts'

/**
 * The runner, proven against the sentences the floor and the episode room have to say
 * (mockups/floor.html, mockups/episode-room.html):
 *
 *   "Generating · holds image-api lock"
 *   "Queued behind it: produce ep05 TTS takes — waits for this run (one run per episode)"
 *   "waiting on GPU (held by ep05)"
 *
 * Every one of those carries an identity, never a boolean, so every test here asserts on
 * WHO holds what — not that something is blocked.
 *
 * There is not one sleep in this file. Steps park on deferred promises the test resolves
 * by hand, and `untilSettled` drains the microtask queue until the database stops
 * changing. A flaky concurrency test trains everyone to re-run until green.
 */

let store: Store
let ep05: string
let ep06: string
let ep07: string

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  ep05 = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' }).id
  ep06 = createEpisode(store, { seasonId: season.id, number: 6, title: 'Cold Ledger' }).id
  ep07 = createEpisode(store, { seasonId: season.id, number: 7, title: 'Meridian' }).id
})

describe('the runner — per-episode serialization', () => {
  it('queues two runs on one episode: the second waits for the first', async () => {
    const log: string[] = []
    const outline = held('write-outline', log)
    const script = held('write-script', log)
    const runner = createRunner(store, catalogue(stage('write', outline.step), stage('script', script.step)))

    const first = runner.enqueueRun({ episodeId: ep05, stage: 'write' })
    const second = runner.enqueueRun({ episodeId: ep05, stage: 'script' })
    await untilSettled(store)

    expect(log).toEqual(['enter write-outline'])
    expect(findRun(store, first.id)!.status).toBe('running')
    expect(findRun(store, second.id)!.status).toBe('queued')

    // "Queued behind it: … — waits for this run (one run per episode)"
    expect(queuedBehind(store, second.id)).toMatchObject({ runId: first.id, stage: 'write' })

    outline.release()
    await runner.settled(first.id)
    await untilSettled(store)

    expect(log).toEqual(['enter write-outline', 'exit write-outline', 'enter write-script'])
    expect(queuedBehind(store, second.id)).toBeUndefined()

    script.release()
    await runner.settled(second.id)
    expect(findRun(store, second.id)!.status).toBe('done')
  })
})

describe('the runner — cross-episode parallelism', () => {
  it('interleaves runs on two episodes', async () => {
    const log: string[] = []
    const quietDeck = held('write-ep05', log)
    const coldLedger = held('write-ep06', log)
    const runner = createRunner(
      store,
      catalogue(stage('write-05', quietDeck.step), stage('write-06', coldLedger.step)),
    )

    const onEp05 = runner.enqueueRun({ episodeId: ep05, stage: 'write-05' })
    const onEp06 = runner.enqueueRun({ episodeId: ep06, stage: 'write-06' })
    await untilSettled(store)

    // Both in flight at once — neither has exited.
    expect(log).toEqual(['enter write-ep05', 'enter write-ep06'])
    expect(findRun(store, onEp05.id)!.status).toBe('running')
    expect(findRun(store, onEp06.id)!.status).toBe('running')

    coldLedger.release()
    await runner.settled(onEp06.id)
    expect(findRun(store, onEp05.id)!.status).toBe('running')

    quietDeck.release()
    await runner.settled(onEp05.id)
    expect(log).toEqual([
      'enter write-ep05',
      'enter write-ep06',
      'exit write-ep06',
      'exit write-ep05',
    ])
  })
})

describe('the runner — named locks', () => {
  it('surfaces the holder of a contended lock, not a boolean', async () => {
    const log: string[] = []
    const onQuietDeck = held('local-shots', log, 'gpu')
    const onColdLedger = held('tts-takes', log, 'gpu')
    const runner = createRunner(
      store,
      catalogue(stage('produce-images', onQuietDeck.step), stage('produce-audio', onColdLedger.step)),
    )

    runner.enqueueRun({ episodeId: ep05, stage: 'produce-images' })
    const blocked = runner.enqueueRun({ episodeId: ep06, stage: 'produce-audio' })
    await untilSettled(store)

    const holder = lockHolders(store)
    expect(holder).toEqual([
      expect.objectContaining({ lock: 'gpu', episodeNumber: 5, stepName: 'local-shots' }),
    ])

    const wait = waitingOn(store, blocked.id)!
    expect(wait).toMatchObject({ lock: 'gpu', heldByEpisodeNumber: 5, heldByStepName: 'local-shots' })

    // The mockup's sentence, built from nothing but that state.
    expect(`waiting on ${wait.lock.toUpperCase()} (held by ep${String(wait.heldByEpisodeNumber).padStart(2, '0')})`)
      .toBe('waiting on GPU (held by ep05)')

    onQuietDeck.release()
    onColdLedger.release()
    await untilSettled(store)
  })

  it('serializes two gpu-taking steps while an image-api step runs alongside them', async () => {
    const log: string[] = []
    // The Metal corruption lesson (D20): local image generation and TTS both take `gpu`
    // and must never overlap. Cloud image generation takes `image-api` and is expected
    // to run right alongside them.
    const localShots = held('local-shots', log, 'gpu')
    const ttsTakes = held('tts-takes', log, 'gpu')
    const cloudShots = held('cloud-shots', log, 'image-api')
    const runner = createRunner(
      store,
      catalogue(
        stage('produce-local-images', localShots.step),
        stage('produce-audio', ttsTakes.step),
        stage('produce-cloud-images', cloudShots.step),
      ),
    )

    const local = runner.enqueueRun({ episodeId: ep05, stage: 'produce-local-images' })
    const audio = runner.enqueueRun({ episodeId: ep06, stage: 'produce-audio' })
    const cloud = runner.enqueueRun({ episodeId: ep07, stage: 'produce-cloud-images' })
    await untilSettled(store)

    // The cloud step did NOT wait for the GPU; the second GPU step did.
    expect(log).toEqual(['enter local-shots', 'enter cloud-shots'])
    expect(waitingOn(store, audio.id)).toMatchObject({ lock: 'gpu', heldByEpisodeNumber: 5 })
    expect(waitingOn(store, cloud.id)).toBeUndefined()
    expect(lockHolders(store).map((h) => h.lock).sort()).toEqual(['gpu', 'image-api'])

    localShots.release()
    await runner.settled(local.id)
    await untilSettled(store)

    // TTS started only after local image generation exited — they never overlapped.
    expect(log).toEqual(['enter local-shots', 'enter cloud-shots', 'exit local-shots', 'enter tts-takes'])
    expect(findRun(store, cloud.id)!.status).toBe('running')

    ttsTakes.release()
    cloudShots.release()
    await runner.settled(audio.id)
    await runner.settled(cloud.id)

    // The whole history, with the two gpu steps strictly one after the other.
    expect(log).toEqual([
      'enter local-shots',
      'enter cloud-shots',
      'exit local-shots',
      'enter tts-takes',
      'exit tts-takes',
      'exit cloud-shots',
    ])
    expect(lockHolders(store)).toEqual([])
  })
})

describe('the runner — bounded retry', () => {
  it('surfaces the attempt history of a step that fails twice', async () => {
    let attempts = 0
    const flaky: Step = {
      name: 'generate-shot-08',
      async execute() {
        attempts += 1
        throw new Error(`the GPU worker went away (attempt ${attempts})`)
      },
    }
    const runner = createRunner(store, catalogue(stage('produce', flaky)))

    const run = runner.enqueueRun({ episodeId: ep05, stage: 'produce' })
    await runner.settled(run.id)

    // One attempt plus the two retries invariant 5 allows, then it reaches Ryan.
    expect(attempts).toBe(3)
    expect(findRun(store, run.id)!.status).toBe('failed')

    const step = stepsOf(store, run.id)[0]!
    expect(step.status).toBe('failed')
    expect(attemptsOf(store, step.id).map((a) => [a.attempt, a.outcome, a.failure])).toEqual([
      [1, 'failed', 'the GPU worker went away (attempt 1)'],
      [2, 'failed', 'the GPU worker went away (attempt 2)'],
      [3, 'failed', 'the GPU worker went away (attempt 3)'],
    ])

    // The floor counts the budget it is actually spending. A re-entry that spent none of
    // it — a gate round — says the step's name and nothing more (gate.test.ts).
    expect(
      eventsOfRun(store, run.id)
        .filter((event) => event.kind === 'step-started')
        .map((event) => event.summary),
    ).toEqual([
      'generate-shot-08',
      'generate-shot-08 — attempt 2 of 3',
      'generate-shot-08 — attempt 3 of 3',
    ])
  })

  it('keeps the losing attempts of a step that fails twice and then succeeds', async () => {
    let attempts = 0
    const flaky: Step = {
      name: 'generate-shot-08',
      async execute() {
        attempts += 1
        if (attempts < 3) throw new Error(`the GPU worker went away (attempt ${attempts})`)
        return { shot: 8 }
      },
    }
    const runner = createRunner(store, catalogue(stage('produce', flaky)))

    const run = runner.enqueueRun({ episodeId: ep05, stage: 'produce' })
    await runner.settled(run.id)

    expect(findRun(store, run.id)!.status).toBe('done')
    const step = stepsOf(store, run.id)[0]!
    expect(step.output).toEqual({ shot: 8 })
    expect(attemptsOf(store, step.id).map((a) => a.outcome)).toEqual(['failed', 'failed', 'succeeded'])
  })
})

describe('the runner — inputs and outputs', () => {
  it('hands a step the output it declared, and refuses the one it did not', async () => {
    const manifest: Step = {
      name: 'build-shot-manifest',
      async execute() {
        return { shots: 14 }
      },
    }
    let seen: unknown
    let refused: string = ''
    const generate: Step = {
      name: 'generate-shots',
      inputs: ['build-shot-manifest'],
      async execute(context) {
        seen = context.input<{ shots: number }>('build-shot-manifest')
        try {
          context.input('write-script')
        } catch (error) {
          refused = (error as Error).message
        }
        return { generated: 14 }
      },
    }
    const runner = createRunner(store, catalogue(stage('produce', manifest, generate)))

    const run = runner.enqueueRun({ episodeId: ep05, stage: 'produce' })
    await runner.settled(run.id)

    expect(findRun(store, run.id)!.status).toBe('done')
    expect(seen).toEqual({ shots: 14 })
    expect(refused).toMatch(/did not declare .*write-script/)
  })
})

describe('the runner — the pause seam E1-4 hangs gates off', () => {
  it('parks a run on a decision and picks the same step back up when it is resumed', async () => {
    const log: string[] = []
    let ruled = false
    const gateStep: Step = {
      name: 'rule-on-the-script',
      lock: 'gpu',
      async execute() {
        log.push('enter rule-on-the-script')
        if (!ruled) pauseRun('the ep05 script gate is open — 3 findings')
        return { ruling: 'approve' }
      },
    }
    const after = held('produce-shots', log)
    const runner = createRunner(store, catalogue(stage('script', gateStep, after.step)))

    const run = runner.enqueueRun({ episodeId: ep05, stage: 'script' })
    await runner.settled(run.id)

    const paused = findRun(store, run.id)!
    expect(paused.status).toBe('paused')
    expect(paused.pauseReason).toBe('the ep05 script gate is open — 3 findings')
    // A paused run holds no lock — Ryan may take days.
    expect(lockHolders(store)).toEqual([])
    expect(log).toEqual(['enter rule-on-the-script'])

    ruled = true
    runner.resumeRun(run.id)
    await untilSettled(store)

    expect(log).toEqual(['enter rule-on-the-script', 'enter rule-on-the-script', 'enter produce-shots'])
    after.release()
    await runner.settled(run.id)
    expect(findRun(store, run.id)!.status).toBe('done')
  })
})

// ── Test kit ────────────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/**
 * A step that enters, logs, and then hangs until the test releases it by hand. This is
 * what makes the interleavings here provable instead of probable.
 */
function held(name: string, log: string[], lock?: LockName) {
  const finish = deferred<void>()
  const step: Step = {
    name,
    lock,
    async execute() {
      log.push(`enter ${name}`)
      await finish.promise
      log.push(`exit ${name}`)
      return { step: name }
    },
  }
  return { step, release: () => finish.resolve() }
}

function stage(name: string, ...steps: Step[]): Stage {
  return scaffoldStage(name, steps)
}

function catalogue(...stages: Stage[]): StageCatalogue {
  return Object.fromEntries(stages.map((s) => [s.name, s]))
}

/**
 * Yields to the macrotask queue until the runner stops changing the database. Every await
 * in the runner is microtask-driven, so a single macrotask boundary drains all of them;
 * comparing two consecutive readings is the belt to that braces. No timers, no polling
 * interval, no "give it 50ms and hope".
 */
async function untilSettled(against: Store): Promise<void> {
  let previous = ''
  for (;;) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    const now = JSON.stringify([
      against.all('SELECT id, status, waiting_on FROM step ORDER BY id'),
      against.all('SELECT id, status FROM run ORDER BY id'),
      against.all('SELECT name, held_by_step_id FROM resource_lock ORDER BY name'),
    ])
    if (now === previous) return
    previous = now
  }
}

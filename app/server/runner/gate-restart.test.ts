import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/store.ts'
import { eventsOfRun } from '../events.ts'
import { gateStanding, openGates } from './gate.ts'
import { findRun, stepsOf } from './run.ts'

/** A fixture process: no stdin, both output streams piped back here. */
type Fixture = ChildProcessByStdio<null, Readable, Readable>

/**
 * "Open gates survive reboots" (2.3), proved the only way it can honestly be proved: a real
 * process killed with SIGKILL while a gate is open, and a second process that starts from
 * nothing but the database on disk and rules on it.
 *
 * Losing a mid-run step costs a retry. Losing an open gate loses Ryan's pending decision —
 * the one thing this system promises never to drop — so it is held to the same standard
 * crash-resume is, next door in crash.test.ts.
 */

const FIXTURE = join(import.meta.dirname, 'gate-fixture.ts')

let libraryDir: string
let children: Fixture[]

beforeEach(() => {
  libraryDir = mkdtempSync(join(tmpdir(), 'showrunner-gate-'))
  children = []
})

afterEach(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(libraryDir, { recursive: true, force: true })
})

describe('the gate — surviving a restart', () => {
  it('a run pauses at a gate and survives restart still-open, then rules through to done', async () => {
    // ── The first process: writes, presents, parks on Ryan, and is killed ──
    const first = spawnFixture('start')
    const parked = await lineFrom(first, /^parked /)
    const [, runId, gateId] = parked.split(' ') as [string, string, string]
    first.kill('SIGKILL')
    expect(await exitOf(first)).toEqual({ code: null, signal: 'SIGKILL' })

    // Killed with the gate open, the database says so — and says nothing is held.
    const afterKill = readLibrary(libraryDir, (store) => ({
      run: findRun(store, runId)!.status,
      steps: stepsOf(store, runId).map((step) => [step.name, step.status]),
      standing: gateStanding(store, gateId)!,
      // A gate holds no lock while it waits. The step took `image-api` to do its work and
      // the runner released it on the pause; a lock held across a decision would starve
      // every other episode until Ryan woke up — "waiting on image-api (held by ep06)"
      // for as long as he slept.
      locks: store.all('SELECT * FROM resource_lock'),
    }))
    expect(afterKill.run).toBe('paused')
    expect(afterKill.steps).toEqual([
      ['write-script', 'paused'],
      ['publish-the-cut', 'pending'],
    ])
    expect(afterKill.standing.isOpen).toBe(true)
    expect(afterKill.standing.round).toBe(1)
    expect(afterKill.locks).toEqual([])

    // ── The second process: has never seen the first, boots, and finds the gate ──
    const second = spawnFixture('rule')

    // Reclaim leaves it ALONE. A paused run is not abandoned work, and a boot that
    // "helpfully" tidied it away would throw Ryan's pending decision back into the queue.
    expect(await lineFrom(second, /^reclaimed /)).toBe('reclaimed 0')
    expect(await lineFrom(second, /^open /)).toBe('open 1 the ep06 script|round 1')

    // It rejects with two routed notes — the work reopens, still Ryan's, now at round 2.
    expect(await lineFrom(second, /^rejected /)).toBe('rejected paused round 2')
    // Then approves, and the run runs on through the step after the gate.
    expect(await lineFrom(second, /^finished /)).toBe(`finished ${runId} done`)
    expect(await exitOf(second)).toEqual({ code: 0, signal: null })

    // ── What both processes did, from the library alone ──
    const done = readLibrary(libraryDir, (store) => ({
      run: findRun(store, runId)!.status,
      standing: gateStanding(store, gateId)!,
      open: openGates(store).length,
      log: eventsOfRun(store, runId).map((event) => [event.seq, event.kind]),
    }))

    expect(done.run).toBe('done')
    expect(done.open).toBe(0)
    // "script v2 under review · writer re-ran with your round-1 notes", across a reboot.
    expect(
      done.standing.rounds.map((round) => [
        round.round,
        round.artifactVersion,
        round.stale,
        round.ruling?.verdict,
      ]),
    ).toEqual([
      [1, 1, true, 'reject'],
      [2, 2, false, 'approve'],
    ])
    // The rejection's routing crossed the process boundary with it.
    expect(done.standing.rounds[0]!.ruling!.notes).toEqual([
      { note: 'scene 4 puts Mara in two places.', depth: 'scene', target: 'scene-4' },
      { note: 'and the ledger-office shot is the wrong lens.', depth: 'shot', target: 'shot-05' },
    ])

    // One unbroken log across the kill: the first process opened the gate, the second
    // ruled on it, and `seq` runs straight through the gap with no restart and no repeat.
    expect(done.log.map(([seq]) => seq)).toEqual(
      done.log.map((_, index) => index + 1),
    )
    expect(done.log.map(([, kind]) => kind)).toEqual([
      // ── the first process: wrote, presented, parked ──
      'run-queued',
      'run-started',
      'lock-acquired',
      'step-started',
      'gate-opened',
      'step-paused',
      'run-paused',
      'lock-released',   // before the wait, never during it
      // ── the second process: rejected with routing, and the step reopened ──
      'gate-rejected',
      'run-resumed',
      'run-started',
      'lock-acquired',
      'step-started',
      'gate-opened',     // round 2, same gate
      'step-paused',
      'run-paused',
      'lock-released',
      // ── and approved, which let the step return and the run finish ──
      'gate-approved',
      'run-resumed',
      'run-started',
      'lock-acquired',
      'step-started',
      'step-done',
      'lock-released',
      'step-started',
      'step-done',
      'run-done',
    ])

    // And the steps of both processes, in order, from the file they both appended to.
    expect(readFileSync(join(libraryDir, 'steps.log'), 'utf8').trim().split('\n').map(strippedPid))
      .toEqual([
        'write-script wrote and presented',
        'write-script rewrote against 2 notes',
        'write-script resumed on approve',
        'publish-the-cut ran',
      ])
    // The same ceiling `crash.test.ts` gives its own kill-and-restart, and for the same
    // reason: this spawns two processes and waits for each to boot, which on a loaded
    // machine is seconds. Nothing here waits on a clock, so the ceiling only ever catches
    // a real hang — and a durability test that goes red on a busy laptop teaches the
    // suite to be re-run until it is green.
  }, 60_000)
})

// ── Test kit ────────────────────────────────────────────────────────────────────

/**
 * Everything each fixture has said, kept from the moment it was spawned.
 *
 * Kept from the start, and never per-wait. The `rule` phase says four things and then
 * exits, and this file waits for them one after another — so a buffer that began when the
 * second `lineFrom` was called would miss any line that arrived in the same chunk as the
 * first, and the process would then exit with the wait still outstanding. That is a test
 * that fails perhaps one run in ten, on timing, saying nothing true about gates.
 */
const heard = new WeakMap<Fixture, Transcript>()

interface Transcript {
  out: string
  err: string
  /** Re-checked on every chunk and once the streams close. */
  waiters: Set<() => void>
}

function spawnFixture(phase: 'start' | 'rule'): Fixture {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', FIXTURE, libraryDir, phase],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as Fixture
  const transcript: Transcript = { out: '', err: '', waiters: new Set() }
  heard.set(child, transcript)

  const wake = (): void => {
    for (const waiter of [...transcript.waiters]) waiter()
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    transcript.out += chunk
    wake()
  })
  child.stderr.on('data', (chunk: string) => {
    transcript.err += chunk
  })
  // 'close' rather than 'exit': it fires once the streams are drained, so a line the
  // process wrote on its way out is in hand before anything gives up on it.
  child.once('close', wake)

  children.push(child)
  return child
}

/** The first stdout line matching `wanted` — including one the process has already said. */
function lineFrom(child: Fixture, wanted: RegExp): Promise<string> {
  const transcript = heard.get(child)!
  return new Promise((resolve, reject) => {
    const look = (): void => {
      const found = transcript.out.split('\n').find((line) => wanted.test(line))
      if (found !== undefined) {
        transcript.waiters.delete(look)
        resolve(found.trim())
        return
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        transcript.waiters.delete(look)
        reject(
          new Error(
            `the fixture exited before saying ${wanted}\n${transcript.out}\n${transcript.err}`,
          ),
        )
      }
    }
    transcript.waiters.add(look)
    look()
  })
}

function exitOf(child: Fixture): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode })
      return
    }
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

/** Opens the library the fixtures wrote, reads one answer out of it, and closes it again. */
function readLibrary<T>(dir: string, read: (store: Store) => T): T {
  const store = openStore(join(dir, 'showrunner.db'))
  try {
    return read(store)
  } finally {
    store.close()
  }
}

const strippedPid = (line: string): string => line.slice(line.indexOf(' ') + 1)

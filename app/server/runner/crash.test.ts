import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../db/store.ts'
import { eventsOfRun } from '../events.ts'
import { attemptsOf, findRun, stepsOf } from './run.ts'

/** A fixture process: no stdin, both output streams piped back here. */
type Fixture = ChildProcessByStdio<null, Readable, Readable>

/**
 * Crash-resume, proven the only way it can honestly be proven: a real process, killed
 * with SIGKILL in the middle of a step, and a second process that starts from nothing but
 * the database on disk.
 *
 * If resume lived in a module-level Map, the first process would have taken it to the
 * grave and the second would have nothing to go on. That is exactly the failure this
 * test exists to catch, and it is why the fixture runs in a child process rather than
 * calling `resume()` on an object this file is holding.
 */

const FIXTURE = join(import.meta.dirname, 'crash-fixture.ts')

let libraryDir: string
let children: Fixture[]

beforeEach(() => {
  libraryDir = mkdtempSync(join(tmpdir(), 'showrunner-crash-'))
  children = []
})

afterEach(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(libraryDir, { recursive: true, force: true })
})

describe('the runner — crash-resume', () => {
  it('resumes from the last completed step after kill -9 and finishes the run', async () => {
    // ── The first process: runs, reaches the long step, and is killed mid-flight ──
    const first = spawnFixture('start')
    await lineFrom(first, 'mid-step generate-shots')
    first.kill('SIGKILL')
    expect(await exitOf(first)).toEqual({ code: null, signal: 'SIGKILL' })

    // Killed mid-step, the database still says the run was running.
    const afterCrash = readLibrary(libraryDir, (store) => {
      const run = onlyRun(store)
      return { status: run.status, steps: stepsOf(store, run.id).map((s) => [s.name, s.status]) }
    })
    expect(afterCrash).toEqual({
      status: 'running',
      steps: [
        ['build-shot-manifest', 'done'],
        ['generate-shots', 'running'],
        ['assemble', 'pending'],
      ],
    })

    // ── The second process: has never seen the first, only its database ──
    const second = spawnFixture('restart')
    const resuming = await lineFrom(second, /^resuming /)
    const finished = await lineFrom(second, /^finished /)
    expect(await exitOf(second)).toEqual({ code: 0, signal: null })

    expect(resuming).toBe('resuming 1')
    expect(finished).toMatch(/^finished run_\w+ done$/)

    // The completed step was NOT re-run: one line for it, from the first process only.
    const executions = readFileSync(join(libraryDir, 'steps.log'), 'utf8').trim().split('\n')
    const firstPid = executions[0]!.split(' ')[0]
    expect(executions.map((line) => line.split(' ')[1])).toEqual([
      'build-shot-manifest',
      'generate-shots',
      'generate-shots',
      'assemble',
    ])
    expect(executions[1]!.split(' ')[0]).toBe(firstPid)
    expect(executions[2]!.split(' ')[0]).not.toBe(firstPid)

    const after = readLibrary(libraryDir, (store) => {
      const run = onlyRun(store)
      const steps = stepsOf(store, run.id)
      return {
        run: run.status,
        steps: steps.map((s) => [s.name, s.status, s.output]),
        interrupted: attemptsOf(store, steps[1]!.id).map((a) => [a.attempt, a.outcome]),
        locks: store.all('SELECT name FROM resource_lock'),
      }
    })
    expect(after).toEqual({
      run: 'done',
      steps: [
        ['build-shot-manifest', 'done', { shots: 14 }],
        ['generate-shots', 'done', { generated: 14 }],
        ['assemble', 'done', { assembled: 14 }],
      ],
      // The attempt the kill took is kept, and honestly labelled — it was not a failure
      // of the step, so it did not spend the retry budget.
      interrupted: [
        [1, 'abandoned'],
        [2, 'succeeded'],
      ],
      // The lock the dead process held was reclaimed; a fresh boot holds nothing.
      locks: [],
    })

    // ── The audit trail spans the kill ──────────────────────────────────────────
    // Two processes, one log. The first process's events are still there — nothing
    // rewrote or tidied them — and the second process's boot is recorded rather than
    // silently rewriting rows where the crash was.
    const log = readLibrary(libraryDir, (store) =>
      eventsOfRun(store, onlyRun(store).id).map((e) => [e.kind, e.summary, e.detail] as const),
    )
    expect(log.map(([kind]) => kind)).toEqual([
      // The first process, up to the moment it died mid-step.
      'run-queued',
      'run-started',
      'step-started', //   build-shot-manifest
      'step-done',
      'lock-acquired', //  image-api, for generate-shots
      'step-started', //   generate-shots — and then SIGKILL. No release, no completion.
      // The second process, which has only ever seen the database.
      'run-reclaimed',
      'run-started',
      'lock-acquired',
      'step-started', //   generate-shots again, attempt 2
      'step-done',
      'lock-released',
      'step-started', //   assemble
      'step-done',
      'run-done',
    ])

    const reclaimed = log[6]!
    expect(reclaimed[1]).toBe(
      "produce-shot-images died inside generate-shots — back in its episode's queue",
    )
    // The lock the dead process was holding is named, not merely dropped.
    expect(reclaimed[2]).toEqual({
      stage: 'produce-shot-images',
      locks: ['image-api'],
      abandonedSteps: ['generate-shots'],
    })
  }, 60_000)
})

// ── Test kit ────────────────────────────────────────────────────────────────────

function spawnFixture(phase: 'start' | 'restart'): Fixture {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', FIXTURE, libraryDir, phase],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  children.push(child)
  return child
}

/** Resolves with the first stdout line matching `want`; rejects if the child dies first. */
function lineFrom(child: Fixture, want: string | RegExp): Promise<string> {
  const matches = (line: string) => (typeof want === 'string' ? line === want : want.test(line))
  return new Promise((resolve, reject) => {
    let buffer = ''
    let stderr = ''
    const onStderr = (chunk: string) => {
      stderr += chunk
    }
    const onExit = () =>
      finish(() => reject(new Error(`the fixture exited before saying ${String(want)}\n${stderr}`)))
    const onData = (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (matches(line)) return finish(() => resolve(line))
    }
    const finish = (settle: () => void) => {
      child.stdout.off('data', onData)
      child.stderr.off('data', onStderr)
      child.off('exit', onExit)
      settle()
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onStderr)
    child.on('exit', onExit)
  })
}

function exitOf(child: Fixture): Promise<{
  code: number | null
  signal: string | null
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
}

/** Opens the child's library — the real one, on disk — reads one answer out, and closes. */
function readLibrary<T>(dir: string, read: (store: Store) => T): T {
  const store = openStore(join(dir, 'showrunner.db'))
  try {
    return read(store)
  } finally {
    store.close()
  }
}

function onlyRun(store: Store) {
  const runs = store.all<{ id: string }>('SELECT id FROM run')
  expect(runs).toHaveLength(1)
  return findRun(store, runs[0]!.id)!
}

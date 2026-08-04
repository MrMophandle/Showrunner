import type { Store } from '../db/store.ts'
import {
  beginStepAttempt,
  completeStep,
  failStep,
  failedAttemptCount,
  findRun,
  findStepByName,
  markRunDone,
  markRunFailed,
  markRunPaused,
  markRunQueued,
  markRunRunning,
  markStepWaitingOnLock,
  nextAttemptNumber,
  pauseStep,
  reclaimAfterCrash,
  recordAttempt,
  reconcileSteps,
  recordRun,
  releaseLock,
  releaseLocksHeldBy,
  resetStep,
  SETTLED_RUN_STATUS,
  startableRuns,
  stepsOf,
  tryAcquireLock,
  type Run,
} from './run.ts'
import { RunPaused, type LockName, type Stage, type StageCatalogue, type Step, type StepContext } from './step.ts'

/**
 * The runner. It starts runs Ryan asked for, executes their steps in order, arbitrates the
 * named locks, retries a failing step twice, and stops.
 *
 * ── What it is not ──────────────────────────────────────────────────────────────
 * There is no DSL here, no config-driven graph, no step registry read from the database,
 * and no generic retry/branch/condition primitive. The only control flow is: run the
 * stage's steps in array order, stop when one fails or pauses. Anything a stage needs to
 * decide, it decides in TypeScript inside a step, where it is readable and has a test.
 * A `stage` column holds a NAME, and `stages` maps that name back to code — that lookup
 * exists because a restarted process has a row and needs its function again, and it is
 * the only concession to indirection in this file.
 *
 * ── Where the state lives ───────────────────────────────────────────────────────
 * On disk. Nothing in this module is at module scope: the in-flight set and the lock
 * waiters below belong to one runner instance and are pure scheduling — every fact a
 * restart needs is written to the database before and after each step. A runner built
 * from nothing but the library file knows everything the dead one knew, which is why
 * `crash.test.ts` can kill a real process with SIGKILL and prove it.
 *
 * ── Nothing runs without a click ────────────────────────────────────────────────
 * A run exists only because `enqueueRun` was called, which is only ever behind a button.
 * The runner starts nothing it was not asked for; what it does do is get on with work
 * already clicked, including work a crash interrupted.
 */

/** One attempt plus the two retries invariant 5 allows, then it reaches Ryan. */
export const MAX_ATTEMPTS_PER_STEP = 3

export interface RunRequest {
  episodeId: string
  stage: string
}

export interface Runner {
  /** Ryan's click. Records the run and starts it if its episode is free. */
  enqueueRun(request: RunRequest): Run
  /** A ruling landed on a paused run: it re-enters the step that paused it. */
  resumeRun(runId: string): void
  /** Boot: picks up every run Ryan clicked that a crash or a shutdown left unfinished. */
  resumeInterrupted(): Run[]
  /** Resolves when the run is done, failed, or parked on Ryan. */
  settled(runId: string): Promise<Run>
}

export function createRunner(store: Store, stages: StageCatalogue): Runner {
  // A fresh process holds no locks and owns no running step. Fix the database first, so
  // everything below reads a world that is true.
  reclaimAfterCrash(store)

  /** Runs this instance is currently driving. Scheduling only — never the source of truth. */
  const driving = new Set<string>()
  /** Who to wake when a lock is released. Single process (2.1), so this is the whole story. */
  const lockWaiters = new Map<LockName, Set<() => void>>()
  const settlementWaiters = new Map<string, Set<(run: Run) => void>>()

  function stageFor(name: string): Stage {
    const stage = stages[name]
    if (!stage) {
      throw new Error(
        `no such stage in code: "${name}" — stages are TypeScript in runner/stages.ts, not data`,
      )
    }
    return stage
  }

  /**
   * Starts every run that may legally start now: for each episode with nothing running or
   * paused on it, the oldest thing Ryan queued. Called after a click and after every run
   * settles — which is what makes "Queued behind it… waits for this run" come true.
   */
  function advance(): Run[] {
    const started: Run[] = []
    for (const run of startableRuns(store)) {
      if (driving.has(run.id)) continue
      // This build has no code for that stage. Leave the run queued rather than failing
      // it: a click Ryan already made is not something a deploy gets to throw away.
      if (!stages[run.stage]) continue
      driving.add(run.id)
      started.push(run)
      void drive(run.id)
    }
    return started
  }

  async function drive(runId: string): Promise<void> {
    try {
      const run = findRun(store, runId)!
      const stage = stageFor(run.stage)
      reconcileSteps(store, runId, stage)
      markRunRunning(store, runId)

      for (const definition of stage.steps) {
        const record = findStepByName(store, runId, definition.name)!
        if (record.status === 'done') continue // resume: a finished step is never re-run
        const outcome = await executeStep(run, definition, record.id)
        if (outcome !== 'done') return // failed or parked on Ryan — the run stops here
      }
      markRunDone(store, runId)
    } catch (error) {
      // Nothing above is allowed to escape: an unhandled rejection would leave a run that
      // says 'running' forever with no process behind it.
      markRunFailed(store, runId, messageOf(error))
    } finally {
      for (const lock of releaseLocksHeldBy(store, runId)) wakeWaiters(lock)
      driving.delete(runId)
      settle(runId)
      advance()
    }
  }

  async function executeStep(
    run: Run,
    definition: Step,
    stepId: string,
  ): Promise<'done' | 'paused' | 'failed'> {
    if (definition.lock) await acquire(definition.lock, run.id, stepId)
    try {
      // Read the budget off the database, not off a counter: a step that already failed
      // twice before a crash gets one more try, not three.
      let failures = failedAttemptCount(store, stepId)

      for (;;) {
        const attempt = nextAttemptNumber(store, stepId)
        const startedAt = beginStepAttempt(store, stepId)
        try {
          const output = await definition.execute(contextFor(run, definition, attempt))
          completeStep(store, stepId, output)
          recordAttempt(store, { stepId, attempt, outcome: 'succeeded', startedAt })
          return 'done'
        } catch (error) {
          if (error instanceof RunPaused) {
            recordAttempt(store, { stepId, attempt, outcome: 'paused', startedAt })
            pauseStep(store, stepId)
            markRunPaused(store, run.id, error.reason)
            return 'paused'
          }
          const failure = messageOf(error)
          recordAttempt(store, { stepId, attempt, outcome: 'failed', failure, startedAt })
          failures += 1
          if (failures >= MAX_ATTEMPTS_PER_STEP) {
            failStep(store, stepId, failure)
            markRunFailed(store, run.id, failure)
            return 'failed'
          }
        }
      }
    } finally {
      // A step holds at most one lock, for exactly as long as it runs. That is why there
      // is no deadlock detection here: nothing ever holds one lock while wanting another.
      if (definition.lock) {
        releaseLock(store, definition.lock, run.id)
        wakeWaiters(definition.lock)
      }
    }
  }

  function contextFor(run: Run, definition: Step, attempt: number): StepContext {
    const declared = new Set(definition.inputs ?? [])
    return {
      runId: run.id,
      episodeId: run.episodeId,
      store,
      attempt,
      input<T>(stepName: string): T {
        if (!declared.has(stepName)) {
          throw new Error(
            `step "${definition.name}" did not declare "${stepName}" as an input — declare it, ` +
              'so what it consumed can be read off the run rather than guessed',
          )
        }
        const source = findStepByName(store, run.id, stepName)
        if (!source || source.status !== 'done') {
          throw new Error(`step "${definition.name}" reads "${stepName}", which has produced nothing`)
        }
        return source.output as T
      },
    }
  }

  async function acquire(lock: LockName, runId: string, stepId: string): Promise<void> {
    for (;;) {
      if (tryAcquireLock(store, lock, runId, stepId)) return
      // Persisted, so the floor can say who is holding it — "waiting on GPU (held by ep05)".
      markStepWaitingOnLock(store, stepId, lock)
      await new Promise<void>((wake) => waitersFor(lock).add(wake))
    }
  }

  function waitersFor(lock: LockName): Set<() => void> {
    let waiters = lockWaiters.get(lock)
    if (!waiters) {
      waiters = new Set()
      lockWaiters.set(lock, waiters)
    }
    return waiters
  }

  function wakeWaiters(lock: LockName): void {
    const waiters = waitersFor(lock)
    const woken = [...waiters]
    waiters.clear()
    for (const wake of woken) wake()
  }

  function settle(runId: string): void {
    const run = findRun(store, runId)
    if (!run || !SETTLED_RUN_STATUS.includes(run.status)) return
    const waiters = settlementWaiters.get(runId)
    if (!waiters) return
    settlementWaiters.delete(runId)
    for (const waiter of waiters) waiter(run)
  }

  return {
    enqueueRun(request: RunRequest): Run {
      const run = recordRun(store, stageFor(request.stage), request.episodeId)
      advance()
      return run
    },

    resumeRun(runId: string): void {
      const run = findRun(store, runId)
      if (!run) throw new Error(`no such run: ${runId}`)
      if (run.status !== 'paused') {
        throw new Error(`run ${runId} is ${run.status}, not paused — there is nothing to resume`)
      }
      store.transaction(() => {
        for (const step of stepsOf(store, runId)) {
          if (step.status === 'paused') resetStep(store, step.id)
        }
        markRunQueued(store, runId)
      })
      advance()
    },

    resumeInterrupted(): Run[] {
      return advance()
    },

    settled(runId: string): Promise<Run> {
      const run = findRun(store, runId)
      if (!run) throw new Error(`no such run: ${runId}`)
      if (SETTLED_RUN_STATUS.includes(run.status)) return Promise.resolve(run)
      return new Promise<Run>((resolve) => {
        let waiters = settlementWaiters.get(runId)
        if (!waiters) {
          waiters = new Set()
          settlementWaiters.set(runId, waiters)
        }
        waiters.add(resolve)
      })
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

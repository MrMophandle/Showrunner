import type { Store } from '../db/store.ts'
import { createEventLog, type EventLog } from '../events.ts'
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
  waitingOn,
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
 * ── The event log is downstream ─────────────────────────────────────────────────
 * This file appends an event at each transition it makes, and never reads one back.
 * `run`, `step`, and `resource_lock` remain the source of truth; the log is the record
 * for Ryan's screen and the audit trail. A runner that consulted its own log would have
 * two answers to "what is the state of this run" and crash-resume would eventually pick
 * the wrong one.
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

/**
 * `events` defaults to a log over the same store so a test whose subject is scheduling
 * does not have to build one. It is a default, not an off switch: every runner writes its
 * transitions, and the app process passes the same log it serves SSE from.
 */
export function createRunner(
  store: Store,
  stages: StageCatalogue,
  events: EventLog = createEventLog(store),
): Runner {
  // A fresh process holds no locks and owns no running step. Fix the database first, so
  // everything below reads a world that is true — then say so in the log, because a boot
  // that silently rewrote rows leaves a gap exactly where the crash was.
  for (const reclaimed of reclaimAfterCrash(store)) {
    events.append({
      kind: 'run-reclaimed',
      runId: reclaimed.runId,
      episodeId: reclaimed.episodeId,
      summary:
        reclaimed.abandonedSteps.length === 0
          ? `${reclaimed.stage} was interrupted by a crash — back in its episode's queue`
          : `${reclaimed.stage} died inside ${reclaimed.abandonedSteps.join(', ')} — back in its episode's queue`,
      detail: {
        stage: reclaimed.stage,
        locks: reclaimed.locks,
        abandonedSteps: reclaimed.abandonedSteps,
      },
    })
  }

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
    const run = findRun(store, runId)!
    try {
      const stage = stageFor(run.stage)
      reconcileSteps(store, runId, stage)
      markRunRunning(store, runId)
      events.append({
        kind: 'run-started',
        runId,
        episodeId: run.episodeId,
        summary: `${run.stage} is running`,
        detail: { stage: run.stage },
      })

      for (const definition of stage.steps) {
        const record = findStepByName(store, runId, definition.name)!
        if (record.status === 'done') continue // resume: a finished step is never re-run
        const outcome = await executeStep(run, definition, record.id)
        if (outcome !== 'done') return // failed or parked on Ryan — the run stops here
      }
      markRunDone(store, runId)
      events.append({
        kind: 'run-done',
        runId,
        episodeId: run.episodeId,
        summary: `${run.stage} finished`,
        detail: { stage: run.stage },
      })
    } catch (error) {
      // Nothing above is allowed to escape: an unhandled rejection would leave a run that
      // says 'running' forever with no process behind it.
      const failure = messageOf(error)
      markRunFailed(store, runId, failure)
      events.append({
        kind: 'run-failed',
        runId,
        episodeId: run.episodeId,
        summary: failure,
        detail: { stage: run.stage, failure },
      })
    } finally {
      // Normally empty: a step releases its own lock as it leaves. This catches the lock a
      // run held when something above threw its way out of `executeStep` entirely.
      for (const lock of releaseLocksHeldBy(store, runId)) {
        wakeWaiters(lock)
        events.append({
          kind: 'lock-released',
          runId,
          episodeId: run.episodeId,
          summary: `released the ${labelOf(lock)} lock`,
          detail: { lock },
        })
      }
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
    if (definition.lock) await acquire(definition.lock, run, definition, stepId)
    try {
      // Read the budget off the database, not off a counter: a step that already failed
      // twice before a crash gets one more try, not three.
      let failures = failedAttemptCount(store, stepId)

      for (;;) {
        const attempt = nextAttemptNumber(store, stepId)
        const startedAt = beginStepAttempt(store, stepId)
        events.append({
          kind: 'step-started',
          runId: run.id,
          stepId,
          episodeId: run.episodeId,
          summary:
            attempt === 1
              ? definition.name
              : `${definition.name} — attempt ${attempt} of ${MAX_ATTEMPTS_PER_STEP}`,
          detail: { step: definition.name, attempt, lock: definition.lock ?? null },
        })
        try {
          const output = await definition.execute(contextFor(run, definition, stepId, attempt))
          completeStep(store, stepId, output)
          recordAttempt(store, { stepId, attempt, outcome: 'succeeded', startedAt })
          events.append({
            kind: 'step-done',
            runId: run.id,
            stepId,
            episodeId: run.episodeId,
            summary: `${definition.name} finished`,
            detail: { step: definition.name, attempt },
          })
          return 'done'
        } catch (error) {
          if (error instanceof RunPaused) {
            recordAttempt(store, { stepId, attempt, outcome: 'paused', startedAt })
            pauseStep(store, stepId)
            markRunPaused(store, run.id, error.reason)
            events.append({
              kind: 'step-paused',
              runId: run.id,
              stepId,
              episodeId: run.episodeId,
              summary: `${definition.name} is waiting on Ryan`,
              detail: { step: definition.name, attempt, reason: error.reason },
            })
            // The run's own transition, separately: the floor renders this one, and it
            // renders it from the reason in Ryan's words.
            events.append({
              kind: 'run-paused',
              runId: run.id,
              stepId,
              episodeId: run.episodeId,
              summary: error.reason,
              detail: { stage: run.stage, step: definition.name, reason: error.reason },
            })
            return 'paused'
          }
          const failure = messageOf(error)
          recordAttempt(store, { stepId, attempt, outcome: 'failed', failure, startedAt })
          failures += 1
          if (failures >= MAX_ATTEMPTS_PER_STEP) {
            failStep(store, stepId, failure)
            markRunFailed(store, run.id, failure)
            events.append({
              kind: 'step-failed',
              runId: run.id,
              stepId,
              episodeId: run.episodeId,
              summary: `${definition.name} failed ${failures} times — over to Ryan with the attempt history`,
              detail: { step: definition.name, attempt, failure, attempts: failures },
            })
            events.append({
              kind: 'run-failed',
              runId: run.id,
              stepId,
              episodeId: run.episodeId,
              summary: failure,
              detail: { stage: run.stage, step: definition.name, failure },
            })
            return 'failed'
          }
          events.append({
            kind: 'step-attempt-failed',
            runId: run.id,
            stepId,
            episodeId: run.episodeId,
            summary: `${definition.name} failed on attempt ${attempt} of ${MAX_ATTEMPTS_PER_STEP} — trying again`,
            detail: { step: definition.name, attempt, failure },
          })
        }
      }
    } finally {
      // A step holds at most one lock, for exactly as long as it runs. That is why there
      // is no deadlock detection here: nothing ever holds one lock while wanting another.
      if (definition.lock) {
        releaseLock(store, definition.lock, run.id)
        wakeWaiters(definition.lock)
        events.append({
          kind: 'lock-released',
          runId: run.id,
          stepId,
          episodeId: run.episodeId,
          summary: `released the ${labelOf(definition.lock)} lock`,
          detail: { lock: definition.lock, step: definition.name },
        })
      }
    }
  }

  function contextFor(run: Run, definition: Step, stepId: string, attempt: number): StepContext {
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
      progress(text: string): void {
        events.append({
          kind: 'step-progress',
          runId: run.id,
          stepId,
          episodeId: run.episodeId,
          summary: text,
          detail: { step: definition.name, attempt },
        })
      },
      chunk(text: string): void {
        events.append({
          kind: 'step-chunk',
          runId: run.id,
          stepId,
          episodeId: run.episodeId,
          summary: text,
          detail: { step: definition.name, attempt },
        })
      },
    }
  }

  async function acquire(
    lock: LockName,
    run: Run,
    definition: Step,
    stepId: string,
  ): Promise<void> {
    for (;;) {
      if (tryAcquireLock(store, lock, run.id, stepId)) {
        events.append({
          kind: 'lock-acquired',
          runId: run.id,
          stepId,
          episodeId: run.episodeId,
          summary: `holds ${labelOf(lock)} lock`,
          detail: { lock, step: definition.name },
        })
        return
      }
      // Persisted, so the floor can say who is holding it — "waiting on GPU (held by ep05)".
      markStepWaitingOnLock(store, stepId, lock)
      // Read the holder back out rather than guessing: the sentence carries an identity,
      // and it is composed here, at the moment it was true.
      const wait = waitingOn(store, run.id)
      events.append({
        kind: 'lock-waiting',
        runId: run.id,
        stepId,
        episodeId: run.episodeId,
        summary: wait
          ? `waiting on ${labelOf(lock)} (held by ep${pad(wait.heldByEpisodeNumber)})`
          : `waiting on ${labelOf(lock)}`,
        detail: {
          lock,
          step: definition.name,
          heldByRunId: wait?.heldByRunId ?? null,
          heldByEpisodeId: wait?.heldByEpisodeId ?? null,
          heldByEpisodeNumber: wait?.heldByEpisodeNumber ?? null,
          heldByStage: wait?.heldByStage ?? null,
          heldByStepName: wait?.heldByStepName ?? null,
        },
      })
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
      // After `recordRun`'s transaction has committed, never inside it: `append` notifies
      // its subscribers as it writes, and a rollback cannot un-tell a browser.
      events.append({
        kind: 'run-queued',
        runId: run.id,
        episodeId: run.episodeId,
        summary: `${run.stage} is queued`,
        detail: { stage: run.stage },
      })
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
      events.append({
        kind: 'run-resumed',
        runId,
        episodeId: run.episodeId,
        summary: `${run.stage} picks up where Ryan's ruling left it`,
        detail: { stage: run.stage },
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

/** "waiting on GPU (held by ep05)", "holds image-api lock" — the mockups' own words. */
function labelOf(lock: LockName): string {
  return lock === 'gpu' ? 'GPU' : lock
}

const pad = (episodeNumber: number): string => String(episodeNumber).padStart(2, '0')

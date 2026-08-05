import type { Store } from '../db/store.ts'
import { newId } from '../domain/id.ts'
import type { LockName, Stage } from './step.ts'

/**
 * The run ledger: every read and write the runner makes, and every read the floor and the
 * episode room make. All of it through the store seam — `node:sqlite` is imported in
 * `db/store.ts` and nowhere else.
 *
 * Nothing here decides anything. It records what happened and answers questions about it,
 * so that a runner rebuilt from this database alone knows everything the dead one knew.
 */

export type RunStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed'
export type StepStatus =
  | 'pending'
  | 'waiting-on-lock'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
export type AttemptOutcome = 'succeeded' | 'failed' | 'paused' | 'abandoned'

/** A run is settled when it is no longer the runner's to move — it is done, dead, or Ryan's. */
export const SETTLED_RUN_STATUS: readonly RunStatus[] = ['done', 'failed', 'paused']

/** A run that is 'running' or 'paused' holds its episode; nothing else on it may start. */
const HOLDS_ITS_EPISODE = "('running','paused')"

export interface Run {
  id: string
  episodeId: string
  stage: string
  status: RunStatus
  pauseReason: string | null
  failure: string | null
  requestedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface StepRecord {
  id: string
  runId: string
  ordinal: number
  name: string
  lock: LockName | null
  status: StepStatus
  waitingOn: LockName | null
  /** The step's JSON result, or undefined until it succeeds. */
  output: unknown
  failure: string | null
  /** When the current (or last) attempt began. */
  startedAt: string | null
  finishedAt: string | null
}

export interface Attempt {
  seq: number
  stepId: string
  attempt: number
  outcome: AttemptOutcome
  failure: string | null
  startedAt: string
  finishedAt: string
}

/** Who holds a scarce resource right now — "Generating · holds image-api lock". */
export interface LockHold {
  lock: LockName
  runId: string
  episodeId: string
  episodeNumber: number
  stage: string
  stepName: string
  since: string
}

/** Who a blocked run is waiting on — "waiting on GPU (held by ep05)". Never a boolean. */
export interface LockWait {
  lock: LockName
  heldByRunId: string
  heldByEpisodeId: string
  heldByEpisodeNumber: number
  heldByStage: string
  heldByStepName: string
}

/** The run a queued run is behind — "waits for this run (one run per episode)". */
export interface RunAhead {
  runId: string
  episodeId: string
  stage: string
  status: RunStatus
}

// ── Writing a run into being ────────────────────────────────────────────────────

/**
 * Records the run Ryan asked for, with a row per step of the stage. The step rows are a
 * record of the plan, not the plan itself: the plan is `stage.steps`, in TypeScript, and
 * resume reads it from there and matches these rows to it by name.
 */
export function recordRun(store: Store, stage: Stage, episodeId: string): Run {
  return store.transaction(() => {
    const id = newId('run')
    store.run('INSERT INTO run (id, episode_id, stage) VALUES (?, ?, ?)', id, episodeId, stage.name)
    reconcileSteps(store, id, stage)
    return findRun(store, id)!
  })
}

/**
 * Makes the step rows agree with the stage's TypeScript, matching by name. Called when the
 * run is recorded and again every time it is driven — so a run that outlived a deploy picks
 * up steps the code has gained rather than resuming into a plan nobody wrote.
 */
export function reconcileSteps(store: Store, runId: string, stage: Stage): void {
  store.transaction(() => {
    stage.steps.forEach((step, index) => {
      const existing = findStepByName(store, runId, step.name)
      if (existing) {
        store.run('UPDATE step SET lock_name = ? WHERE id = ?', step.lock ?? null, existing.id)
        return
      }
      store.run(
        'INSERT INTO step (id, run_id, ordinal, name, lock_name) VALUES (?, ?, ?, ?, ?)',
        newId('step'),
        runId,
        index + 1,
        step.name,
        step.lock ?? null,
      )
    })
  })
}

// ── Reading ─────────────────────────────────────────────────────────────────────

export function findRun(store: Store, id: string): Run | undefined {
  const row = store.get<RunRow>('SELECT * FROM run WHERE id = ?', id)
  return row && hydrateRun(row)
}

export function stepsOf(store: Store, runId: string): StepRecord[] {
  return store
    .all<StepRow>('SELECT * FROM step WHERE run_id = ? ORDER BY ordinal', runId)
    .map(hydrateStep)
}

/**
 * This episode's runs, newest first — the episode room's run list, and what a launch
 * button reads to find out whether it may offer itself at all. Ordered by `seq` rather
 * than `requested_at`, for the same reason the event log is: the timestamp is for humans.
 */
export function runsOfEpisode(store: Store, episodeId: string, limit = 20): Run[] {
  return store
    .all<RunRow>(
      'SELECT * FROM run WHERE episode_id = ? ORDER BY seq DESC LIMIT ?',
      episodeId,
      limit,
    )
    .map(hydrateRun)
}

export function findStepByName(store: Store, runId: string, name: string): StepRecord | undefined {
  const row = store.get<StepRow>('SELECT * FROM step WHERE run_id = ? AND name = ?', runId, name)
  return row && hydrateStep(row)
}

/** Every attempt of a step, kept — this is the loop history Ryan is handed when it gives up. */
export function attemptsOf(store: Store, stepId: string): Attempt[] {
  return store
    .all<AttemptRow>('SELECT * FROM step_attempt WHERE step_id = ? ORDER BY attempt', stepId)
    .map((row) => ({
      seq: row.seq,
      stepId: row.step_id,
      attempt: row.attempt,
      outcome: row.outcome,
      failure: row.failure,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }))
}

/** How many of a step's attempts were the step's own fault. Only these spend the budget. */
export function failedAttemptCount(store: Store, stepId: string): number {
  return store.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM step_attempt WHERE step_id = ? AND outcome = 'failed'",
    stepId,
  )!.n
}

/** The number the next attempt gets. Abandoned attempts hold their number so history reads straight. */
export function nextAttemptNumber(store: Store, stepId: string): number {
  return (
    store.get<{ highest: number | null }>(
      'SELECT MAX(attempt) AS highest FROM step_attempt WHERE step_id = ?',
      stepId,
    )!.highest ?? 0
  ) + 1
}

export function lockHolders(store: Store): LockHold[] {
  return store
    .all<LockHoldRow>(
      `SELECT l.name, l.held_by_run_id, l.acquired_at, r.episode_id, r.stage,
              e.number AS episode_number, s.name AS step_name
         FROM resource_lock l
         JOIN run r ON r.id = l.held_by_run_id
         JOIN episode e ON e.id = r.episode_id
         JOIN step s ON s.id = l.held_by_step_id
        ORDER BY l.name`,
    )
    .map((row) => ({
      lock: row.name,
      runId: row.held_by_run_id,
      episodeId: row.episode_id,
      episodeNumber: row.episode_number,
      stage: row.stage,
      stepName: row.step_name,
      since: row.acquired_at,
    }))
}

/**
 * What a blocked run is blocked on, and WHO has it. The holder's identity is the state:
 * "waiting on GPU (held by ep05)" cannot be rendered from a boolean, and a screen that
 * makes Ryan go find out who is holding the GPU has failed the HIL contract.
 */
export function waitingOn(store: Store, runId: string): LockWait | undefined {
  const row = store.get<LockWaitRow>(
    `SELECT s.waiting_on, l.held_by_run_id, r.episode_id, r.stage,
            e.number AS episode_number, hs.name AS step_name
       FROM step s
       JOIN resource_lock l ON l.name = s.waiting_on
       JOIN run r ON r.id = l.held_by_run_id
       JOIN episode e ON e.id = r.episode_id
       JOIN step hs ON hs.id = l.held_by_step_id
      WHERE s.run_id = ? AND s.status = 'waiting-on-lock'
      LIMIT 1`,
    runId,
  )
  if (!row) return undefined
  return {
    lock: row.waiting_on,
    heldByRunId: row.held_by_run_id,
    heldByEpisodeId: row.episode_id,
    heldByEpisodeNumber: row.episode_number,
    heldByStage: row.stage,
    heldByStepName: row.step_name,
  }
}

/**
 * The run this one is queued behind on its episode — the earliest unfinished run ahead of
 * it. One run per episode, so this is the whole reason it has not started.
 */
export function queuedBehind(store: Store, runId: string): RunAhead | undefined {
  const row = store.get<RunRow>(
    `SELECT ahead.* FROM run ahead
       JOIN run mine ON mine.episode_id = ahead.episode_id
      WHERE mine.id = ?
        AND ahead.seq < mine.seq
        AND ahead.status IN ('queued','running','paused')
      ORDER BY ahead.seq LIMIT 1`,
    runId,
  )
  if (!row) return undefined
  return { runId: row.id, episodeId: row.episode_id, stage: row.stage, status: row.status }
}

/**
 * The runs that may legally start right now: for each episode with nothing running or
 * paused on it, the oldest thing Ryan queued. This is the whole of per-episode
 * serialization and cross-episode parallelism — one query, no scheduler state in memory.
 */
export function startableRuns(store: Store): Run[] {
  return store
    .all<RunRow>(
      `SELECT r.* FROM run r
        WHERE r.status = 'queued'
          AND NOT EXISTS (
                SELECT 1 FROM run holder
                 WHERE holder.episode_id = r.episode_id
                   AND holder.status IN ${HOLDS_ITS_EPISODE})
          AND r.seq = (
                SELECT MIN(q.seq) FROM run q
                 WHERE q.episode_id = r.episode_id AND q.status = 'queued')
        ORDER BY r.seq`,
    )
    .map(hydrateRun)
}

// ── Transitions ─────────────────────────────────────────────────────────────────

export function markRunRunning(store: Store, runId: string): void {
  store.run(
    `UPDATE run SET status = 'running', pause_reason = NULL, failure = NULL,
            started_at = COALESCE(started_at, ?) WHERE id = ?`,
    now(store),
    runId,
  )
}

export function markRunDone(store: Store, runId: string): void {
  store.run("UPDATE run SET status = 'done', finished_at = ? WHERE id = ?", now(store), runId)
}

export function markRunFailed(store: Store, runId: string, failure: string): void {
  store.run(
    "UPDATE run SET status = 'failed', failure = ?, finished_at = ? WHERE id = ?",
    failure,
    now(store),
    runId,
  )
}

export function markRunPaused(store: Store, runId: string, reason: string): void {
  store.run("UPDATE run SET status = 'paused', pause_reason = ? WHERE id = ?", reason, runId)
}

/** Ryan's ruling landed: the run goes back in its episode's queue and re-enters its step. */
export function markRunQueued(store: Store, runId: string): void {
  store.run("UPDATE run SET status = 'queued', pause_reason = NULL WHERE id = ?", runId)
}

export function markStepWaitingOnLock(store: Store, stepId: string, lock: LockName): void {
  store.run(
    "UPDATE step SET status = 'waiting-on-lock', waiting_on = ? WHERE id = ?",
    lock,
    stepId,
  )
}

/** Persisted BEFORE the step runs — a process that dies now leaves a step it can explain. */
export function beginStepAttempt(store: Store, stepId: string): string {
  const startedAt = now(store)
  store.run(
    "UPDATE step SET status = 'running', waiting_on = NULL, failure = NULL, started_at = ? WHERE id = ?",
    startedAt,
    stepId,
  )
  return startedAt
}

/** Persisted AFTER, with the output, which is what makes resume able to skip it. */
export function completeStep(store: Store, stepId: string, output: unknown): void {
  store.run(
    "UPDATE step SET status = 'done', output = ?, finished_at = ? WHERE id = ?",
    output === undefined ? null : JSON.stringify(output),
    now(store),
    stepId,
  )
}

export function failStep(store: Store, stepId: string, failure: string): void {
  store.run(
    "UPDATE step SET status = 'failed', failure = ?, finished_at = ? WHERE id = ?",
    failure,
    now(store),
    stepId,
  )
}

export function pauseStep(store: Store, stepId: string): void {
  store.run("UPDATE step SET status = 'paused' WHERE id = ?", stepId)
}

/** Back to pending, so resume re-enters the step from the top. Steps are idempotent. */
export function resetStep(store: Store, stepId: string): void {
  store.run("UPDATE step SET status = 'pending', waiting_on = NULL WHERE id = ?", stepId)
}

export function recordAttempt(
  store: Store,
  attempt: { stepId: string; attempt: number; outcome: AttemptOutcome; failure?: string; startedAt: string },
): void {
  store.run(
    `INSERT INTO step_attempt (step_id, attempt, outcome, failure, started_at)
     VALUES (?, ?, ?, ?, ?)`,
    attempt.stepId,
    attempt.attempt,
    attempt.outcome,
    attempt.failure ?? null,
    attempt.startedAt,
  )
}

// ── Locks ───────────────────────────────────────────────────────────────────────

/** Takes the lock, or reports that someone else has it. The PRIMARY KEY is the exclusion. */
export function tryAcquireLock(
  store: Store,
  lock: LockName,
  runId: string,
  stepId: string,
): boolean {
  const held = store.get<{ held_by_run_id: string }>(
    'SELECT held_by_run_id FROM resource_lock WHERE name = ?',
    lock,
  )
  if (held) return held.held_by_run_id === runId
  store.run(
    'INSERT INTO resource_lock (name, held_by_run_id, held_by_step_id) VALUES (?, ?, ?)',
    lock,
    runId,
    stepId,
  )
  return true
}

/** Releases the lock only if this run is the holder — a run never drops someone else's. */
export function releaseLock(store: Store, lock: LockName, runId: string): void {
  store.run('DELETE FROM resource_lock WHERE name = ? AND held_by_run_id = ?', lock, runId)
}

export function releaseLocksHeldBy(store: Store, runId: string): LockName[] {
  const held = store
    .all<{ name: LockName }>('SELECT name FROM resource_lock WHERE held_by_run_id = ?', runId)
    .map((row) => row.name)
  store.run('DELETE FROM resource_lock WHERE held_by_run_id = ?', runId)
  return held
}

// ── Crash recovery ──────────────────────────────────────────────────────────────

/** What a boot found in flight and put right — one of these per run it reclaimed. */
export interface Reclamation {
  runId: string
  episodeId: string
  stage: string
  /** Locks the dead process was holding for this run. */
  locks: LockName[]
  /** Names of the steps whose attempt died mid-flight. */
  abandonedSteps: string[]
}

/**
 * Everything a fresh process must fix before it can be trusted, done from the database
 * alone: no process holds a lock at boot, an attempt whose process died gets an honest
 * outcome rather than a silent gap, and a run the database still calls 'running' goes back
 * in its episode's queue.
 *
 * Paused runs are left exactly where they are — an open gate survives a reboot, and it is
 * still Ryan's, not the runner's (invariant 5).
 *
 * It returns what it changed so the runner can record it in the event log. It does not
 * write those events itself: this module is the ledger, it decides nothing and publishes
 * nothing, and a boot that silently rewrote rows would leave the audit trail with a gap
 * exactly where the crash was.
 */
export function reclaimAfterCrash(store: Store): Reclamation[] {
  return store.transaction(() => {
    const interrupted = store.all<{ id: string; episode_id: string; stage: string }>(
      "SELECT id, episode_id, stage FROM run WHERE status = 'running'",
    )
    const locksOf = new Map<string, LockName[]>()
    for (const held of store.all<{ name: LockName; held_by_run_id: string }>(
      'SELECT name, held_by_run_id FROM resource_lock',
    )) {
      locksOf.set(held.held_by_run_id, [...(locksOf.get(held.held_by_run_id) ?? []), held.name])
    }
    store.run('DELETE FROM resource_lock')

    const abandonedOf = new Map<string, string[]>()
    for (const step of store.all<{
      id: string
      run_id: string
      name: string
      started_at: string | null
    }>("SELECT id, run_id, name, started_at FROM step WHERE status = 'running'")) {
      recordAttempt(store, {
        stepId: step.id,
        attempt: nextAttemptNumber(store, step.id),
        outcome: 'abandoned',
        failure: 'the process running this step died',
        startedAt: step.started_at ?? now(store),
      })
      abandonedOf.set(step.run_id, [...(abandonedOf.get(step.run_id) ?? []), step.name])
    }

    store.run(
      `UPDATE step SET status = 'pending', waiting_on = NULL
        WHERE status IN ('running','waiting-on-lock')`,
    )
    store.run("UPDATE run SET status = 'queued' WHERE status = 'running'")

    return interrupted.map((run) => ({
      runId: run.id,
      episodeId: run.episode_id,
      stage: run.stage,
      locks: locksOf.get(run.id) ?? [],
      abandonedSteps: abandonedOf.get(run.id) ?? [],
    }))
  })
}

// ── Rows ────────────────────────────────────────────────────────────────────────

/** One clock for the whole ledger — SQLite's, the same one the column defaults use. */
function now(store: Store): string {
  return store.get<{ now: string }>("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")!.now
}

interface RunRow {
  seq: number
  id: string
  episode_id: string
  stage: string
  status: RunStatus
  pause_reason: string | null
  failure: string | null
  requested_at: string
  started_at: string | null
  finished_at: string | null
}

interface StepRow {
  id: string
  run_id: string
  ordinal: number
  name: string
  lock_name: LockName | null
  status: StepStatus
  waiting_on: LockName | null
  output: string | null
  failure: string | null
  started_at: string | null
  finished_at: string | null
}

interface AttemptRow {
  seq: number
  step_id: string
  attempt: number
  outcome: AttemptOutcome
  failure: string | null
  started_at: string
  finished_at: string
}

interface LockHoldRow {
  name: LockName
  held_by_run_id: string
  acquired_at: string
  episode_id: string
  stage: string
  episode_number: number
  step_name: string
}

interface LockWaitRow {
  waiting_on: LockName
  held_by_run_id: string
  episode_id: string
  stage: string
  episode_number: number
  step_name: string
}

const hydrateRun = (row: RunRow): Run => ({
  id: row.id,
  episodeId: row.episode_id,
  stage: row.stage,
  status: row.status,
  pauseReason: row.pause_reason,
  failure: row.failure,
  requestedAt: row.requested_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
})

const hydrateStep = (row: StepRow): StepRecord => ({
  id: row.id,
  runId: row.run_id,
  ordinal: row.ordinal,
  name: row.name,
  lock: row.lock_name,
  status: row.status,
  waitingOn: row.waiting_on,
  output: row.output === null ? undefined : JSON.parse(row.output),
  failure: row.failure,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
})

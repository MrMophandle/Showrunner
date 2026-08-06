import type { Store } from './db/store.ts'

/**
 * The event log: the fourth primitive (2.2), append-only, driving the live UI over SSE and
 * standing as the audit trail.
 *
 * ── The record, never the state ─────────────────────────────────────────────────
 * `run`, `step`, and `resource_lock` are the source of truth. This module records what
 * happened to them and answers questions about it. Nothing here reconstructs a run, and
 * the runner never reads its own state back out of here — a runner that did would answer
 * to two masters, and crash-resume would eventually believe the wrong one. If you are
 * about to derive run status by replaying these rows, stop: that is event sourcing, it is
 * a large architecture nobody asked for, and the answer is no.
 *
 * ── Append-only means append-only ───────────────────────────────────────────────
 * There is no update path and no delete path in this module, and none may be added.
 * SQLite enforces it independently: `event_is_append_only_update` and
 * `event_is_append_only_delete` in 0003_event.sql abort any UPDATE or DELETE, from any
 * caller, including a future migration.
 *
 * ── Not a pub/sub framework ─────────────────────────────────────────────────────
 * One table, one in-process fan-out, one replay query. There is no topic, no subscriber
 * registry keyed by kind, no filter language, and no plugin surface. `subscribe` takes a
 * function and returns the way to stop; a subscriber that wants only some events writes
 * an `if`. One process (2.1), so this is the whole story.
 */

/**
 * Every kind of event, and the only ones the `kind` column will accept — the `event_kind`
 * table carries the same list, `kind` is a foreign key into it, and `events.test.ts`
 * asserts the two lists are identical, because two lists of twenty-one strings in
 * different places drift.
 *
 * Adding a kind is a row in `event_kind` (a one-line migration) AND a member here AND a
 * sentence something renders. It was a CHECK constraint until 0004: SQLite cannot ALTER
 * one, and `event` is the fastest-growing table in the database because it persists every
 * chunk, so widening it meant copying the whole log. The lookup table is not a seam for
 * describing kinds in data (the Archon rule) — it is the database's half of a code change.
 *
 * A const array and a union type, never a TS `enum`: the server runs its TypeScript under
 * Node's type stripping, which only erases.
 */
export const EVENT_KIND = [
  'run-queued',
  'run-started',
  'run-paused',
  'run-resumed',
  'run-done',
  'run-failed',
  'run-reclaimed',
  'step-started',
  'step-done',
  'step-attempt-failed',
  'step-failed',
  'step-paused',
  'lock-waiting',
  'lock-acquired',
  'lock-released',
  // gate transitions (E1-4). 'gate-opened' is one round being presented — round 2 is the
  // same kind, with the round in `detail`. The three verdicts are three kinds because an
  // override is an approval OVER something (invariant 3) and a log that cannot tell it
  // from a plain approval has lost the only record that Ryan overrode anything.
  'gate-opened',
  'gate-approved',
  'gate-rejected',
  'gate-overridden',
  // canon dispositions (E2-2). Three, for the same reason the gate has four: "ratified the
  // Mara proposal" WROTE CANON and "deferred the Mara proposal" wrote nothing at all, and a
  // log that cannot tell them apart has lost the only record of when canon moved. A ruling
  // convened away from a gate — the bench, the founding queue — leaves no event, because
  // `event.run_id` is NOT NULL and neither has a run; the ledger is its record.
  'proposal-ratified',
  'proposal-rejected',
  'proposal-deferred',
  'step-progress',
  'step-chunk',
] as const

export type EventKind = (typeof EVENT_KIND)[number]

/**
 * The kinds that are transitions of run, step, or lock state — everything except the two
 * kinds a step emits from inside itself. This is what the floor and the episode room
 * render; `step-progress` and `step-chunk` are the prose that scrolls past underneath.
 */
export const TRANSITION_KIND: readonly EventKind[] = EVENT_KIND.filter(
  (kind) => kind !== 'step-progress' && kind !== 'step-chunk',
)

/**
 * The complement: the two kinds a step emits from inside itself. Derived rather than
 * listed, because a third list of these strings would be a third thing to keep in step.
 */
export const PROSE_KIND: readonly EventKind[] = EVENT_KIND.filter(
  (kind) => !TRANSITION_KIND.includes(kind),
)

export interface EventRecord {
  /** Monotonic. The order of the log, and the SSE `id:` a reconnecting browser resumes from. */
  seq: number
  kind: EventKind
  runId: string
  stepId: string | null
  episodeId: string
  /** A machine-written sentence — "waiting on GPU (held by ep05)" — or null. */
  summary: string | null
  /** Parsed JSON structure, or undefined. */
  detail: unknown
  at: string
}

export interface NewEvent {
  kind: EventKind
  runId: string
  episodeId: string
  stepId?: string
  summary?: string
  detail?: unknown
}

export interface EventLog {
  /**
   * Writes the row and, in the same call, hands the written record to every subscriber.
   * Sequence assignment and fan-out happen together, single-threaded, so what a live
   * browser sees can never disagree with what a replay reads back.
   */
  append(event: NewEvent): EventRecord
  /** Adds a listener; returns the function that removes it. That is the whole API. */
  subscribe(listener: (event: EventRecord) => void): () => void
}

export function createEventLog(store: Store): EventLog {
  const listeners = new Set<(event: EventRecord) => void>()

  return {
    append(event: NewEvent): EventRecord {
      // A subscriber told about an event that a rollback then erased has been lied to,
      // and it has already put the lie on Ryan's screen. Refuse instead.
      if (store.inTransaction) {
        throw new Error(
          `cannot append the "${event.kind}" event inside an open transaction — commit ` +
            'first: subscribers are notified synchronously, and a rollback cannot un-tell them',
        )
      }

      const row = store.get<EventRow>(
        `INSERT INTO event (kind, run_id, step_id, episode_id, summary, detail)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
        event.kind,
        event.runId,
        event.stepId ?? null,
        event.episodeId,
        event.summary ?? null,
        event.detail === undefined ? null : JSON.stringify(event.detail),
      )!
      const record = hydrate(row)

      for (const listener of [...listeners]) {
        try {
          listener(record)
        } catch {
          // A dead SSE connection is a UI problem. It must never travel back up into the
          // runner and fail a step — the work is real, the browser watching it is not.
          // Swallowed on purpose: the log row is already written, which is the part that
          // matters, and a listener that throws is one the SSE handler will drop itself
          // when its own write fails.
        }
      }
      return record
    },

    subscribe(listener: (event: EventRecord) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// ── Replay ──────────────────────────────────────────────────────────────────────

/** Everything about run X, in order — prose and transitions alike. */
export function eventsOfRun(store: Store, runId: string): EventRecord[] {
  return store
    .all<EventRow>('SELECT * FROM event WHERE run_id = ? ORDER BY seq', runId)
    .map(hydrate)
}

/**
 * Run X's transitions in order, without the streamed prose — the run's story as the floor
 * tells it. Kinds are inlined from `TRANSITION_KIND` rather than passed as parameters so
 * this stays one query with one plan.
 */
export function transitionsOfRun(store: Store, runId: string): EventRecord[] {
  const placeholders = TRANSITION_KIND.map(() => '?').join(', ')
  return store
    .all<EventRow>(
      `SELECT * FROM event WHERE run_id = ? AND kind IN (${placeholders}) ORDER BY seq`,
      runId,
      ...TRANSITION_KIND,
    )
    .map(hydrate)
}

/**
 * Everything after `seq`, across every run. This is what a reconnecting browser is served
 * before it goes live again: it sends the last id it saw, and gets the gap.
 */
export function eventsSince(store: Store, seq: number): EventRecord[] {
  return store.all<EventRow>('SELECT * FROM event WHERE seq > ? ORDER BY seq', seq).map(hydrate)
}

/** The highest sequence written so far, or 0 on an empty log. */
export function latestSeq(store: Store): number {
  return store.get<{ highest: number | null }>('SELECT MAX(seq) AS highest FROM event')!.highest ?? 0
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface EventRow {
  seq: number
  kind: EventKind
  run_id: string
  step_id: string | null
  episode_id: string
  summary: string | null
  detail: string | null
  at: string
}

const hydrate = (row: EventRow): EventRecord => ({
  seq: row.seq,
  kind: row.kind,
  runId: row.run_id,
  stepId: row.step_id,
  episodeId: row.episode_id,
  summary: row.summary,
  detail: row.detail === null ? undefined : JSON.parse(row.detail),
  at: row.at,
})

import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './db/migrate.ts'
import { openStore, type Store } from './db/store.ts'
import { createShow, createSeason, createEpisode } from './domain/spine.ts'
import {
  createEventLog,
  EVENT_KIND,
  eventsOfRun,
  eventsSince,
  latestSeq,
  transitionsOfRun,
  type EventLog,
} from './events.ts'
import { recordRun } from './runner/run.ts'
import { scaffoldStage } from './runner/stage-fixture.ts'

/**
 * The event log itself: ordering, append-only, and replay.
 *
 * The stream test next door proves it end to end through the SSE endpoint with a real
 * runner behind it. This file proves the properties that make that possible.
 */

let store: Store
let log: EventLog
let runId: string
let episodeId: string

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  log = createEventLog(store)
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  episodeId = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' }).id
  runId = recordRun(store, scaffoldStage('produce', []), episodeId).id
})

/** A `NewEvent` with the boilerplate filled in — every test here is about the rest. */
function about(kind: (typeof EVENT_KIND)[number], summary?: string) {
  return { kind, runId, episodeId, summary }
}

describe('the event log — ordering', () => {
  it('assigns a strictly increasing sequence across a burst of appends', () => {
    const written = Array.from({ length: 200 }, (_, i) => log.append(about('step-chunk', `piece ${i}`)))

    expect(written.map((e) => e.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
    // Replay hands them back in exactly the order they were written.
    expect(eventsOfRun(store, runId).map((e) => e.summary)).toEqual(written.map((e) => e.summary))
  })

  it('orders by sequence, not by the clock — through equal and backwards timestamps', () => {
    // Written by hand, because the clock cannot be relied on to produce these cases on
    // demand and an intermittent ordering test is worse than none.
    //
    // Equal timestamps alone do NOT prove this: SQLite breaks a tie by rowid, so a query
    // ordering by `at` would pass anyway and the test would be theatre. The third row is
    // what makes it bite — a clock that stepped backwards between two appends, stamping a
    // later event earlier. Order by `at` and it comes back first; order by `seq` and the
    // log reads in the order it was written, which is the only order that is true.
    const written: [string, string][] = [
      ['first', '2026-08-04T12:00:00.010Z'],
      ['second', '2026-08-04T12:00:00.010Z'], // the same millisecond
      ['third', '2026-08-04T12:00:00.002Z'], // the clock stepped backwards
      ['fourth', '2026-08-04T12:00:00.010Z'],
    ]
    for (const [summary, at] of written) {
      store.run(
        'INSERT INTO event (kind, run_id, episode_id, summary, at) VALUES (?, ?, ?, ?, ?)',
        'run-started',
        runId,
        episodeId,
        summary,
        at,
      )
    }

    const inOrder = ['first', 'second', 'third', 'fourth']
    expect(eventsOfRun(store, runId).map((e) => e.summary)).toEqual(inOrder)
    expect(eventsOfRun(store, runId).map((e) => e.seq)).toEqual([1, 2, 3, 4])
    // The same for the other two replay queries — all three order the same way or the
    // stream and its replay disagree at exactly the moment someone is watching.
    expect(transitionsOfRun(store, runId).map((e) => e.summary)).toEqual(inOrder)
    expect(eventsSince(store, 0).map((e) => e.summary)).toEqual(inOrder)
  })

  it('reports the high-water mark, and 0 on an empty log', () => {
    expect(latestSeq(store)).toBe(0)
    log.append(about('run-queued'))
    const second = log.append(about('run-started'))
    expect(latestSeq(store)).toBe(second.seq)
  })
})

describe('the event log — append-only', () => {
  it('refuses an UPDATE to a written event, in the database itself', () => {
    const event = log.append(about('run-started', 'produce is running'))

    expect(() => store.run('UPDATE event SET summary = ? WHERE seq = ?', 'something else', event.seq))
      .toThrow(/append-only/)
    expect(eventsOfRun(store, runId)[0]!.summary).toBe('produce is running')
  })

  it('refuses a DELETE, including one that would empty the table', () => {
    log.append(about('run-started'))

    expect(() => store.run('DELETE FROM event WHERE run_id = ?', runId)).toThrow(/append-only/)
    expect(() => store.run('DELETE FROM event')).toThrow(/append-only/)
    expect(eventsOfRun(store, runId)).toHaveLength(1)
  })

  it('refuses to delete a run, or the episode above it, once either has history', () => {
    log.append(about('run-started'))

    // RESTRICT on event.run_id.
    expect(() => store.run('DELETE FROM run WHERE id = ?', runId)).toThrow(/FOREIGN KEY/i)

    // And the CASCADE from episode → run never gets to fire: it is outranked by the
    // RESTRICT above, so deleting an episode with history fails rather than shredding it.
    expect(() => store.run('DELETE FROM episode WHERE id = ?', episodeId)).toThrow(/FOREIGN KEY/i)
    expect(store.all('SELECT id FROM run')).toHaveLength(1)
  })

  it('refuses an append inside an open transaction, rather than tell a subscriber a lie', () => {
    const seen: string[] = []
    log.subscribe((event) => seen.push(event.kind))

    expect(() =>
      store.transaction(() => {
        log.append(about('run-started'))
      }),
    ).toThrow(/open transaction/)

    // Nothing written, and nobody told about it.
    expect(seen).toEqual([])
    expect(eventsOfRun(store, runId)).toEqual([])
  })
})

describe('the event log — subscribers', () => {
  it('hands each subscriber the written record, in sequence order', () => {
    const seen: number[] = []
    const unsubscribe = log.subscribe((event) => seen.push(event.seq))

    log.append(about('run-queued'))
    log.append(about('run-started'))
    unsubscribe()
    log.append(about('run-done'))

    expect(seen).toEqual([1, 2])
    // The one written after unsubscribing is in the log all the same.
    expect(eventsOfRun(store, runId)).toHaveLength(3)
  })

  it('keeps a throwing subscriber out of the runner', () => {
    const reached: string[] = []
    log.subscribe(() => {
      throw new Error('the browser hung up mid-write')
    })
    log.subscribe((event) => reached.push(event.kind))

    // A dead SSE connection must never travel back up and fail a step: the work is real,
    // the browser watching it is not.
    expect(() => log.append(about('step-done'))).not.toThrow()
    expect(reached).toEqual(['step-done'])
    expect(eventsOfRun(store, runId)).toHaveLength(1)
  })
})

describe('the event log — replay', () => {
  it('answers "everything about run X, in order", and its transitions alone', () => {
    const other = recordRun(store, scaffoldStage('write', []), episodeId).id

    log.append(about('run-queued'))
    log.append(about('run-started'))
    log.append({ kind: 'step-progress', runId, episodeId, summary: 'Shot 8 of 14 — scene 2, the corridor' })
    log.append({ kind: 'step-chunk', runId, episodeId, summary: 'emergency lighting dies…' })
    log.append({ kind: 'run-started', runId: other, episodeId, summary: 'a different run entirely' })
    log.append(about('run-done'))

    expect(eventsOfRun(store, runId).map((e) => [e.kind, e.summary])).toEqual([
      ['run-queued', undefined],
      ['run-started', undefined],
      ['step-progress', 'Shot 8 of 14 — scene 2, the corridor'],
      ['step-chunk', 'emergency lighting dies…'],
      ['run-done', undefined],
    ].map(([kind, summary]) => [kind, summary ?? null]))

    // The floor's version: the transitions, without the prose scrolling past underneath.
    expect(transitionsOfRun(store, runId).map((e) => e.kind)).toEqual([
      'run-queued',
      'run-started',
      'run-done',
    ])
  })

  it('answers "everything after sequence N", which is what a reconnect is served', () => {
    log.append(about('run-queued'))
    const mark = log.append(about('run-started'))
    log.append(about('step-started'))
    log.append(about('step-done'))

    expect(eventsSince(store, mark.seq).map((e) => e.kind)).toEqual(['step-started', 'step-done'])
    expect(eventsSince(store, 0)).toHaveLength(4)
    expect(eventsSince(store, latestSeq(store))).toEqual([])
  })

  it('round-trips the JSON detail the UI renders from', () => {
    log.append({
      kind: 'lock-waiting',
      runId,
      episodeId,
      summary: 'waiting on GPU (held by ep05)',
      detail: { lock: 'gpu', heldByEpisodeNumber: 5, heldByStepName: 'local-shots' },
    })

    expect(eventsOfRun(store, runId)[0]!.detail).toEqual({
      lock: 'gpu',
      heldByEpisodeNumber: 5,
      heldByStepName: 'local-shots',
    })
  })
})

describe('the event log — the two kind lists', () => {
  it('carries the same kinds in the event_kind table and the TypeScript union', () => {
    // Two lists of twenty-one strings in two places drift. This is the only thing stopping
    // them: a kind added to one and not the other fails here rather than at 2am when an
    // append hits a foreign key nobody was thinking about.
    //
    // It asks the live schema rather than parsing a migration file, because the question
    // is "what will this database accept", and the answer moves whenever a later migration
    // adds a row — which is now the ONLY way a kind is added (0004).
    const declared = store.all<{ kind: string }>('SELECT kind FROM event_kind ORDER BY kind')
      .map((row) => row.kind)

    expect(declared).toEqual([...EVENT_KIND].sort())
    expect(declared).toHaveLength(EVENT_KIND.length)
  })

  it('refuses a kind that is not one of them', () => {
    expect(() =>
      store.run(
        "INSERT INTO event (kind, run_id, episode_id) VALUES ('gate-ratified', ?, ?)",
        runId,
        episodeId,
      ),
    ).toThrow(/FOREIGN KEY/i)
  })
})

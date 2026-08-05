import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { migrate } from './db/migrate.ts'
import { openStore, type Store } from './db/store.ts'
import { createEpisode, createSeason, createShow } from './domain/spine.ts'
import { createEventLog, eventsOfRun, transitionsOfRun, type EventLog } from './events.ts'
import { libraryPaths } from './library.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { pauseRun, type StageCatalogue, type Step } from './runner/step.ts'

/**
 * The event stream, end to end: a browser opens `/api/events`, Ryan clicks, and the three
 * lines the floor and the episode room render arrive live (mockups/floor.html:267-269,
 * mockups/episode-room.html:287-289):
 *
 *   "Generating · holds image-api lock"                     ← lock-acquired
 *   "Shot 8 of 14 — scene 2, the corridor"                  ← step-progress
 *   "emergency lighting dies section by section…"           ← step-chunk, accumulating
 *   "waiting on GPU (held by ep05)"                         ← lock-waiting, with an identity
 *
 * ── About the last transition ───────────────────────────────────────────────────
 * The run ends these tests parked on a decision, and the frame that says so is
 * `run-paused`. It is NOT `gate-open`: gates are issue #5 and do not exist yet. What
 * exists today is the pause seam E1-4 will hang them off — a step throws `RunPaused`, the
 * runner persists the step and the run as paused, releases the lock, and stops. That is a
 * real transition and it is the one asserted here. When #5 lands, the gate step pauses in
 * exactly this place and adds its own event; nothing below has to be un-faked first.
 *
 * ── No sleeps ───────────────────────────────────────────────────────────────────
 * The step hangs on a deferred promise the test resolves by hand, and the only awaits are
 * `reader.read()` — which resolves when a frame actually arrives, not when a timer says it
 * probably has.
 */

const PATHS = libraryPaths(join('/tmp', 'showrunner-event-stream-test'))

let store: Store
let events: EventLog
let runner: Runner
let app: ReturnType<typeof createApp>
let ep05: string
let ep06: string
let open: StreamReader[]

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  events = createEventLog(store)
  app = createApp(PATHS, store, events)
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  ep05 = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' }).id
  ep06 = createEpisode(store, { seasonId: season.id, number: 6, title: 'Cold Ledger' }).id
  open = []
})

afterEach(async () => {
  // Every stream is closed, or the handler loops on its wake promise forever.
  for (const reader of open) await reader.close()
})

describe('the event stream — a run, live and then replayed', () => {
  it('carries a run from launch to the decision it parks on, and replays the same sequence', async () => {
    const release = deferred()
    let ruled = false
    const generate: Step = {
      name: 'generate-shot-images',
      lock: 'image-api',
      async execute(context) {
        context.progress('Shot 8 of 14 — scene 2, the corridor')
        context.chunk('emergency lighting dies section by section ')
        context.chunk('down the spine of the ship…')
        await release.promise
        if (!ruled) pauseRun('the ep05 shot gate is open — 7 images to review')
        return { generated: 14 }
      },
    }
    runner = createRunner(store, catalogue('produce', generate), events)

    const stream = await connect()
    // The open frame is written after the handler has subscribed, so reading it is what
    // makes "the browser was listening before the click" true rather than likely.
    expect(await stream.take(1)).toEqual([{ id: undefined, event: 'open', data: { since: 0 } }])

    const run = runner.enqueueRun({ episodeId: ep05, stage: 'produce' })

    // ── Live, while the step is still executing ──────────────────────────────────
    const live = await stream.take(6)
    expect(live.map((f) => [f.event, f.data.summary])).toEqual([
      ['run-queued', 'produce is queued'],
      ['run-started', 'produce is running'],
      ['lock-acquired', 'holds image-api lock'],
      ['step-started', 'generate-shot-images'],
      ['step-progress', 'Shot 8 of 14 — scene 2, the corridor'],
      ['step-chunk', 'emergency lighting dies section by section '],
    ])
    // The step has not returned: these arrived mid-flight, which is the whole point of
    // "streams, not spinners" (2.3).
    expect(store.get<{ status: string }>('SELECT status FROM run WHERE id = ?', run.id))
      .toEqual({ status: 'running' })

    // ── The rest, once the step is let go ───────────────────────────────────────
    release.resolve()
    await runner.settled(run.id)

    const rest = await stream.take(4)
    expect(rest.map((f) => [f.event, f.data.summary])).toEqual([
      ['step-chunk', 'down the spine of the ship…'],
      ['step-paused', 'generate-shot-images is waiting on Ryan'],
      // Not `gate-open` — see the header. This is the pause seam #5 hangs gates off.
      ['run-paused', 'the ep05 shot gate is open — 7 images to review'],
      ['lock-released', 'released the image-api lock'],
    ])

    // Every frame carried the sequence as its SSE id, ascending, so a browser can resume.
    const seqs = [...live, ...rest].map((f) => Number(f.id))
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs).toEqual([...live, ...rest].map((f) => f.data.seq))

    // ── The replay query reconstructs the same sequence ─────────────────────────
    expect(eventsOfRun(store, run.id).map((e) => [e.kind, e.summary])).toEqual(
      [...live, ...rest].map((f) => [f.event, f.data.summary]),
    )
    // And the floor's version of it: the transitions, without the prose underneath.
    expect(transitionsOfRun(store, run.id).map((e) => e.kind)).toEqual([
      'run-queued',
      'run-started',
      'lock-acquired',
      'step-started',
      'step-paused',
      'run-paused',
      'lock-released',
    ])
  })
})

describe('the event stream — lock contention', () => {
  it('streams who is holding the lock, not that something is blocked', async () => {
    const onEp05 = deferred()
    const onEp06 = deferred()
    runner = createRunner(
      store,
      {
        'produce-local-images': {
          name: 'produce-local-images',
          steps: [{ name: 'local-shots', lock: 'gpu', execute: () => onEp05.promise }],
        },
        'produce-audio': {
          name: 'produce-audio',
          steps: [{ name: 'tts-takes', lock: 'gpu', execute: () => onEp06.promise }],
        },
      },
      events,
    )

    const stream = await connect()
    await stream.take(1)

    runner.enqueueRun({ episodeId: ep05, stage: 'produce-local-images' })
    const blocked = runner.enqueueRun({ episodeId: ep06, stage: 'produce-audio' })

    const waiting = await stream.until((frame) => frame.event === 'lock-waiting')

    // The mockup's sentence, off the wire, carrying an identity — a boolean could not
    // have rendered it and Ryan would have had to go find out who had the GPU.
    expect(waiting.data.summary).toBe('waiting on GPU (held by ep05)')
    expect(waiting.data.runId).toBe(blocked.id)
    expect(waiting.data.detail).toMatchObject({
      lock: 'gpu',
      step: 'tts-takes',
      heldByEpisodeNumber: 5,
      heldByStepName: 'local-shots',
    })

    onEp05.resolve()
    onEp06.resolve()
  })
})

describe('the event stream — reconnect', () => {
  it('serves the gap from the last id the browser saw, then goes live again', async () => {
    const release = deferred()
    runner = createRunner(
      store,
      catalogue('produce', {
        name: 'generate-shot-images',
        async execute(context) {
          context.chunk('the corridor lights fail…')
          await release.promise
          return { generated: 14 }
        },
      }),
      events,
    )

    const first = await connect()
    await first.take(1)
    const run = runner.enqueueRun({ episodeId: ep05, stage: 'produce' })
    const seen = await first.take(4) // run-queued, run-started, step-started, step-chunk
    expect(seen.map((f) => f.event)).toEqual([
      'run-queued',
      'run-started',
      'step-started',
      'step-chunk',
    ])

    // The connection drops mid-generation, exactly where a browser's would.
    await first.close()

    // It comes back with the last id it saw. The chunk it already had is not repeated,
    // and the ones it missed are not lost — which is only possible because chunks are
    // rows in the log rather than something that happened to be in flight.
    const missed = events.append({
      kind: 'step-chunk',
      runId: run.id,
      episodeId: ep05,
      summary: 'emergency lighting dies section by section…',
    })

    const second = await connect(Number(seen.at(-1)!.id))
    expect(await second.take(1)).toEqual([
      { id: undefined, event: 'open', data: { since: Number(seen.at(-1)!.id) } },
    ])
    expect(await second.take(1)).toEqual([
      expect.objectContaining({ id: String(missed.seq), event: 'step-chunk' }),
    ])

    release.resolve()
    await runner.settled(run.id)
    const tail = await second.take(2)
    expect(tail.map((f) => f.event)).toEqual(['step-done', 'run-done'])
  })
})

// ── Test kit ────────────────────────────────────────────────────────────────────

interface Frame {
  /** The SSE `id:` — the event's sequence. Absent on the `open` control frame. */
  id: string | undefined
  event: string
  data: FrameData
}

/** Whatever the frame's JSON holds: an `EventRecord`, or `{ since }` on the open frame. */
interface FrameData {
  seq?: number
  runId?: string
  summary?: string | null
  detail?: unknown
  since?: number
}

interface StreamReader {
  /** The next `count` frames, awaiting the socket — never a timer. */
  take(count: number): Promise<Frame[]>
  /** Frames until one matches, discarding the rest. */
  until(matches: (frame: Frame) => boolean): Promise<Frame>
  close(): Promise<void>
}

async function connect(since?: number): Promise<StreamReader> {
  const controller = new AbortController()
  const res = await app.request(
    since === undefined ? '/api/events' : `/api/events?since=${since}`,
    { signal: controller.signal },
  )
  expect(res.headers.get('content-type')).toContain('text/event-stream')

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const queued: Frame[] = []
  let buffer = ''
  let closed = false

  const pump = async (): Promise<void> => {
    const { value, done } = await reader.read()
    if (done) throw new Error('the event stream ended before it had said enough')
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) if (part.trim()) queued.push(parseFrame(part))
  }

  const stream: StreamReader = {
    async take(count: number): Promise<Frame[]> {
      while (queued.length < count) await pump()
      return queued.splice(0, count)
    },
    async until(matches: (frame: Frame) => boolean): Promise<Frame> {
      for (;;) {
        const at = queued.findIndex(matches)
        if (at >= 0) return queued.splice(0, at + 1).at(-1)!
        await pump()
      }
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      controller.abort()
      await reader.cancel().catch(() => undefined)
    },
  }
  open.push(stream)
  return stream
}

function parseFrame(frame: string): Frame {
  const fields = new Map<string, string>()
  for (const line of frame.split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue // a comment line, or an empty one
    fields.set(line.slice(0, colon), line.slice(colon + 1).replace(/^ /, ''))
  }
  return {
    id: fields.get('id'),
    event: fields.get('event')!,
    data: JSON.parse(fields.get('data')!),
  }
}

function catalogue(stageName: string, ...steps: Step[]): StageCatalogue {
  return { [stageName]: { name: stageName, steps } }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = () => settle()
  })
  return { promise, resolve }
}

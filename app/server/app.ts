import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Store } from './db/store.ts'
import { eventsSince, type EventLog, type EventRecord } from './events.ts'
import type { LibraryPaths } from './library.ts'
import type { LLMReadiness } from './llm/choose.ts'
import { launchBlockedBecause, operatingView, runView } from './operating.ts'
import type { NoteDraft, Rulings } from './runner/gate.ts'
import type { Runner } from './runner/runner.ts'

const WEB_ROOT = './dist/web'

/**
 * The one app process (2.1): web UI, API, and the event stream, all here.
 *
 * ── What the API is for ─────────────────────────────────────────────────────────
 * Four verbs and three reads. Ryan launches a run, rules on a gate, and watches; the page
 * renders the sentences this process composed (operating.ts) rather than composing its
 * own. Nothing here decides anything — the runner runs, the rulings rule, and this file
 * is the wire between them and a browser.
 *
 * **Nothing runs without a click** (invariant 5): the only thing that starts a run is
 * `POST /api/run`, and the only thing that resumes one is a ruling. No GET starts work,
 * so a page load, a refresh, a health check, and a crawler are all free.
 *
 * **Preconditions before the button** (D15): the launch refuses with the exact sentence
 * the disabled button was already showing, because both come out of `launchBlockedBecause`.
 * A precondition the API enforced and the button did not show would be a failure after a
 * click, which is the thing that rule exists to forbid.
 */

/** What the API needs to operate: the two things that act, and the one that reports. */
export interface Operating {
  runner: Runner
  rulings: Rulings
  /**
   * Whether this process can reach a model right now. A function, not a value: it is
   * re-asked on every health check, so a snapshot taken at boot cannot go on claiming
   * "ready" after the thing it checked went away.
   */
  readiness: () => LLMReadiness
}

export function createApp(
  paths: LibraryPaths,
  store: Store,
  events: EventLog,
  operating: Operating,
): Hono {
  const app = new Hono()

  /**
   * Rules, then hands back the whole run as the ruling left it: resumed and moving again,
   * not finished. A ruling does not wait for the work it releases — the step is off doing
   * it before this responds — and pretending otherwise would mean an HTTP request that
   * hangs for as long as an Opus call. What happens next arrives on the event stream,
   * which is what the stream is for.
   */
  const rule = (c: Context, verdict: () => { gate: { runId: string } }) => {
    try {
      return c.json(runView(store, paths, verdict().gate.runId)!)
    } catch (error) {
      return c.json({ error: messageOf(error) }, 409)
    }
  }

  /**
   * Health, and the one question the floor's first tile exists to answer: can this reach a
   * model right now (`mockups/floor.html`, "Claude adapter — Anthropic API · connected").
   *
   * `status` is about this process, and it stays `ok` when the adapter is dead, because it
   * is: the library is mounted, the runner is running, gates rule, everything that is not
   * a model call works. The adapter's state is its own field with its own sentence, which
   * is the only way a screen can render two facts that are genuinely separate.
   */
  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      llm: operating.readiness(),
      library: {
        root: paths.root,
        databaseFile: paths.databaseFile,
        artifactDir: paths.artifactDir,
      },
    }),
  )

  /** Everything the operating page renders: shows, episodes, lifecycle, buttons, spend. */
  app.get('/api/operating', (c) => c.json(operatingView(store, paths, operating.readiness())))

  /** One run in full — its steps, its events, its spend, and the gate it is parked on. */
  app.get('/api/run/:id', (c) => {
    const view = runView(store, paths, c.req.param('id'))
    if (!view) return c.json({ error: `No such run: ${c.req.param('id')}` }, 404)
    return c.json(view)
  })

  /** Ryan's click, and the only thing in this app that starts work. */
  app.post('/api/run', async (c) => {
    const body = await json(c.req.raw)
    const episodeId = typeof body['episodeId'] === 'string' ? body['episodeId'] : ''
    const stage = typeof body['stage'] === 'string' ? body['stage'] : ''
    if (!episodeId || !stage) {
      return c.json({ error: 'A run needs an episodeId and a stage.' }, 400)
    }

    const blocked = launchBlockedBecause(store, operating.readiness(), episodeId)
    if (blocked) return c.json({ error: blocked }, 409)

    try {
      const run = operating.runner.enqueueRun({ episodeId, stage })
      return c.json({ runId: run.id }, 201)
    } catch (error) {
      return c.json({ error: messageOf(error) }, 409)
    }
  })

  /**
   * The two verdicts this page offers. Neither takes a precondition and neither may be
   * refused on the artifact's account — checks argue, they never veto (invariant 3) — so
   * the only errors either can return are "no such gate" and "that round is already
   * ruled", both of which come straight out of `createRulings`.
   */
  app.post('/api/gate/:id/approve', async (c) => {
    const body = await json(c.req.raw)
    const comment = typeof body['comment'] === 'string' ? body['comment'].trim() : ''
    return rule(c, () =>
      operating.rulings.approve(c.req.param('id'), comment === '' ? {} : { comment }),
    )
  })

  app.post('/api/gate/:id/reject', async (c) => {
    const body = await json(c.req.raw)
    const notes = notesFrom(body['notes'])
    if (notes.length === 0) {
      return c.json(
        {
          error:
            'Rejecting needs at least one note — "reject with notes" is the verb, and the ' +
            'notes are what the step reopens with.',
        },
        400,
      )
    }
    return rule(c, () => operating.rulings.reject(c.req.param('id'), { notes }))
  })

  /**
   * The live stream: every event, in sequence order, forever.
   *
   * It opens with the gap and then goes live. A browser sends the last id it saw — as
   * `Last-Event-ID` on a reconnect, which it does on its own, or as `?since=` by hand —
   * and gets everything after it before the live feed resumes. That is why the chunks are
   * persisted: a connection that drops mid-generation comes back to the line it was
   * reading rather than to a blank one, and "run state is always visible" survives a
   * dropped socket.
   *
   * Events that land *during* the replay are held and de-duplicated by `seq`, so the
   * stream has neither a gap nor a repeat at the seam.
   *
   * There is no keep-alive ping and no `?run=` filter. Nothing proxies this — the browser
   * talks to this process — and a dropped connection is already recoverable by the resume
   * path above. One user, one process: a consumer that wants one episode writes an `if`.
   */
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const asked = Number(c.req.header('Last-Event-ID') ?? c.req.query('since') ?? 0)
      const from = Number.isInteger(asked) && asked > 0 ? asked : 0

      const pending: EventRecord[] = []
      let wake: (() => void) | undefined
      let aborted = false

      const unsubscribe = events.subscribe((event) => {
        pending.push(event)
        wake?.()
      })
      stream.onAbort(() => {
        aborted = true
        wake?.()
      })

      const send = (event: EventRecord) =>
        stream.writeSSE({
          id: String(event.seq),
          event: event.kind,
          data: JSON.stringify(event),
        })

      try {
        // Sent before anything is read, so a client knows the socket is open and where it
        // resumed from. A control frame, not a log entry — it has no sequence.
        await stream.writeSSE({ event: 'open', data: JSON.stringify({ since: from }) })

        let last = from
        for (const event of eventsSince(store, from)) {
          await send(event)
          last = event.seq
        }

        while (!aborted && !stream.closed) {
          const next = pending.shift()
          if (next === undefined) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
            wake = undefined
            continue
          }
          if (next.seq <= last) continue // already sent in the replay above
          await send(next)
          last = next.seq
        }
      } finally {
        unsubscribe()
      }
    }),
  )

  // An unknown API route says so. It must never fall through to the SPA shell —
  // a 200 with a page in it reads as success to anything calling the API.
  app.all('/api/*', (c) => c.text(`No such endpoint: ${c.req.path}`, 404))

  app.use('/*', serveStatic({ root: WEB_ROOT }))
  app.get('/*', serveStatic({ path: `${WEB_ROOT}/index.html` }))

  app.notFound((c) =>
    c.text(
      'The page has not been built yet. Run `npm run build`, or `npm run dev:web` for the SPA with HMR.',
      404,
    ),
  )

  return app
}

/** A body that is absent, empty, or not JSON is an empty body, not a crash. */
async function json(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Notes as Ryan typed them. A note with no depth is legal — the unrouted default (D21). */
function notesFrom(value: unknown): NoteDraft[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): NoteDraft[] => {
    if (typeof entry === 'string') return entry.trim() === '' ? [] : [{ note: entry.trim() }]
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const note = typeof record['note'] === 'string' ? record['note'].trim() : ''
    if (note === '') return []
    return [
      {
        note,
        ...(typeof record['depth'] === 'string' && record['depth'] !== ''
          ? { depth: record['depth'] as NoteDraft['depth'] }
          : {}),
        ...(typeof record['target'] === 'string' && record['target'].trim() !== ''
          ? { target: record['target'].trim() }
          : {}),
      },
    ]
  })
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

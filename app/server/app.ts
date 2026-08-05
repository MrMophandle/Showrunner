import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Store } from './db/store.ts'
import { eventsSince, type EventLog, type EventRecord } from './events.ts'
import type { LibraryPaths } from './library.ts'

const WEB_ROOT = './dist/web'

/**
 * The one app process (2.1): web UI, API, and the event stream, all here.
 */
export function createApp(paths: LibraryPaths, store: Store, events: EventLog): Hono {
  const app = new Hono()

  app.get('/api/health', (c) =>
    c.json({
      status: 'ok',
      library: {
        root: paths.root,
        databaseFile: paths.databaseFile,
        artifactDir: paths.artifactDir,
      },
    }),
  )

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

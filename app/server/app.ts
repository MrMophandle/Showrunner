import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { LibraryPaths } from './library.ts'

const WEB_ROOT = './dist/web'

/**
 * The one app process (2.1): web UI, API, and the event stream, all here.
 * The event stream is a stub in this scaffold — E1-5 gives it the real event log.
 */
export function createApp(paths: LibraryPaths): Hono {
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

  // SSE stub: says hello, then ticks. It proves the wiring and nothing else.
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let aborted = false
      stream.onAbort(() => {
        aborted = true
      })

      await stream.writeSSE({
        event: 'hello',
        data: JSON.stringify({ message: 'Showrunner scaffold — the real event log is E1-5.' }),
      })

      let tick = 0
      while (!aborted && !stream.closed) {
        await stream.sleep(1000)
        if (aborted || stream.closed) break
        tick += 1
        await stream.writeSSE({ event: 'tick', id: String(tick), data: String(tick) })
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

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { migrate } from './db/migrate.ts'
import { openStore } from './db/store.ts'
import { createEventLog } from './events.ts'
import { libraryPaths } from './library.ts'

// No library is touched here — the app only reports the paths it was handed. The store is
// a throwaway in-memory one; what the stream actually carries is proven in
// event-stream.test.ts, with a runner behind it.
const store = openStore(':memory:')
migrate(store)
const app = createApp(libraryPaths(join('/tmp', 'showrunner-app-test')), store, createEventLog(store))

describe('the app process', () => {
  it('reports health with the library paths it will use', async () => {
    const res = await app.request('/api/health')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; library: { databaseFile: string } }
    expect(body.status).toBe('ok')
    expect(body.library.databaseFile).toMatch(/showrunner\.db$/)
  })

  it('opens the event stream saying which sequence it resumed from', async () => {
    const controller = new AbortController()
    const res = await app.request('/api/events?since=7', { signal: controller.signal })

    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    try {
      const { value } = await reader.read()
      const frame = new TextDecoder().decode(value)
      expect(frame).toContain('event: open')
      expect(frame).toContain('"since":7')
    } finally {
      controller.abort()
      await reader.cancel()
    }
  })

  it('names an unknown API endpoint instead of guessing at it', async () => {
    const res = await app.request('/api/canon')

    expect(res.status).toBe(404)
    expect(await res.text()).toContain('/api/canon')
  })
})

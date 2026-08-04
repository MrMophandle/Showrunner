import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { libraryPaths } from './library.ts'

// No library is touched here — the app only reports the paths it was handed.
const app = createApp(libraryPaths(join('/tmp', 'showrunner-app-test')))

describe('the app process', () => {
  it('reports health with the library paths it will use', async () => {
    const res = await app.request('/api/health')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; library: { databaseFile: string } }
    expect(body.status).toBe('ok')
    expect(body.library.databaseFile).toMatch(/showrunner\.db$/)
  })

  it('streams a hello event down the SSE stub', async () => {
    const controller = new AbortController()
    const res = await app.request('/api/events', { signal: controller.signal })

    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    try {
      const { value } = await reader.read()
      const chunk = new TextDecoder().decode(value)
      expect(chunk).toContain('event: hello')
      expect(chunk).toContain('E1-5')
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

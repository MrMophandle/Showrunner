import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { initLibrary } from './library.ts'

const paths = initLibrary()
const port = Number(process.env.PORT ?? 4400)

serve({ fetch: createApp(paths).fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Showrunner is on http://localhost:${info.port}`)
  console.log(`Library volume: ${paths.root}`)
})

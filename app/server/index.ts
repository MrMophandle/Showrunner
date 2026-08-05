import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createEventLog } from './events.ts'
import { initLibrary, openLibraryStore } from './library.ts'
import { chooseLLMAdapter } from './llm/choose.ts'
import { createRunner } from './runner/runner.ts'
import { STAGES } from './runner/stages.ts'

const paths = initLibrary()
const port = Number(process.env.PORT ?? 4400)

// One process, one store, held open for its lifetime (2.1). The runner reclaims on
// construction: a killed process leaves behind locks nothing holds and runs nothing is
// running, and none of the state below can be trusted until that is put right.
const store = openLibraryStore(paths)

// One log, written by the runner and served by the SSE endpoint. The same object, so a
// browser sees a transition in the same order the database recorded it.
const events = createEventLog(store)

// Named here rather than reached for from inside a step (D6). Building it is deferred to
// the first call, so a process with no credentials still boots and runs everything that
// is not a model call.
const llm = chooseLLMAdapter()
const runner = createRunner(store, STAGES, events, llm)

// Work Ryan already clicked and a crash interrupted gets picked back up. Work he has not
// clicked does not (invariant 5), and open gates stay open — they are his, not the runner's.
const resumed = runner.resumeInterrupted()

serve({ fetch: createApp(paths, store, events).fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Showrunner is on http://localhost:${info.port}`)
  console.log(`Library volume: ${paths.root}`)
  console.log(`LLM backend: ${llm.backend}`)
  console.log(
    resumed.length === 0
      ? 'Runner: nothing was left in flight.'
      : `Runner: resumed ${resumed.length} interrupted run(s) — ${resumed.map((run) => run.stage).join(', ')}`,
  )
})

import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { createEventLog } from './events.ts'
import { initLibrary, openLibraryStore } from './library.ts'
import { chooseLLMAdapter, describeLLMBackend } from './llm/choose.ts'
import { createRulings } from './runner/gate.ts'
import { createRunner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'

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
// the first call, so a process with no credentials still boots and runs everything below.
const llm = chooseLLMAdapter()
const runner = createRunner(store, stageCatalogue(paths), events, llm)
const rulings = createRulings(store, events, runner)

// Work Ryan already clicked and a crash interrupted gets picked back up. Work he has not
// clicked does not (invariant 5), and open gates stay open — they are his, not the runner's.
const resumed = runner.resumeInterrupted()

serve(
  {
    fetch: createApp(paths, store, events, {
      runner,
      rulings,
      // Re-asked per request rather than captured here: a snapshot taken at boot would go
      // on saying "ready" after the thing it checked went away.
      readiness: () => describeLLMBackend(),
    }).fetch,
    port,
    hostname: '0.0.0.0',
  },
  (info) => {
    console.log(`Showrunner is on http://localhost:${info.port}`)
    console.log(`Library volume: ${paths.root}`)

    // The backend, and whether there is anything behind it. Printed loudly on the way up
    // rather than discovered on the first model call, inside a step, mid-run — which is
    // what a container that reported `LLM backend: claude-cli` with no CLI in the image
    // did on Aug 5 2026 (issue #9).
    const backend = describeLLMBackend()
    if (backend.ready) {
      console.log(`LLM backend: ${backend.backend} — ready (${backend.chosenBy}).`)
      console.log(`  ${backend.sentence}`)
    } else {
      console.error(`!! LLM backend: ${backend.backend} — NOT READY (${backend.chosenBy}).`)
      console.error(`!! ${backend.sentence}`)
      console.error('!! Everything that is not a model call still works. /api/health says the same.')
    }

    console.log(
      resumed.length === 0
        ? 'Runner: nothing was left in flight.'
        : `Runner: resumed ${resumed.length} interrupted run(s) — ${resumed.map((run) => run.stage).join(', ')}`,
    )
  },
)

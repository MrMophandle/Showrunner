import { boot } from './boot.ts'
import { libraryPaths, libraryRoot } from './library.ts'
import { describeLLMBackend } from './llm/choose.ts'

/**
 * The process, and the order it does two things in: **bind the port, then open the library**
 * (#49). The order is the whole of this file's design and it is argued in `boot.ts`, which
 * is also where the window between the two is made honest.
 *
 * What is left here is what a boot says out loud, on its way up and on its way down.
 */

// Pure — `resolve` and `join`, nothing on disk. WHERE the volume is, computed before the
// bind; what is IN it, opened only after one (`boot.ts`).
const paths = libraryPaths(libraryRoot())
const port = Number(process.env.PORT ?? 4455)

const booted = await boot({ paths, port }).catch((error: unknown) => {
  // The sentence, not a stack. `exitCode` rather than `process.exit`, so what was just
  // written reaches the terminal (or the parent's pipe) before the process goes.
  console.error(`!! ${messageOf(error)}`)
  process.exitCode = 1
  return undefined
})

if (booted) {
  try {
    const { resumed } = await booted.serving

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
      console.error(
        '!! Everything that is not a model call still works. /api/health says the same.',
      )
    }

    console.log(
      resumed.length === 0
        ? 'Runner: nothing was left in flight.'
        : `Runner: resumed ${resumed.length} interrupted run(s) — ${resumed.map((run) => run.stage).join(', ')}`,
    )

    // Last, and only once it is true: everything above happened while the port was held and
    // every route but health was refusing in words.
    console.log(`Showrunner is serving on http://localhost:${booted.port}`)
  } catch (error) {
    // The window's own failure: the port was ours, and what happens behind it was not. It
    // is let go rather than held by a process that will never serve over it, and the error
    // is printed whole — a migration that will not apply is a bug, not an operating
    // condition, and the sentence treatment above would be hiding a stack somebody needs.
    console.error('!! Showrunner took the port and then could not come up. It has let it go.')
    console.error(error)
    await booted.stop()
    process.exitCode = 1
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

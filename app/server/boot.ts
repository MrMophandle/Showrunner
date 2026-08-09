import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import type { Server } from 'node:http'
import { setImmediate as yieldToTheLoop } from 'node:timers/promises'
import { createApp } from './app.ts'
import type { Store } from './db/store.ts'
import { createEventLog } from './events.ts'
import {
  migrateLibrary as migrateTheLibrary,
  openLibraryForBoot,
  type LibraryPaths,
} from './library.ts'
import { chooseLLMAdapter, describeLLMBackend } from './llm/choose.ts'
import { createRulings } from './runner/gate.ts'
import type { Run } from './runner/run.ts'
import { createRunner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'

/**
 * Boot order, and why it is this one.
 *
 * **The incident (#49, E3-0).** A stray `npm start` with no `LIBRARY_DIR` raced the
 * container for :4455. It migrated Ryan's real `./library` to 0010 and *then* failed to
 * bind — a process that was always going to lose the port had already written to the
 * volume on its way down. Nothing moved in the end, but the hazard was the order:
 * migrate first, listen second.
 *
 * So the order is inverted here. **Bind the port, then open the library.** A collision is
 * now discovered before `showrunner.db` has been opened, created, or migrated, and a boot
 * that loses the race costs nothing at all — no rows, no file, no directory.
 *
 * ── The window that buys ────────────────────────────────────────────────────────
 * Between the bind and the migration there is a window in which the port is held and the
 * database is not ready. This module is that window made honest:
 *
 *   · `/api/health` answers `starting — migrating N → M` at **503** for as long as it is
 *     true, and `ok` at 200 once it is serving. It never renders a state it is not in
 *     (invariant 4), and the compose healthcheck reads `r.ok`, so "healthy" goes on
 *     meaning "serving" without compose having to learn a new word for it.
 *   · **Every other route refuses, in words.** Not a 500 from a route reading tables that
 *     do not exist yet, and not an answer computed over a half-migrated schema — a 503
 *     carrying the same sentence health is carrying.
 *
 * **Refused, not held.** A held request is an open socket with nothing behind it, which a
 * browser cannot tell apart from a hang; a refusal with `Retry-After` lets the page say
 * what is happening and ask again. Nothing refused here is a write, either, so refusing
 * loses nothing — every one of them is Ryan's click, and a click can be made again. The
 * migration itself is synchronous SQLite and holds the event loop while it runs, so a
 * request that lands mid-migration is answered when it ends, by which time `ok` is the
 * truth; the yields below are what keep a request that arrived *before* it from being
 * held behind it.
 */

/** Where the boot is, in its own words. */
type BootPhase = { kind: 'opening' } | { kind: 'migrating'; from: number; to: number }

export interface BootOptions {
  paths: LibraryPaths
  /** 0 lets the OS choose — `boot` reports back the one it got. */
  port: number
  hostname?: string
  /** Where the boot's account of itself goes. */
  say?: (line: string) => void
  /**
   * How the library is brought to this build's schema — the real thing by default.
   *
   * A parameter for one reason. The window above is microseconds wide by design, and the
   * only honest way to prove from OUTSIDE this process that `/api/health` reports
   * `starting — migrating N → M` *while it is happening* is to hold it open. `boot.test.ts`
   * passes a version that waits. Nothing in the app ever passes anything.
   */
  migrateLibrary?: (store: Store, paths: LibraryPaths) => void | Promise<void>
}

/** What the process has once it is actually serving. */
export interface Serving {
  store: Store
  /** Runs a killed process left behind, back in flight. */
  resumed: Run[]
}

export interface Booted {
  /** The port actually bound. */
  port: number
  /** Resolves when the process is serving; rejects if the boot failed after the bind. */
  serving: Promise<Serving>
  stop(): Promise<void>
}

/**
 * Binds the port, then brings the library up behind it. Resolves as soon as the port is
 * held — **rejects, having touched nothing, if it is not**.
 */
export async function boot(options: BootOptions): Promise<Booted> {
  const { paths, port, hostname = '0.0.0.0' } = options
  const say = options.say ?? ((line: string) => console.log(line))
  const migrate = options.migrateLibrary ?? migrateTheLibrary

  let phase: BootPhase = { kind: 'opening' }
  /** The real app, once there is a database under it. Until then, the gate below answers. */
  let live: Hono | undefined
  let opened: Store | undefined

  const gate = new Hono()

  // Health is the one thing that answers during the window, and it answers with the window:
  // 503, because the container's healthcheck asks "are you serving" and the answer is no.
  // Docker's own word for a container in its start period is "starting", which is the word
  // used here on purpose.
  gate.get('/api/health', (c) =>
    c.json(
      {
        status: 'starting',
        sentence: sentenceOf(phase),
        ...(phase.kind === 'migrating' && { migrating: { from: phase.from, to: phase.to } }),
        library: {
          root: paths.root,
          databaseFile: paths.databaseFile,
          artifactDir: paths.artifactDir,
        },
      },
      503,
      { 'Retry-After': '1' },
    ),
  )

  // Everything else refuses in the same sentence — an API route in the shape every other
  // refusal in this app takes (`{ error }`), a page in plain words. The SPA shell is refused
  // too: a page that loaded and then watched every one of its own calls fail would be a
  // worse account of "starting" than one line saying it.
  gate.all('/api/*', (c) => c.json({ error: refusalOf(phase) }, 503, { 'Retry-After': '1' }))
  gate.all('*', (c) => c.text(refusalOf(phase), 503, { 'Retry-After': '1' }))

  const server = await bindPort(
    (request, env) => (live ?? gate).fetch(request, env),
    { port, hostname },
    paths,
  )
  const boundPort = addressOf(server, port)

  say(`Showrunner has the port: http://localhost:${boundPort} — starting.`)
  say(`Library volume: ${paths.root}`)

  const serving = (async (): Promise<Serving> => {
    // Before the file is so much as opened: a request that arrived in the accept backlog
    // during the bind is answered here, honestly, rather than waiting behind SQLite.
    await yieldToTheLoop()

    const standing = openLibraryForBoot(paths)
    opened = standing.store
    if (standing.from < standing.to) {
      phase = { kind: 'migrating', from: standing.from, to: standing.to }
      say(`Library schema: migrating ${standing.from} → ${standing.to}.`)
      await yieldToTheLoop()
    }
    await migrate(standing.store, paths)

    // One log, written by the runner and served by the SSE endpoint. The same object, so a
    // browser sees a transition in the same order the database recorded it.
    const events = createEventLog(standing.store)

    // Named here rather than reached for from inside a step (D6). Building it is deferred to
    // the first call, so a process with no credentials still boots and runs everything below.
    const llm = chooseLLMAdapter()

    // ── Where reclaim sits, and why ───────────────────────────────────────────────
    // `createRunner` reclaims on construction: a killed process leaves locks nothing holds
    // and runs nothing is running. That is **after** the migration, because the rows it
    // rewrites live in tables the migration may only just have added — and **before
    // anything is served**, because a page rendered over unreclaimed state would say
    // "waiting on GPU (held by ep05)" about a lock no process on this machine holds, and a
    // launch would be refused by a precondition computed from a run that died yesterday.
    // The port is bound through all of it; what waits is the serving, never the bind.
    const runner = createRunner(standing.store, stageCatalogue(paths), events, llm)
    const rulings = createRulings(standing.store, events, runner)

    // Work Ryan already clicked and a crash interrupted gets picked back up. Work he has not
    // clicked does not (invariant 5), and open gates stay open — they are his, not the
    // runner's. Also before the flip, so the first request this process ever answers is
    // answered over a world that is true: reclaimed, re-queued, and moving again.
    const resumed = runner.resumeInterrupted()

    live = createApp(paths, standing.store, events, {
      runner,
      rulings,
      // The same adapter the runner binds to its steps (D6). E3-5's remediations spend
      // outside a run and have no step to be bound to; they build their own call site.
      llm,
      // Re-asked per request rather than captured here: a snapshot taken at boot would go
      // on saying "ready" after the thing it checked went away.
      readiness: () => describeLLMBackend(),
    })

    return { store: standing.store, resumed }
  })()

  // Marked handled here so a boot that fails behind the bind is reported by whoever awaited
  // it — `index.ts` does — rather than as an unhandled rejection with a stack in it.
  serving.catch(() => {})

  return {
    port: boundPort,
    serving,
    async stop() {
      // Keep-alive connections would hold `close` open until they time out, so they are cut
      // rather than waited on: this is a shutdown, and there is nothing left to serve.
      ;(server as Server).closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      opened?.close()
    },
  }
}

/** `starting — migrating 3 → 12`, and the one word it says before it knows the numbers. */
function sentenceOf(phase: BootPhase): string {
  return phase.kind === 'opening'
    ? 'starting — opening the library'
    : `starting — migrating ${phase.from} → ${phase.to}`
}

function refusalOf(phase: BootPhase): string {
  return (
    `Showrunner is ${sentenceOf(phase)}. Nothing but /api/health is served until the ` +
    'database is at the schema this build expects — nothing was lost, try again in a moment.'
  )
}

/**
 * The bind, as a promise that keeps its word: it resolves when the port is HELD, and
 * rejects when it is not. `EADDRINUSE` arrives asynchronously — the server object exists,
 * `listen` has been called, and the failure lands an event loop turn later — which is
 * exactly why the library must not be opened on the strength of `serve()` having returned.
 */
function bindPort(
  fetch: (request: Request, env: unknown) => Response | Promise<Response>,
  where: { port: number; hostname: string },
  paths: LibraryPaths,
): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    let bound = false
    const server = serve({ fetch, port: where.port, hostname: where.hostname }, () => {
      bound = true
      resolve(server)
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (bound) {
        console.error(`!! The server errored: ${error.message}`)
        return
      }
      // Released explicitly: a handle left open would keep a process that has already
      // failed from ever exiting, and the exit code is how a boot reports this.
      server.close(() => {})
      reject(new Error(bindFailureSentence(error, where.port, paths)))
    })
  })
}

/**
 * What a lost bind says. A sentence, not a stack: a taken port is an operating condition,
 * and what it needs to say is which port, who is likely holding it, and — the whole point
 * of #49 — that the volume was not touched.
 */
function bindFailureSentence(
  error: NodeJS.ErrnoException,
  port: number,
  paths: LibraryPaths,
): string {
  const untouched =
    `Nothing was opened, migrated, or created: the library at ${paths.root} is exactly ` +
    'as it was.'
  if (error.code !== 'EADDRINUSE') {
    return `Showrunner could not bind port ${port}: ${error.message}\n${untouched}`
  }
  return (
    `Showrunner did not start: port ${port} is already taken.\n${untouched}\n` +
    'Something else is already serving it — `docker compose ps` first, because the ' +
    `container publishes the app's port, then \`lsof -i :${port}\`.`
  )
}

/** The port actually bound, which is news only when 0 was asked for. */
function addressOf(server: ServerType, asked: number): number {
  const address = server.address()
  return address !== null && typeof address === 'object' ? address.port : asked
}

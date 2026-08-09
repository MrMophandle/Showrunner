import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA, libraryBehindSchema, schemaOf } from './boot-fixture.ts'
import type { Store } from './db/store.ts'
import { artifactsOf } from './domain/artifact.ts'
import { recordExtractedBoard } from './domain/board.ts'
import { episodesOf, scenesOf, seasonsOf } from './domain/spine.ts'
import { eventsSince } from './events.ts'
import { loadFixture } from './fixture/load.ts'
import { initLibrary, libraryPaths, openLibraryStore, type LibraryPaths } from './library.ts'
import { BOARD_CHECK_STAGE } from './runner/board-step.ts'
import {
  attemptsOf,
  beginStepAttempt,
  findRun,
  markRunRunning,
  recordRun,
  stepsOf,
  tryAcquireLock,
  type Run,
} from './runner/run.ts'
import { stageCatalogue } from './runner/stages.ts'

/**
 * The entry point, spawned — because the thing under test is what `app/server/index.ts`
 * does in what order, and an order can only be proved by the process that keeps it.
 *
 * **The incident this is here for (#49).** A stray `npm start` with no `LIBRARY_DIR` raced
 * the container for :4455, migrated Ryan's real `./library`, and only then failed to bind.
 * So the first two tests below are the fix stated as a cost: a boot that loses the port
 * writes nothing, and — on a library that does not exist yet — creates nothing either.
 *
 * **Every process here is pointed at scratch.** A temp `LIBRARY_DIR` per test, a port the
 * OS chose (`PORT=0`) or one this file is deliberately squatting on, and an LLM backend
 * with nothing behind it, so no test can reach a model even if a resumed run tried to.
 */

/** A spawned entry point: no stdin, both output streams piped back here. */
type Process = ChildProcessByStdio<null, Readable, Readable>

const ENTRY_POINT = join(import.meta.dirname, 'index.ts')

/** A library an older build left behind: applied through 3, and nothing since. */
const BEHIND = 3

/**
 * Every test here spawns Node and waits for it to boot, which on a loaded machine is
 * seconds rather than the tenths it takes on an idle one — and a durability test that goes
 * red on a busy laptop is the worst kind, because the suite starts being re-run until it is
 * green. Generous, like `crash.test.ts` next door: nothing here waits on a clock, so a long
 * ceiling costs nothing and only ever catches a real hang.
 */
const SPAWNING = 60_000

let root: string
let children: Process[]
let squatters: Server[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-entry-'))
  children = []
  squatters = []
})

afterEach(() => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  for (const squatter of squatters) squatter.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the entry point — losing the port', () => {
  it('exits nonzero without migrating a library that is behind the schema', async () => {
    libraryBehindSchema(root, BEHIND)
    const ledger = ledgerOf(root)
    const port = await squat()

    const doomed = spawnEntryPoint(port)

    expect(await exitOf(doomed)).toEqual({ code: 1, signal: null })

    // The sentence, and what a taken port needs to say: which port, that the volume is
    // untouched, and where to look for whoever has it. Not a stack — a stack is what the
    // incident's process printed while the damage was already done.
    const said = transcriptOf(doomed).err
    expect(said).toContain(`Showrunner did not start: port ${port} is already taken.`)
    expect(said).toContain(`the library at ${root} is exactly as it was`)
    expect(said).toContain(`lsof -i :${port}`)
    expect(said).not.toContain('at Server.')
    expect(said).not.toContain('EADDRINUSE')

    // The done condition of #49: `schema_migration` untouched, row for row and stamp for
    // stamp. A boot that was always going to lose the port did not move the library on.
    expect(ledgerOf(root)).toEqual(ledger)
    expect(schemaOf(root)).toBe(BEHIND)
  }, SPAWNING)

  it('creates no library at all when there was none to begin with', async () => {
    const port = await squat()

    const doomed = spawnEntryPoint(port)

    expect(await exitOf(doomed)).toEqual({ code: 1, signal: null })
    // Not "wrote nothing" — made nothing. `showrunner.db` exists the instant the file is
    // opened, so the proof that the bind comes first is an empty directory.
    expect(readdirSync(root)).toEqual([])
  }, SPAWNING)
})

describe('the entry point — coming up', () => {
  it('binds the port, then migrates, then serves — and says so in that order', async () => {
    libraryBehindSchema(root, BEHIND)

    const app = spawnEntryPoint(0)
    const bound = await lineFrom(app, /^Showrunner has the port/)
    const port = portOf(bound)
    const migrating = await lineFrom(app, /^Library schema/)
    await lineFrom(app, /^Showrunner is serving/)

    // The order, in the process's own account of itself: it had the port before it had
    // read a single row, and it said so before it moved the schema.
    expect(bound).toBe(`Showrunner has the port: http://localhost:${port} — starting.`)
    expect(migrating).toBe(`Library schema: migrating ${BEHIND} → ${CURRENT_SCHEMA}.`)
    expect(transcriptOf(app).out.indexOf(bound)).toBeLessThan(
      transcriptOf(app).out.indexOf(migrating),
    )

    const health = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok', library: { root } })
    expect(schemaOf(root)).toBe(CURRENT_SCHEMA)
  }, SPAWNING)
})

describe('the entry point — the E1 drill, kill and restart', () => {
  it('reclaims what a killed process left, resumes it, and serves over a world that is true', async () => {
    seedCrashedRun(root)

    // ── A process that has only ever seen the database ──────────────────────────
    const first = spawnEntryPoint(0)
    const port = portOf(await lineFrom(first, /^Showrunner has/))
    const resumed = await lineFrom(first, /^Runner: /)
    await lineFrom(first, /^Showrunner is serving/)

    expect(resumed).toBe(`Runner: resumed 1 interrupted run(s) — ${BOARD_CHECK_STAGE}`)

    // What reclaim made of the leavings, unattended, on the way up: the lock the dead
    // process held is gone, the attempt it died in is recorded as abandoned rather than
    // failed — that was not the step's doing, so it did not spend the retry budget — and
    // the run finished on the second attempt. That none of it was visible to a request
    // before it was true is the gate's doing, held open and asked in `boot.test.ts`.
    const after = await settled(root, port)
    expect(after.locks).toEqual([])
    expect(after.run.status).toBe('done')
    expect(after.attempts).toEqual([
      [1, 'abandoned'],
      [2, 'succeeded'],
    ])
    expect(after.reclaimed).toBe(
      `${BOARD_CHECK_STAGE} died inside run-the-board-rules — back in its episode's queue`,
    )

    const health = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(health.status).toBe(200)

    // ── The drill's step: kill it, start it again ───────────────────────────────
    first.kill('SIGKILL')
    expect(await exitOf(first)).toEqual({ code: null, signal: 'SIGKILL' })

    const second = spawnEntryPoint(0)
    const secondPort = portOf(await lineFrom(second, /^Showrunner has/))
    await lineFrom(second, /^Showrunner is serving/)

    // Nothing was in flight this time, and the second process says so rather than
    // re-running work that had already finished.
    expect(transcriptOf(second).out).toContain('Runner: nothing was left in flight.')
    expect((await fetch(`http://127.0.0.1:${secondPort}/api/health`)).status).toBe(200)
    expect(readLibrary(root, runsIn)).toHaveLength(1)
  }, SPAWNING)
})

// ── Test kit ────────────────────────────────────────────────────────────────────

/**
 * The real entry point, on a scratch library and a port that is either the OS's choice
 * (`0`) or one this file is holding against it.
 *
 * The environment is curated rather than inherited: `LIBRARY_DIR` points at scratch — the
 * standing rule this issue exists to enforce — and the LLM backend is named with no key
 * behind it, so a resumed run that reached for a model would fail rather than spend. The
 * stage the drill resumes below is a free one, and this is the second lock on that door.
 */
function spawnEntryPoint(port: number): Process {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', ENTRY_POINT],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LIBRARY_DIR: root,
        PORT: String(port),
        SHOWRUNNER_LLM_BACKEND: 'anthropic-api',
        ANTHROPIC_API_KEY: '',
      },
    },
  )
  const transcript: Transcript = { out: '', err: '', waiters: new Set() }
  heard.set(child, transcript)

  const wake = (): void => {
    for (const waiter of [...transcript.waiters]) waiter()
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    transcript.out += chunk
    wake()
  })
  child.stderr.on('data', (chunk: string) => {
    transcript.err += chunk
    wake()
  })
  // 'close' rather than 'exit': it fires once the streams are drained, so a line the
  // process wrote on its way out is in hand before anything gives up on it.
  child.once('close', wake)

  children.push(child)
  return child
}

/**
 * Everything a process has said, kept from the moment it was spawned rather than from the
 * moment something asked — the boot says four things in a row and this file waits for them
 * one at a time, so a buffer that started at the first wait would miss the rest.
 */
const heard = new WeakMap<Process, Transcript>()

interface Transcript {
  out: string
  err: string
  waiters: Set<() => void>
}

const transcriptOf = (child: Process): Transcript => heard.get(child)!

/** The first stdout line matching `want` — including one the process has already said. */
function lineFrom(child: Process, want: RegExp): Promise<string> {
  const transcript = transcriptOf(child)
  return new Promise((resolve, reject) => {
    const look = (): void => {
      const found = transcript.out.split('\n').find((line) => want.test(line))
      if (found !== undefined) {
        transcript.waiters.delete(look)
        resolve(found)
        return
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        transcript.waiters.delete(look)
        reject(
          new Error(
            `the process exited before saying ${String(want)}\n${transcript.out}\n${transcript.err}`,
          ),
        )
      }
    }
    transcript.waiters.add(look)
    look()
  })
}

/** The port out of the line the boot prints the moment it has one. */
const portOf = (line: string): number => Number(/http:\/\/localhost:(\d+)/.exec(line)![1])

function exitOf(child: Process): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
}

/** Something else already on the port, holding it for as long as the test runs. */
function squat(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    squatters.push(server)
    server.listen(0, '0.0.0.0', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}

/**
 * What a killed process leaves behind: the run still says running, the step it died in
 * still says running, and the lock it took is still held by a process that no longer
 * exists. Written with the runner's own primitives, and it is exactly the state
 * `crash.test.ts` produces with a real `kill -9` — that test proves the leavings, this one
 * asks what the ENTRY POINT does with them on the way up.
 *
 * The stage is the free one on purpose (`continuity-board-checks` re-runs deterministic
 * rules over rows an extraction already wrote): a drill that resumed a paid stage would
 * spend Ryan's money every time the suite ran.
 */
function seedCrashedRun(root: string): void {
  const paths = initLibrary(root)
  const store = openLibraryStore(paths)
  try {
    loadFixture(store, paths)
    const show = store.get<{ id: string }>("SELECT id FROM show WHERE key = 'greyharbor'")!
    const ep01 = episodesOf(store, seasonsOf(store, show.id)[0]!.id).find((e) => e.number === 1)!.id

    // The rules read a board, so there is one — built the way the extraction writes it,
    // without a model. Flat and inside: what is under test is the boot, not the rules.
    const script = artifactsOf(store, ep01).find((artifact) => artifact.kind === 'script')!
    recordExtractedBoard(store, {
      episodeId: ep01,
      scriptId: script.id,
      extraction: {
        scenes: scenesOf(store, ep01).map((scene) => ({
          scene: scene.ordinal,
          location: scene.heading,
          environment: 'inside' as const,
          elapsed: '',
          elapsedSeconds: null,
          present: [],
        })),
        transits: [],
        hazards: [],
      },
      filePath: 'greyharbor/s01e01/continuity-board-v1.md',
    })

    const stage = stageCatalogue(paths)[BOARD_CHECK_STAGE]!
    const run = recordRun(store, stage, ep01)
    markRunRunning(store, run.id)
    const step = stepsOf(store, run.id)[0]!
    beginStepAttempt(store, step.id)
    tryAcquireLock(store, 'gpu', run.id, step.id)
  } finally {
    store.close()
  }
}

interface Settled {
  run: Run
  attempts: [number, string][]
  locks: unknown[]
  reclaimed: string | null | undefined
}

/**
 * Waits for the resumed run on the process's OWN event stream — the one the floor watches —
 * and then reads the library once it has landed. No timer anywhere: the wait ends because
 * the process said `run-done`, and `?since=0` means a run that finished before this
 * connected is still in the replay rather than a race this file would lose.
 */
async function settled(root: string, port: number): Promise<Settled> {
  // Either verdict ends the wait: a run that failed is a real answer, and waiting only for
  // `run-done` would report it as a timeout rather than as what it was.
  await eventFrom(port, /^event: run-(done|failed)$/m)
  return readLibrary(root, (store): Settled => {
    const run = runsIn(store)[0]!
    return {
      run,
      attempts: attemptsOf(store, stepsOf(store, run.id)[0]!.id).map((a) => [a.attempt, a.outcome]),
      locks: store.all('SELECT * FROM resource_lock'),
      reclaimed: eventsSince(store, 0).find((event) => event.kind === 'run-reclaimed')?.summary,
    }
  })
}

/** Reads the SSE stream until a frame matching `want` arrives. */
async function eventFrom(port: number, want: RegExp): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/events?since=0`)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let stream = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`the stream closed before ${String(want)}:\n${stream}`)
      stream += decoder.decode(value, { stream: true })
      if (want.test(stream)) return
    }
  } finally {
    await reader.cancel()
  }
}

function runsIn(store: Store): Run[] {
  return store
    .all<{ id: string }>('SELECT id FROM run ORDER BY seq')
    .map((row) => findRun(store, row.id)!)
}

/** The ledger rows, exactly as they stand — the thing #49 says a lost bind must not move. */
function ledgerOf(root: string): unknown[] {
  return readLibrary(root, (store) =>
    store.all('SELECT number, name, applied_at FROM schema_migration ORDER BY number'),
  )
}

/** Opens the library on disk, reads one answer out, and closes. */
function readLibrary<T>(root: string, read: (store: Store) => T): T {
  const store = openLibraryStore(libraryPaths(root))
  try {
    return read(store)
  } finally {
    store.close()
  }
}

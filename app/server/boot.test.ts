import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, type Booted } from './boot.ts'
import { CURRENT_SCHEMA, libraryBehindSchema, schemaOf } from './boot-fixture.ts'
import { initLibrary, libraryPaths, migrateLibrary, type LibraryPaths } from './library.ts'

/**
 * The window between the bind and the migration, and the two things that make it honest:
 * `/api/health` reporting `starting — migrating N → M` while it is true, and every other
 * route refusing in words rather than reading tables that are not there yet (#49, boot.ts).
 *
 * The window is microseconds wide in a real boot, which is the point of it — so this file
 * holds it open, through the one parameter `boot` takes for the purpose, and asks the
 * process the questions a browser and a healthcheck would ask while it stands there. The
 * port is a real port and the requests are real HTTP. The entry point itself is
 * `index.test.ts` next door, where a lost bind is proved to cost nothing.
 */

/** A library an older build left behind: applied through 3, and nothing since. */
const BEHIND = 3

let root: string
let paths: LibraryPaths
let booted: Booted | undefined
let squatters: Server[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-boot-'))
  paths = libraryPaths(root)
  squatters = []
})

afterEach(async () => {
  await booted?.stop()
  booted = undefined
  for (const squatter of squatters) squatter.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the boot — the window between the bind and the migration', () => {
  it('reports the migration on /api/health, refuses everything else in words, then serves', async () => {
    libraryBehindSchema(root, BEHIND)
    const held = await bootHeldAtTheMigration()

    // ── Health, in the state the process is actually in (invariant 4) ───────────
    const starting = await ask('/api/health')
    expect(starting.status).toBe(503)
    expect(starting.body).toMatchObject({
      status: 'starting',
      sentence: `starting — migrating ${BEHIND} → ${CURRENT_SCHEMA}`,
      migrating: { from: BEHIND, to: CURRENT_SCHEMA },
      library: { root: paths.root, databaseFile: paths.databaseFile },
    })
    // 503, because the compose healthcheck asks `r.ok` and the answer is genuinely no: the
    // port is held, and nothing is being served over it yet.
    expect(starting.headers.get('retry-after')).toBe('1')

    // ── And every other route, refusing in the same sentence ────────────────────
    // Not a 500 out of a route reading `episode` before 0001 has been applied, and not an
    // answer computed over a half-migrated schema.
    const refused = await ask('/api/operating')
    expect(refused.status).toBe(503)
    expect(refused.body).toEqual({
      error:
        `Showrunner is starting — migrating ${BEHIND} → ${CURRENT_SCHEMA}. Nothing but ` +
        '/api/health is served until the database is at the schema this build expects — ' +
        'nothing was lost, try again in a moment.',
    })

    // The click that starts work is refused the same way, and refusing it costs nothing:
    // it is a click, and a click can be made again (invariant 5).
    const launch = await ask('/api/run', { method: 'POST', body: '{}' })
    expect(launch.status).toBe(503)
    expect(launch.body).toMatchObject({ error: expect.stringContaining('starting — migrating') })

    // The page too. A shell that loaded and then watched every one of its own calls fail
    // would be a worse account of "starting" than one line saying it.
    const page = await ask('/')
    expect(page.status).toBe(503)
    expect(page.text).toContain(`starting — migrating ${BEHIND} → ${CURRENT_SCHEMA}`)

    // Nothing was served, and nothing was migrated either — the file is still where the
    // older build left it while the sentence above is being told.
    expect(schemaOf(root)).toBe(BEHIND)

    // ── Released: the migration runs, and the process starts serving ────────────
    held.resolve()
    await booted!.serving

    const ok = await ask('/api/health')
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ status: 'ok', library: { root: paths.root } })

    // The route refused a moment ago answers, over a schema that is now whole.
    expect((await ask('/api/operating')).status).toBe(200)
    expect(schemaOf(root)).toBe(CURRENT_SCHEMA)
  })

  it('says `opening` before it knows the numbers, and claims no migration it is not doing', async () => {
    // A library already at this build's schema. There is no `N → M` to report, and saying
    // `12 → 12` would be a state the process is not in.
    initLibrary(root)
    const held = await bootHeldAtTheMigration()

    const starting = await ask('/api/health')
    expect(starting.status).toBe(503)
    expect(starting.body).toMatchObject({
      status: 'starting',
      sentence: 'starting — opening the library',
    })
    expect(starting.body).not.toHaveProperty('migrating')

    held.resolve()
    await booted!.serving
    expect((await ask('/api/health')).status).toBe(200)
  })

  it('refuses a port it cannot have, and opens nothing at all doing it', async () => {
    const port = await squat()

    await expect(boot({ paths, port, say: () => {} })).rejects.toThrow(
      `Showrunner did not start: port ${port} is already taken.`,
    )

    // The whole of #49 in one assertion: a boot that was always going to lose the port did
    // not create the library on its way down. No `showrunner.db`, no `artifact/`, nothing.
    expect(readdirSync(root)).toEqual([])
  })
})

// ── Test kit ────────────────────────────────────────────────────────────────────

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

/**
 * Boots on a real port and stops at the moment before the migration — where a real boot
 * spends microseconds, and where every question above is asked. Resolves once it is
 * standing there; releasing the returned latch lets it carry on.
 */
async function bootHeldAtTheMigration(): Promise<Deferred> {
  const standing = deferred()
  const held = deferred()
  booted = await boot({
    paths,
    port: 0,
    say: () => {},
    migrateLibrary: async (store, where) => {
      standing.resolve()
      await held.promise
      migrateLibrary(store, where)
    },
  })
  await standing.promise
  return held
}

interface Answer {
  status: number
  headers: Headers
  text: string
  body: unknown
}

/** A real request over a real socket to the port the boot actually bound. */
async function ask(path: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${booted!.port}${path}`, init)
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: response.status, headers: response.headers, text, body }
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

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

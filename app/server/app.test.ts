import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import type { Store } from './db/store.ts'
import { episodesOf, seasonsOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { loadFixture } from './fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import type { RunView } from './operating.ts'
import { createRulings, openGates } from './runner/gate.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { DEMO_STAGE, stageCatalogue } from './runner/stages.ts'

/**
 * The API the operating page talks to, end to end: Ryan clicks, a run starts, a gate
 * opens, he rules, the run finishes.
 *
 * A real library volume in a temp directory, the Grey Harbor fixture in it, the real
 * runner and the real gate primitive behind it — and the fake backend in front of the
 * model, because no test in this repo may spend a cent.
 *
 * What it is chiefly here to hold is the seam between the disabled button and the refusal:
 * both come out of `launchBlockedBecause`, and if they ever drift, a precondition becomes
 * a failure after a click, which is the thing D15 forbids.
 */

/** A process with a key: something to call. */
const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
/** The container as it booted on Aug 5 2026: no key, no CLI, nothing behind the adapter. */
const NOTHING: LLMReadiness = describeLLMBackend({ PATH: '' })

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let app: ReturnType<typeof createApp>
let readiness: LLMReadiness
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-api-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  loadFixture(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  readiness = READY
  // A function, not a value: what the process can reach is re-asked on every request.
  app = createApp(paths, store, events, {
    runner,
    rulings: createRulings(store, events, runner),
    readiness: () => readiness,
  })

  const show = store.get<{ id: string }>("SELECT id FROM show WHERE key = 'greyharbor'")!
  ep02 = episodesOf(store, seasonsOf(store, show.id)[0]!.id).find((e) => e.number === 2)!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the app process — health', () => {
  it('reports the library paths it will use', async () => {
    const body = await get<{ status: string; library: { databaseFile: string } }>('/api/health')

    expect(body.status).toBe('ok')
    expect(body.library.databaseFile).toMatch(/showrunner\.db$/)
  })

  it('reports whether it can reach a model, and stays ok when it cannot', async () => {
    // The floor's first tile is what this feeds (mockups/floor.html): "Claude adapter —
    // Anthropic API · connected". It could not be rendered from the old payload at all.
    const ready = await get<{ status: string; llm: LLMReadiness }>('/api/health')
    expect(ready.llm).toMatchObject({ backend: 'anthropic-api', ready: true })

    readiness = NOTHING
    const not = await get<{ status: string; llm: LLMReadiness }>('/api/health')
    expect(not.llm).toMatchObject({ backend: 'claude-cli', ready: false })
    expect(not.llm.sentence).toContain('no `claude` executable on PATH')
    // The process is still fine: the library is mounted, the runner runs, gates rule.
    // Two facts, two fields — a screen cannot render them from one.
    expect(not.status).toBe('ok')
  })
})

describe('the app process — launching a run', () => {
  it('starts the demo run Ryan clicked, and nothing else', async () => {
    llm.reply('The exchanger fails on a Tuesday.')

    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    expect(started.status).toBe(201)
    await runner.settled(started.body.runId)

    const view = await get<RunView>(`/api/run/${started.body.runId}`)
    expect(view.run.status).toBe('paused')
    expect(view.gate!.artifact.text).toContain('The exchanger fails')
  })

  it('refuses with the same sentence the disabled button was showing', async () => {
    readiness = NOTHING

    const view = await get<{ shows: { episodes: { launch: { blockedBecause: string } }[] }[] }>(
      '/api/operating',
    )
    const onScreen = view.shows[0]!.episodes[1]!.launch.blockedBecause

    const refused = await post<{ error: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    expect(refused.status).toBe(409)
    // Not "similar" — the same sentence, out of the same composer. That is what stops a
    // precondition becoming a failure after the click.
    expect(refused.body.error).toBe(onScreen)
    expect(llm.calls).toHaveLength(0)
  })

  it('refuses a second run on an episode that already has one', async () => {
    llm.reply('The exchanger fails on a Tuesday.')
    const first = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(first.body.runId)

    const second = await post<{ error: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    expect(second.status).toBe(409)
    expect(second.body.error).toContain('One run per episode')
  })

  it('needs an episode and a stage', async () => {
    const nothing = await post<{ error: string }>('/api/run', {})
    expect(nothing.status).toBe(400)
    expect(nothing.body.error).toContain('episodeId and a stage')
  })
})

describe('the app process — ruling on a gate', () => {
  it('carries the run on and hands back the run as it now stands', async () => {
    llm.reply('The exchanger fails on a Tuesday.')
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(started.body.runId)
    const gateId = openGates(store)[0]!.gate.id

    const ruled = await post<RunView>(`/api/gate/${gateId}/approve`, { comment: 'that reads.' })
    expect(ruled.status).toBe(200)
    // The answer is the run as the ruling left it: moving again, not finished. A ruling
    // releases work, it does not wait for it — the rest arrives on the event stream.
    expect(ruled.body.run.status).toBe('running')
    expect(ruled.body.gate!.rounds[0]!.ruling).toMatchObject({ verdict: 'approve' })

    await runner.settled(started.body.runId)
    const after = await get<RunView>(`/api/run/${started.body.runId}`)
    expect(after.run.status).toBe('done')
    expect(after.spend.sentence).toMatch(/^1 call · \$\d+\.\d\d$/)
    // Nothing was re-run on the way back in: one call, one row, one draft on the volume.
    expect(llm.calls).toHaveLength(1)
  })

  it('reopens the producing step on a rejection, with the notes', async () => {
    llm.reply('The exchanger fails on a Tuesday.')
    llm.reply('Nobody will say whose fault the exchanger is.')
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(started.body.runId)
    const gateId = openGates(store)[0]!.gate.id

    const ruled = await post<RunView>(`/api/gate/${gateId}/reject`, {
      notes: [{ note: 'Too tidy.', depth: 'premise' }],
    })
    expect(ruled.status).toBe(200)
    // The note is recorded with its routing depth (D21) the moment it is given; round 2
    // opens when the step has written again, which is a model call away.
    expect(ruled.body.gate!.rounds[0]!.ruling).toMatchObject({
      verdict: 'reject',
      notes: [{ note: 'Too tidy.', depth: 'premise', target: null }],
    })

    await runner.settled(started.body.runId)
    const after = await get<RunView>(`/api/run/${started.body.runId}`)
    expect(after.gate!.round).toBe(2)
    expect(after.gate!.artifact.text).toContain('whose fault')
    expect(llm.calls[1]!.prompt).toContain('Too tidy.')
  })

  it('will not take a rejection with no notes', async () => {
    llm.reply('The exchanger fails on a Tuesday.')
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(started.body.runId)
    const gateId = openGates(store)[0]!.gate.id

    const refused = await post<{ error: string }>(`/api/gate/${gateId}/reject`, { notes: [] })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('at least one note')
  })

  it('says so when the round has already been ruled, rather than ruling it twice', async () => {
    llm.reply('The exchanger fails on a Tuesday.')
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(started.body.runId)
    const gateId = openGates(store)[0]!.gate.id

    await post(`/api/gate/${gateId}/approve`, {})
    const again = await post<{ error: string }>(`/api/gate/${gateId}/approve`, {})
    expect(again.status).toBe(409)
    expect(again.body.error).toContain('A later opinion is a later round.')
  })
})

describe('the app process — the wire itself', () => {
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

  it('says so for a run that does not exist', async () => {
    const res = await app.request('/api/run/run_nope')
    expect(res.status).toBe(404)
  })
})

// ── Test kit ────────────────────────────────────────────────────────────────────

async function get<T>(path: string): Promise<T> {
  const res = await app.request(path)
  expect(res.status).toBe(200)
  return (await res.json()) as T
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as T }
}

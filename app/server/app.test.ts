import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import type { CanonBenchView } from './canon-bench.ts'
import type { Store } from './db/store.ts'
import { findingsIn, recordCheckPass } from './domain/finding.ts'
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
let showId: string

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
  showId = show.id
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

  /**
   * D12, both sides of it, over the wire — and the two tests below differ by ONE VERB.
   *
   * A deterministic finding is standing against the artifact under review. The gate accepts
   * every verdict exactly as it did before: nothing here refuses a ruling, and neither
   * request below is turned away. What the verdict changes is what happens to the NEXT
   * STAGE — which is the whole of the ruling, and the reason `approve` and `override` are
   * two words in the ledger rather than one.
   */
  async function ruleOverAStandingFinding(verdict: 'approve' | 'override'): Promise<string> {
    llm.reply('The exchanger fails on a Tuesday.')
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(started.body.runId)
    const open = openGates(store)[0]!

    // As if a canon-graph check had read the draft under review. `recordCheckPass` is the
    // only path that writes a finding, planted or not.
    recordCheckPass(store, {
      checkKey: 'retired-reappearance',
      tier: 'deterministic',
      artifactId: open.gate.artifactId,
      findings: [
        {
          concern:
            'Sefa Doule is declared retired, and this premise-brief is built on them. ' +
            'Standing is a declaration about the show and provenance is what the episode ' +
            'actually touches — the two disagree, and one of them is wrong.',
          severity: 'high',
          confidence: 'certain',
        },
      ],
    })

    const ruled = await post<RunView>(`/api/gate/${open.gate.id}/${verdict}`, {})
    expect(ruled.status).toBe(200)
    expect(ruled.body.gate!.rounds[0]!.ruling).toMatchObject({ verdict })
    await runner.settled(started.body.runId)
    return open.gate.artifactId
  }

  it('takes the approval, and the deterministic finding still walls the next stage', async () => {
    await ruleOverAStandingFinding('approve')

    const view = await get<{ shows: { episodes: { launch: { blockedBecause: string } }[] }[] }>(
      '/api/operating',
    )
    const onScreen = view.shows[0]!.episodes[1]!.launch.blockedBecause
    const refused = await post<{ error: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })

    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(onScreen)
    expect(refused.body.error).toContain('retired-reappearance')
    expect(refused.body.error).toContain('Sefa Doule is declared retired')
  })

  it('takes the override, and the SAME enqueue goes through — with nothing unblocked', async () => {
    const artifactId = await ruleOverAStandingFinding('override')

    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: DEMO_STAGE })
    expect(started.status).toBe(201)

    // Nothing was written to unblock it. The finding is exactly as the check left it — open,
    // undismissed, still a record of what it read — and the wall is down because Ryan's
    // override is a row it computes over, not because anything cleared a flag.
    const finding = findingsIn(store, artifactId)[0]!
    expect(finding).toMatchObject({ status: 'open', disposition: null })
    expect(
      store.get<{ n: number }>('SELECT COUNT(*) AS n FROM finding_disposition')!.n,
    ).toBe(0)
    // And the override is in the log as itself, distinguishable forever (invariant 3).
    expect(
      store.get<{ n: number }>("SELECT COUNT(*) AS n FROM event WHERE kind = 'gate-overridden'")!.n,
    ).toBe(1)
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

describe('the app process — the canon bench', () => {
  it('serves the bench a loaded show stands at: candidates, a full queue, an empty ledger', async () => {
    const view = await get<CanonBenchView>(`/api/canon/${showId}`)

    expect(view.show.key).toBe('greyharbor')
    expect(view.entities.every((entity) => entity.status === 'candidate')).toBe(true)
    expect(view.queue).toHaveLength(6)
    expect(view.ledger).toEqual([])
    expect(view.found.enabled).toBe(true)
    expect(view.found.cost).toBe('No model call · $0.00')

    const missing = await app.request('/api/canon/show_nope')
    expect(missing.status).toBe(404)
  })

  it('founds the show, and the ledger it renders from carries one ruling per sheet', async () => {
    const founded = await post<CanonBenchView>(`/api/canon/${showId}/found`, {})

    expect(founded.status).toBe(200)
    // The answer IS the recomposed bench: the section re-renders off `canon_ruling` without
    // a second round trip, which is where a bench ruling is read back from (#29).
    expect(founded.body.ledger).toHaveLength(6)
    expect(founded.body.ledger.every((ruling) => ruling.kind === 'ratification')).toBe(true)
    expect(founded.body.ledger[0]!.sentence).toContain('convened at the bench, no gate')
    expect(founded.body.queue).toEqual([])
    expect(founded.body.found.enabled).toBe(false)
    expect(founded.body.entities.find((entity) => entity.name === 'Ilse Renn')!.status).toBe(
      'active',
    )
    // Nothing about a canon ruling reaches the wire: the Live panel stays runs-and-gates.
    expect(await get<{ shows: unknown[] }>('/api/operating')).toBeTruthy()
    expect(llm.calls).toHaveLength(0)
  })

  it('round-trips all three ruling verbs, and each lands on the ledger', async () => {
    const queue = (await get<CanonBenchView>(`/api/canon/${showId}`)).queue

    const ratified = await post<CanonBenchView>(`/api/proposal/${queue[0]!.id}/ratify`, {
      note: 'yes — that is the sheet.',
    })
    const rejected = await post<CanonBenchView>(`/api/proposal/${queue[1]!.id}/reject`, {
      note: 'not yet; the harbour has no faction in it.',
    })
    const deferred = await post<CanonBenchView>(`/api/proposal/${queue[2]!.id}/defer`, {
      note: 'later.',
    })

    expect([ratified.status, rejected.status, deferred.status]).toEqual([200, 200, 200])
    expect(deferred.body.ledger.map((ruling) => ruling.kind)).toEqual([
      'deferral',
      'rejection',
      'ratification',
    ])
    expect(deferred.body.ledger[0]!.note).toBe('later.')
    // All three dispose of a proposal, so the queue is three shorter — and only the first
    // wrote canon (invariant 1).
    expect(deferred.body.queue).toHaveLength(3)

    const again = await post<{ error: string }>(`/api/proposal/${queue[0]!.id}/ratify`, {})
    expect(again.status).toBe(409)
    expect(again.body.error).toContain('a proposal is ruled once')

    const nothing = await app.request('/api/proposal/prop_nope/ratify', { method: 'POST' })
    expect(nothing.status).toBe(404)
  })

  it('refuses a rejection with no note in the sentence the disabled button was showing', async () => {
    const view = await get<CanonBenchView>(`/api/canon/${showId}`)
    const onScreen = view.refusals.rejectNeedsNote

    const refused = await post<{ error: string }>(`/api/proposal/${view.queue[0]!.id}/reject`, {
      note: '   ',
    })
    expect(refused.status).toBe(409)
    // Not "similar" — the same string, out of `REJECTION_NEEDS_A_NOTE`. The disabled button
    // and the refusal cannot drift apart, which is what makes the precondition real.
    expect(refused.body.error).toBe(onScreen)
    expect(refused.body.error).toContain('reject with note')
  })

  it('creates an entity as a candidate and raises its promotion, and rules it in the queue', async () => {
    await post(`/api/canon/${showId}/found`, {})

    const created = await post<CanonBenchView>(`/api/canon/${showId}/entity`, {
      categoryKey: 'character',
      name: 'Ottilie Bray',
      standing: 'recurring',
      facts: 'Ottilie Bray keeps the harbour’s only working lathe.\n',
      relations: [{ type: 'species', to: 'unknown' }],
    })

    expect(created.status).toBe(200)
    const candidate = created.body.entities.find((entity) => entity.name === 'Ottilie Bray')!
    expect(candidate.status).toBe('candidate')
    expect(created.body.queue).toHaveLength(1)
    expect(created.body.queue[0]!.sentence).toContain('raised by you, at the bench')

    const ruled = await post<CanonBenchView>(
      `/api/proposal/${created.body.queue[0]!.id}/ratify?entity=${candidate.id}`,
      { note: 'she has been in the background for six episodes.' },
    )
    expect(ruled.body.entity!.status).toBe('active')
    expect(ruled.body.entity!.facts).toHaveLength(1)

    const blank = await post<{ error: string }>(`/api/canon/${showId}/entity`, {
      categoryKey: 'character',
      name: ' ',
    })
    expect(blank.status).toBe(409)
    expect(blank.body.error).toBe(created.body.refusals.entityNeedsName)
  })

  it('promotes the candidate the loader left, with the sheet typed for it', async () => {
    const founded = await post<CanonBenchView>(`/api/canon/${showId}/found`, {})
    const sefa = founded.body.entities.find((entity) => entity.name === 'Sefa Doule')!
    expect(sefa.status).toBe('candidate')
    expect(sefa.promote.enabled).toBe(true)

    const raised = await post<CanonBenchView>(
      `/api/canon/entity/${sefa.id}/promote?entity=${sefa.id}`,
      {
        standing: 'recurring',
        aliases: 'the assessor',
        facts: 'Sefa Doule files against the line office’s ledger, not the harbour’s.',
        relations: [{ type: 'species', to: 'unknown' }],
      },
    )
    expect(raised.body.entity!.status).toBe('candidate')
    expect(raised.body.queue).toHaveLength(1)

    const ruled = await post<CanonBenchView>(
      `/api/proposal/${raised.body.queue[0]!.id}/ratify?entity=${sefa.id}`,
      { note: 'he is in ep03; put him on the books.' },
    )
    expect(ruled.body.entity!.status).toBe('active')
    expect(ruled.body.entity!.relations[0]!.sentence).toContain('species → unknown')
  })

  it('changes one ratified fact by a second proposal, and the as-of control flips it back', async () => {
    const founded = await post<CanonBenchView>(`/api/canon/${showId}/found`, {})
    const ilse = founded.body.entities.find((entity) => entity.name === 'Ilse Renn')!

    const sheet = await get<CanonBenchView>(`/api/canon/${showId}?entity=${ilse.id}`)
    const fact = sheet.entity!.facts[0]!

    const raised = await post<CanonBenchView>(
      `/api/canon/fact/${fact.id}/propose?entity=${ilse.id}`,
      { statement: 'Ilse Renn has not left the station in eleven years.' },
    )
    expect(raised.status).toBe(200)
    // Raised is not ruled: canon still says what it said.
    expect(raised.body.entity!.facts.map((each) => each.statement)).toContain(fact.statement)

    const ruled = await post<CanonBenchView>(
      `/api/proposal/${raised.body.queue[0]!.id}/ratify?entity=${ilse.id}`,
      { note: 'eleven. the gap year counts.' },
    )
    const at = ruled.body.ledger[0]!.seq
    expect(ruled.body.entity!.facts.map((each) => each.statement)).toContain(
      'Ilse Renn has not left the station in eleven years.',
    )

    // The whole point of the ledger being the clock: read canon on the other side of it.
    const before = await get<CanonBenchView>(
      `/api/canon/${showId}?entity=${ilse.id}&ruling=${at - 1}`,
    )
    expect(before.entity!.facts.map((each) => each.statement)).toContain(fact.statement)
    expect(before.entity!.facts.map((each) => each.statement)).not.toContain(
      'Ilse Renn has not left the station in eleven years.',
    )
    expect(before.asOf.sentence).toContain(`Canon as of ruling ${at - 1}`)

    const missing = await app.request('/api/canon/fact/fact_nope/propose', { method: 'POST' })
    expect(missing.status).toBe(404)
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

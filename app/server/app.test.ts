import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import type { CanonBenchView } from './canon-bench.ts'
import type { CheckBenchView } from './check-bench.ts'
import type { Store } from './db/store.ts'
import { artifactsOf } from './domain/artifact.ts'
import { recordExtractedBoard } from './domain/board.ts'
import { findingsIn, recordCheckPass } from './domain/finding.ts'
import { episodesOf, scenesOf, seasonsOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { loadFixture } from './fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import type { ArtifactEdited } from './edit.ts'
import type { ArtifactOnTheWire } from './app.ts'
import type { RunView } from './operating.ts'
import type { WritingRoomView } from './writing-room.ts'
import { BOARD_CHECK_STAGE, BOARD_STAGE } from './runner/board-step.ts'
import { createRulings, openGates } from './runner/gate.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'
import { PREMISE_STAGE } from './runner/write-step.ts'

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
let ep01: string
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
    llm,
    readiness: () => readiness,
  })

  const show = store.get<{ id: string }>("SELECT id FROM show WHERE key = 'greyharbor'")!
  showId = show.id
  const episodes = episodesOf(store, seasonsOf(store, show.id)[0]!.id)
  ep01 = episodes.find((e) => e.number === 1)!.id
  ep02 = episodes.find((e) => e.number === 2)!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const WRITTEN = 'The exchanger fails on a Tuesday.'

/**
 * One whole round of the premise stage, scripted: the draft, then the panel it convenes.
 *
 * The fixture is LOADED and not founded here, so every entity is still a candidate with no
 * standing — the desk hands the writer nobody, the brief declares no provenance, and the
 * panel is the two craft reviewers a premise-brief is read by whatever else is true (D13).
 */
function queueThePremise(text: string = WRITTEN): void {
  llm.reply(text)
  llm.reply('{"findings": []}')
  llm.reply('{"findings": []}')
}

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
  it('starts the premise run Ryan clicked, and nothing else', async () => {
    queueThePremise()

    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
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

    const refused = await post<{ error: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
    expect(refused.status).toBe(409)
    // Not "similar" — the same sentence, out of the same composer. That is what stops a
    // precondition becoming a failure after the click.
    expect(refused.body.error).toBe(onScreen)
    expect(llm.calls).toHaveLength(0)
  })

  it('refuses a second run on an episode that already has one', async () => {
    queueThePremise()
    const first = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(first.body.runId)

    const second = await post<{ error: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
    expect(second.status).toBe(409)
    expect(second.body.error).toContain('One run per episode')
  })

  it('needs an episode and a stage', async () => {
    const nothing = await post<{ error: string }>('/api/run', {})
    expect(nothing.status).toBe(400)
    expect(nothing.body.error).toContain('episodeId and a stage')
  })

  it('says which stages it has when asked for one it does not', async () => {
    const missing = await post<{ error: string }>('/api/run', {
      episodeId: ep02,
      stage: 'produce-shot-images',
    })

    // A stage this build does not have is a different mistake from a run it will not start,
    // and it answers as one. The catalogue is TypeScript, so the list is the truth.
    expect(missing.status).toBe(404)
    expect(missing.body.error).toContain('no stage called “produce-shot-images”')
    expect(missing.body.error).toContain('continuity-board-checks')
    expect(missing.body.error).toContain('the Archon rule')
  })

  /**
   * The defect E3-1 found and deferred to E3-7, through the wire it actually matters on: a
   * stage that declares zero spend runs on a process with nothing behind the adapter.
   */
  it('starts a stage that declares no model call with no backend configured at all', async () => {
    readiness = NOTHING
    // ep01 has the fixture script and a board is what the free tier reads; build one the way
    // the rules will find it, without a model.
    const script = artifactsOf(store, ep01).find((artifact) => artifact.kind === 'script')!
    recordExtractedBoard(store, {
      episodeId: ep01,
      scriptId: script.id,
      // Every scene the script has, because a grid with a hole in it is refused (`board.ts`).
      // Flat and inside: what is under test here is the refusal in front of the button, not
      // what the rules make of the rows.
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

    const started = await post<{ runId: string }>('/api/run', {
      episodeId: ep01,
      stage: BOARD_CHECK_STAGE,
    })

    expect(started.status).toBe(201)
    const settled = await runner.settled(started.body.runId)
    expect(settled.status).toBe('done')
    expect(llm.calls).toHaveLength(0)

    // Its paid sibling on the same episode is refused, with the adapter's own sentence. That
    // asymmetry is the whole fix: a declaration, not an exemption list.
    const paid = await post<{ error: string }>('/api/run', { episodeId: ep01, stage: BOARD_STAGE })
    expect(paid.status).toBe(409)
    expect(paid.body.error).toContain('Nothing to call')
  })
})

describe('the app process — the check bench', () => {
  it('answers with the bench for one episode, and runs nothing doing it', async () => {

    const bench = await get<CheckBenchView>(`/api/checks/${ep01}`)

    expect(bench.label).toBe('ep01')
    expect(bench.artifact.kind).toBe('script')
    // The script itself, off the volume — the bench renders the artifact, never a filename.
    expect(bench.artifact.text).toContain('The mess deck is warm')
    // A GET starts nothing (invariant 5), and reading this page costs nothing.
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM run')!.n).toBe(0)
    expect(llm.calls).toHaveLength(0)
    // One button per stage that reads, each with the stage it starts on it, so the browser
    // never holds its own copy of a stage name.
    expect(bench.runs.map((one) => one.stage)).toContain(BOARD_CHECK_STAGE)
  })

  it('404s for an episode that is not in this library', async () => {
    const missing = await app.request('/api/checks/ep_nope')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: 'No such episode: ep_nope' })
  })
})

describe('the app process — ruling on a gate', () => {
  it('carries the run on and hands back the run as it now stands', async () => {
    queueThePremise()
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
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
    // The draft and the two reviewers that read it. Nothing was re-run on the way back in:
    // no second draft, no second reading, no second row.
    expect(after.spend.sentence).toMatch(/^3 calls · \$\d+\.\d\d$/)
    expect(llm.calls).toHaveLength(3)
  })

  it('reopens the producing step on a rejection, with the notes', async () => {
    queueThePremise()
    queueThePremise('Nobody will say whose fault the exchanger is.')
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(started.body.runId)
    const gateId = openGates(store)[0]!.gate.id

    const ruled = await post<RunView>(`/api/gate/${gateId}/reject`, {
      notes: [{ note: 'Too tidy.', depth: 'premise' }],
    })
    expect(ruled.status).toBe(200)
    // The note is recorded with its routing depth (D21) the moment it is given, and with the
    // ADDRESS that depth resolved to — the ep02 premise-brief at the version standing when he
    // wrote it (E4-5, `domain/routing.ts`). It is the artifact this very gate is over, so the
    // note lands here and round 2 opens when the step has written again, a model call away.
    expect(ruled.body.gate!.rounds[0]!.ruling).toMatchObject({
      verdict: 'reject',
      notes: [
        {
          note: 'Too tidy.',
          depth: 'premise',
          target: artifactsOf(store, ep02).find((one) => one.kind === 'premise-brief')!.id,
          targetVersion: 1,
        },
      ],
    })

    await runner.settled(started.body.runId)
    const after = await get<RunView>(`/api/run/${started.body.runId}`)
    expect(after.gate!.round).toBe(2)
    expect(after.gate!.artifact.text).toContain('whose fault')
    // The note reached the writer — the second draft's call, on the far side of round 1's
    // panel — and it arrived through the desk, with the round it was given at on it.
    const rewrite = llm.calls.filter((call) => call.prompt.includes('WRITE THE ep02'))[1]!
    expect(rewrite.prompt).toContain('Too tidy.')
    expect(rewrite.prompt).toContain('your round 1 rejection of the ep02 premise-brief')
  })

  it('will not take a rejection with no notes', async () => {
    queueThePremise()
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
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
   *
   * **What it is read through changed in E4-1.** It used to be the episode card's launch
   * button, back when `demo` could be run on anything forever. The premise stage cannot: once
   * ep02 has a brief the button says so, ahead of the wall and rightly (`operating.ts`). So
   * the wall is read where it is also rendered — the check bench's `wall`, which is the same
   * `stageBlockedBecause` string the refusal uses, over the same wire.
   */
  async function ruleOverAStandingFinding(verdict: 'approve' | 'override'): Promise<string> {
    queueThePremise()
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
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

    const bench = await get<CheckBenchView>(`/api/checks/${ep02}`)
    expect(bench.wall).toContain('ep02 is blocked')
    expect(bench.wall).toContain('retired-reappearance')
    expect(bench.wall).toContain('Sefa Doule is declared retired')

    // The premise stage has its own, truer answer for ep02 now — it wrote the brief that is
    // sitting there — and that is what the button says. The wall is still up behind it.
    const refused = await post<{ error: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain('already has a premise-brief')
  })

  it('takes the override, and the wall comes down — with nothing unblocked', async () => {
    const artifactId = await ruleOverAStandingFinding('override')

    const bench = await get<CheckBenchView>(`/api/checks/${ep02}`)
    expect(bench.wall).toBeNull()

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
    queueThePremise()
    const started = await post<{ runId: string }>('/api/run', { episodeId: ep02, stage: PREMISE_STAGE })
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
    expect(founded.body.ledger[0]!.sentence).toContain('convened away from a gate')
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

  it('adds a fact to an entity created without one, which is the gap #39 names', async () => {
    await post(`/api/canon/${showId}/found`, {})
    const created = await post<CanonBenchView>(`/api/canon/${showId}/entity`, {
      categoryKey: 'character',
      name: 'Ottilie Bray',
      standing: 'recurring',
      facts: '',
      relations: [{ type: 'species', to: 'unknown' }],
    })
    const ottilie = created.body.entities.find((entity) => entity.name === 'Ottilie Bray')!
    const promoted = await post<CanonBenchView>(
      `/api/proposal/${created.body.queue[0]!.id}/ratify?entity=${ottilie.id}`,
      { note: 'she has been in the background for six episodes.' },
    )
    // Canon, and carrying nothing — there is no fact here to hang a change form on.
    expect(promoted.body.entity!.status).toBe('active')
    expect(promoted.body.entity!.facts).toEqual([])

    const raised = await post<CanonBenchView>(
      `/api/canon/entity/${ottilie.id}/fact?entity=${ottilie.id}`,
      { field: 'trade', statement: 'Ottilie Bray keeps the harbour’s only working lathe.' },
    )
    expect(raised.status).toBe(200)
    // Raised is not ruled: her sheet is still empty, and the proposal is on the queue.
    expect(raised.body.entity!.facts).toEqual([])
    expect(raised.body.queue).toHaveLength(1)

    const ruled = await post<CanonBenchView>(
      `/api/proposal/${raised.body.queue[0]!.id}/ratify?entity=${ottilie.id}`,
      { note: 'yes — she turns the part in ep05.' },
    )
    expect(ruled.body.entity!.facts.map((fact) => fact.statement)).toEqual([
      'Ottilie Bray keeps the harbour’s only working lathe.',
    ])

    // The 400-and-the-button house rule: one string, refused and rendered.
    const blank = await post<{ error: string }>(`/api/canon/entity/${ottilie.id}/fact`, {
      statement: ' ',
    })
    expect(blank.status).toBe(409)
    expect(blank.body.error).toBe(ruled.body.refusals.additionNeedsStatement)

    const missing = await app.request('/api/canon/entity/entity_nope/fact', { method: 'POST' })
    expect(missing.status).toBe(404)
  })

  it('refuses a fact on a candidate in the sentence its disabled button showed', async () => {
    const founded = await post<CanonBenchView>(`/api/canon/${showId}/found`, {})
    const sefa = founded.body.entities.find((entity) => entity.name === 'Sefa Doule')!

    const sheet = await get<CanonBenchView>(`/api/canon/${showId}?entity=${sefa.id}`)
    expect(sheet.entity!.addFact.enabled).toBe(false)

    const refused = await post<{ error: string }>(`/api/canon/entity/${sefa.id}/fact`, {
      statement: 'Sefa Doule files against the line office’s ledger.',
    })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(sheet.entity!.addFact.blockedBecause)
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

  /**
   * **The door E4-4 built** (#64): until this route, `declarePosition` had one caller in the
   * whole app and it was the fixture loader. Declaring is free and raises nothing — the
   * LANDING that turns a pin into a claim is raised by the script's extraction, with the
   * subject only a writer can answer for (`claim.ts`).
   */
  it('declares an episode’s arc position, raising nothing and writing no canon', async () => {
    const before = await get<CanonBenchView>(`/api/canon/${showId}?episode=${ep02}`)
    expect(before.positions!.standing).toContain('ep02 declares no position on any arc')

    const second = before.positions!.waypoints.find((one) => one.ordinal === 2)!
    expect(second.declare.enabled).toBe(true)
    expect(second.declare.cost).toBe('No model call · $0.00')
    expect(second.declare.sentence).toContain('Declare ep02 at waypoint 2')
    expect(second.declare.sentence).toContain('the landing proposal is raised when the script is read')

    const declared = await post<CanonBenchView>(
      `/api/canon/episode/${ep02}/position?episode=${ep02}`,
      { arcId: second.arcId, waypointId: second.waypointId },
    )
    expect(declared.status).toBe(200)
    expect(declared.body.positions!.waypoints.find((one) => one.ordinal === 2)!.declared).toBe(true)
    // The pin moved and nothing else did: no proposal on the queue, no row on the ledger.
    expect(declared.body.queue).toEqual(before.queue)
    expect(declared.body.ledger).toEqual(before.ledger)

    const missing = await app.request('/api/canon/episode/ep_nope/position', { method: 'POST' })
    expect(missing.status).toBe(404)
  })

  it('refuses an arc the episode is not written under, in the words the bench would use', async () => {
    const view = await get<CanonBenchView>(`/api/canon/${showId}?episode=${ep02}`)
    const waypoint = view.positions!.waypoints[0]!

    const refused = await post<{ error: string }>(
      `/api/canon/episode/${ep02}/position?episode=${ep02}`,
      { arcId: waypoint.arcId, waypointId: 'wp_nope' },
    )
    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain('does not belong to arc')
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

// ── The writing room, over the wire (E4-7) ────────────────────────────────────

describe('the app process — the writing room', () => {
  it('answers with the line, the desks, the doors and the pin, and starts nothing', async () => {
    const room = await get<WritingRoomView>(`/api/writing/${ep02}`)

    expect(room.label).toBe('ep02')
    expect(room.line.map((step) => step.step)).toEqual(['premise', 'outline', 'script'])
    expect(room.line[0]!.offer.sentence).toContain('Write the ep02 premise-brief')
    // The desk is composed on the read — that is what makes it a preview of what a click
    // would buy rather than a post-mortem of one.
    expect(room.line[0]!.desk.prompt).toContain('WRITE THE ep02 PREMISE-BRIEF')
    expect(room.line[0]!.desk.leftOut.length).toBeGreaterThan(0)
    expect(room.positions!.waypoints.length).toBeGreaterThan(0)

    // A GET runs nothing and costs nothing (invariant 5, at page-load scale).
    expect(llm.calls).toEqual([])
    expect(store.all('SELECT id FROM run')).toEqual([])
  })

  it('refuses the rejection with the exact sentence the room’s button was showing', async () => {
    queueThePremise()
    const started = await post<{ runId: string }>('/api/run', {
      episodeId: ep02,
      stage: PREMISE_STAGE,
    })
    await runner.settled(started.body.runId)

    const room = await get<WritingRoomView>(`/api/writing/${ep02}`)
    const gate = room.gates[0]!
    expect(gate.isOpen).toBe(true)

    // One string, byte for byte: what the disabled button shows and what the route answers.
    const refused = await post<{ error: string }>(`/api/gate/${gate.id}/reject`, { notes: [] })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe(gate.rejectNeedsNote)
  })

  it('says so for an episode that does not exist', async () => {
    const res = await app.request('/api/writing/ep_nope')
    expect(res.status).toBe(404)
  })
})

// ── Test kit ────────────────────────────────────────────────────────────────────

// ── Ryan's hand, over the wire (E4-5) ──────────────────────────────────────────

describe('the app process — editing a written artifact by hand', () => {
  const scriptOf = (episodeId: string) =>
    artifactsOf(store, episodeId).find((one) => one.kind === 'script')!

  it('hands over the draft to type over, with the door and its cost on it', async () => {
    const script = scriptOf(ep01)
    const view = await get<ArtifactOnTheWire>(`/api/artifact/${script.id}`)

    expect(view.artifact.kind).toBe('script')
    expect(view.text).toContain('## 4 · EXT. THE LONG PIER — 07:07')
    expect(view.edit.enabled).toBe(true)
    expect(view.edit.cost).toBe('No model call · $0.00')
    expect(view.staleBecause).toBeNull()
    expect(view.standing).toEqual([])
    expect(llm.calls).toEqual([])
  })

  it('lands what he sends word for word, and reads it before it answers', async () => {
    const script = scriptOf(ep01)
    const before = await get<ArtifactOnTheWire>(`/api/artifact/${script.id}`)
    const typed = before.text!.replace('Three minutes of it,', 'Two minutes of it,')

    const edited = await post<ArtifactEdited>(`/api/artifact/${script.id}/edit`, { text: typed })

    expect(edited.status).toBe(200)
    expect(edited.body.version).toBe(2)
    expect(edited.body.read.map((pass) => pass.checkKey)).toEqual([
      'stale-exception',
      'retired-reappearance',
    ])
    expect(edited.body.lifecycle).toBe('script')
    expect((await get<ArtifactOnTheWire>(`/api/artifact/${script.id}`)).text).toBe(typed)
    // The door that costs nothing costs nothing.
    expect(llm.calls).toEqual([])
    expect(store.all('SELECT * FROM cost_entry')).toEqual([])
  })

  it('refuses with the sentence the disabled button was already showing', async () => {
    const script = scriptOf(ep01)
    const offered = await get<ArtifactOnTheWire>(`/api/artifact/${script.id}`)
    // The same text back: not a new draft, and the refusal says so rather than spending a
    // version on nothing.
    const refused = await post<{ error: string }>(`/api/artifact/${script.id}/edit`, {
      text: offered.text,
    })

    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain('already on the volume, character for character')
    expect(scriptOf(ep01).version).toBe(1)
  })

  it('is a 404 for an artifact this library does not have, and a 400 with no text', async () => {
    const missing = await post<{ error: string }>('/api/artifact/art_nothing/edit', { text: 'x' })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toContain('art_nothing')

    const empty = await post<{ error: string }>(
      `/api/artifact/${scriptOf(ep01).id}/edit`,
      { nope: 1 },
    )
    expect(empty.status).toBe(400)
    expect(empty.body.error).toContain('word for word')
  })
})

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

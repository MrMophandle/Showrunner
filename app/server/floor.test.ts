import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { setShowBudget } from './cost.ts'
import type { Store } from './db/store.ts'
import { artifactsOf, type Artifact } from './domain/artifact.ts'
import { runBoardRules } from './domain/board-rules.ts'
import { recordExtractedBoard } from './domain/board.ts'
import { factsOfEntity } from './domain/fact.ts'
import { dismissFinding, findingsIn } from './domain/finding.ts'
import { raiseProposal } from './domain/proposal.ts'
import { episodesOf, moveLifecycleTo, seasonsOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { loadFixture } from './fixture/load.ts'
import { theLongPierExtraction } from './fixture/long-pier-board.ts'
import { floorView, count, ago, type FloorShow, type NeedsYouCard } from './floor.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import { createRulings, openGates, type Rulings } from './runner/gate.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'
import { SCRIPT_GATE_STAGE } from './runner/present-step.ts'
import { PREMISE_STAGE } from './runner/write-step.ts'

/**
 * **The floor** (E5-1, #81) — what needs Ryan, brought to him, and every sentence of it read
 * off a record something else wrote.
 *
 * Everything below runs against a REAL library volume with Grey Harbor **founded** in it, and
 * the gate it renders is a real gate a real run really parked on, opened by the real premise
 * stage with the fake backend in front of the model. No test in this repo spends a cent
 * (fixtures before features), and no test here writes a needs-you card by hand — the whole
 * question this file asks is whether the right rows produce the right card.
 *
 * The two assertions with the longest shadow are the qualifying rule and the budget:
 *
 *   * **What earns a card** — holding work still or standing owed — is asserted from BOTH
 *     sides. An open gate, a standing wall and an owed sweep each raise one; a canon queue
 *     with a whole founding stack on it raises none, however long it is.
 *   * **What a budget is** — the meter exists if and only if a `show_budget` row does, and
 *     the tile says in words that no cap is set when none is. There is no path in this build
 *     that writes that row (#88), so the null case is the one every library is in.
 */

const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
const NO_KEY: LLMReadiness = describeLLMBackend({ PATH: '/nowhere' })
const NOTHING_FOUND = '{"findings": []}'

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
let harbor: FoundedFixture
let ep01: string
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-floor-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)

  const season = seasonsOf(store, harbor.show.id)[0]!
  const episodes = episodesOf(store, season.id)
  ep01 = episodes[0]!.id
  ep02 = episodes[1]!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const floor = (llmReadiness: LLMReadiness = READY, now = new Date()): FloorShow =>
  floorView(store, paths, llmReadiness, now).shows[0]!

const cardsOfKind = (show: FloorShow, kind: NeedsYouCard['kind']): NeedsYouCard[] =>
  show.needsYou.filter((card) => card.kind === kind)

const episode = (show: FloorShow, label: string) =>
  show.episodes.find((one) => one.label === label)!

/**
 * A real gate on ep02, opened the only way a gate is ever opened: a real run of a real stage
 * that parked on it. The fake backend answers the writer and the panel; nothing is spent.
 */
async function openAGateOnEp02(): Promise<string> {
  llm.reply('Tobin Wick reads the exchanger log and has to decide what to do about it.')
  for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
  const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
  await runner.settled(run.id)
  return run.id
}

/**
 * The Long Pier's planted contradiction, raised over the hand-written extraction by the free
 * deterministic tier — the same real finding `stage-wall.test.ts` asks its questions of. No
 * model, no money, and the wall is computed off it rather than set anywhere.
 */
function wallEp01(): Artifact {
  const script = artifactsOf(store, ep01).find((artifact) => artifact.kind === 'script')!
  const board = recordExtractedBoard(store, {
    episodeId: ep01,
    scriptId: script.id,
    extraction: theLongPierExtraction({
      lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factOf('Halvani', 'loses consciousness'),
    }),
    filePath: 'greyharbor/s01e01/continuity-board-v1.md',
  })
  runBoardRules(store, board.artifact.id)
  return script
}

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

/** A proposal riding an episode — which is what makes a completion sweep owed (`sweep.ts`). */
function rideEp01(): void {
  raiseProposal(store, {
    entityId: harbor.entity('Tobin Wick').id,
    kind: 'fact-delta',
    raisedBy: 'writer',
    episodeId: ep01,
    facts: [{ statement: 'Tobin Wick keeps the plant keys on his own ring.' }],
  })
}

// ── Trap 1 · the qualifying rule ────────────────────────────────────────────────

describe('a needs-you card is computed from a record that holds work still, or stands owed', () => {
  it('raises one for a real open gate, with the sentence and the room the ruling happens in', async () => {
    await openAGateOnEp02()
    const open = openGates(store)[0]!
    const show = floor()

    expect(show.needsYou).toHaveLength(1)
    const [card] = show.needsYou
    expect(card!.kind).toBe('gate')
    expect(card!.id).toBe(open.gate.id)
    expect(card!.title).toBe('ep02 “Dry Stores” — premise-brief gate')
    expect(card!.kindLabel).toBe('Gate open')

    // It says WHY: the run is parked and his ruling is the only thing that moves it.
    expect(card!.why).toContain('parked on this gate')
    expect(card!.since).toContain('just now')

    // And WHERE — the gate room's real address, with the gate's real id on it, so the link
    // is the act rather than a search. The room says what it can do today rather than
    // pretending: E5-3 (#83) builds it, and the card carries that sentence.
    expect(card!.href).toBe(`/gate/${open.gate.id}`)
    expect(card!.room).toBe('the gate room')
    expect(card!.roomNotYet).toContain('#83')

    // Verb + object + scope + cost, and the cost is the truth about the CLICK.
    expect(card!.act.sentence).toBe('Rule on the ep02 premise-brief — round 1, at its gate')
    expect(card!.act.cost).toContain('No model call · $0.00 to open it')
    expect(card!.act.enabled).toBe(true)
  })

  it('raises none for the canon queue, however long it stands — that is presence, not alarm', () => {
    // A whole founding stack, unruled: seven promotion proposals in the queue and nothing
    // riding anything. `loadFixture` alone is exactly what `npm run fixture:load` leaves.
    rmSync(root, { recursive: true, force: true })
    store.close()
    root = mkdtempSync(join(tmpdir(), 'showrunner-floor-queue-'))
    paths = initLibrary(root)
    store = openLibraryStore(paths)
    const load = loadFixture(store, paths)

    expect(load.promotions.created).toBeGreaterThan(0)
    expect(floor().needsYou).toEqual([])
  })

  it('raises none for a proposal that rides nothing, and one for a proposal that rides an episode', () => {
    raiseProposal(store, {
      entityId: harbor.entity('Ilse Renn').id,
      kind: 'fact-delta',
      raisedBy: 'ryan',
      facts: [{ statement: 'Ilse Renn keeps the beacon log in pencil.' }],
    })
    // Rides nothing, so no episode's completion pass convenes it — it is rulable in the
    // library's queue, at his leisure, and the floor stays quiet about it.
    expect(floor().needsYou).toEqual([])

    rideEp01()
    const sweep = cardsOfKind(floor(), 'sweep')
    expect(sweep).toHaveLength(1)
    expect(sweep[0]!.title).toBe('ep01 “The Long Pier” — 1 proposal riding')
    expect(sweep[0]!.why).toContain('ep01')
    expect(sweep[0]!.act.sentence).toContain('Rule the 1 proposal riding ep01')
    expect(sweep[0]!.href).toBe(`/episode/${ep01}`)
  })

  it('raises one for a standing wall — a stage refused is work held still', () => {
    wallEp01()

    const [card] = cardsOfKind(floor(), 'wall')
    expect(card!.kindLabel).toBe('Stage refused')
    expect(card!.title).toContain('ep01 “The Long Pier”')
    expect(card!.title).toContain('vacuum-without-protection')
    // The opening sentence, which is the claim; the whole refusal rides on `detail`.
    expect(card!.why).toContain('ep01 is blocked')
    expect(card!.detail).toContain('D12')
    expect(card!.href).toBe(`/episode/${ep01}`)
  })

  it('stops raising the wall card the moment the wall comes down, with nothing to clear', () => {
    const script = wallEp01()
    expect(cardsOfKind(floor(), 'wall')).toHaveLength(1)

    for (const finding of findingsIn(store, script.id).filter((one) => one.status === 'open')) {
      dismissFinding(store, finding.id, 'ruled on it: the collar is on the peg in the next shot')
    }

    // Computed, both times, off the same rows. There is no `blocked` column to unset.
    expect(cardsOfKind(floor(), 'wall')).toEqual([])
    expect(floor().needsYou).toEqual([])
  })

  it('folds a wall into the gate card when both stand on one episode — one act, one card', async () => {
    wallEp01()
    // A gate on the SAME episode. The wall is now said inside it rather than beside it,
    // because both come down at the same ruling in the same room.
    llm.reply('The Long Pier, again, from the top.')
    for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
    const run = runner.enqueueRun({ episodeId: ep01, stage: SCRIPT_GATE_STAGE })
    await runner.settled(run.id)

    const show = floor()
    expect(cardsOfKind(show, 'wall')).toEqual([])
    const [gate] = cardsOfKind(show, 'gate')
    expect(gate!.why).toContain('deterministic')
    expect(gate!.why).toContain('D12')
    expect(gate!.detail).toContain('vacuum-without-protection')
  })

  it('says the designed empty state when nothing needs him, rather than leaving a blank', () => {
    const show = floor()
    expect(show.needsYou).toEqual([])
    expect(show.nothingNeedsYou!.lead).toBe('Nothing needs you.')
    expect(show.nothingNeedsYou!.sentence).toContain('No gate is open')
    expect(show.nothingNeedsYou!.sentence).toContain('canon library')
  })
})

// ── Trap 4 · the pip's three ruled states ───────────────────────────────────────

describe('the lifecycle track carries the three states Ryan ruled', () => {
  it('lights the stage the episode is AT in amber, and everything behind it as done', () => {
    // ep01 is at `script` in the fixture: premise and outline done, script his.
    const track = episode(floor(), 'ep01').track

    expect(track.map((stop) => stop.stage)).toEqual([
      'premise',
      'outline',
      'script',
      'assets',
      'assembled',
      'published',
    ])
    expect(track.map((stop) => stop.standing)).toEqual([
      'done',
      'done',
      'current',
      'ahead',
      'ahead',
      'ahead',
    ])
    // Said in words as well as in colour — the whole point of the amber/blue ruling is that
    // two states are never told apart by hue alone.
    expect(track[2]!.sentence).toBe('script — where it stands, and it is yours to move')
    expect(track[0]!.sentence).toBe('premise — done')
    expect(track[3]!.sentence).toBe('assets — not reached yet')
  })

  it('turns the current stage blue only while a run is actually turning on it', async () => {
    // Nothing running: ep02 is at `premise`, and `premise` is amber — his hand.
    expect(episode(floor(), 'ep02').track[0]!.standing).toBe('current')

    // A run in flight on it, and the same stop is `running` — in flight, not his hand.
    const inFlight = new Promise<void>((resolve) => {
      const stop = events.subscribe((record) => {
        if (record.kind === 'step-started' && record.episodeId === ep02) {
          stop()
          resolve()
        }
      })
    })
    llm.reply('Dry Stores, in one paragraph.')
    for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await inFlight

    const running = episode(floor(), 'ep02')
    expect(running.track[0]!.standing).toBe('running')
    expect(running.track[0]!.sentence).toBe('premise — running now')
    // And no other stop ever wears it: `running` is one stop, or none.
    expect(running.track.filter((stop) => stop.standing === 'running')).toHaveLength(1)

    await runner.settled(run.id)
  })
})

// ── Trap 5 · the health strip is honest about what does not exist ───────────────

describe('the health strip says what is true, including about what is not built', () => {
  const tile = (id: string) => floor().health.find((one) => one.id === id)!

  it('carries the adapter’s own sentence — presence, never “connected”', () => {
    expect(tile('adapter').value).toBe('Anthropic API · something to call')
    expect(tile('adapter').standing).toBe('good')
    expect(tile('adapter').detail).toContain('only knowable by spending money')
    // The word the E1-8 tile refuses, still refused.
    expect(tile('adapter').value).not.toContain('connected')
  })

  it('says nothing to call, in the adapter’s words, when there is nothing to call', () => {
    const missing = floorView(store, paths, NO_KEY).shows[0]!.health.find(
      (one) => one.id === 'adapter',
    )!
    expect(missing.value).toContain('nothing to call')
    expect(missing.standing).toBe('attention')
    expect(missing.sub).toContain('claude')
  })

  it('says the GPU worker is not built and whose it is, rather than drawing it down', () => {
    expect(tile('gpu-worker').standing).toBe('not-built')
    expect(tile('gpu-worker').value).toBe('Not built yet')
    expect(tile('gpu-worker').sub).toContain('E6')
    expect(tile('gpu-worker').detail).toContain('no worker here to be down')
  })

  it('reports the volume as the volume and the library as the library, never as each other', () => {
    const volume = tile('library-volume')
    expect(volume.value).toMatch(/(free|unreadable)/)
    // ep01's three artifacts are on disk in the fixture; the count is the ROWS, not the
    // disk, and it leads because it is the half that is about this library.
    expect(volume.sub).toBe(`3 artifact files recorded · ${paths.root}`)
    expect(volume.detail).toContain('not this library')
  })

  /**
   * **The budget, resolved.** `show_budget` and `remainingThisWeek` are real and have been
   * since 0005 — and nothing in this build ever writes that row, so every library reads back
   * "no weekly budget set". The tile therefore shows spend and says so; the meter appears
   * only when a row exists, which is what #88 is for.
   */
  it('draws no bar when no cap is set, and says in words that none is', () => {
    const spend = tile('spend')
    expect(spend.meter).toBeNull()
    expect(spend.label).toBe('Spend · this week')
    expect(spend.sub).toContain('no weekly budget set')
    expect(spend.detail).toContain('Nothing in this build sets a weekly cap')
    expect(spend.detail).toContain('#88')
  })

  it('draws the bar the moment a cap is a row, and never before', () => {
    setShowBudget(store, harbor.show.id, 60)

    const spend = tile('spend')
    expect(spend.label).toBe('Budget · this week')
    expect(spend.value).toBe('$0.00 of $60.00')
    expect(spend.meter).not.toBeNull()
    expect(spend.meter!.filled).toBe(0)
    expect(spend.meter!.sentence).toBe("$60.00 left of this week's $60.00")
  })

  it('argues the budget in the section header, where a reader meets it first', () => {
    expect(floor().healthHeading.explains).toContain('no weekly cap is set anywhere in this build')
    expect(floor().healthHeading.explains).toContain('#88')
  })
})

// ── Trap 6 · empty and not-started are states, rendered true ────────────────────

describe('not started, vanilla and finished are states the floor says out loud', () => {
  it('says ep02 is not started, because it is — no artifact, no run, still at premise', () => {
    const ep = episode(floor(), 'ep02')
    expect(ep.standing).toBe('Not started — nothing has been written for ep02 yet.')
    expect(ep.note).toBe('nothing spent — no call was made')
    expect(artifactsOf(store, ep02)).toEqual([])
  })

  it('stops saying it the moment something has been written for it', async () => {
    await openAGateOnEp02()
    expect(episode(floor(), 'ep02').standing).not.toContain('Not started')
  })

  it('says a vanilla episode is vanilla, and never that it has failed', () => {
    // ep02 declares no arc position. That is legal, tracked, and the fixture's own point.
    expect(episode(floor(), 'ep02').standing).toContain('Not started')
    // ep01 lands one, and says which.
    expect(episode(floor(), 'ep01').standing).toContain('Lands ')
    expect(episode(floor(), 'ep01').standing).toContain('@')
  })

  it('names the arc a vanilla-but-started episode does not touch', async () => {
    await openAGateOnEp02()
    const ep = episode(floor(), 'ep02')
    expect(ep.standing).toBe(
      'Vanilla — it touches no arc, which is legal, tracked, and never a failure.',
    )
  })

  it('draws a published episode quiet, with what it left behind rather than an offer', () => {
    moveLifecycleTo(store, ep01, 'published')

    const ep = episode(floor(), 'ep01')
    expect(ep.past).toBe(true)
    expect(ep.launch).toBeNull()
    expect(ep.done).toContain('Published')
    expect(ep.track.every((stop) => stop.standing !== 'ahead')).toBe(true)
  })

  it('says what an empty library is and how to fill it, rather than rendering nothing', () => {
    store.close()
    root = mkdtempSync(join(tmpdir(), 'showrunner-floor-empty-'))
    paths = initLibrary(root)
    store = openLibraryStore(paths)

    const view = floorView(store, paths, READY)
    expect(view.shows).toEqual([])
    expect(view.empty!.lead).toContain('no shows in it yet')
    expect(view.empty!.sentence).toContain('npm run fixture:load')
  })

  it('says what is NOT in flight where the mockup draws an idea pool nothing records', () => {
    const footer = floor().footer
    expect(footer.lead).toBe('Nothing else in flight.')
    expect(footer.sentence).toContain('2 episodes across 1 season')
    expect(footer.sentence).toContain('idea pool')
    expect(footer.sentence).toContain('not in this build')
  })
})

// ── The rows: offers, refusals, and the run in flight ───────────────────────────

describe('an episode row states its next act, its cost, and its refusal before the click', () => {
  it('offers the stage the episode is at, priced, when nothing holds it', () => {
    const ep = episode(floor(), 'ep02')
    expect(ep.launch!.enabled).toBe(true)
    expect(ep.launch!.sentence).toContain('ep02')
    expect(ep.launch!.cost).toContain('your money, spent when you click')
    expect(ep.launchStage).toBe(PREMISE_STAGE)
  })

  it('renders the refusal in words when the adapter cannot reach a model', () => {
    const ep = floorView(store, paths, NO_KEY).shows[0]!.episodes.find(
      (one) => one.label === 'ep02',
    )!
    expect(ep.launch!.enabled).toBe(false)
    expect(ep.launch!.blockedBecause).toContain('Nothing to call')
  })

  it('withdraws the offer entirely while a gate is open, and says who it is waiting on', async () => {
    await openAGateOnEp02()

    const ep = episode(floor(), 'ep02')
    expect(ep.launch).toBeNull()
    expect(ep.waiting).toContain('Waiting on you')
    expect(ep.waiting).toContain('premise-brief gate, round 1')
  })

  it('carries the wall onto the row as well as onto a card — it is about that episode', () => {
    wallEp01()
    expect(episode(floor(), 'ep01').wall).toContain('ep01 is blocked')
  })

  /**
   * Found by booting the app and looking at it, which is the only way this one was ever
   * going to turn up: ep01 sat at an open gate with a run stacked up behind it, and the row
   * said nothing at all about the queued work — because the queued run WAS the in-flight
   * one, and a guard meant to stop a run being named behind itself ate the only sentence
   * there was. It is the consequence of the very ruling the floor is asking for.
   */
  it('says what is queued behind a gate, because ruling it is what releases the work', async () => {
    await openAGateOnEp02()
    // A second run on the same episode: legal to ask for, and it waits (D7).
    const second = runner.enqueueRun({ episodeId: ep02, stage: SCRIPT_GATE_STAGE })

    const ep = episode(floor(), 'ep02')
    expect(ep.waiting).toContain('Waiting on you')
    expect(ep.queued).toContain('Queued behind your ruling')
    expect(ep.queued).toContain(SCRIPT_GATE_STAGE)
    expect(ep.queued).toContain('it starts when your ruling lets')
    expect(ep.queued).toContain('one run per episode, D7')
    expect(second.status).toBe('queued')
  })

  it('says what a run is thinking, off the event log, for an eye that arrived mid-run', async () => {
    const started = new Promise<string>((resolve) => {
      const stop = events.subscribe((record) => {
        if (record.kind === 'step-started' && record.episodeId === ep02) {
          stop()
          resolve(record.runId)
        }
      })
    })
    llm.reply('Dry Stores, in one paragraph.')
    for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    const runId = await started

    events.append({
      kind: 'step-progress',
      runId,
      episodeId: ep02,
      summary: 'Writing the ep02 premise — 1 of 1',
    })
    events.append({ kind: 'step-chunk', runId, episodeId: ep02, summary: 'The plant is loud ' })
    events.append({ kind: 'step-chunk', runId, episodeId: ep02, summary: 'in the way a thing is' })

    const live = episode(floor(), 'ep02').live!
    expect(live.runId).toBe(runId)
    expect(live.heading).toContain('running')
    expect(live.latest).toBe('Writing the ep02 premise — 1 of 1')
    expect(live.stream.join('')).toBe('The plant is loud in the way a thing is')

    await runner.settled(run.id)
  })
})

// ── The wire ────────────────────────────────────────────────────────────────────

describe('GET /api/floor', () => {
  it('answers with the floor and starts nothing — a read, at the home screen’s own address', async () => {
    await openAGateOnEp02()
    const app = createApp(paths, store, events, {
      runner,
      rulings,
      llm,
      readiness: () => READY,
    })

    const before = store.get<{ runs: number }>('SELECT COUNT(*) AS runs FROM run')!.runs
    const res = await app.request('/api/floor')
    expect(res.status).toBe(200)

    const view = (await res.json()) as ReturnType<typeof floorView>
    expect(view.shows[0]!.needsYou).toHaveLength(1)
    expect(view.shows[0]!.needsYou[0]!.kind).toBe('gate')
    expect(view.stream.kinds.length).toBeGreaterThan(0)
    // Opening the home screen rules nothing, runs nothing and spends nothing (invariant 5).
    expect(store.get<{ runs: number }>('SELECT COUNT(*) AS runs FROM run')!.runs).toBe(before)
  })

  it('is the room the shell now calls built, and no longer a stub', async () => {
    const app = createApp(paths, store, events, {
      runner,
      rulings,
      llm,
      readiness: () => READY,
    })
    const cockpit = (await (await app.request('/api/cockpit')).json()) as {
      destinations: { id: string; standing: string; notYetBecause: string | null; path: string }[]
    }
    const room = cockpit.destinations.find((one) => one.id === 'floor')!
    expect(room.standing).toBe('built')
    expect(room.notYetBecause).toBeNull()
    expect(room.path).toBe('/')
  })
})

// ── The two sentences the floor writes for itself ───────────────────────────────

describe('the phrases the cards are built out of', () => {
  it('counts as a phrase reads, including zero', () => {
    expect(count(0, 'finding')).toBe('no findings')
    expect(count(1, 'finding')).toBe('1 finding')
    expect(count(3, 'proposal')).toBe('3 proposals')
  })

  it('says how long something has been waiting in the coarsest unit still true', () => {
    const now = new Date('2026-08-11T12:00:00.000Z')
    expect(ago('2026-08-11T11:59:30.000Z', now)).toBe('just now')
    expect(ago('2026-08-11T11:22:00.000Z', now)).toBe('38 min ago')
    expect(ago('2026-08-11T04:00:00.000Z', now)).toBe('8 h ago')
    expect(ago('2026-08-08T12:00:00.000Z', now)).toBe('3 days ago')
    // A clock that has drifted backwards is not news the floor reports as negative time.
    expect(ago('2026-08-11T12:05:00.000Z', now)).toBe('just now')
  })
})

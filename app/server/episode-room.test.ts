import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from './db/store.ts'
import { artifactsOf } from './domain/artifact.ts'
import { runBoardRules } from './domain/board-rules.ts'
import { recordExtractedBoard } from './domain/board.ts'
import { factsOfEntity } from './domain/fact.ts'
import { episodesOf, scenesOf, seasonsOf } from './domain/spine.ts'
import { editScene, scenesToEdit } from './edit.ts'
import { episodeRoomView, type EpisodeRoomView } from './episode-room.ts'
import { createEventLog, type EventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { theLongPierExtraction } from './fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import { createRulings } from './runner/gate.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'
import { PREMISE_STAGE } from './runner/write-step.ts'

/**
 * **The episode room's read** (E5-2, #82; 5.2, D14).
 *
 * The whole of this file is one claim in several places: **the room composes three reads and
 * derives nothing they already say.** Every assertion below either checks that a sentence
 * arrived from the module that owns it — `panel.ts`'s verdict, `stage-wall.ts`'s wall,
 * `edit.ts`'s freshness, the stage's own declared cost — or that a door this room shows is
 * the same door the API refuses with.
 *
 * It runs against a REAL library volume with Grey Harbor **founded** in it, the real board
 * extraction and the real deterministic rules, and the fake backend in front of the model.
 * Nothing here reaches the network or spends a cent.
 */

const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
const NOTHING_FOUND = '{"findings": []}'

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let harbor: FoundedFixture
let ep01: string
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-room-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  createRulings(store, events, runner)

  const season = seasonsOf(store, harbor.show.id)[0]!
  const episodes = episodesOf(store, season.id)
  ep01 = episodes[0]!.id
  ep02 = episodes[1]!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const room = (episodeId: string = ep01): EpisodeRoomView =>
  episodeRoomView(store, paths, episodeId, READY)!

const factIn = (entity: string, needle: string): string =>
  factsOfEntity(store, harbor.entity(entity).id).find((fact) =>
    fact.statement.includes(needle),
  )!.id

/** The Long Pier's board, extracted, with the free deterministic rules run over it. */
function buildTheBoard(): void {
  const script = artifactsOf(store, ep01).find((one) => one.kind === 'script')!
  const board = recordExtractedBoard(store, {
    episodeId: ep01,
    scriptId: script.id,
    extraction: theLongPierExtraction({
      lockCycle: factIn('Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factIn('Halvani', 'loses consciousness'),
    }),
    filePath: 'greyharbor/s01e01/continuity-board-v1.md',
  })
  runBoardRules(store, board.artifact.id)
}

/** A real premise run on ep02: real cost rows, a real gate, and nothing spent. */
async function runThePremiseOnEp02(): Promise<void> {
  llm.reply('Tobin Wick reads the exchanger log and has to decide what to do about it.')
  for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
  const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
  await runner.settled(run.id)
}

// ── Trap 1 · the grid is the board, and it recomputes nothing ───────────────────

describe('the scene grid renders the board’s own rows and the board’s own verdicts', () => {
  it('renders one row per scene, with the board’s readings and nothing worked out here', () => {
    buildTheBoard()
    const grid = room().grid

    expect(grid.notYet).toBeNull()
    expect(grid.rows.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5, 6])
    // Every cell is a `board_scene` / `board_presence` row. Nothing is inferred from the script.
    expect(grid.rows[0]!.location).toBe('Mess deck')
    expect(grid.rows[0]!.present).toBe('Ilse Renn, Tobin Wick')
    expect(grid.rows[3]!.exposed).toBe(true)
    expect(grid.rows[3]!.environment).toBe('exposed')
    // 3.2b keeps environment and protection in two columns because one could not say both.
    expect(grid.rows[5]!.environment).toBe('hardsuit · exposed')
    expect(grid.rows[0]!.elapsed).toBe('06:10')
    // The crossings and the hazard the rules read, each citing the fact behind it.
    expect(grid.transits.length).toBeGreaterThan(0)
    expect(grid.hazards.map((hazard) => hazard.sentence)).toEqual(['Halvani — lethal-in-vacuum'])
    expect(grid.hazards[0]!.factId).toBe(factIn('Halvani', 'loses consciousness'))
  })

  /**
   * The grid's health is `panel.ts`'s verdict word and `panel.ts`'s own sentence, with
   * `check-bench.ts`'s sentence for what would answer a row that is not an answer yet. The
   * assertion is deliberately a string equality against the bench: if the room ever starts
   * WORDING a verdict, this fails.
   */
  it('says the grid’s health in the words panel.ts wrote them, never in words of its own', () => {
    buildTheBoard()
    const view = room()
    const bench = view.checks.rows.filter((row) => row.row.tier === 'deterministic')

    expect(view.grid.health.map((one) => one.checkKey).sort()).toEqual([
      'dual-presence',
      'duplicate-arrival',
      'impossible-adjacency',
      'vacuum-without-protection',
    ])
    expect(view.grid.health).toEqual(
      bench.map((row) => ({
        checkKey: row.row.checkKey,
        verdict: row.row.verdict,
        what: row.row.what,
        fix: row.fix,
      })),
    )
    // The two planted contradictions are `found`, with severity and confidence in the sentence.
    const vacuum = view.grid.health.find((one) => one.checkKey === 'vacuum-without-protection')!
    expect(vacuum.verdict).toBe('found')
    expect(vacuum.what).toContain('severity high · confidence certain · scene 4')
    // And the board's own one-line sentence is the verdict board's, whole.
    expect(view.grid.sentence).toBe(view.checks.board.sentence)
  })

  it('renders the deterministic verdicts where a rule meets a scene, with D12’s sentence on them', () => {
    buildTheBoard()
    const grid = room().grid

    const four = grid.rows[3]!
    expect(four.verdicts.map((say) => say.checkKey)).toEqual(['vacuum-without-protection'])
    expect(four.verdicts[0]!.blocking).toBe(true)
    // The wall's own sentence, quoted — so a red mark here can never read as a veto at a gate.
    expect(four.verdicts[0]!.blockingSentence).toContain(
      'Blocks the next stage until it is resolved, and never this gate (D12)',
    )
    expect(grid.rows[5]!.verdicts.map((say) => say.checkKey)).toEqual(['dual-presence'])
    // A scene nothing argued with says nothing. Silence here is an absence of findings, and
    // the measured silence is on the health row above, which is where D11's denominator lives.
    expect(grid.rows[0]!.verdicts).toEqual([])
  })

  /**
   * A board that has moved past its source renders `stale` in the freshness sentence AND in
   * the rows' own verdicts — both computed, neither remembered (1.3, and `panel.ts`).
   */
  it('says the board is stale in edit.ts’s words when the script has moved past it', () => {
    buildTheBoard()
    const script = artifactsOf(store, ep01).find((one) => one.kind === 'script')!
    const three = scenesToEdit(store, paths, script.id)[2]!
    editScene(store, paths, {
      artifactId: script.id,
      sceneId: three.sceneId,
      text: `${three.text}\nOne more line.\n`,
    })

    const grid = room().grid
    expect(grid.stale).toBe(true)
    expect(grid.standing).toBe('stale')
    expect(grid.freshness).toContain('you edited scene 3 by hand')
    expect(grid.freshness).toContain('stale until something is written from what the script says now')
    // And the deterministic rows say the same thing in `panel.ts`'s words, with the fix.
    const health = grid.health.find((one) => one.verdict === 'stale')!
    expect(health.what).toContain('re-run the board rules, they cost nothing')
    expect(health.fix).toContain('costs nothing')
  })

  it('renders the honest not-yet state and the priced button that builds a board', () => {
    // ep01 is founded with a script and no board — the fixture's own state.
    const grid = room().grid
    expect(grid.rows).toEqual([])
    expect(grid.notYet!.lead).toBe('No continuity board yet.')
    expect(grid.notYet!.sentence).toContain('an empty grid is not a clean one')
    expect(grid.notYet!.stage).toBe('continuity-board')
    expect(grid.notYet!.build.enabled).toBe(true)
    expect(grid.notYet!.build.cost).toContain('your money, spent when you click')
    expect(grid.standing).toBe('no board')

    // ep02 has no script to read, so the same button is refused in the stage's own words.
    const two = room(ep02).grid
    expect(two.notYet!.build.enabled).toBe(false)
    expect(two.notYet!.build.blockedBecause).toContain('has no script to read')
  })
})

// ── Trap 5 · the scene door reaches the grid, and it is composition ─────────────

describe('every scene of the grid carries D14’s edit door', () => {
  it('opens the scene’s own span, and lands it through edit.ts’s one motion', () => {
    buildTheBoard()
    const before = room().grid
    const three = before.rows[2]!

    expect(three.edit.enabled).toBe(true)
    expect(three.edit.cost).toBe('No model call · $0.00')
    expect(three.edit.sentence).toContain('Edit scene 3 of the ep01 script yourself')
    expect(three.text).toContain(scenesOf(store, ep01)[2]!.heading)
    expect(three.text).not.toContain(scenesOf(store, ep01)[3]!.heading)

    const landed = editScene(store, paths, {
      artifactId: room().checks.artifact.id,
      sceneId: three.sceneId,
      text: `${three.text.trimEnd()}\n\nHe says nothing about the lock at all.\n\n`,
    })

    // The one motion's receipt, and the touched scene named — not a new write path. Both
    // halves of the free tier ran: the canon-graph checks over the new draft, AND the board
    // rules over the board this script was read into (`readItForFree`).
    expect(landed.version).toBe(2)
    expect(landed.read.map((pass) => pass.checkKey)).toEqual([
      'stale-exception',
      'retired-reappearance',
      'dual-presence',
      'impossible-adjacency',
      'duplicate-arrival',
      'vacuum-without-protection',
    ])
    expect(landed.touchedScene!.ordinal).toBe(3)
    expect(landed.sentence).toContain('You typed over scene 3')

    // And the room re-reads it: the script is at v2 and the board it fed is stale.
    const after = room()
    expect(after.artifacts.find((one) => one.kind === 'script')!.version).toBe(2)
    expect(after.artifacts.find((one) => one.kind === 'continuity-board')!.stale).toBe(true)
    expect(
      readFileSync(join(paths.artifactDir, 'greyharbor/s01e01/script-v2.md'), 'utf8'),
    ).toContain('He says nothing about the lock at all.')
  })

  it('hands down the refusal the page needs, so an empty box is refused in one string', () => {
    const view = room()
    expect(view.refusals.needsText).toContain('an empty box is not a deletion you meant')
  })
})

// ── Trap 2 · every door ruled elsewhere is a LINK, at the room that rules it ────

describe('the room links to the rooms that own the decisions it does not', () => {
  it('sends a gate to the gate room, carrying that room’s own honesty about itself', async () => {
    await runThePremiseOnEp02()
    const view = room(ep02)

    expect(view.rail.noGates).toBeNull()
    const gate = view.rail.gates[0]!
    expect(gate.href).toBe(`/gate/${gate.gateId}`)
    expect(gate.room).toBe('the gate room')
    // Off `cockpit.ts`, the same list the shell draws its bar from, so this room can never
    // point at a door the bar does not have. E5-3 built it, so there is nothing left for the
    // link to be honest ABOUT — a room that still named the issue that builds it while being
    // built would be the honesty this field exists for, disagreeing with itself.
    expect(gate.roomNotYet).toBeNull()
    expect(gate.isOpen).toBe(true)
    expect(gate.standing).toContain('Open at round 1, waiting on you')
    expect(gate.open.sentence).toContain('Rule on the ep02 premise-brief')
    // Going there spends nothing. What a VERDICT buys is priced at the gate, on its button.
    expect(gate.open.cost).toContain('$0.00 to open it')
  })

  it('sends the floor and every arc to their own rooms, and says which room each is', () => {
    const view = room()

    expect(view.floorHref).toBe('/')
    expect(view.floorName).toBe('the floor')
    const arc = view.arcs[0]!
    expect(arc.href).toBe(`/arc/${arc.arcId}`)
    expect(arc.room).toBe('the arc page')
    // Built by E5-5 (#85), so the link goes somewhere and carries no apology with it. The
    // room's standing is read off `cockpit.ts` rather than restated here, which is what makes
    // building a room and this sentence changing the same fact said once.
    expect(arc.roomNotYet).toBeNull()
  })

  /**
   * The pin is drawn and a LANDING is not, and that is D8 rather than an omission: only
   * ratifying a landing proposal makes "this arc reached waypoint 2 in ep01" a fact. A chain
   * that painted the earlier waypoints as done would be asserting facts nobody ruled.
   */
  it('draws the pin and never claims a waypoint has landed', () => {
    const arc = room().arcs[0]!

    expect(arc.kindAndScope).toBe('character · season')
    expect(arc.waypoints.map((one) => `${one.ordinal}:${one.standing}`)).toEqual([
      '1:ahead',
      '2:here',
      '3:ahead',
    ])
    expect(arc.note).toContain('A pin is not a landing')
    // The door that moves it is `canon-bench.ts`'s own offer, with its own refusals on it.
    expect(arc.waypoints[0]!.declare.sentence).toContain('Declare ep01 at waypoint 1')
    expect(arc.waypoints[1]!.declare.sentence).toContain('Re-declare ep01 at waypoint 2')
  })

  it('says the wall on the rail in the same sentence the producing buttons are refused with', () => {
    buildTheBoard()
    const view = room()

    expect(view.rail.wall).toContain('ep01 is blocked')
    expect(view.rail.wall).toContain('vacuum-without-protection')
    // The same string, both places — the room and the disabled button cannot drift (D12).
    expect(view.rail.wall).toBe(view.writing.wall)
    expect(view.rail.wall).toBe(view.checks.wall)
  })

  it('offers every stage the catalogue has, in its order, with the wall on the ones it refuses', () => {
    buildTheBoard()
    const rail = room().rail

    expect(rail.stages.map((one) => one.stage)).toEqual([
      'write-the-premise',
      'write-the-outline',
      'write-the-script',
      'continuity-board',
      'continuity-board-checks',
      'text-checks',
      'premise-gate',
      'outline-gate',
      'script-gate',
    ])
    // A reading stage is never walled — the wall's own way out is re-running the free checks.
    expect(rail.stages.find((one) => one.stage === 'continuity-board-checks')!.offer.enabled).toBe(
      true,
    )
    expect(rail.stages.every((one) => one.work === 'produces' || one.work === 'reads')).toBe(true)
  })
})

// ── Trap 6 · the ledger is projection against actual, and nothing new ───────────

describe('the ledger renders what a button projected against what the rows recorded', () => {
  it('itemises the run’s spend under its stage, beside that stage’s own declared cost', async () => {
    await runThePremiseOnEp02()
    const ledger = room(ep02).ledger

    expect(ledger.lines).toHaveLength(1)
    const line = ledger.lines[0]!
    expect(line.label).toBe('write-the-premise')
    // What the rows recorded: the draft's call plus one per reviewer the panel convened,
    // through the fake backend and the same `chargeLLMCall` production uses.
    expect(line.calls).toBeGreaterThan(1)
    expect(line.detail).toBe(`${line.calls} calls`)
    expect(line.microDollars).toBeGreaterThan(0)
    // One run, so the line IS the total — the lines add up to it by construction.
    expect(line.spent).toBe(ledger.spent)
    // What the button projected: the stage's own declaration, never a number this room works out.
    expect(line.projected).toContain('Opus call')
    expect(line.projected).toContain('your money, spent when you click')

    // And the total is `cost.ts`'s, in `spentSentence`'s words.
    expect(ledger.totals.calls).toBe(line.calls)
    expect(ledger.sentence).toContain(`${line.calls} calls`)
  })

  it('prices a failed call and says so, rather than folding it into the count', async () => {
    // A call that came back wrong still spent. `chargeFailedLLMCall` files the row.
    llm.reply({ fails: 'the model went quiet', usage: { uncachedInput: 900, output: 100 } })
    llm.reply('Tobin Wick reads the exchanger log and has to decide what to do about it.')
    for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(run.id)

    const line = room(ep02).ledger.lines[0]!
    expect(line.failed).toBe(1)
    expect(line.detail).toContain('1 of them failed and cost money anyway')
    expect(room(ep02).ledger.sentence).toContain('1 of them failed and cost money anyway')
  })

  it('quotes what is still offerable rather than summing it, and names what is not in this build', () => {
    const ledger = room().ledger

    expect(ledger.lines).toEqual([])
    expect(ledger.sentence).toBe('nothing spent — no call was made')
    expect(ledger.spent).toBe('$0.00')
    // Every price in the projection is a stage's own sentence. Adding them up would be the
    // new cost computation this room may not invent.
    expect(ledger.projection).toContain('continuity-board — 1 Opus call')
    expect(ledger.projection).toContain('text-checks — 10 Opus calls')
    expect(ledger.projection).toContain('nothing in this build produces assets')
  })
})

// ── Trap 4 · the pip's three ruled states, from the floor's own composer ────────

describe('the lifecycle track wears the states Ryan ruled, not the ones this mockup drew', () => {
  it('marks the stage the episode is at as CURRENT while nothing is running', () => {
    const view = room()

    expect(view.track.map((stop) => `${stop.stage}:${stop.standing}`)).toEqual([
      'premise:done',
      'outline:done',
      'script:current',
      'assets:ahead',
      'assembled:ahead',
      'published:ahead',
    ])
    // Amber means his hand and blue means in flight; a merely-current stage is never running.
    expect(view.track.filter((stop) => stop.standing === 'running')).toEqual([])
    expect(view.track[2]!.sentence).toBe('script — the stage this episode is at, and yours to move')
  })

  it('says the track is of THIS episode, because the component refuses a label-less track', () => {
    expect(room().trackLabel).toBe('ep01 The Long Pier — premise through published')
  })
})

// ── The three wires arrive whole, and the room adds no fourth ───────────────────

describe('the room hands down the three reads whole', () => {
  it('carries the writing room, the check bench and the sweep without re-deriving one', () => {
    buildTheBoard()
    const view = room()

    // The desk, given its cockpit home (E4-7's one new render) — three of them, one per step.
    expect(view.writing.line.map((step) => step.step)).toEqual(['premise', 'outline', 'script'])
    expect(view.writing.line[0]!.desk.entities.length).toBeGreaterThan(0)
    expect(view.writing.line[0]!.desk.promptCaveat).toContain('round 1')
    // D11's record, which is a show's question and not an episode's.
    expect(view.checks.record.length).toBeGreaterThan(0)
    // The sweep, whether it is owed or not — "swept" is a sentence, never a column.
    expect(view.sweep.owed).toBe(false)
    expect(view.sweep.nothingBecause).toContain('Nothing has ever ridden ep01’s writing')
  })

  it('renders every artifact with freshness in words, and both doors on the ones he writes', () => {
    buildTheBoard()
    const view = room()

    expect(view.noArtifacts).toBeNull()
    expect(view.artifacts.map((one) => one.kind).sort()).toEqual([
      'continuity-board',
      'outline',
      'premise-brief',
      'script',
    ])
    const script = view.artifacts.find((one) => one.kind === 'script')!
    expect(script.standing).toBe('fresh')
    expect(script.because).toContain('Nothing it was built from has moved since')
    expect(script.edit.enabled).toBe(true)
    expect(script.present!.enabled).toBe(true)
    expect(script.presentStage).toBe('script-gate')

    // A derived kind gets the edit door DISABLED with its reason, rather than no door at all.
    const board = view.artifacts.find((one) => one.kind === 'continuity-board')!
    expect(board.edit.enabled).toBe(false)
    expect(board.edit.blockedBecause).toContain('is not written by hand')
    expect(board.present).toBeNull()
  })

  it('says nothing has been written yet, with the first stage’s own offer as the way out', () => {
    const view = room(ep02)

    expect(view.artifacts).toEqual([])
    expect(view.noArtifacts!.lead).toBe('Nothing has been written for ep02 yet.')
    expect(view.noArtifacts!.sentence).toContain('Write the ep02 premise-brief')
    expect(view.rail.noGates!.lead).toBe('No gate has ever opened on ep02.')

    // The arcs of the show are still drawn, with every waypoint ahead and the door that would
    // pin one — an episode touching no arc is VANILLA, which is a standing rather than a gap
    // (1.1), so the panel says which arcs it could stand on rather than going blank.
    expect(view.noArcs).toBeNull()
    expect(view.arcs[0]!.waypoints.map((one) => one.standing)).toEqual(['ahead', 'ahead', 'ahead'])
    expect(view.arcs[0]!.note).toContain('vanilla')
    expect(view.standing).toContain('vanilla')
  })
})

// ── Live: the idle box holds its shape, and the protocol is the floor's ─────────

describe('the live region is a state rather than an absence', () => {
  it('renders idle with a heading when nothing has ever run', () => {
    const live = room().live

    expect(live.idle).toBe(true)
    expect(live.runId).toBeNull()
    expect(live.heading).toBe('Nothing has ever run on ep01')
    expect(live.entries).toEqual([])
  })

  it('renders the finished run’s own transitions, and the seq the prose is as of', async () => {
    await runThePremiseOnEp02()
    const live = room(ep02).live

    expect(live.idle).toBe(true)
    expect(live.runId).not.toBeNull()
    expect(live.heading).toContain('write-the-premise on ep02')
    expect(live.entries.length).toBeGreaterThan(0)
    // Ordered by the monotonic seq, never by the timestamp (`events.ts`).
    expect(live.entries.map((entry) => entry.seq)).toEqual(
      [...live.entries.map((entry) => entry.seq)].sort((a, b) => a - b),
    )
    // The dedup position E5-1's protocol needs: the browser drops anything at or below it.
    expect(live.seq).toBeGreaterThan(0)
  })

  it('hands over the stream’s kinds and the position this read was taken from', () => {
    const view = room()
    expect(view.stream.kinds.length).toBeGreaterThan(0)
    expect(view.stream.prose.length).toBeGreaterThan(0)
    expect(view.stream.since).toBe(0)
  })
})

describe('a room for an episode this library does not have', () => {
  it('is undefined, so the API can answer 404 with it', () => {
    expect(episodeRoomView(store, paths, 'ep_nope', READY)).toBeUndefined()
  })
})

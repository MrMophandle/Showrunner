import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { declareEpisodePosition } from './canon-bench.ts'
import type { Store } from './db/store.ts'
import { arcsOf, positionsOf, waypointsOf } from './domain/arc.ts'
import { artifactsOf, type Artifact } from './domain/artifact.ts'
import { abandonEpisode, sweepEpisode } from './domain/episode-canon.ts'
import { canonAsOf, factsOfEntity, findFact, rulingsOfShow } from './domain/fact.ts'
import { openProposals, findProposal, raiseProposal } from './domain/proposal.ts'
import { createEpisode, episodesOf, findEpisode, seasonsOf } from './domain/spine.ts'
import { categoryChecksFor, composeTextCheck } from './domain/text-check.ts'
import { composeWriteContext } from './domain/write-context.ts'
import { createEventLog, type EventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import { operatingView } from './operating.ts'
import { createRulings, openGates, type Rulings } from './runner/gate.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'
import { OUTLINE_STAGE, PREMISE_STAGE, SCRIPT_STAGE } from './runner/write-step.ts'
import { sweepView, type SweepView } from './sweep.ts'

/**
 * **The completion sweep** (E4-6, #66; 1.2, 3.3) — the ruling pass an approved episode owes
 * canon, and the first real caller `sweepEpisode` has ever had.
 *
 * Everything here runs the REAL stages through the REAL runner against a REAL library volume
 * with Grey Harbor **founded** in it, and the fake backend in front of the model — so the
 * riders Ryan rules are the ones E4-4's extraction actually raised out of a script he actually
 * approved, rather than proposals a test wrote by hand. No test in this repo may spend a cent
 * (fixtures before features).
 *
 * Its first job is the reconciliation `sweep.ts`'s header argues, tested rather than asserted:
 * **at the moment the script gate renders, the riders do not exist**, so the pass cannot live
 * inside that gate — it stands OWED once the approval has carried the run through the
 * extraction, and Ryan makes it from the episode, one rider at a time.
 */

const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
let app: ReturnType<typeof createApp>
let harbor: FoundedFixture
let ep02: string
let ep03: string

// ── What the fake writes ────────────────────────────────────────────────────────

const PREMISE = [
  'The water plant’s exchanger fails three weeks after Ilse Renn took its spare for the beacon.',
  'Tobin Wick is the one who reads the temperature log, and the one who has to decide what to',
  'do about having read it.',
].join('\n')

const PREMISE_PANEL = 3

const OUTLINE = [
  '## Morning, dry',
  '',
  'Tobin Wick reads the exchanger log at Grey Harbor Station and says out loud what it means.',
  '',
  '## The drawer',
  '',
  'Tobin goes for the spare and the drawer is empty. Ilse Renn answers him with the roster.',
  '',
  '## Dry stores',
  '',
  'By the end the water is rationed and nobody has said whose fault it is.',
].join('\n')

const OUTLINE_PANEL = 5

/** The three lines the extraction quotes: one per rider it raises. */
const LEDGER_LINE = 'the diversion is written up in her own hand in the back of the spares ledger'
const KEYS_LINE = 'Tobin Wick carries the plant keys on the same ring as his own.'
const LANDING_LINE = 'The roster says you are on the plant at seven.'

const SCRIPT = [
  '# Dry Stores — script',
  '',
  '## 1 · INT. WATER PLANT — 05:50',
  '',
  '> Tobin reads the exchanger log and says what it means out loud.',
  '',
  'The plant is loud in the way a thing is loud when it is working. TOBIN WICK has the',
  'temperature log open on the housing.',
  '',
  `${KEYS_LINE}`,
  '',
  'TOBIN',
  'It has been climbing three weeks.',
  '',
  "## 2 · INT. HARBOURMASTER'S OFFICE — 06:30",
  '',
  '> Ilse is asked where the spare went, and answers with the roster.',
  '',
  'Ilse Renn is at the desk at Grey Harbor Station. The spares drawer is open and empty, and',
  `${LEDGER_LINE}.`,
  '',
  'ILSE',
  `${LANDING_LINE}`,
  '',
  '## 3 · INT. DRY STORES — 18:00',
  '',
  '> The water goes on ration and nobody says whose fault it is.',
  '',
  'Ilse Renn writes the ration up on the board and does not sign it.',
].join('\n')

const SCRIPT_PANEL = 6

const NOTHING_FOUND = '{"findings": []}'

/** The two statements the two fact deltas would write, and the arc the landing would land. */
const HER_LEDGER = 'Ilse writes her diversions into the back of the spares ledger by hand.'
const HIS_KEYS = 'Tobin Wick keeps the water plant keys on his own key ring.'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-sweep-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)
  app = createApp(paths, store, events, {
    runner,
    rulings,
    llm,
    readiness: () => READY,
  })

  const season = seasonsOf(store, harbor.show.id)[0]!
  const episodes = episodesOf(store, season.id)
  ep02 = episodes[1]!.id
  ep03 = createEpisode(store, { seasonId: season.id, number: 3, title: 'Slack Water' }).id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

// ── Getting ep02 to three standing riders, the way Ryan would ───────────────────

function queueRound(draft: string, panel: number, ...said: string[]): void {
  llm.reply(draft)
  const answers = [...said]
  while (answers.length < panel) answers.push(NOTHING_FOUND)
  for (const answer of answers) llm.reply(answer)
}

/** One more reviewer convenes per declared arc position — read off the rows, never counted twice. */
const panel = (base: number): number => base + positionsOf(store, ep02).length

async function ruleThePremiseAndTheOutline(): Promise<void> {
  queueRound(PREMISE, panel(PREMISE_PANEL))
  const premise = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
  await runner.settled(premise.id)
  rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that is the episode.' })
  await runner.settled(premise.id)

  queueRound(OUTLINE, panel(OUTLINE_PANEL))
  const outline = runner.enqueueRun({ episodeId: ep02, stage: OUTLINE_STAGE })
  await runner.settled(outline.id)
  rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that is the shape.' })
  await runner.settled(outline.id)
}

/** Writes the ep02 script and leaves it at its gate, unruled. */
async function writeTheScript(): Promise<string> {
  queueRound(SCRIPT, panel(SCRIPT_PANEL))
  const run = runner.enqueueRun({ episodeId: ep02, stage: SCRIPT_STAGE })
  const settled = await runner.settled(run.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? 'the run failed')
  return run.id
}

/** The pin, declared the only way this app declares one — through the bench's door (E4-4). */
function declareWaypointTwo(): { arcId: string; waypointId: string } {
  const arc = arcsOf(store, harbor.show.id)[0]!
  const waypoint = waypointsOf(store, arc.id).find((one) => one.ordinal === 2)!
  declareEpisodePosition(store, { episodeId: ep02, arcId: arc.id, waypointId: waypoint.id })
  return { arcId: arc.id, waypointId: waypoint.id }
}

const factOf = (name: string, needle: string) =>
  factsOfEntity(store, harbor.entity(name).id).find((fact) => fact.statement.includes(needle))!

/** Two claims and a landing: a contradiction, an addition, and the waypoint ep02 is pinned to. */
function theExtraction(arcId: string): string {
  return JSON.stringify({
    claims: [
      {
        entity: 'Ilse Renn',
        statement: HER_LEDGER,
        field: 'record-keeping',
        quote: LEDGER_LINE,
        contradicts: factOf('Ilse Renn', 'never filed a diversion').id,
      },
      { entity: 'Tobin Wick', statement: HIS_KEYS, quote: KEYS_LINE },
    ],
    landings: [{ arc: arcId, subject: 'Ilse Renn', quote: LANDING_LINE }],
  })
}

/**
 * ep02 written, pinned, approved and read — the state every test below starts from, and the
 * only way this app produces it. **Three proposals ride ep02 when this returns**, and not one
 * of them has been ruled.
 */
async function threeRidersOnEp02(): Promise<void> {
  const { arcId } = declareWaypointTwo()
  await ruleThePremiseAndTheOutline()
  const runId = await writeTheScript()
  llm.reply(theExtraction(arcId))
  rulings.approve(openGates(store)[0]!.gate.id, { comment: 'shoot it.' })
  await runner.settled(runId)
}

// ── Reading ─────────────────────────────────────────────────────────────────────

const script = (): Artifact => artifactsOf(store, ep02).find((one) => one.kind === 'script')!

const sweep = (episodeId: string = ep02): SweepView => sweepView(store, episodeId)!

/** The card's own sentence, off the real operating view. Null while nothing rides. */
const cardSweep = (episodeId: string = ep02) =>
  operatingView(store, paths, READY)
    .shows.flatMap((show) => show.episodes)
    .find((episode) => episode.id === episodeId)!.sweep

const riderFor = (statement: string) =>
  sweep().riders.find((rider) => rider.change.some((line) => line.includes(statement)))!

const landingRider = () => sweep().riders.find((rider) => rider.kind === 'landing')!

/** Every ruling this show's canon has moved by, newest first — the ledger itself. */
const ledger = () => rulingsOfShow(store, harbor.show.id)

async function ruleFromTheSweep(
  proposalId: string,
  verdict: 'ratify' | 'reject' | 'defer',
  note: string,
): Promise<Response> {
  return app.request(`/api/sweep/proposal/${proposalId}/${verdict}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  })
}

// ── Trap 1: the reconciliation, tested rather than asserted ─────────────────────

describe('the sweep is the pass owed AFTER the approval, and not the gate’s own payload', () => {
  it('finds nothing at the moment the script gate renders — the riders do not exist yet', async () => {
    declareWaypointTwo()
    await ruleThePremiseAndTheOutline()
    await writeTheScript()

    // The draft is at its gate, waiting on Ryan. E4-4 put the extraction on the FAR SIDE of
    // this ruling, so the proposals it will raise have not been raised: a sweep convened from
    // inside this gate would present an empty pass and then have nothing to say about the
    // stack that lands a second later. That is the whole reason the spec sentence and E4-4's
    // order cannot both be literal (`sweep.ts`).
    expect(openGates(store)).toHaveLength(1)
    expect(sweep().owed).toBe(false)
    expect(sweep().riders).toEqual([])
    expect(sweep().nothingBecause).toContain('Nothing has ever ridden ep02’s writing')
    expect(cardSweep()).toBeNull()
  })

  it('stands owed the moment the approval has carried the run through the extraction', async () => {
    await threeRidersOnEp02()

    // The approval moved the episode on (E4-1's seam, untouched) AND left the pass owed. The
    // two are separate facts about one ruling, which is what "episode approval is complete
    // when the pass is" means in rows.
    expect(findEpisode(store, ep02)!.lifecycle).toBe('assets')
    expect(sweep().owed).toBe(true)
    expect(sweep().riders).toHaveLength(3)
    expect(sweep().riders.map((rider) => rider.kind)).toEqual([
      'fact-delta',
      'fact-delta',
      'landing',
    ])
    expect(sweep().sentence).toBe(
      'ep02 carries 3 proposals to rule — 2 fact deltas, 1 waypoint landing. They ride ep02 ' +
        'until you rule them, one at a time — approving the script was not a ruling on any of them.',
    )
  })

  it('presents each rider with its own blast radius, computed at read and never stored', async () => {
    await threeRidersOnEp02()
    const rider = riderFor(HER_LEDGER).id

    // The contradiction reaches the ratified fact it argues with, BY NAME. Nothing wrote that
    // down when the proposal was raised: it is computed off canon as it stands now (1.2).
    expect(riderFor(HER_LEDGER).implications).toContain('touches 1 ratified fact')
    expect(riderFor(HER_LEDGER).implications).toContain('never filed a diversion')
    // The addition argues with nothing standing and says so instead of naming a fact.
    expect(riderFor(HIS_KEYS).implications).not.toContain('ratified fact')
    // Every rider carries one, and one of its own.
    expect(sweep().riders.every((one) => one.implications !== '')).toBe(true)

    // **Read time, proven by moving the ground under it.** Ratifying closes the fact this
    // radius named and opens its successor, and the SAME proposal's radius now names the
    // AFTER where it named the before — with nothing rewritten anywhere, because there was
    // nothing written down to rewrite. A stored radius would still be arguing with a fact
    // that is no longer what canon says, silently, under Ryan's hand (1.2).
    await ruleFromTheSweep(rider, 'ratify', 'yes — she keeps it herself.')
    const ruled = sweep().ruled.find((one) => one.id === rider)!
    expect(ruled.implications).not.toContain('never filed a diversion')
    expect(ruled.implications).toContain(`touches 1 ratified fact (ep02: “${HER_LEDGER}”)`)
  })
})

// ── Trap 3: one at a time is the whole ceremony ─────────────────────────────────

describe('one at a time is the whole ceremony', () => {
  it('rules three riders separately — three rulings, three rows, one disposition each', async () => {
    await threeRidersOnEp02()
    const before = ledger().length
    const [first, second, third] = sweep().riders.map((rider) => rider.id)

    const one = await ruleFromTheSweep(first!, 'ratify', 'yes — she does keep it herself.')
    expect(one.status).toBe(200)
    expect(((await one.json()) as SweepView).riders).toHaveLength(2)

    const two = await ruleFromTheSweep(second!, 'reject', 'no. That is not his ring, it is hers.')
    expect(two.status).toBe(200)
    expect(((await two.json()) as SweepView).riders).toHaveLength(1)

    const three = await ruleFromTheSweep(third!, 'defer', 'not until ep03 shows me the money.')
    expect(three.status).toBe(200)
    const done = (await three.json()) as SweepView

    // Three rulings, three rows, in the order he made them — and every disposition kept.
    expect(ledger()).toHaveLength(before + 3)
    const made = ledger()
      .filter((ruling) => [first, second, third].includes(ruling.proposalId ?? ''))
      .sort((a, b) => a.seq - b.seq)
    expect(made.map((ruling) => [ruling.proposalId, ruling.kind, ruling.note])).toEqual([
      [first, 'ratification', 'yes — she does keep it herself.'],
      [second, 'rejection', 'no. That is not his ring, it is hers.'],
      [third, 'deferral', 'not until ep03 shows me the money.'],
    ])
    // Each row is its own seq: nothing here disposed of two proposals at one ruling.
    expect(new Set(made.map((ruling) => ruling.seq)).size).toBe(3)
    // Convened away from a gate, like the bench's own — so `event.run_id` has nothing to hang
    // on, `announce` returns without appending, and the ledger is the whole record (#29).
    expect(made.map((ruling) => ruling.gateId)).toEqual([null, null, null])
    expect(store.all("SELECT seq FROM event WHERE kind LIKE 'proposal-%'")).toEqual([])

    expect(done.owed).toBe(false)
    expect(done.riders).toEqual([])
    expect(done.ruled.map((rider) => rider.status)).toEqual(['ratified', 'rejected', 'deferred'])
    expect(done.sentence).toBe('ep02 carries nothing left to rule.')
    expect(done.nothingBecause).toContain('3 of them, each on its own row of the ledger')
  })

  it('has no bulk verb on the pass, and no route that rules one', async () => {
    await threeRidersOnEp02()

    // Every verb on this pass belongs to one rider. There is no fourth key anywhere on the
    // view, and nothing on it takes a list.
    for (const rider of sweep().riders) {
      expect(Object.keys(rider).filter((key) => ['ratify', 'reject', 'defer'].includes(key)))
        .toHaveLength(3)
    }
    expect(Object.keys(sweep())).toEqual([
      'episode',
      'show',
      'owed',
      'riders',
      'ruled',
      'sentence',
      'nothingBecause',
      'refusals',
    ])

    // And the API has nothing to press either. A bulk approve is not a route this build
    // refuses — it is a route this build does not have.
    for (const bulk of ['ratify-all', 'approve-all', 'rule-all']) {
      const res = await app.request(`/api/sweep/${ep02}/${bulk}`, { method: 'POST' })
      expect(res.status).toBe(404)
    }
    expect(sweep().riders).toHaveLength(3)
  })

  it('refuses a second ruling on a rider already ruled, in the ledger’s own words', async () => {
    await threeRidersOnEp02()
    const rider = sweep().riders[0]!.id

    expect((await ruleFromTheSweep(rider, 'ratify', 'yes.')).status).toBe(200)
    const again = await ruleFromTheSweep(rider, 'reject', 'actually no.')

    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toMatch(
      /was ratified at ruling \d+, and a proposal is ruled once/,
    )
  })

  it('refuses a rejection with nothing typed in the box — one string, two readers', async () => {
    await threeRidersOnEp02()
    const rider = sweep().riders[0]!.id

    const refused = await ruleFromTheSweep(rider, 'reject', '   ')

    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toBe(
      sweep().refusals.rejectNeedsNote,
    )
    expect(findProposal(store, rider)!.status).toBe('raised')
  })
})

// ── Trap 5: ratifying a rider flips every reader, together ─────────────────────

describe('ratifying a rider flips every reader at once', () => {
  it('moves canonAsOf, ep03’s desk and ep02’s own checks across the one ruling', async () => {
    await threeRidersOnEp02()
    const ilse = harbor.entity('Ilse Renn').id
    const rider = riderFor(HER_LEDGER).id
    const claimed = findProposal(store, rider)!.change.facts[0]!.factId!

    // ── Before ──────────────────────────────────────────────────────────────
    // Canon still says what it said: the claim is provisional and invisible to `canonAsOf`.
    expect(statements(canonAsOf(store, { entityId: ilse }, 'now'))).not.toContain(HER_LEDGER)
    expect(findFact(store, claimed)!.status).toBe('provisional')
    // ep03's writer is not handed it at all — a provisional claim reaches the desk of the
    // episode it rides and no other (`write-context.ts`).
    expect(deskFacts(ep03, ilse)).not.toContain(HER_LEDGER)
    // ep02's own checks DO see it, and see it as a claim: that is what "riding" means (3.3).
    expect(checkScope(ilse).map((fact) => fact.status)).toContain('provisional')
    expect(checkScope(ilse).find((fact) => fact.statement === HER_LEDGER)!.ratifiedBy).toBeNull()

    const res = await ruleFromTheSweep(rider, 'ratify', 'yes — she has kept it that way.')
    expect(res.status).toBe(200)
    const at = findProposal(store, rider)!.disposition!.seq

    // ── After: all three readers, moved by the one ruling ───────────────────
    // 1. canonAsOf — in from that ruling on, and out on the tick before it (D9).
    expect(statements(canonAsOf(store, { entityId: ilse }, 'now'))).toContain(HER_LEDGER)
    expect(statements(canonAsOf(store, { entityId: ilse }, { ruling: at - 1 }))).not.toContain(
      HER_LEDGER,
    )
    // 2. ep03's desk — the fact now reaches a LATER episode's writer, as canon already on
    //    screen. Its lineage is what makes that answerable.
    expect(deskFacts(ep03, ilse)).toContain(HER_LEDGER)
    expect(deskReach(ep03, ilse, HER_LEDGER)).toBe('established-earlier')
    // 3. ep02's checks — the same words, read as canon rather than as a claim. Rows are
    //    immutable: the provisional row closed and a ratified successor opened at the ruling.
    const inScope = checkScope(ilse).find((fact) => fact.statement === HER_LEDGER)!
    expect(inScope.status).toBe('ratified')
    expect(inScope.ratifiedBy).toBe(at)
    expect(inScope.id).not.toBe(claimed)
    expect(findFact(store, claimed)!.status).toBe('superseded')
    expect(findFact(store, claimed)!.closure!.supersededBy).toBe(inScope.id)

    // Lineage, in both halves: established in ep02, ratified at this ruling.
    expect(inScope.establishedIn).toBe(ep02)
    // And the fact it argued with is closed by the same ruling — one tick, both sides.
    const before = factOf('Ilse Renn', 'never filed a diversion')
    expect(before.closure!.closedBy).toBe(at)
  })

  it('leaves the two riders it did not touch exactly where they were', async () => {
    await threeRidersOnEp02()
    const rider = riderFor(HER_LEDGER).id

    await ruleFromTheSweep(rider, 'ratify', 'yes.')

    expect(sweep().riders.map((one) => one.status)).toEqual(['raised', 'raised'])
    expect(
      statements(canonAsOf(store, { entityId: harbor.entity('Tobin Wick').id }, 'now')),
    ).not.toContain(HIS_KEYS)
  })
})

// ── The landing, ratified (D8) ─────────────────────────────────────────────────

describe('the landing rider does the same, and the arc position reads ratified', () => {
  it('turns “arc reached waypoint 2 in ep02” into a fact with ep02’s lineage', async () => {
    await threeRidersOnEp02()
    const arc = arcsOf(store, harbor.show.id)[0]!
    const waypoint = waypointsOf(store, arc.id).find((one) => one.ordinal === 2)!
    const landed = `“${arc.name}” reached waypoint 2 “${waypoint.name}” in ep02.`
    const rider = landingRider().id
    const ilse = harbor.entity('Ilse Renn').id

    // The pin has been on the arc since it was declared, and it is NOT the fact: a pin is a
    // production decision, and the landing is the claim about the world (E4-4's split, D8).
    expect(positionsOf(store, ep02).map((one) => one.waypoint.ordinal)).toEqual([2])
    expect(statements(canonAsOf(store, { entityId: ilse }, 'now'))).not.toContain(landed)

    const res = await ruleFromTheSweep(rider, 'ratify', 'landed — the roster line does it.')
    expect(res.status).toBe(200)
    const at = findProposal(store, rider)!.disposition!.seq

    const fact = canonAsOf(store, { entityId: ilse }, 'now').find(
      (one) => one.statement === landed,
    )!
    expect(fact.establishedIn).toBe(ep02)
    expect(fact.ratifiedBy).toBe(at)
    expect(canonAsOf(store, { entityId: ilse }, { ruling: at - 1 }).map((f) => f.statement))
      .not.toContain(landed)
    // The pin did not move, and did not need to: the position was always ep02's, and what
    // the ruling changed is whether landing it is CANON.
    expect(positionsOf(store, ep02).map((one) => one.waypoint.ordinal)).toEqual([2])
  })
})

// ── Trap 3: the deferral, which parks without ruling canon ─────────────────────

describe('deferring a rider parks it, and it is still Ryan’s to rule later', () => {
  it('stops it riding, writes no canon, and leaves it on the queue’s record', async () => {
    await threeRidersOnEp02()
    const rider = riderFor(HIS_KEYS).id
    const tobin = harbor.entity('Tobin Wick').id
    const claimed = findProposal(store, rider)!.change.facts[0]!.factId!

    expect(checkScope(tobin).map((fact) => fact.statement)).toContain(HIS_KEYS)

    const res = await ruleFromTheSweep(rider, 'defer', 'park it — ep03 decides whose ring it is.')
    expect(res.status).toBe(200)

    // Parked: off the pass, on the record, and the note kept forever (3.3).
    expect(sweep().riders.map((one) => one.id)).not.toContain(rider)
    expect(sweep().ruled.map((one) => [one.id, one.status])).toContainEqual([rider, 'deferred'])
    expect(findProposal(store, rider)!.disposition!.note).toBe(
      'park it — ep03 decides whose ring it is.',
    )
    // It stops riding: ep02's checks no longer argue with a claim Ryan put down.
    expect(checkScope(tobin).map((fact) => fact.statement)).not.toContain(HIS_KEYS)
    expect(findFact(store, claimed)!.status).toBe('reverted')
    // And it wrote NO canon — that is what makes a deferral legal where a ruling would not be.
    expect(statements(canonAsOf(store, { entityId: tobin }, 'now'))).not.toContain(HIS_KEYS)

    // Still rulable, from the queue rather than from the pass: the record is what a later
    // proposal cites, and this build's answer is that a ruled proposal is ruled once.
    expect(openProposals(store, harbor.show.id).map((one) => one.id)).not.toContain(rider)
    const again = await ruleFromTheSweep(rider, 'ratify', 'changed my mind.')
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toMatch(
      /A later opinion is a NEW proposal/,
    )
  })
})

// ── Trap 4: "swept" is a sentence derived, never a column ──────────────────────

describe('the owed-pass sentence is derived from the queue, both ways', () => {
  it('appears on the card with the riders and disappears when the last one is ruled', async () => {
    await threeRidersOnEp02()

    expect(cardSweep()!.riders).toBe(3)
    expect(cardSweep()!.sentence).toContain('ep02 carries 3 proposals to rule')
    expect(cardSweep()!.open.sentence).toBe(
      'Rule the 3 proposals riding ep02 — the completion sweep, one at a time, each on its own ' +
        'row of the ledger',
    )
    expect(cardSweep()!.open.cost).toBe('No model call · $0.00')
    expect(cardSweep()!.open.enabled).toBe(true)

    for (const rider of sweep().riders) await ruleFromTheSweep(rider.id, 'defer', 'later.')

    // Gone — not marked done, not flagged swept. There is nothing to mark: the sentence was
    // the queue, read.
    expect(cardSweep()).toBeNull()
    expect(store.all('SELECT name FROM sqlite_master WHERE name LIKE ?', '%sweep%')).toEqual([])
    expect(
      store.all("SELECT name FROM pragma_table_info('episode') WHERE name LIKE '%swept%'"),
    ).toEqual([])
  })

  it('says the two different kinds of nothing, which are different news', async () => {
    // Never had one.
    expect(sweep(ep03).owed).toBe(false)
    expect(sweep(ep03).nothingBecause).toContain('Nothing has ever ridden ep03’s writing')
    expect(sweep(ep03).ruled).toEqual([])

    // Had three, and ruled them.
    await threeRidersOnEp02()
    for (const rider of sweep().riders) await ruleFromTheSweep(rider.id, 'defer', 'later.')
    expect(sweep().nothingBecause).toContain('has been ruled — 3 of them')
  })

  it('does not block, wall or move anything — the pass is owed, never a gate', async () => {
    await threeRidersOnEp02()
    const before = findEpisode(store, ep02)!.lifecycle

    expect(sweep().owed).toBe(true)
    // The lifecycle moved when the run's own closing step moved it, and the standing pass
    // neither advanced it further nor holds it back (E4-1's seam, `domain/lifecycle.ts`).
    expect(before).toBe('assets')
    for (const rider of sweep().riders) await ruleFromTheSweep(rider.id, 'ratify', 'yes.')
    expect(findEpisode(store, ep02)!.lifecycle).toBe('assets')
    // And no run was started, resumed or parked by any of it.
    expect(openGates(store)).toEqual([])
  })
})

// ── Trap 2: it collects. It never generates ────────────────────────────────────

describe('the sweep collects, and never generates, prompts or re-reads a word', () => {
  it('raises nothing of its own and calls no model, however long it is left standing', async () => {
    await threeRidersOnEp02()
    const spent = llm.calls.length
    const raised = sweepEpisode(store, ep02).outstanding.map((one) => one.id)

    // Read it, render it on the card, read it again: it is a READ, and reads cost nothing.
    sweep()
    cardSweep()
    await app.request(`/api/sweep/${ep02}`)
    await app.request(`/api/sweep/${ep02}`)

    expect(llm.calls).toHaveLength(spent)
    expect(sweepEpisode(store, ep02).outstanding.map((one) => one.id)).toEqual(raised)
  })

  it('does not go looking for claims a hand edit left unraised — that door is the bench', async () => {
    await threeRidersOnEp02()
    for (const rider of sweep().riders) await ruleFromTheSweep(rider.id, 'ratify', 'yes.')
    expect(sweep().owed).toBe(false)

    // A line of prose asserting something canon has never said, landed by hand. E4-5 chose
    // that an edit raises nothing (`edit.ts`), and this is the other half of that choice: the
    // sweep collects what rides and does not helpfully re-read his words for more.
    const res = await app.request(`/api/artifact/${script().id}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `${SCRIPT}\n\nIlse Renn has never once been off this station.\n`,
      }),
    })
    expect(res.status).toBe(200)

    expect(sweep().owed).toBe(false)
    expect(sweep().riders).toEqual([])
    expect(cardSweep()).toBeNull()
  })

  it('collects a rider that arrived from somewhere else entirely, without knowing where', async () => {
    await threeRidersOnEp02()
    for (const rider of sweep().riders) await ruleFromTheSweep(rider.id, 'ratify', 'yes.')

    // Not the extractor's, not a gate's: a proposal raised at the bench that rides ep02 (#39's
    // door does exactly this). The pass is computed from the queue, so it collects it — which
    // is why the pass had to be a standing obligation rather than one gate's payload.
    const late = raiseProposal(store, {
      entityId: harbor.entity('Tobin Wick').id,
      kind: 'fact-delta',
      raisedBy: 'ryan',
      episodeId: ep02,
      facts: [{ statement: 'Tobin Wick reads the log before he reads the roster.' }],
    })

    expect(sweep().riders.map((one) => one.id)).toEqual([late.id])
    expect(cardSweep()!.sentence).toContain('ep02 carries 1 proposal to rule — 1 fact delta.')
    expect(cardSweep()!.sentence).toContain('It rides ep02 until you rule it')
  })
})

// ── Trap 6: the other exit still works (E2-3's abandon path) ───────────────────

describe('abandoning an episode with standing riders — the regression', () => {
  it('still parks every rider and raises one revert per ratified fact, ruled one by one', async () => {
    await threeRidersOnEp02()
    // One rider ratified, so ep02 has established canon; two left riding.
    const ratified = riderFor(HER_LEDGER).id
    await ruleFromTheSweep(ratified, 'ratify', 'yes — she keeps it herself.')
    const riding = sweep().riders.map((one) => one.id)
    expect(riding).toHaveLength(2)

    const abandonment = abandonEpisode(store, ep02, { note: 'the B-story never landed' })

    // Parked: the two that were riding, with the abandonment as the note.
    expect(abandonment.parked.map((one) => one.id)).toEqual(riding)
    expect(riding.map((id) => findProposal(store, id)!.status)).toEqual(['deferred', 'deferred'])
    expect(findProposal(store, riding[0]!)!.disposition!.note).toMatch(/ep02 .* was abandoned/)

    // One revert per ratified fact it established — raised, never ruled (3.3 is surgical).
    expect(abandonment.reverts.map((one) => one.kind)).toEqual(['revert'])
    expect(abandonment.reverts[0]!.episodeId).toBeNull()
    expect(abandonment.reverts[0]!.status).toBe('raised')
    expect(abandonment.reverts[0]!.change.facts[0]!.supersedes).toBe(
      canonAsOf(store, { entityId: harbor.entity('Ilse Renn').id }, 'now').find(
        (fact) => fact.statement === HER_LEDGER,
      )!.id,
    )
    // Canon is exactly where it was: abandoning ruled nothing.
    expect(statements(canonAsOf(store, { entityId: harbor.entity('Ilse Renn').id }, 'now')))
      .toContain(HER_LEDGER)
    // And the pass is empty, because the parking emptied it — computed, as ever.
    expect(sweep().owed).toBe(false)
    expect(cardSweep()).toBeNull()
    expect(findEpisode(store, ep02)!.abandonedAt).not.toBeNull()
    expect(findEpisode(store, ep02)!.lifecycle).toBe('assets')
  })
})

// ── What is not on an episode's pass ───────────────────────────────────────────

describe('what the pass refuses, in words', () => {
  it('refuses a proposal that rides nothing, and says where it IS rulable', async () => {
    // A founding sheet: Sefa Doule stays a candidate through the fixture's founding, so her
    // promotion is exactly the proposal that rides nothing (D25).
    const founding = raiseProposal(store, {
      entityId: harbor.entity('Sefa Doule').id,
      kind: 'promotion',
      raisedBy: 'loader',
      standing: 'recurring',
      facts: [{ statement: 'Sefa Doule signs for nothing.' }],
    })

    const refused = await ruleFromTheSweep(founding.id, 'ratify', 'yes.')
    const said = ((await refused.json()) as { error: string }).error

    expect(refused.status).toBe(409)
    expect(said).toContain('That proposal rides no episode')
    // The refusal names the door it IS behind, rather than leaving him to find it (D15).
    expect(said).toContain('Rule it in the canon library’s queue')
    expect(findProposal(store, founding.id)!.status).toBe('raised')
  })

  it('answers 404 for an episode this library does not have, and for a proposal it does not', async () => {
    expect((await app.request('/api/sweep/ep_nope')).status).toBe(404)
    expect(sweepView(store, 'ep_nope')).toBeUndefined()

    const missing = await ruleFromTheSweep('prop_nope', 'ratify', 'yes.')
    expect(missing.status).toBe(404)
  })
})

// ── The three readers, read ────────────────────────────────────────────────────

const statements = (facts: { statement: string }[]): string[] => facts.map((f) => f.statement)

/** What a LATER episode's writer is handed about one entity — the desk, really composed. */
function deskFacts(episodeId: string, entityId: string): string[] {
  const desk = composeWriteContext(store, paths, { episodeId, step: 'premise' })
  const held = desk.entities.find((one) => one.entity.id === entityId)
  return (held?.facts ?? []).map((fact) => fact.fact.statement)
}

/** Which door in time a fact came through, on that desk (`write-context.ts`'s `FactReach`). */
function deskReach(episodeId: string, entityId: string, statement: string): string | undefined {
  const desk = composeWriteContext(store, paths, { episodeId, step: 'premise' })
  const held = desk.entities.find((one) => one.entity.id === entityId)
  return held?.facts.find((fact) => fact.fact.statement === statement)?.reach
}

/**
 * **What ep02's own checks are handed** — the real check composer over the real script, so
 * "riding" and "canon" are told apart by the reader that has to tell them apart, rather than
 * by a query written for this test (invariant 2, `domain/text-check.ts`).
 */
function checkScope(entityId: string) {
  const artifact = script()
  const subject = categoryChecksFor(store, artifact).find((one) =>
    one.subjectEntityIds.includes(entityId),
  )!
  const composed = composeTextCheck(store, {
    artifact,
    text: SCRIPT,
    subject,
  })
  return composed.scope
    .filter((held) => held.entityId === entityId)
    .map((held) => findFact(store, held.factId)!)
}

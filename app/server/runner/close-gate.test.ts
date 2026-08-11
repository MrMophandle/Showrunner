import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { criedWolf } from '../cried-wolf.ts'
import type { Store } from '../db/store.ts'
import { artifactsOf, type Artifact } from '../domain/artifact.ts'
import { runBoardRules } from '../domain/board-rules.ts'
import { recordExtractedBoard } from '../domain/board.ts'
import { factsOfEntity } from '../domain/fact.ts'
import { findingsIn } from '../domain/finding.ts'
import { proposalsRiding } from '../domain/proposal.ts'
import { notesOwedBy, routedNotesTo } from '../domain/routing.ts'
import { episodesOf, findEpisode, seasonsOf } from '../domain/spine.ts'
import { composeWriteContext } from '../domain/write-context.ts'
import { createEventLog, eventsOfRun, type EventLog } from '../events.ts'
import { greyHarborFounded } from '../fixture/founded.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { describeLLMBackend, type LLMReadiness } from '../llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { gateOnThePage, launchBlockedBecause, stageOffer } from '../operating.ts'
import { OUTLINE_GATE_STAGE, SCRIPT_GATE_STAGE } from './present-step.ts'
import {
  closingNeedsANote,
  createRulings,
  openGates,
  overriddenThrough,
  overriddenVersions,
  type Rulings,
} from './gate.ts'
import { findRun } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import { stageBlockedBecause } from './stage-wall.ts'
import { stageCatalogue } from './stages.ts'
import { OUTLINE_STAGE, PREMISE_STAGE, SCRIPT_STAGE } from './write-step.ts'

/**
 * **The reject-that-closes** (E5-3, #83; 0015) — the verb the E4 ledger asked E5 to rule.
 *
 * The ledger recorded the gap by name: *"A presenting gate has one exit, and it is approve."*
 * There is no producer behind such a gate, so a rejection about the draft in front of Ryan
 * re-presents the same bytes as round 2 — and D7 holds the episode while that gate is open, so
 * the rewrite his note asked for cannot happen until he approves the draft he just rejected.
 * *"A rejection he means as 'put this down for now' has no verb: he must approve, or leave the
 * run parked forever."*
 *
 * This file is the verb, and it is as much about what a close does NOT do as about what it
 * does. Four things it must not touch, each a test below by name:
 *
 *   1. **It advances no lifecycle.** It is not an approval.
 *   2. **It rules no finding.** They stay open, nothing is written to any disposition, and a
 *      standing deterministic finding still walls the next stage — closing a gate is not a
 *      door through D12.
 *   3. **It counts nothing in cried-wolf.** A put-down is not a disposition on any concern
 *      (D11), and `overriddenVersions` is the filter that keeps it invisible.
 *   4. **It gives no check a veto.** Nothing about the findings forces it or forbids it, and
 *      the only thing that can disable it is its own note.
 *
 * And two it must: the episode is FREE afterwards, and the note STANDS — the offer reopens and
 * the next writer run reads it back off the desk (4.4, D21).
 *
 * Everything runs the REAL stages through the REAL runner against a REAL library volume with
 * Grey Harbor founded in it, and the fake backend in front of the model.
 */

const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
const NOTHING_FOUND = '{"findings": []}'

/** Ryan's note when he stops. A sentence he would actually write, and 4.4 reads it back. */
const PUT_DOWN = 'Not this week — the pier scene is the whole episode and it is not there yet.'

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
let showId: string
let ep01: string
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-close-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  const harbor = greyHarborFounded(store, paths)
  showId = harbor.show.id
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

// ── Reading ─────────────────────────────────────────────────────────────────────

const artifact = (episodeId: string, kind: string): Artifact =>
  artifactsOf(store, episodeId).find((one) => one.kind === kind)!

const offerFor = (episodeId: string, stage: string) =>
  stageOffer(store, READY, episodeId, stageCatalogue(paths)[stage]!)

const onDisk = (one: Artifact): string => readFileSync(join(paths.artifactDir, one.filePath!), 'utf8')

const factOf = (entity: string, needle: string): string => {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

/** The Long Pier's planted contradictions, raised for nothing by the rules that read rows. */
function theBoard(): void {
  const script = artifact(ep01, 'script')
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
}

/** ep01's hand-written script, put in front of Ryan at the door that produces nothing. */
async function presentTheEp01Script(): Promise<string> {
  const run = runner.enqueueRun({ episodeId: ep01, stage: SCRIPT_GATE_STAGE })
  await runner.settled(run.id)
  return run.id
}

// ── 1 · The gap, and the verb that closes it ────────────────────────────────────

describe('the gap the E4 ledger named — a presenting gate with one exit', () => {
  /**
   * The control. This is what the ledger recorded, reproduced, so that the verb below is
   * measured against the thing it replaces rather than against a description of it.
   */
  it('re-presents the same bytes on a rejection, and D7 holds the episode while it does', async () => {
    const runId = await presentTheEp01Script()
    const version = artifact(ep01, 'script').version

    rulings.reject(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    // Round 2, over the identical draft — there is no producer here to write another.
    const gate = openGates(store)[0]!
    expect(gate.round).toBe(2)
    expect(findRun(store, runId)!.status).toBe('paused')
    expect(artifact(ep01, 'script').version).toBe(version)
    expect(llm.calls).toEqual([])
    // And every stage on ep01 is refused while it stands — including the one that would
    // rewrite the thing his note is about. That is the deadlock, in one assertion.
    const refused = launchBlockedBecause(store, READY, ep01, stageCatalogue(paths)[SCRIPT_STAGE]!)
    expect(refused).toContain('One run per episode (D7)')
    expect(refused).toContain('waiting on your ruling')
  })

  it('ends the run on a close, with the draft exactly as he ruled on it', async () => {
    const runId = await presentTheEp01Script()
    const version = artifact(ep01, 'script').version
    const text = onDisk(artifact(ep01, 'script'))

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    expect(findRun(store, runId)!.status).toBe('done')
    expect(openGates(store)).toEqual([])
    // Nothing re-presented, nothing rewritten, and not one call after the verdict.
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM gate_round')!.n).toBe(1)
    expect(artifact(ep01, 'script').version).toBe(version)
    expect(onDisk(artifact(ep01, 'script'))).toBe(text)
    expect(llm.calls).toEqual([])
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_entry')!.n).toBe(0)
  })

  it('frees the episode — every stage is offerable again the moment it lands', async () => {
    const runId = await presentTheEp01Script()
    expect(launchBlockedBecause(store, READY, ep01, stageCatalogue(paths)[SCRIPT_STAGE]!)).toContain(
      'One run per episode (D7)',
    )

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    // D7 is not un-said: it let go because the run ENDED, which is the only thing that ever
    // released it. Nothing wrote an unblock anywhere.
    expect(launchBlockedBecause(store, READY, ep01, stageCatalogue(paths)[SCRIPT_STAGE]!)).toBeNull()
    expect(findRun(store, runId)!.status).toBe('done')
  })

  it('keeps its record distinct from a rejection, in the ledger and in the log', async () => {
    const runId = await presentTheEp01Script()

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    // The ledger: one word, its own, readable with no join to a catalogue that can lose a
    // stage. This is the whole argument for a fourth verdict over a fourth meaning (0015).
    expect(store.all<{ verdict: string }>('SELECT verdict FROM gate_ruling')).toEqual([
      { verdict: 'close' },
    ])
    // The log: its own kind and its own sentence, so the floor can tell the two apart.
    const said = eventsOfRun(store, runId).filter((event) => event.kind.startsWith('gate-'))
    expect(said.map((event) => event.kind)).toEqual(['gate-opened', 'gate-closed'])
    expect(said[1]!.summary).toContain('put the ep01 script down with 1 note')
    expect(said[1]!.summary).toContain('nothing is rewritten')
    expect(said[1]!.summary).not.toContain('reopens as round')
    expect((said[1]!.detail as { verdict: string }).verdict).toBe('close')
  })

  it('says what it did in the step’s own words, and moves the episode nowhere', async () => {
    const runId = await presentTheEp01Script()

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    const said = store.get<{ output: string }>(
      "SELECT output FROM step WHERE run_id = ? AND name = 'present-the-script-for-your-ruling'",
      runId,
    )!
    const outcome = JSON.parse(said.output) as { verdict: string; sentence: string; lifecycle: { moved: boolean } }
    expect(outcome.verdict).toBe('close')
    expect(outcome.lifecycle.moved).toBe(false)
    expect(outcome.sentence).toContain('Put down at round 1')
    expect(outcome.sentence).toContain('ep01 is free')
    expect(outcome.sentence).toContain('Nothing regenerates until you ask for it (D21)')
  })
})

// ── 2 · The note stands, and it is read back ───────────────────────────────────

describe('the note a close leaves behind', () => {
  it('stands against the artifact and reopens the stage that writes it, quoted', async () => {
    const runId = await presentTheEp01Script()
    // Before: the writing stage has nothing to do, because the draft already exists.
    expect(offerFor(ep01, SCRIPT_STAGE).blockedBecause).toContain('already has a script')

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    expect(notesOwedBy(store, artifact(ep01, 'script').id).map((one) => one.note)).toEqual([PUT_DOWN])
    const offer = offerFor(ep01, SCRIPT_STAGE)
    expect(offer.enabled).toBe(true)
    expect(offer.sentence).toContain('the note you put it down with at the script gate')
    expect(offer.sentence).toContain(PUT_DOWN)
    // The API and the button say the same thing (D15).
    expect(launchBlockedBecause(store, READY, ep01, stageCatalogue(paths)[SCRIPT_STAGE]!)).toBeNull()
  })

  it('reaches the writer through the desk, saying which verb wrote it', async () => {
    const runId = await presentTheEp01Script()
    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    const desk = composeWriteContext(store, paths, { episodeId: ep01, step: 'script' })
    const note = desk.notes.find((one) => one.note === PUT_DOWN)!
    expect(note.sentence).toBe('the note you put the ep01 script down with at round 1')
    expect(note.origin).toMatchObject({ kind: 'gate-rejection', verdict: 'close', round: 1 })
    // The three authorities are still three: a close is Ryan at THIS artifact's gate, which is
    // the same authority a rejection is — what differs is what he did next, and it is said.
    expect(note.sentence).not.toContain('rejection')
  })

  it('routes like a rejection when he says where it goes, and reopens THAT stage', async () => {
    const runId = await presentTheEp01Script()

    rulings.close(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'the outline never turns here', depth: 'outline' }],
    })
    await runner.settled(runId)

    // Depths are not a rejection's private property: a closing note carries an address the
    // same way, and answers the same way — a newer version of the target, and nothing else.
    const outline = artifact(ep01, 'outline')
    expect(routedNotesTo(store, outline.id).map((one) => one.depth)).toEqual(['outline'])
    expect(offerFor(ep01, OUTLINE_STAGE).enabled).toBe(true)
    // And it is off the script, because he named somewhere else.
    expect(notesOwedBy(store, artifact(ep01, 'script').id)).toEqual([])
  })

  it('closes again the moment a newer version exists — no flag was written anywhere', async () => {
    const runId = await presentTheEp01Script()
    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    // Ryan types over the draft himself, which is the door the reopened offer names.
    const script = artifact(ep01, 'script')
    store.run(
      'INSERT INTO artifact_revision (artifact_id, version, summary) VALUES (?, ?, ?)',
      script.id,
      script.version + 1,
      'you typed over it',
    )
    store.run('UPDATE artifact SET version = ? WHERE id = ?', script.version + 1, script.id)

    expect(notesOwedBy(store, script.id)).toEqual([])
    // Derived, never stored: the row still says exactly what it said.
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM gate_note')!.n).toBe(1)
  })
})

// ── 3 · What a close does NOT do (the four negatives, each by name) ─────────────

describe('what putting a draft down does not do', () => {
  it('advances no lifecycle — it is not an approval', async () => {
    const runId = await presentTheEp01Script()
    expect(findEpisode(store, ep01)!.lifecycle).toBe('script')

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    // Approving at this very door moves ep01 from `script` to `assets` (#76,
    // `present-step.test.ts`). A close goes through `stayedAt` instead, and nothing moves.
    expect(findEpisode(store, ep01)!.lifecycle).toBe('script')
    expect(findEpisode(store, ep01)!.abandonedAt).toBeNull()
  })

  it('rules no finding — they stay open, and nothing is written to any disposition', async () => {
    theBoard()
    const runId = await presentTheEp01Script()
    const script = artifact(ep01, 'script')
    const before = findingsIn(store, script.id).map((one) => [one.id, one.status])
    expect(before.length).toBeGreaterThan(0)

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    expect(findingsIn(store, script.id).map((one) => [one.id, one.status])).toEqual(before)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM finding_disposition')!.n).toBe(0)
  })

  it('is not a door through D12 — a standing deterministic finding still walls the next stage', async () => {
    theBoard()
    const runId = await presentTheEp01Script()
    expect(stageBlockedBecause(store, ep01)).toContain('ep01 is blocked')

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    // The wall is a read over five live conditions and an OVERRIDE is the only verdict that
    // moves one of them (`stage-wall.ts`). Closing a gate is not overriding anything.
    expect(stageBlockedBecause(store, ep01)).toContain('ep01 is blocked')
    expect(overriddenVersions(store, artifact(ep01, 'script').id)).toEqual([])
    expect(overriddenThrough(store, artifact(ep01, 'script').id)).toBeNull()
  })

  it('counts nothing in cried-wolf — a put-down is not a disposition on any concern', async () => {
    theBoard()
    const runId = await presentTheEp01Script()
    const before = criedWolf(store, { showId })
    expect(before.length).toBeGreaterThan(0)

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    // D11's ratio reads dismissals and overrides. A fourth verdict it cannot see is a fourth
    // verdict that cannot move a number Ryan would have to account for (`cried-wolf.ts`).
    expect(criedWolf(store, { showId })).toEqual(before)
    for (const record of criedWolf(store, { showId })) {
      expect(record.overridden).toBe(0)
      expect(record.dismissed).toBe(0)
    }
  })

  it('raises nothing of what the draft claimed — no reading was bought', async () => {
    const runId = await presentTheEp01Script()

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    expect(proposalsRiding(store, ep01)).toEqual([])
    expect(llm.calls).toEqual([])
  })
})

// ── 4 · No precondition enters it, proven by omission ──────────────────────────

describe('nothing about the findings forces or forbids it', () => {
  it('is offered with two deterministic findings standing, and with none', async () => {
    theBoard()
    await presentTheEp01Script()

    const loud = gateOnThePage(store, paths, openGates(store)[0]!.gate.id, stageCatalogue(paths))!
    expect(loud.close.enabled).toBe(true)
    expect(loud.close.blockedBecause).toBeNull()
    // The gate's other three are equally unrefused — the point of the assertion is that a red
    // board changes NONE of the four (invariant 3, D12).
    expect([loud.approve, loud.override, loud.reject].every((offer) => offer.enabled)).toBe(true)
    // And it costs nothing, whatever stage is behind it: a close re-runs nothing.
    expect(loud.close.cost).toBe('No model call · $0.00')
  })

  it('is offered at a gate with no findings at all, and at the outline’s door too', async () => {
    const run = runner.enqueueRun({ episodeId: ep01, stage: OUTLINE_GATE_STAGE })
    await runner.settled(run.id)

    const quiet = gateOnThePage(store, paths, openGates(store)[0]!.gate.id, stageCatalogue(paths))!
    expect(quiet.close.enabled).toBe(true)
    expect(quiet.close.sentence).toContain('Put the ep01 outline down with your note')
    expect(quiet.close.sentence).toContain('ep01 is free the moment you click')
  })

  it('refuses only its own missing note, in one sentence with three readers', async () => {
    await presentTheEp01Script()
    const gateId = openGates(store)[0]!.gate.id

    expect(() => rulings.close(gateId, { notes: [] })).toThrow(closingNeedsANote('the ep01 script'))
    // The refusal is the button's too, and it is NOT the rejection's with a word swapped: a
    // close reopens nothing, so its note is the whole record rather than what a step writes
    // against.
    const rendered = gateOnThePage(store, paths, gateId, stageCatalogue(paths))!
    expect(rendered.closeNeedsNote).toBe(closingNeedsANote('the ep01 script'))
    expect(rendered.closeNeedsNote).not.toBe(rendered.rejectNeedsNote)
    expect(rendered.closeNeedsNote).toContain('a parking says why')
    // And the verdict was not recorded: a refused verb writes nothing.
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM gate_ruling')!.n).toBe(0)
  })

  it('refuses a second ruling on a round it already closed, and nothing else', async () => {
    const runId = await presentTheEp01Script()
    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    const gateId = store.get<{ id: string }>('SELECT id FROM gate')!.id
    expect(() => rulings.close(gateId, { notes: [{ note: 'again' }] })).toThrow(
      /has no open round — round 1 was ruled "close"/,
    )
    expect(() => rulings.approve(gateId)).toThrow(/no open round/)
  })
})

// ── 5 · The same verb at a writing gate, where there IS a producer ─────────────

/**
 * The verb takes no view of which stage opened the gate — *a gate says where Ryan stood, never
 * whether he may rule* (`gate.ts`). At a writing gate a close means the same thing: stop, the
 * note stands, and nothing is rewritten until he asks.
 */
describe('the same verb at a writing gate', () => {
  const PREMISE = [
    'The water plant’s exchanger fails on a Tuesday, three weeks after Ilse Renn cut the tag off',
    'its spare and gave the part to the beacon. Tobin Wick reads the temperature log.',
  ].join('\n')

  /** ep02's premise, written by the real stage, sitting at its own gate with a real producer. */
  async function toThePremiseGate(): Promise<string> {
    llm.reply(PREMISE)
    for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(run.id)
    return run.id
  }

  it('ends the run without a rewrite, though the producer is right there', async () => {
    const runId = await toThePremiseGate()
    const spent = llm.calls.length
    expect(artifact(ep02, 'premise-brief').version).toBe(1)

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    // A rejection here would write round 2 against his note. A close does not, and the whole
    // difference is the word in the ledger.
    expect(llm.calls).toHaveLength(spent)
    expect(artifact(ep02, 'premise-brief').version).toBe(1)
    expect(findRun(store, runId)!.status).toBe('done')
    expect(openGates(store)).toEqual([])
  })

  it('leaves the episode where it stood, with the note standing and the stage reopened', async () => {
    const runId = await toThePremiseGate()
    expect(findEpisode(store, ep02)!.lifecycle).toBe('premise')

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: PUT_DOWN }] })
    await runner.settled(runId)

    // Approving here moves ep02 from `premise` to `outline`. A close goes through the verb
    // that moves nothing, and says which of the two stopping words it was.
    expect(findEpisode(store, ep02)!.lifecycle).toBe('premise')
    const closing = store.get<{ output: string }>(
      "SELECT output FROM step WHERE run_id = ? AND name LIKE 'advance-past-%'",
      runId,
    )!
    const outcome = JSON.parse(closing.output) as { verdict: string; sentence: string }
    expect(outcome.verdict).toBe('close')
    expect(outcome.sentence).toContain('Put down at round 1')
    expect(outcome.sentence).toContain('you put the draft down with a note')
    expect(outcome.sentence).not.toContain('routed')

    expect(notesOwedBy(store, artifact(ep02, 'premise-brief').id).map((one) => one.note)).toEqual([
      PUT_DOWN,
    ])
    expect(offerFor(ep02, PREMISE_STAGE).enabled).toBe(true)
  })
})

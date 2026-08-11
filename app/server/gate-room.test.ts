import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from './db/store.ts'
import { artifactsOf, type Artifact } from './domain/artifact.ts'
import { runBoardRules } from './domain/board-rules.ts'
import { recordExtractedBoard } from './domain/board.ts'
import { factsOfEntity } from './domain/fact.ts'
import { verdictBoard } from './domain/panel.ts'
import { episodesOf, seasonsOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { greyHarborFounded } from './fixture/founded.ts'
import { theLongPierExtraction } from './fixture/long-pier-board.ts'
import { boardSentence, gateIndexView, gateRoomView } from './gate-room.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import { NOTE_DEPTH, createRulings, openGates, type Rulings } from './runner/gate.ts'
import { SCRIPT_GATE_STAGE } from './runner/present-step.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'
import { PREMISE_STAGE } from './runner/write-step.ts'

/**
 * **The gate room's read model** (E5-3, #83; 5.3, D15).
 *
 * `gate-room.test.tsx` proves the screen. This proves what it is handed: that the draft comes
 * back whole with the cards folded in at the spans they are anchored to, that the round history
 * says what "stale" means in versions rather than in a flag, that the dock offers four verbs
 * none of which a finding can disable, and that every sentence on it belongs to the module that
 * owns the fact — this file composes the fold, the tags, the headline and the depths, and
 * quotes everything else.
 */

const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
const NOTHING_FOUND = '{"findings": []}'
/** A fixed clock, so "opened 3 minutes ago" is an assertion rather than a race. */
const NOW = new Date('2026-08-11T12:00:00.000Z')

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
let ep01: string
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-gate-room-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  const harbor = greyHarborFounded(store, paths)
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

const artifact = (episodeId: string, kind: string): Artifact =>
  artifactsOf(store, episodeId).find((one) => one.kind === kind)!

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

/** ep01's hand-written script, in front of Ryan at the door that produces nothing. */
async function presentTheEp01Script(): Promise<string> {
  const run = runner.enqueueRun({ episodeId: ep01, stage: SCRIPT_GATE_STAGE })
  await runner.settled(run.id)
  return run.id
}

const room = (gateId = openGates(store)[0]!.gate.id) =>
  gateRoomView(store, paths, gateId, READY, NOW)!

// ── The artifact is the page ───────────────────────────────────────────────────

describe('the draft comes back whole, with the cards folded in where they land', () => {
  it('reassembles to the file on the volume, byte for byte', async () => {
    theBoard()
    await presentTheEp01Script()
    const view = room()

    // Prose and marked spans, concatenated in the order they arrive, ARE the artifact. If the
    // fold ever drops a character, duplicates one, or re-orders two, this is what fails —
    // which is the only way to be sure "the gate renders its artifact" is still true after
    // something has been sliced into it.
    const rebuilt = view.fold.pieces
      .map((piece) => (piece.kind === 'finding' ? '' : piece.text))
      .join('')
    expect(rebuilt).toBe(onDisk(artifact(ep01, 'script')))
  })

  it('marks each span at its real anchor and puts its card directly under it', async () => {
    theBoard()
    await presentTheEp01Script()
    const view = room()
    const text = onDisk(artifact(ep01, 'script'))

    const spans = view.fold.pieces.filter((piece) => piece.kind === 'span')
    expect(spans.length).toBeGreaterThan(0)
    for (const span of spans) {
      // The mark is a real substring of the draft, in the place it was quoted from.
      expect(text).toContain(span.text)
      // And the card it belongs to is the very next piece — that is what "anchored" means.
      const at = view.fold.pieces.indexOf(span)
      const next = view.fold.pieces[at + 1]!
      expect(next.kind).toBe('finding')
      expect(next.kind === 'finding' && next.card.id).toBe(span.cardId)
      expect(next.kind === 'finding' && next.card.quote).toBe(span.text)
    }
  })

  it('carries every reviewer’s say with severity and confidence apart, and the blocking marked', async () => {
    theBoard()
    await presentTheEp01Script()
    const view = room()

    const cards = view.fold.pieces.flatMap((piece) => (piece.kind === 'finding' ? [piece.card] : []))
    expect(cards.length).toBeGreaterThan(0)
    const blocking = cards.filter((card) => card.blocking)
    expect(blocking.length).toBeGreaterThan(0)

    for (const card of blocking) {
      const say = card.says.find((one) => one.blocking)!
      // `panel.ts`'s own line, quoted rather than re-worded — two values, never one.
      expect(say.sentence).toContain('severity')
      expect(say.sentence).toContain('confidence')
      // And D12's sentence, from `stage-wall.ts`, so a red mark never reads as a veto here.
      expect(say.blockingSentence).toContain('never this gate')
      // 4.3's three remediations ride each say, with their own costs and refusals.
      expect(say.remediations.predraft.sentence).toContain('Pre-draft a rewrite')
      expect(say.remediations.dismiss.sentence).toContain('with your note')
    }
    // The card says where it is in words rather than as a schema noun.
    expect(cards.map((card) => card.where).join(' ')).toContain('of the ep01 script')
  })

  /**
   * **Ryan's third and fourth examples on #99, as assertions.**
   *
   * Both headings used to be constants that gestured at what the page was already holding —
   * "what you are ruling on" over an artifact whose kind and version were right there, and
   * "one row per reviewer" over rows that each say what kind of reviewer they are. They are
   * composed now, so what is asserted is that they SPEND that knowledge: the artifact heading
   * names the episode, the kind and the version, and the board heading counts its own rows and
   * says who paid for each.
   */
  it('names the draft it is rendering, with its version, rather than gesturing at it', async () => {
    await presentTheEp01Script()
    const heading = room().headings.artifact

    expect(heading.name).toBe('The draft')
    expect(heading.explains).toBe(
      'The ep01 script, version 1, shown in full. Findings appear beside the lines they ' +
        'refer to.',
    )
    // The deictic Ryan pulled it up on, gone — and no citation behind it either.
    expect(heading.explains).not.toContain('what you are ruling on')
    expect(heading.explains).not.toMatch(/\((?:D\d+|\d+\.\d+|invariant \d+)\)/)
  })

  it('says who read the draft and what each of them cost, instead of "one row per reviewer"', async () => {
    theBoard()
    await presentTheEp01Script()
    const heading = room().headings.board

    expect(heading.name).toBe('Verdict board')
    // Every group the rows actually hold, counted off the rows themselves.
    expect(heading.explains).toContain('One row per check that read this draft')
    expect(heading.explains).toContain('deterministic rule')
    expect(heading.explains).toContain('cost nothing')
    // The line Ryan asked for: agency is explicit, and none of them is the decider.
    expect(heading.explains).toContain('None of them decides anything; deciding is yours, below.')
    expect(heading.explains).not.toContain('reviewer')
    expect(heading.explains).not.toContain('convened')
  })

  it('says a board nobody has read is unread, rather than counting to zero three times', () => {
    // "0 canon checks and 0 craft checks" reads like a clean panel, and an unread board is
    // the opposite of a clean one (invariant 4). It says so in words instead.
    const unread = boardSentence({
      artifactId: 'a',
      version: 0,
      rows: [],
      convened: 0,
      read: 0,
      standing: 0,
      gaps: 0,
      sentence: '',
    })
    expect(unread).toContain('No check has read this draft')
    expect(unread).toContain('deciding is yours')
    expect(unread).not.toContain('0 ')
  })

  it('says what the fold IS, and names the doc rather than a path', async () => {
    theBoard()
    await presentTheEp01Script()
    const view = room()

    expect(view.fold.docHeader).toBe('ep01 script v1 · 6 scenes')
    expect(view.fold.note).toBeNull()
    expect(view.fold.sentence).toContain('each one beside the lines it refers to')
    expect(view.fold.sentence).toContain('never have to go and find a quoted span')
  })

  it('says a draft with nothing anchored in it is not a draft nothing read', async () => {
    await presentTheEp01Script()
    const view = room()

    // ep01's script has no findings until the board's rules run over it. "No cards" and "no
    // reading" are two different pieces of news and the sentence refuses to collapse them —
    // invariant 4, said about a fold rather than about a check.
    expect(view.fold.pieces.every((piece) => piece.kind === 'prose')).toBe(true)
    expect(view.fold.sentence).toContain('Nothing is anchored in this draft')
    expect(view.fold.sentence).toContain('not the same as a draft nothing read')
  })

  it('says which of the two nothings it is when there is no draft to render', async () => {
    await presentTheEp01Script()
    const gateId = openGates(store)[0]!.gate.id
    // The row still says where the file is; the volume no longer has it.
    rmSync(join(paths.artifactDir, artifact(ep01, 'script').filePath!))

    const view = room(gateId)
    expect(view.fold.pieces).toEqual([])
    // `operating.ts`'s own note, quoted: which of "no script here" and "the volume is not
    // mounted" it is, because they are very different pieces of news.
    expect(view.fold.note).toContain('could not be read')
    expect(view.fold.note).toContain('no such file or directory')
    expect(view.fold.sentence).toContain('renders the draft itself rather than a filename')
  })
})

// ── The board, the loop, and the riders are handed over whole ──────────────────

describe('it hands over the reads that already exist and re-words none of them', () => {
  it('hands over `panel.ts`’s verdict board, exactly', async () => {
    theBoard()
    await presentTheEp01Script()
    const view = room()

    expect(view.board).toEqual(verdictBoard(store, artifact(ep01, 'script')))
    expect(view.board.rows.map((row) => row.checkKey)).toContain('dual-presence')
  })

  it('walks the loop’s drafts, and says the honest nothing when no check has read one', async () => {
    await presentTheEp01Script()
    const view = room()

    // ep01's script was written by hand into the fixture, so no correction round ever read
    // it — which is not the same news as a clean reading, and the empty state says so.
    expect(view.loop.drafts).toEqual([])
    expect(view.loop.none!.lead).toBe('No check has read the ep01 script.')
    expect(view.loop.none!.sentence).toContain('That is not a clean reading')
    // The gate's own payload sentence, quoted — the one thing only this door knows.
    expect(view.loop.sentence).toContain('Presenting the ep01 script v1 for your ruling')
  })

  it('names the deterministic findings an override would be standing over', async () => {
    theBoard()
    await presentTheEp01Script()
    const view = room()

    expect(view.loop.blocking.map((one) => one.sentence)).toEqual([
      expect.stringContaining('vacuum-without-protection · scene 4'),
      expect.stringContaining('dual-presence · scene 6'),
    ])
  })

  it('hands over the completion sweep whole, one rider at a time', async () => {
    await presentTheEp01Script()
    const view = room()

    expect(view.sweep.episode.id).toBe(ep01)
    expect(view.sweep.refusals.rejectNeedsNote).toBeTruthy()
    // Nothing rides ep01, and the pass says so rather than rendering an empty list.
    expect(view.sweep.nothingBecause).toContain('Nothing has ever ridden')
  })
})

// ── The round history: stale, said in versions ─────────────────────────────────

describe('the round history keeps every round and says what stale means', () => {
  it('says the same draft was presented again when nothing rewrote it', async () => {
    const runId = await presentTheEp01Script()
    rulings.reject(openGates(store)[0]!.gate.id, { notes: [{ note: 'not yet' }] })
    await runner.settled(runId)

    const view = room()
    expect(view.rounds).toHaveLength(2)
    expect(view.rounds[0]!.name).toBe('Round 1 · script v1')
    // The case the fourth verb exists for, said out loud rather than hidden behind "stale":
    // round 2 is the identical file, because nothing behind this gate rewrites anything.
    expect(view.rounds[0]!.staleTag).toContain('from before your last rejection')
    expect(view.rounds[0]!.staleTag).toContain('presented the SAME script v1')
    expect(view.rounds[0]!.ruling!.sentence).toContain('the step reopened as the next round')
    expect(view.rounds[0]!.ruling!.notes[0]!.routing).toContain('unrouted')
    // The newest round is not stale, and it is open.
    expect(view.rounds[1]!.staleTag).toBeNull()
    expect(view.rounds[1]!.standing).toBe('open, waiting on you')
  })

  it('says which version each round was ruled on when a rewrite landed between them', async () => {
    llm.reply('Tobin Wick reads the exchanger log and has to decide what to do about it.')
    for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(run.id)

    llm.reply('Tobin Wick reads the log, and Ilse Renn already knows what it says.')
    for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
    rulings.reject(openGates(store)[0]!.gate.id, { notes: [{ note: 'Ilse has to know first.' }] })
    await runner.settled(run.id)

    const view = room()
    expect(view.rounds.map((one) => one.artifactVersion)).toEqual([1, 2])
    expect(view.rounds[0]!.staleTag).toContain('you ruled on premise-brief v1')
    expect(view.rounds[0]!.staleTag).toContain('round 2 presented v2')
    expect(view.rounds[0]!.staleTag).not.toContain('the SAME')
    // Round 1 is kept exactly as it was ruled — marked, never replaced.
    expect(view.rounds[0]!.ruling!.notes[0]!.note).toBe('Ilse has to know first.')
  })

  it('says what a close DID, in its own words, and keeps the round', async () => {
    const runId = await presentTheEp01Script()
    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: 'Not this week.' }] })
    await runner.settled(runId)

    const gateId = store.get<{ id: string }>('SELECT id FROM gate')!.id
    const view = room(gateId)
    expect(view.isOpen).toBe(false)
    expect(view.rounds).toHaveLength(1)
    expect(view.rounds[0]!.ruling!.verdict).toBe('close')
    expect(view.rounds[0]!.ruling!.sentence).toContain('The run ended, nothing was rewritten')
    expect(view.rounds[0]!.standing).toBe('close · 1 note on script v1')
    // A ruled gate is still readable — it is the record of a decision (D15, `gate.ts`).
    expect(view.chip).toContain('ruled')
    expect(view.standing).toContain('kept as the record of what you decided')
    expect(view.dock.headline).toContain('This round is closed; to change your mind')
  })

  it('says where each note went, in words rather than in an id', async () => {
    const runId = await presentTheEp01Script()
    rulings.close(openGates(store)[0]!.gate.id, {
      notes: [
        { note: 'the outline never turns here', depth: 'outline' },
        { note: 'and scene 4 is in the wrong place', depth: 'scene', target: 'scene-4' },
        { note: 'shot work is not this epic’s', depth: 'shot', target: 'shot-05' },
      ],
    })
    await runner.settled(runId)

    const notes = room(store.get<{ id: string }>('SELECT id FROM gate')!.id).rounds[0]!.ruling!.notes
    expect(notes[0]!.routing).toContain('routed at outline depth')
    expect(notes[0]!.routing).toContain('a newer version is the only thing that answers it')
    expect(notes[1]!.routing).toContain('a part of this draft, so it stays on this draft')
    // A depth that reaches nothing in this build is recorded and says so — never refused. It
    // carries a target exactly as the scene note above does, and the two are still told apart,
    // because what decides is the DEPTH rather than whether a box was filled in.
    expect(notes[2]!.routing).toContain('which E6 builds, so it reaches nothing on this episode yet')
    expect(notes[2]!.routing).toContain('recorded rather than refused')
    expect(notes[2]!.routing).not.toContain('part of this draft')
    // No artifact id anywhere: an id on a screen is the archaeology 4.6 forbids.
    for (const note of notes) expect(note.routing).not.toMatch(/art_|artifact_[0-9a-f]/)
  })
})

// ── The dock ───────────────────────────────────────────────────────────────────

describe('the dock offers four verbs, and a finding disables none of them', () => {
  it('renders all four enabled with two deterministic findings standing', async () => {
    theBoard()
    await presentTheEp01Script()
    const dock = room().dock

    for (const offer of [dock.approve, dock.override, dock.reject, dock.close]) {
      expect(offer.enabled).toBe(true)
      expect(offer.blockedBecause).toBeNull()
      // Verb + object + scope, in a sentence. No generic verbs anywhere on this dock.
      expect(offer.sentence).toContain('ep01 script')
      expect(offer.sentence.length).toBeGreaterThan(30)
    }
    // The headline says what stands and says that it does not stand in his way.
    expect(dock.headline).toContain('Your ruling closes round 1')
    expect(dock.headline).toContain('2 deterministic findings')
    expect(dock.headline).toContain('refuse the next stage and never this gate')
  })

  it('names what the override would be standing over, and what the close would free', async () => {
    theBoard()
    await presentTheEp01Script()
    const dock = room().dock

    expect(dock.override.sentence).toContain('OVER the vacuum-without-protection finding')
    expect(dock.close.sentence).toContain('Put the ep01 script down with your note')
    expect(dock.close.sentence).toContain('ep01 is free the moment you click')
    expect(dock.close.sentence).toContain('your note stands against the draft')
    expect(dock.close.cost).toBe('No model call · $0.00')
  })

  it('carries the two note refusals, and they are two different sentences', async () => {
    await presentTheEp01Script()
    const dock = room().dock

    expect(dock.rejectNeedsNote).toContain('the notes are what the step reopens with')
    expect(dock.closeNeedsNote).toContain('Nothing reopens on this verb')
    expect(dock.rejectNeedsNote).not.toBe(dock.closeNeedsNote)
    // Both name the artifact, so the disabled button reads as being about THIS draft.
    expect(dock.rejectNeedsNote).toContain('the ep01 script')
    expect(dock.closeNeedsNote).toContain('the ep01 script')
  })

  it('offers every ruled depth, never disabled, each saying where it would land', async () => {
    await presentTheEp01Script()
    const dock = room().dock

    // The unrouted default plus the closed set of 4.7 and D21 — nothing added, nothing hidden.
    expect(dock.depths.map((one) => one.depth)).toEqual(['', ...NOTE_DEPTH])
    for (const choice of dock.depths) {
      expect(choice.label).not.toBe('')
      expect(choice.because).not.toBe('')
    }
    expect(dock.depths[0]!.because).toContain('The default.')
    // A depth that reaches nothing is offered anyway, and says so before the click — because
    // nothing may block a ruling, and a route that lands nowhere is still a verdict he gave.
    const shot = dock.depths.find((one) => one.depth === 'shot')!
    expect(shot.because).toContain('recorded with no address rather than refused')
    expect(shot.needsTarget).toBe(true)
    expect(dock.depths.find((one) => one.depth === 'outline')!.needsTarget).toBe(false)
  })

  it('refuses all four in one sentence once the round is ruled, and only then', async () => {
    const runId = await presentTheEp01Script()
    rulings.approve(openGates(store)[0]!.gate.id, {})
    await runner.settled(runId)

    const dock = room(store.get<{ id: string }>('SELECT id FROM gate')!.id).dock
    for (const offer of [dock.approve, dock.override, dock.reject, dock.close]) {
      expect(offer.enabled).toBe(false)
      expect(offer.blockedBecause).toContain('was already ruled')
    }
  })
})

// ── The room around the decision ───────────────────────────────────────────────

describe('the room says where it is and what is happening behind it', () => {
  it('carries the breadcrumb, the chip and the standing line', async () => {
    await presentTheEp01Script()
    const view = room()

    expect(view.title).toBe('ep01 “The Long Pier” — the ep01 script')
    expect(view.where).toBe('Grey Harbor · Season 1')
    expect(view.floorHref).toBe('/')
    expect(view.episodeHref).toBe(`/episode/${ep01}`)
    expect(view.episodeRoom).toBe('the episode room')
    expect(view.episodeRoomNotYet).toBeNull()
    expect(view.chip).toContain('Round 1 · open')
    expect(view.standing).toContain('script v1 under review')
    expect(view.standing).toContain('the first time ep01 has put this in front of you')
  })

  it('renders the run as parked on him rather than as an absence', async () => {
    await presentTheEp01Script()
    const view = room()

    expect(view.live.idle).toBe(true)
    expect(view.live.heading).toContain('stopped here to ask you')
    // The last thing the STEP said, not a sentence this module composed about it — which on
    // the ordinary path is the presentation itself, said by the code that decided to present.
    expect(view.live.latest).toBe(
      'Presenting the ep01 script v1 for your ruling — round 1. 0 of 10 reviewers have read this draft.',
    )
    // The transitions are the log's own sentences, ordered by seq.
    expect(view.live.entries.map((one) => one.sentence)).toContain('the ep01 script gate is open')
  })

  it('says the same draft came back when a rejection re-presented it', async () => {
    const runId = await presentTheEp01Script()
    rulings.reject(openGates(store)[0]!.gate.id, { notes: [{ note: 'not yet' }] })
    await runner.settled(runId)

    expect(room().standing).toContain('nothing behind this gate rewrites anything')
    expect(room().standing).toContain('which is what putting it down is for')
  })

  it('answers undefined for a gate this library does not have', () => {
    expect(gateRoomView(store, paths, 'gate_nope', READY, NOW)).toBeUndefined()
  })
})

// ── The index ──────────────────────────────────────────────────────────────────

describe('the index is a thin list of sentences that link', () => {
  it('lists every open gate with where it is and how long it has waited', async () => {
    await presentTheEp01Script()
    const gateId = openGates(store)[0]!.gate.id

    const index = gateIndexView(store, paths, NOW)
    expect(index.gates).toHaveLength(1)
    expect(index.gates[0]!.gateId).toBe(gateId)
    expect(index.gates[0]!.sentence).toContain('ep01 — the ep01 script, round 1')
    expect(index.gates[0]!.sentence).toContain('opened')
    expect(index.gates[0]!.href).toBe(`/gate/${gateId}`)
    // Going there spends nothing; what a verdict buys is priced at the gate itself.
    expect(index.gates[0]!.open.cost).toContain('no model call · $0.00 to open it')
    expect(index.empty).toBeNull()
  })

  it('says so honestly when nothing is waiting, and names where the record lives', () => {
    const index = gateIndexView(store, paths, NOW)

    expect(index.gates).toEqual([])
    expect(index.empty!.lead).toBe('Nothing is waiting on your ruling.')
    expect(index.empty!.sentence).toContain('a ruled gate is the record of a decision')
    expect(index.heading.explains).toContain('opening one spends nothing')
  })

  it('drops a gate off the list the moment it is ruled — nothing was marked', async () => {
    const runId = await presentTheEp01Script()
    expect(gateIndexView(store, paths, NOW).gates).toHaveLength(1)

    rulings.close(openGates(store)[0]!.gate.id, { notes: [{ note: 'Not this week.' }] })
    await runner.settled(runId)

    expect(gateIndexView(store, paths, NOW).gates).toEqual([])
    expect(gateIndexView(store, paths, NOW).empty).not.toBeNull()
  })
})

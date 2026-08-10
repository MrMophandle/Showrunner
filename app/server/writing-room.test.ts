import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from './db/store.ts'
import { editArtifact } from './edit.ts'
import { artifactsOf, recordArtifact } from './domain/artifact.ts'
import { runBoardRules } from './domain/board-rules.ts'
import { recordExtractedBoard } from './domain/board.ts'
import { factsOfEntity } from './domain/fact.ts'
import { dismissFinding, findingsIn } from './domain/finding.ts'
import { createProposalRulings, raiseProposal } from './domain/proposal.ts'
import { sweepView } from './sweep.ts'
import { positionsOf } from './domain/arc.ts'
import { episodesOf, seasonsOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { theLongPierExtraction } from './fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import { declareEpisodePosition } from './canon-bench.ts'
import { createRulings, openGates, type Rulings } from './runner/gate.ts'
import { PREMISE_GATE_STAGE, SCRIPT_GATE_STAGE } from './runner/present-step.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { stageCatalogue } from './runner/stages.ts'
import { OUTLINE_STAGE, PREMISE_STAGE, SCRIPT_STAGE } from './runner/write-step.ts'
import { writingRoomView } from './writing-room.ts'

/**
 * **The writing room, and every expectation the E4 drill makes of it** — on fakes, on a
 * scratch volume, with no key in the environment and nothing reaching the network.
 *
 * The drill in `README.md` is operated by Ryan on real money. Every sentence it tells him to
 * expect is asserted here first, against the fake backend, so that operating it can surprise
 * him about what a model wrote and about nothing else. Where a test backs a numbered step of
 * the drill it says which.
 */

const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })

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
  root = mkdtempSync(join(tmpdir(), 'showrunner-room-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)

  const season = seasonsOf(store, harbor.show.id)[0]!.id
  ep01 = episodesOf(store, season).find((episode) => episode.number === 1)!.id
  ep02 = episodesOf(store, season).find((episode) => episode.number === 2)!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const room = (episodeId: string = ep02) => writingRoomView(store, paths, episodeId, READY)!

/**
 * **One writing round, on a backend of its own**: the draft, then a clean panel for every
 * reviewer it might convene.
 *
 * The fake answers a queue in order, and how many reviewers a panel convenes is a consequence
 * of who the draft turns out to be about (4.1) — so a stage that convenes fewer than were
 * queued leaves answers behind, and the NEXT stage's producer would take one of them as its
 * draft. A fresh backend per stage makes that impossible rather than making the counts exact,
 * which would be a test that breaks whenever a category declares one more artifact kind.
 *
 * Swapping the runner mid-suite is safe for the reason the whole app is crash-proof: a runner
 * holds no run state, it reads it (`runner.ts`), so a new one resumes a run an old one parked.
 */
function queueADraft(text: string): void {
  freshBackend()
  llm.reply(text)
  for (let reviewer = 0; reviewer < 20; reviewer += 1) llm.reply('{"findings": []}')
}

function freshBackend(): void {
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)
}

// ── The line, and what each button promises before the click ───────────────────

describe('the writing room — the line', () => {
  it('offers all three writing stages in line order, each a sentence with a cost', () => {
    const view = room()

    expect(view.line.map((step) => step.step)).toEqual(['premise', 'outline', 'script'])
    expect(view.line.map((step) => step.kind)).toEqual(['premise-brief', 'outline', 'script'])
    expect(view.line.map((step) => step.stage)).toEqual([
      PREMISE_STAGE,
      OUTLINE_STAGE,
      SCRIPT_STAGE,
    ])

    // Verb + object + scope, and the cost stated BEFORE the click — never "Run", never "Go".
    for (const step of view.line) {
      expect(step.offer.sentence).toMatch(/^Write the ep02 /)
      expect(step.offer.cost).toContain('your money, spent when you click')
      expect(step.offer.sentence).not.toMatch(/^(Run|Launch|Go|Do)\b/)
    }
    // The reviewer count is an UPPER bound and the button says so (E3-7's rule).
    expect(view.line[0]!.offer.sentence).toContain('up to')
  })

  it('offers the stage the lifecycle is at, and refuses the two it has not reached', () => {
    const view = room()

    expect(view.at).toBe('premise')
    expect(view.line[0]!.current).toBe(true)
    expect(view.line[0]!.offer.enabled).toBe(true)

    // The lifecycle column is how a writing stage asks "was the upstream ruled" (E4-2).
    expect(view.line[1]!.offer.enabled).toBe(false)
    expect(view.line[1]!.offer.blockedBecause).toContain(
      'ep02 is at premise and has not reached outline yet',
    )
    expect(view.line[2]!.offer.blockedBecause).toContain('has not reached script yet')
  })

  /** Drill step 6: the script button's cost covers the spend that lands past its gate (E4-4). */
  it('puts the post-gate extraction on the script button, because one click buys the whole run', () => {
    expect(room().line[2]!.offer.cost).toContain('after you approve it')
    expect(room().line[2]!.offer.cost).toContain('what the script claims of canon')
    // And the two that have no step past their gate do not claim one.
    expect(room().line[0]!.offer.cost).not.toContain('after you approve it')
    expect(room().line[1]!.offer.cost).not.toContain('after you approve it')
  })
})

// ── The desk inspector: what the writer was handed ─────────────────────────────

describe('the writing room — the desk inspector', () => {
  it('names every entity on the desk with the door it came through, in words', () => {
    const desk = room().line[0]!.desk

    // Core standing is the door the house style and the world rules come through, and there
    // is no fourth door for them (`write-context.ts`).
    const byName = new Map(desk.entities.map((entity) => [entity.name, entity]))
    expect(byName.has('Grey Harbor Station')).toBe(true)
    for (const entity of desk.entities) {
      expect(entity.reasons.length).toBeGreaterThan(0)
      for (const reason of entity.reasons) expect(reason.because).not.toBe('')
    }
    expect(
      desk.entities.flatMap((entity) => entity.reasons.map((one) => one.because)),
    ).toContain('standing core')
  })

  it('names every entity it was NOT handed, with the rule that kept it out', () => {
    const desk = room().line[0]!.desk

    // The half that cannot be inferred from what WAS included — "why did the writer not know
    // about X" is answerable from the screen, with no archaeology (4.6).
    expect(desk.leftOut.length).toBeGreaterThan(0)
    for (const entity of desk.leftOut) {
      expect(entity.because).toContain('so not core')
      expect(entity.name).not.toBe('')
    }
    // Sefa Doule is the fixture's deliberate candidate — registered, never ruled, and so on
    // nobody's desk.
    expect(desk.leftOut.map((entity) => entity.name)).toContain('Sefa Doule')
  })

  it('gives every fact the door in TIME it came through, in the prompt’s own words', () => {
    const desk = room().line[0]!.desk
    const facts = desk.entities.flatMap((entity) => entity.facts)

    expect(facts.length).toBeGreaterThan(0)
    for (const fact of facts) {
      expect(fact.reachSentence).not.toBe('')
      expect(['show-level', 'established-earlier', 'established-here', 'riding']).toContain(
        fact.reach,
      )
    }
    // Founded canon rides no episode, so the audience knows it from the start (D9, 1.2).
    expect(facts.some((fact) => fact.reach === 'show-level')).toBe(true)
    expect(facts.find((fact) => fact.reach === 'show-level')!.reachSentence).toBe(
      'show canon, true before the first episode',
    )
  })

  it('carries an inherited fact with the edge it travelled, never as the entity’s own (D22)', () => {
    const desk = room().line[0]!.desk
    const inherited = desk.entities
      .flatMap((entity) => entity.facts)
      .filter((fact) => fact.inherited !== null)

    expect(inherited.length).toBeGreaterThan(0)
    expect(inherited[0]!.inherited!.via).toBe('species')
  })

  it('composes the prompt with the step’s own function, and says what it is a floor of', () => {
    const desk = room().line[0]!.desk

    expect(desk.round).toBe(1)
    expect(desk.prompt).toContain('CANON, AS THE ep02 AUDIENCE KNOWS IT')
    expect(desk.prompt).toContain('WRITE THE ep02 PREMISE-BRIEF')
    // Honest confidence: what it cannot know before the click is named, not papered over.
    expect(desk.promptCaveat).toContain('round 1')
    expect(desk.promptCaveat).toContain('CHECKS’ notes')
    expect(desk.promptCaveat).toContain('floor on what the ep02 writer will be handed')
  })

  /**
   * The E4-0 property, re-asserted where Ryan reads it: an entity the desk left out cannot be
   * in the prompt, so "why did it not write about X" and "why did it not know about X" are the
   * same answer on one screen.
   */
  it('never lets an entity the desk left out appear in the prompt it renders', () => {
    const desk = room().line[0]!.desk

    for (const entity of desk.leftOut) expect(desk.prompt).not.toContain(entity.name)
    expect(desk.leftOut.length).toBeGreaterThan(0)
  })

  it('renders what it writes from — the artifact, not its path (D15)', async () => {
    await approveThePremise()
    const desk = room().line[1]!.desk

    expect(desk.upstream.expected).toBe('premise-brief')
    expect(desk.upstream.text).toContain('The spare is gone')
    expect(desk.upstream.version).toBe(1)
    // The premise reads from nothing, and says which kind of nothing it is.
    expect(room().line[0]!.desk.upstream.expected).toBeNull()
    expect(room().line[0]!.desk.upstream.note).toContain('reads from nothing')
  })

  it('says the episode is vanilla when it declares no position, and never as a failure', () => {
    const desk = room().line[0]!.desk

    expect(desk.vanilla).toBe(true)
    expect(desk.arcs.length).toBeGreaterThan(0)
    expect(desk.arcs[0]!.sentence).toContain('vanilla, which is legal and tracked')
  })
})

// ── The three note origins, kept apart ─────────────────────────────────────────

describe('the writing room — the three note origins', () => {
  /**
   * **Drill step 1's proof, and the exit's "a re-run provably reads the notes back".**
   *
   * All three authorities on one desk, distinguishable: a rejection Ryan made at this draft's
   * own gate, a note he wrote at a LATER artifact's gate and routed back here (D21), and a
   * finding he put down at the check bench. Flattened into a bag of sentences they would read
   * as three instructions with no provenance, which is what `NoteOrigin` exists to prevent.
   */
  it('distinguishes a gate rejection, a routed rejection and a dismissed finding', async () => {
    await approveThePremise()

    // (1) A rejection at the premise-brief's own gate — his opinion of the thing itself.
    const presented = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_GATE_STAGE })
    await runner.settled(presented.id)
    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'Too tidy. Say what it costs her.' }],
    })
    await runner.settled(presented.id)
    rulings.approve(openGates(store)[0]!.gate.id, {})
    await runner.settled(presented.id)

    // (2) A note written at the OUTLINE's gate and routed back to the premise (D21).
    await writeTheOutline()
    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'The premise is what is wrong, not this.', depth: 'premise' }],
    })
    await runner.settled(runsHere())

    // (3) A finding he put down at the check bench — his ruling on a CHECK.
    runTheBoardRules()
    dismissFinding(store, aStandingFinding(), 'scene 6 is a flash-forward; leave it')

    const notes = room().line[0]!.desk.notes
    const origins = new Set(notes.map((note) => note.origin))
    expect(origins).toEqual(
      new Set(['gate-rejection', 'routed-rejection', 'finding-dismissal']),
    )

    const byOrigin = new Map(notes.map((note) => [note.origin, note]))
    expect(byOrigin.get('gate-rejection')!.originSentence).toContain(
      'Your own rejection of this draft, at its gate',
    )
    expect(byOrigin.get('routed-rejection')!.originSentence).toContain(
      'given while you were standing at a later one (D21)',
    )
    expect(byOrigin.get('finding-dismissal')!.originSentence).toContain(
      'your ruling on a CHECK, which is a different act from rejecting a draft',
    )

    // Never a raw id on the screen: a resolved target is an artifact row, and an id is the
    // archaeology the HIL contract forbids.
    for (const note of notes) expect(note.originSentence).not.toMatch(/art_[0-9a-f]{12}/)

    // And every one of them is in the prompt the next click would send, verbatim.
    const prompt = room().line[0]!.desk.prompt
    for (const note of notes) expect(prompt).toContain(note.note)
  })
})

// ── The gates: readable, with their loop history and their findings ────────────

describe('the writing room — the gates', () => {
  it('renders every gate the episode has ever had, artifact and all, newest first', async () => {
    await approveThePremise()
    await writeTheOutline()

    const gates = room().gates
    expect(gates.length).toBe(2)
    expect(gates[0]!.subject).toContain('outline')
    expect(gates[1]!.subject).toContain('premise-brief')
    // A gate renders its artifact, readable, never a filename (D15, 4.6).
    expect(gates[1]!.artifact.text).toContain('The spare is gone')
    expect(gates[1]!.isOpen).toBe(false)
    expect(gates[1]!.stage).toBe(PREMISE_STAGE)
  })

  it('carries the loop history — one round per draft, every ruling kept (3.3)', async () => {
    await approveThePremise()
    const presented = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_GATE_STAGE })
    await runner.settled(presented.id)
    rulings.reject(openGates(store)[0]!.gate.id, { notes: [{ note: 'Not yet.' }] })
    await runner.settled(presented.id)

    const gate = room().gates[0]!
    expect(gate.rounds.length).toBe(2)
    expect(gate.rounds[0]!.ruling!.verdict).toBe('reject')
    expect(gate.rounds[0]!.ruling!.notes[0]!.note).toBe('Not yet.')
    expect(gate.rounds[1]!.ruling).toBeUndefined()
  })

  it('refuses the rejection with the exact sentence the API refuses with', async () => {
    await approveThePremise()
    const presented = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_GATE_STAGE })
    await runner.settled(presented.id)

    const gate = room().gates[0]!
    // One string, three readers: the disabled button, the route, and the ruling itself.
    expect(gate.rejectNeedsNote).toContain('Rejecting the ep02 premise-brief needs at least one')
    expect(() => rulings.reject(gate.id, { notes: [] })).toThrow(gate.rejectNeedsNote)
  })

  it('never disables a verdict on the artifact’s account — checks argue, they never veto', async () => {
    await approveThePremise()
    const presented = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_GATE_STAGE })
    await runner.settled(presented.id)

    const gate = room().gates[0]!
    expect(gate.approve.enabled).toBe(true)
    expect(gate.override.enabled).toBe(true)
    expect(gate.reject.enabled).toBe(true)
  })

  /** The premise-brief's and the outline's reviewers had no surface at all before this. */
  it('clusters what the checks said at the spans they said it about', async () => {
    const script = artifactsOf(store, ep01).find((one) => one.kind === 'script')!
    runTheBoardRules()
    const gate = runner.enqueueRun({ episodeId: ep01, stage: SCRIPT_GATE_STAGE })
    await runner.settled(gate.id)

    const rendered = room(ep01).gates[0]!
    expect(rendered.artifact.id).toBe(script.id)
    expect(rendered.clusters.length).toBeGreaterThan(0)

    // Severity and confidence as two values, never one (invariant 4) — and the tier beside
    // them, because `certain` off a row is not a model's certainty (4.2).
    const says = rendered.clusters.flatMap((cluster) => cluster.says)
    expect(says[0]!.sentence).toMatch(/ · severity \w+ · confidence \w+ · /)
    expect(says.some((say) => say.sentence.includes('deterministic, from the rows'))).toBe(true)
    // The fixture's planted dual presence, at the scene it was planted in.
    expect(says.map((say) => say.checkKey)).toContain('dual-presence')
  })

  it('marks a blocking finding and says on the card that it never reaches this gate (D12)', async () => {
    runTheBoardRules()
    const gate = runner.enqueueRun({ episodeId: ep01, stage: SCRIPT_GATE_STAGE })
    await runner.settled(gate.id)

    const rendered = room(ep01).gates[0]!
    const blocking = rendered.clusters.flatMap((cluster) => cluster.says).find((say) => say.blocking)!
    expect(blocking.blockingSentence).toContain('never this gate (D12)')
    expect(room(ep01).wall).toContain('ep01 is blocked')
    // And the gate's own verbs are untouched by it: checks argue, they never veto.
    expect(rendered.approve.enabled).toBe(true)
    expect(rendered.override.enabled).toBe(true)
    expect(rendered.override.sentence).toContain('recorded as your override forever')
  })
})

// ── The doors onto what is written (E4-5) ──────────────────────────────────────

describe('the writing room — Ryan’s two doors', () => {
  /**
   * **Drill steps 4 and 5**: the outline edited by hand BEFORE the script, so the script
   * provably builds from Ryan's own words — and then the staleness sentence, which appears
   * when the outline moves under a script already written and names why in words (1.3).
   */
  it('hands the script writer Ryan’s own words when he edits the outline first', async () => {
    await approveThePremise()
    await writeTheOutline()
    rulings.approve(openGates(store)[0]!.gate.id, {})
    await runner.settled(runsHere())

    const outline = artifactsOf(store, ep02).find((one) => one.kind === 'outline')!
    const HIS_WORDS = '# Dry stores, before the count\n\nIlse takes the spare and says nothing.\n'
    editArtifact(store, paths, { artifactId: outline.id, text: HIS_WORDS })

    // A hand-made asset wins: it landed word for word, as a new version beside the old one.
    const edited = room().written.find((one) => one.kind === 'outline')!
    expect(edited.version).toBe(2)
    // And the script writer's desk is handed exactly that — the proof the drill points at.
    const desk = room().line[2]!.desk
    expect(desk.upstream.text).toBe(HIS_WORDS)
    expect(desk.upstream.version).toBe(2)
    expect(desk.prompt).toContain('Ilse takes the spare and says nothing.')
  })

  it('says why a script is stale when the outline moves under it, and how it resolves', async () => {
    await approveThePremise()
    await writeTheOutline()
    rulings.approve(openGates(store)[0]!.gate.id, {})
    await runner.settled(runsHere())
    await writeTheScript()
    await approveTheScript()

    expect(room().written.find((one) => one.kind === 'script')!.status).toBe('fresh')

    const outline = artifactsOf(store, ep02).find((one) => one.kind === 'outline')!
    editArtifact(store, paths, {
      artifactId: outline.id,
      text: '# Dry stores\n\nIlse takes the spare and says nothing.\n',
    })

    const script = room().written.find((one) => one.kind === 'script')!
    expect(script.status).toBe('stale')
    // The reason, not just the fact — the revision summary is the load-bearing half.
    expect(script.staleBecause).toContain('you edited it by hand')
    expect(script.staleBecause).toContain('stands at v2 now')
    expect(script.staleBecause).toContain('stale until something is written from what the outline says now')
  })

  /** Drill step 5: `num_scenes` is an OUTPUT of the written episode, never an input (D3). */
  it('derives the scenes from the script the writer wrote, and prescribes none', async () => {
    await approveThePremise()
    await writeTheOutline()
    rulings.approve(openGates(store)[0]!.gate.id, {})
    await runner.settled(runsHere())

    // Nothing upstream said how many there would be: the outline's own ask forbids it.
    expect(room().line[1]!.desk.prompt).toContain('This is not a scene list')
    expect(room().line[2]!.desk.prompt).toContain('How many scenes there are is yours to decide')

    await writeTheScript()
    const scenes = store.all<{ heading: string }>(
      'SELECT heading FROM scene WHERE episode_id = ? ORDER BY ordinal',
      ep02,
    )
    expect(scenes.map((scene) => scene.heading)).toEqual([
      'INT. GREY HARBOR STATION — DRY STORES — 07:20',
      'INT. GREY HARBOR STATION — MESS DECK — 08:05',
    ])
  })

  it('offers the edit and the presenting door on every written artifact, both free', async () => {
    await approveThePremise()

    const written = room().written.find((one) => one.kind === 'premise-brief')!
    expect(written.edit.sentence).toContain('Edit the ep02 premise-brief yourself')
    expect(written.edit.cost).toBe('No model call · $0.00')
    expect(written.present.sentence).toContain('Present the ep02 premise-brief v1 for your ruling')
    expect(written.present.cost).toBe('No model call · $0.00')
  })
})

// ── The declare door (E4-4, D8) ────────────────────────────────────────────────

describe('the writing room — the arc pin', () => {
  /** Drill step 2: declaring ep02's waypoint early, free, raising nothing. */
  it('offers every waypoint of every arc the episode is written under, free', () => {
    const positions = room().positions!

    expect(positions.waypoints.length).toBeGreaterThan(0)
    for (const waypoint of positions.waypoints) {
      expect(waypoint.declare.cost).toBe('No model call · $0.00')
      expect(waypoint.declare.enabled).toBe(true)
      expect(waypoint.declare.sentence).toMatch(/^(Declare|Re-declare) ep02 at waypoint /)
    }
    expect(positions.standing).toContain('vanilla')
  })

  it('moves the pin, raises nothing, and says so on both surfaces', () => {
    const waypoint = room().positions!.waypoints[1]!
    declareEpisodePosition(store, {
      episodeId: ep02,
      arcId: waypoint.arcId,
      waypointId: waypoint.waypointId,
    })

    // The pin moved and the LANDING is still nobody's claim — it is raised when the script is
    // read, with the subject only the writer can answer for (D8, E4-4).
    expect(positionsOf(store, ep02)).toHaveLength(1)
    expect(room().sweep).toBeNull()

    const after = room()
    expect(after.positions!.waypoints[1]!.declared).toBe(true)
    expect(after.positions!.standing).toContain('A pin is not a fact')
    // And the desk the writer would be handed says where it stands.
    expect(after.line[0]!.desk.vanilla).toBe(false)
    expect(after.line[0]!.desk.arcs.find((arc) => arc.declaredOrdinal !== null)!.sentence)
      .toContain('A pin is not a landing')
  })
})

// ── The completion sweep, on the room (E4-6) ───────────────────────────────────

describe('the writing room — what the episode owes canon', () => {
  it('says nothing is owed while nothing rides', () => {
    expect(room().sweep).toBeNull()
  })

  it('offers the owed pass, free, and never as a wall', () => {
    raiseProposal(store, {
      entityId: harbor.entity('Ilse Renn').id,
      kind: 'fact-delta',
      raisedBy: 'writer',
      episodeId: ep02,
      facts: [{ statement: 'Ilse writes her diversions into the spares ledger by hand.' }],
    })

    const view = room()
    expect(view.sweep!.riders).toBe(1)
    expect(view.sweep!.open.cost).toBe('No model call · $0.00')
    expect(view.sweep!.sentence).toContain('rides ep02 until you rule it')
    // A pass that stands owed does not hold the line: the launch button beside it is live.
    expect(view.line[0]!.offer.enabled).toBe(true)
  })
})

// ── The spine: written end to end, extracted, and swept one at a time ──────────

describe('the writing room — ep02 written end to end', () => {
  /**
   * **Drill steps 2 through 7, in order**, on fakes: the pin declared early, the premise
   * approved and the lifecycle moving, the outline written and edited by hand, the script
   * built from Ryan's words with its scenes derived, the extraction raising riders past the
   * gate, and the sweep ruling them ONE AT A TIME.
   */
  it('moves the lifecycle by ruling, raises riders past the gate, and owes a pass', async () => {
    // Step 2 — the pin, declared before a word is written. Free, and it raises nothing.
    const waypoint = room().positions!.waypoints[1]!
    declareEpisodePosition(store, {
      episodeId: ep02,
      arcId: waypoint.arcId,
      waypointId: waypoint.waypointId,
    })
    expect(room().sweep).toBeNull()

    // Step 3 — the premise, written and approved. The approval is what moves the episode.
    expect(room().lifecycle).toBe('premise')
    await approveThePremise()
    expect(room().lifecycle).toBe('outline')
    expect(room().at).toBe('outline')

    // Step 4 — the outline, written, approved, then edited by hand before the script.
    await writeTheOutline()
    rulings.approve(openGates(store)[0]!.gate.id, {})
    await runner.settled(runsHere())
    expect(room().lifecycle).toBe('script')

    const outline = artifactsOf(store, ep02).find((one) => one.kind === 'outline')!
    editArtifact(store, paths, {
      artifactId: outline.id,
      text: '# Dry stores\n\nIlse takes the spare and says nothing about it.\n',
    })
    // An edit moves no episode — an approval is the only thing that does (E4-1).
    expect(room().lifecycle).toBe('script')

    // Step 5 — the script, built from his words, with its scenes derived from it.
    await writeTheScript()
    expect(room().line[2]!.desk.upstream.text).toContain('Ilse takes the spare')
    expect(
      store.all('SELECT id FROM scene WHERE episode_id = ?', ep02),
    ).toHaveLength(2)

    // Step 6 — the paid step past the gate. One click bought it, and the button said so.
    await approveTheScript(
      JSON.stringify({
        claims: [
          {
            entity: 'Ilse Renn',
            statement: 'Ilse Renn keeps a spare she has not declared.',
            quote: 'ILSE RENN stands at the racks with a slate.',
          },
        ],
        landings: [
          {
            arc: waypoint.arcId,
            subject: 'Ilse Renn',
            quote: 'ILSE RENN stands at the racks with a slate.',
          },
        ],
      }),
    )

    // Step 7 — the pass stands OWED. It never blocks, and it is computed off the queue.
    const owed = room().sweep!
    expect(owed.riders).toBe(2)
    expect(owed.sentence).toContain('ride ep02 until you rule them, one at a time')
    expect(owed.open.cost).toBe('No model call · $0.00')

    const pass = sweepView(store, ep02)!
    expect(pass.riders).toHaveLength(2)
    // One fact delta and one waypoint landing — and each carries its own three verbs.
    expect(pass.riders.map((rider) => rider.kind).sort()).toEqual(['fact-delta', 'landing'])
    for (const rider of pass.riders) {
      expect(rider.ratify.enabled).toBe(true)
      expect(rider.reject.enabled).toBe(true)
      expect(rider.defer.enabled).toBe(true)
    }

    // Ruled one at a time: ratify the delta, reject the landing with a note. Two rulings,
    // two rows on the ledger, and no verb anywhere that disposes of both.
    const proposals = createProposalRulings(store, events)
    const delta = pass.riders.find((rider) => rider.kind === 'fact-delta')!
    const landing = pass.riders.find((rider) => rider.kind === 'landing')!
    proposals.ratify(delta.id, { note: 'yes — that is the episode.' })
    expect(sweepView(store, ep02)!.riders).toHaveLength(1)
    proposals.reject(landing.id, { note: 'she has not been found out yet. Not this episode.' })

    // The pass is done, the sentence goes with it, and the card stops saying anything.
    expect(sweepView(store, ep02)!.owed).toBe(false)
    expect(sweepView(store, ep02)!.nothingBecause).toContain('The pass is done')
    expect(room().sweep).toBeNull()

    // And the ratified fact carries its lineage, which is what the drill quotes off the sheet.
    // Ratifying a provisional fact writes a NEW ROW — rows are immutable and status is
    // derived — so both are here, and only one of them is canon.
    const claimed = factsOfEntity(store, harbor.entity('Ilse Renn').id).filter((fact) =>
      fact.statement.includes('spare she has not declared'),
    )
    expect(claimed).toHaveLength(2)
    const ratified = claimed.find((fact) => fact.ratifiedBy !== null)!
    expect(ratified.establishedIn).toBe(ep02)
    expect(claimed.find((fact) => fact.ratifiedBy === null)!.closure).not.toBeNull()
  })
})

// ── The half-door, and the wall the drill routes around (issue #76) ────────────

describe('the writing room — an episode holding a pre-E4 artifact', () => {
  /**
   * **Drill step 1**, and the shape of ep02 in Ryan's own library: a premise-brief written
   * into slot `demo` by a stage E4-1 retired, approved at an E1 gate that carried no lifecycle
   * step, so the episode still stands at `premise`.
   */
  function theDemoEraBrief(): string {
    const filePath = 'greyharbor/s01e02/premise-brief-demo.md'
    const onDisk = join(paths.artifactDir, filePath)
    mkdirSync(dirname(onDisk), { recursive: true })
    writeFileSync(onDisk, 'The spare is gone and nobody has said so.\n')
    return recordArtifact(store, {
      episodeId: ep02,
      kind: 'premise-brief',
      slot: 'demo',
      filePath,
    }).id
  }

  it('refuses the write and names both doors, and the presenting door really opens', async () => {
    theDemoEraBrief()

    const view = room()
    expect(view.line[0]!.offer.enabled).toBe(false)
    expect(view.line[0]!.offer.blockedBecause).toBe(
      'ep02 already has a premise-brief, in slot “demo” — rule on it at its gate, or edit it directly (E4-5).',
    )
    // The refusal names a gate, and the gate is real — E4-5 widened the presenting stage's
    // question to the one the refusal asks, slot and all.
    const presented = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_GATE_STAGE })
    await runner.settled(presented.id)
    expect(room().gates[0]!.isOpen).toBe(true)
    expect(room().gates[0]!.artifact.text).toContain('The spare is gone')
  })

  it('carries a rejection at that gate onto the desk, with its origin, before any click', async () => {
    theDemoEraBrief()
    const presented = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_GATE_STAGE })
    await runner.settled(presented.id)
    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'Too tidy. Say what it costs her.' }],
    })
    await runner.settled(presented.id)

    // The round trip, proven where the drill tells Ryan to look: the note is on the desk the
    // next writer run would be handed, with the authority that wrote it, and in the prompt.
    const desk = room().line[0]!.desk
    expect(desk.notes).toHaveLength(1)
    expect(desk.notes[0]!.origin).toBe('gate-rejection')
    expect(desk.notes[0]!.note).toBe('Too tidy. Say what it costs her.')
    expect(desk.prompt).toContain('Too tidy. Say what it costs her.')
    expect(desk.prompt).toContain('WHAT THE SHOWRUNNER HAS ALREADY SAID')
  })

  /**
   * **The recorded gap (issue #76), pinned so the day it is closed this test says so.**
   *
   * A rejection at a presenting gate has nowhere to go: there is no producer behind it, so the
   * step re-presents; and the note cannot reopen the writing stage's offer, because
   * `unaddressedNotesTo` reads `routedNotesTo`, which excludes a note whose gate was over the
   * artifact it names. That exclusion is right for the DESK — it stops Ryan's words being
   * printed to a writer twice — and over-broad for the OFFER, which is a different question.
   *
   * The consequence is the whole of the gap: **an episode holding an artifact no writing gate
   * ever approved cannot leave its lifecycle stop.** The write stage is refused because the
   * artifact exists, the presenting stage carries no lifecycle step, and a hand edit
   * deliberately moves nothing (E4-5). The E4 drill routes around it and does not step on it.
   */
  it('records that neither door moves the lifecycle, which is issue #76', async () => {
    theDemoEraBrief()
    const presented = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_GATE_STAGE })
    await runner.settled(presented.id)
    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'Too tidy.', depth: 'premise' }],
    })
    await runner.settled(presented.id)
    rulings.approve(openGates(store)[0]!.gate.id, {})
    await runner.settled(presented.id)

    // Approving at a presenting gate rules the artifact and moves no episode.
    expect(room().lifecycle).toBe('premise')
    expect(room().line[0]!.offer.enabled).toBe(false)
    expect(room().line[0]!.offer.blockedBecause).toContain('already has a premise-brief')

    // And a hand edit is explicit that it does not move it either.
    const brief = room().written.find((one) => one.kind === 'premise-brief')!
    const edited = editArtifact(store, paths, {
      artifactId: brief.id,
      text: 'Ilse takes the spare, and the plant is three weeks from finding out.\n',
    })
    expect(edited.sentence).toContain('ep02 is still at premise')
    expect(room().line[0]!.offer.enabled).toBe(false)
    // The outline's refusal is the sentence that points nowhere while this stands.
    expect(room().line[1]!.offer.blockedBecause).toContain('has not reached outline yet')
  })
})

// ── ep01, untouched (the drill's last step) ────────────────────────────────────

describe('the writing room — reading it changes nothing', () => {
  it('composes three desks, every gate and every offer without writing a row', () => {
    const before = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact')!.n
    const runs = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM run')!.n
    const rulingRows = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_ruling')!.n

    room(ep01)
    room(ep02)

    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact')!.n).toBe(before)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM run')!.n).toBe(runs)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_ruling')!.n).toBe(rulingRows)
    // And nothing was called: opening a room is free (invariant 5 at page-load scale).
    expect(llm.calls).toHaveLength(0)
  })

  it('answers undefined for an episode this library does not have', () => {
    expect(writingRoomView(store, paths, 'ep_nope', READY)).toBeUndefined()
  })
})

// ── Kit ────────────────────────────────────────────────────────────────────────

/** The run holding this episode right now — whatever stage opened it. */
function runsHere(episodeId: string = ep02): string {
  return store.get<{ id: string }>(
    'SELECT id FROM run WHERE episode_id = ? ORDER BY seq DESC LIMIT 1',
    episodeId,
  )!.id
}

/** ep02's premise, written and approved — the lifecycle seam, moved by the ruling (E4-1). */
async function approveThePremise(): Promise<void> {
  queueADraft('The spare is gone and nobody has said so.')
  const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
  await runner.settled(run.id)
  rulings.approve(openGates(store)[0]!.gate.id, {})
  await runner.settled(run.id)
}

/** ep02's outline, written and parked at its gate. */
async function writeTheOutline(): Promise<void> {
  queueADraft('# Morning, inboard\n\nIlse counts the spares and one is missing.\n')
  const run = runner.enqueueRun({ episodeId: ep02, stage: OUTLINE_STAGE })
  await runner.settled(run.id)
}

/**
 * A script whose scenes can be read out of it — a scene IS its heading (`domain/delineate.ts`),
 * and two the same cannot be told apart afterwards.
 */
const TWO_SCENES = [
  '## 1 · INT. GREY HARBOR STATION — DRY STORES — 07:20',
  '',
  '> Ilse counts the spares and one is missing.',
  '',
  'ILSE RENN stands at the racks with a slate.',
  '',
  '## 2 · INT. GREY HARBOR STATION — MESS DECK — 08:05',
  '',
  '> She says nothing about it.',
  '',
  'TOBIN WICK pours the last of the coffee.',
  '',
].join('\n')

/** ep02's script, written and parked at its gate. */
async function writeTheScript(): Promise<void> {
  queueADraft(TWO_SCENES)
  const run = runner.enqueueRun({ episodeId: ep02, stage: SCRIPT_STAGE })
  await runner.settled(run.id)
}

/**
 * Approving the script, and the paid step that lands on the far side of it (E4-4): the
 * extraction reads the draft Ryan APPROVED and raises what it claims of canon. A draft that
 * claims nothing says so — a zero-claims pass is a real and legal answer (`claim.ts`).
 */
async function approveTheScript(claims = '{"claims": [], "landings": []}'): Promise<void> {
  freshBackend()
  llm.reply(claims)
  rulings.approve(openGates(store)[0]!.gate.id, {})
  await runner.settled(runsHere())
}

/**
 * **The fixture's own planted defects, raised the way E3 raises them**: the hand-written
 * continuity board read into rows, and the four deterministic rules run over it. Scene 4's
 * vacuum violation and scenes 5–6's dual presence are the fixture's fixed points (E1's ledger),
 * so nothing here invents a finding — it runs the rules that find the ones already planted.
 */
function runTheBoardRules(): void {
  const script = artifactsOf(store, ep01).find((one) => one.kind === 'script')!
  const factOf = (entity: string, needle: string): string => {
    const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
    return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
  }
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

/** One finding standing on ep01's script, for the dismissal origin. */
function aStandingFinding(): string {
  const script = artifactsOf(store, ep01).find((one) => one.kind === 'script')!
  return findingsIn(store, script.id)[0]!.id
}

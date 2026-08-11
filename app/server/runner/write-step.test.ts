import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { costOfRun } from '../cost.ts'
import type { Store } from '../db/store.ts'
import {
  artifactsOf,
  declareProvenance,
  provenanceOf,
  recordArtifact,
  revisionsOf,
  type Artifact,
} from '../domain/artifact.ts'
import { registerEntity } from '../domain/canon.ts'
import { declareCategory } from '../domain/category.ts'
import { abandonEpisode } from '../domain/episode-canon.ts'
import { checkPassesOf } from '../domain/finding.ts'
import { panelFor } from '../domain/panel.ts'
import { createProposalRulings, raiseProposal } from '../domain/proposal.ts'
import { createEpisode, episodesOf, findEpisode, seasonsOf } from '../domain/spine.ts'
import { createEventLog, eventsOfRun, type EventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { describeLLMBackend, type LLMReadiness } from '../llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { launchBlockedBecause, stageOffer } from '../operating.ts'
import type { CorrectionOutcome } from './correction-loop.ts'
import { createRulings, gateStanding, openGates, type Rulings } from './gate.ts'
import { findStepByName, stepsOf } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import { stageCatalogue } from './stages.ts'
import { PREMISE_STAGE, type WriteClose } from './write-step.ts'

/**
 * **The premise stage** (E4-1, 1.1, 4.4): the first real writing stage, and the first
 * consumer of E4-0's writer's desk — context → one call → a brief, inside the correction
 * loop, landing at a gate.
 *
 * Everything here runs the REAL stage through the REAL runner against a REAL library volume
 * with Grey Harbor **founded** in it, and the fake backend in front of the model. No test in
 * this repo may spend a cent (fixtures before features).
 *
 * The load-bearing test is `the desk is what reaches the model`: the prompt is asserted
 * against what the adapter was really handed, and it asserts the desk's DISTINCTIVE content
 * — prose only the desk carries, a fact only its audience filter admits, a fact only its
 * audience filter refuses, and the absence of every entity it deliberately left out. A
 * parallel composer that queried canon itself would pass none of those four at once.
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
/** ep02 "Dry Stores" — the un-started episode. Nothing has been written for it. */
let ep02: string
let ep01: string
let ep03: string

/**
 * The drafts the fake writes. Both name **Ilse Renn and nobody else**, which is what makes
 * the convened panel a fixed number: her category is the only one that reaches the brief's
 * provenance, so the roster is `character` + the two craft reviewers a premise-brief is read
 * by (D13). Naming "the harbour" would put the station in it and make it four.
 */
const FIRST = [
  'Ilse Renn has three days of water in the tanks and a roster she will not re-cut.',
  'Nobody signs for the exchanger, so nobody is at fault, and so nothing moves.',
].join('\n')

const SECOND = [
  'The exchanger fails on a Tuesday. Ilse Renn re-cuts the roster the same evening and',
  'signs the fault herself, which is the part nobody expected of her.',
].join('\n')

/** What a premise-brief convenes in this fixture: the character check, story-craft, hook. */
const PANEL_SIZE = 3
const NOTHING_FOUND = '{"findings": []}'

const HOUSE_STYLE_BODY = [
  'The narrator never explains the harbour. Sentences are short when something is',
  'breaking and long when nobody will say why. No scene ends on a question.',
].join('\n')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-premise-'))
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
  // The future. The audience filter is only testable against an episode that has ratified
  // canon ep02's audience has not seen (D7: episodes parallelize).
  ep03 = createEpisode(store, { seasonId: season.id, number: 3, title: 'Slack Water' }).id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

// ── Planting ────────────────────────────────────────────────────────────────────

/** One round: the writer's draft, then the whole panel's answers to it, in roster order. */
function queueRound(draft: string, ...panel: string[]): void {
  llm.reply(draft)
  const said = [...panel]
  while (said.length < PANEL_SIZE) said.push(NOTHING_FOUND)
  for (const reply of said) llm.reply(reply)
}

/** A fact ratified into canon, riding the episode named. */
function ratifyFact(entity: string, statement: string, episodeId: string): void {
  const proposal = raiseProposal(store, {
    entityId: harbor.entity(entity).id,
    kind: 'fact-delta',
    raisedBy: 'writer',
    episodeId,
    facts: [{ statement }],
  })
  createProposalRulings(store, createEventLog(store)).ratify(proposal.id, { note: 'yes.' })
}

/**
 * A house style, promoted the way canon is made. The fixture ships no house-style sheet on
 * purpose, and the desk carries its prose anyway — through `core` standing and no door of
 * its own. It applies to the outline and the script, so it convenes nothing over a
 * premise-brief and the roster below stays the number it is.
 */
function foundHouseStyle(): void {
  const category = declareCategory(store, {
    showId: harbor.show.id,
    key: 'house-style',
    name: 'House style',
    blurb: 'Narrator voice, pacing, content constraints.',
    appliesTo: ['outline', 'script'],
    checkInstructions: 'Read the draft against the voice below.',
  })
  const entity = registerEntity(store, {
    showId: harbor.show.id,
    categoryKey: category.key,
    name: 'The Grey Harbor voice',
  })
  const proposal = raiseProposal(store, {
    entityId: entity.id,
    kind: 'promotion',
    raisedBy: 'ryan',
    standing: 'core',
    body: HOUSE_STYLE_BODY,
  })
  createProposalRulings(store, createEventLog(store)).ratify(proposal.id, { note: 'that is it.' })
}

// ── Reading ─────────────────────────────────────────────────────────────────────

async function writeThePremise(episodeId: string = ep02): Promise<string> {
  const run = runner.enqueueRun({ episodeId, stage: PREMISE_STAGE })
  const settled = await runner.settled(run.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? 'the run failed')
  return run.id
}

/** The producer's calls, told apart from the panel's by what only the writer is asked for. */
const writerPrompts = (): string[] =>
  llm.calls.filter((call) => call.prompt.includes('WRITE THE ep02 PREMISE-BRIEF')).map((c) => c.prompt)

const brief = (episodeId: string = ep02): Artifact =>
  artifactsOf(store, episodeId).find((one) => one.kind === 'premise-brief')!

const premiseStage = () => stageCatalogue(paths)[PREMISE_STAGE]!

const lifecycleOf = (episodeId: string = ep02): string => findEpisode(store, episodeId)!.lifecycle

// ── Trap 1: the desk is what reaches the model ──────────────────────────────────

describe('the desk is what reaches the model', () => {
  it('carries the prose, the lineage and the silence the desk composed — and nothing else', async () => {
    foundHouseStyle()
    ratifyFact('Ilse Renn', 'Ilse signed the beacon over to Tobin for one night.', ep01)
    // Ratified on a Tuesday while ep02 is being written. `canonAsOf(now)` shows it; the ep02
    // audience has not seen it, so the desk refuses it — and so, therefore, does the prompt.
    ratifyFact('Ilse Renn', 'Ilse told the crew the lane is never reopening.', ep03)
    queueRound(FIRST)

    await writeThePremise()

    const [prompt] = writerPrompts()
    expect(writerPrompts()).toHaveLength(1)

    // The house style's prose, which arrives through `core` standing and no door of its own.
    expect(prompt).toContain('The narrator never explains the harbour.')
    // The world rules, likewise — prose the show does not get to bend.
    expect(prompt).toContain('two hundred years calling itself')
    // A fact with ep01 lineage, on ep02's desk because ep01 is already on screen.
    expect(prompt).toContain('Ilse signed the beacon over to Tobin for one night.')
    expect(prompt).toContain('established in an earlier episode')
    // And the one a LATER episode ratified, refused. A parallel composer reading canon as it
    // stands now would have leaked this, and every other assertion here would still pass.
    expect(prompt).not.toContain('Ilse told the crew the lane is never reopening.')

    // The confession trail stays off the wire: `leftOut` carries identities so a surface can
    // answer "why did the writer not know about X", and a prompt composer iterating the slice
    // cannot leak one into a call.
    expect(prompt).not.toContain('Sefa Doule')
    expect(prompt).not.toContain('the assessor')
  })

  it('carries the arcs it is written under, and says vanilla is legal', async () => {
    queueRound(FIRST)
    await writeThePremise()

    const [prompt] = writerPrompts()
    expect(prompt).toContain('What the harbor is for')
    expect(prompt).toContain('The harbor is worth spending on')
    expect(prompt).toContain('vanilla')
  })

  it('says out loud that the premise step reads from nothing upstream', async () => {
    queueRound(FIRST)
    await writeThePremise()

    expect(writerPrompts()[0]).toContain('reads from nothing')
  })
})

// ── The stage itself: one call, one artifact, one gate ──────────────────────────

describe('the premise stage — context, one call, a brief, a gate', () => {
  it('writes the brief, files it, declares what it touches, and parks on Ryan', async () => {
    queueRound(FIRST)

    const runId = await writeThePremise()

    // One writing call, and one per convened reviewer beside it.
    expect(writerPrompts()).toHaveLength(1)
    expect(llm.calls).toHaveLength(1 + PANEL_SIZE)

    const artifact = brief()
    expect(artifact).toMatchObject({ kind: 'premise-brief', slot: '', version: 1 })
    expect(artifact.filePath).toBe('greyharbor/s01e02/premise-brief-round-1.md')
    expect(readFileSync(join(paths.artifactDir, artifact.filePath!), 'utf8')).toBe(`${FIRST}\n`)

    // Provenance, declared out of what it WROTE (invariant 2) — the entities the desk handed
    // it that the draft actually names, and nobody else. Six were on the desk; one is in it.
    expect(provenanceOf(store, artifact.id).map((entity) => entity.name)).toEqual(['Ilse Renn'])

    // Parked on a decision, with the loop history under it.
    const standing = gateStanding(store, openGates(store)[0]!.gate.id)!
    expect(standing).toMatchObject({ round: 1, isOpen: true, subject: 'the ep02 premise-brief' })
    const payload = standing.rounds[0]!.payload as CorrectionOutcome
    expect(payload.rounds.map((round) => [round.artifactVersion, round.checks])).toEqual([
      [1, PANEL_SIZE],
    ])
    expect(payload).toMatchObject({ converged: true, clean: true })

    expect(stepsOf(store, runId).map((step) => [step.name, step.status])).toEqual([
      ['write-the-premise-brief', 'paused'],
      ['advance-past-the-premise-gate', 'pending'],
    ])
    expect(costOfRun(store, runId).calls).toBe(1 + PANEL_SIZE)
  })

  it('streams what the model wrote while it is writing it', async () => {
    queueRound(FIRST)
    const runId = await writeThePremise()

    const prose = eventsOfRun(store, runId)
      .filter((event) => event.kind === 'step-chunk')
      .map((event) => event.summary)
      .join('')
    expect(prose).toContain('Ilse Renn has three days of water')
  })

  it('says so when the model stopped at the ceiling rather than at the end', async () => {
    // Paid for, real, and filed — but it stops mid-sentence, and Ryan is told rather than
    // handed a truncated artifact that looks finished (invariant 4).
    llm.reply({ text: FIRST, stopReason: 'max_tokens' })
    for (let reviewer = 0; reviewer < PANEL_SIZE; reviewer += 1) llm.reply(NOTHING_FOUND)

    const runId = await writeThePremise()

    expect(eventsOfRun(store, runId).map((event) => event.summary)).toContain(
      'The model stopped at the 4000-token ceiling — the draft below stops mid-sentence',
    )
  })

  it('keeps a draft already on the volume and makes no call for it (D20)', async () => {
    // What a crash between writing the draft and recording the row leaves behind — and what
    // a hand-made asset looks like. Either way it wins, and it is not paid for twice.
    const at = join(paths.artifactDir, 'greyharbor/s01e02/premise-brief-round-1.md')
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, `${FIRST}\n`, 'utf8')
    for (let reviewer = 0; reviewer < PANEL_SIZE; reviewer += 1) llm.reply(NOTHING_FOUND)

    const runId = await writeThePremise()

    expect(writerPrompts()).toHaveLength(0)
    expect(readFileSync(at, 'utf8')).toBe(`${FIRST}\n`)
    // The row and its provenance are recorded anyway: a hand-made draft touches whoever it
    // names, and a check that never loaded Ilse would be a clean reading of nothing.
    expect(provenanceOf(store, brief().id).map((entity) => entity.name)).toEqual(['Ilse Renn'])
    expect(costOfRun(store, runId).calls).toBe(PANEL_SIZE)
  })
})

// ── Trap 6: convening stays data, and story-craft arrives unbidden ──────────────

describe('what a premise-brief convenes', () => {
  it('is read by story-craft, unbidden, and its pass is recorded (D13)', async () => {
    queueRound(FIRST)
    await writeThePremise()

    const passes = checkPassesOf(store, brief().id)
    expect(passes.map((pass) => pass.checkKey)).toEqual(['character', 'story-craft', 'hook'])
    // A clean run is a measurement: story-craft read it, found nothing, and has a row saying
    // so — D11's denominator, and the reason silence is queryable at all.
    const craft = passes.find((pass) => pass.checkKey === 'story-craft')!
    expect(craft).toMatchObject({ findingCount: 0, scopeCount: 0 })

    const payload = gateStanding(store, openGates(store)[0]!.gate.id)!.rounds[0]!
      .payload as CorrectionOutcome
    expect(payload.board.rows.map((row) => [row.checkKey, row.verdict])).toEqual([
      ['character', 'clean'],
      ['story-craft', 'clean'],
      ['hook', 'clean'],
    ])
  })

  it('grows its roster by a DECLARATION, with no code change anywhere', async () => {
    queueRound(FIRST)
    await writeThePremise()
    const artifact = brief()

    expect(panelFor(store, artifact).map((subject) => subject.key)).toEqual([
      'character',
      'story-craft',
      'hook',
    ])

    // A category is data (3.2). Declare one that names this artifact kind, put one of its
    // entities in the brief's provenance, and the roster is longer. Nothing in code moved.
    const category = declareCategory(store, {
      showId: harbor.show.id,
      key: 'faction',
      name: 'Faction',
      appliesTo: ['premise-brief', 'outline', 'script'],
      checkInstructions: 'Read the draft against what the faction wants.',
    })
    const office = registerEntity(store, {
      showId: harbor.show.id,
      categoryKey: category.key,
      name: 'The line office',
    })
    declareProvenance(store, artifact.id, [office.id])

    expect(panelFor(store, artifact).map((subject) => subject.key)).toEqual([
      'character',
      'faction',
      'story-craft',
      'hook',
    ])
  })

  it('leaves a declared category home when the brief is about none of its entities (4.1)', async () => {
    queueRound(FIRST)
    await writeThePremise()

    // `location`, `species`, `technology` and `world-rules` all declare `premise-brief` in
    // the fixture's sheets. None of them convenes, because this brief names nobody of theirs
    // — invariant 2 from the other side: a check loads exactly what the artifact touches.
    expect(panelFor(store, brief()).map((subject) => subject.key)).not.toContain('world-rules')
  })
})

// ── Trap 2: the rejection note travels through the desk ─────────────────────────

describe('a rejection at the gate reaches the next draft through the desk', () => {
  it('arrives in the prompt with its round attribution, not through a side channel', async () => {
    queueRound(FIRST)
    const runId = await writeThePremise()

    queueRound(SECOND)
    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'Too tidy. Nobody in Grey Harbor says whose fault it is.', depth: 'premise' }],
    })
    await runner.settled(runId)

    const prompts = writerPrompts()
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toContain('Too tidy.')
    // The note, verbatim — and the sentence the DESK composed around it, which is what says
    // it arrived through `composeWriteContext` rather than off the loop's brief.
    expect(prompts[1]).toContain('Too tidy. Nobody in Grey Harbor says whose fault it is.')
    expect(prompts[1]).toContain('your round 1 rejection of the ep02 premise-brief')
    expect(prompts[1]).toContain('routed at premise depth')
    // Said once. Reading his note off the brief AS WELL as off the desk would print it twice.
    expect(prompts[1]!.split('Too tidy.')).toHaveLength(2)

    // Round 2 of the same gate, on version 2 of the same artifact, each draft its own file.
    const standing = gateStanding(store, openGates(store)[0]!.gate.id)!
    expect(standing.round).toBe(2)
    expect(revisionsOf(store, brief().id).map((one) => one.version)).toEqual([1, 2])
    expect(existsSync(join(paths.artifactDir, 'greyharbor/s01e02/premise-brief-round-1.md'))).toBe(true)
    expect(brief().filePath).toBe('greyharbor/s01e02/premise-brief-round-2.md')
  })
})

// ── Trap 4: the lifecycle seam ──────────────────────────────────────────────────

describe('lifecycle moves on the gate, and not before', () => {
  it('leaves the episode at premise while the brief sits at its gate', async () => {
    queueRound(FIRST)
    await writeThePremise()

    // The brief is written, checked and presented. ep02 is still AT premise, because
    // lifecycle names the stage the episode is doing and nobody has approved it.
    expect(brief()).toBeDefined()
    expect(lifecycleOf()).toBe('premise')
  })

  it('moves it to outline when Ryan approves, and closes the run with what it cost', async () => {
    queueRound(FIRST)
    const runId = await writeThePremise()

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that reads.' })
    const settled = await runner.settled(runId)

    expect(settled.status).toBe('done')
    expect(lifecycleOf()).toBe('outline')
    // Nothing re-written, nothing re-checked, nothing re-spent on the way back in.
    expect(llm.calls).toHaveLength(1 + PANEL_SIZE)

    const close = findStepByName(store, runId, 'advance-past-the-premise-gate')!
      .output as WriteClose
    expect(close.verdict).toBe('approve')
    expect(close.lifecycle).toMatchObject({ from: 'premise', to: 'outline', moved: true })
    expect(close.sentence).toContain('ep02 moves from premise to outline')
    expect(close.sentence).toMatch(/\$\d+\.\d\d/)
  })

  it('moves it on an override too — an override is an approval with a record', async () => {
    queueRound(FIRST)
    const runId = await writeThePremise()

    rulings.override(openGates(store)[0]!.gate.id, {})
    await runner.settled(runId)

    expect(lifecycleOf()).toBe('outline')
  })

  it('keeps the stage an abandoned episode reached', async () => {
    queueRound(FIRST)
    const runId = await writeThePremise()
    abandonEpisode(store, ep02, { note: 'the exchanger story belongs to ep05.' })

    rulings.approve(openGates(store)[0]!.gate.id, {})
    await runner.settled(runId)

    expect(lifecycleOf()).toBe('premise')
    expect(findEpisode(store, ep02)!.abandonedAt).not.toBeNull()
    const close = findStepByName(store, runId, 'advance-past-the-premise-gate')!
      .output as WriteClose
    expect(close.lifecycle.moved).toBe(false)
    expect(close.lifecycle.sentence).toContain('was abandoned at premise')
  })
})

// ── Trap 5: an existing brief means nothing to do, in words ─────────────────────

describe('an episode that already has a premise-brief', () => {
  it('is refused in words, before the click, and its brief is never rewritten', async () => {
    // ep01 carries the fixture's own hand-written premise. A hand-made asset always wins.
    const before = readFileSync(join(paths.artifactDir, brief(ep01).filePath!), 'utf8')

    const offer = stageOffer(store, READY, ep01, premiseStage())
    expect(offer.enabled).toBe(false)
    expect(offer.blockedBecause).toContain('ep01 already has a premise-brief')
    expect(offer.blockedBecause).toContain('rule on it at its gate, or edit it directly')
    // The cost is still stated: what it would have cost is not a secret because it is blocked.
    expect(offer.cost).toContain('Opus call')

    // And the API refuses with the same string the disabled button was showing.
    expect(launchBlockedBecause(store, READY, ep01, premiseStage())).toBe(offer.blockedBecause)
    expect(readFileSync(join(paths.artifactDir, brief(ep01).filePath!), 'utf8')).toBe(before)
    expect(llm.calls).toHaveLength(0)
  })

  it('names the slot when the brief that is there came from somewhere else', () => {
    // What Ryan's own library holds: a premise-brief the retired demo stage wrote into its
    // own slot. It still counts, and the refusal says which one it is talking about.
    recordArtifact(store, {
      episodeId: ep02,
      kind: 'premise-brief',
      slot: 'demo',
      filePath: 'greyharbor/s01e02/demo/premise-round-1.md',
    })

    expect(launchBlockedBecause(store, READY, ep02, premiseStage())).toContain('slot “demo”')
  })

  it('offers ep02 in full sentences while it has none', () => {
    const offer = stageOffer(store, READY, ep02, premiseStage())

    expect(offer.enabled).toBe(true)
    expect(offer.blockedBecause).toBeNull()
    expect(offer.sentence).toContain('Write the ep02 premise-brief')
    expect(offer.sentence).toContain('Dry Stores')
    expect(offer.sentence).not.toMatch(/^(Launch|Run|Go|Do|Start)\b/)
    // Verb + object + scope + cost: the writing call, the reviewers it convenes, the bound.
    expect(offer.cost).toMatch(/Opus call.*~\$\d+\.\d\d/)
    expect(offer.cost).toContain('your money, spent when you click')
  })
})

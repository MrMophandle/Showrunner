import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonBenchView, declareEpisodePosition } from '../canon-bench.ts'
import type { Store } from '../db/store.ts'
import { arcsOf, positionsOf, waypointsOf } from '../domain/arc.ts'
import { artifactsOf, provenanceOf, type Artifact } from '../domain/artifact.ts'
import { landingOf, sweepEpisode } from '../domain/episode-canon.ts'
import { canonAsOf, factsInScope, factsOfEntity } from '../domain/fact.ts'
import { createProposalRulings, proposalsRiding } from '../domain/proposal.ts'
import { createEpisode, episodesOf, findEpisode, seasonsOf } from '../domain/spine.ts'
import { composeWriteContext } from '../domain/write-context.ts'
import { createEventLog, type EventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { bindLLM } from '../llm/adapter.ts'
import { describeLLMBackend, type LLMReadiness } from '../llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { stageOffer } from '../operating.ts'
import { createRulings, openGates, type Rulings } from './gate.ts'
import { findStepByName, stepsOf } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import { stageCatalogue } from './stages.ts'
import type { ClaimExtractionOutcome } from './claim-step.ts'
import { OUTLINE_STAGE, PREMISE_STAGE, SCRIPT_STAGE } from './write-step.ts'

/**
 * **What writing does to canon** (E4-4, #64) — extraction, landings, and the door that
 * declares a position.
 *
 * Everything in this file RAISES, and the last test is the issue's signature: the whole of it
 * runs, and `canon_ruling` and canon's own facts come out byte for byte identical. Raising
 * writes proposals, and proposals are not canon (invariant 1).
 *
 * The real stages run through the real runner against a real library volume with Grey Harbor
 * founded in it, and the fake backend in front of the model. No test in this repo may spend a
 * cent (fixtures before features).
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

/**
 * ep02's script. Three lines in it are load-bearing and each is quoted by the extraction below:
 * the ledger line (a claim canon argues with), the roster line (a claim canon already stands
 * on, verbatim), and the drawer line (the waypoint-2 landing — a resource diverted, answered
 * with the schedule).
 */
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
  'TOBIN',
  'It has been climbing three weeks.',
  '',
  "## 2 · INT. HARBOURMASTER'S OFFICE — 06:30",
  '',
  '> Ilse is asked where the spare went, and answers with the roster.',
  '',
  'Ilse Renn is at the desk at Grey Harbor Station. The spares drawer is open and empty, and',
  'the diversion is written up in her own hand in the back of the spares ledger.',
  '',
  'TOBIN',
  'There was one in that drawer in Marrowmas.',
  '',
  'ILSE',
  'The roster says you are on the plant at seven.',
  '',
  '## 3 · INT. DRY STORES — 18:00',
  '',
  '> The water goes on ration and nobody says whose fault it is.',
  '',
  'Ilse Renn writes the ration up on the board and does not sign it.',
].join('\n')

const SCRIPT_PANEL = 6

const NOTHING_FOUND = '{"findings": []}'

/** The line the contradiction is quoted from — inside scene 2, and nowhere else. */
const LEDGER_LINE = 'the diversion is written up in her own hand in the back of the spares ledger'

/** The line the landing is quoted from. */
const LANDING_LINE = 'The roster says you are on the plant at seven.'

/** What canon already says, word for word — the claim that must NOT be raised again. */
const STANDING_VERBATIM =
  'Ilse posts the duty roster on Sunday and treats it as the answer to most questions about ' +
  'the harbour.'

/** The fact the script argues with: she has never filed a diversion, and here she has. */
const NEVER_FILED = 'Ilse has never filed a diversion against the harbour'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-claims-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)

  const season = seasonsOf(store, harbor.show.id)[0]!
  const episodes = episodesOf(store, season.id)
  ep02 = episodes[1]!.id
  ep03 = createEpisode(store, { seasonId: season.id, number: 3, title: 'Slack Water' }).id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

// ── Getting ep02 to an approved script, the way Ryan would ──────────────────────

function queueRound(draft: string, panel: number, ...said: string[]): void {
  llm.reply(draft)
  const answers = [...said]
  while (answers.length < panel) answers.push(NOTHING_FOUND)
  for (const answer of answers) llm.reply(answer)
}

/**
 * One more reviewer convenes for every arc position the episode declares (`domain/panel.ts`),
 * so a test that pins ep02 before writing it is scripting a bigger panel — read off the rows
 * rather than written down twice.
 */
const panel = (base: number): number => base + positionsOf(store, ep02).length

/** ep02 through the premise and the outline, each approved at its own gate. */
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

/** Approves the script gate, which is what carries the run on into the extraction. */
async function approveTheScript(runId: string): Promise<void> {
  rulings.approve(openGates(store)[0]!.gate.id, { comment: 'shoot it.' })
  await runner.settled(runId)
}

// ── Reading ─────────────────────────────────────────────────────────────────────

const script = (): Artifact => artifactsOf(store, ep02).find((one) => one.kind === 'script')!

const factOf = (name: string, needle: string) =>
  factsOfEntity(store, harbor.entity(name).id).find((fact) => fact.statement.includes(needle))!

const extractionPrompt = (): string =>
  llm.calls.find((call) => call.prompt.includes('## The canon this script declares it touches'))!
    .prompt

const outcomeOf = (runId: string): ClaimExtractionOutcome =>
  findStepByName(store, runId, 'extract-the-canon-claims')!.output as ClaimExtractionOutcome

/** The waypoint-2 pin, declared the only way this app declares one — through the door. */
function declareWaypointTwo(): { arcId: string; waypointId: string } {
  const arc = arcsOf(store, harbor.show.id)[0]!
  const waypoint = waypointsOf(store, arc.id).find((one) => one.ordinal === 2)!
  declareEpisodePosition(store, { episodeId: ep02, arcId: arc.id, waypointId: waypoint.id })
  return { arcId: arc.id, waypointId: waypoint.id }
}

/**
 * The extraction's answer: one contradiction, one claim canon already stands on verbatim, and
 * one landing for whatever position ep02 declares.
 */
function theExtraction(landing?: { arcId: string }): string {
  return JSON.stringify({
    claims: [
      {
        entity: 'Ilse Renn',
        statement: 'Ilse writes her diversions into the back of the spares ledger by hand.',
        field: 'record-keeping',
        quote: LEDGER_LINE,
        contradicts: factOf('Ilse Renn', 'never filed a diversion').id,
      },
      {
        entity: 'Ilse Renn',
        statement: STANDING_VERBATIM,
        quote: LANDING_LINE,
      },
    ],
    landings: landing
      ? [{ arc: landing.arcId, subject: 'Ilse Renn', quote: LANDING_LINE }]
      : [],
  })
}

// ── Trap 1: the extraction runs post-gate, inside the run, on one click ─────────

describe('extraction is the script stage’s third step, and the gate is what carries the run to it', () => {
  it('spends nothing until Ryan approves, then reads the draft he approved', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()
    const beforeTheRuling = llm.calls.length

    // The draft is at its gate. Extraction is pending and has bought nothing: reading a draft
    // round 2 might rewrite would be spend and noise for prose nobody keeps.
    expect(stepsOf(store, runId).map((step) => [step.name, step.status])).toEqual([
      ['write-the-script', 'paused'],
      ['extract-the-canon-claims', 'pending'],
      ['advance-past-the-script-gate', 'pending'],
    ])
    expect(proposalsRiding(store, ep02)).toEqual([])

    llm.reply(theExtraction())
    await approveTheScript(runId)

    // Exactly one call, and it read the version he ruled on.
    expect(llm.calls).toHaveLength(beforeTheRuling + 1)
    expect(extractionPrompt()).toContain(SCRIPT)
    expect(outcomeOf(runId).called).toBe(true)
    expect(findEpisode(store, ep02)!.lifecycle).toBe('assets')
  })

  it('states the post-approval call on the button that buys it, before the click', async () => {
    await ruleThePremiseAndTheOutline()
    const offer = stageOffer(store, READY, ep02, stageCatalogue(paths)[SCRIPT_STAGE]!)

    expect(offer.enabled).toBe(true)
    expect(offer.cost).toMatch(/then 1 Opus call, ~\$\d+\.\d\d after you approve it, to read /)
    expect(offer.cost).toContain('what the script claims of canon into proposals for your ruling')
  })

  it('makes no second call when the step is re-entered — the reply is on the volume', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()
    llm.reply(theExtraction())
    await approveTheScript(runId)

    const outcome = outcomeOf(runId)
    expect(outcome.filePath).toBe('greyharbor/s01e02/script-claims-v1.json')
    expect(existsSync(join(paths.artifactDir, outcome.filePath))).toBe(true)

    // Re-run the step by hand, the way a crash-resumed run does. No answer is queued, so a
    // second call would throw out of the fake — and nothing is raised twice either.
    const spent = llm.calls.length
    const raised = proposalsRiding(store, ep02).length
    const again = stageCatalogue(paths)[SCRIPT_STAGE]!.steps[1]!
    await runner.resumeInterrupted()
    const replay = await replayStep(runId, again.name)

    expect(llm.calls).toHaveLength(spent)
    expect(replay!.called).toBe(false)
    expect(proposalsRiding(store, ep02)).toHaveLength(raised)
  })
})

/** Runs one of a settled run's steps again, as a resumed runner would. */
async function replayStep(runId: string, name: string): Promise<ClaimExtractionOutcome | null> {
  const { extractTheCanonClaims } = await import('./claim-step.ts')
  const step = extractTheCanonClaims(paths, 'write-the-script')
  expect(step.name).toBe(name)
  const stepId = findStepByName(store, runId, name)!.id
  return step.execute({
    runId,
    episodeId: ep02,
    stepId,
    store,
    attempt: 2,
    llm: bindLLM(llm, {
      store,
      stepId,
      runId,
      episodeId: ep02,
      attempt: 2,
      chunk: () => {},
    }),
    input: <T,>() => findStepByName(store, runId, 'write-the-script')!.output as T,
    progress: () => {},
    chunk: () => {},
    gate: () => undefined,
    openGate: () => {
      throw new Error('the extraction step opens no gate')
    },
  })
}

// ── Trap 2: nothing trusts the model ───────────────────────────────────────────

describe('the extractor’s law: nothing trusts the model', () => {
  it('fails loudly on a claim about an entity the script’s provenance does not carry', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()

    const invented = JSON.stringify({
      claims: [
        {
          entity: 'Sefa Doule',
          statement: 'Sefa Doule audits the harbour’s spares every quarter.',
          quote: LEDGER_LINE,
        },
      ],
      landings: [],
    })
    for (let attempt = 0; attempt < 3; attempt += 1) llm.reply(invented)

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'shoot it.' })
    const settled = await runner.settled(runId)

    expect(settled.status).toBe('failed')
    expect(settled.failure).toContain('The extraction claims about “Sefa Doule”')
    expect(settled.failure).toContain('a claim about an entity the writer was never handed')
    expect(settled.failure).toContain('touches: Ilse Renn, Tobin Wick, Grey Harbor Station')
    // Three attempts, then Ryan with the history (invariant 5) — and nothing raised by any.
    expect(findStepByName(store, runId, 'extract-the-canon-claims')!.failure).toContain(
      'Sefa Doule',
    )
    expect(proposalsRiding(store, ep02)).toEqual([])
    // The lifecycle did not move: he ruled, and the stage did not finish. Both are true and
    // both are visible, which is the honest state to be left in.
    expect(findEpisode(store, ep02)!.lifecycle).toBe('script')
  })

  it('fails loudly on a span that does not resolve in the draft', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()

    const unquotable = JSON.stringify({
      claims: [
        {
          entity: 'Ilse Renn',
          statement: 'Ilse keeps a second ledger.',
          quote: 'She keeps a second ledger in the lamp room.',
        },
      ],
      landings: [],
    })
    for (let attempt = 0; attempt < 3; attempt += 1) llm.reply(unquotable)

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'shoot it.' })
    const settled = await runner.settled(runId)

    expect(settled.status).toBe('failed')
    expect(settled.failure).toContain('those words are not in the ep02 script')
    expect(settled.failure).toContain('a claim about a script nobody wrote')
    expect(proposalsRiding(store, ep02)).toEqual([])
  })

  it('fails loudly rather than passing silently when the answer is not an extraction', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()
    for (let attempt = 0; attempt < 3; attempt += 1) llm.reply('Nothing much happens, really.')

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'shoot it.' })
    const settled = await runner.settled(runId)

    // The trap this refusal exists for: a zero-claims pass is a REAL answer, so a broken reply
    // that rendered as one would tell Ryan this episode touched no canon.
    expect(settled.status).toBe('failed')
    expect(settled.failure).toContain('did not come back as an extraction — it is not JSON')
    expect(proposalsRiding(store, ep02)).toEqual([])
  })

  it('raises a contradiction WITH its before, and does not raise what canon already says', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()
    llm.reply(theExtraction())
    await approveTheScript(runId)

    const riding = proposalsRiding(store, ep02)
    expect(riding).toHaveLength(1)
    const [delta] = riding
    expect(delta!.kind).toBe('fact-delta')
    expect(delta!.raisedBy).toBe('writer')
    expect(delta!.entityId).toBe(harbor.entity('Ilse Renn').id)
    // The before is the ratified fact the script argues with — which is what makes it a delta
    // rather than a second, silently disagreeing fact on one sheet.
    expect(delta!.change.facts[0]!.supersedes).toBe(factOf('Ilse Renn', 'never filed a diversion').id)
    expect(delta!.change.facts[0]!.statement).toBe(
      'Ilse writes her diversions into the back of the spares ledger by hand.',
    )
    expect(delta!.change.facts[0]!.field).toBe('record-keeping')

    // And the verbatim one raised nothing at all, with the reason kept rather than dropped.
    const outcome = outcomeOf(runId)
    expect(outcome.deltas).toHaveLength(1)
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0]!.statement).toBe(STANDING_VERBATIM)
    expect(outcome.skipped[0]!.because).toContain('the claim stands verbatim')
  })

  it('raises one proposal for a claim the extraction made twice in one answer', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()

    const said = {
      entity: 'Ilse Renn',
      statement: 'Ilse writes her diversions into the back of the spares ledger by hand.',
      quote: LEDGER_LINE,
    }
    llm.reply(JSON.stringify({ claims: [said, said], landings: [] }))
    await approveTheScript(runId)

    // The scope is read once, before anything is raised, so the store-side check cannot see
    // the first of these — the second reading is over what this pass has already raised.
    expect(proposalsRiding(store, ep02)).toHaveLength(1)
    expect(outcomeOf(runId).skipped[0]!.because).toContain('claimed this twice in one answer')
  })

  it('quotes the span with its surrounding lines, through the one prefill composer', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()
    llm.reply(theExtraction())
    await approveTheScript(runId)

    const context = proposalsRiding(store, ep02)[0]!.usageContext
    // The scene it sits in, the span's own line marked, and the lines either side of it —
    // `quotedLines` (remediation.ts), which is the one composer in this app for a quoted
    // passage. A ruling on a sentence is not a ruling on the episode.
    expect(context).toContain('the ep02 script · scene 2 reads:')
    expect(context).toContain(`> ${LEDGER_LINE}.  ← the span`)
    expect(context).toContain('> Ilse Renn is at the desk at Grey Harbor Station.')
    expect(context).toContain(`Canon says “${NEVER_FILED}`)
  })
})

// ── Trap 3: riding, proved on both sides ───────────────────────────────────────

describe('the raised claims RIDE ep02', () => {
  it('reaches ep02’s own checks and desk, and never canon or another episode’s', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()
    llm.reply(theExtraction())
    await approveTheScript(runId)

    const claimed = 'Ilse writes her diversions into the back of the spares ledger by hand.'
    const ilse = harbor.entity('Ilse Renn').id

    // Visible: the scope helper is what a check reads (3.3), and the claim is in it.
    expect(factsInScope(store, ilse).inScope.map((fact) => fact.statement)).toContain(claimed)
    // Visible: ep02's own desk, marked as the provisional thing it is (E4-0's edge d).
    const desk = composeWriteContext(store, paths, { episodeId: ep02, step: 'script' })
    const held = desk.entities.find((one) => one.entity.id === ilse)!
    expect(held.facts.find((fact) => fact.fact.statement === claimed)!.reach).toBe('riding')

    // Invisible: canon, which is what "only ratification writes canon" means from the read side.
    expect(canonAsOf(store, { entityId: ilse }, 'now').map((fact) => fact.statement)).not.toContain(
      claimed,
    )
    // Invisible: every other episode's desk. ep03 is written by the same composer and cannot
    // see a claim riding ep02 — a provisional fact rides ONE episode, in both directions.
    const other = composeWriteContext(store, paths, { episodeId: ep03, step: 'premise' })
    expect(
      other.entities
        .find((one) => one.entity.id === ilse)!
        .facts.map((fact) => fact.fact.statement),
    ).not.toContain(claimed)

    // And the before is still what canon says, because nobody has ruled anything.
    expect(canonAsOf(store, { entityId: ilse }, 'now').map((fact) => fact.statement)).toContain(
      factOf('Ilse Renn', 'never filed a diversion').statement,
    )
  })

  it('reaches the completion sweep, which is what will convene them (E2-3’s seam)', async () => {
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()
    llm.reply(theExtraction())
    await approveTheScript(runId)

    const sweep = sweepEpisode(store, ep02)
    expect(sweep.outstanding).toHaveLength(1)
    expect(sweep.ruled).toEqual([])
    expect(sweep.sentence).toBe('ep02 carries 1 proposal to rule — 1 fact delta.')
  })
})

// ── Traps 4 and 5: the declare door, and the landing with its subject ──────────

describe('declaring a position, and the landing the extraction raises for it', () => {
  it('offers the pin as a sentence at $0.00, and refuses an abandoned episode in words', () => {
    const view = canonBenchView(store, harbor.show.id, { episodeId: ep02 })!
    expect(view.positions!.label).toBe('ep02')
    expect(view.positions!.standing).toContain('ep02 declares no position on any arc')
    expect(view.positions!.standing).toContain('**vanilla**')

    const second = view.positions!.waypoints.find((one) => one.ordinal === 2)!
    expect(second.declare.enabled).toBe(true)
    expect(second.declare.cost).toBe('No model call · $0.00')
    expect(second.declare.sentence).toBe(
      'Declare ep02 at waypoint 2 “The harbor is worth spending on” of “What the harbor is ' +
        'for” — the pin moves, and the landing proposal is raised when the script is read',
    )
    expect(second.declare.sentence).not.toMatch(/^(Launch|Run|Go|Do|Start)\b/)

    // Declared, and the section says where the pin sits and what a pin is NOT.
    declareEpisodePosition(store, {
      episodeId: ep02,
      arcId: second.arcId,
      waypointId: second.waypointId,
    })
    const after = canonBenchView(store, harbor.show.id, { episodeId: ep02 })!
    expect(after.positions!.standing).toContain('waypoint 2 “The harbor is worth spending on”')
    expect(after.positions!.standing).toContain('A pin is not a fact')
    expect(after.positions!.waypoints.find((one) => one.ordinal === 2)!.declared).toBe(true)
    // Re-declaring is how an episode confirms it was re-read where the waypoint now sits.
    expect(
      after.positions!.waypoints.find((one) => one.ordinal === 2)!.declare.sentence,
    ).toContain('Re-declare ep02')
  })

  it('refuses with the same sentence the disabled button shows', () => {
    const arc = arcsOf(store, harbor.show.id)[0]!
    const waypoint = waypointsOf(store, arc.id)[0]!
    store.run('UPDATE episode SET abandoned_at = ? WHERE id = ?', '2026-08-09T00:00:00Z', ep02)

    const offer = canonBenchView(store, harbor.show.id, { episodeId: ep02 })!.positions!.waypoints[0]!
    expect(offer.declare.enabled).toBe(false)
    expect(offer.declare.blockedBecause).toContain('ep02 was abandoned on 2026-08-09T00:00:00Z')
    expect(() =>
      declareEpisodePosition(store, { episodeId: ep02, arcId: arc.id, waypointId: waypoint.id }),
    ).toThrow(offer.declare.blockedBecause!)
  })

  it('raises the landing with the subject the writer answered, riding ep02', async () => {
    const pinned = declareWaypointTwo()
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()

    // The prompt hands over the declared position and asks whose landing it is — the one
    // question the schema cannot answer (the E2-3 constraint).
    llm.reply(theExtraction(pinned))
    await approveTheScript(runId)

    expect(extractionPrompt()).toContain('## The arc positions this episode declares')
    expect(extractionPrompt()).toContain('WHICH ENTITY this landing is a claim about')

    const landing = proposalsRiding(store, ep02).find((one) => one.kind === 'landing')!
    expect(landing.entityId).toBe(harbor.entity('Ilse Renn').id)
    expect(landing.raisedBy).toBe('writer')
    expect(landing.episodeId).toBe(ep02)
    expect(landing.change.facts[0]!.statement).toBe(
      '“What the harbor is for” reached waypoint 2 “The harbor is worth spending on” in ep02.',
    )
    expect(landingOf(store, landing.id)).toEqual(pinned)
    expect(landing.usageContext).toContain('the writer answers that it reads on Ilse Renn')
    expect(landing.usageContext).toContain('What you wrote that landing it looks like:')
    // Nothing ruled it: the pin moved, the claim rides, and canon is untouched.
    expect(landing.status).toBe('raised')
  })

  it('fails loudly when a declared position is answered by nobody, or by an outsider', async () => {
    const pinned = declareWaypointTwo()
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()

    const silent = JSON.stringify({ claims: [], landings: [] })
    for (let attempt = 0; attempt < 3; attempt += 1) llm.reply(silent)
    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'shoot it.' })
    const settled = await runner.settled(runId)

    expect(settled.status).toBe('failed')
    expect(settled.failure).toContain('ep02 declares a position on “What the harbor is for”')
    expect(settled.failure).toContain('the writer’s judgement — nobody else can supply it')
    expect(positionsOf(store, ep02)).toHaveLength(1)
    expect(proposalsRiding(store, ep02)).toEqual([])
    expect(pinned.arcId).toBe(positionsOf(store, ep02)[0]!.arc.id)
  })

  it('refuses a landing subject the script never touched, exactly like a claim’s', async () => {
    const pinned = declareWaypointTwo()
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()

    const outsider = JSON.stringify({
      claims: [],
      landings: [{ arc: pinned.arcId, subject: 'Sefa Doule', quote: LANDING_LINE }],
    })
    for (let attempt = 0; attempt < 3; attempt += 1) llm.reply(outsider)
    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'shoot it.' })
    const settled = await runner.settled(runId)

    expect(settled.status).toBe('failed')
    expect(settled.failure).toContain('The extraction claims about “Sefa Doule”')
    expect(proposalsRiding(store, ep02)).toEqual([])
  })
})

// ── Trap 6: the issue's signature ──────────────────────────────────────────────

describe('everything E4-4 builds raises, and the ledger is byte-identical after it', () => {
  it('runs the whole of it and writes no canon at all', async () => {
    // The declare door first — the drill's opening move, and the reason a landing exists to be
    // raised at all.
    const pinned = declareWaypointTwo()
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()

    const ledgerBefore = ledgerRows()
    const canonBefore = ratifiedFactRows()
    const asOfBefore = canonAsOf(store, { showId: harbor.show.id }, 'now').map((f) => f.statement)

    llm.reply(theExtraction(pinned))
    await approveTheScript(runId)

    // It really did everything: a delta with a before, a landing with a subject, a verbatim
    // claim declined, and a pin that was declared through the door.
    const riding = proposalsRiding(store, ep02)
    expect(riding.map((one) => one.kind).sort()).toEqual(['fact-delta', 'landing'])
    expect(outcomeOf(runId).skipped).toHaveLength(1)
    expect(positionsOf(store, ep02)).toHaveLength(1)
    expect(provenanceOf(store, script().id).map((one) => one.name).sort()).toEqual([
      'Grey Harbor Station',
      'Ilse Renn',
      'Tobin Wick',
    ])

    // ── The proof ────────────────────────────────────────────────────────────
    // `canon_ruling` IS the ledger every ruling lands on, and not one row was added: nothing
    // in this issue rules, so nothing in this issue reached it.
    expect(ledgerRows()).toEqual(ledgerBefore)
    // And canon itself — every RATIFIED fact row, byte for byte. The `fact` table as a whole
    // is deliberately not asserted identical, and the difference is the point of trap 3: a
    // proposal riding an episode writes its claims PROVISIONALLY (proposal.ts), which is what
    // makes them visible to that episode's checks. A provisional row is not canon; it has no
    // ratification on it, `canonAsOf` cannot see it, and it is closed by whichever ruling
    // eventually disposes of the proposal. So the honest assertion is this one, and it is
    // strict: the ratified rows are unchanged and no new one appeared.
    expect(ratifiedFactRows()).toEqual(canonBefore)
    expect(canonAsOf(store, { showId: harbor.show.id }, 'now').map((f) => f.statement)).toEqual(
      asOfBefore,
    )
    // Every new fact row is provisional and belongs to a proposal riding ep02 — nothing wrote
    // a fact by any other door.
    const claims = riding.flatMap((proposal) => proposal.change.facts.map((part) => part.factId))
    expect(claims.filter((id) => id !== null)).toHaveLength(2)
    for (const id of claims) {
      const fact = factsOfEntity(store, harbor.entity('Ilse Renn').id).find((f) => f.id === id)!
      expect(fact.ratifiedBy).toBeNull()
      expect(fact.status).toBe('provisional')
      expect(fact.establishedIn).toBe(ep02)
    }
  })

  it('writes canon only when Ryan rules one, which is this test simulating him', async () => {
    const pinned = declareWaypointTwo()
    await ruleThePremiseAndTheOutline()
    const runId = await writeTheScript()
    llm.reply(theExtraction(pinned))
    await approveTheScript(runId)

    const before = ledgerRows().length
    // **Simulating Ryan**, through the one ruling API and nothing else — this is the only
    // ruling anywhere in this file, and it is here to show that the ledger CAN move, so that
    // the test above is a measurement rather than a tautology.
    const delta = proposalsRiding(store, ep02).find((one) => one.kind === 'fact-delta')!
    createProposalRulings(store, createEventLog(store)).ratify(delta.id, { note: 'she would.' })

    expect(ledgerRows()).toHaveLength(before + 1)
    expect(canonAsOf(store, { entityId: harbor.entity('Ilse Renn').id }, 'now').map((f) => f.statement))
      .toContain('Ilse writes her diversions into the back of the spares ledger by hand.')
    // And the fact it argued with is closed by that same ruling, with the heir named (D9).
    expect(factOf('Ilse Renn', 'never filed a diversion').closure).not.toBeNull()
  })
})

/** The ledger, whole, as rows — what "byte-identical" is asserted over. */
const ledgerRows = () =>
  store.all<Record<string, unknown>>('SELECT * FROM canon_ruling ORDER BY seq')

/** Canon: the ratified fact rows and their closures. A provisional row is not one of these. */
const ratifiedFactRows = () =>
  store.all<Record<string, unknown>>(
    'SELECT * FROM fact WHERE ratified_by IS NOT NULL ORDER BY rowid',
  )

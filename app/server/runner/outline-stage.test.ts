import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, declareProvenance, provenanceOf, type Artifact } from '../domain/artifact.ts'
import { registerEntity } from '../domain/canon.ts'
import { declareCategory } from '../domain/category.ts'
import { factsOfEntity } from '../domain/fact.ts'
import { dismissFinding, findingsIn, type Finding } from '../domain/finding.ts'
import { panelFor } from '../domain/panel.ts'
import { createProposalRulings, raiseProposal } from '../domain/proposal.ts'
import { createEpisode, episodesOf, findEpisode, scenesOf, seasonsOf } from '../domain/spine.ts'
import { runStructuralChecks } from '../domain/structural.ts'
import { createEventLog, type EventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { describeLLMBackend, type LLMReadiness } from '../llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { launchBlockedBecause, runView, stageOffer } from '../operating.ts'
import type { CorrectionOutcome } from './correction-loop.ts'
import { createRulings, gateStanding, openGates, type Rulings } from './gate.ts'
import { findStepByName, stepsOf } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import { stageCatalogue } from './stages.ts'
import { OUTLINE_STAGE, PREMISE_STAGE, type WriteClose } from './write-step.ts'

/**
 * **The outline stage** (E4-2, 1.1, 4.1, 4.4): the SECOND consumer of the writer's desk, and
 * therefore the issue where "one composer, one loop, one gate" stops being a claim about the
 * premise stage and starts being a claim about the writing line.
 *
 * Almost nothing below tests new machinery, and that is the result rather than a shortcut: the
 * outline stage is `writingStage(library, 'outline', …)` and the diff that made it is an ask,
 * a catalogue line and a precondition. What is tested is that the second lap really runs on
 * the first lap's circuit — the same desk, the same matcher, the same loop, the same note
 * path — and the three things the outline is the first stage able to prove at all.
 *
 * ## The three
 *
 *   1. **An outline is intent, never a scene list** (1.1, D3). `num_scenes` is an output of
 *      the SCRIPT, and this stage may not decide it early by any route: not by a field, not
 *      by a row, and not by a numbered grid a model was invited to write. ep02 has no scenes
 *      before this stage and has none after it.
 *   2. **D12's wall gets its button-side demonstration back** (E4-1's note, #61). The premise
 *      is the first artifact an episode has, so an episode with material standing against it
 *      always has a brief already and "nothing to do" answers ahead of the wall — correctly.
 *      The outline produces from material an episode really has, so the wall can stand in
 *      front of it, and does.
 *   3. **A writing step writes from something RULED.** The lifecycle is the column that says
 *      whether it was, because an approval is the only thing that moves it — and a WRITTEN
 *      premise is not a ruled one, which is the assertion that distinguishes the two.
 *
 * Everything runs the REAL stages through the REAL runner against a REAL library volume with
 * Grey Harbor **founded** in it, and the fake backend in front of the model. No test in this
 * repo may spend a cent (fixtures before features).
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
/** ep02 "Dry Stores" — the un-started episode, and the only one with no outline already. */
let ep02: string
let ep01: string
let ep03: string

// ── What the fake writes ────────────────────────────────────────────────────────

/**
 * ep02's premise-brief. It names **Ilse Renn and Tobin Wick and nobody else**, which fixes
 * its own panel at three: their one category, plus the two craft reviewers a premise-brief is
 * read by. "the harbour" would put the station in it and make it four (`write-context.ts`'s
 * matcher is lexical, and the station's aliases include that phrase).
 */
const PREMISE = [
  'The water plant’s exchanger fails on a Tuesday, three weeks after Ilse Renn cut the tag off',
  'its spare and gave the part to the beacon. Tobin Wick is the one who reads the temperature',
  'log, and the one who has to decide what to do about having read it.',
].join('\n')

/** What a premise-brief convenes here: the character check, story-craft, hook. */
const PREMISE_PANEL = 3

/**
 * A fleshed outline: three movements, named and unnumbered, and no scene anywhere in it.
 *
 * It names Ilse Renn, Tobin Wick and Grey Harbor Station, so the roster it convenes is their
 * two categories plus the three craft reviewers an outline is read by — and that roster is a
 * CONSEQUENCE of what the outline turned out to be about, not a constant (4.1).
 */
const OUTLINE = [
  '## Morning, dry',
  '',
  'Ilse Renn reads the exchanger log and does not say the thing she already knows. Tobin Wick',
  'reads it after her and says it out loud, which is the difference between them and the',
  'reason the back half of the episode is his to carry.',
  '',
  '## The tag',
  '',
  'The spares drawer at Grey Harbor Station holds a tag and no part. Tobin takes the tag to',
  'Ilse and asks her what it was for; she tells him what time he is on the roster. The',
  'audience learns here what she did three weeks ago. Tobin does not.',
  '',
  '## Dry stores',
  '',
  'By the end the water is rationed and nobody has said whose fault it is. Ilse Renn writes',
  'nothing down, and Tobin Wick keeps the tag.',
].join('\n')

/**
 * The line the planted contradiction lives on, kept whole on one line of the draft so that
 * what the check quotes and what the artifact stores are byte-identical.
 *
 * It breaks two of *The hull and the void*'s three rules at once — a body outside the pressure
 * hull with nothing between it and the void, and a voice carrying outside without a radio or a
 * handset — which is the fixture's own planted-defect shape, moved up the line to the outline.
 */
const CONTRADICTION =
  'Tobin Wick goes out along the spar in coveralls and shouts back to Ilse Renn at the lock.'

/** Round 1 of the loop's test: the same three movements, with the contradiction in the middle. */
const OUTLINE_WITH_A_CONTRADICTION = [
  '## Morning, dry',
  '',
  'Ilse Renn reads the exchanger log at Grey Harbor Station and does not say what she knows.',
  '',
  '## The spar',
  '',
  CONTRADICTION,
  'Neither of them will use the handset, and the outside rules are what everyone here says',
  'they live by.',
  '',
  '## Dry stores',
  '',
  'By the end the water is rationed and nobody has said whose fault it is.',
].join('\n')

/** Round 2: the same beats, with the rule obeyed. Nothing else about the episode moves. */
const OUTLINE_CORRECTED = [
  '## Morning, dry',
  '',
  'Ilse Renn reads the exchanger log at Grey Harbor Station and does not say what she knows.',
  '',
  '## The spar',
  '',
  'Tobin Wick seals into a hardsuit before the lock and goes out along the spar, and every',
  'word between him and Ilse Renn crosses on the pier housing’s wired handset. The outside',
  'rules are what everyone here says they live by, and this morning they do.',
  '',
  '## Dry stores',
  '',
  'By the end the water is rationed and nobody has said whose fault it is.',
].join('\n')

const CONCERN =
  'A body outside the pressure hull in coveralls is in vacuum. There is no third exception ' +
  'and proximity to the hull is not one, and no hardsuit or containment field is named here.'

const NOTHING_FOUND = '{"findings": []}'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-outline-'))
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

// ── Getting ep02 to the outline stage, the way Ryan would ───────────────────────

/**
 * Writes ep02's premise-brief through the real premise stage and approves it at its gate,
 * which is the ONLY thing that moves ep02 from `premise` to `outline` (domain/lifecycle.ts).
 *
 * Deliberately not a shortcut past it. Half of what this file asserts is about the seam
 * between the two stages, and a helper that moved the column by hand would test the outline
 * stage against a state the app cannot reach.
 */
async function ruleThePremise(): Promise<void> {
  llm.reply(PREMISE)
  for (let reviewer = 0; reviewer < PREMISE_PANEL; reviewer += 1) llm.reply(NOTHING_FOUND)

  const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
  await runner.settled(run.id)
  rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that is the episode.' })
  await runner.settled(run.id)
}

/** One round of the outline loop: the draft, then every convened reviewer's answer to it. */
function queueRound(draft: string, panel: number, ...said: string[]): void {
  llm.reply(draft)
  const answers = [...said]
  while (answers.length < panel) answers.push(NOTHING_FOUND)
  for (const answer of answers) llm.reply(answer)
}

async function writeTheOutline(): Promise<string> {
  const run = runner.enqueueRun({ episodeId: ep02, stage: OUTLINE_STAGE })
  const settled = await runner.settled(run.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? 'the run failed')
  return run.id
}

// ── Reading ─────────────────────────────────────────────────────────────────────

const outlineStage = () => stageCatalogue(paths)[OUTLINE_STAGE]!

/** The producer's calls, told apart from the panel's by what only the writer is asked for. */
const writerPrompts = (): string[] =>
  llm.calls.filter((call) => call.prompt.includes('WRITE THE ep02 OUTLINE')).map((c) => c.prompt)

const outline = (episodeId: string = ep02): Artifact =>
  artifactsOf(store, episodeId).find((one) => one.kind === 'outline')!

const brief = (episodeId: string = ep02): Artifact =>
  artifactsOf(store, episodeId).find((one) => one.kind === 'premise-brief')!

const lifecycleOf = (episodeId: string = ep02): string => findEpisode(store, episodeId)!.lifecycle

const offerFor = (episodeId: string) => stageOffer(store, READY, episodeId, outlineStage())

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

// ── Trap 1: an outline is intent, and it decides no scenes ──────────────────────

describe('an outline is intent, never a scene list', () => {
  it('lands without writing one scene row, and leaves ep02 with the none it had', async () => {
    await ruleThePremise()
    expect(scenesOf(store, ep02)).toEqual([])

    queueRound(OUTLINE, 5)
    const runId = await writeTheOutline()
    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that is the shape.' })
    await runner.settled(runId)

    // The whole stage has run, been checked, been ruled on, and moved the episode — and the
    // count of scenes ep02 has is the count it started with. `num_scenes` is an output of the
    // SCRIPT (1.1, D3) and nothing upstream of one may decide it early.
    expect(scenesOf(store, ep02)).toEqual([])
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM scene WHERE episode_id = ?', ep02)!.n)
      .toBe(0)
    // Nor by the back door: the artifact belongs to the episode, not to a scene, and there is
    // no `scenes` field on it to carry a grid in.
    expect(outline()).toMatchObject({ kind: 'outline', slot: '', version: 1, sceneId: null })
    expect(Object.keys(outline())).not.toContain('scenes')
  })

  it('asks the model for movement, and refuses it a grid in as many words', async () => {
    await ruleThePremise()
    queueRound(OUTLINE, 5)
    await writeTheOutline()

    const [prompt] = writerPrompts()
    expect(prompt).toContain('the movement of the story')
    expect(prompt).toContain('This is not a scene list')
    expect(prompt).toContain('Do not number')
    expect(prompt).toContain('do not say anywhere how many there will be')
    // The reason travels with the prohibition, because a model told only "no numbers" writes
    // the same grid with dashes.
    expect(prompt).toContain('DERIVED from the written episode and never prescribed')
    // And nowhere is a count asked for, in any of the shapes that would smuggle one in.
    expect(prompt).not.toMatch(/how many scenes|number of scenes|scene count|one line per scene/i)
  })

  it('files the draft verbatim — nothing here parses an outline into parts', async () => {
    await ruleThePremise()
    queueRound(OUTLINE, 5)
    await writeTheOutline()

    // The bytes on the volume are the model's answer and nothing else. A parser that lifted
    // "movements" out of this would be the scene list arriving inferred rather than asked for.
    expect(readFileSync(join(paths.artifactDir, outline().filePath!), 'utf8')).toBe(`${OUTLINE}\n`)
    expect(outline().filePath).toBe('greyharbor/s01e02/outline-round-1.md')
  })
})

// ── Trap 3: the upstream is a RULED premise, and the offer says so ──────────────

describe('the outline is offered only once the premise has been ruled', () => {
  it('refuses ep02 in words while it is still at premise, before any click', () => {
    const offer = offerFor(ep02)

    expect(offer.enabled).toBe(false)
    expect(offer.blockedBecause).toContain('ep02 is at premise and has not reached outline yet')
    expect(offer.blockedBecause).toContain('you have not approved its premise')
    expect(offer.blockedBecause).toContain('Rule on the ep02 premise first')
    // The cost is stated anyway: what it would have cost is not a secret because it is blocked.
    expect(offer.cost).toContain('Opus call')
    // And the API refuses with the same string the disabled button is showing (D15).
    expect(launchBlockedBecause(store, READY, ep02, outlineStage())).toBe(offer.blockedBecause)
    expect(llm.calls).toHaveLength(0)
  })

  /**
   * The sharp end of it: a brief on the volume is not an approval. The stage's own declaration
   * is asked directly, because a parked premise run would otherwise be refused first by D7's
   * one-run-per-episode — a true sentence about a different thing.
   */
  it('still refuses it when the brief is written and waiting on his ruling', async () => {
    llm.reply(PREMISE)
    for (let reviewer = 0; reviewer < PREMISE_PANEL; reviewer += 1) llm.reply(NOTHING_FOUND)
    await runner.settled(runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE }).id)

    expect(brief()).toBeDefined()
    expect(lifecycleOf()).toBe('premise')
    expect(outlineStage().offerOn(store, findEpisode(store, ep02)!).nothingToDoBecause).toContain(
      'has not reached outline yet',
    )
  })

  it('offers it in full sentences the moment the premise gate is approved', async () => {
    await ruleThePremise()

    expect(lifecycleOf()).toBe('outline')
    const offer = offerFor(ep02)
    expect(offer.enabled).toBe(true)
    expect(offer.blockedBecause).toBeNull()
    expect(offer.sentence).toContain('Write the ep02 outline from the writer’s desk')
    expect(offer.sentence).toContain('Dry Stores')
    expect(offer.sentence).not.toMatch(/^(Launch|Run|Go|Do|Start)\b/)
    // Verb + object + scope + cost: the writing call, the reviewers it may convene, the bound.
    expect(offer.cost).toMatch(/Opus call.*~\$\d+\.\d\d/)
    expect(offer.cost).toContain('your money, spent when you click')
  })

  it('says "there is already one" ahead of anything else, on the episode that has one', () => {
    // ep01 is at `script` and carries the fixture's hand-written outline. It has reached the
    // stage, so the lifecycle has nothing to say; what it wants is a ruling or an edit.
    const offer = offerFor(ep01)

    expect(offer.enabled).toBe(false)
    expect(offer.blockedBecause).toContain('ep01 already has an outline')
    expect(offer.blockedBecause).toContain('rule on it at its gate, or edit it directly')
  })
})

// ── Trap 2: D12's wall, back in front of a real button ──────────────────────────

/**
 * **The wall's button-side demonstration, restored to a live stage** (D12, E4-1's #61 note).
 *
 * The finding is real rather than planted: a location the show has retired is declared in the
 * ep02 premise-brief's provenance, and the structural tier's `retired-reappearance` check
 * reads exactly that and answers `certain`, for nothing (`domain/structural.ts`). What is
 * planted is the world in which an honest check fires.
 */
describe('a deterministic finding on the brief refuses the outline', () => {
  /** A place the show is done with, retired the only way standing is ever written. */
  function retireALocation(): string {
    const entity = registerEntity(store, {
      showId: harbor.show.id,
      categoryKey: 'location',
      name: 'The old wet dock',
    })
    const proposal = raiseProposal(store, {
      entityId: entity.id,
      kind: 'promotion',
      raisedBy: 'ryan',
      standing: 'retired',
      body: 'Sealed and struck off the plan two seasons before the series begins.',
    })
    createProposalRulings(store, createEventLog(store)).ratify(proposal.id, { note: 'done with it.' })
    return entity.id
  }

  /** The brief, built on the retired place, read by the free tier. Returns the finding. */
  function standMaterialAgainstTheBrief(): Finding {
    declareProvenance(store, brief().id, [retireALocation()])
    runStructuralChecks(store, brief().id)
    return findingsIn(store, brief().id).find((one) => one.checkKey === 'retired-reappearance')!
  }

  it('renders the offer disabled with the wall’s own sentence', async () => {
    await ruleThePremise()
    expect(offerFor(ep02).enabled).toBe(true)

    standMaterialAgainstTheBrief()

    const offer = offerFor(ep02)
    expect(offer.enabled).toBe(false)
    expect(offer.blockedBecause).toContain('ep02 is blocked')
    expect(offer.blockedBecause).toContain('retired-reappearance')
    expect(offer.blockedBecause).toContain('the ep02 premise-brief')
    expect(offer.blockedBecause).toContain('The old wet dock is declared retired')
    // And the way out, in his words, because a refusal with no way out is a dead end.
    expect(offer.blockedBecause).toContain('refuse the next stage and never your gate')
    expect(launchBlockedBecause(store, READY, ep02, outlineStage())).toBe(offer.blockedBecause)
  })

  it('comes back the moment he rules on it, with no unblocking write anywhere', async () => {
    await ruleThePremise()
    const finding = standMaterialAgainstTheBrief()
    expect(offerFor(ep02).enabled).toBe(false)

    dismissFinding(store, finding.id, 'The dock is a flashback in the cold open, and reads as one.')

    // Recomputed off live rows, not decremented: nothing wrote "unblocked" anywhere, the
    // finding row is still there, and it is his disposition that changed the answer.
    expect(offerFor(ep02).enabled).toBe(true)
    expect(offerFor(ep02).blockedBecause).toBeNull()
    expect(findingsIn(store, brief().id).map((one) => one.checkKey)).toContain(
      'retired-reappearance',
    )
  })

  it('never stands in front of the reading stages beside it', async () => {
    await ruleThePremise()
    standMaterialAgainstTheBrief()

    for (const stage of Object.values(stageCatalogue(paths)).filter((one) => one.work === 'reads')) {
      expect(launchBlockedBecause(store, READY, ep02, stage) ?? '').not.toContain('is blocked')
    }
  })
})

// ── Trap 4: the same desk, the same matcher, the same note path ─────────────────

describe('the desk is what reaches the model, on the second lap too', () => {
  it('carries the ruled brief whole, the audience’s canon, and nothing it left out', async () => {
    ratifyFact('Ilse Renn', 'Ilse signed the beacon over to Tobin for one night.', ep01)
    // Ratified on a Tuesday while ep02 is being written. `canonAsOf(now)` shows it; the ep02
    // audience has not seen it, so the desk refuses it — and so, therefore, does the prompt.
    ratifyFact('Ilse Renn', 'Ilse told the crew the lane is never reopening.', ep03)
    await ruleThePremise()

    queueRound(OUTLINE, 5)
    await writeTheOutline()

    const [prompt] = writerPrompts()
    expect(writerPrompts()).toHaveLength(1)

    // The upstream: the ruled brief, whole, read off the volume by the desk rather than
    // reconstructed — and named as what it is, so the model knows what it is writing from.
    expect(prompt).toContain('The ep02 premise-brief, whole:')
    expect(prompt).toContain('three weeks after Ilse Renn cut the tag off')
    // The world rules' prose, which arrives through `core` standing and no door of its own.
    expect(prompt).toContain('two hundred years calling itself')
    // A fact with ep01 lineage, on ep02's desk because ep01 is already on screen.
    expect(prompt).toContain('Ilse signed the beacon over to Tobin for one night.')
    expect(prompt).toContain('established in an earlier episode')
    // And the one a LATER episode ratified, refused. A second composer reading canon as it
    // stands now would have leaked this, and every other assertion here would still pass —
    // which is why all of them are in one test.
    expect(prompt).not.toContain('Ilse told the crew the lane is never reopening.')
    // The confession trail stays off the wire: `leftOut` carries identities so a surface can
    // answer "why did the writer not know about X", never so a prompt can iterate them.
    expect(prompt).not.toContain('Sefa Doule')
    expect(prompt).not.toContain('the assessor')
  })

  it('declares provenance out of what it WROTE, through the desk’s own matcher', async () => {
    await ruleThePremise()
    queueRound(OUTLINE, 5)
    await writeTheOutline()

    // Six entities were on the desk; three are in the draft. Invariant 2 runs backwards for a
    // producer — there is no upstream declaration to read, because this is the step that
    // writes one — and `nameAppearingIn` is the one lexical rule that decides "named in".
    expect(provenanceOf(store, outline().id).map((one) => one.name).sort()).toEqual([
      'Grey Harbor Station',
      'Ilse Renn',
      'Tobin Wick',
    ])
  })

  it('walks the whole circuit once: one call, one artifact, one panel, one gate', async () => {
    await ruleThePremise()
    const before = llm.calls.length

    queueRound(OUTLINE, 5)
    const runId = await writeTheOutline()

    expect(writerPrompts()).toHaveLength(1)
    expect(llm.calls.length - before).toBe(1 + 5)

    const standing = gateStanding(store, openGates(store)[0]!.gate.id)!
    expect(standing).toMatchObject({ round: 1, isOpen: true, subject: 'the ep02 outline' })
    const payload = standing.rounds[0]!.payload as CorrectionOutcome
    expect(payload.rounds.map((round) => [round.artifactVersion, round.checks])).toEqual([[1, 5]])
    expect(payload).toMatchObject({ converged: true, clean: true })

    expect(stepsOf(store, runId).map((step) => [step.name, step.status])).toEqual([
      ['write-the-outline', 'paused'],
      ['advance-past-the-outline-gate', 'pending'],
    ])

    // And the gate renders its artifact rather than a filename (1.3): the outline he is being
    // asked about is on the page, read off the volume, with the loop history beside it.
    const view = runView(store, paths, runId)!
    expect(view.gate!.artifact.text).toBe(`${OUTLINE}\n`)
    expect(view.gate!.subject).toBe('the ep02 outline')
  })

  it('carries a rejection back into the next draft through the desk, with its round on it', async () => {
    await ruleThePremise()
    queueRound(OUTLINE, 5)
    const runId = await writeTheOutline()

    queueRound(OUTLINE_CORRECTED, 5)
    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'The middle movement turns nothing. Make him go outside.', depth: 'artifact' }],
    })
    await runner.settled(runId)

    const prompts = writerPrompts()
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toContain('The middle movement turns nothing.')
    // The note verbatim, and the sentence the DESK composed around it — which is what says it
    // arrived through `composeWriteContext` rather than off the loop's `brief.ruling`.
    expect(prompts[1]).toContain('The middle movement turns nothing. Make him go outside.')
    expect(prompts[1]).toContain('your round 1 rejection of the ep02 outline')
    expect(prompts[1]).toContain('routed at artifact depth')
    // Said once. Reading his note off the brief AS WELL as off the desk would print it twice.
    expect(prompts[1]!.split('The middle movement turns nothing.')).toHaveLength(2)

    // Round 2 of the same gate, on version 2 of the same artifact, each draft its own file.
    expect(gateStanding(store, openGates(store)[0]!.gate.id)!.round).toBe(2)
    expect(outline().filePath).toBe('greyharbor/s01e02/outline-round-2.md')
  })
})

// ── Trap 5: findings anchor in a sceneless artifact, and the loop converges ─────

describe('a contradiction in an outline draft', () => {
  /** The world-rules reply: a finding at a quoted span, in an artifact that has no scenes. */
  function worldRulesFinding(): string {
    const vacuum = factsOfEntity(store, harbor.entity('The hull and the void').id).find((fact) =>
      fact.statement.includes('Outside the hull is vacuum'),
    )!
    return JSON.stringify({
      findings: [
        {
          quote: CONTRADICTION,
          concern: CONCERN,
          severity: 'high',
          confidence: 'high',
          entity: 'Tobin Wick',
          facts: [vacuum.id],
        },
      ],
    })
  }

  it('draws the finding anchored by quoted span with no scene, and converges on round 2', async () => {
    await ruleThePremise()

    // Six convene once the draft names the world rules: character, location, world-rules, and
    // the three craft reviewers an outline is read by. Provenance is additive, so round 2
    // convenes the same six over the corrected draft.
    queueRound(OUTLINE_WITH_A_CONTRADICTION, 6, NOTHING_FOUND, NOTHING_FOUND, worldRulesFinding())
    queueRound(OUTLINE_CORRECTED, 6)

    const runId = await writeTheOutline()

    // The anchor: a quoted span of an artifact with no scenes in it. That is the honest
    // answer, and it is the same answer a whole-artifact finding gives anywhere else.
    const raised = findingsIn(store, outline().id).find((one) => one.checkKey === 'world-rules')!
    expect(raised.anchor).toMatchObject({ sceneId: null, quote: CONTRADICTION, version: 1 })
    expect(raised.tier).toBe('text')
    expect(scenesOf(store, ep02)).toEqual([])

    // Round 1's findings, in round 2's prompt — severity and confidence side by side and never
    // collapsed (invariant 4), the span quoted so the rewrite knows where to land, and the
    // canon it argues with quoted with it.
    const prompts = writerPrompts()
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toContain(CONCERN)
    expect(prompts[1]).toContain('The checks read round 1 and this is what they said')
    expect(prompts[1]).toContain('the world-rules check · severity high · confidence high')
    expect(prompts[1]).toContain(CONTRADICTION)
    expect(prompts[1]).toContain(CONCERN)
    expect(prompts[1]).toContain('It argues with canon: “**Outside the hull is vacuum.**')

    // And it converged: two drafts, the second read clean, presented once.
    const payload = gateStanding(store, openGates(store)[0]!.gate.id)!.rounds[0]!
      .payload as CorrectionOutcome
    expect(payload.rounds.map((round) => [round.artifactVersion, round.findings.length])).toEqual([
      [1, 1],
      [2, 0],
    ])
    expect(payload).toMatchObject({ converged: true, clean: true })
    expect(payload.sentence).toContain('read clean at round 2')
    expect(stepsOf(store, runId).map((step) => step.status)).toEqual(['paused', 'pending'])
  })

  it('reaches the gate loud when it never converges, with every round under it', async () => {
    await ruleThePremise()

    // Three drafts, the same contradiction each time, and the same reading each time. The
    // budget is spent (invariant 5) and this is where the machine stops arguing with itself.
    for (let round = 0; round < 3; round += 1) {
      queueRound(OUTLINE_WITH_A_CONTRADICTION, 6, NOTHING_FOUND, NOTHING_FOUND, worldRulesFinding())
    }

    await writeTheOutline()

    const payload = gateStanding(store, openGates(store)[0]!.gate.id)!.rounds[0]!
      .payload as CorrectionOutcome
    expect(payload.rounds.map((round) => [round.artifactVersion, round.findings.length])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ])
    expect(payload.converged).toBe(false)
    expect(payload.sentence).toContain('the correction budget is spent')
    // Loud, and no slower: the findings do not gate the gate (invariant 3).
    expect(payload.board.rows.find((row) => row.checkKey === 'world-rules')!.verdict).toBe('found')
  })
})

// ── Trap 6: the roster is data, and outline-sized ───────────────────────────────

describe('what an outline convenes', () => {
  it('is its categories plus the craft reviewers an outline is read by, unbidden (D13)', async () => {
    await ruleThePremise()
    queueRound(OUTLINE, 5)
    await writeTheOutline()

    expect(panelFor(store, outline()).map((subject) => subject.key)).toEqual([
      'character',
      'location',
      'story-craft',
      'pacing',
      'hook',
    ])
    // Pacing reads an outline and dialogue does not — an outline has no dialogue in it, and
    // paying a model to say so is what 4.1's second half exists to prevent (craft.ts).
    expect(panelFor(store, outline()).map((subject) => subject.key)).not.toContain('dialogue')
    // `species`, `technology` and `world-rules` all declare `outline` in the fixture's sheets
    // and none of them convenes: this outline names nobody of theirs (invariant 2, from the
    // other side). The roster is a consequence of what the draft turned out to be about.
    expect(panelFor(store, outline()).map((subject) => subject.key)).not.toContain('world-rules')
  })

  it('grows by a DECLARATION that names the outline, with no code change anywhere', async () => {
    await ruleThePremise()
    queueRound(OUTLINE, 5)
    await writeTheOutline()

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
    declareProvenance(store, outline().id, [office.id])

    expect(panelFor(store, outline()).map((subject) => subject.key)).toEqual([
      'character',
      'faction',
      'location',
      'story-craft',
      'pacing',
      'hook',
    ])
  })

  it('stays home when the declaration names other kinds — the same data, said differently', async () => {
    await ruleThePremise()
    queueRound(OUTLINE, 5)
    await writeTheOutline()

    // The identical move as above, one word different in the DECLARATION: this category
    // applies to the script and not to the outline. Its entity is in the outline's provenance
    // all the same, and it does not convene. Nothing in code told the two apart.
    const category = declareCategory(store, {
      showId: harbor.show.id,
      key: 'set-dressing',
      name: 'Set dressing',
      appliesTo: ['script'],
      checkInstructions: 'Read the draft against what is on the walls.',
    })
    const props = registerEntity(store, {
      showId: harbor.show.id,
      categoryKey: category.key,
      name: 'The dry-stores shelving',
    })
    declareProvenance(store, outline().id, [props.id])

    expect(panelFor(store, outline()).map((subject) => subject.key)).not.toContain('set-dressing')
    expect(panelFor(store, outline())).toHaveLength(5)
  })
})

// ── The lifecycle seam, one stage further along ─────────────────────────────────

describe('the outline gate moves ep02 on, and nothing else does', () => {
  it('leaves it at outline while the draft sits at its gate', async () => {
    await ruleThePremise()
    queueRound(OUTLINE, 5)
    await writeTheOutline()

    expect(outline()).toBeDefined()
    expect(lifecycleOf()).toBe('outline')
  })

  it('moves it to script when Ryan approves, through the seam the builder put there', async () => {
    await ruleThePremise()
    queueRound(OUTLINE, 5)
    const runId = await writeTheOutline()
    const spent = llm.calls.length

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that is the shape.' })
    const settled = await runner.settled(runId)

    expect(settled.status).toBe('done')
    expect(lifecycleOf()).toBe('script')
    // Nothing re-written, nothing re-checked, nothing re-spent on the way back in.
    expect(llm.calls).toHaveLength(spent)

    const close = findStepByName(store, runId, 'advance-past-the-outline-gate')!.output as WriteClose
    expect(close.verdict).toBe('approve')
    expect(close.lifecycle).toMatchObject({ from: 'outline', to: 'script', moved: true })
    expect(close.sentence).toContain('ep02 moves from outline to script')
    expect(close.sentence).toMatch(/\$\d+\.\d\d/)
  })

  it('moves it on an override too — an override is an approval with a record', async () => {
    await ruleThePremise()
    queueRound(OUTLINE_WITH_A_CONTRADICTION, 6, NOTHING_FOUND, NOTHING_FOUND, worldRules())
    queueRound(OUTLINE_WITH_A_CONTRADICTION, 6, NOTHING_FOUND, NOTHING_FOUND, worldRules())
    queueRound(OUTLINE_WITH_A_CONTRADICTION, 6, NOTHING_FOUND, NOTHING_FOUND, worldRules())
    const runId = await writeTheOutline()

    rulings.override(openGates(store)[0]!.gate.id, {})
    await runner.settled(runId)

    expect(lifecycleOf()).toBe('script')
  })

  /** The same reply the loop test uses, hoisted so the override case can be loud too. */
  function worldRules(): string {
    const vacuum = factsOfEntity(store, harbor.entity('The hull and the void').id).find((fact) =>
      fact.statement.includes('Outside the hull is vacuum'),
    )!
    return JSON.stringify({
      findings: [
        {
          quote: CONTRADICTION,
          concern: CONCERN,
          severity: 'high',
          confidence: 'high',
          facts: [vacuum.id],
        },
      ],
    })
  }
})

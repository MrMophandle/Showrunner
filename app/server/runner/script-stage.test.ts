import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, provenanceOf, type Artifact } from '../domain/artifact.ts'
import { delineateScript } from '../domain/delineate.ts'
import { factsOfEntity } from '../domain/fact.ts'
import { findingsIn } from '../domain/finding.ts'
import { panelFor } from '../domain/panel.ts'
import { createProposalRulings, raiseProposal } from '../domain/proposal.ts'
import { createEpisode, episodesOf, findEpisode, scenesOf, seasonsOf } from '../domain/spine.ts'
import { createEventLog, type EventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { FIXTURE_DIR } from '../fixture/read.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { describeLLMBackend, type LLMReadiness } from '../llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { launchBlockedBecause, runView, stageOffer } from '../operating.ts'
import type { CorrectionOutcome } from './correction-loop.ts'
import { createRulings, gateStanding, openGates, type Rulings } from './gate.ts'
import { findStepByName, stepsOf } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import { stageCatalogue } from './stages.ts'
import { OUTLINE_STAGE, PREMISE_STAGE, SCRIPT_STAGE, type WriteClose } from './write-step.ts'

/**
 * **The script stage** (E4-3, 1.1, D3, 4.4): the third caller of the writer's desk, and the
 * only one whose draft has scenes in it.
 *
 * The stage itself is `writingStage(library, 'script', …)` — the same builder, the same loop,
 * the same gate, a bigger ask. What is new is everything scenes bring with them, and it is
 * what most of this file is about:
 *
 *   1. **Delineation runs per landed draft, inside the loop**, before that round's checks read
 *      a word — because findings anchor by SCENE, and a panel reading a fresh draft against the
 *      last draft's grid would anchor every finding in the wrong place.
 *   2. **`num_scenes` is an output.** Nothing asks for a count, nothing asserts one as an
 *      input, and the ask says the count is the writer's in as many words — which is what E4-2
 *      kept a grid out of the outline FOR.
 *   3. **A scene is its heading** (`domain/delineate.ts`). The edge that decided the rule is
 *      tested end to end here: a rewrite inserts a scene in the middle, every ordinal after it
 *      shifts, and a finding anchored before the rewrite still points at the prose it argued
 *      with.
 *   4. **The fixture is the convention's proof and its defects are fixed points.** ep01's
 *      hand-written script survives a run of this stage byte for byte, and the stage refuses
 *      itself on ep01 in words before any click.
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
let ep01: string
let ep02: string
let ep03: string

// ── What the fake writes ────────────────────────────────────────────────────────

const PREMISE = [
  'The water plant’s exchanger fails on a Tuesday, three weeks after Ilse Renn cut the tag off',
  'its spare and gave the part to the beacon. Tobin Wick is the one who reads the temperature',
  'log, and the one who has to decide what to do about having read it.',
].join('\n')

/** What a premise-brief convenes here: the character check, story-craft, hook. */
const PREMISE_PANEL = 3

const OUTLINE = [
  '## Morning, dry',
  '',
  'Tobin Wick reads the exchanger log at Grey Harbor Station and says out loud what it means.',
  'The audience learns here what the temperature has been doing for three weeks. Ilse Renn',
  'already knows.',
  '',
  '## The drawer',
  '',
  'Tobin goes for the spare and the drawer is empty. Ilse answers him with the roster, which',
  'is what she answers most questions with. The audience learns what she did three weeks ago;',
  'Tobin does not.',
  '',
  '## Dry stores',
  '',
  'By the end the water is rationed and nobody has said whose fault it is.',
].join('\n')

/** What an outline convenes here: character, location, and the three craft reviewers. */
const OUTLINE_PANEL = 5

/**
 * ep02's script, draft one — three scenes, headed the way the ask asks for them.
 *
 * It names Ilse Renn, Tobin Wick and Grey Harbor Station and nobody else, which fixes its
 * panel at six: their two categories, plus the four craft reviewers a SCRIPT is read by
 * (story-craft, pacing, dialogue, hook — `craft.ts`; an outline has no dialogue in it).
 */
const SCRIPT_V1 = [
  '# Dry Stores — script',
  '',
  '> Grey Harbor · Season 1 · Episode 2 · draft 1',
  '',
  '## 1 · INT. WATER PLANT — 05:50',
  '',
  '> Tobin reads the exchanger log and says what it means out loud.',
  '',
  'The plant is loud in the way a thing is loud when it is working. TOBIN WICK has the',
  'temperature log open on the housing and does not write anything down.',
  '',
  'TOBIN',
  'It has been climbing three weeks.',
  '',
  "## 2 · INT. HARBOURMASTER'S OFFICE — 06:30",
  '',
  '> Ilse is asked where the spare went, and answers with the roster.',
  '',
  'Ilse Renn is at the desk at Grey Harbor Station with the spares drawer shut.',
  '',
  'ILSE',
  'There is no spare.',
  '',
  'TOBIN',
  'There was one in that drawer in Marrowmas.',
  '',
  '## 3 · INT. DRY STORES — 18:00',
  '',
  '> The water goes on ration and nobody says whose fault it is.',
  '',
  'Ilse Renn writes the ration up on the board and does not sign it.',
].join('\n')

/**
 * Draft two: **a scene inserted in the middle**, and every other heading left exactly alone.
 *
 * This is the edge that decided the identity rule. Under an ordinal identity the office scene
 * would silently become the lock scene, and the finding anchored in it would render against
 * prose nobody checked.
 */
const SCRIPT_V2 = [
  '# Dry Stores — script',
  '',
  '> Grey Harbor · Season 1 · Episode 2 · draft 2',
  '',
  '## 1 · INT. WATER PLANT — 05:50',
  '',
  '> Tobin reads the exchanger log and says what it means out loud.',
  '',
  'The plant is loud in the way a thing is loud when it is working. TOBIN WICK has the',
  'temperature log open on the housing and does not write anything down.',
  '',
  'TOBIN',
  'It has been climbing three weeks.',
  '',
  '## 2 · INT. NO. 4 LOCK — 06:10',
  '',
  '> Tobin crosses inboard, and passes the beacon feed on his way.',
  '',
  'Tobin Wick comes through the lock with the log under his arm.',
  '',
  "## 3 · INT. HARBOURMASTER'S OFFICE — 06:30",
  '',
  '> Ilse is asked where the spare went, and answers with the roster.',
  '',
  'Ilse Renn is at the desk at Grey Harbor Station with the spares drawer shut.',
  '',
  'ILSE',
  'The roster says you are on the plant at seven.',
  '',
  '## 4 · INT. DRY STORES — 18:00',
  '',
  '> The water goes on ration and nobody says whose fault it is.',
  '',
  'Ilse Renn writes the ration up on the board and does not sign it.',
].join('\n')

/** What a script convenes here: character, location, and the FOUR craft reviewers. */
const SCRIPT_PANEL = 6

/** The line the round-1 finding is anchored at, inside scene 2 and nowhere else. */
const QUOTED = 'There is no spare.'

const CONCERN =
  'Ilse answers a question about the spare with a flat denial. Canon has her answering with ' +
  'the roster instead, which is a different woman.'

const NOTHING_FOUND = '{"findings": []}'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-script-'))
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
  ep03 = createEpisode(store, { seasonId: season.id, number: 3, title: 'Slack Water' }).id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

// ── Getting ep02 to the script stage, the way Ryan would ────────────────────────

/** One round of a loop: the draft, then every convened reviewer's answer to it. */
function queueRound(draft: string, panel: number, ...said: string[]): void {
  llm.reply(draft)
  const answers = [...said]
  while (answers.length < panel) answers.push(NOTHING_FOUND)
  for (const answer of answers) llm.reply(answer)
}

/**
 * ep02 through the premise and the outline, each approved at its own gate — which is the only
 * thing that moves the lifecycle, and therefore the only way this stage becomes offerable.
 * Deliberately not a shortcut past the seam.
 */
async function ruleThePremiseAndTheOutline(): Promise<void> {
  queueRound(PREMISE, PREMISE_PANEL)
  const premise = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
  await runner.settled(premise.id)
  rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that is the episode.' })
  await runner.settled(premise.id)

  queueRound(OUTLINE, OUTLINE_PANEL)
  const outline = runner.enqueueRun({ episodeId: ep02, stage: OUTLINE_STAGE })
  await runner.settled(outline.id)
  rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that is the shape.' })
  await runner.settled(outline.id)
}

async function writeTheScript(episodeId: string = ep02): Promise<string> {
  const run = runner.enqueueRun({ episodeId, stage: SCRIPT_STAGE })
  const settled = await runner.settled(run.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? 'the run failed')
  return run.id
}

// ── Reading ─────────────────────────────────────────────────────────────────────

const scriptStage = () => stageCatalogue(paths)[SCRIPT_STAGE]!

const writerPrompts = (): string[] =>
  llm.calls.filter((call) => call.prompt.includes('WRITE THE ep02 SCRIPT')).map((c) => c.prompt)

const script = (episodeId: string = ep02): Artifact =>
  artifactsOf(store, episodeId).find((one) => one.kind === 'script')!

const lifecycleOf = (episodeId: string = ep02): string => findEpisode(store, episodeId)!.lifecycle

const offerFor = (episodeId: string) => stageOffer(store, READY, episodeId, scriptStage())

const onDisk = (artifact: Artifact): string =>
  readFileSync(join(paths.artifactDir, artifact.filePath!), 'utf8')

/** The character check's reply: one finding, anchored in scene 2 by a quote out of scene 2. */
function characterFinding(): string {
  const roster = factsOfEntity(store, harbor.entity('Ilse Renn').id).find((fact) =>
    fact.statement.includes('duty roster on Sunday'),
  )!
  return JSON.stringify({
    findings: [
      {
        scene: 2,
        quote: QUOTED,
        concern: CONCERN,
        severity: 'medium',
        confidence: 'high',
        entity: 'Ilse Renn',
        facts: [roster.id],
      },
    ],
  })
}

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

// ── Trap 1: scenes are derived, per landed draft, before the checks read ────────

describe('scenes are derived from the script, and the count is an output', () => {
  it('lands ep02 with the scenes its own draft broke into, and none before it', async () => {
    await ruleThePremiseAndTheOutline()
    // Through the premise and the outline, ep02 has no scenes at all: an outline is intent and
    // decides no scene (E4-2). This is the assertion that fails on the script side if it ever
    // starts deciding one.
    expect(scenesOf(store, ep02)).toEqual([])

    queueRound(SCRIPT_V1, SCRIPT_PANEL)
    await writeTheScript()

    expect(scenesOf(store, ep02).map((scene) => [scene.ordinal, scene.heading])).toEqual([
      [1, 'INT. WATER PLANT — 05:50'],
      [2, "INT. HARBOURMASTER'S OFFICE — 06:30"],
      [3, 'INT. DRY STORES — 18:00'],
    ])
    // Read off the rows, never off a field: there is no `num_scenes` anywhere and there must
    // never be one (0001, D3).
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM scene WHERE episode_id = ?', ep02)!.n)
      .toBe(3)
    // And the count came out of the draft rather than out of the outline: the outline above has
    // three movements and this draft has three scenes only because the writer wrote three.
    expect(delineateScript(onDisk(script()), 'the draft')).toHaveLength(3)
  })

  it('delineates BEFORE that round’s checks read it, so a finding anchors in a fresh row', async () => {
    await ruleThePremiseAndTheOutline()

    queueRound(SCRIPT_V1, SCRIPT_PANEL, characterFinding())
    queueRound(SCRIPT_V2, SCRIPT_PANEL)
    await writeTheScript()

    // The panel answered `"scene": 2` and the anchor resolved — which it can only do if the
    // scene rows existed when the check composed its prompt, and if the quote really sits
    // inside that scene's span (`anchorOf`, `sceneSpans`). Delineation at approval instead of
    // here would have made this an unanchorable finding on a sceneless artifact.
    const raised = findingsIn(store, script().id).find((one) => one.checkKey === 'character')!
    expect(raised.anchor.version).toBe(1)
    expect(raised.anchor.quote).toBe(QUOTED)
    expect(raised.anchor.sceneId).not.toBeNull()
    // Round 2's prompt carries it back with the scene it landed in, so the rewrite knows where.
    expect(writerPrompts()[1]).toContain('the character check · severity medium · confidence high')
    expect(writerPrompts()[1]).toContain(QUOTED)
  })

  it('re-delineates every version, and the scene rows follow the newest draft', async () => {
    await ruleThePremiseAndTheOutline()

    queueRound(SCRIPT_V1, SCRIPT_PANEL, characterFinding())
    queueRound(SCRIPT_V2, SCRIPT_PANEL)
    await writeTheScript()

    expect(script().version).toBe(2)
    expect(scenesOf(store, ep02).map((scene) => scene.heading)).toEqual([
      'INT. WATER PLANT — 05:50',
      'INT. NO. 4 LOCK — 06:10',
      "INT. HARBOURMASTER'S OFFICE — 06:30",
      'INT. DRY STORES — 18:00',
    ])
    // Both drafts are on the volume, each its own file, and each was delineated as it landed.
    expect(delineateScript(readFileSync(join(paths.artifactDir, 'greyharbor/s01e02/script-round-1.md'), 'utf8'), 'v1'))
      .toHaveLength(3)
    expect(onDisk(script())).toBe(`${SCRIPT_V2}\n`)
  })

  it('asks the model for a script and never for a number of scenes', async () => {
    await ruleThePremiseAndTheOutline()
    queueRound(SCRIPT_V1, SCRIPT_PANEL)
    await writeTheScript()

    const [prompt] = writerPrompts()
    // The convention, stated exactly — because a scene is its heading and the app finds a
    // scene's text by looking its heading up (`domain/delineate.ts`).
    expect(prompt).toContain('## 1 · INT. GREY HARBOR STATION — MESS DECK — 06:10')
    expect(prompt).toContain('Every heading must differ from every other one')
    // The count is the writer's, said with the reason, and the pairing-off trap named.
    expect(prompt).toContain('How many scenes there are is yours to decide')
    expect(prompt).toContain('Do not pair its movements off against scenes')
    // And nowhere is a count asked for, in any of the shapes that would smuggle one in.
    expect(prompt).not.toMatch(/how many scenes should|number of scenes:|write \d+ scenes/i)
    expect(prompt).not.toMatch(/one scene per movement/i)
  })
})

// ── Trap 2: scene identity across versions, end to end ──────────────────────────

describe('a scene is its heading, across a whole-script rewrite', () => {
  it('keeps the anchor where it was when a rewrite inserts a scene above it', async () => {
    await ruleThePremiseAndTheOutline()

    queueRound(SCRIPT_V1, SCRIPT_PANEL, characterFinding())
    queueRound(SCRIPT_V2, SCRIPT_PANEL)

    await writeTheScript()

    const anchored = findingsIn(store, script().id).find((one) => one.checkKey === 'character')!
    const scenes = scenesOf(store, ep02)
    const landedIn = scenes.find((scene) => scene.id === anchored.anchor.sceneId)!

    // The scene the finding is anchored in is the office scene it was raised against — now at
    // ordinal 3, because a scene was inserted above it. **Identity is not the ordinal.** Under
    // the ordinal identity this replaced, this same row would now be the No. 4 lock, and the
    // finding about how Ilse answers a question would render against a man walking through a
    // door, with nothing anywhere saying it had moved.
    expect(landedIn.heading).toBe("INT. HARBOURMASTER'S OFFICE — 06:30")
    expect(landedIn.ordinal).toBe(3)
    expect(scenes[1]!.heading).toBe('INT. NO. 4 LOCK — 06:10')
    expect(scenes[1]!.id).not.toBe(anchored.anchor.sceneId)
  })

  it('takes the scene with it when a rewrite renames the heading, and migrates no anchor', async () => {
    await ruleThePremiseAndTheOutline()

    // The same three scenes, with the office renamed to a different hour — the writer saying
    // this is a different scene.
    const renamed = SCRIPT_V1.replace("INT. HARBOURMASTER'S OFFICE — 06:30", 'INT. HARBOURMASTER’S OFFICE — 09:15')
    queueRound(SCRIPT_V1, SCRIPT_PANEL, characterFinding())
    queueRound(renamed, SCRIPT_PANEL)
    await writeTheScript()

    const anchored = findingsIn(store, script().id).find((one) => one.checkKey === 'character')!
    // The row it named is gone, so the finding degrades to the whole artifact — `scene_id` is
    // `ON DELETE SET NULL` (0010) and that is exactly what it was built for. What it does NOT
    // do is point at a scene it was never raised against.
    expect(anchored.anchor.sceneId).toBeNull()
    expect(anchored.anchor.quote).toBe(QUOTED)
    expect(scenesOf(store, ep02).map((scene) => scene.heading)).toEqual([
      'INT. WATER PLANT — 05:50',
      'INT. HARBOURMASTER’S OFFICE — 09:15',
      'INT. DRY STORES — 18:00',
    ])
  })

  it('reaches Ryan rather than filing a draft whose scenes cannot be told apart', async () => {
    await ruleThePremiseAndTheOutline()

    // Two scenes with one heading. `sceneSpans` would hand both rows the same first occurrence,
    // so every span after it would be wrong — including the ones an anchor is verified against.
    const ambiguous = [
      '## 1 · INT. DRY STORES',
      '',
      'Ilse Renn writes the ration up on the board.',
      '',
      '## 2 · INT. DRY STORES',
      '',
      'Tobin Wick reads it.',
    ].join('\n')
    for (let attempt = 0; attempt < 3; attempt += 1) llm.reply(ambiguous)

    const run = runner.enqueueRun({ episodeId: ep02, stage: SCRIPT_STAGE })
    const settled = await runner.settled(run.id)

    expect(settled.status).toBe('failed')
    expect(settled.failure).toContain('both “INT. DRY STORES”')
    expect(settled.failure).toContain('a scene is its heading')
    // Three attempts, then Ryan with the history (invariant 5) — and no scene row and no draft
    // left behind by any of them.
    expect(stepsOf(store, run.id)[0]!.failure).toContain('a scene is its heading')
    expect(scenesOf(store, ep02)).toEqual([])
    expect(artifactsOf(store, ep02).find((one) => one.kind === 'script')).toBeUndefined()
  })
})

// ── Trap 3: the fixture is a fixed point ───────────────────────────────────────

describe('ep01’s hand-written script', () => {
  it('is refused by the stage in words, before any click', () => {
    const offer = offerFor(ep01)

    expect(offer.enabled).toBe(false)
    expect(offer.blockedBecause).toBe(
      'ep01 already has a script — rule on it at its gate, or edit it directly (E4-5).',
    )
    // And the API refuses with the same string the disabled button is showing (D15).
    expect(launchBlockedBecause(store, READY, ep01, scriptStage())).toBe(offer.blockedBecause)
    expect(llm.calls).toHaveLength(0)
  })

  it('survives a run of this stage byte for byte — a hand-made asset always wins', async () => {
    const path = join(paths.artifactDir, 'greyharbor/s01e01/script.md')
    const before = readFileSync(path, 'utf8')
    expect(before).toBe(readFileSync(join(FIXTURE_DIR, 'episode/01-the-long-pier/script.md'), 'utf8'))
    const planted = scenesOf(store, ep01).map((scene) => scene.heading)

    // Forced past the refusal above, which is the only way in: a round writes its OWN file and
    // `writeIfAbsent` is what makes that a rule rather than a habit (D20).
    queueRound(SCRIPT_V1, 10)
    await writeTheScript(ep01)

    expect(readFileSync(path, 'utf8')).toBe(before)
    // The planted defects are still where `episode.md` says they are, in the file the checks
    // read them out of. A delineator that wanted this file changed would be the one that is
    // wrong.
    expect(delineateScript(before, 'ep01').map((scene) => scene.heading)).toEqual(planted)
    expect(planted[3]).toBe('EXT. THE LONG PIER — 07:07')
    expect(planted[5]).toBe('EXT. THE LONG PIER — CONTINUOUS')
  })
})

// ── Trap 6: the offer, and its honest upper bound ──────────────────────────────

describe('the script is offered only once the outline has been ruled', () => {
  it('refuses ep02 in words while its outline is unruled, before any click', async () => {
    // Premise approved, outline written and waiting: a draft on the volume is not an approval,
    // and the lifecycle column is the one place an approval is recorded as having happened.
    queueRound(PREMISE, PREMISE_PANEL)
    const premise = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(premise.id)
    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'yes.' })
    await runner.settled(premise.id)

    const offer = offerFor(ep02)
    expect(offer.enabled).toBe(false)
    expect(offer.blockedBecause).toContain('ep02 is at outline and has not reached script yet')
    expect(offer.blockedBecause).toContain('you have not approved its outline')
    expect(offer.blockedBecause).toContain('Rule on the ep02 outline first')
    expect(launchBlockedBecause(store, READY, ep02, scriptStage())).toBe(offer.blockedBecause)
  })

  it('states verb, object, scope and cost — with the reviewers OVER-stated, never under', async () => {
    await ruleThePremiseAndTheOutline()

    const offer = offerFor(ep02)
    expect(offer.enabled).toBe(true)
    expect(offer.sentence).toBe(
      'Write the ep02 script from the writer’s desk and present it for your ruling — ' +
        '“Dry Stores”, one call, then up to 9 reviewers read it',
    )
    expect(offer.sentence).not.toMatch(/^(Launch|Run|Go|Do|Start)\b/)
    expect(offer.cost).toMatch(/^1 Opus call, ~\$\d+\.\d\d \+ up to 9 Opus calls, ~\$\d+\.\d\d/)
    expect(offer.cost).toContain('stops at 3 drafts')
    expect(offer.cost).toContain('your money, spent when you click')

    // And the upper bound is really an upper bound: nine is every category that DECLARES the
    // script kind plus the craft reviewers, and what actually convenes is a consequence of who
    // the draft turns out to be about (4.1) — six. Over-stating is the safe direction; a button
    // that under-stated would be a button that lies cheaply.
    queueRound(SCRIPT_V1, SCRIPT_PANEL)
    await writeTheScript()
    expect(panelFor(store, script()).map((subject) => subject.key)).toEqual([
      'character',
      'location',
      'story-craft',
      'pacing',
      'dialogue',
      'hook',
    ])
  })
})

// ── Trap 5: the desk, on the third lap, and provenance out of what was written ──

describe('the desk is what reaches the model, on the third lap too', () => {
  it('carries the ruled outline whole, the audience’s canon, and nothing it left out', async () => {
    ratifyFact('Ilse Renn', 'Ilse signed the beacon over to Tobin for one night.', ep01)
    // Ratified while ep02 is being written. `canonAsOf(now)` shows it; the ep02 audience has
    // not seen it, so the desk refuses it — and so, therefore, does the prompt.
    ratifyFact('Ilse Renn', 'Ilse told the crew the lane is never reopening.', ep03)
    await ruleThePremiseAndTheOutline()

    queueRound(SCRIPT_V1, SCRIPT_PANEL)
    await writeTheScript()

    const [prompt] = writerPrompts()
    expect(writerPrompts()).toHaveLength(1)

    // The upstream: the RULED outline, whole, read off the volume by the desk rather than
    // reconstructed — and named as what it is, so the model knows what it is writing from.
    expect(prompt).toContain('The ep02 outline, whole:')
    expect(prompt).toContain(OUTLINE)
    // The world rules' prose, which arrives through `core` standing and no door of its own.
    expect(prompt).toContain('two hundred years calling itself')
    // A fact with ep01 lineage, on ep02's desk because ep01 is already on screen.
    expect(prompt).toContain('Ilse signed the beacon over to Tobin for one night.')
    expect(prompt).toContain('established in an earlier episode')
    // And the one a LATER episode ratified, refused. A second composer reading canon as it
    // stands now would have leaked this, and every other assertion here would still pass.
    expect(prompt).not.toContain('Ilse told the crew the lane is never reopening.')
    // The confession trail stays off the wire: `leftOut` carries identities so a surface can
    // answer "why did the writer not know about X", never so a prompt can iterate them.
    expect(prompt).not.toContain('Sefa Doule')
    expect(prompt).not.toContain('the assessor')
  })

  it('declares provenance out of what it WROTE, through the desk’s own matcher', async () => {
    await ruleThePremiseAndTheOutline()
    queueRound(SCRIPT_V1, SCRIPT_PANEL)
    await writeTheScript()

    // Invariant 2 runs backwards for a producer — there is no upstream declaration to read,
    // because this is the step that writes one — and `nameAppearingIn` is the one lexical rule
    // that decides "named in". No second extractor: the board (E3-1) remains the paid
    // verification of what the text actually says.
    expect(provenanceOf(store, script().id).map((one) => one.name).sort()).toEqual([
      'Grey Harbor Station',
      'Ilse Renn',
      'Tobin Wick',
    ])
  })

  it('walks the whole circuit once: one call, one artifact, one panel, one gate', async () => {
    await ruleThePremiseAndTheOutline()
    const before = llm.calls.length

    queueRound(SCRIPT_V1, SCRIPT_PANEL)
    const runId = await writeTheScript()

    expect(llm.calls.length - before).toBe(1 + SCRIPT_PANEL)

    const standing = gateStanding(store, openGates(store)[0]!.gate.id)!
    expect(standing).toMatchObject({ round: 1, isOpen: true, subject: 'the ep02 script' })
    const payload = standing.rounds[0]!.payload as CorrectionOutcome
    expect(payload.rounds.map((round) => [round.artifactVersion, round.checks])).toEqual([[1, 6]])
    expect(payload).toMatchObject({ converged: true, clean: true, blocking: [] })

    expect(stepsOf(store, runId).map((step) => [step.name, step.status])).toEqual([
      ['write-the-script', 'paused'],
      ['advance-past-the-script-gate', 'pending'],
    ])
    // And the gate renders its artifact rather than a filename (1.3).
    const view = runView(store, paths, runId)!
    expect(view.gate!.artifact.text).toBe(`${SCRIPT_V1}\n`)
  })
})

// ── The lifecycle seam, at the last stop the writing line has ──────────────────

describe('the script gate moves ep02 on, and nothing else does', () => {
  it('leaves it at script while the draft sits at its gate', async () => {
    await ruleThePremiseAndTheOutline()
    queueRound(SCRIPT_V1, SCRIPT_PANEL)
    await writeTheScript()

    expect(script()).toBeDefined()
    expect(scenesOf(store, ep02)).toHaveLength(3)
    expect(lifecycleOf()).toBe('script')
  })

  it('moves it to assets when Ryan approves, through the seam the builder put there', async () => {
    await ruleThePremiseAndTheOutline()
    queueRound(SCRIPT_V1, SCRIPT_PANEL)
    const runId = await writeTheScript()
    const spent = llm.calls.length

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'shoot it.' })
    const settled = await runner.settled(runId)

    expect(settled.status).toBe('done')
    expect(lifecycleOf()).toBe('assets')
    // Nothing re-written, nothing re-checked, nothing re-spent on the way back in — and
    // nothing re-delineated either.
    expect(llm.calls).toHaveLength(spent)
    expect(scenesOf(store, ep02)).toHaveLength(3)

    const close = findStepByName(store, runId, 'advance-past-the-script-gate')!.output as WriteClose
    expect(close.lifecycle).toMatchObject({ from: 'script', to: 'assets', moved: true })
    expect(close.sentence).toContain('ep02 moves from script to assets')
  })
})

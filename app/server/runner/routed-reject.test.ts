import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, staleArtifacts, type Artifact } from '../domain/artifact.ts'
import { dismissFinding, findingsIn, recordCheckPass } from '../domain/finding.ts'
import { proposalsRiding } from '../domain/proposal.ts'
import { notesOwedBy } from '../domain/routing.ts'
import { episodesOf, findEpisode, seasonsOf } from '../domain/spine.ts'
import { composeWriteContext } from '../domain/write-context.ts'
import { createEventLog, type EventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { describeLLMBackend, type LLMReadiness } from '../llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { launchBlockedBecause, stageOffer } from '../operating.ts'
import { createRulings, openGates, type Rulings } from './gate.ts'
import { findRun } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import { stageCatalogue } from './stages.ts'
import { OUTLINE_STAGE, PREMISE_STAGE, SCRIPT_STAGE } from './write-step.ts'

/**
 * **Reject is routed, not rewound** (E4-5, #65; D21, 4.7).
 *
 * A rejection note at a writing gate picks its depth. When every note is routed AWAY from the
 * draft under review — to the outline, or to the premise — three things must be true at once,
 * and this file is those three:
 *
 *   1. **Nothing regenerates.** The run ends. The draft Ryan ruled on is the draft on the
 *      volume, at the version he ruled on it, and not one model call was made after the verdict.
 *   2. **What changes is the TARGET's offer.** The stage that writes the artifact the note names
 *      becomes offerable again, with the note in its sentence — and the depths he did not route
 *      to are exactly as they were.
 *   3. **The note reaches the target's next run through the desk, with its origin on it** —
 *      "your note from the ep02 script gate, routed here", which is a different instruction from
 *      "your round-2 rejection" and from "a finding you dismissed".
 *
 * "Addressed" is derived and never flagged: the offer closes again the moment a newer version
 * of the target exists, whoever wrote it.
 *
 * Everything runs the REAL stages through the REAL runner against a REAL library volume with
 * Grey Harbor founded in it, and the fake backend in front of the model.
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

// ── What the fake writes ────────────────────────────────────────────────────────

const PREMISE = [
  'The water plant’s exchanger fails on a Tuesday, three weeks after Ilse Renn cut the tag off',
  'its spare and gave the part to the beacon. Tobin Wick is the one who reads the temperature',
  'log, and the one who has to decide what to do about having read it.',
].join('\n')

const PREMISE_PANEL = 3

const OUTLINE = [
  '## Morning, dry',
  '',
  'Tobin Wick reads the exchanger log at Grey Harbor Station and says out loud what it means.',
  'Ilse Renn already knows.',
  '',
  '## The drawer',
  '',
  'Tobin goes for the spare and the drawer is empty. Ilse answers him with the roster.',
  '',
  '## Dry stores',
  '',
  'By the end the water is rationed and nobody has said whose fault it is.',
].join('\n')

/** The outline written again, against his routed note. */
const OUTLINE_AGAIN = [
  '## Morning, dry',
  '',
  'Tobin Wick reads the exchanger log at Grey Harbor Station and says out loud what it means.',
  'Ilse Renn already knows, and the audience learns that she knows before he does.',
  '',
  '## The drawer',
  '',
  'Tobin goes for the spare and the drawer is empty. Ilse answers him with the roster, and the',
  'audience learns what she did three weeks ago. Tobin does not.',
  '',
  '## Dry stores',
  '',
  'By the end the water is rationed and nobody has said whose fault it is.',
].join('\n')

const OUTLINE_PANEL = 5

const SCRIPT = [
  '# Dry Stores — script',
  '',
  '## 1 · INT. WATER PLANT — 05:50',
  '',
  '> Tobin reads the exchanger log and says what it means out loud.',
  '',
  'TOBIN WICK has the temperature log open on the housing.',
  '',
  "## 2 · INT. HARBOURMASTER'S OFFICE — 06:30",
  '',
  '> Ilse is asked where the spare went, and answers with the roster.',
  '',
  'Ilse Renn is at the desk at Grey Harbor Station with the spares drawer shut.',
  '',
  '## 3 · INT. DRY STORES — 18:00',
  '',
  '> The water goes on ration and nobody says whose fault it is.',
  '',
  'Ilse Renn writes the ration up on the board and does not sign it.',
].join('\n')

const SCRIPT_PANEL = 6

const NOTHING_FOUND = '{"findings": []}'

/** The note Ryan writes at the script gate and sends back to the outline. */
const ROUTED = 'The middle movement does not turn — the drawer is the same beat as the log.'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-routed-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)

  const season = seasonsOf(store, harbor.show.id)[0]!
  ep02 = episodesOf(store, season.id)[1]!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

// ── Getting ep02 to an open script gate, the way Ryan would ─────────────────────

function queueRound(draft: string, panel: number, ...said: string[]): void {
  llm.reply(draft)
  const answers = [...said]
  while (answers.length < panel) answers.push(NOTHING_FOUND)
  for (const answer of answers) llm.reply(answer)
}

/** ep02 through the premise and the outline, each approved at its own gate. */
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

/** …and up to an OPEN script gate, with the draft written and read. */
async function toTheScriptGate(): Promise<string> {
  await ruleThePremiseAndTheOutline()
  queueRound(SCRIPT, SCRIPT_PANEL)
  const run = runner.enqueueRun({ episodeId: ep02, stage: SCRIPT_STAGE })
  const settled = await runner.settled(run.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? 'the run failed')
  return run.id
}

/** The rejection this whole file is about: one note, routed to the outline. */
async function rejectToTheOutline(runId: string, note = ROUTED): Promise<void> {
  rulings.reject(openGates(store)[0]!.gate.id, { notes: [{ note, depth: 'outline' }] })
  await runner.settled(runId)
}

// ── Reading ─────────────────────────────────────────────────────────────────────

const artifact = (kind: string): Artifact =>
  artifactsOf(store, ep02).find((one) => one.kind === kind)!

const offerFor = (stage: string) => stageOffer(store, READY, ep02, stageCatalogue(paths)[stage]!)

/**
 * What the STAGE itself says it has to do, asked directly — because while the script run is
 * parked at its gate, D7's one-run-per-episode answers first with a true sentence about a
 * different thing (`operating.ts`).
 */
const nothingToDoOn = (stage: string): string | null =>
  stageCatalogue(paths)[stage]!.offerOn(store, findEpisode(store, ep02)!).nothingToDoBecause

const promptsFor = (what: string): string[] =>
  llm.calls.filter((call) => call.prompt.includes(what)).map((call) => call.prompt)

const onDisk = (one: Artifact): string =>
  readFileSync(join(paths.artifactDir, one.filePath!), 'utf8')

// ── 1 · Nothing regenerates ─────────────────────────────────────────────────────

describe('a rejection routed away from the draft regenerates nothing', () => {
  it('ends the run with the script exactly as he ruled on it, and no call after the verdict', async () => {
    const runId = await toTheScriptGate()
    const spentBefore = llm.calls.length
    expect(artifact('script').version).toBe(1)

    await rejectToTheOutline(runId)

    // The verdict was given, the run finished, and nothing was written or read for money in
    // between. "Nothing regenerates until the route lands" (D21), said as a call count.
    expect(llm.calls).toHaveLength(spentBefore)
    expect(findRun(store, runId)!.status).toBe('done')
    expect(artifact('script').version).toBe(1)
    expect(onDisk(artifact('script'))).toBe(`${SCRIPT}\n`)
  })

  it('leaves the episode where it stood, and raises nothing of what the script claimed', async () => {
    const runId = await toTheScriptGate()
    expect(findEpisode(store, ep02)!.lifecycle).toBe('script')

    await rejectToTheOutline(runId)

    // A rejection is not an approval, so the lifecycle does not move (E4-1) — and E4-4's paid
    // extraction reads the draft he APPROVED, so a rejection buys none of it.
    expect(findEpisode(store, ep02)!.lifecycle).toBe('script')
    expect(proposalsRiding(store, ep02)).toEqual([])
  })

  it('still writes the draft again when the note is about the draft in front of him', async () => {
    const runId = await toTheScriptGate()
    queueRound(SCRIPT.replace('05:50', '05:55'), SCRIPT_PANEL)

    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'Scene 1 opens too early.', depth: 'artifact' }],
    })
    await runner.settled(runId)

    // The ordinary path, untouched: a note that lands here is what the correction loop has
    // always answered by writing the draft again, and round 2 is open on the new version.
    expect(artifact('script').version).toBe(2)
    expect(openGates(store)[0]!.round).toBe(2)
  })
})

// ── 2 · The target's offer, and only the target's ───────────────────────────────

describe('the note reopens exactly the stage it was routed to', () => {
  it('offers the outline again, with the note quoted in the sentence', async () => {
    const runId = await toTheScriptGate()
    // Before the rejection there is nothing for the outline stage to do.
    expect(nothingToDoOn(OUTLINE_STAGE)).toContain('ep02 already has an outline')

    await rejectToTheOutline(runId)

    const offer = offerFor(OUTLINE_STAGE)
    expect(offer.enabled).toBe(true)
    expect(offer.blockedBecause).toBeNull()
    expect(offer.sentence).toContain(
      'the ep02 outline has your note from the script gate standing against it — rewriting ' +
        `reads it: “${ROUTED}”`,
    )
    // The API and the button say the same thing (D15).
    expect(launchBlockedBecause(store, READY, ep02, stageCatalogue(paths)[OUTLINE_STAGE]!)).toBeNull()
    // And it is on the artifact, not on the gate it was written at.
    expect(notesOwedBy(store, artifact('outline').id)).toHaveLength(1)
    expect(notesOwedBy(store, artifact('script').id)).toEqual([])
  })

  it('leaves the depths he did not route to exactly as they were', async () => {
    const runId = await toTheScriptGate()
    const before = nothingToDoOn(PREMISE_STAGE)

    await rejectToTheOutline(runId)

    // The premise-brief was not routed to, so its stage still has nothing to do — word for
    // word the sentence it was already saying.
    expect(nothingToDoOn(PREMISE_STAGE)).toEqual(before)
    expect(offerFor(PREMISE_STAGE).blockedBecause).toContain('ep02 already has a premise-brief')
    expect(notesOwedBy(store, artifact('premise-brief').id)).toEqual([])
  })

  it('closes again the moment a newer version of the outline exists — no flag anywhere', async () => {
    const runId = await toTheScriptGate()
    await rejectToTheOutline(runId)

    queueRound(OUTLINE_AGAIN, OUTLINE_PANEL)
    const again = runner.enqueueRun({ episodeId: ep02, stage: OUTLINE_STAGE })
    await runner.settled(again.id)
    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'that turns now.' })
    await runner.settled(again.id)

    expect(artifact('outline').version).toBe(2)
    // Derived: nothing was written to the note, and the row still says what it said.
    expect(notesOwedBy(store, artifact('outline').id)).toEqual([])
    expect(
      store.get<{ n: number }>('SELECT COUNT(*) AS n FROM gate_note WHERE target IS NOT NULL')!.n,
    ).toBe(1)
    expect(offerFor(OUTLINE_STAGE).blockedBecause).toContain('ep02 already has an outline')
    // Forward only: the outline gate approved on an episode already past outline moves nothing.
    expect(findEpisode(store, ep02)!.lifecycle).toBe('script')
    // And the script is stale, because the thing it was written from has moved (1.3).
    expect(staleArtifacts(store, ep02).map((one) => one.artifact.kind)).toEqual(['script'])
  })
})

// ── 3 · The note travels through the desk, with its origin ──────────────────────

describe('the routed note reaches the target’s writer, and says where it came from', () => {
  it('arrives in the outline writer’s captured prompt, routed here', async () => {
    const runId = await toTheScriptGate()
    await rejectToTheOutline(runId)

    queueRound(OUTLINE_AGAIN, OUTLINE_PANEL)
    await runner.settled(runner.enqueueRun({ episodeId: ep02, stage: OUTLINE_STAGE }).id)

    const [, rewrite] = promptsFor('WRITE THE ep02 OUTLINE')
    expect(rewrite).toContain('WHAT THE SHOWRUNNER HAS ALREADY SAID')
    expect(rewrite).toContain(
      `your note from the ep02 script gate, routed here: “${ROUTED}”`,
    )
  })

  it('is not handed to the writer of the draft whose gate it was written at', async () => {
    const runId = await toTheScriptGate()
    await rejectToTheOutline(runId)

    // The script's own desk does not carry it: he was standing at the script gate, but the
    // note is about the outline, and a script writer told to answer it would be the rewind
    // D21 forbids.
    const desk = composeWriteContext(store, paths, { episodeId: ep02, step: 'script' })
    expect(desk.notes.map((note) => note.note)).not.toContain(ROUTED)

    const outlineDesk = composeWriteContext(store, paths, { episodeId: ep02, step: 'outline' })
    expect(outlineDesk.notes.map((note) => note.note)).toContain(ROUTED)
  })

  it('tells three origins apart — routed, round rejection, and a dismissed finding', async () => {
    const runId = await toTheScriptGate()
    // A round rejection of the OUTLINE itself, before the routed one, so the outline's desk
    // carries both kinds at once.
    await rejectToTheOutline(runId)
    rejectTheOutlineOnItsOwnGate()
    dismissAFindingSomewhereElse()

    const desk = composeWriteContext(store, paths, { episodeId: ep02, step: 'outline' })
    const kinds = desk.notes.map((note) => note.origin.kind)
    expect(new Set(kinds)).toEqual(
      new Set(['routed-rejection', 'gate-rejection', 'finding-dismissal']),
    )
    const sentences = Object.fromEntries(desk.notes.map((note) => [note.origin.kind, note.sentence]))
    expect(sentences['routed-rejection']).toBe('your note from the ep02 script gate, routed here')
    expect(sentences['gate-rejection']).toBe('your round 1 rejection of the ep02 outline')
    expect(sentences['finding-dismissal']).toContain('finding you dismissed in ep02')
  })
})

/**
 * A rejection of the outline AT THE OUTLINE'S OWN GATE — the second of the three origins.
 *
 * Written straight onto the ledger rather than driven through a run: the outline's writing run
 * is long finished, and what this test is about is how the desk reads three kinds of note apart,
 * not how a second run of the outline stage would behave.
 */
function rejectTheOutlineOnItsOwnGate(): void {
  const outline = artifact('outline')
  store.run("INSERT INTO run (id, episode_id, stage) VALUES ('run_x', ?, ?)", ep02, OUTLINE_STAGE)
  store.run("INSERT INTO step (id, run_id, ordinal, name) VALUES ('step_x', 'run_x', 1, 'w')")
  store.run(
    'INSERT INTO gate (id, run_id, step_id, episode_id, artifact_id) VALUES (?, ?, ?, ?, ?)',
    'gate_x',
    'run_x',
    'step_x',
    ep02,
    outline.id,
  )
  store.run(
    'INSERT INTO gate_round (gate_id, round, artifact_version) VALUES (?, 1, ?)',
    'gate_x',
    outline.version,
  )
  store.run("INSERT INTO gate_ruling (gate_id, round, verdict) VALUES ('gate_x', 1, 'reject')")
  store.run(
    "INSERT INTO gate_note (gate_id, round, note) VALUES ('gate_x', 1, 'Say what the audience learns.')",
  )
}

/** A finding on the script, put down with a note — the third origin (E3-5, 4.4). */
function dismissAFindingSomewhereElse(): void {
  const pass = recordCheckPass(store, {
    checkKey: 'world-rules',
    tier: 'text',
    artifactId: artifact('script').id,
    findings: [
      {
        concern: 'Nobody says whether the plant is inboard.',
        severity: 'low',
        confidence: 'low',
        anchor: { quote: 'The plant is loud' },
      },
    ],
  })
  const raised = findingsIn(store, artifact('script').id).find((one) => one.passId === pass.id)!
  dismissFinding(store, raised.id, 'The plant is inboard. It always has been.')
}

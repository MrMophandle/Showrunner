import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, recordArtifact, type Artifact } from '../domain/artifact.ts'
import { runBoardRules } from '../domain/board-rules.ts'
import { recordExtractedBoard } from '../domain/board.ts'
import { factsOfEntity } from '../domain/fact.ts'
import { findingsIn } from '../domain/finding.ts'
import { unaddressedNotesTo } from '../domain/routing.ts'
import { findEpisode } from '../domain/spine.ts'
import { createEventLog, type EventLog } from '../events.ts'
import { greyHarborFounded } from '../fixture/founded.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { describeLLMBackend } from '../llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { launchBlockedBecause, runView, stageOffer } from '../operating.ts'
import { createRulings, openGates, type Rulings } from './gate.ts'
import { createRunner, type Runner } from './runner.ts'
import { draftsUnderReview, type CorrectionReport } from './correction-loop.ts'
import { OUTLINE_GATE_STAGE, PREMISE_GATE_STAGE, SCRIPT_GATE_STAGE } from './present-step.ts'
import { stageBlockedBecause } from './stage-wall.ts'
import { stageCatalogue } from './stages.ts'
import { PREMISE_STAGE, SCRIPT_STAGE } from './write-step.ts'

/**
 * The gate over a written artifact (E3-7, generalized by E4-3): **the stage that produces
 * nothing, and the door the wall's override is behind.**
 *
 * D12 says a deterministic finding blocks the next stage and never Ryan's gate. Both halves
 * are asserted here against the fixture's own planted contradiction, and the second half is
 * the one that needed a stage built for it: `overriddenThrough` is asked per artifact, so an
 * override is only an override of what is standing on the artifact under review — and until
 * this stage there was no gate anywhere in the app over the ep01 script.
 *
 * ## And the collision E3-7 left for E4 (#63)
 *
 * E4's writing line opened its own gate over the script, which is two stages able to put one
 * artifact in front of Ryan — the state the E3 ledger forbids. The affordance was kept and
 * generalized rather than retired, and the last block below is what that resolution is worth:
 * the two gates can never be open at once, and the two payloads are one shape.
 */

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
let episodeId: string
let script: Artifact

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-script-gate-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  greyHarborFounded(store, paths)
  episodeId = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'The Long Pier'")!.id
  script = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'script')!

  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)
  rulings = createRulings(store, events, runner)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const factOf = (entity: string, needle: string): string => {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

/** The fixture's planted contradictions, raised for nothing by the rules that read rows. */
function theBoard(): void {
  const board = recordExtractedBoard(store, {
    episodeId,
    scriptId: script.id,
    extraction: theLongPierExtraction({
      lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factOf('Halvani', 'loses consciousness'),
    }),
    filePath: 'greyharbor/s01e01/continuity-board-v1.md',
  })
  runBoardRules(store, board.artifact.id)
}

async function present(): Promise<string> {
  const run = runner.enqueueRun({ episodeId, stage: SCRIPT_GATE_STAGE })
  await runner.settled(run.id)
  return run.id
}

describe('the script gate — presenting what stands', () => {
  it('opens a gate over the script with the verdict board under it, and calls nothing', async () => {
    theBoard()

    const runId = await present()

    expect(llm.calls).toEqual([])
    const gate = openGates(store)[0]!
    expect(gate.subject).toBe('the ep01 script')
    expect(gate.round).toBe(1)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_entry')!.n).toBe(0)

    // The round records what he was shown: a snapshot of the board, and the findings the wall
    // is standing on, so the ruling is readable a season later against a live recomputation.
    const view = runView(store, paths, runId)!
    const payload = view.gate!.rounds[0]!.payload as {
      board: { rows: { checkKey: string }[] }
      blocking: { checkKey: string; scene: number | null }[]
    }
    expect(payload.board.rows.map((row) => row.checkKey)).toContain('dual-presence')
    expect(payload.blocking.map((one) => [one.checkKey, one.scene])).toEqual([
      ['vacuum-without-protection', 4],
      ['dual-presence', 6],
    ])
  })

  it('is never itself walled — a deterministic finding blocks the next stage, not a ruling', () => {
    theBoard()

    // The wall is up, and it is what refuses a stage that would PRODUCE from this episode's
    // material. That refusal is asserted on ep02 in `operating.test.ts`: E4-1 retired `demo`,
    // and the only producer this build ships is the premise stage, which on ep01 is refused
    // for having nothing to do — the fixture wrote ep01's premise by hand — before the wall
    // is ever consulted (`operating.ts`).
    expect(stageBlockedBecause(store, episodeId)).toContain('ep01 is blocked')
    expect(
      launchBlockedBecause(
        store,
        describeLLMBackend({ ANTHROPIC_API_KEY: 'k' }),
        episodeId,
        stageCatalogue(paths)[PREMISE_STAGE]!,
      ),
    ).toContain('already has a premise-brief')
    // And the gate is not. Refusing it would be a check vetoing Ryan by the longest route.
    expect(
      launchBlockedBecause(store, describeLLMBackend({ PATH: '' }), episodeId, stageCatalogue(paths)[SCRIPT_GATE_STAGE]!),
    ).toBeNull()
  })

  it('names on the button what an approval would be standing over', async () => {
    theBoard()

    const offered = stageCatalogue(paths)[SCRIPT_GATE_STAGE]!.offerOn(
      store,
      findEpisode(store, episodeId)!,
    )
    expect(offered.sentence).toContain('2 deterministic findings stand on it')
    expect(offered.sentence).toContain('approving over them is recorded as your override')
    expect(offered.callsModel).toBe(false)
  })
})

describe('the script gate — the three verdicts, and what each leaves behind', () => {
  it('takes the wall down on an override, and writes nothing to any finding', async () => {
    theBoard()
    const runId = await present()
    const standing = findingsIn(store, script.id).map((one) => [one.id, one.status])

    rulings.override(openGates(store)[0]!.gate.id, { comment: 'shooting it as written' })
    await runner.settled(runId)

    expect(stageBlockedBecause(store, episodeId)).toBeNull()
    // The findings are exactly as the checks left them. Nothing wrote an unblock: the wall is
    // a read, and one of its five conditions stopped being true (`stage-wall.ts`).
    expect(findingsIn(store, script.id).map((one) => [one.id, one.status])).toEqual(standing)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM finding_disposition')!.n).toBe(0)
    expect(store.get<{ verdict: string }>('SELECT verdict FROM gate_ruling')!.verdict).toBe('override')
  })

  it('leaves the wall up on a plain approval — the two verbs are two rulings, forever', async () => {
    theBoard()
    const runId = await present()

    rulings.approve(openGates(store)[0]!.gate.id, { comment: 'read it, carry on' })
    await runner.settled(runId)

    // An approval is not an override, and folding them would spend invariant 3's distinction
    // at the one place it is load-bearing.
    expect(stageBlockedBecause(store, episodeId)).toContain('ep01 is blocked')
  })

  it('reopens as the next round on a rejection, with the notes recorded against it', async () => {
    theBoard()
    const runId = await present()

    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'scene 6 has to move; she cannot be on the pier', depth: 'scene', target: 'scene-6' }],
    })
    await runner.settled(runId)

    const view = runView(store, paths, runId)!
    expect(view.gate!.round).toBe(2)
    expect(view.gate!.isOpen).toBe(true)
    expect(view.gate!.rounds[0]!.ruling!.notes[0]!.note).toContain('scene 6 has to move')
    expect(view.gate!.rounds[0]!.ruling!.notes[0]!.depth).toBe('scene')
    // Round 1 is kept exactly as it was ruled, marked rather than replaced.
    expect(view.gate!.rounds[0]!.stale).toBe(true)
    // Rejecting a presentation costs nothing: there is no producer behind this gate to re-run,
    // and the button says that rather than promising a rewrite nothing is going to do.
    expect(view.gate!.reject.cost).toBe('No model call · $0.00')
    expect(view.gate!.reject.sentence).toContain('presents it again with them recorded against it')
    expect(view.gate!.reject.sentence).not.toContain('writes it again')
    expect(llm.calls).toEqual([])
  })

  /**
   * **A note routed to another artifact ends the run instead of re-presenting** (E4-5, D21).
   *
   * The presenting stage has no producer to re-run, so a rejection has always re-presented
   * the same draft as the next round. That is right for a note about THIS draft and wrong for
   * one routed away: re-presenting the script Ryan has just sent back to the outline would
   * park his own episode on a gate he has already ruled, and the work he asked for is at a
   * different stage's button (`domain/routing.ts`).
   */
  it('ends the run instead, when the note was routed to another artifact', async () => {
    theBoard()
    const runId = await present()

    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'the outline never turns here', depth: 'outline' }],
    })
    await runner.settled(runId)

    const view = runView(store, paths, runId)!
    expect(view.run.status).toBe('done')
    expect(view.gate!.round).toBe(1)
    expect(view.gate!.isOpen).toBe(false)
    expect(openGates(store)).toEqual([])
    // Nothing regenerated and nothing re-presented — and the ep01 outline is where the note is.
    expect(llm.calls).toEqual([])
    expect(
      unaddressedNotesTo(store, artifactsOf(store, episodeId).find((one) => one.kind === 'outline')!.id),
    ).toHaveLength(1)
  })
})

// ── The collision, resolved (E4-3, #63) ────────────────────────────────────────

describe('one artifact, one ruling — and two doors onto it', () => {
  /** Every written kind has one, and each presents its own. */
  it('offers a presenting stage per written artifact, and each names what it presents', () => {
    const episode = findEpisode(store, episodeId)!
    const offers = [PREMISE_GATE_STAGE, OUTLINE_GATE_STAGE, SCRIPT_GATE_STAGE].map((name) =>
      stageCatalogue(paths)[name]!.offerOn(store, episode),
    )

    expect(offers.map((offer) => offer.sentence)).toEqual([
      'Present the ep01 premise-brief v1 for your ruling — what the panel found is under it, and nothing deterministic stands',
      'Present the ep01 outline v1 for your ruling — what the panel found is under it, and nothing deterministic stands',
      'Present the ep01 script v1 for your ruling — what the panel found is under it, and nothing deterministic stands',
    ])
    // None of them spends anything, and none of them may be walled (D12, invariant 3).
    for (const name of [PREMISE_GATE_STAGE, OUTLINE_GATE_STAGE, SCRIPT_GATE_STAGE]) {
      expect(stageCatalogue(paths)[name]!.work).toBe('reads')
      expect(stageCatalogue(paths)[name]!.offerOn(store, episode).callsModel).toBe(false)
    }
  })

  /**
   * The refusal E4-1 and E4-2 already say — "rule on it at its gate, or edit it directly" —
   * is TRUE for an artifact whose writing run never existed, which is what retiring this
   * stage would have taken away. ep01's script was written by hand into the fixture.
   */
  /**
   * **The E4 drill's opening move** (#67): ep02 in Ryan's real library carries a premise-brief
   * E1's retired `demo` stage wrote into its own slot, and the writing stage refuses it with
   * "ep02 already has a premise-brief, in slot “demo” — rule on it at its gate, or edit it
   * directly". Both halves of that sentence have to be true of THAT artifact, slot and all.
   */
  it('presents an artifact a retired stage wrote into its own slot — the drill’s opening move', () => {
    const ep02 = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'Dry Stores'")!.id
    const demo = recordArtifact(store, {
      episodeId: ep02,
      kind: 'premise-brief',
      slot: 'demo',
      filePath: 'greyharbor/s01e02/premise-brief-demo.md',
    })
    mkdirSync(join(paths.artifactDir, 'greyharbor', 's01e02'), { recursive: true })
    writeFileSync(
      join(paths.artifactDir, demo.filePath!),
      'A relay goes dark, and the part that replaces it was promised to the water plant.\n',
      'utf8',
    )

    const ready = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
    // The writing stage refuses it, naming both doors…
    const write = stageOffer(store, ready, ep02, stageCatalogue(paths)[PREMISE_STAGE]!)
    expect(write.blockedBecause).toBe(
      'ep02 already has a premise-brief, in slot “demo” — rule on it at its gate, or edit it ' +
        'directly (E4-5).',
    )
    // …and the gate it names opens over that very artifact, free and refused by nothing.
    const present = stageOffer(store, ready, ep02, stageCatalogue(paths)[PREMISE_GATE_STAGE]!)
    expect(present.enabled).toBe(true)
    expect(present.blockedBecause).toBeNull()
    expect(present.sentence).toContain('Present the ep02 premise-brief v1 for your ruling')
  })

  it('makes “rule on it at its gate” truthful for an artifact no run ever wrote', () => {
    const episode = findEpisode(store, episodeId)!
    expect(
      stageCatalogue(paths)[SCRIPT_STAGE]!.offerOn(store, episode).nothingToDoBecause,
    ).toContain('rule on it at its gate')
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM run')!.n).toBe(0)

    // And the gate that sentence points at is offerable, right now, for nothing.
    const offer = stageOffer(store, describeLLMBackend({ PATH: '' }), episodeId, stageCatalogue(paths)[SCRIPT_GATE_STAGE]!)
    expect(offer.enabled).toBe(true)
    expect(offer.blockedBecause).toBeNull()
  })

  /**
   * **Never two gates at once**, and it is D7 that guarantees it rather than anything in this
   * file: one run per episode, refused with the same string the API refuses with (D15).
   */
  it('refuses the writing stage while this gate is open, and itself while a writing gate is', async () => {
    await present()

    const ready = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
    const refused = launchBlockedBecause(store, ready, episodeId, stageCatalogue(paths)[SCRIPT_STAGE]!)
    expect(refused).toContain('ep01 already has a script-gate run')
    expect(refused).toContain('waiting on your ruling')
    expect(refused).toContain('One run per episode (D7)')
    // And the reverse, on the same rule: this stage is refused while any run of ep01 stands.
    expect(
      launchBlockedBecause(store, ready, episodeId, stageCatalogue(paths)[SCRIPT_GATE_STAGE]!),
    ).toBe(refused)
    expect(openGates(store)).toHaveLength(1)
  })

  /**
   * **Never two screens**, and that is this module's half: the payload is composed by the same
   * function the correction loop composes its own from, so what Ryan is handed over one
   * artifact does not depend on which door he came in by.
   */
  it('hands over the same shape a writing gate does — the drafts, the board, the wall', async () => {
    theBoard()
    const runId = await present()

    const payload = runView(store, paths, runId)!.gate!.rounds[0]!.payload as CorrectionReport
    expect(Object.keys(payload).sort()).toEqual(
      ['artifactId', 'blocking', 'board', 'clean', 'converged', 'rounds', 'sentence'].sort(),
    )
    expect(payload.artifactId).toBe(script.id)
    expect(payload).toMatchObject({ ...draftsUnderReview(store, script.id) })
    // The rounds are every draft a check has read, and a hand-written script has none: the
    // board's rules recorded their pass against the BOARD and anchored their findings in the
    // SCRIPT, which is the divergence 0010 built two columns for. So the history is empty and
    // the wall is two — both true, and the same two answers the writing loop would give.
    expect(payload.rounds).toEqual([])
    expect(payload.blocking.map((one) => one.checkKey)).toEqual([
      'vacuum-without-protection',
      'dual-presence',
    ])
    // Only the sentence is this door's own, because only the sentence is about why THIS gate
    // opened. It says the wall is standing and that it does not stand here.
    expect(payload.sentence).toContain('Presenting the ep01 script v1 for your ruling')
    expect(payload.sentence).toContain('none of them blocks this gate (D12)')
    expect(payload.sentence).not.toContain('correction budget')
  })
})

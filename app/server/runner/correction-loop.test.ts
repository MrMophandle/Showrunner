import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import {
  artifactsOf,
  recordArtifact,
  reviseArtifact,
  revisionsOf,
  type Artifact,
} from '../domain/artifact.ts'
import { checkPassesOf } from '../domain/finding.ts'
import { createProposalRulings, raiseProposal } from '../domain/proposal.ts'
import { createEventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { promotionFromSheet } from '../fixture/load.ts'
import { readFixture } from '../fixture/read.ts'
import { initLibrary, openLibraryStore, writeIfAbsent, type LibraryPaths } from '../library.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import {
  correctionLoop,
  correctionNoteLines,
  MAX_CORRECTION_ROUNDS,
  type CorrectionOutcome,
  type Producer,
} from './correction-loop.ts'
import { createRulings, gateStanding, openGates, type Rulings } from './gate.ts'
import { attemptsOf, findStepByName } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import type { StageCatalogue, StepContext } from './step.ts'
import { checkTextAgainstCanon } from './text-check-step.ts'

/**
 * The correction loop (4.4): **a stage composes produce → check, and a failed check re-runs
 * the producer with the findings as notes.** Bounded at three drafts (invariant 5), every
 * one of them kept, and whatever it ends on goes to Ryan with the whole history under it.
 *
 * ## Two loops, and this file is where they are proved apart
 *
 * A transport failure re-runs the SAME work: nothing was produced, nothing was judged, and
 * there is no ruling for Ryan to make. A correction re-runs the producer with NEW
 * INFORMATION. They are bounded separately and counted separately — `handoff/docs/README.md`,
 * "Transport retry is not correction retry" — and the interleaving test below is the one that
 * holds it: a broken reply inside round 2 spends a step attempt and leaves the round count
 * exactly where it was.
 *
 * ## What is fake here, and what is not
 *
 * The producer is a fake: E4's writer is what will really sit in this seam, and the loop is
 * built before it. Everything else is real — the real runner, the real bounded attempts, the
 * real semantic tier reading a real artifact off a real volume, and the real gate. The
 * backend is `createFakeLLM`, the only one `npm test` may reach.
 */

let root: string
let paths: LibraryPaths
let store: Store
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
let harbor: FoundedFixture
let episodeId: string

/** The stage the loop makes: one step, which produces, checks, corrects, and presents. */
const OUTLINE_STAGE = 'write-the-ep02-outline'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-correction-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  episodeId = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'Dry Stores'")!.id

  llm = createFakeLLM()
  const events = createEventLog(store)
  runner = createRunner(store, stages(), events, llm)
  rulings = createRulings(store, events, runner)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/**
 * The fake producer: it writes an outline for Dry Stores, and rewrites it against whatever
 * notes it is handed. One model call per round, through the same bound adapter a real step
 * gets — which is what lets a test assert on the string that went over the wire.
 *
 * `touches` is what decides how many checks convene (4.1). One character in provenance means
 * exactly one check per round, so the scripted replies stay readable.
 */
function outlineWriter(touches: () => string[]): Producer {
  const find = (context: StepContext): Artifact | undefined =>
    artifactsOf(context.store, context.episodeId).find(
      (artifact) => artifact.kind === 'outline' && artifact.slot === '',
    )

  return {
    name: 'write-the-outline',
    find,

    async produce(context, brief): Promise<void> {
      const completion = await context.llm.complete({
        system: 'You write outlines.',
        prompt: [
          'Write the Dry Stores outline.',
          ...correctionNoteLines(brief),
        ].join('\n'),
        maxTokens: 400,
        effort: 'low',
      })

      const filePath = join('greyharbor', 's01e02', `outline-round-${brief.round}.md`)
      const onDisk = join(paths.artifactDir, filePath)
      mkdirSync(dirname(onDisk), { recursive: true })
      // A hand-made asset always wins and re-runs fill gaps only (D20) — the same rule the
      // demo step keeps, and the reason a resumed round costs nothing twice.
      writeIfAbsent(onDisk, `${completion.text.trim()}\n`)

      const standing = find(context)
      if (!standing) {
        recordArtifact(context.store, {
          episodeId: context.episodeId,
          kind: 'outline',
          filePath,
          touches: touches(),
        })
        return
      }
      reviseArtifact(context.store, standing.id, {
        summary: `rewritten against ${brief.findings.length} finding(s)`,
        filePath,
      })
    },
  }
}

function stages(touches: () => string[] = () => [harbor.entity('Ilse Renn').id]): StageCatalogue {
  return {
    [OUTLINE_STAGE]: {
      name: OUTLINE_STAGE,
      steps: [correctionLoop(outlineWriter(touches), checkTextAgainstCanon(paths, 'outline'))],
    },
  }
}

// ── What the fake says, round by round ───────────────────────────────────────────

const FLAWED = 'Ilse Renn signs the exchanger off herself and walks away from the paperwork.'
const CLEAN = 'Ilse Renn files the exchanger fault on the ninth, with the quarterly return.'

const CONCERN =
  'Ilse files the quarterly return on the ninth and would not walk away from paperwork. ' +
  'The outline has her doing the one thing her sheet says she never does.'

/** A finding the character check could really raise about that sentence. */
function theFinding(): string {
  return JSON.stringify({
    findings: [
      {
        quote: 'walks away from the paperwork',
        concern: CONCERN,
        severity: 'medium',
        confidence: 'high',
        entity: 'Ilse Renn',
      },
    ],
  })
}

const NOTHING_FOUND = '{"findings": []}'

/** Round n: the producer's draft, then the tier's answer to it. */
function queueRound(draft: string, answer: string): void {
  llm.reply(draft)
  llm.reply(answer)
}

async function write(): Promise<{ runId: string; report: CorrectionOutcome }> {
  const run = runner.enqueueRun({ episodeId, stage: OUTLINE_STAGE })
  const settled = await runner.settled(run.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? 'the run failed')
  return { runId: run.id, report: reportOf(run.id) }
}

function reportOf(runId: string): CorrectionOutcome {
  const payload = gateStanding(store, openGates(store).find((open) => open.gate.runId === runId)!.gate.id)!
  return payload.rounds.at(-1)!.payload as CorrectionOutcome
}

function stepOf(runId: string): string {
  return findStepByName(store, runId, 'write-the-outline')!.id
}

/** The producer's calls, told apart from the checker's by what only it sends. */
function producerCalls(): string[] {
  return llm.calls
    .filter((call) => call.prompt.startsWith('Write the Dry Stores outline.'))
    .map((call) => call.prompt)
}

describe('a failed check re-runs the producer with the findings as notes', () => {
  it('converges on round 2, and round 2 was written against round 1 findings', async () => {
    queueRound(FLAWED, theFinding())
    queueRound(CLEAN, NOTHING_FOUND)

    const { report } = await write()

    expect(report.rounds.map((round) => [round.round, round.artifactVersion, round.checks])).toEqual(
      [
        [1, 1, 1],
        [2, 2, 1],
      ],
    )
    expect(report.rounds[0]!.findings).toHaveLength(1)
    expect(report.rounds[1]!.findings).toEqual([])
    expect(report).toMatchObject({ converged: true, clean: true })

    // THE POINT: the second draft exists because the first one's findings were handed to
    // the producer. Asserted against what the adapter was really given, not an intention.
    const [first, second] = producerCalls()
    expect(first).not.toContain(CONCERN)
    expect(second).toContain(CONCERN)
    expect(second).toContain('walks away from the paperwork')
    expect(second).toContain('severity medium · confidence high')
    expect(second).toContain('the character check')
  })

  it('keeps every attempt — both drafts on the volume, both readings in the ledger', async () => {
    queueRound(FLAWED, theFinding())
    queueRound(CLEAN, NOTHING_FOUND)

    const { runId } = await write()

    const outline = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'outline')!
    expect(revisionsOf(store, outline.id).map((revision) => revision.version)).toEqual([1, 2])
    expect(existsSync(join(paths.artifactDir, 'greyharbor/s01e02/outline-round-1.md'))).toBe(true)
    expect(existsSync(join(paths.artifactDir, 'greyharbor/s01e02/outline-round-2.md'))).toBe(true)
    expect(
      checkPassesOf(store, outline.id).map((pass) => [pass.artifactVersion, pass.findingCount]),
    ).toEqual([
      [1, 1],
      [2, 0],
    ])

    // And the correction spent no transport budget: one attempt, which ended parked on Ryan.
    expect(attemptsOf(store, stepOf(runId)).map((attempt) => attempt.outcome)).toEqual(['paused'])
  })

  it('presents the whole loop history at the gate, and carries on when Ryan approves', async () => {
    queueRound(FLAWED, theFinding())
    queueRound(CLEAN, NOTHING_FOUND)
    const { runId } = await write()

    const open = openGates(store)[0]!
    expect(open.subject).toBe('the ep02 outline')
    const standing = gateStanding(store, open.gate.id)!
    // The gate renders its artifact; the payload is the history beside it (4.4). Every round
    // says which draft it read, what the producer did to it, and what the checks said.
    expect(standing.rounds[0]!.artifactVersion).toBe(2)
    const payload = standing.rounds[0]!.payload as CorrectionOutcome
    expect(payload.rounds.map((round) => [round.artifactVersion, round.summary])).toEqual([
      [1, 'first version'],
      [2, 'rewritten against 1 finding(s)'],
    ])
    expect(payload.rounds[0]!.findings[0]!.concern).toBe(CONCERN)
    expect(payload.sentence).toContain('read clean')

    rulings.approve(open.gate.id, { comment: 'that reads.' })
    const settled = await runner.settled(runId)

    expect(settled.status).toBe('done')
    // Nothing re-run and nothing re-spent on the way back in: four calls, as before.
    expect(llm.calls).toHaveLength(4)
    const output = findStepByName(store, runId, 'write-the-outline')!.output as CorrectionOutcome
    expect(output).toMatchObject({ verdict: 'approve', gateRound: 1, converged: true })
  })
})

describe('non-convergence is not a failure — it is Ryan’s turn', () => {
  it('stops at three drafts and reaches the gate loud, with every round under it', async () => {
    for (let round = 0; round < MAX_CORRECTION_ROUNDS; round += 1) {
      queueRound(`${FLAWED} (${round + 1})`, theFinding())
    }

    const { runId, report } = await write()

    expect(report.rounds.map((round) => round.findings.length)).toEqual([1, 1, 1])
    expect(report.converged).toBe(false)
    expect(report.sentence).toContain('still has 1 finding(s) after 3 drafts')
    expect(report.sentence).toContain('the correction budget is spent')
    // The loop never blocks the gate — invariant 3 in runner clothes.
    expect(store.get<{ status: string }>('SELECT status FROM run WHERE id = ?', runId)!.status).toBe(
      'paused',
    )
    expect(attemptsOf(store, stepOf(runId)).map((attempt) => attempt.outcome)).toEqual(['paused'])
    // Three drafts, three readings, and no fourth of either.
    expect(producerCalls()).toHaveLength(3)
    expect(llm.calls).toHaveLength(6)
  })

  it('does not render a converged artifact clean when a check could not look (invariant 4)', async () => {
    // Sefa's species is declared unknown (D22), so nothing travels that edge and the check
    // records a gap about her rather than a silence over her.
    const sheet = readFixture().entities.find((entity) => entity.name === 'Sefa Doule')!
    const sefa = harbor.entity('Sefa Doule').id
    const proposal = raiseProposal(store, promotionFromSheet(sheet, sefa, harbor.entities))
    createProposalRulings(store, createEventLog(store)).ratify(proposal.id, { note: 'promote' })
    runner = createRunner(
      store,
      stages(() => [harbor.entity('Ilse Renn').id, sefa]),
      createEventLog(store),
      llm,
    )
    queueRound(CLEAN, NOTHING_FOUND)

    const { report } = await write()

    expect(report.converged).toBe(true)
    expect(report.clean).toBe(false)
    expect(report.rounds[0]!.gaps).toHaveLength(1)
    expect(report.rounds[0]!.gaps[0]!.detail).toContain('Sefa Doule')
    expect(report.sentence).toContain('could not check')
  })
})

describe('a transport failure is not a correction', () => {
  it('spends a step attempt, resumes the round it was in, and leaves the count untouched', async () => {
    queueRound(FLAWED, theFinding())
    // Round 2's draft is written, and then the tier comes back as something nobody can read.
    // The step fails on its own budget; the correction budget is not the one being spent.
    queueRound(CLEAN, 'Certainly! Overall the outline reads well.')
    llm.reply(NOTHING_FOUND)

    const { runId, report } = await write()

    expect(report.rounds.map((round) => round.artifactVersion)).toEqual([1, 2])
    expect(report).toMatchObject({ converged: true, clean: true })
    // One failed attempt, then the one that parked on Ryan — the runner's budget, spent by
    // the runner, visible as the runner's.
    expect(attemptsOf(store, stepOf(runId)).map((attempt) => attempt.outcome)).toEqual([
      'failed',
      'paused',
    ])
    // And the producer was NOT asked again: the second draft was already on the volume and
    // already recorded, so the resumed loop re-read it rather than rewriting it.
    expect(producerCalls()).toHaveLength(2)
    expect(llm.calls).toHaveLength(5)

    const outline = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'outline')!
    // The tier that broke recorded nothing at all, so the resumed round starts from a clean
    // sheet — one pass per version, never one and a half.
    expect(checkPassesOf(store, outline.id).map((pass) => pass.artifactVersion)).toEqual([1, 2])
  })
})

describe('Ryan is not bounded by the correction budget', () => {
  it('rewrites against his notes and checks again, however many rounds he takes', async () => {
    queueRound(FLAWED, theFinding())
    queueRound(CLEAN, NOTHING_FOUND)
    const { runId } = await write()

    // Queued before the ruling: a ruling resumes its run then and there, and the step is
    // already asking for its next answer before `reject` has returned.
    //
    // His rewrite draws a finding of its own, and the machine corrects it — a FOURTH draft,
    // which a budget counted across the artifact's whole life would have refused.
    queueRound(`${CLEAN} But she walks away from the paperwork.`, theFinding())
    queueRound('Ilse Renn files the exchanger fault the same evening.', NOTHING_FOUND)
    rulings.reject(openGates(store)[0]!.gate.id, {
      notes: [{ note: 'She would file it, but not on the ninth. Move it.', depth: 'premise' }],
    })
    await runner.settled(runId)

    const standing = gateStanding(store, openGates(store)[0]!.gate.id)!
    expect(standing.round).toBe(2)
    expect(standing.rounds[0]!.ruling).toMatchObject({ verdict: 'reject' })
    // His note reached the producer verbatim, with its routing depth kept (D21).
    expect(producerCalls()[2]).toContain('She would file it, but not on the ninth.')
    expect(producerCalls()[2]).toContain('premise')
    // Rounds are not capped for Ryan (gate.ts), and his ruling starts the machine's own
    // count over: the correction budget bounds how long it argues unattended, and it is not
    // unattended once he has spoken.
    expect(producerCalls()).toHaveLength(4)
    // Every one of them was one attempt: a correction is not a failure, and the step never
    // spent the runner's budget to make four drafts.
    expect(attemptsOf(store, stepOf(runId)).map((attempt) => attempt.outcome)).toEqual([
      'paused',
      'paused',
    ])
    const payload = standing.rounds[1]!.payload as CorrectionOutcome
    expect(payload.rounds).toHaveLength(4)
    expect(payload.converged).toBe(true)
  })
})

describe('an artifact nothing checks', () => {
  it('is vanilla, not clean, and never loops forever looking for a check', async () => {
    runner = createRunner(store, stages(() => []), createEventLog(store), llm)
    llm.reply(CLEAN)

    const { report } = await write()

    expect(report.rounds).toEqual([])
    expect(report).toMatchObject({ converged: true, clean: false })
    expect(report.sentence).toContain('Nothing checks')
    expect(producerCalls()).toHaveLength(1)
  })
})

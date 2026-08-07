import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, declareProvenance, type Artifact } from '../domain/artifact.ts'
import { factsOfEntity } from '../domain/fact.ts'
import { checkPassesOf, findingsIn, gapsAbout } from '../domain/finding.ts'
import { createProposalRulings, raiseProposal } from '../domain/proposal.ts'
import { scenesOf } from '../domain/spine.ts'
import { createEventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { promotionFromSheet } from '../fixture/load.ts'
import { readFixture } from '../fixture/read.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { attemptsOf, findStepByName } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import {
  textCheckProjection,
  textCheckStages,
  TEXT_CHECK_STAGE,
  type TextCheckReport,
} from './text-check-step.ts'

/**
 * The semantic tier as a step (2.2): compose, call, parse, record — with the money on the
 * step and the answer streamed under the progress line.
 *
 * Every call goes through `createFakeLLM`, the only backend `npm test` may reach. What is
 * proved here is the wiring the domain module cannot prove on its own: that a check is billed
 * where it belongs, that a reply nobody can read FAILS the step rather than filing a clean
 * pass, and that nothing at all is recorded when it does.
 *
 * The real-call path is `npm run smoke:llm` — by hand, by Ryan, documented in the step's own
 * header and never run by CI.
 */

let root: string
let paths: LibraryPaths
let store: Store
let llm: FakeLLM
let runner: Runner
let harbor: FoundedFixture
let episodeId: string
let script: Artifact

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-text-check-step-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  episodeId = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'The Long Pier'")!.id
  script = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'script')!

  llm = createFakeLLM()
  runner = createRunner(store, textCheckStages(paths), createEventLog(store), llm)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/**
 * The six checks The Long Pier's script convenes, in the order the step runs them: five
 * categories by key, then the arc position it declares. Only the world-rules one has anything
 * to say; the other five are the script's controls, and their silence is what gets recorded.
 */
const CHECKS = ['character', 'location', 'species', 'technology', 'world-rules', 'waypoint-drift']

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

/** Five clean answers, the world-rules finding on scene 4, and one clean arc answer. */
function queueTheChecks(): void {
  const clean = { text: '{"findings": []}', usage: { uncachedInput: 9000, output: 120 } }
  llm.reply(clean)
  llm.reply(clean)
  llm.reply(clean)
  llm.reply(clean)
  llm.reply({
    text: JSON.stringify({
      findings: [
        {
          scene: 4,
          quote: 'Tobin comes out onto the pier in his coveralls',
          concern:
            'Three minutes outside the pressure hull in coveralls. The rule names a sealed ' +
            'hardsuit or an active containment field and the scene shows neither.',
          severity: 'high',
          confidence: 'high',
          entity: 'Tobin Wick',
          facts: [factOf('Halvani', 'loses consciousness')],
        },
      ],
    }),
    usage: { uncachedInput: 9400, output: 380 },
  })
  llm.reply(clean)
}

async function check(): Promise<TextCheckReport> {
  const run = runner.enqueueRun({ episodeId, stage: TEXT_CHECK_STAGE })
  const settled = await runner.settled(run.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? 'the run failed')
  return findStepByName(store, run.id, 'check-the-script-against-canon')!.output as TextCheckReport
}

describe('the tier runs whole, and records what each check said', () => {
  it('reads the script once per check and records a pass for every one of them', async () => {
    queueTheChecks()

    const report = await check()

    expect(llm.calls).toHaveLength(6)
    expect(report).toMatchObject({ checks: 6, findings: 1, gaps: 0 })
    // Five silences and one finding, every one of them a row. The four category controls and
    // the arc are what D11's ratio counts as a denominator.
    expect(
      checkPassesOf(store, script.id).map((pass) => [pass.checkKey, pass.tier, pass.findingCount]),
    ).toEqual(CHECKS.map((key) => [key, 'text', key === 'world-rules' ? 1 : 0]))
  })

  it('lands the finding in the script at scene 4, quoting the fact it argues with', async () => {
    queueTheChecks()

    await check()

    const scenes = scenesOf(store, episodeId)
    const [finding] = findingsIn(store, script.id, { sceneId: scenes[3]!.id })
    expect(finding).toMatchObject({
      checkKey: 'world-rules',
      tier: 'text',
      severity: 'high',
      confidence: 'high',
      entityId: harbor.entity('Tobin Wick').id,
    })
    expect(finding!.facts[0]!.statement).toContain('loses consciousness in about nine seconds')
    expect(finding!.anchor.quote).toEqual('Tobin comes out onto the pier in his coveralls')
  })

  it('bills every call against the step, the run, the episode and the show', async () => {
    queueTheChecks()

    await check()

    expect(
      store.get('SELECT COUNT(*) AS n FROM cost_entry WHERE episode_id = ? AND step_id IS NOT NULL', episodeId),
    ).toEqual({ n: 6 })
    expect(
      store.get<{ micro: number }>('SELECT SUM(micro_dollars) AS micro FROM cost_entry')!.micro,
    ).toBeGreaterThan(0)
  })

  it('streams what the model says, rather than spinning (2.3)', async () => {
    queueTheChecks()

    await check()

    expect(
      store.get<{ n: number }>("SELECT COUNT(*) AS n FROM event WHERE kind = 'step-chunk'")!.n,
    ).toBeGreaterThan(0)
  })

  it('states what it will cost before the click, in the words the button says', () => {
    const projection = textCheckProjection(6)

    expect(projection.calls).toEqual(6)
    expect(projection.priced).toEqual('rate-card')
    expect(projection.sentence).toMatch(/^6 Opus calls, ~\$\d/)
  })
})

describe('a reply nobody can read fails the step — it is never a clean pass', () => {
  it('spends the bounded retry, keeps every attempt, and reaches Ryan', async () => {
    // One good answer, then a model that has lost the thread. Three times, because invariant
    // 5 allows one attempt and two retries and no more.
    for (let round = 0; round < 3; round += 1) {
      llm.reply('{"findings": []}')
      llm.reply('Certainly! Overall the script reads well, though scene 4 gave me pause.')
    }

    await expect(check()).rejects.toThrow(/did not come back as a check/)

    const run = store.get<{ id: string }>('SELECT id FROM run ORDER BY rowid DESC LIMIT 1')!.id
    const step = findStepByName(store, run, 'check-the-script-against-canon')!
    expect(attemptsOf(store, step.id).map((attempt) => attempt.outcome)).toEqual([
      'failed',
      'failed',
      'failed',
    ])
    expect(attemptsOf(store, step.id).every((attempt) => attempt.failure !== null)).toBe(true)

    // THE POINT. Not one pass was written — not even for the check that answered cleanly
    // before the broken one. A half-recorded tier would tell D11 that one check fires less
    // often than its sibling, and a zero-finding row here would be a broken check rendered
    // as a green checkmark (invariant 4).
    expect(checkPassesOf(store, script.id)).toEqual([])
  })

  it('refuses a finding that cites canon this check was never handed', async () => {
    const invented = JSON.stringify({
      findings: [
        {
          scene: 4,
          quote: 'Three minutes of it, start to finish.',
          concern: 'quoting a fact nobody loaded',
          severity: 'high',
          confidence: 'high',
          facts: ['fact_deadbeef1234'],
        },
      ],
    })
    for (let round = 0; round < 3; round += 1) {
      for (let before = 0; before < 4; before += 1) llm.reply('{"findings": []}')
      llm.reply(invented)
    }

    await expect(check()).rejects.toThrow(/not one of the facts this check was handed/)
    expect(checkPassesOf(store, script.id)).toEqual([])
  })
})

describe('the honest gap, end to end', () => {
  it('records what it could not check, and says so under the progress line', async () => {
    const sheet = readFixture().entities.find((entity) => entity.name === 'Sefa Doule')!
    const sefa = harbor.entity('Sefa Doule').id
    const proposal = raiseProposal(store, promotionFromSheet(sheet, sefa, harbor.entities))
    createProposalRulings(store, createEventLog(store)).ratify(proposal.id, {
      note: 'Sefa is written into ep01 now',
    })
    declareProvenance(store, script.id, [sefa])
    for (let i = 0; i < 6; i += 1) llm.reply('{"findings": []}')

    const report = await check()

    // Six checks, no findings, six gaps — one per pass, because every one of them was handed
    // the same hole. Zero findings alone would have read as a clean run.
    expect(report).toMatchObject({ checks: 6, findings: 0, gaps: 6 })
    expect(gapsAbout(store, sefa).map((gap) => gap.reason)).toEqual(Array(6).fill('declared-unknown'))
    expect(checkPassesOf(store, script.id).every((pass) => pass.findingCount === 0)).toBe(true)
    expect(checkPassesOf(store, script.id).every((pass) => pass.gapCount === 1)).toBe(true)

    const progress = store.all<{ summary: string }>(
      "SELECT summary FROM event WHERE kind = 'step-progress' ORDER BY seq",
    )
    expect(progress.map((line) => line.summary).join('\n')).toContain('could not check')
  })
})

describe('preconditions before the button', () => {
  it('says so rather than guessing when the episode has no script', async () => {
    const dryStores = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'Dry Stores'")!.id
    const run = runner.enqueueRun({ episodeId: dryStores, stage: TEXT_CHECK_STAGE })

    const settled = await runner.settled(run.id)
    expect(settled.status).toEqual('failed')
    expect(settled.failure).toMatch(/has no script to check/)
    expect(llm.calls).toEqual([])
  })

  it('sends exactly the entities in scope — proved from what the adapter was handed', async () => {
    // Sefa is real, ratified canon in this show, and she is not in this script's provenance.
    const sheet = readFixture().entities.find((entity) => entity.name === 'Sefa Doule')!
    const sefa = harbor.entity('Sefa Doule').id
    const proposal = raiseProposal(store, promotionFromSheet(sheet, sefa, harbor.entities))
    createProposalRulings(store, createEventLog(store)).ratify(proposal.id, { note: 'promote' })
    queueTheChecks()

    await check()

    // Invariant 2 against the string that went over the wire, not against an intention.
    for (const call of llm.calls) {
      expect(call.prompt).not.toContain('Sefa Doule')
      expect(call.prompt).not.toContain('sent by the line office')
      // And the Halvani physiology IS there, on Tobin, because his sheet declares the edge
      // and the character category declares that facts travel it (D22, D23).
      expect(call.prompt).toContain('loses consciousness in about nine seconds')
      expect(call.prompt).toMatch(/loses\s+consciousness[\s\S]{0,200}?\(inherited via species\)/)
    }
  })

  it('reads the script off the volume rather than out of the store', async () => {
    queueTheChecks()

    await check()

    // The prompt carries the file, so a hand edit on the volume is what the next check reads
    // (D2: plain files, human-readable and git-versionable).
    const onDisk = readFileSync(join(paths.artifactDir, script.filePath!), 'utf8')
    expect(llm.calls[0]!.prompt).toContain(onDisk.trim())
  })
})

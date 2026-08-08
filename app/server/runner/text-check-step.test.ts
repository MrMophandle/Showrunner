import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { artifactsOf, declareProvenance, type Artifact } from '../domain/artifact.ts'
import { recordExtractedBoard } from '../domain/board.ts'
import { runBoardRules } from '../domain/board-rules.ts'
import { factsOfEntity } from '../domain/fact.ts'
import { checkPassesOf, findingsIn, gapsAbout } from '../domain/finding.ts'
import { createProposalRulings, raiseProposal } from '../domain/proposal.ts'
import { scenesOf } from '../domain/spine.ts'
import { createEventLog } from '../events.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { promotionFromSheet } from '../fixture/load.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { readFixture } from '../fixture/read.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { createFakeLLM, type FakeLLM } from '../llm/fake.ts'
import { clusterFindings, verdictBoard } from '../domain/panel.ts'
import { attemptsOf, findStepByName } from './run.ts'
import { createRunner, type Runner } from './runner.ts'
import {
  panelProjection,
  textCheckStages,
  TEXT_CHECK_STAGE,
  type TextCheckReport,
} from './text-check-step.ts'

/**
 * The panel as a step (2.2, 4.5): convene, call, parse, record — with the money on the step
 * and the answers streamed under the progress line.
 *
 * Every call goes through `createFakeLLM`, the only backend `npm test` may reach. What is
 * proved here is the wiring the domain modules cannot prove on their own: that every convened
 * reviewer is billed where it belongs, that a reply nobody can read FAILS the step rather than
 * filing a clean pass, that **nothing at all is recorded when it does** — the retry-granularity
 * decision, exercised — and that the board a gate renders comes out whole at the far end.
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
 * The ten reviewers The Long Pier's script convenes, in the order the panel runs them: five
 * categories by key, the arc position it declares, then the four craft reviewers (D13).
 *
 * Only two of them have anything to say. The other eight are the script's controls, and their
 * silence is what gets recorded — it is D11's denominator and it is the fixture's whole point.
 */
const PANEL = [
  'character',
  'location',
  'species',
  'technology',
  'world-rules',
  'waypoint-drift',
  'story-craft',
  'pacing',
  'dialogue',
  'hook',
]

const STEP = 'convene-the-script-panel'

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

const CLEAN = { text: '{"findings": []}', usage: { uncachedInput: 9000, output: 120 } }

/** The world-rules finding on scene 4 — canon quoted, entity named. */
function theCanonFinding(): { text: string; usage: { uncachedInput: number; output: number } } {
  return {
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
  }
}

/** The story-craft finding on the same moment — quoted differently, and citing nothing. */
function theCraftFinding(): { text: string; usage: { uncachedInput: number; output: number } } {
  return {
    text: JSON.stringify({
      findings: [
        {
          scene: 4,
          quote: 'onto the pier in his coveralls and goes down the spar',
          concern:
            'The pier is the only physical risk in the episode and it is set up as routine ' +
            'and paid as routine. Nothing is nearly lost, so the walk costs the story nothing.',
          severity: 'medium',
          confidence: 'medium',
        },
      ],
    }),
    usage: { uncachedInput: 5200, output: 260 },
  }
}

/**
 * Ten answers, in roster order: four clean categories, the world-rules finding, a clean arc
 * answer, the story-craft finding, and three clean craft answers.
 */
function queueThePanel(): void {
  for (let before = 0; before < 4; before += 1) llm.reply(CLEAN)
  llm.reply(theCanonFinding())
  llm.reply(CLEAN)
  llm.reply(theCraftFinding())
  for (let after = 0; after < 3; after += 1) llm.reply(CLEAN)
}

async function check(): Promise<TextCheckReport> {
  const run = runner.enqueueRun({ episodeId, stage: TEXT_CHECK_STAGE })
  const settled = await runner.settled(run.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? 'the run failed')
  return findStepByName(store, run.id, STEP)!.output as TextCheckReport
}

describe('the panel runs whole, and records what each reviewer said', () => {
  it('reads the script once per convened reviewer and records a pass for every one', async () => {
    queueThePanel()

    const report = await check()

    expect(llm.calls).toHaveLength(10)
    expect(report).toMatchObject({ checks: 10, findings: 2, gaps: 0 })
    // Eight silences and two findings, every one of them a row. The controls and the arc are
    // what D11's ratio counts as a denominator.
    expect(
      checkPassesOf(store, script.id).map((pass) => [pass.checkKey, pass.tier, pass.findingCount]),
    ).toEqual(
      PANEL.map((key) => [key, 'text', key === 'world-rules' || key === 'story-craft' ? 1 : 0]),
    )
  })

  it('yields one board row per convened check, over the fixture script', async () => {
    queueThePanel()

    await check()

    const board = verdictBoard(store, script)
    expect(board.rows.map((row) => row.checkKey)).toEqual(PANEL)
    expect(board).toMatchObject({ convened: 10, read: 10, standing: 2, gaps: 0 })
    expect(board.rows.filter((row) => row.verdict === 'found').map((row) => row.checkKey)).toEqual([
      'world-rules',
      'story-craft',
    ])
    // The craft reviewer was handed no canon, and the board says so beside its silence rather
    // than rendering the same zero the category checks earned by reading facts (D13).
    expect(board.rows.find((row) => row.checkKey === 'pacing')).toMatchObject({
      verdict: 'clean',
      scope: 0,
    })
    expect(board.rows.find((row) => row.checkKey === 'character')!.scope).toBeGreaterThan(0)
  })

  it('lands the finding in the script at scene 4, quoting the fact it argues with', async () => {
    queueThePanel()

    await check()

    const scenes = scenesOf(store, episodeId)
    const finding = findingsIn(store, script.id, { sceneId: scenes[3]!.id }).find(
      (one) => one.checkKey === 'world-rules',
    )
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

  it('lands the craft finding beside it with no canon on it at all (D13)', async () => {
    queueThePanel()

    await check()

    const craft = findingsIn(store, script.id).find((one) => one.checkKey === 'story-craft')!
    expect(craft).toMatchObject({ tier: 'text', entityId: null, severity: 'medium' })
    expect(craft.facts).toEqual([])
    // And the prompt it answered carried none either — asserted against the wire.
    const asked = llm.calls[6]!
    expect(asked.prompt).toContain('the story-craft reviewer')
    expect(asked.prompt).not.toContain('fact_')
  })

  it('clusters the two reviewers onto one anchor, quoting the moment differently', async () => {
    queueThePanel()

    await check()

    const clusters = clusterFindings(store, script, readFileSync(join(paths.artifactDir, script.filePath!), 'utf8'))

    // Two reviewers, one moment in scene 4, and neither quote contains the other. A
    // byte-identical anchor key would have made two cards out of one problem.
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.says.map((say) => say.checkKey)).toEqual(['world-rules', 'story-craft'])
    expect(clusters[0]!.says.map((say) => say.quote)).toEqual([
      'Tobin comes out onto the pier in his coveralls',
      'onto the pier in his coveralls and goes down the spar',
    ])
    expect(clusters[0]).toMatchObject({ scene: 4, standing: 2, worstSeverity: 'high' })
    // One carries canon and the other carries none, on one card (D13, invariant 4).
    expect(clusters[0]!.says[0]!.facts[0]).toContain('loses consciousness')
    expect(clusters[0]!.says[1]).toMatchObject({ entityId: null, facts: [], confidence: 'medium' })
  })

  it('bills every call against the step, the run, the episode and the show', async () => {
    queueThePanel()

    await check()

    expect(
      store.get('SELECT COUNT(*) AS n FROM cost_entry WHERE episode_id = ? AND step_id IS NOT NULL', episodeId),
    ).toEqual({ n: 10 })
    expect(
      store.get<{ micro: number }>('SELECT SUM(micro_dollars) AS micro FROM cost_entry')!.micro,
    ).toBeGreaterThan(0)
  })

  it('streams what the model says, rather than spinning (2.3)', async () => {
    queueThePanel()

    await check()

    expect(
      store.get<{ n: number }>("SELECT COUNT(*) AS n FROM event WHERE kind = 'step-chunk'")!.n,
    ).toBeGreaterThan(0)
  })
})

describe('what the button says before Ryan clicks it', () => {
  it('states the whole panel in one sentence, priced off the rate card', () => {
    const projection = panelProjection(store, script)

    expect(projection).toMatchObject({ reviewers: 10, calls: 10, free: 0 })
    expect(projection.cost.priced).toEqual('rate-card')
    expect(projection.sentence).toMatch(/^10 reviewers · 10 Opus calls, ~\$\d/)
  })

  it('says the deterministic rules on the board are free rather than counting them as spend', () => {
    const built = recordExtractedBoard(store, {
      episodeId,
      scriptId: script.id,
      extraction: theLongPierExtraction({
        lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
        halvaniVacuum: factOf('Halvani', 'loses consciousness'),
      }),
    })
    runBoardRules(store, built.artifact.id)

    const projection = panelProjection(store, script)

    expect(projection).toMatchObject({ reviewers: 14, calls: 10, free: 4 })
    expect(projection.sentence).toContain('4 deterministic')
    expect(projection.sentence).toContain('free')
  })

  it('says so rather than summing a zero when the model has no rate card', () => {
    const projection = panelProjection(store, script, { model: 'claude-omega-9' })

    // A gap never renders as a zero (CLAUDE.md, cost.ts). The button states what it cannot
    // say, and "~$0.00" for ten Opus-sized calls would be the exact lie that rule forbids.
    expect(projection.cost.priced).toEqual('unpriced')
    expect(projection.cost.dollars).toEqual(0)
    expect(projection.sentence).toContain('cost unknown')
    expect(projection.sentence).toContain('claude-omega-9 is not in the price table')
    expect(projection.sentence).not.toContain('~$')
  })
})

describe('a reply nobody can read fails the panel — it is never a clean pass', () => {
  it('spends the bounded retry, keeps every attempt, and reaches Ryan', async () => {
    // One good answer, then a model that has lost the thread. Three times, because invariant
    // 5 allows one attempt and two retries and no more.
    for (let round = 0; round < 3; round += 1) {
      llm.reply('{"findings": []}')
      llm.reply('Certainly! Overall the script reads well, though scene 4 gave me pause.')
    }

    await expect(check()).rejects.toThrow(/did not come back as a check/)

    const run = store.get<{ id: string }>('SELECT id FROM run ORDER BY rowid DESC LIMIT 1')!.id
    const step = findStepByName(store, run, STEP)!
    expect(attemptsOf(store, step.id).map((attempt) => attempt.outcome)).toEqual([
      'failed',
      'failed',
      'failed',
    ])
    expect(attemptsOf(store, step.id).every((attempt) => attempt.failure !== null)).toBe(true)

    // THE POINT, and the retry-granularity decision made visible: not one pass was written —
    // not even for the reviewer that answered cleanly before the broken one. A half-recorded
    // panel would put a row on the verdict board for some reviewers and leave others silently
    // absent, which is a broken check rendered as a green checkmark (invariant 4).
    expect(checkPassesOf(store, script.id)).toEqual([])
  })

  it('re-calls every reviewer on the retry, which is what the decision costs', async () => {
    // The bill for atomicity, asserted rather than assumed: nine good answers and one broken
    // one, three times over, is thirty calls for one bad reply. `text-check-step.ts`'s header
    // is where that trade is argued; this is the number it is argued against.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (let before = 0; before < 9; before += 1) llm.reply(CLEAN)
      llm.reply('Happy to help! Here are my thoughts on the hook.')
    }

    await expect(check()).rejects.toThrow(/did not come back as a check/)

    expect(llm.calls).toHaveLength(30)
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
    for (let i = 0; i < 10; i += 1) llm.reply('{"findings": []}')

    const report = await check()

    // Ten reviewers, no findings, six gaps — one per CANON pass, because those six were handed
    // the same hole. Zero findings alone would have read as a clean run. The four craft
    // reviewers record none: they were handed no canon, so there was no scope to fall short of
    // (D13), and inventing a gap for them would be a hole in a scope nobody loaded.
    expect(report).toMatchObject({ checks: 10, findings: 0, gaps: 6 })
    expect(gapsAbout(store, sefa).map((gap) => gap.reason)).toEqual(Array(6).fill('declared-unknown'))
    expect(checkPassesOf(store, script.id).every((pass) => pass.findingCount === 0)).toBe(true)
    expect(
      checkPassesOf(store, script.id).filter((pass) => pass.gapCount === 1).length,
    ).toEqual(6)

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
    queueThePanel()

    await check()

    // Invariant 2 against the string that went over the wire, not against an intention. Not
    // one of the ten prompts carries her, whatever tier it belongs to.
    for (const call of llm.calls) {
      expect(call.prompt).not.toContain('Sefa Doule')
      expect(call.prompt).not.toContain('sent by the line office')
    }
    // And on the six that argue from canon, the Halvani physiology IS there, on Tobin,
    // because his sheet declares the edge and the character category declares that facts
    // travel it (D22, D23). The four craft prompts carry none of it, on purpose (D13).
    for (const call of llm.calls.slice(0, 6)) {
      expect(call.prompt).toContain('loses consciousness in about nine seconds')
      expect(call.prompt).toMatch(/loses\s+consciousness[\s\S]{0,200}?\(inherited via species\)/)
    }
    for (const call of llm.calls.slice(6)) {
      expect(call.prompt).not.toContain('loses consciousness in about nine seconds')
    }
  })

  it('reads the script off the volume rather than out of the store', async () => {
    queueThePanel()

    await check()

    // The prompt carries the file, so a hand edit on the volume is what the next check reads
    // (D2: plain files, human-readable and git-versionable).
    const onDisk = readFileSync(join(paths.artifactDir, script.filePath!), 'utf8')
    expect(llm.calls[0]!.prompt).toContain(onDisk.trim())
  })
})

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkBenchView, CHECK_REFUSALS, type CheckBenchView } from './check-bench.ts'
import type { Store } from './db/store.ts'
import { artifactsOf, declareProvenance, type Artifact } from './domain/artifact.ts'
import { runBoardRules } from './domain/board-rules.ts'
import { recordExtractedBoard } from './domain/board.ts'
import { factsOfEntity } from './domain/fact.ts'
import { dismissFinding, findingsIn } from './domain/finding.ts'
import { createProposalRulings, raiseProposal } from './domain/proposal.ts'
import { scenesOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { promotionFromSheet } from './fixture/load.ts'
import { theLongPierExtraction } from './fixture/long-pier-board.ts'
import { readFixture } from './fixture/read.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { describeLLMBackend, type LLMReadiness } from './llm/choose.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import { launchBlockedBecause } from './operating.ts'
import { applyRewrite, recheckScene } from './remediation.ts'
import { BOARD_CHECK_STAGE, BOARD_STAGE } from './runner/board-step.ts'
import { createRulings, openGates, type Rulings } from './runner/gate.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { SCRIPT_GATE_STAGE } from './runner/script-gate-step.ts'
import { stageCatalogue } from './runner/stages.ts'
import { PREMISE_STAGE } from './runner/write-step.ts'
import { TEXT_CHECK_STAGE } from './runner/text-check-step.ts'

/**
 * The check bench (E3-7) — **what Ryan reads when he asks what the checks said.**
 *
 * Everything below is the fixture's own planted material, read by the real machinery: the
 * continuity board's deterministic rules over the hand-written extraction (free, no model),
 * and the panel over the ep01 script through `createFakeLLM`, which is the only backend
 * `npm test` may reach. Nothing here scripts a finding into the database by hand that a
 * check could have raised — the bench's job is rendering records, and a test that planted
 * its own records would be rendering itself.
 *
 * The HIL contract is what is actually under test: everything pertinent, present, zero
 * archaeology. Each assertion below names the thing Ryan would otherwise have to go and
 * find.
 */

/** A process with a key: something to call. */
const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
/** The container as it booted on Aug 5 2026: no key, no CLI, nothing behind the adapter. */
const NOTHING: LLMReadiness = describeLLMBackend({ PATH: '' })

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let rulings: Rulings
let harbor: FoundedFixture
let episodeId: string
let script: Artifact

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-check-bench-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
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

// ── The kit ─────────────────────────────────────────────────────────────────────

const bench = (llmState: LLMReadiness = READY): CheckBenchView =>
  checkBenchView(store, paths, episodeId, llmState)!

const factOf = (entity: string, needle: string): string => {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

/** The board as the fixture extracted it by hand, and the four rules over it. Free, both. */
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

const CLEAN = { text: '{"findings": []}', usage: { uncachedInput: 9000, output: 120 } }

/** The world-rules finding on scene 4, quoting the Halvani fact it argues with. */
const theCanonFinding = () => ({
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

/** The story-craft finding on the SAME moment, quoted differently and citing nothing (D13). */
const theCraftFinding = () => ({
  text: JSON.stringify({
    findings: [
      {
        scene: 4,
        quote: 'onto the pier in his coveralls and goes down the spar',
        concern:
          'The pier is the only physical risk in the episode and it is paid as routine. ' +
          'Nothing is nearly lost, so the walk costs the story nothing.',
        severity: 'medium',
        confidence: 'medium',
      },
    ],
  }),
  usage: { uncachedInput: 5200, output: 260 },
})

/**
 * One reviewer with three separate complaints about scene 4 — the shape of a check that is
 * about to earn D11's maintenance question. Three spans, so three concerns rather than three
 * firings of one (`domain/concern.ts`).
 */
const theOverEagerCheck = () => ({
  text: JSON.stringify({
    findings: [
      'Tobin comes out onto the pier in his coveralls',
      'At the head, he gets the housing open.',
      'Three minutes of it, start to finish.',
    ].map((quote) => ({
      scene: 4,
      quote,
      concern: `Unprotected outside the hull: “${quote}”`,
      severity: 'high',
      confidence: 'high',
      entity: 'Tobin Wick',
      facts: [factOf('Halvani', 'loses consciousness')],
    })),
  }),
  usage: { uncachedInput: 9400, output: 900 },
})

/** Ten answers in roster order: four clean, world-rules, the arc, story-craft, three clean. */
function queueThePanel(): void {
  for (let before = 0; before < 4; before += 1) llm.reply(CLEAN)
  llm.reply(theCanonFinding())
  llm.reply(CLEAN)
  llm.reply(theCraftFinding())
  for (let after = 0; after < 3; after += 1) llm.reply(CLEAN)
}

async function run(stage: string): Promise<void> {
  const started = runner.enqueueRun({ episodeId, stage })
  const settled = await runner.settled(started.id)
  if (settled.status === 'failed') throw new Error(settled.failure ?? `${stage} failed`)
}

/** Board rules and panel, which is the state the drill reaches after its first two clicks. */
async function bothTiers(): Promise<void> {
  theBoard()
  queueThePanel()
  await run(TEXT_CHECK_STAGE)
}

const findingOf = (checkKey: string): string =>
  findingsIn(store, script.id).find((finding) => finding.checkKey === checkKey)!.id

// ── The buttons ─────────────────────────────────────────────────────────────────

describe('the check bench — the buttons that read', () => {
  it('offers one per stage whose work is reading, each stating verb, object, scope and cost', () => {
    const runs = bench().runs

    // The catalogue filtered by DECLARATION, never by a list of names here — the premise
    // stage produces, so it is not on this bench at all.
    expect(runs.map((one) => one.stage)).toEqual([
      BOARD_STAGE,
      BOARD_CHECK_STAGE,
      TEXT_CHECK_STAGE,
      SCRIPT_GATE_STAGE,
    ])
    for (const one of runs) {
      expect(one.offer.sentence).not.toMatch(/^(Launch|Run|Go|Do|Start)\b/)
      expect(one.offer.cost).not.toBe('')
    }
  })

  it('states the panel’s projected cost, and what the panel is made of, before the click', () => {
    const panel = bench().runs.find((one) => one.stage === TEXT_CHECK_STAGE)!.offer

    // The roster in the words 4.5 convenes it with: five categories, the arc position ep01
    // declares (D8), and the four craft reviewers (D13).
    expect(panel.sentence).toContain('Check the ep01 script v1')
    expect(panel.sentence).toContain('5 category checks, 1 arc position and 4 craft reviewers')
    expect(panel.sentence).toMatch(/10 reviewers · 10 Opus calls, ~\$\d+\.\d\d/)
    // Whose money, and when — E3-4's projection with E3-7's tail on it.
    expect(panel.cost).toMatch(/^10 Opus calls, ~\$\d+\.\d\d · your money, spent when you click$/)
    expect(panel.enabled).toBe(true)
  })

  it('prices the free tier at nothing and says so, rather than leaving it to be inferred', () => {
    theBoard()

    const free = bench().runs.find((one) => one.stage === BOARD_CHECK_STAGE)!.offer

    expect(free.sentence).toContain('Re-run the 4 deterministic rules over the ep01 continuity board')
    expect(free.sentence).toContain('read no script')
    expect(free.cost).toBe('No model call · $0.00')
    // The tail belongs to a call. A free stage that said "spent when you click" would be
    // charging Ryan for a reading of rows.
    expect(free.cost).not.toContain('your money')
  })

  it('refuses the free tier in words when there is no board for it to read', () => {
    const free = bench().runs.find((one) => one.stage === BOARD_CHECK_STAGE)!.offer

    expect(free.enabled).toBe(false)
    expect(free.blockedBecause).toContain('ep01 has no continuity board yet')
    expect(free.blockedBecause).toContain('Build the board first')
    // And the API refuses with the same string. One composer, and they cannot drift.
    expect(launchBlockedBecause(store, READY, episodeId, stageCatalogue(paths)[BOARD_CHECK_STAGE]!)).toBe(
      free.blockedBecause,
    )
  })
})

// ── The done-condition E3-1 deferred ────────────────────────────────────────────

describe('a stage declares what it spends, and a free one runs on nothing', () => {
  it('offers the free re-check on a process with NO backend configured at all', () => {
    theBoard()

    const offers = bench(NOTHING).runs

    // The defect E3-1 found: this stage calls no model, and until it could say so the
    // refusal turned "Nothing to call" on a stage that calls nothing.
    const free = offers.find((one) => one.stage === BOARD_CHECK_STAGE)!.offer
    expect(free.enabled).toBe(true)
    expect(free.blockedBecause).toBeNull()

    // Its paid sibling beside it is refused, with the adapter's own sentence — which is what
    // makes this a declaration rather than an exemption.
    const paid = offers.find((one) => one.stage === BOARD_STAGE)!.offer
    expect(paid.enabled).toBe(false)
    expect(paid.blockedBecause).toContain('Nothing to call')
    expect(paid.blockedBecause).toContain('no `claude` executable on PATH')
  })

  it('RUNS the free re-check with no backend, and calls nothing doing it', async () => {
    theBoard()
    // A runner over an adapter with no answers queued: `createFakeLLM` throws if anything
    // asks it for one, so a single call anywhere in this stage fails the test loudly.
    const barren = createFakeLLM()
    runner = createRunner(store, stageCatalogue(paths), events, barren)

    await run(BOARD_CHECK_STAGE)

    expect(barren.calls).toEqual([])
    // Four rules ran again over the same rows, and every one of them recorded a pass —
    // including the two the script obeys (0010). Eight rows: the tier, twice.
    expect(
      store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM check_pass WHERE tier = 'deterministic'",
      )!.n,
    ).toBe(8)
    // And nothing reached the ledger, because nothing reached a model.
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_entry')!.n).toBe(0)
  })

  it('gives the gate stage the same freedom, because a gate spends nothing either', () => {
    const gate = bench(NOTHING).runs.find((one) => one.stage === SCRIPT_GATE_STAGE)!.offer

    expect(gate.enabled).toBe(true)
    expect(gate.cost).toBe('No model call · $0.00')
  })
})

// ── The records, rendered ───────────────────────────────────────────────────────

describe('the check bench — the artifact, with the findings at their spans', () => {
  it('renders the script itself, never a filename (D15)', async () => {
    await bothTiers()

    const view = bench()
    expect(view.artifact.text).toBe(
      readFileSync(join(paths.artifactDir, script.filePath!), 'utf8'),
    )
    expect(view.artifact.note).toBeNull()
    expect(view.version).toBe(1)
  })

  it('anchors every card at a span that is really in the draft, in document order', async () => {
    await bothTiers()

    const view = bench()
    const text = view.artifact.text!
    expect(view.clusters.length).toBeGreaterThan(0)

    for (const cluster of view.clusters) {
      if (cluster.quote === '') continue
      // The gate-room shape: the card sits where the words it argues with sit, so the page
      // can render the script and put the argument under the line.
      expect(text.slice(cluster.from, cluster.to)).toBe(cluster.quote)
    }
    const starts = view.clusters.map((cluster) => cluster.from)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
  })

  it('puts every reviewer that argued with one moment on ONE card (4.5)', async () => {
    await bothTiers()

    // Two reviewers read the same beat of scene 4 and quoted it differently — one took the
    // sentence, one took the clause inside it. Clustering is by overlap, so they share a card.
    const card = bench().clusters.find((cluster) => cluster.says.length > 1)!
    expect(card.scene).toBe(4)
    expect(card.says.map((say) => say.checkKey).sort()).toEqual(['story-craft', 'world-rules'])
    expect(card.standing).toBe(2)
    expect(card.worstSeverity).toBe('high')
  })

  it('keeps severity and confidence as two values on every say (invariant 4)', async () => {
    await bothTiers()

    const says = bench().clusters.flatMap((cluster) => cluster.says)
    const world = says.find((say) => say.checkKey === 'world-rules')!
    expect([world.severity, world.confidence]).toEqual(['high', 'high'])
    expect(world.sentence).toBe(
      'world-rules · severity high · confidence high · text, a reading',
    )

    const dual = says.find((say) => say.checkKey === 'dual-presence')!
    expect([dual.severity, dual.confidence]).toEqual(['high', 'certain'])
    // `certain` is the deterministic tier's word and the sentence says which tier said it.
    expect(dual.sentence).toContain('deterministic, from the rows')
  })

  it('quotes the Halvani fact the semantic finding argues with', async () => {
    await bothTiers()

    const world = bench()
      .clusters.flatMap((cluster) => cluster.says)
      .find((say) => say.checkKey === 'world-rules')!
    expect(world.facts).toHaveLength(1)
    expect(world.facts[0]).toContain('loses consciousness in about nine seconds')
    // The craft reviewer beside it was handed no canon at all, and cites none (D13).
    const craft = bench()
      .clusters.flatMap((cluster) => cluster.says)
      .find((say) => say.checkKey === 'story-craft')!
    expect(craft.facts).toEqual([])
  })
})

// ── D12, on the bench ───────────────────────────────────────────────────────────

describe('the check bench — the wall, and what it marks', () => {
  it('marks the deterministic findings stage-blocking and says they never reach the gate', async () => {
    await bothTiers()

    const says = bench().clusters.flatMap((cluster) => cluster.says)
    expect(says.filter((say) => say.blocking).map((say) => say.checkKey).sort()).toEqual([
      'dual-presence',
      'vacuum-without-protection',
    ])
    expect(says.find((say) => say.checkKey === 'dual-presence')!.blockingSentence).toContain(
      'Blocks the next stage until it is resolved, and never this gate (D12)',
    )
    // A text finding argues and never vetoes (invariant 3) — no mark, no sentence.
    const world = says.find((say) => say.checkKey === 'world-rules')!
    expect(world.blocking).toBe(false)
    expect(world.blockingSentence).toBeNull()
  })

  it('carries the wall’s sentence — the same string the next-stage button is refused with', async () => {
    await bothTiers()

    const view = bench()
    expect(view.wall).toContain('ep01 is blocked')
    expect(view.wall).toContain('vacuum-without-protection')
    expect(view.wall).toContain('scene 4 of the ep01 script')
    // One composer, two readers — and on ep01 the producing stage does not reach the wall at
    // all: the premise stage is refused for having nothing to do (the fixture wrote ep01's
    // premise by hand) before the wall is consulted, which is the order `operating.ts` argues
    // for. The wall refusing a producer with this exact string is asserted on ep02, where the
    // premise stage still has something to write (`operating.test.ts`).
    expect(launchBlockedBecause(store, READY, episodeId, stageCatalogue(paths)[PREMISE_STAGE]!)).toContain(
      'already has a premise-brief',
    )
  })

  it('does not wall the stages that READ, which is how the wall’s own advice stays true', async () => {
    await bothTiers()

    // The wall's sentence ends "fix it and re-run the checks — the deterministic ones cost
    // nothing". A wall that refused that button would be a dead end built out of its advice.
    const refusals = bench()
      .runs.map((one) => one.offer.blockedBecause)
      .filter((because) => because !== null)
    expect(refusals).toEqual([])
    expect(bench().runs.every((one) => one.offer.enabled)).toBe(true)
  })
})

// ── The three kinds of nothing ──────────────────────────────────────────────────

describe('the check bench — the silences, told apart', () => {
  it('renders the obeyed hull rules as loaded-and-un-cited, which is a measurement', async () => {
    await bothTiers()

    const world = bench().rows.find((one) => one.row.checkKey === 'world-rules')!
    // The check fired once, about rule 1. Rules 2 and 3 were in front of it and it left them
    // alone — that is the fixture's control, and the bench says so by NAME rather than as a
    // count Ryan would have to go and reconstruct.
    const uncited = world.scope.filter((fact) => !fact.cited).map((fact) => fact.statement)
    expect(world.scope.some((fact) => fact.cited)).toBe(true)
    expect(uncited.join(' ')).toContain('Sound does not carry outside the hull')
    expect(uncited.join(' ')).toContain('no tide')

    // And the two board rules the script obeys are green rows rather than absent ones (0010).
    const quiet = bench().rows.filter(
      (one) => one.row.tier === 'deterministic' && one.row.verdict === 'clean',
    )
    expect(quiet.map((one) => one.row.checkKey).sort()).toEqual([
      'duplicate-arrival',
      'impossible-adjacency',
    ])
  })

  it('shows what could not be checked at all, and never folds it into a silence (0012)', async () => {
    const sheet = readFixture().entities.find((entity) => entity.name === 'Sefa Doule')!
    const sefa = harbor.entity('Sefa Doule').id
    const proposal = raiseProposal(store, promotionFromSheet(sheet, sefa, harbor.entities))
    createProposalRulings(store, events).ratify(proposal.id, { note: 'written into ep01 now' })
    declareProvenance(store, script.id, [sefa])
    for (let reviewer = 0; reviewer < 10; reviewer += 1) llm.reply(CLEAN)
    await run(TEXT_CHECK_STAGE)

    const view = bench()
    expect(view.gaps).toHaveLength(6)
    expect(view.gaps[0]!.reason).toBe('declared-unknown')
    expect(view.gaps.map((gap) => gap.detail).join(' ')).toContain('Sefa Doule')

    // Zero findings AND a gap is not a clean run. The row says which of the two it is, and
    // what would answer it — no rewrite would.
    const gapped = view.rows.find((one) => one.row.verdict === 'gapped')!
    expect(gapped.row.what).toContain('could not check at all')
    expect(gapped.fix).toContain('canon has not decided them')
  })

  it('says a convened reviewer has not read this draft rather than counting it clean', () => {
    theBoard()

    // Nothing has convened the panel, so ten rows say `unread` — a check that has not run is
    // not a check that found nothing.
    const view = bench()
    const unread = view.rows.filter((one) => one.row.verdict === 'unread')
    expect(unread).toHaveLength(10)
    expect(unread[0]!.row.what).toBe('has not read this draft')
    expect(unread[0]!.fix).toContain('Convene the panel over this draft')
    expect(unread[0]!.scope).toEqual([])
  })
})

// ── The board's other two verdicts ──────────────────────────────────────────────

describe('the check bench — partial and stale, each with its fix named', () => {
  it('renders the board rows stale after a rewrite, and names re-extraction as the fix', async () => {
    await bothTiers()
    applyRewrite(store, paths, {
      findingId: findingOf('world-rules'),
      replacement: 'Tobin comes out onto the pier in a hardsuit',
    })

    const view = bench()
    expect(view.version).toBe(2)
    const stale = view.rows.filter((one) => one.row.verdict === 'stale')
    expect(stale.length).toBeGreaterThan(0)
    // The version it was computed from is on the row, put there by the module that knows it.
    expect(stale[0]!.row.what).toContain('re-run the board rules, they cost nothing')
    expect(stale[0]!.fix).toContain('built out of a draft the script has moved past')
    expect(stale[0]!.fix).toContain('reading the new draft into a fresh board')
  })

  it('renders a scene-scoped reading as partial, and says what the reviewer has not read', async () => {
    await bothTiers()
    applyRewrite(store, paths, {
      findingId: findingOf('world-rules'),
      replacement: 'Tobin comes out onto the pier in a hardsuit',
    })
    // D14's paid half: one scene, one reviewer, one call — the reviewer that argued with it.
    const scene4 = scenesOf(store, episodeId)[3]!
    const owed = bench().rechecks
    // Both reviewers that argued with scene 4 — and only those two, out of a roster of ten.
    // That narrowing is the whole of D14, and the button states it before the click.
    expect(owed.map((one) => one.scene)).toEqual([4])
    expect(owed[0]!.offer.sentence).toContain(
      'Re-read scene 4 of the script with the 2 reviewers that argued with it',
    )
    expect(owed[0]!.offer.cost).toContain('your money, spent when you click')

    llm.reply(CLEAN)
    llm.reply(CLEAN)
    await recheckScene(store, llm, paths, { artifactId: script.id, sceneId: scene4.id })

    const partial = bench().rows.find((one) => one.row.checkKey === 'world-rules')!
    expect(partial.row.verdict).toBe('partial')
    expect(partial.row.what).toContain('read scene 4 of this draft and found nothing there')
    expect(partial.fix).toContain('The rest of this draft it has not read')
    // And the board says it above the rows, so a clean panel and a narrowed one never look alike.
    expect(bench().board.sentence).toContain('read only the scene that was rewritten')
  })
})

// ── The three buttons behind a finding (4.3) ────────────────────────────────────

describe('the check bench — the remediations, priced and refused in words', () => {
  it('prices the rewrite off the rate card and the other two at nothing, said so', async () => {
    await bothTiers()

    const say = bench()
      .clusters.flatMap((cluster) => cluster.says)
      .find((one) => one.checkKey === 'world-rules')!

    expect(say.remediations.predraft.sentence).toContain(
      'Pre-draft a rewrite of the world-rules span in scene 4 of the ep01 script',
    )
    // D14 is why it is cents: one span, one scene, one call — not the episode.
    expect(say.remediations.predraft.cost).toMatch(
      /^1 Opus call, ~\$0\.\d\d · your money, spent when you click$/,
    )
    expect(say.remediations.apply.cost).toBe('No model call · $0.00')
    expect(say.remediations.propose.cost).toBe('No model call · $0.00')
    expect(say.remediations.dismiss.cost).toBe('No model call · $0.00')
    expect(
      [say.remediations.predraft, say.remediations.apply, say.remediations.dismiss].every(
        (offer) => offer.enabled,
      ),
    ).toBe(true)
  })

  it('refuses a rewrite of a finding that lands on no span, in words, before the click', async () => {
    await bothTiers()

    // The board rules anchor at the scene HEADING, which is a real span; the canon-graph
    // checks are the ones about provenance rather than about a sentence. Here the deterministic
    // finding's own span is what matters: it is quotable, so what refuses is the propose
    // button — a rule that reads rows quotes no canon fact, so there is no before for a delta.
    const dual = bench()
      .clusters.flatMap((cluster) => cluster.says)
      .find((one) => one.checkKey === 'dual-presence')!
    expect(dual.remediations.propose.enabled).toBe(false)
    expect(dual.remediations.propose.blockedBecause).toContain('quotes no canon fact')
    expect(dual.remediations.propose.blockedBecause).toContain('register the claim at the canon bench')
  })

  it('refuses every remediation on a finding already put down, quoting the note back', async () => {
    await bothTiers()
    dismissFinding(store, findingOf('world-rules'), 'the collars are a season-2 problem')

    const say = bench()
      .clusters.flatMap((cluster) => cluster.says)
      .find((one) => one.checkKey === 'world-rules')!

    expect(say.status).toBe('dismissed')
    expect(say.dismissal!.note).toBe('the collars are a season-2 problem')
    for (const offer of [
      say.remediations.predraft,
      say.remediations.apply,
      say.remediations.propose,
      say.remediations.dismiss,
    ]) {
      expect(offer.enabled).toBe(false)
      expect(offer.blockedBecause).toContain('already dismissed')
      expect(offer.blockedBecause).toContain('the collars are a season-2 problem')
    }
  })

  it('hands down the three refusals that live in a field the server never sees', () => {
    expect(CHECK_REFUSALS.dismissNeedsNote).toContain('Dismissing a finding takes a note')
    expect(CHECK_REFUSALS.rewriteNeedsReplacement).toContain('word for word')
    expect(CHECK_REFUSALS.changeNeedsStatement).toContain('a before AND an after')
    expect(bench().refusals).toEqual(CHECK_REFUSALS)
  })
})

// ── E3-6, closed on screen ──────────────────────────────────────────────────────

describe('the check bench — a standing dismissal, and the twin it reaches', () => {
  it('names the ruling that is holding the wall down over an open twin', async () => {
    await bothTiers()
    dismissFinding(store, findingOf('dual-presence'), 'scene 6 is a flash-forward; leave it')
    dismissFinding(store, findingOf('vacuum-without-protection'), 'he is suited in the rewrite')
    expect(bench().wall).toBeNull()

    // A rewrite SOMEWHERE ELSE re-runs the free tier over rows nobody touched, so identical
    // twins of both concerns come back open at v2 (E3-5's one motion).
    applyRewrite(store, paths, {
      findingId: findingOf('world-rules'),
      replacement: 'Tobin comes out onto the pier in a hardsuit',
    })

    const says = bench().clusters.flatMap((cluster) => cluster.says)
    const twin = says.find((say) => say.checkKey === 'dual-presence')!
    expect(twin.status).toBe('open')
    expect(twin.inherited).not.toBeNull()
    expect(twin.inherited!.note).toBe('scene 6 is a flash-forward; leave it')
    expect(twin.inherited!.sentence).toContain('You put this exact concern down at v1')
    expect(twin.inherited!.sentence).toContain('does not do is put the wall back up')

    // Which is the point: the wall Ryan brought down stays down, with nothing written to
    // unblock anything.
    expect(bench().wall).toBeNull()
    expect(twin.blocking).toBe(false)
  })

  /**
   * The same mechanism reached by the click the drill actually uses. E3-5's one-motion apply
   * re-runs this tier on every rewrite; pressing the free stage does the same thing directly,
   * for nothing, which is why it is the reproducible way to watch a standing ruling work.
   */
  it('holds the wall down when the FREE stage re-raises the twins by itself', async () => {
    theBoard()
    dismissFinding(store, findingOf('dual-presence'), 'scene 6 is a flash-forward; leave it')
    dismissFinding(store, findingOf('vacuum-without-protection'), 'suited in the pickup')
    expect(bench().wall).toBeNull()

    await run(BOARD_CHECK_STAGE)

    // Both concerns fired again, at no cost, over rows nobody touched. They are open, they
    // count in D11's denominator, and the wall Ryan brought down stays down.
    const says = bench().clusters.flatMap((cluster) => cluster.says)
    const twins = says.filter((say) => say.status === 'open')
    expect(twins.map((say) => say.checkKey).sort()).toEqual([
      'dual-presence',
      'vacuum-without-protection',
    ])
    expect(twins.every((say) => say.inherited !== null)).toBe(true)
    expect(twins.every((say) => !say.blocking)).toBe(true)
    expect(bench().wall).toBeNull()

    // Counted, not hidden: each check now shows two firings over one concern.
    for (const key of ['dual-presence', 'vacuum-without-protection']) {
      const record = bench().record.find((one) => one.checkKey === key)!
      expect([record.firings, record.concerns.length, record.dismissed]).toEqual([2, 1, 1])
    }
  })

  it('lands the dismissals on the cried-wolf record, and asks the maintenance question', async () => {
    // Three concerns from one reviewer, at three different spans of scene 4 — three concerns
    // and not three firings of one, because identity is the span as well as the words.
    theBoard()
    for (let before = 0; before < 4; before += 1) llm.reply(CLEAN)
    llm.reply(theOverEagerCheck())
    for (let after = 0; after < 5; after += 1) llm.reply(CLEAN)
    await run(TEXT_CHECK_STAGE)

    // The floor is three ruled concerns, because two is a coincidence and one is an anecdote,
    // and the majority test is what makes it worth asking at all (D11).
    for (const finding of findingsIn(store, script.id).filter((one) => one.checkKey === 'world-rules')) {
      dismissFinding(store, finding.id, 'the rule is over-broad about coveralls')
    }

    const view = bench()
    expect(view.tune).toHaveLength(1)
    expect(view.tune[0]).toContain('world-rules — you have put down 3 of its last 3 ruled concerns')
    expect(view.tune[0]).toContain('3 dismissed with a note, against 0 confirmed by a rewrite')
    expect(view.tune[0]).toContain('Tune this check?')

    // Nothing acted on it. Every check that read is still on the record, including the ones
    // that never fired — a control that fires at nothing belongs here with its silences on it.
    const quiet = view.record.find((one) => one.checkKey === 'impossible-adjacency')!
    expect(quiet.tune).toBeNull()
    expect(quiet.readings).toBeGreaterThan(0)
    expect(quiet.silent).toBe(quiet.readings)
  })
})

// ── The wall's three doors ──────────────────────────────────────────────────────

describe('the check bench — the wall comes down three ways, and nothing writes an unblock', () => {
  it('falls to an override at the gate, recorded as itself forever', async () => {
    await bothTiers()
    await run(SCRIPT_GATE_STAGE)

    const view = bench()
    expect(view.gateRunId).not.toBeNull()
    expect(view.wall).toContain('ep01 is blocked')

    // The gate is open and the wall never reached it — checks argue, they never veto.
    const gate = openGates(store)[0]!.gate
    rulings.override(gate.id, { comment: 'shooting it as written; the collar is in the pickup' })

    expect(bench().wall).toBeNull()
    // Nothing was written to any finding: they are still open, and still exactly what the
    // checks said at that version (0010).
    expect(
      findingsIn(store, script.id).filter((one) => one.tier === 'deterministic').every(
        (one) => one.status === 'open',
      ),
    ).toBe(true)
    expect(
      store.get<{ verdict: string }>('SELECT verdict FROM gate_ruling LIMIT 1')!.verdict,
    ).toBe('override')
  })

  /**
   * The drill's sharpest moment, and the reason an override is recorded against a VERSION.
   * He approved over the draft in front of him; the next draft is not that draft, and a
   * licence that ran forward would be a permanent pass on work he has never seen.
   */
  it('does not carry an override forward past the rewrite that followed it', async () => {
    await bothTiers()
    await run(SCRIPT_GATE_STAGE)
    rulings.override(openGates(store)[0]!.gate.id, { comment: 'shooting it as written' })
    expect(bench().wall).toBeNull()

    // A rewrite anywhere lands v2 and re-runs the free tier over it in the same motion, so
    // twins of both concerns stand against a draft nobody has ruled on.
    applyRewrite(store, paths, {
      findingId: findingOf('world-rules'),
      replacement: 'Tobin comes out onto the pier in a hardsuit',
    })

    expect(bench().version).toBe(2)
    expect(bench().wall).toContain('ep01 is blocked')
    const blocking = bench()
      .clusters.flatMap((cluster) => cluster.says)
      .filter((say) => say.blocking)
    expect(blocking.map((say) => say.checkKey).sort()).toEqual([
      'dual-presence',
      'vacuum-without-protection',
    ])
    // And no dismissal exists to hold it down — that is step 7's door, not this one.
    expect(blocking.every((say) => say.inherited === null)).toBe(true)
  })

  it('falls to a dismissal with a note, with no unblocking write anywhere', async () => {
    await bothTiers()
    const before = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM finding')!.n

    dismissFinding(store, findingOf('dual-presence'), 'scene 6 is a flash-forward; leave it')
    expect(bench().wall).toContain('vacuum-without-protection')
    dismissFinding(store, findingOf('vacuum-without-protection'), 'suited in the pickup')

    expect(bench().wall).toBeNull()
    // Two disposition rows, and not one finding row touched — status is derived (0010).
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM finding')!.n).toBe(before)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM finding_disposition')!.n).toBe(2)
  })
})

// ── An episode with nothing to check ────────────────────────────────────────────

describe('the check bench — an episode with no artifact at its boundary', () => {
  it('says what to do rather than rendering an empty board', () => {
    const ep02 = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'Dry Stores'")!.id

    const view = checkBenchView(store, paths, ep02, READY)!
    expect(view.emptyBecause).toContain('ep02 has no script to check')
    expect(view.emptyBecause).toContain('Checks fire at artifact boundaries')
    expect(view.clusters).toEqual([])
    expect(view.runs.every((one) => one.offer.enabled)).toBe(false)
  })

  it('is undefined for an episode that is not in this library', () => {
    expect(checkBenchView(store, paths, 'ep_nope', READY)).toBeUndefined()
  })
})

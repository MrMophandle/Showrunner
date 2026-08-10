import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonBenchView,
  registerAndPropose,
  type CanonBenchView,
} from '../server/canon-bench.ts'
import { checkBenchView, type CheckBenchView } from '../server/check-bench.ts'
import type { Store } from '../server/db/store.ts'
import { artifactsOf } from '../server/domain/artifact.ts'
import { runBoardRules } from '../server/domain/board-rules.ts'
import { recordExtractedBoard } from '../server/domain/board.ts'
import { findEntity } from '../server/domain/canon.ts'
import { factsOfEntity } from '../server/domain/fact.ts'
import { createProposalRulings, raiseProposal } from '../server/domain/proposal.ts'
import { episodesOf, seasonsOf } from '../server/domain/spine.ts'
import { createEventLog, eventsOfRun, type EventLog } from '../server/events.ts'
import { greyHarborFounded } from '../server/fixture/founded.ts'
import { theLongPierExtraction } from '../server/fixture/long-pier-board.ts'
import { loadFixture } from '../server/fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../server/library.ts'
import { describeLLMBackend, type LLMReadiness } from '../server/llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../server/llm/fake.ts'
import { operatingView, runView } from '../server/operating.ts'
import { openGates } from '../server/runner/gate.ts'
import { createRunner, type Runner } from '../server/runner/runner.ts'
import { SCRIPT_GATE_STAGE } from '../server/runner/present-step.ts'
import { stageCatalogue } from '../server/runner/stages.ts'
import { PREMISE_STAGE } from '../server/runner/write-step.ts'
import { TEXT_CHECK_STAGE } from '../server/runner/text-check-step.ts'
import { sweepView, type SweepView } from '../server/sweep.ts'
import { App, Page } from './App.tsx'
import { EMPTY_BENCH, type BenchDraft } from './CanonBench.tsx'
import { EMPTY_CHECK_DRAFT, type CheckDraft } from './CheckBench.tsx'
import { EMPTY_SWEEP, type SweepDraft } from './Sweep.tsx'

/**
 * The page, rendered — with the real view objects the server composes, off a real library
 * volume with the fixture in it.
 *
 * It renders to a string rather than to a browser because there is nothing here worth a
 * DOM: no interaction, no layout, no design (that is E5's, to the mockups). What must be
 * true is that the sentences the server wrote actually reach the page, that the gate
 * shows the artifact rather than its filename, and that a blocked button is disabled with
 * its reason beside it.
 */

/** A process with a key: something to call. */
const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
/** The container as it booted on Aug 5 2026: no key, no CLI, nothing behind the adapter. */
const NOTHING: LLMReadiness = describeLLMBackend({ PATH: '' })

const WRITTEN = 'Three weeks after the harbourmaster took the spare, the water plant gives out.'

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let llm: FakeLLM
let runner: Runner
let ep02: string
let showId: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-page-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  loadFixture(store, paths)
  events = createEventLog(store)
  llm = createFakeLLM()
  runner = createRunner(store, stageCatalogue(paths), events, llm)

  const show = store.get<{ id: string }>("SELECT id FROM show WHERE key = 'greyharbor'")!
  showId = show.id
  ep02 = episodesOf(store, seasonsOf(store, show.id)[0]!.id).find((e) => e.number === 2)!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/**
 * One whole round of the premise stage: the draft, then the panel it convenes. The fixture
 * is LOADED and not founded here, so nobody has standing yet, the desk hands the writer no
 * canon, and the panel is the two craft reviewers a premise-brief is read by (D13).
 */
function queueThePremise(text: string = WRITTEN): void {
  llm.reply(text)
  llm.reply('{"findings": []}')
  llm.reply('{"findings": []}')
}

describe('the operating page — before the API answers', () => {
  it('says so, rather than drawing an empty floor', () => {
    const html = renderToString(<App />)

    expect(html).toContain('Showrunner')
    expect(html).toContain('The API has not answered yet.')
    // Nothing runs without a click, and a first render is not a click: there is no launch
    // button at all until the server has said what may be launched and what it will cost.
    expect(html).not.toContain('<button')
  })
})

describe('the operating page — the floor of it', () => {
  it('renders the adapter, the episodes, and a button that states its cost', () => {
    const html = render(operatingView(store, paths, READY))

    // The floor's first tile, in words.
    expect(html).toContain('Anthropic API')
    expect(html).toContain('ready')

    // Both fixture episodes, each on its own lifecycle position.
    expect(html).toContain('The Long Pier')
    expect(html).toContain('Dry Stores')
    expect(html).toContain('<strong>[script]</strong>')
    expect(html).toContain('<strong>[premise]</strong>')

    // Verb + object + scope, and the cost stated before the click. Each card offers the stage
    // its own lifecycle is at (E4-3, `stageForEpisode`), so the two cards offer two stages.
    expect(html).toContain('Write the ep02 premise-brief from the writer’s desk')
    expect(html).toContain('Write the ep01 script from the writer’s desk')
    expect(html).toContain('your money, spent when you click')
    // ep01 already has a script, so its button is disabled with the reason in words — a
    // blocked action never fails after the click (D15).
    expect(html).toContain('Blocked:')
    expect(html).toContain('ep01 already has a script')
  })

  it('disables the button and prints the reason when nothing can reach a model', () => {
    const html = render(operatingView(store, paths, NOTHING))

    expect(html).toContain('NOT READY')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Blocked:')
    expect(html).toContain('no `claude` executable on PATH')
    // Still a sentence and still a cost — a blocked button says what it would have done.
    expect(html).toContain('Write the ep02 premise-brief')
  })
})

describe('the operating page — the gate', () => {
  it('renders the artifact itself, both verdicts, and what the run has spent', async () => {
    queueThePremise()
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(run.id)

    const html = render(operatingView(store, paths, READY), {
      run: runView(store, paths, run.id)!,
      live: eventsOfRun(store, run.id),
    })

    // D15 / 4.6: the artifact is on the page, readable. Its path is beside it, not
    // instead of it.
    expect(html).toContain(WRITTEN)
    expect(html).toContain('greyharbor/s01e02/premise-brief-round-1.md')

    // Both verdicts, each stating its own cost. The rejection is disabled until the note
    // it needs has been written — the same shape as every other blocked button.
    expect(html).toContain('Approve the ep02 premise-brief')
    expect(html).toContain('No model call · $0.00')
    expect(html).toContain('reopens as round 2')
    expect(html).toContain('Write the note first')

    // Run state is always visible: the steps, and what it cost.
    expect(html).toContain('write-the-premise-brief')
    expect(html).toContain('advance-past-the-premise-gate')
    expect(html).toMatch(/3 calls · \$\d+\.\d\d/)

    // And the stream underneath, prose included — "streams, not spinners".
    expect(html).toContain('step-chunk')
    expect(html).toContain(openGates(store)[0]!.gate.runId)
  })

  it('offers the rejection once the note is written', async () => {
    queueThePremise()
    const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
    await runner.settled(run.id)

    const html = render(operatingView(store, paths, READY), {
      run: runView(store, paths, run.id)!,
      draft: { note: 'Too tidy.', depth: 'premise', target: '', comment: '' },
    })

    expect(html).not.toContain('Write the note first')
    expect(html).toContain('reopens as round 2')
  })
})

describe('the operating page — the check bench', () => {
  /**
   * The fixture's own planted material, checked by the real machinery and rendered by the
   * real page: the board rules over the hand-written extraction (free), and the panel through
   * the fake backend. What is asserted is that every kind of record E3 writes actually reaches
   * the screen — the HIL contract, held to as a string search.
   */
  async function checked(): Promise<CheckBenchView> {
    const harbor = greyHarborFounded(store, paths)
    const ep01 = episodesOf(store, seasonsOf(store, harbor.show.id)[0]!.id).find(
      (episode) => episode.number === 1,
    )!.id
    const script = artifactsOf(store, ep01).find((artifact) => artifact.kind === 'script')!
    const factOf = (entity: string, needle: string): string => {
      const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
      return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
    }

    const board = recordExtractedBoard(store, {
      episodeId: ep01,
      scriptId: script.id,
      extraction: theLongPierExtraction({
        lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
        halvaniVacuum: factOf('Halvani', 'loses consciousness'),
      }),
      filePath: 'greyharbor/s01e01/continuity-board-v1.md',
    })
    runBoardRules(store, board.artifact.id)

    for (let before = 0; before < 4; before += 1) llm.reply('{"findings": []}')
    llm.reply(
      JSON.stringify({
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
    )
    for (let after = 0; after < 5; after += 1) llm.reply('{"findings": []}')

    const panel = runner.enqueueRun({ episodeId: ep01, stage: TEXT_CHECK_STAGE })
    await runner.settled(panel.id)
    return checkBenchView(store, paths, ep01, READY)!
  }

  it('renders the script with every finding at its own span, and the buttons that read it', async () => {
    const html = renderChecks(await checked())

    // The artifact itself, readable, with the argued line marked where it stands (D15, 4.6).
    expect(html).toContain('The mess deck is warm')
    expect(html).toContain('<mark>Tobin comes out onto the pier in his coveralls</mark>')

    // Verb + object + scope + cost on every button that reads, and the free tier says free.
    expect(html).toContain('Check the ep01 script v1')
    expect(html).toContain('5 category checks, 1 arc position and 4 craft reviewers')
    expect(html).toContain('your money, spent when you click')
    expect(html).toContain('Re-run the 4 deterministic rules over the ep01 continuity board')
    expect(html).toContain('No model call · $0.00')
  })

  it('renders every kind of record E3 writes — the HIL contract, as a string search', async () => {
    const html = renderChecks(await checked())

    // Severity and confidence as two values, never one (invariant 4).
    expect(html).toContain('world-rules · severity high · confidence high · text, a reading')
    expect(html).toContain('dual-presence · severity high · confidence certain · deterministic')

    // The canon it argues with, quoted on the card.
    expect(html).toContain('loses consciousness in about nine seconds')

    // Deterministic findings marked stage-blocking, and said not to reach the gate.
    expect(html).toContain('STAGE-BLOCKING')
    expect(html).toContain('Blocks the next stage until it is resolved, and never this gate (D12)')

    // The wall's own sentence, where a disabled next-stage button renders it.
    expect(html).toContain('ep01 is blocked')
    expect(html).toContain('Deterministic findings block the next stage and never your gate')

    // ONE verdict board (4.5), not two half-boards Ryan has to read together: ten text
    // reviewers and the four deterministic rules, with the three findings standing on it.
    expect(html).toContain('Verdict board')
    expect(html).toContain('3 finding(s) standing across 14 reviewers')

    // The measured silence, by name: rules 2 and 3 were loaded and left alone.
    expect(html).toContain('loaded, and not cited')
    expect(html).toContain('Sound does not carry outside the hull')

    // 4.3's three buttons, priced, and the two refusals the page owns.
    expect(html).toContain('Pre-draft a rewrite of the world-rules span in scene 4')
    expect(html).toContain('Put the world-rules finding down with your note')
    expect(html).toContain('Dismissing a finding takes a note')
    expect(html).toContain('Pre-draft a replacement, or write one yourself')

    // D11's record, with its silences on it — and no maintenance prompt, because nothing here
    // has earned one. It is a question, and nothing acts on it.
    expect(html).toContain('Cried-wolf record')
    expect(html).toContain('No check is crying wolf')
    expect(html).toContain('impossible-adjacency')
  })

  it('renders the override verb at the gate, naming what it would stand over', async () => {
    const harbor = greyHarborFounded(store, paths)
    const ep01 = episodesOf(store, seasonsOf(store, harbor.show.id)[0]!.id).find(
      (episode) => episode.number === 1,
    )!.id
    const gate = runner.enqueueRun({ episodeId: ep01, stage: SCRIPT_GATE_STAGE })
    await runner.settled(gate.id)

    const html = render(operatingView(store, paths, READY), {
      run: runView(store, paths, gate.id)!,
    })

    // Three verbs, and the third one is its own button because it is its own row in the
    // ledger, forever (invariant 3).
    expect(html).toContain('Approve the ep01 script — round 1')
    expect(html).toContain('Approve the ep01 script OVER')
    expect(html).toContain('recorded as your override forever')
    // Rejecting this gate re-presents; there is no producer behind it to re-run, so it is free.
    expect(html).toContain('Reject the ep01 script with notes')
  })
})

describe('the operating page — the canon bench, unfounded', () => {
  it('renders every sheet as a candidate, the queue, and the button that founds the show', () => {
    const html = renderBench(canonBenchView(store, showId)!)

    expect(html).toContain('Canon — Grey Harbor')
    expect(html).toContain('Canon as of now')

    // Verb + object + scope, and the cost stated before the click — and it is $0.00,
    // because nothing on this bench calls a model.
    expect(html).toContain('Found Grey Harbor — ratify its 6 founding sheets, one ruling each')
    expect(html).toContain('No model call · $0.00')

    // Visibly unofficial: the word, and the sentence that says what it means.
    expect(html).toContain('Sefa Doule')
    expect(html).toContain('is a candidate — an identity registered, and a sheet nobody has ruled on')

    // The queue, with its three verbs — and the rejection blocked until the note is typed,
    // in the same sentence the API refuses with.
    expect(html).toContain('Ratify the “Ilse Renn” promotion')
    expect(html).toContain('Rejecting a proposal needs the reason')
    expect(html).toContain('Defer the “Ilse Renn” promotion')

    // Nothing has been ruled, so there is nothing on the ledger to render.
    expect(html).toContain('No ruling has been made on this show')
  })
})

describe('the operating page — the canon bench, founded', () => {
  it('renders canon on the sheets, the ledger it was ruled onto, and the change form', () => {
    const harbor = greyHarborFounded(store, paths)
    const html = renderBench(
      canonBenchView(store, harbor.show.id, { entityId: harbor.entity('Ilse Renn').id })!,
    )

    // Founding is done, and the button says so rather than offering to do it again.
    expect(html).toContain('has no founding sheets left to rule')
    expect(html).toContain('Nothing is waiting on a ruling')

    // The sheet: facts, their status, and their lineage.
    expect(html).toContain('Ilse Renn')
    expect(html).toContain('ratified at ruling')
    expect(html).toContain('species → Halvani · exactly-one, required · facts travel it (D22)')

    // The affordance the epic exit turns on — blocked until the new statement is typed.
    expect(html).toContain('Propose a change to')
    expect(html).toContain('Write the new statement first')

    // The ledger, which is where a bench ruling is read back from.
    expect(html).toContain('ratification')
    expect(html).toContain('convened away from a gate')
    expect(html).toContain('ruling 1 · ratification — the “Ilse Renn” promotion')
    expect(html).toContain('founded Grey Harbor from the sheets in')
  })

  it('offers the addition form on a factless entity, where no change form can reach', () => {
    const harbor = greyHarborFounded(store, paths)
    // Ottilie Bray as the drill left her: created with the facts box empty, promotion ruled.
    const promotion = registerAndPropose(
      store,
      harbor.show.id,
      { categoryKey: 'character', name: 'Ottilie Bray' },
      { standing: 'recurring', relations: [{ type: 'species', to: 'unknown' }] },
    )
    createProposalRulings(store, createEventLog(store)).ratify(promotion.id, {
      note: 'she has been in the background for six episodes.',
    })
    const ottilie = findEntity(store, {
      showId: harbor.show.id,
      categoryKey: 'character',
      name: 'Ottilie Bray',
    })!

    const html = renderBench(canonBenchView(store, harbor.show.id, { entityId: ottilie.id })!)

    // Nothing to anchor a change to — and the addition is offered anyway (#39).
    expect(html).toContain('Nothing ratified stands here at this setting')
    expect(html).toContain('Propose a new fact for Ottilie Bray')
    expect(html).toContain('No model call · $0.00')
    // Blocked until the statement is typed, in the sentence the API refuses with.
    expect(html).toContain('Write the statement first')
  })

  it('offers the candidate its promotion, and the create form its category', () => {
    const harbor = greyHarborFounded(store, paths)
    const html = renderBench(
      canonBenchView(store, harbor.show.id, { entityId: harbor.entity('Sefa Doule').id })!,
    )

    expect(html).toContain(
      'Promote Sefa Doule — raise the sheet below as a promotion proposal, for your own ruling',
    )
    // `unknown` is a real answer and satisfies the required species (D22) — and the word
    // came down the wire rather than out of the browser bundle.
    expect(html).toContain('unknown — declared, and a real answer')
    expect(html).toContain('Register a new character in Grey Harbor and raise its promotion')
    expect(html).toContain('Type the name first')
  })
})

// ── Ryan's two doors, on the card that refuses the writing stage (E4-5) ────────

describe('the page — what may be done with what is already written', () => {
  it('renders both doors the refusal names, with their sentences and their cost', () => {
    const html = render(operatingView(store, paths, READY))

    // The refusal, and then the two things it promises — on the same card, both pressable.
    expect(html).toContain('ep01 already has a script — rule on it at its gate, or edit it')
    expect(html).toContain('Present the ep01 script v1 for your ruling')
    expect(html).toContain('Edit the ep01 script yourself')
    expect(html).toContain('lands word for word as v2')
    expect(html).toContain('No model call · $0.00')
  })

  it('renders the draft in a field once he opens it, and never before', () => {
    const showId = store.get<{ id: string }>("SELECT id FROM show WHERE key = 'greyharbor'")!.id
    const ep01 = episodesOf(store, seasonsOf(store, showId)[0]!.id).find(
      (episode) => episode.number === 1,
    )!.id
    const script = artifactsOf(store, ep01).find((one) => one.kind === 'script')!
    const closed = render(operatingView(store, paths, READY))
    expect(closed).not.toContain('Leave it as it stands')

    const open = render(operatingView(store, paths, READY), {
      editing: { artifactId: script.id, text: '## 1 · INT. SOMEWHERE — 06:00' },
    })
    expect(open).toContain('textarea')
    expect(open).toContain('INT. SOMEWHERE')
    expect(open).toContain('Leave it as it stands')
  })
})

// ── The completion sweep, on the card and on the pass (E4-6) ──────────────────

describe('the page — the completion sweep an approved episode still owes', () => {
  /** Two claims riding ep02, raised the way anything raises: never by ratifying anything. */
  function twoRiders(): void {
    const harbor = greyHarborFounded(store, paths)
    for (const [who, statement] of [
      ['Ilse Renn', 'Ilse writes her diversions into the spares ledger by hand.'],
      ['Tobin Wick', 'Tobin Wick keeps the plant keys on his own ring.'],
    ] as const) {
      raiseProposal(store, {
        entityId: harbor.entity(who).id,
        kind: 'fact-delta',
        raisedBy: 'writer',
        episodeId: ep02,
        facts: [{ statement }],
      })
    }
  }

  it('says nothing at all on a card whose episode owes nothing', () => {
    const html = render(operatingView(store, paths, READY))

    expect(html).not.toContain('proposals to rule')
    expect(html).not.toContain('the completion sweep')
  })

  it('says what is owed on the card, and offers the pass — free, and never a wall', () => {
    twoRiders()
    const html = render(operatingView(store, paths, READY))

    expect(html).toContain('ep02 carries 2 proposals to rule — 2 fact deltas.')
    expect(html).toContain('They ride ep02 until you rule them, one at a time')
    expect(html).toContain('Rule the 2 proposals riding ep02 — the completion sweep, one at a time')
    expect(html).toContain('No model call · $0.00')
    // The launch button beside it is untouched: the pass is owed, it does not block work.
    expect(html).toContain('Write the ep02 premise-brief from the writer’s desk')
  })

  it('renders one rider at a time, with three verbs each and no fourth button', () => {
    twoRiders()
    const html = renderSweep(sweepView(store, ep02)!)

    expect(html).toContain('The ep02 completion sweep')
    expect(html).toContain('Implications:')
    expect(html).toContain('this, and only this, writes it into canon')
    expect(html).toContain('parks it, and it stops riding its episode')
    // Two riders, three verbs apiece — and no button anywhere that rules the pass at once.
    expect(html.match(/writes it into canon/g)).toHaveLength(2)
    expect(html.match(/parks it, and it stops riding its episode/g)).toHaveLength(2)
    for (const bulk of [/ratify all/i, /approve all/i, /rule them all/i, /rule the rest/i]) {
      expect(html).not.toMatch(bulk)
    }
    expect(html).toContain('Rejecting a proposal needs the reason')
  })
})

// ── Test kit ────────────────────────────────────────────────────────────────────

/**
 * The page as HTML, with React's `<!-- -->` text-node separators taken out. They are
 * hydration bookkeeping, they land in the middle of every interpolated sentence, and
 * asserting around them would mean asserting on React's internals rather than on what
 * Ryan reads.
 */
function render(
  view: ReturnType<typeof operatingView>,
  over: Partial<Parameters<typeof Page>[0]> = {},
): string {
  return renderToString(
    <Page
      view={view}
      run={null}
      runId={null}
      live={[]}
      problem={null}
      busy={false}
      draft={{ note: '', depth: '', target: '', comment: '' }}
      onDraft={() => undefined}
      onLaunch={() => undefined}
      editing={null}
      onEdit={() => undefined}
      onEditDraft={() => undefined}
      onLandEdit={() => undefined}
      onCancelEdit={() => undefined}
      onShowRun={() => undefined}
      onRule={() => undefined}
      bench={null}
      onShowBench={() => undefined}
      checks={null}
      checkEpisode={null}
      onShowChecks={() => undefined}
      sweep={null}
      sweepEpisode={null}
      onShowSweep={() => undefined}
      {...over}
    />,
  ).replaceAll('<!-- -->', '')
}

/** The completion sweep, with the real pass the server composed. Handlers are no-ops. */
function renderSweep(sweep: SweepView, draft: SweepDraft = EMPTY_SWEEP): string {
  return render(operatingView(store, paths, READY), {
    sweepEpisode: sweep.episode.id,
    sweep: {
      sweep,
      draft,
      busy: false,
      onDraft: () => undefined,
      onRule: () => undefined,
      onClose: () => undefined,
    },
  })
}

/** The checks section, with the real bench the server composed. Handlers are no-ops. */
function renderChecks(checks: CheckBenchView, draft: CheckDraft = EMPTY_CHECK_DRAFT): string {
  return render(operatingView(store, paths, READY), {
    checks: {
      checks,
      draft,
      busy: false,
      onDraft: () => undefined,
      onRun: () => undefined,
      onPredraft: () => undefined,
      onApply: () => undefined,
      onPropose: () => undefined,
      onDismiss: () => undefined,
      onRecheck: () => undefined,
      onShowRun: () => undefined,
    },
  })
}

/**
 * The canon section, with the real bench the server composed. Every handler is a no-op:
 * what is under test is what Ryan READS — the sentences, the costs, and the reasons a
 * blocked button gives before it is pressed.
 */
function renderBench(canon: CanonBenchView, draft: BenchDraft = EMPTY_BENCH): string {
  return render(operatingView(store, paths, READY), {
    bench: {
      canon,
      draft,
      busy: false,
      asOf: { ruling: '', date: '' },
      onDraft: () => undefined,
      onAsOf: () => undefined,
      onShowEntity: () => undefined,
      onFound: () => undefined,
      onCreate: () => undefined,
      onPromote: () => undefined,
      onPropose: () => undefined,
      onAddFact: () => undefined,
      onRuleProposal: () => undefined,
    },
  })
}

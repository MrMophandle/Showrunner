import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonBenchView, type CanonBenchView } from '../server/canon-bench.ts'
import type { Store } from '../server/db/store.ts'
import { episodesOf, seasonsOf } from '../server/domain/spine.ts'
import { createEventLog, eventsOfRun, type EventLog } from '../server/events.ts'
import { greyHarborFounded } from '../server/fixture/founded.ts'
import { loadFixture } from '../server/fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../server/library.ts'
import { describeLLMBackend, type LLMReadiness } from '../server/llm/choose.ts'
import { createFakeLLM, type FakeLLM } from '../server/llm/fake.ts'
import { operatingView, runView } from '../server/operating.ts'
import { openGates } from '../server/runner/gate.ts'
import { createRunner, type Runner } from '../server/runner/runner.ts'
import { DEMO_STAGE, stageCatalogue } from '../server/runner/stages.ts'
import { App, Page } from './App.tsx'
import { EMPTY_BENCH, type BenchDraft } from './CanonBench.tsx'

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

    // Verb + object + scope, and the cost stated before the click.
    expect(html).toContain('Write the ep01 demo premise and present it for your ruling')
    expect(html).toContain('your money, spent when you click')
    expect(html).not.toContain('Blocked:')
    expect(html).not.toContain('disabled=""')
  })

  it('disables the button and prints the reason when nothing can reach a model', () => {
    const html = render(operatingView(store, paths, NOTHING))

    expect(html).toContain('NOT READY')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Blocked:')
    expect(html).toContain('no `claude` executable on PATH')
    // Still a sentence and still a cost — a blocked button says what it would have done.
    expect(html).toContain('Write the ep01 demo premise')
  })
})

describe('the operating page — the gate', () => {
  it('renders the artifact itself, both verdicts, and what the run has spent', async () => {
    llm.reply(WRITTEN)
    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)

    const html = render(operatingView(store, paths, READY), {
      run: runView(store, paths, run.id)!,
      live: eventsOfRun(store, run.id),
    })

    // D15 / 4.6: the artifact is on the page, readable. Its path is beside it, not
    // instead of it.
    expect(html).toContain(WRITTEN)
    expect(html).toContain('greyharbor/s01e02/demo/premise-round-1.md')

    // Both verdicts, each stating its own cost. The rejection is disabled until the note
    // it needs has been written — the same shape as every other blocked button.
    expect(html).toContain('Approve the ep02 premise-brief demo')
    expect(html).toContain('No model call · $0.00')
    expect(html).toContain('reopens as round 2')
    expect(html).toContain('Write the note first')

    // Run state is always visible: the steps, and what it cost.
    expect(html).toContain('write-the-demo-premise')
    expect(html).toContain('tally-the-demo-spend')
    expect(html).toMatch(/1 call · \$\d+\.\d\d/)

    // And the stream underneath, prose included — "streams, not spinners".
    expect(html).toContain('step-chunk')
    expect(html).toContain(openGates(store)[0]!.gate.runId)
  })

  it('offers the rejection once the note is written', async () => {
    llm.reply(WRITTEN)
    const run = runner.enqueueRun({ episodeId: ep02, stage: DEMO_STAGE })
    await runner.settled(run.id)

    const html = render(operatingView(store, paths, READY), {
      run: runView(store, paths, run.id)!,
      draft: { note: 'Too tidy.', depth: 'premise', target: '', comment: '' },
    })

    expect(html).not.toContain('Write the note first')
    expect(html).toContain('reopens as round 2')
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
    expect(html).toContain('convened at the bench, no gate')
    expect(html).toContain('ruling 1 · ratification — the “Ilse Renn” promotion')
    expect(html).toContain('founded Grey Harbor from the sheets in')
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
      onShowRun={() => undefined}
      onRule={() => undefined}
      bench={null}
      onShowBench={() => undefined}
      {...over}
    />,
  ).replaceAll('<!-- -->', '')
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
      onRuleProposal: () => undefined,
    },
  })
}

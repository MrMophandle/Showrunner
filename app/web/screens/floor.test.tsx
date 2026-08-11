// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../../server/db/store.ts'
import { artifactsOf } from '../../server/domain/artifact.ts'
import { runBoardRules } from '../../server/domain/board-rules.ts'
import { recordExtractedBoard } from '../../server/domain/board.ts'
import { factsOfEntity } from '../../server/domain/fact.ts'
import { episodesOf, seasonsOf } from '../../server/domain/spine.ts'
import { createEventLog, type EventLog, type EventRecord } from '../../server/events.ts'
import { greyHarborFounded } from '../../server/fixture/founded.ts'
import { theLongPierExtraction } from '../../server/fixture/long-pier-board.ts'
import { floorView, type FloorView } from '../../server/floor.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../../server/library.ts'
import { describeLLMBackend, type LLMReadiness } from '../../server/llm/choose.ts'
import { createFakeLLM } from '../../server/llm/fake.ts'
import { createRulings, openGates } from '../../server/runner/gate.ts'
import { markRunRunning, recordRun } from '../../server/runner/run.ts'
import { createRunner } from '../../server/runner/runner.ts'
import { scaffoldStage } from '../../server/runner/stage-fixture.ts'
import { stageCatalogue } from '../../server/runner/stages.ts'
import { PREMISE_STAGE } from '../../server/runner/write-step.ts'
import { heldStill, stillTheSameNode } from '../chrome/held-still.ts'
import { applyProse, FloorScreen, seedProse, type Prose } from './Floor.tsx'

/**
 * **The floor, in a real DOM, with a real run's events flowing** (E5-1, #81).
 *
 * `floor.test.ts` proves the sentences are right. This proves the screen: that the whole
 * floor holds still while everything on it changes, that the pip wears the three states
 * Ryan ruled, that an open gate reaches him as a card he can click, and that the browser
 * writes not one word of it.
 *
 * ── The stylesheets are the ones that ship ──────────────────────────────────────
 * `chrome.css` AND `floor.css` are read off disk and put in the document, because
 * `held-still.ts` asks the CSSOM whether a box can grow. A test against a bundler's idea of
 * the stylesheet would pass on a page that shoved itself down the screen.
 *
 * ── The events are the real ones ────────────────────────────────────────────────
 * `events.subscribe` is what `GET /api/events` itself subscribes to (`app.ts`), so what
 * arrives here is the same record, off the same fan-out, in the same order the browser
 * would receive it over SSE — with the socket taken out, because a socket is not what is
 * being tested. And the view the harness re-reads is `floorView` itself, over the same
 * library, so a transition re-renders exactly what it would re-render in the app.
 */

const CHROME = readFileSync(join(import.meta.dirname, '..', 'chrome', 'chrome.css'), 'utf8')
const FLOOR = readFileSync(join(import.meta.dirname, 'floor.css'), 'utf8')
const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
const NOTHING_FOUND = '{"findings": []}'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let host: HTMLElement
let root: Root
let library: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let ep01: string
let ep02: string

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  for (const css of [CHROME, FLOOR]) {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  library = mkdtempSync(join(tmpdir(), 'showrunner-floor-screen-'))
  paths = initLibrary(library)
  store = openLibraryStore(paths)
  const harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  const season = seasonsOf(store, harbor.show.id)[0]!
  const episodes = episodesOf(store, season.id)
  ep01 = episodes[0]!.id
  ep02 = episodes[1]!.id
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.head.replaceChildren()
  store.close()
  rmSync(library, { recursive: true, force: true })
})

const read = (): FloorView => floorView(store, paths, READY)

function render(node: React.ReactNode): void {
  act(() => root.render(node))
}

/** The screen, over one read, with nothing arriving. */
function still(view: FloorView = read()): void {
  render(
    <div className="wrap" data-room="floor">
      <FloorScreen
        view={view}
        prose={seedProse({}, view)}
        busy={null}
        problem={null}
        onLaunch={() => {}}
      />
    </div>,
  )
}

/**
 * The screen as the app wires it: subscribed to the real log, re-reading the real view on a
 * transition and patching the prose in place on everything else. This is `Floor`'s two
 * effects with `fetch` and `EventSource` taken out and the same functions underneath.
 */
function Harness({ log }: { log: EventLog }) {
  const [view, setView] = useState<FloorView>(read)
  const [prose, setProse] = useState<Prose>(() => seedProse({}, read()))

  useEffect(
    () =>
      log.subscribe((record: EventRecord) => {
        setProse((held) => applyProse(held, record))
        if (record.kind === 'step-progress' || record.kind === 'step-chunk') return
        setView(read())
      }),
    [log],
  )

  return (
    <div className="wrap" data-room="floor">
      <FloorScreen view={view} prose={prose} busy={null} problem={null} onLaunch={() => {}} />
    </div>
  )
}

/** A real run row on ep01, running, for real events to belong to. */
function runningOnEp01(): string {
  const run = recordRun(store, scaffoldStage('produce', []), ep01)
  markRunRunning(store, run.id)
  return run.id
}

/** A real gate on ep02, opened by a real run of the real premise stage. Nothing is spent. */
async function openAGateOnEp02(): Promise<void> {
  const llm = createFakeLLM()
  const runner = createRunner(store, stageCatalogue(paths), events, llm)
  createRulings(store, events, runner)
  llm.reply('Tobin Wick reads the exchanger log and has to decide what to do about it.')
  for (let n = 0; n < 8; n += 1) llm.reply(NOTHING_FOUND)
  const run = runner.enqueueRun({ episodeId: ep02, stage: PREMISE_STAGE })
  await runner.settled(run.id)
}

/** The Long Pier's planted contradiction, raised by the free deterministic tier. */
function wallEp01(): void {
  const script = artifactsOf(store, ep01).find((artifact) => artifact.kind === 'script')!
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
}

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

const floor = () => host.querySelector('.floor')!

// ── Trap 3 · live means in place, at screen scale ───────────────────────────────

describe('the whole floor holds still while a real run talks under it', () => {
  it('never moves the row Ryan is reaching for, across a run’s worth of real events', async () => {
    await openAGateOnEp02()
    const runId = runningOnEp01()
    render(<Harness log={events} />)

    // What his hand is on: the door into ep02's room, in the row BELOW the one that is
    // talking. That is the arrangement his complaint was about — the wall of changing text
    // was above the thing he was hunting for.
    const reaching = () => host.querySelector(`#open-${ep02}`)!
    const arrive = (kind: EventRecord['kind'], summary: string) =>
      act(() => {
        events.append({ kind, runId, episodeId: ep01, summary })
      })

    // A latest-wins line replacing itself, including with one long enough to wrap.
    await heldStill(floor(), reaching(), () => arrive('step-progress', 'Writing the ep01 script'))
    await heldStill(floor(), reaching(), () =>
      arrive(
        'step-progress',
        'Writing the ep01 script — a progress line long enough that it would wrap onto a ' +
          'second line and then a third if this screen let anything wrap',
      ),
    )

    // An accumulating stream, a sentence at a time.
    for (const piece of [
      '“emergency lighting dies section by section ',
      'down the spine of the ship, ',
      'and the dark comes up behind it like water.” ',
      'The corridor holds its breath. ',
    ]) {
      await heldStill(floor(), reaching(), () => arrive('step-chunk', piece))
    }

    // And the transitions — each of which re-reads the WHOLE floor, so every number, card
    // and sentence on it is recomposed under his eye without moving a pixel of it.
    for (const kind of ['step-started', 'lock-acquired', 'step-done', 'lock-released'] as const) {
      await heldStill(floor(), reaching(), () => arrive(kind, `${kind} on ep01`))
    }
  })

  it('replaces the words in the live line without replacing the element', () => {
    const runId = runningOnEp01()
    render(<Harness log={events} />)
    const line = () => host.querySelector(`#live-${ep01} .live-region__latest`)!

    const first = line()
    act(() => {
      events.append({ kind: 'step-progress', runId, episodeId: ep01, summary: 'Scene 1 of 6' })
    })
    expect(line().textContent).toBe('Scene 1 of 6')

    act(() => {
      events.append({ kind: 'step-progress', runId, episodeId: ep01, summary: 'Scene 2 of 6' })
    })
    // The same node with new words in it: focus, selection and scroll position survive.
    stillTheSameNode(first, line())
    expect(line().textContent).toBe('Scene 2 of 6')
  })

  it('holds still when a needs-you card ARRIVES, which is the moment that matters most', async () => {
    const runId = runningOnEp01()
    render(<Harness log={events} />)
    expect(host.querySelectorAll('.need')).toHaveLength(0)

    const reaching = () => host.querySelector(`#open-${ep02}`)!
    // The wall goes up mid-watch. A card appears in a region that already had the room for
    // it, and the episode rows underneath do not move an inch.
    await heldStill(floor(), reaching(), () => {
      wallEp01()
      act(() => {
        events.append({ kind: 'step-done', runId, episodeId: ep01, summary: 'the checks landed' })
      })
    })

    expect(host.querySelectorAll('.need')).toHaveLength(1)
    expect(host.querySelector('.section-h__count')!.textContent).toBe('1')
  })

  it('reserves the space before anything arrives — every region above a row is a fixed box', () => {
    still()

    for (const selector of ['.floor-health', '.floor-needs', '.floor-row', '.floor-row__status']) {
      const height = getComputedStyle(host.querySelector(selector)!).height
      expect(height, `${selector} has no fixed height, so the page can grow above a row`).not.toBe(
        'auto',
      )
      expect(height).not.toBe('')
    }
    // A `max-height` anywhere in this layout would be the same defect on a longer fuse: a
    // box that grows up to its maximum shoves everything under it the whole way.
    expect(FLOOR).not.toMatch(/max-height\s*:/)
  })
})

// ── Trap 4 · the pip's three ruled states, pinned ───────────────────────────────

describe('the lifecycle pip wears the three states Ryan ruled, and says which in words', () => {
  /**
   * The COLOURS are pinned in `drift.test.ts`, against the stylesheet, because jsdom does
   * not resolve a `var()` and a computed-style assertion here would be reading
   * `rgba(0,0,0,0)` and calling it amber. What is pinned here is what this screen decides:
   * which stop wears which standing, and therefore which rule applies to it.
   */
  it('marks done as done, the current stage as current, and nothing else as either', () => {
    still()
    const stops = host.querySelectorAll(`#row-${ep01} .stage`)

    expect([...stops].map((stop) => stop.className)).toEqual([
      'stage stage--done',
      'stage stage--done',
      'stage stage--current',
      'stage stage--ahead',
      'stage stage--ahead',
      'stage stage--ahead',
    ])
    // Exactly one stop is his, and it is the one the episode is AT.
    expect(host.querySelectorAll(`#row-${ep01} .stage--current`)).toHaveLength(1)
    expect(host.querySelectorAll(`#row-${ep01} .stage--running`)).toHaveLength(0)
  })

  it('moves that stop to `running` while a run turns on it — in flight, not his hand', () => {
    runningOnEp01()
    still()

    const stops = host.querySelectorAll(`#row-${ep01} .stage`)
    expect(stops[2]!.className).toBe('stage stage--running')
    // And `current` is nowhere on this track, because nothing here is waiting on him. The
    // two states are exclusive by construction, which is what makes the colours mean what
    // the ruling says they mean.
    expect(host.querySelectorAll(`#row-${ep01} .stage--current`)).toHaveLength(0)
  })

  it('says the state in words as well as in colour, and marks the current stop for a reader', () => {
    still()
    const current = host.querySelector(`#row-${ep01} .stage--current`)!

    expect(current.getAttribute('aria-current')).toBe('step')
    expect(current.querySelector('.visually-hidden')!.textContent).toBe(
      'script — where it stands, and it is yours to move',
    )
    expect(host.querySelector(`#row-${ep01} .stage--done .visually-hidden`)!.textContent).toBe(
      'premise — done',
    )
    // Every stop that is not the one it is at is unmarked — one `aria-current` per track.
    expect(host.querySelectorAll(`#row-${ep01} [aria-current]`)).toHaveLength(1)
  })
})

// ── Trap 1 · the card, on the screen, linked ────────────────────────────────────

describe('a needs-you card reaches the screen as something to click', () => {
  it('renders the gate as a card whose act is a real link into the gate room', async () => {
    await openAGateOnEp02()
    const gateId = openGates(store)[0]!.gate.id
    still()

    const card = host.querySelector('.need')!
    expect(card.getAttribute('data-kind')).toBe('gate')
    expect(card.querySelector('.need__kind')!.textContent).toBe('Gate open')
    expect(card.querySelector('.need__title')!.textContent).toBe('ep02 “Dry Stores” — premise-brief gate')

    // A real anchor with a real href: a keyboard, a middle click and a reader all get a
    // link, and the address is the gate's own.
    const link = card.querySelector('a.btn')!
    expect(link.getAttribute('href')).toBe(`/gate/${gateId}`)
    expect(link.textContent).toContain('Rule on the ep02 premise-brief')
    expect(link.querySelector('.cost')!.textContent).toContain('$0.00 to open it')
    // It is honest about the room before it is clicked, not after.
    expect(card.querySelector('.need__room')!.textContent).toBe('the gate room')
    expect(card.querySelector('.need__room')!.getAttribute('title')).toContain('#83')
    expect(link.getAttribute('title')).toContain('#83')

    // And the WHY is on the card, with pixels. It was `flex: 1` in a box whose other parts
    // already filled it, which rendered the one line Ryan most needs zero high.
    const why = card.querySelector('.need__why')!
    expect(why.textContent).toContain('parked on this gate')
    expect(getComputedStyle(why).flex).not.toBe('1')
  })

  it('says “nothing needs you” as a designed state when nothing does', () => {
    still()

    expect(host.querySelectorAll('.need')).toHaveLength(0)
    expect(host.querySelectorAll('.section-h__count')).toHaveLength(0)
    const empty = host.querySelector('.floor-needs .empty')!
    expect(empty.querySelector('.empty__lead')!.textContent).toBe('Nothing needs you.')
    expect(empty.textContent).toContain('No gate is open')
  })
})

// ── Trap 6 · the rows say what is true ──────────────────────────────────────────

describe('the rows render the states the mockup designed for', () => {
  it('says ep02 is not started, and offers the stage it is at with its price', () => {
    still()
    const row = host.querySelector(`#row-${ep02}`)!

    expect(row.querySelector('.floor-row__standing')!.textContent).toBe(
      'Not started — nothing has been written for ep02 yet.',
    )
    const button = row.querySelector('button')!
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('ep02')
    expect(button.querySelector('.cost')!.textContent).toContain('your money, spent when you click')
  })

  it('shows the wall on the row in the words the server refuses with', () => {
    wallEp01()
    still()

    const wall = host.querySelector(`#row-${ep01} .floor-row__wall`)!
    expect(wall.textContent).toContain('ep01 is blocked')
    expect(wall.textContent).toContain('vacuum-without-protection')
  })

  it('renders a run’s own line, its lock and its prose, and no button beside them', () => {
    const runId = runningOnEp01()
    render(<Harness log={events} />)
    act(() => {
      events.append({ kind: 'step-progress', runId, episodeId: ep01, summary: 'Shot 8 of 14' })
      events.append({ kind: 'step-chunk', runId, episodeId: ep01, summary: 'the dark comes up ' })
      events.append({ kind: 'step-chunk', runId, episodeId: ep01, summary: 'behind it like water' })
    })

    const region = host.querySelector(`#live-${ep01}`)!
    expect(region.querySelector('.live-region__heading')!.textContent).toContain('produce')
    expect(region.querySelector('.live-region__latest')!.textContent).toBe('Shot 8 of 14')
    expect(region.querySelector('.live-region__stream')!.textContent).toBe(
      'the dark comes up behind it like water',
    )
    // An episode with a run in flight is offered nothing: one run per episode (D7).
    expect(host.querySelectorAll(`#row-${ep01} button`)).toHaveLength(0)
  })

  it('says what is NOT in flight at the foot, where the mockup draws a pool nothing records', () => {
    still()
    const footer = host.querySelector('.floor-footer .empty')!
    expect(footer.querySelector('.empty__lead')!.textContent).toBe('Nothing else in flight.')
    expect(footer.textContent).toContain('idea pool')
  })
})

// ── The browser writes none of the words ────────────────────────────────────────

/**
 * The strongest proof available, and the one `chrome.test.tsx` uses: hand the screen a view
 * of empty strings and see whether anything comes out. A word this file authored shows up
 * here as that word, and there is nowhere to hide it.
 */
describe('the floor writes none of its own copy', () => {
  it('renders a blank view blank — every sentence on this screen came down the wire', () => {
    const blank: FloorView = {
      library: paths,
      shows: [
        {
          id: 'show',
          key: '',
          title: '',
          where: '',
          health: [
            { id: 'a', label: '', value: '', sub: '', detail: '', standing: 'good', meter: null },
          ],
          // `explains` may not be blank — the component refuses one, which is E5-0's rule
          // and the one string below that has to be non-empty for the screen to render.
          healthHeading: { name: '', explains: '—' },
          needsYouHeading: { name: '', explains: '—' },
          needsYou: [
            {
              id: 'card',
              kind: 'gate',
              kindLabel: '',
              title: '',
              why: '',
              detail: '',
              since: '',
              href: '/gate/x',
              room: '',
              roomNotYet: null,
              act: { sentence: '', cost: '', enabled: true, blockedBecause: null },
              episodeId: 'ep',
            },
          ],
          nothingNeedsYou: null,
          inFlightHeading: { name: '', explains: '—' },
          episodes: [
            {
              id: 'ep',
              label: '',
              number: 1,
              title: '',
              lifecycle: 'premise',
              note: '',
              standing: '',
              past: false,
              track: [{ stage: '', standing: 'current', sentence: '' }],
              waiting: '',
              live: { runId: 'r', heading: '', latest: '', stream: [''] },
              launch: { sentence: '', cost: '', enabled: true, blockedBecause: null },
              done: '',
              launchStage: '',
              wall: '',
              queued: '',
              href: '/episode/ep',
            },
          ],
          footer: { lead: '', sentence: '' },
        },
      ],
      empty: null,
      stream: { kinds: [], prose: [] },
    } as unknown as FloorView

    still(blank)
    // The separators are the stylesheet's marks rather than words, and the count badge is a
    // NUMBER off the card list — data, not copy. Everything else that could appear here
    // would be a sentence this file wrote.
    const said = (host.textContent ?? '').replaceAll(/[·—\d]/g, '').trim()
    expect(said).toBe('')
  })
})

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
import { episodeRoomView, type EpisodeRoomView } from '../../server/episode-room.ts'
import { createEventLog, type EventLog, type EventRecord } from '../../server/events.ts'
import { greyHarborFounded } from '../../server/fixture/founded.ts'
import { theLongPierExtraction } from '../../server/fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../../server/library.ts'
import { describeLLMBackend, type LLMReadiness } from '../../server/llm/choose.ts'
import { createFakeLLM } from '../../server/llm/fake.ts'
import { createRulings, openGates } from '../../server/runner/gate.ts'
import { markRunRunning, recordRun } from '../../server/runner/run.ts'
import { createRunner } from '../../server/runner/runner.ts'
import { scaffoldStage } from '../../server/runner/stage-fixture.ts'
import { stageCatalogue } from '../../server/runner/stages.ts'
import { PREMISE_STAGE } from '../../server/runner/write-step.ts'
import { applyProse, type Prose } from './Floor.tsx'
import { heldStill, stillTheSameNode } from '../chrome/held-still.ts'
import { EMPTY_DRAFT, EpisodeRoomScreen, seedLive, type RoomDraft } from './EpisodeRoom.tsx'

/**
 * **The episode room, in a real DOM, with a real run's events flowing** (E5-2, #82).
 *
 * `episode-room.test.ts` proves the sentences are right. This proves the screen: that the
 * whole room holds still while everything on it changes, that the pip wears the states Ryan
 * ruled and gets them from the floor's own component, that the grid renders the board's own
 * verdicts, that the scene door opens the scene's own span — and that the browser writes not
 * one word of any of it.
 *
 * ── The stylesheets are the ones that ship ──────────────────────────────────────
 * `chrome.css` AND `episode-room.css` are read off disk and put in the document, because
 * `held-still.ts` asks the CSSOM whether a box can grow. A test against a bundler's idea of
 * the stylesheet would pass on a page that shoved itself down the screen.
 *
 * ── The events are the real ones ────────────────────────────────────────────────
 * `events.subscribe` is what `GET /api/events` itself subscribes to (`app.ts`), so what
 * arrives here is the same record, off the same fan-out, in the same order the browser would
 * receive it over SSE — with the socket taken out, because a socket is not what is being
 * tested. And the view the harness re-reads is `episodeRoomView` itself, over the same
 * library, so a transition re-renders exactly what it would re-render in the app.
 */

const CHROME = readFileSync(join(import.meta.dirname, '..', 'chrome', 'chrome.css'), 'utf8')
const ROOM = readFileSync(join(import.meta.dirname, 'episode-room.css'), 'utf8')
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
  for (const css of [CHROME, ROOM]) {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  library = mkdtempSync(join(tmpdir(), 'showrunner-room-screen-'))
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

const read = (episodeId: string = ep01): EpisodeRoomView =>
  episodeRoomView(store, paths, episodeId, READY)!

function render(node: React.ReactNode): void {
  act(() => root.render(node))
}

/** The screen, over one read, with nothing arriving. */
function still(view: EpisodeRoomView = read(), draft: RoomDraft = EMPTY_DRAFT): void {
  render(
    <div className="wrap" data-room="episode-room">
      <EpisodeRoomScreen
        view={view}
        prose={seedLive({}, view)}
        draft={draft}
        busy={null}
        problem={null}
        onDraft={() => {}}
        onLaunch={() => {}}
        onOpenScene={() => {}}
        onLandScene={() => {}}
        onOpenArtifact={() => {}}
        onLandArtifact={() => {}}
        onPredraft={() => {}}
        onApply={() => {}}
        onPropose={() => {}}
        onDismiss={() => {}}
        onRecheck={() => {}}
        onDeclare={() => {}}
        onRule={() => {}}
      />
    </div>,
  )
}

/**
 * The screen as the app wires it: subscribed to the real log, re-reading the real view on a
 * transition and patching the prose in place on everything else. This is `EpisodeRoom`'s two
 * effects with `fetch` and `EventSource` taken out and the same functions underneath.
 */
function Harness({ log, episodeId }: { log: EventLog; episodeId: string }) {
  const [view, setView] = useState<EpisodeRoomView>(() => read(episodeId))
  const [prose, setProse] = useState<Prose>(() => seedLive({}, read(episodeId)))

  useEffect(
    () =>
      log.subscribe((record: EventRecord) => {
        setProse((held) => applyProse(held, record))
        if (record.kind === 'step-progress' || record.kind === 'step-chunk') return
        setView(read(episodeId))
      }),
    [log, episodeId],
  )

  return (
    <div className="wrap" data-room="episode-room">
      <EpisodeRoomScreen
        view={view}
        prose={prose}
        draft={EMPTY_DRAFT}
        busy={null}
        problem={null}
        onDraft={() => {}}
        onLaunch={() => {}}
        onOpenScene={() => {}}
        onLandScene={() => {}}
        onOpenArtifact={() => {}}
        onLandArtifact={() => {}}
        onPredraft={() => {}}
        onApply={() => {}}
        onPropose={() => {}}
        onDismiss={() => {}}
        onRecheck={() => {}}
        onDeclare={() => {}}
        onRule={() => {}}
      />
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

/** The Long Pier's planted contradictions, raised by the free deterministic tier. */
function buildTheBoard(): void {
  const script = artifactsOf(store, ep01).find((one) => one.kind === 'script')!
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

const room = () => host.querySelector('.room')!

// ── Trap 3 · live in place, at room scale ──────────────────────────────────────

describe('the whole room holds still while a real run talks under it', () => {
  it('never moves the button Ryan is reaching for, across a run’s worth of real events', async () => {
    const runId = runningOnEp01()
    render(<Harness log={events} episodeId={ep01} />)

    // What his hand is on: the last button on the stage rail — below the live region, below
    // the news box, and below every other offer, which is the arrangement his complaint was
    // about. The wall of changing text is all of it, above the thing he is hunting for.
    const reaching = () => host.querySelector('#stage-script-gate')!
    const arrive = (kind: EventRecord['kind'], summary: string) =>
      act(() => {
        events.append({ kind, runId, episodeId: ep01, summary })
      })

    // A latest-wins line replacing itself, including with one long enough to wrap.
    await heldStill(room(), reaching(), () => arrive('step-progress', 'Reading scene 1 of 6'))
    await heldStill(room(), reaching(), () =>
      arrive(
        'step-progress',
        'Reading scene 1 of 6 — a progress line long enough that it would wrap onto a second ' +
          'line and then a third if this screen let anything wrap',
      ),
    )

    // An accumulating stream, a sentence at a time.
    for (const piece of [
      '“the pier is ninety seconds of nothing ',
      'in either direction, and she knows it, ',
      'and she goes anyway.” ',
    ]) {
      await heldStill(room(), reaching(), () => arrive('step-chunk', piece))
    }

    // And the transitions — each of which re-reads the WHOLE room, so every verdict, sentence,
    // freshness line and ledger row on it is recomposed under his eye without moving a pixel.
    for (const kind of ['step-started', 'lock-acquired', 'step-done', 'lock-released'] as const) {
      await heldStill(room(), reaching(), () => arrive(kind, `${kind} on ep01`))
    }

    // The hardest one, and the reason the news box exists: **D12's wall goes up mid-watch.**
    // A board lands, two deterministic rules fire, and a paragraph of refusal appears at the
    // top of the rail — directly above the button his hand is on. That is the system's doing,
    // not his, so the space for it was reserved before it arrived.
    expect(host.querySelector('.room-rail__wall')).toBeNull()
    await heldStill(room(), reaching(), () => {
      buildTheBoard()
      arrive('step-done', 'the board landed and the rules read it')
    })
    expect(host.querySelector('.room-rail__wall')!.textContent).toContain('ep01 is blocked')
    // And the grid filled in under him at the same moment, six rows deep.
    expect(
      host.querySelectorAll('.room-scenes tbody tr:not([id^="scene-says-"])'),
    ).toHaveLength(6)
  })

  it('holds the scene grid still when a rule lands a verdict on a row above the one being read', async () => {
    const runId = runningOnEp01()
    render(<Harness log={events} episodeId={ep01} />)

    // Ryan is reading the grid, and the board arrives under him. The rows the mockup draws
    // are the room's face, so this is the region most worth protecting.
    const reaching = () => host.querySelector('.room-body--grid')!
    await heldStill(room(), reaching(), () => {
      buildTheBoard()
      act(() => {
        events.append({ kind: 'step-done', runId, episodeId: ep01, summary: 'the board landed' })
      })
    })

    // And the world really did move underneath — otherwise this asserts nothing at all.
    expect(
      host.querySelectorAll('.room-scenes tbody tr:not([id^="scene-says-"])'),
    ).toHaveLength(6)
    expect(host.querySelector('.room-rail__wall')!.textContent).toContain('ep01 is blocked')
  })

  it('reserves the space before anything arrives — every region that can change is a fixed box', () => {
    buildTheBoard()
    still()

    for (const selector of [
      '.room-head',
      '.room-grid__head',
      '.room-body--grid',
      '.room-body--artifacts',
      '.room-body--findings',
      '.room-body--live',
      '.room-body--rail',
      '.room-rail__news',
      '.room-body--riders',
      '.room-body--ledger',
      '.room-offer',
    ]) {
      const height = getComputedStyle(host.querySelector(selector)!).height
      expect(height, `${selector} has no fixed height, so the page can grow above a button`).not.toBe(
        'auto',
      )
      expect(height).not.toBe('')
    }
    // A `max-height` anywhere in this layout would be the same defect on a longer fuse: a box
    // that grows up to its maximum shoves everything under it the whole way.
    expect(ROOM).not.toMatch(/max-height\s*:/)
  })

  it('replaces the words in the live line without replacing the element', () => {
    const runId = runningOnEp01()
    render(<Harness log={events} episodeId={ep01} />)
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

  it('does not say a word twice when the stream replays what the read already handed over', () => {
    const runId = runningOnEp01()
    // Three chunks land BEFORE the page opens, so the server's read seeds them — and the
    // replay on connect will deliver the very same rows again. E5-1's seq protocol, reused.
    const before = [1, 2, 3].map((n) =>
      events.append({ kind: 'step-chunk', runId, episodeId: ep01, summary: `chunk ${n} ` }),
    )
    const seeded = before.reduce(applyProse, seedLive({}, read(ep01)))
    expect(seeded[runId]!.chunks.join('')).toBe('chunk 1 chunk 2 chunk 3 ')

    render(<Harness log={events} episodeId={ep01} />)
    const line = () => host.querySelector(`#live-${ep01} .live-region__stream`)!.textContent
    expect(line()).toBe('chunk 1 chunk 2 chunk 3 ')

    act(() => {
      events.append({ kind: 'step-chunk', runId, episodeId: ep01, summary: 'chunk 4' })
    })
    expect(line()).toBe('chunk 1 chunk 2 chunk 3 chunk 4')
  })

  it('renders the live region idle rather than absent, so starting a run moves nothing', () => {
    still()
    const idle = host.querySelector(`#live-${ep01}`)!
    expect(idle.className).toContain('live-region--idle')
    expect(idle.querySelector('.live-region__heading')!.textContent).toBe(
      'Nothing has ever run on ep01',
    )

    const before = getComputedStyle(host.querySelector('.room-body--live')!).height
    runningOnEp01()
    still()
    expect(host.querySelector(`#live-${ep01}`)!.className).not.toContain('live-region--idle')
    expect(getComputedStyle(host.querySelector('.room-body--live')!).height).toBe(before)
  })
})

// ── Trap 4 · the pip is the floor's component, wearing the ruled states ────────

/**
 * Ryan ruled it on Aug 11: done / current-**amber** / running-**blue, pulsing**. This room's
 * own mockup paints a merely-current stage blue, and that is the error the ruling names.
 *
 * The COLOURS are pinned in `drift.test.ts` against the stylesheet, because jsdom does not
 * resolve a `var()`. What is pinned here is that this screen renders the floor's own
 * component and its own class vocabulary — so there is one pip in the cockpit, not two.
 */
describe('the lifecycle pip is the floor’s component, and wears the states Ryan ruled', () => {
  it('marks the current stage `current` and never `running` while nothing is in flight', () => {
    still()
    const stops = host.querySelectorAll('.room-head .stage')

    expect([...stops].map((stop) => stop.className)).toEqual([
      'stage stage--done',
      'stage stage--done',
      'stage stage--current',
      'stage stage--ahead',
      'stage stage--ahead',
      'stage stage--ahead',
    ])
    expect(host.querySelectorAll('.room-head .stage--running')).toHaveLength(0)
    // The mockup's own error, refused: a merely-current stage never wears the running class,
    // which is the only class `chrome.css` gives the blue pulse to.
    expect(host.querySelector('.stage--current .pip')).not.toBeNull()
  })

  it('moves that stop to `running` while a run turns on it — in flight, not his hand', () => {
    runningOnEp01()
    still()

    const stops = host.querySelectorAll('.room-head .stage')
    expect(stops[2]!.className).toBe('stage stage--running')
    // The two states are exclusive by construction, which is what makes the colours mean what
    // the ruling says they mean.
    expect(host.querySelectorAll('.room-head .stage--current')).toHaveLength(0)
  })

  it('says the state in words as well as in colour, and marks the current stop for a reader', () => {
    still()
    const current = host.querySelector('.room-head .stage--current')!

    expect(current.getAttribute('aria-current')).toBe('step')
    expect(current.querySelector('.visually-hidden')!.textContent).toBe(
      'script — where it stands, and it is yours to move',
    )
    expect(host.querySelectorAll('.room-head [aria-current]')).toHaveLength(1)
  })
})

// ── Trap 1 · the grid renders the board's own verdicts ─────────────────────────

describe('the scene grid is the room’s face, and it renders the board’s own words', () => {
  it('draws one row per scene with the board’s readings and the rules’ verdicts on it', () => {
    buildTheBoard()
    still()

    const rows = host.querySelectorAll('.room-scenes tbody tr:not([id^="scene-says-"])')
    expect(rows).toHaveLength(6)
    // Two of the six carry a verdict row under them; the other four say nothing because
    // nothing argued with them.
    expect(host.querySelectorAll('[id^="scene-says-"]')).toHaveLength(2)
    expect(rows[0]!.querySelector('.room-scenes__who')!.textContent).toBe('Ilse Renn, Tobin Wick')
    // The void is on this side of the hull, and the grid says so in the one place it raises
    // its voice — beside the words, never instead of them.
    expect(rows[3]!.querySelector('.room-env')!.className).toContain('room-env--exposed')
    expect(rows[3]!.querySelector('.room-env')!.textContent).toBe('exposed')
    expect(rows[5]!.querySelector('.room-env')!.textContent).toBe('hardsuit · exposed')

    // Where the row meets the scene: the deterministic say, in a row of its own beneath the
    // scene it is about, with D12's sentence on it.
    const say = host.querySelector(
      `#scene-says-${read().grid.rows[3]!.sceneId} .room-scenes__say`,
    )!
    expect(say.textContent).toContain('vacuum-without-protection')
    expect(say.textContent).toContain('severity high · confidence certain')
    expect(say.getAttribute('data-blocking')).toBe('true')
    expect(say.getAttribute('title')).toContain('never this gate (D12)')
  })

  it('renders the grid’s health as panel.ts’s own verdicts and sentences', () => {
    buildTheBoard()
    still()

    const verdicts = [...host.querySelectorAll('.room-verdict')]
    expect(verdicts.map((one) => one.getAttribute('data-check')).sort()).toEqual([
      'dual-presence',
      'duplicate-arrival',
      'impossible-adjacency',
      'vacuum-without-protection',
    ])
    const clean = verdicts.find((one) => one.getAttribute('data-check') === 'duplicate-arrival')!
    expect(clean.getAttribute('data-verdict')).toBe('clean')
    expect(clean.textContent).toContain('clean')
    const found = verdicts.find(
      (one) => one.getAttribute('data-check') === 'vacuum-without-protection',
    )!
    expect(found.getAttribute('data-verdict')).toBe('found')
    expect(found.textContent).toContain('severity high · confidence certain · scene 4')
  })

  it('renders the honest not-yet state with the priced button that builds a board', () => {
    still()

    expect(host.querySelector('.room-scenes')).toBeNull()
    const empty = host.querySelector('.room-body--grid .empty')!
    expect(empty.querySelector('.empty__lead')!.textContent).toBe('No continuity board yet.')
    const button = empty.querySelector('button')!
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('continuity board')
    expect(button.querySelector('.cost')!.textContent).toContain('your money, spent when you click')
  })
})

// ── Trap 5 · the scene door opens the scene's own span ─────────────────────────

describe('every row of the grid carries D14’s scene door', () => {
  it('offers a short door per scene, and its own span as what the box opens on', () => {
    buildTheBoard()
    const view = read()
    const three = view.grid.rows[2]!
    still(view)

    const door = host.querySelector(`#edit-scene-${three.sceneId}`) as HTMLButtonElement
    expect(door.disabled).toBe(false)
    // Short in the cell, whole on the pointer — said twice, at two lengths, so nothing is
    // trimmed away from the offer's own sentence.
    expect(door.textContent).toBe('edit scene 3')
    expect(door.getAttribute('title')).toContain('Edit scene 3 of the ep01 script yourself')

    // Open, with his words in it — and the button that LANDS it is the priced one.
    still(view, { ...EMPTY_DRAFT, scene: { sceneId: three.sceneId, text: three.text } })
    const box = host.querySelector('#scene-edit-box') as HTMLTextAreaElement
    expect(box.value).toBe(three.text)
    expect(box.value).toContain(three.heading)
    const land = host.querySelector('.room-editbox button') as HTMLButtonElement
    expect(land.disabled).toBe(false)
    expect(land.querySelector('.cost')!.textContent).toBe('No model call · $0.00')

    // An empty box is refused before the click, in the sentence the API refuses with.
    still(view, { ...EMPTY_DRAFT, scene: { sceneId: three.sceneId, text: '  ' } })
    const refused = host.querySelector('.room-editbox button') as HTMLButtonElement
    expect(refused.disabled).toBe(true)
    expect(refused.querySelector('.cost')!.textContent).toBe(view.refusals.needsText)
  })
})

// ── Trap 2 · the doors ruled elsewhere are links, and they say which room ──────

describe('a decision made in another room is a link into that room', () => {
  it('renders every gate as a real anchor at the gate room’s own address', async () => {
    await openAGateOnEp02()
    const gateId = openGates(store)[0]!.gate.id
    still(read(ep02))

    const door = host.querySelector(`#gate-${gateId}`)!
    const link = door.querySelector('a.btn')!
    expect(link.getAttribute('href')).toBe(`/gate/${gateId}`)
    expect(link.textContent).toContain('Rule on the ep02 premise-brief')
    expect(link.querySelector('.cost')!.textContent).toContain('$0.00 to open it')
    // Honest about the room BEFORE the click, not after — and E5-3 (#83) built it, so there
    // is nothing left to warn him about and the link carries no title at all.
    expect(link.getAttribute('title')).toBeNull()
    expect(door.querySelector('.room-door__standing')!.textContent).toContain(
      'Open at round 1, waiting on you',
    )
  })

  it('renders the way back to the floor, and every arc at the arc page’s address', () => {
    still()

    const back = host.querySelector('.room-crumb__back')!
    expect(back.getAttribute('href')).toBe('/')
    expect(back.textContent).toBe('the floor')

    const arc = host.querySelector('.room-arc__name')!
    expect(arc.getAttribute('href')).toMatch(/^\/arc\/arc_/)
    expect(arc.getAttribute('title')).toContain('#85')
    // The pin is drawn and a landing is not — only ratifying makes one a fact (D8).
    const here = host.querySelectorAll('.room-wp[data-standing="here"]')
    expect(here).toHaveLength(1)
    expect(host.querySelectorAll('.room-wp[data-standing="ahead"]')).toHaveLength(2)
  })

  it('renders D12’s wall on the rail, in the sentence the producing buttons are refused with', () => {
    buildTheBoard()
    still()

    expect(host.querySelector('.room-rail__wall')!.textContent).toContain('ep01 is blocked')
    // Every stage the catalogue has is on the rail, and a blocked one renders disabled with
    // the reason in the cost line's place — the mockups' own pattern.
    expect(host.querySelectorAll('.room-offer[data-work]')).toHaveLength(9)
    const script = host.querySelector('#stage-write-the-script button') as HTMLButtonElement
    expect(script.disabled).toBe(true)
    expect(script.querySelector('.cost')!.textContent).toContain('already has a script')
  })
})

// ── Trap 6 · the ledger renders projection against actual ──────────────────────

describe('the ledger renders what a button projected against what the rows recorded', () => {
  it('itemises the run under its stage with that stage’s own declared cost beside it', async () => {
    await openAGateOnEp02()
    const view = read(ep02)
    still(view)

    const line = host.querySelector('.room-ledger tr[data-line]')!
    expect(line.getAttribute('data-line')).toBe('write-the-premise')
    expect(line.querySelector('.room-ledger__detail')!.textContent).toContain('calls')
    expect(line.querySelector('.room-ledger__projected')!.textContent).toContain(
      'your money, spent when you click',
    )
    expect(line.querySelector('td:last-child')!.textContent).toBe(view.ledger.lines[0]!.spent)

    const total = host.querySelector('#ledger-total')!
    expect(total.querySelector('td:last-child')!.textContent).toBe(view.ledger.spent)
    expect(total.textContent).toContain('calls')
  })

  it('says what is still offerable rather than a budget — that is the floor’s tile', () => {
    still()
    const projection = host.querySelector('.room-ledger__projection')!
    expect(projection.textContent).toContain('continuity-board — 1 Opus call')
    expect(projection.textContent).toContain('nothing in this build produces assets')
    // No meter, no cap, no budget anywhere on this screen (#88 owns that door).
    expect(host.querySelector('.tile__meter')).toBeNull()
  })
})

// ── The browser writes none of the words ───────────────────────────────────────

/**
 * The strongest proof available, and the one `chrome.test.tsx` and `floor.test.tsx` both use:
 * hand the screen a view of empty strings and see whether anything comes out. A word this
 * file authored shows up here as that word, and there is nowhere to hide it.
 */
describe('the episode room writes none of its own copy', () => {
  it('renders a blank view blank — every sentence on this screen came down the wire', () => {
    const blank = {
      episodeId: 'ep',
      label: '',
      number: 1,
      title: '',
      lifecycle: 'premise',
      show: { id: 'show', title: '' },
      where: '',
      floorHref: '/',
      floorName: '',
      track: [{ stage: '', standing: 'current', sentence: '' }],
      trackLabel: '',
      standing: '',
      writing: { line: [], written: [], gates: [], positions: null, wall: null },
      checks: {
        label: '',
        artifact: { id: '', kind: '', slot: '', version: 0, filePath: null, text: null, note: null },
        board: { sentence: '' },
        rows: [],
        gaps: [],
        clusters: [],
        rechecks: [],
        record: [],
        tune: [],
        refusals: {
          dismissNeedsNote: '',
          changeNeedsStatement: '',
          rewriteNeedsReplacement: '',
        },
        emptyBecause: null,
      },
      sweep: {
        sentence: '',
        nothingBecause: null,
        riders: [],
        ruled: [],
        refusals: { rejectNeedsNote: '' },
      },
      grid: {
        columns: [''],
        builtFrom: '',
        standing: '',
        freshness: '',
        stale: false,
        health: [],
        sentence: '',
        rows: [],
        transits: [],
        hazards: [],
        notYet: null,
      },
      findings: [],
      artifacts: [],
      noArtifacts: { lead: '', sentence: '' },
      rail: {
        stages: [],
        wall: null,
        queued: null,
        gates: [],
        noGates: { lead: '', sentence: '' },
        notInThisBuild: '',
      },
      arcs: [],
      noArcs: { lead: '', sentence: '' },
      ledger: { lines: [], totals: { calls: 0 }, spent: '', sentence: '', projection: '' },
      criedWolf: [],
      live: { runId: null, heading: '', latest: null, stream: [], seq: 0, entries: [], idle: true },
      // `explains` may not be blank — the component refuses one, which is E5-0's rule and the
      // only strings below that have to be non-empty for the screen to render at all.
      headings: Object.fromEntries(
        ['grid', 'artifacts', 'findings', 'rail', 'gates', 'riders', 'arcs', 'ledger', 'desk', 'criedWolf'].map(
          (key) => [key, { name: '', explains: '—' }],
        ),
      ),
      refusals: { needsText: '' },
      stream: { kinds: [], prose: [], since: 0 },
    } as unknown as EpisodeRoomView

    still(blank)
    // The separators are the stylesheet's marks rather than words. Everything else that could
    // appear here would be a sentence this file wrote.
    const said = (host.textContent ?? '').replaceAll(/[·—\d]/g, '').trim()
    expect(said).toBe('')
  })
})

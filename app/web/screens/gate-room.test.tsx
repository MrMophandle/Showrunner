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
import { gateIndexView, gateRoomView, type GateIndexView, type GateRoomView } from '../../server/gate-room.ts'
import { greyHarborFounded } from '../../server/fixture/founded.ts'
import { theLongPierExtraction } from '../../server/fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../../server/library.ts'
import { describeLLMBackend, type LLMReadiness } from '../../server/llm/choose.ts'
import { createFakeLLM } from '../../server/llm/fake.ts'
import { createRulings, openGates, type Rulings } from '../../server/runner/gate.ts'
import { SCRIPT_GATE_STAGE } from '../../server/runner/present-step.ts'
import { createRunner, type Runner } from '../../server/runner/runner.ts'
import { stageCatalogue } from '../../server/runner/stages.ts'
import { heldStill, stillTheSameNode } from '../chrome/held-still.ts'
import { applyProse, type Prose } from './Floor.tsx'
import {
  EMPTY_GATE_DRAFT,
  GateIndexScreen,
  GateRoomScreen,
  notesOnTheWire,
  seedGate,
  type GateDraft,
} from './GateRoom.tsx'

/**
 * **The gate room, in a real DOM, with a real gate under it** (E5-3, #83).
 *
 * `gate-room.test.ts` proves the sentences are right. This proves the screen: that the draft
 * is on the page as a document with the cards folded into it, that the dock is pinned and its
 * composer expands in place rather than as a popup, that a ruling landing moves nothing under
 * the reading eye, that no verb is ever disabled because a finding stands — and that the
 * browser writes not one word of any of it.
 *
 * ── The stylesheets are the ones that ship ──────────────────────────────────────
 * `chrome.css` AND `gate-room.css` are read off disk and put in the document, because
 * `held-still.ts` asks the CSSOM whether a box can grow. A test against a bundler's idea of
 * the stylesheet would pass on a page that shoved itself down the screen.
 */

const CHROME = readFileSync(join(import.meta.dirname, '..', 'chrome', 'chrome.css'), 'utf8')
const GATE = readFileSync(join(import.meta.dirname, 'gate-room.css'), 'utf8')
const READY: LLMReadiness = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x' })
const NOW = new Date('2026-08-11T12:00:00.000Z')

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
let runner: Runner
let rulings: Rulings
let ep01: string

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  for (const css of [CHROME, GATE]) {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  library = mkdtempSync(join(tmpdir(), 'showrunner-gate-screen-'))
  paths = initLibrary(library)
  store = openLibraryStore(paths)
  const harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  runner = createRunner(store, stageCatalogue(paths), events, createFakeLLM())
  rulings = createRulings(store, events, runner)
  ep01 = episodesOf(store, seasonsOf(store, harbor.show.id)[0]!.id)[0]!.id
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.head.replaceChildren()
  store.close()
  rmSync(library, { recursive: true, force: true })
})

const factOf = (entity: string, needle: string): string => {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

/** The Long Pier's planted contradictions, raised for nothing by the rules that read rows. */
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

let runId: string

/** ep01's hand-written script, in front of Ryan at the door that produces nothing. */
async function present(): Promise<string> {
  const run = runner.enqueueRun({ episodeId: ep01, stage: SCRIPT_GATE_STAGE })
  await runner.settled(run.id)
  runId = run.id
  return openGates(store)[0]!.gate.id
}

const read = (gateId: string): GateRoomView => gateRoomView(store, paths, gateId, READY, NOW)!

function render(node: React.ReactNode): void {
  act(() => root.render(node))
}

/** The screen, over one read, with nothing arriving. */
function still(view: GateRoomView, draft: GateDraft = EMPTY_GATE_DRAFT): void {
  render(
    <div className="wrap" data-room="gate-room">
      <GateRoomScreen
        view={view}
        prose={seedGate({}, view)}
        draft={draft}
        busy={null}
        problem={null}
        onDraft={() => {}}
        onRule={() => {}}
        onPredraft={() => {}}
        onApply={() => {}}
        onPropose={() => {}}
        onDismiss={() => {}}
        onRuleRider={() => {}}
      />
    </div>,
  )
}

/**
 * The screen as the app wires it: subscribed to the real log, re-reading the real view on a
 * transition and patching the prose in place on everything else. This is `OneGate`'s two
 * effects with `fetch` and `EventSource` taken out and the same functions underneath.
 */
function Harness({ log, gateId }: { log: EventLog; gateId: string }) {
  const [view, setView] = useState<GateRoomView>(() => read(gateId))
  const [prose, setProse] = useState<Prose>(() => seedGate({}, read(gateId)))
  const [draft, setDraft] = useState<GateDraft>(EMPTY_GATE_DRAFT)

  useEffect(
    () =>
      log.subscribe((record: EventRecord) => {
        setProse((held) => applyProse(held, record))
        if (record.kind === 'step-progress' || record.kind === 'step-chunk') return
        setView(read(gateId))
      }),
    [log, gateId],
  )

  return (
    <div className="wrap" data-room="gate-room">
      <GateRoomScreen
        view={view}
        prose={prose}
        draft={draft}
        busy={null}
        problem={null}
        onDraft={(next) => setDraft((held) => ({ ...held, ...next }))}
        onRule={() => {}}
        onPredraft={() => {}}
        onApply={() => {}}
        onPropose={() => {}}
        onDismiss={() => {}}
        onRuleRider={() => {}}
      />
    </div>
  )
}

const gate = () => host.querySelector('.gate')!

// ── Trap 3 · the artifact is the page ──────────────────────────────────────────

describe('the draft is on the page as a document, with the findings folded into it', () => {
  it('renders the script itself, and every card sits at the span it is anchored to', async () => {
    buildTheBoard()
    const gateId = await present()
    still(read(gateId))

    const doc = host.querySelector('.gate-doc')!
    // The whole draft is here — not a filename, not an excerpt (D15, 4.6).
    expect(doc.textContent).toContain('INT. GREY HARBOR STATION')
    const marks = [...doc.querySelectorAll('mark')]
    expect(marks.length).toBeGreaterThan(0)

    for (const mark of marks) {
      // The card the mark belongs to is the very next element in the document.
      const card = mark.nextElementSibling!
      expect(card.className).toBe('gate-card')
      expect(card.id).toBe(mark.id.replace('span-', ''))
      // …and it is INSIDE the script's own box, which is what "folded in" means. A findings
      // list beside the draft is the failure mode this whole layout exists to avoid.
      expect(host.querySelector('.gate-fold')!.contains(card)).toBe(true)
    }
  })

  it('says severity and confidence apart, and marks the blocking without vetoing', async () => {
    buildTheBoard()
    const gateId = await present()
    still(read(gateId))

    const blocking = host.querySelector('.gate-card[data-blocking="true"]')!
    expect(blocking).not.toBeNull()
    const say = blocking.querySelector('.gate-say__meta')!
    expect(say.textContent).toContain('severity')
    expect(say.textContent).toContain('confidence')
    // D12, in words, on the card — so a red mark at a gate never reads as a veto over it.
    expect(blocking.textContent).toContain('never this gate (D12)')
    // And the mark that points at it wears the same standing, said as data rather than only
    // as a colour.
    expect(host.querySelector('mark[data-blocking="true"]')).not.toBeNull()
  })

  it('folds 4.3’s three remediations behind a disclosure, and opens them in place', async () => {
    buildTheBoard()
    const gateId = await present()
    const view = read(gateId)
    const findingId = view.fold.pieces.flatMap((piece) =>
      piece.kind === 'finding' ? piece.card.says.map((say) => say.findingId) : [],
    )[0]!
    still(view)

    // Closed by default: a card is INSIDE the script here, and four open boxes are taller
    // than the draft they are about. The fold says what is behind it before it is opened.
    const card = host.querySelector('.gate-say')!
    expect(card.querySelectorAll('button.btn')).toHaveLength(0)
    expect(card.querySelector('.editlink')!.textContent).toContain('What you may do about the')

    still(view, { ...EMPTY_GATE_DRAFT, openSay: findingId })

    const buttons = [...host.querySelector(`#finding-${findingId}`)!.querySelectorAll('button.btn')]
    expect(buttons).toHaveLength(4)
    expect(buttons.map((one) => one.textContent).join(' ')).toContain('Pre-draft a rewrite')
    // …and it opened inside the card, inside the script. Nothing navigated anywhere.
    expect(host.querySelector('.gate-fold')!.contains(buttons[0]!)).toBe(true)
    // The apply is disabled while the box is empty, in the API's own sentence off the wire.
    const apply = buttons.find((one) => one.textContent?.includes('Apply the rewrite'))!
    expect((apply as HTMLButtonElement).disabled).toBe(true)
    expect(apply.querySelector('.cost')!.textContent).toBe(view.refusals.rewriteNeedsReplacement)
  })
})

// ── Trap 4 · the dock is pinned and the composer expands in place ──────────────

describe('the decision dock', () => {
  it('is pinned to the bottom and out of flow, so nothing it does can move the page', async () => {
    const gateId = await present()
    still(read(gateId))

    const dock = host.querySelector('.gate-dock')!
    expect(getComputedStyle(dock).position).toBe('fixed')
    expect(getComputedStyle(dock).bottom).toBe('0px')
    // And the page reserves its height rather than being covered by it — a decision bar on
    // top of the last line of the script is the same failure as a page that moves.
    expect(getComputedStyle(gate()).paddingBottom).not.toBe('0px')
  })

  it('states four verbs as full sentences, with what each costs', async () => {
    buildTheBoard()
    const gateId = await present()
    still(read(gateId))

    const verbs = [...host.querySelectorAll('.gate-dock__verbs button.btn')]
    expect(verbs).toHaveLength(4)
    const said = verbs.map((one) => one.textContent ?? '')
    expect(said[0]).toContain('Approve the ep01 script')
    expect(said[1]).toContain('OVER')
    expect(said[2]).toContain('Reject the ep01 script with notes')
    expect(said[3]).toContain('Put the ep01 script down with your note')
    // No generic verbs anywhere: every one names its object, and none is "Launch" or "Go".
    for (const button of verbs) {
      expect(button.querySelector('.cost')!.textContent).not.toBe('')
      expect(button.textContent).not.toMatch(/^(Launch|Run|Go|Do)\b/)
    }
  })

  it('expands the composer in place when a note-taking verb is pressed — never a popup', async () => {
    const gateId = await present()
    const view = read(gateId)
    still(view)
    expect(host.querySelector('#composer-close')).toBeNull()

    still(view, { ...EMPTY_GATE_DRAFT, composer: 'close' })

    const composer = host.querySelector('#composer-close')!
    // It lives INSIDE the dock — no dialog, no overlay, and the draft is still on screen.
    expect(host.querySelector('.gate-dock')!.contains(composer)).toBe(true)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('.gate-doc')).not.toBeNull()
    expect(composer.textContent).toContain('Put the ep01 script down')
  })

  it('offers a depth picker per note, and adding one adds a picker of its own', async () => {
    const gateId = await present()
    const view = read(gateId)
    still(view, {
      ...EMPTY_GATE_DRAFT,
      composer: 'reject',
      notes: [
        { note: 'the pier scene is wrong', depth: '', target: '' },
        { note: 'and the outline never turns', depth: 'outline', target: '' },
      ],
    })

    const blocks = [...host.querySelectorAll('.gate-composer__note')]
    expect(blocks).toHaveLength(2)
    // Each note has its OWN radio group, which is what "per note" means — D21 routes a note,
    // never a rejection, and one depth for a whole rejection would send one of two
    // instructions to the wrong artifact forever.
    expect(blocks[0]!.querySelectorAll('input[name="depth-0"]')).toHaveLength(view.dock.depths.length)
    expect(blocks[1]!.querySelectorAll('input[name="depth-1"]')).toHaveLength(view.dock.depths.length)
    expect(blocks[1]!.querySelector('.gate-depth[data-picked="true"]')!.getAttribute('data-depth')).toBe(
      'outline',
    )
    // Every depth says what it would do, before it is picked.
    for (const label of blocks[0]!.querySelectorAll('.gate-depth')) {
      expect(label.textContent!.length).toBeGreaterThan(20)
    }
  })

  it('asks which one only for the depths that name one', async () => {
    const gateId = await present()
    const view = read(gateId)

    still(view, {
      ...EMPTY_GATE_DRAFT,
      composer: 'reject',
      notes: [{ note: 'n', depth: 'outline', target: '' }],
    })
    expect(host.querySelector('#target-0')).toBeNull()

    still(view, {
      ...EMPTY_GATE_DRAFT,
      composer: 'reject',
      notes: [{ note: 'n', depth: 'scene', target: '' }],
    })
    expect(host.querySelector('#target-0')).not.toBeNull()
  })

  it('disables the confirm while every note is empty, in the API’s own sentence', async () => {
    const gateId = await present()
    const view = read(gateId)

    still(view, { ...EMPTY_GATE_DRAFT, composer: 'close' })
    const blocked = host.querySelector('#composer-close button.btn') as HTMLButtonElement
    expect(blocked.disabled).toBe(true)
    // The exact string the POST refuses with — never a paraphrase (E4-7's rule).
    expect(blocked.querySelector('.cost')!.textContent).toBe(view.dock.closeNeedsNote)
    // …and it is NOT the rejection's, because a close reopens nothing.
    expect(blocked.querySelector('.cost')!.textContent).not.toBe(view.dock.rejectNeedsNote)

    still(view, {
      ...EMPTY_GATE_DRAFT,
      composer: 'close',
      notes: [{ note: 'Not this week.', depth: '', target: '' }],
    })
    const ready = host.querySelector('#composer-close button.btn') as HTMLButtonElement
    expect(ready.disabled).toBe(false)
    expect(ready.querySelector('.cost')!.textContent).toBe(view.dock.close.cost)
  })

  it('collapses on Esc with nothing filed, and what he typed stays held', async () => {
    const gateId = await present()
    const view = read(gateId)
    const typed = [{ note: 'Not this week.', depth: '' as const, target: '' }]
    let draft: GateDraft = { ...EMPTY_GATE_DRAFT, composer: 'close', notes: typed }
    const ruled: string[] = []

    const paint = () =>
      render(
        <div className="wrap" data-room="gate-room">
          <GateRoomScreen
            view={view}
            prose={{}}
            draft={draft}
            busy={null}
            problem={null}
            onDraft={(next) => {
              draft = { ...draft, ...next }
              paint()
            }}
            onRule={(verdict) => ruled.push(verdict)}
            onPredraft={() => {}}
            onApply={() => {}}
            onPropose={() => {}}
            onDismiss={() => {}}
            onRuleRider={() => {}}
          />
        </div>,
      )
    paint()
    expect(host.querySelector('#composer-close')).not.toBeNull()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(host.querySelector('#composer-close')).toBeNull()
    // Nothing filed — Esc is a cancel, and a cancel that ruled would be the worst possible
    // reading of a keystroke on this page.
    expect(ruled).toEqual([])
    // And the notes are still held: pressing the verb again brings his words back.
    expect(draft.notes).toEqual(typed)
  })

  it('drops a note he started and left, rather than writing an empty one forever', () => {
    expect(
      notesOnTheWire([
        { note: 'the pier scene is wrong', depth: 'scene', target: 'scene-4' },
        { note: '   ', depth: 'outline', target: '' },
      ]),
    ).toEqual([{ note: 'the pier scene is wrong', depth: 'scene', target: 'scene-4' }])
    // An unrouted note sends no depth at all rather than an empty string — '' is not one of
    // the six, and the API would refuse it.
    expect(notesOnTheWire([{ note: 'n', depth: '', target: '' }])).toEqual([{ note: 'n' }])
  })
})

// ── Trap 6 · no precondition enters any verb ───────────────────────────────────

describe('no verb on this page is ever disabled because a finding stands', () => {
  it('renders all four pressable with two deterministic findings on the draft', async () => {
    buildTheBoard()
    const gateId = await present()
    still(read(gateId))

    const verbs = [...host.querySelectorAll('.gate-dock__verbs button.btn')] as HTMLButtonElement[]
    expect(verbs.map((one) => one.disabled)).toEqual([false, false, false, false])
    // The wall is on the page, loud, and it says in words that it is not standing here.
    expect(gate().textContent).toContain('never this gate (D12)')
    expect(host.querySelector('.gate-dock__headline')!.textContent).toContain(
      '2 deterministic findings',
    )
  })

  it('disables all four only once the round is ruled, in the wire’s own sentence', async () => {
    const gateId = await present()
    rulings.close(gateId, { notes: [{ note: 'Not this week.' }] })
    await runner.settled(runId)
    const view = read(gateId)
    still(view)

    const verbs = [...host.querySelectorAll('.gate-dock__verbs button.btn')] as HTMLButtonElement[]
    expect(verbs.map((one) => one.disabled)).toEqual([true, true, true, true])
    expect(verbs[0]!.querySelector('.cost')!.textContent).toBe(view.dock.approve.blockedBecause)
  })
})

// ── Trap 5 · liveness, and the whole page holding still ────────────────────────

describe('the whole page holds still while a real ruling lands under it', () => {
  it('never moves the card Ryan is reading when a round is appended', async () => {
    buildTheBoard()
    const gateId = await present()
    render(<Harness log={events} gateId={gateId} />)

    // What his eye is on: the fold that opens a finding's remediations, in the middle of the
    // script. Everything that changes when a ruling lands — the chip, the standing line, the
    // round history, the dock's headline — is either above it in a fixed box or out of flow.
    const reading = host.querySelector('.gate-card .editlink')!
    const dockBefore = host.querySelector('.gate-dock')!

    // The ruling RESUMES the run, so the events keep landing after the call returns — the
    // whole settle is inside `act` so every one of them is a render this assertion watched.
    await heldStill(gate(), reading, async () => {
      await act(async () => {
        rulings.reject(gateId, { notes: [{ note: 'the pier scene is not there yet' }] })
        await runner.settled(runId)
      })
    })

    // The round really did land: it is on the page, in reserved space.
    expect(host.querySelector('#round-1')!.textContent).toContain('from before your last rejection')
    expect(host.querySelector('#round-2')).not.toBeNull()
    // And the dock updated in place rather than being re-created under his hand.
    stillTheSameNode(dockBefore, host.querySelector('.gate-dock'))
  })

  it('reserves the space before anything arrives — every region that can change is a fixed box', async () => {
    buildTheBoard()
    const gateId = await present()
    still(read(gateId))

    for (const selector of [
      '.gate-head',
      '.gate-fold',
      '.gate-body--board',
      '.gate-body--loop',
      '.gate-body--rounds',
      '.gate-body--riders',
      '.gate-body--live',
    ]) {
      const height = getComputedStyle(host.querySelector(selector)!).height
      expect(height, `${selector} has no fixed height, so the page can grow above a button`).not.toBe(
        'auto',
      )
      expect(height).not.toBe('')
    }
    // A `max-height` on anything IN FLOW would be the same defect on a longer fuse. The dock
    // has one and is exempt: it is `position: fixed`, so it is out of flow and can grow to a
    // cap without carrying a single pixel of the page with it.
    expect(GATE.replaceAll(/\.gate-dock \{[^}]*\}/g, '')).not.toMatch(/max-height\s*:/)
  })

  it('replaces the words in the live line without replacing the element', async () => {
    const gateId = await present()
    render(<Harness log={events} gateId={gateId} />)
    const line = () => host.querySelector(`#live-${gateId} .live-region__latest`)!

    const first = line()
    act(() => {
      events.append({ kind: 'step-progress', runId, episodeId: ep01, summary: 'Reading scene 1' })
    })
    expect(line().textContent).toBe('Reading scene 1')

    act(() => {
      events.append({ kind: 'step-progress', runId, episodeId: ep01, summary: 'Reading scene 2' })
    })
    // The same node with new words in it: focus, selection and scroll position survive.
    stillTheSameNode(first, line())
    expect(line().textContent).toBe('Reading scene 2')
  })

  it('does not say a word twice when the stream replays what the read already handed over', async () => {
    const gateId = await present()
    for (const summary of ['The ', 'pier ', 'is ']) {
      events.append({ kind: 'step-chunk', runId, episodeId: ep01, summary })
    }
    render(<Harness log={events} gateId={gateId} />)
    const stream = () => host.querySelector(`#live-${gateId} .live-region__stream`)!
    expect(stream().textContent).toBe('The pier is ')

    // The replay on connect delivers the very same rows again, and the seq protocol drops
    // them (E5-1). Without it the line renders every word twice.
    act(() => {
      for (const record of store.all<EventRecord>('SELECT * FROM event ORDER BY seq')) {
        events.append({
          kind: 'step-chunk',
          runId,
          episodeId: ep01,
          summary: (record as unknown as { summary: string }).summary,
        })
      }
    })
    expect(stream().textContent).not.toContain('The pier is The pier is ')
  })
})

// ── The index ──────────────────────────────────────────────────────────────────

describe('the index is a list of sentences that link', () => {
  it('renders each open gate as a real anchor at its own address', async () => {
    const gateId = await present()
    render(<GateIndexScreen view={gateIndexView(store, paths, NOW)} />)

    const row = host.querySelector(`#open-${gateId}`)!
    expect(row.querySelector('.gate-index__sentence')!.textContent).toContain('ep01 — the ep01 script')
    const link = row.querySelector('a.btn')!
    expect(link.getAttribute('href')).toBe(`/gate/${gateId}`)
    expect(link.querySelector('.cost')!.textContent).toContain('$0.00 to open it')
  })

  it('says so honestly when nothing is waiting', () => {
    render(<GateIndexScreen view={gateIndexView(store, paths, NOW)} />)

    expect(host.querySelector('.empty')!.textContent).toContain('Nothing is waiting on your word')
    expect(host.querySelector('.gate-index__row')).toBeNull()
  })
})

// ── It writes no word ──────────────────────────────────────────────────────────

/**
 * The strongest proof available, and the one every screen in this epic takes: hand it a view
 * of empty strings and see whether anything comes out. A word this file authored shows up here
 * as that word, and there is nowhere to hide it.
 */
describe('the gate room writes none of its own copy', () => {
  it('renders a blank view blank — every sentence on this screen came down the wire', () => {
    const blank = {
      gateId: 'gate',
      runId: 'run',
      floorHref: '/',
      floorName: '',
      where: '',
      episodeId: 'ep',
      episodeLabel: '',
      episodeTitle: '',
      episodeCrumb: '',
      episodeHref: '/episode/ep',
      episodeRoom: '',
      episodeRoomNotYet: null,
      title: '',
      chip: '',
      standing: '',
      round: 1,
      isOpen: true,
      fold: { docHeader: '', pieces: [], note: null, sentence: '' },
      board: { artifactId: '', version: 0, rows: [], convened: 0, read: 0, standing: 0, gaps: 0, sentence: '' },
      loop: { sentence: '', drafts: [], none: null, converged: false, clean: false, blocking: [] },
      rounds: [],
      sweep: {
        episode: { id: 'ep', label: '', title: '', lifecycle: 'script', abandonedAt: null },
        show: { id: 'show', title: '' },
        owed: false,
        riders: [],
        ruled: [],
        sentence: '',
        nothingBecause: null,
        refusals: { rejectNeedsNote: '' },
      },
      dock: {
        headline: '',
        approve: { sentence: '', cost: '', enabled: true, blockedBecause: null },
        override: { sentence: '', cost: '', enabled: true, blockedBecause: null },
        reject: { sentence: '', cost: '', enabled: true, blockedBecause: null },
        close: { sentence: '', cost: '', enabled: true, blockedBecause: null },
        depths: [],
        rejectComposer: '',
        closeComposer: '',
        rejectNeedsNote: '',
        closeNeedsNote: '',
        escape: '',
      },
      live: { runId: 'run', heading: '', latest: null, stream: [], seq: 0, entries: [], idle: true },
      // `explains` may not be blank — the component refuses one, which is E5-0's rule and the
      // only strings below that have to be non-empty for the screen to render at all.
      headings: Object.fromEntries(
        ['artifact', 'board', 'loop', 'rounds', 'riders', 'live'].map((key) => [
          key,
          { name: '', explains: '—' },
        ]),
      ),
      refusals: { dismissNeedsNote: '', changeNeedsStatement: '', rewriteNeedsReplacement: '' },
      stream: { kinds: [], prose: [], since: 0 },
    } as unknown as GateRoomView

    still(blank)
    // The separators are the stylesheet's marks rather than words. Everything else that could
    // appear here would be a sentence this file wrote.
    const said = (host.textContent ?? '').replaceAll(/[·—\d]/g, '').trim()
    expect(said).toBe('')
  })

  it('writes only the composer’s own “one more field” label, and nothing about the product', () => {
    const blank = {
      heading: { name: '', explains: '—' },
      gates: [],
      empty: { lead: '', sentence: '' },
      stream: { kinds: [], prose: [], since: 0 },
    } as unknown as GateIndexView

    render(<GateIndexScreen view={blank} />)
    expect((host.textContent ?? '').replaceAll(/[·—\d]/g, '').trim()).toBe('')
  })
})

// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../server/db/migrate.ts'
import { openStore, type Store } from '../../server/db/store.ts'
import { createEpisode, createSeason, createShow } from '../../server/domain/spine.ts'
import { createEventLog, type EventLog, type EventRecord } from '../../server/events.ts'
import type { Offer } from '../../server/operating.ts'
import { recordRun } from '../../server/runner/run.ts'
import { scaffoldStage } from '../../server/runner/stage-fixture.ts'
import { Card, CardRow, Section } from './Card.tsx'
import { EmptyState } from './EmptyState.tsx'
import { Freshness } from './Freshness.tsx'
import { heldStill, ReflowError, stillTheSameNode } from './held-still.ts'
import { LifecycleTrack, type TrackStop } from './LifecycleTrack.tsx'
import { LiveRegion, type LiveEntry } from './LiveRegion.tsx'
import { SectionHeader } from './SectionHeader.tsx'
import { SentenceButton, SentenceLink } from './SentenceButton.tsx'
import { Glossed, GlossaryProvider, Term } from './Term.tsx'
import { TwoValues } from './TwoValues.tsx'
import { glossary } from '../../server/glossary.ts'

/**
 * The chrome, in a real DOM (E5-0, #80).
 *
 * `drift.test.ts` proves the stylesheet came out of the mockups. This file proves the
 * three rules the epic's charter turned into components: **regions hold still**, **a
 * section explains itself**, and **the browser writes no copy**.
 *
 * It renders into jsdom rather than to a string, because every one of those is about what
 * the DOM does when something changes, and `renderToString` renders once and stops.
 * `chrome.css` is read off disk and put in the document, so what the assertions see is the
 * stylesheet that ships rather than a bundler's idea of it.
 */

const CHROME = readFileSync(join(import.meta.dirname, 'chrome.css'), 'utf8')

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let host: HTMLElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const style = document.createElement('style')
  style.textContent = CHROME
  document.head.append(style)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.head.replaceChildren()
})

function render(node: React.ReactNode): void {
  act(() => root.render(node))
}

const READY: Offer = {
  sentence: 'Write the ep07 outline',
  cost: '1 Opus call · ~$0.85',
  enabled: true,
  blockedBecause: null,
}

const BLOCKED: Offer = {
  sentence: 'Write the ep08 outline',
  cost: '1 Opus call · ~$0.85',
  enabled: false,
  blockedBecause: 'blocked — the ep08 premise is not greenlit yet',
}

// ── The region that holds still ─────────────────────────────────────────────────

/**
 * A screen, as every screen in this epic will be built: a heading, a live region, and
 * the thing Ryan is reaching for underneath it. The button is deliberately BELOW the
 * region, because that is the arrangement his complaint was about — the wall of changing
 * text was above the button he was hunting for.
 *
 * The subscription is the real one. `events.subscribe` is what `GET /api/events` itself
 * subscribes to (`app.ts`), so what arrives here is the same record, off the same
 * fan-out, in the same order the browser would receive it over SSE — with the socket
 * taken out because a socket is not what is being tested.
 */
function Screen({ events, naive = false }: { events: EventLog; naive?: boolean }) {
  const [latest, setLatest] = useState<string | null>(null)
  const [stream, setStream] = useState<string[]>([])
  const [entries, setEntries] = useState<LiveEntry[]>([])

  useEffect(
    () =>
      events.subscribe((record: EventRecord) => {
        if (record.kind === 'step-progress') setLatest(record.summary)
        else if (record.kind === 'step-chunk') setStream((held) => [...held, record.summary ?? ''])
        else setEntries((held) => [...held, { seq: record.seq, sentence: record.summary ?? '' }])
      }),
    [events],
  )

  return (
    <div className="wrap" id="screen">
      <h1>The Quiet Deck</h1>
      <p className="crumb">ep05 · Dead Light · Season 1</p>
      {naive ? (
        <NaiveRegion latest={latest} stream={stream} entries={entries} />
      ) : (
        <LiveRegion
          id="ep05-run"
          heading="Generating · holds image-api lock"
          latest={latest}
          stream={stream}
          entries={entries}
        />
      )}
      <SentenceButton offer={READY} onClick={() => {}} />
    </div>
  )
}

/**
 * The scaffolding's shape, kept alive on purpose: a box that simply holds what has
 * arrived. Every line wraps, every row appends, and the whole thing grows downward — this
 * is what Ryan was reading over, and it is here so that `heldStill` can be shown to fail
 * on it. An assertion that has never failed is a decoration.
 */
function NaiveRegion({
  latest,
  stream,
  entries,
}: {
  latest: string | null
  stream: readonly string[]
  entries: readonly LiveEntry[]
}) {
  return (
    <div>
      <p>{latest}</p>
      <p>{stream.join('')}</p>
      <ul>
        {entries.map((entry) => (
          <li key={entry.seq}>{entry.sentence}</li>
        ))}
      </ul>
    </div>
  )
}

describe('the live region — Ryan’s first criterion, as an assertion', () => {
  let store: Store
  let events: EventLog
  let runId: string
  let episodeId: string

  beforeEach(() => {
    store = openStore(':memory:')
    migrate(store)
    events = createEventLog(store)
    const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
    const season = createSeason(store, { showId: show.id, number: 1 })
    episodeId = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' }).id
    runId = recordRun(store, scaffoldStage('produce', []), episodeId).id
  })

  afterEach(() => store.close())

  /** One real event, appended to the real log, delivered down the real fan-out. */
  function arrive(kind: EventRecord['kind'], summary: string): void {
    act(() => {
      events.append({ kind, runId, episodeId, summary })
    })
  }

  const button = () => host.querySelector('button')!

  it('holds the button still across a whole run’s worth of events', async () => {
    render(<Screen events={events} />)
    const screen = host.querySelector('#screen')!

    // A latest-wins line replacing itself, four times.
    await heldStill(screen, button(), () => arrive('step-progress', 'Shot 8 of 14 — scene 2'))
    await heldStill(screen, button(), () =>
      arrive('step-progress', 'Shot 9 of 14 — scene 2, the corridor, holding the image-api lock'),
    )
    await heldStill(screen, button(), () =>
      arrive(
        'step-progress',
        'Shot 10 of 14 — scene 3, the quiet deck, a sentence long enough that it would ' +
          'wrap onto a second line and then a third if anything let it',
      ),
    )

    // An accumulating stream, arriving a sentence at a time.
    for (const piece of [
      '“emergency lighting dies section by section ',
      'down the spine of the ship, ',
      'and the dark comes up behind it like water.” ',
      'The corridor holds its breath. ',
    ]) {
      await heldStill(screen, button(), () => arrive('step-chunk', piece))
    }

    // Transitions landing in the log, ten of them — well past what fits in its box.
    for (let n = 0; n < 10; n += 1) {
      await heldStill(screen, button(), () => arrive('step-done', `step ${n} finished`))
    }
  })

  it('replaces the latest-wins line’s text without replacing the element', async () => {
    render(<Screen events={events} />)
    const line = () => host.querySelector('.live-region__latest')!

    const first = line()
    arrive('step-progress', 'Shot 8 of 14 — scene 2')
    expect(line().textContent).toBe('Shot 8 of 14 — scene 2')

    arrive('step-progress', 'Shot 9 of 14 — scene 2, the corridor')
    // The same node, with new words in it: latest-wins is a replacement of the TEXT.
    stillTheSameNode(first, line())
    expect(line().textContent).toBe('Shot 9 of 14 — scene 2, the corridor')
  })

  it('accumulates the stream inside its own box, and the log inside its own', async () => {
    render(<Screen events={events} />)

    arrive('step-chunk', 'the dark comes up ')
    arrive('step-chunk', 'behind it like water')
    expect(host.querySelector('.live-region__stream')!.textContent).toBe(
      'the dark comes up behind it like water',
    )

    for (let n = 0; n < 6; n += 1) arrive('run-resumed', `resumed ${n}`)
    expect(host.querySelectorAll('.live-region__entry')).toHaveLength(6)

    // Six rows arrived and the box is the height it was declared at, not six rows tall.
    expect(getComputedStyle(host.querySelector('.live-region__log')!).height).toBe('9rem')
  })

  it('reserves the space before anything arrives, so starting a run moves nothing', async () => {
    render(<Screen events={events} />)
    const screen = host.querySelector('#screen')!

    // The empty→filled transition is the one that catches a region built without reserved
    // space: it is the first event of every run, and it is where the page jumps.
    await heldStill(screen, button(), () => arrive('run-started', 'the run started'))
    await heldStill(screen, button(), () => arrive('step-progress', 'Shot 1 of 14'))
  })

  it('fails on a region built the scaffolding’s way — which is how we know it bites', async () => {
    render(<Screen events={events} naive />)
    const screen = host.querySelector('#screen')!

    await expect(
      heldStill(screen, button(), () => arrive('step-progress', 'Shot 8 of 14 — scene 2')),
    ).rejects.toThrow(ReflowError)

    // And it says which box, rather than just "something moved".
    let thrown: unknown
    try {
      await heldStill(screen, button(), () => arrive('step-chunk', 'more words arriving'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ReflowError)
    const reflow = thrown as ReflowError
    expect(reflow.reflows[0]!.where).toContain('div')
    expect(reflow.message).toContain('LiveRegion')
  })

  it('fails when the element being read is replaced rather than updated', () => {
    render(<Screen events={events} />)
    const line = host.querySelector('.live-region__latest')!
    render(<p className="live-region__latest">a different tree entirely</p>)
    expect(() => stillTheSameNode(line, host.querySelector('.live-region__latest'))).toThrow(
      /replaced rather than updated/,
    )
  })
})

// ── A section that explains itself ──────────────────────────────────────────────

describe('a section header — Ryan’s second criterion, made structural', () => {
  it('renders the name and the plain-words explanation together', () => {
    render(<SectionHeader name="Artifacts" explains="freshness is computed, never remembered" />)

    expect(host.querySelector('h2')!.textContent).toBe('Artifacts')
    expect(host.querySelector('.section-h__explains')!.textContent).toBe(
      'freshness is computed, never remembered',
    )
  })

  it('refuses a heading with nothing beside it, rather than rendering a bare schema noun', () => {
    expect(() => render(<SectionHeader name="Provenance" explains="" />)).toThrow(
      /without a plain-words explanation/,
    )
    expect(() => render(<SectionHeader name="Provenance" explains="   " />)).toThrow(
      /schema noun on its own/,
    )
  })

  it('carries the obligation onto every titled card, because Section takes Explained', () => {
    render(
      <Section name="Findings" explains="checks argue, never veto">
        <CardRow>a finding</CardRow>
      </Section>,
    )
    expect(host.querySelector('.card .section-h__explains')!.textContent).toBe(
      'checks argue, never veto',
    )
  })

  /**
   * The compiler stops a screen leaving the explanation OUT — `explains` has no default.
   * This is the other half: a screen cannot route around the component by opening a
   * heading tag of its own. `SectionHeader.tsx` is the only file in the cockpit allowed
   * to write one, and this reads the directories to prove it rather than trusting a rule.
   *
   * It walks `app/web/screens/` as well as the chrome, because that is where the rule was
   * always going to be broken first — E5-1's floor is the first screen to live there, and a
   * `<h2>` inside a room is exactly the bare schema noun this component exists to prevent.
   */
  it('is the only file in the chrome or a screen that opens a heading element', () => {
    const here = import.meta.dirname
    const screens = join(here, '..', 'screens')
    const offenders = [
      ...readdirSync(here).map((name) => ({ dir: here, name, at: `chrome/${name}` })),
      ...readdirSync(screens).map((name) => ({ dir: screens, name, at: `screens/${name}` })),
    ]
      .filter(({ name }) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
      .filter(({ name }) => name !== 'SectionHeader.tsx')
      .filter(({ dir, name }) => /<h[23][\s>]/.test(readFileSync(join(dir, name), 'utf8')))
      .map(({ at }) => at)

    expect(offenders, 'a heading outside SectionHeader.tsx has no explanation beside it').toEqual([])
  })

  /**
   * The count badge the mockups draw beside a heading — "NEEDS YOU ③" — reaches the DOM
   * without displacing the obligation: the name and the plain words are still both there,
   * and still in that order.
   */
  it('lets a heading carry a badge without letting one stand in for the explanation', () => {
    render(
      <SectionHeader name="Needs you" explains="what is holding work still">
        <span className="section-h__count">3</span>
      </SectionHeader>,
    )

    expect(host.querySelector('h2')!.textContent).toBe('Needs you')
    expect(host.querySelector('.section-h__explains')!.textContent).toBe('what is holding work still')
    expect(host.querySelector('.section-h__count')!.textContent).toBe('3')
    expect(() =>
      render(
        <SectionHeader name="Needs you" explains="">
          <span>3</span>
        </SectionHeader>,
      ),
    ).toThrow(/without a plain-words explanation/)
  })
})

// ── No copy in the browser ──────────────────────────────────────────────────────

/**
 * E4-7's rule was that nothing in `app/web/` may hold a refusal string. #80 extends it to
 * the whole chrome: no label, no cost line, no room name, no reason is authored in a
 * component.
 *
 * The proof is the strongest one available — hand every component nothing and see whether
 * anything comes out. A component that renders a single word of its own shows up here as
 * that word, and there is nowhere to hide it.
 */
describe('the browser writes none of the words', () => {
  const nothing = (): string => (host.textContent ?? '').replaceAll('·', '').trim()

  it('the sentence button renders what the wire said and nothing else', () => {
    render(
      <SentenceButton
        offer={{ sentence: '', cost: '', enabled: true, blockedBecause: null }}
        onClick={() => {}}
      />,
    )
    expect(nothing()).toBe('')
  })

  it('the honest empty state has no words of its own', () => {
    render(<EmptyState lead="" sentence="" />)
    expect(nothing()).toBe('')
  })

  it('the freshness sentence has no words of its own', () => {
    render(<Freshness standing="" because={null} stale={false} />)
    expect(nothing()).toBe('')
  })

  it('the live region has no words of its own', () => {
    render(<LiveRegion id="quiet" heading="" latest={null} stream={[]} entries={[]} />)
    expect(nothing()).toBe('')
  })

  it('the readings carry the axis names the server gave them', () => {
    render(<TwoValues readings={[{ label: '', value: '' }, { label: '', value: '' }]} />)
    expect(nothing()).toBe('')
  })

  it('a card has no words of its own', () => {
    render(<Card>{null}</Card>)
    expect(nothing()).toBe('')
  })

  it('the lifecycle track has no words of its own — the stage names are the schema’s', () => {
    render(<LifecycleTrack stops={[{ stage: '', standing: 'current', sentence: '' }]} label="" />)
    expect(nothing()).toBe('')
  })

  it('the link form of the sentence renders what the wire said and nothing else', () => {
    render(
      <SentenceLink
        offer={{ sentence: '', cost: '', enabled: true, blockedBecause: null }}
        href="/gate/x"
      />,
    )
    expect(nothing()).toBe('')
  })

  it('the term mark writes no word and no definition of its own', () => {
    // Both halves are the server's: the word came out of its sentence, the definition out
    // of `server/glossary.ts`. Handed neither, there is nothing for this file to render.
    render(
      <Term term="" definition="">
        {''}
      </Term>,
    )
    expect(nothing()).toBe('')

    // And with no glossary in the context, a sentence comes out exactly as it went in.
    render(<Glossed text="" />)
    expect(nothing()).toBe('')
  })
})

// ── A word with its meaning one hover or one Tab away ───────────────────────────

/**
 * #99 ruled that the domain nouns stay on screen and gain a definition Ryan can reach
 * without leaving the page. These are the two halves of keeping that: the marks land on
 * the right words, and the definition is reachable by keyboard and not only by mouse.
 */
describe('the glossary mark — a term Ryan can ask about (#99)', () => {
  const GLOSSARY = glossary()

  const gloss = (text: string) =>
    render(
      <GlossaryProvider glossary={GLOSSARY}>
        <p>
          <Glossed text={text} />
        </p>
      </GlossaryProvider>,
    )

  /**
   * The definition rides in the DOM beside its word rather than being mounted on hover, so
   * `aria-describedby` always has a node to point at. `chrome.css` hides it with
   * `visibility: hidden`, which takes it out of the accessibility tree as well as off the
   * screen — so what a reader gets, sighted or not, is the sentence the server wrote until
   * they ask for more. That is what this reads: the line without the closed definitions in it.
   */
  const asRead = (): string => {
    const line = host.querySelector('p')!.cloneNode(true) as HTMLElement
    for (const closed of line.querySelectorAll('.term__def')) closed.remove()
    return line.textContent ?? ''
  }

  it('renders the sentence whole, with the marked word still in its place', () => {
    gloss('Every proposal riding this episode reaches you here.')

    expect(asRead()).toBe('Every proposal riding this episode reaches you here.')
    expect([...host.querySelectorAll('.term__word')].map((word) => word.textContent)).toEqual([
      'proposal',
      'riding',
    ])
    // Closed, so it is off the screen and out of the accessibility tree both.
    for (const definition of host.querySelectorAll('.term__def')) {
      expect(getComputedStyle(definition).visibility).toBe('hidden')
    }
  })

  it('marks nothing in a sentence that names nothing from the glossary', () => {
    gloss('Eight of nine shots are on disk, and the ninth is still generating.')
    expect(host.querySelectorAll('.term')).toHaveLength(0)
  })

  it('carries the server’s definition, and ties it to the word for a screen reader', () => {
    gloss('One finding, quoted.')

    const word = host.querySelector('.term__word')!
    const definition = host.querySelector('.term__def')!
    expect(word.getAttribute('aria-describedby')).toBe(definition.id)
    expect(definition.id).not.toBe('')
    expect(definition.textContent).toBe(
      GLOSSARY.find((entry) => entry.term === 'finding')!.definition,
    )
    expect(definition.getAttribute('role')).toBe('tooltip')
  })

  /**
   * The half a `title` attribute cannot do. E5-0's baseline is that every screen inherits a
   * keyboard path, and a definition that opens for a pointer and not for a Tab key is a
   * definition half the people it was written for cannot read.
   */
  it('is reachable by keyboard, and opens on focus as well as on hover', () => {
    gloss('One gate, open.')

    const word = host.querySelector('.term__word') as HTMLElement
    expect(word.tabIndex).toBe(0)
    // Not a button: pressing it does nothing, and saying "button" would promise an act.
    expect(word.getAttribute('role')).toBeNull()

    const definition = host.querySelector('.term__def')!
    expect(getComputedStyle(definition).visibility).toBe('hidden')

    // jsdom applies `:focus` but not `:focus-visible`, so the rule is read off the
    // stylesheet that ships. Both openers are asserted, because the mouse one alone is
    // the failure this component exists to avoid.
    expect(CHROME).toContain('.term:hover .term__def')
    expect(CHROME).toContain('.term__word:focus-visible ~ .term__def')
    expect(CHROME).toMatch(/\.term:hover \.term__def,\s*\.term__word:focus-visible ~ \.term__def \{\s*visibility: visible;/)

    word.focus()
    expect(document.activeElement).toBe(word)
  })

  it('does not shove the line when a definition opens — it is out of flow', () => {
    gloss('One gate, open.')
    const definition = host.querySelector('.term__def')!
    expect(getComputedStyle(definition).position).toBe('absolute')
  })

  it('reaches every screen through the one line every section must carry', () => {
    render(
      <GlossaryProvider glossary={GLOSSARY}>
        <SectionHeader name="Artifacts" explains="what each one was built from" />
      </GlossaryProvider>,
    )

    // The heading's own name is untouched — the mark is on the explanation beside it.
    expect(host.querySelector('h2')!.textContent).toBe('Artifacts')
    expect(host.querySelector('.section-h__explains')!.textContent).toBe(
      'what each one was built from',
    )
    expect(host.querySelector('.section-h__name .term')).toBeNull()
  })
})

// ── The lifecycle pip, and the three states it is allowed to be ─────────────────

/**
 * The ruling of Aug 11 2026 (E5-0's review, on #81): **done / current-amber /
 * running-blue-pulsing**, amber meaning his hand and blue meaning in flight, app-wide.
 *
 * `drift.test.ts` pins the COLOURS against the stylesheet — jsdom does not resolve a
 * `var()`, so a computed-style assertion here would be reading `rgba(0,0,0,0)` and calling
 * it amber. What is pinned here is the component's half: a standing produces exactly one
 * class, the four are mutually exclusive, and the state is said in words as well as in
 * colour. **E5-2 inherits this assertion rather than the convention** — an episode room
 * that paints a merely-current stage blue fails these, in this file, before it ships.
 */
describe('the lifecycle track’s three ruled states', () => {
  const TRACK: TrackStop[] = [
    { stage: 'premise', standing: 'done', sentence: 'premise — done' },
    { stage: 'outline', standing: 'current', sentence: 'outline — yours to move' },
    { stage: 'script', standing: 'ahead', sentence: 'script — not reached yet' },
  ]

  it('gives each standing exactly one class, and never two at once', () => {
    render(<LifecycleTrack stops={TRACK} label="ep01 The Long Pier" />)

    expect([...host.querySelectorAll('.stage')].map((stop) => stop.className)).toEqual([
      'stage stage--done',
      'stage stage--current',
      'stage stage--ahead',
    ])
    expect(host.querySelectorAll('.stage--running')).toHaveLength(0)
  })

  it('is `running` and not `current` while a call is in flight on the stage', () => {
    render(
      <LifecycleTrack
        stops={[{ stage: 'assets', standing: 'running', sentence: 'assets — running now' }]}
        label="ep05"
      />,
    )

    // The distinction the ruling exists to make: "waiting on you" and "working" are two
    // states, and this is the line between them.
    expect(host.querySelector('.stage')!.className).toBe('stage stage--running')
    expect(host.querySelectorAll('.stage--current')).toHaveLength(0)
  })

  it('says which stop is the current one twice — in a class, and to a reader', () => {
    render(<LifecycleTrack stops={TRACK} label="ep01 The Long Pier" />)

    const marked = host.querySelectorAll('[aria-current="step"]')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.className).toBe('stage stage--current')
    expect(marked[0]!.querySelector('.visually-hidden')!.textContent).toBe(
      'outline — yours to move',
    )
    // A `running` stop is the current one too — it is where the episode is, and a reader
    // navigating by structure must land on it whether the work is his or the model's.
    render(
      <LifecycleTrack
        stops={[{ stage: 'assets', standing: 'running', sentence: 'assets — running now' }]}
        label="ep05"
      />,
    )
    expect(host.querySelectorAll('[aria-current="step"]')).toHaveLength(1)
  })

  it('names the track, so a screen with six of them is six answerable questions', () => {
    render(<LifecycleTrack stops={TRACK} label="ep01 The Long Pier" />)
    expect(host.querySelector('ol')!.getAttribute('aria-label')).toBe('ep01 The Long Pier')
  })
})

describe('a refusal reaches the screen as the sentence the server wrote', () => {
  it('renders it verbatim, in the cost line’s place, on a disabled button', () => {
    render(<SentenceButton offer={BLOCKED} onClick={() => {}} />)

    const button = host.querySelector('button')!
    expect(button.disabled).toBe(true)
    expect(button.querySelector('.cost')!.textContent).toBe(BLOCKED.blockedBecause)
    // The price of something that cannot be bought is not information — the mockups
    // put the reason here, and the reason is what is here.
    expect(button.textContent).not.toContain('$0.85')
  })

  it('states verb, object, scope and cost when it can be pressed', () => {
    render(<SentenceButton offer={READY} onClick={() => {}} />)

    const button = host.querySelector('button')!
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('Write the ep07 outline')
    expect(button.querySelector('.cost')!.textContent).toBe('1 Opus call · ~$0.85')
  })
})

// ── Severity and confidence, never collapsed ────────────────────────────────────

describe('severity and confidence stay two values', () => {
  it('prints both, each in its own element, each named by the server', () => {
    render(
      <TwoValues
        readings={[
          { label: 'severity', value: 'low' },
          { label: 'confidence', value: 'high' },
        ]}
        also="image check"
      />,
    )

    expect(host.querySelector('[data-axis="severity"]')!.textContent).toBe('severity low')
    expect(host.querySelector('[data-axis="confidence"]')!.textContent).toBe('confidence high')
    // Never a tick, never a score, never one word standing for two readings (invariant 4).
    expect(host.textContent).not.toContain('✓')
  })
})

// ── The accessibility baseline ──────────────────────────────────────────────────

/**
 * Checked once, here, so that a screen inherits a palette whose contrast is known rather
 * than hoped for. The three pairs below AA are listed by name rather than excluded
 * quietly — a known shortfall that is written down is a decision; one that is filtered
 * out of a test is a lie with a green tick on it.
 */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    const [r, g, blue] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * blue!
  }
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

function token(name: string): string {
  const found = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(CHROME)
  if (!found) throw new Error(`${name} is not declared in chrome.css`)
  return found[1]!
}

describe('the palette’s contrast, checked once', () => {
  const page = () => token('--page')
  const card = () => token('--card')

  it.each([
    ['--ink', 'the promoted text', 4.5],
    ['--ink-2', 'running text', 4.5],
    ['--muted', 'meta, cost lines and section headings', 4.5],
    ['--warn', 'anything waiting on Ryan', 4.5],
    ['--live', 'anything in flight, and the focus ring', 4.5],
    ['--good', 'settled and ratified', 4.5],
    ['--serious', 'a serious finding', 4.5],
  ])('%s (%s) clears AA on both surfaces', (name, _what, floor) => {
    expect(contrast(token(name), page())).toBeGreaterThanOrEqual(floor)
    expect(contrast(token(name), card())).toBeGreaterThanOrEqual(floor)
  })

  /**
   * The three that do not clear it, named. `--faint` is the footer and only the footer;
   * `--critical` is a border and a dot rather than text (the gate room prints its red
   * finding in `#f2a0a0`, which clears AA at 7.99:1); `--muted` on the RAISED fill is a
   * quarter-point short and appears wherever a card sits on a card. Each is on the owed
   * list in #80, and each screen's own issue carries its share.
   */
  it.each([
    ['--faint', 2.85, 'the footer’s ink, on the page'],
    ['--critical', 4.05, 'a blocking finding’s border and dot, never its words'],
  ])('%s is a known shortfall at about %s:1 — %s', (name, about) => {
    const measured = contrast(token(name), page())
    expect(measured).toBeLessThan(4.5)
    expect(measured).toBeCloseTo(about, 1)
  })

  it('--muted is a quarter-point short on the raised fill, and nowhere else', () => {
    expect(contrast(token('--muted'), token('--card-raised'))).toBeLessThan(4.5)
    expect(contrast(token('--muted'), token('--card-raised'))).toBeGreaterThan(4.4)
  })
})

describe('the accessibility baseline every screen inherits', () => {
  it('draws a focus ring rather than removing one', () => {
    expect(CHROME).toContain(':focus-visible')
    expect(CHROME).not.toMatch(/outline:\s*(none|0)\b/)
  })

  it('turns motion off when the machine asks it to', () => {
    expect(CHROME).toContain('prefers-reduced-motion: reduce')
  })

  it('collapses rather than scrolling sideways, at the width the mockups stop at', () => {
    expect(CHROME).toContain('max-width: 800px')
    expect(CHROME).toMatch(/html\s*\{\s*overflow-x:\s*hidden/)
  })

  it('renders the live region as a labelled section with one polite line in it', () => {
    render(
      <LiveRegion id="ep05-run" heading="Generating" latest="Shot 8 of 14" stream={[]} entries={[]} />,
    )

    const region = host.querySelector('#ep05-run')!
    expect(region.tagName).toBe('SECTION')
    expect(region.getAttribute('aria-labelledby')).toBe('ep05-run-heading')
    expect(host.querySelector('[aria-live="polite"]')!.textContent).toBe('Shot 8 of 14')
    // The model's half-formed prose is never read aloud a chunk at a time.
    expect(host.querySelector('.live-region__stream')!.getAttribute('aria-live')).toBe('off')
  })
})

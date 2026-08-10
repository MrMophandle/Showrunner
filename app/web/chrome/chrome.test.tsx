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
import { LiveRegion, type LiveEntry } from './LiveRegion.tsx'
import { SectionHeader } from './SectionHeader.tsx'
import { SentenceButton } from './SentenceButton.tsx'
import { TwoValues } from './TwoValues.tsx'

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
   * to write one, and this reads the directory to prove it rather than trusting a rule.
   */
  it('is the only file in the chrome that opens a heading element', () => {
    const here = import.meta.dirname
    const offenders = readdirSync(here)
      .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
      .filter((name) => name !== 'SectionHeader.tsx')
      .filter((name) => /<h[23][\s>]/.test(readFileSync(join(here, name), 'utf8')))

    expect(offenders, 'a heading outside SectionHeader.tsx has no explanation beside it').toEqual([])
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

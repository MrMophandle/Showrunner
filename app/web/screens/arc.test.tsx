// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { arcIndexView, arcPageView, type ArcIndexView, type ArcPageView } from '../../server/arc-page.ts'
import type { Store } from '../../server/db/store.ts'
import { arcsOf, waypointsOf, type Arc } from '../../server/domain/arc.ts'
import { artifactsOf } from '../../server/domain/artifact.ts'
import { landPosition } from '../../server/domain/episode-canon.ts'
import { createProposalRulings } from '../../server/domain/proposal.ts'
import { episodesOf, seasonsOf } from '../../server/domain/spine.ts'
import { waypointChecksFor } from '../../server/domain/text-check.ts'
import { createEventLog } from '../../server/events.ts'
import { greyHarborFounded, type FoundedFixture } from '../../server/fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../../server/library.ts'
import { heldStill, stillTheSameNode } from '../chrome/held-still.ts'
import { ArcIndexScreen, ArcPageScreen } from './ArcPage.tsx'

/**
 * **The arc page, in a real DOM, with a real arc under it** (E5-5, #85).
 *
 * `arc-page.test.ts` proves the sentences are right. This proves the screen — and the one that
 * matters most here is that the drift check's own composed instructions land on the PAGE
 * unparaphrased, because a paragraph a component wrote would pass every server-side test in the
 * repo and still be the thing Ryan actually read.
 */

const CHROME = readFileSync(join(import.meta.dirname, '..', 'chrome', 'chrome.css'), 'utf8')
const ARC = readFileSync(join(import.meta.dirname, 'arc.css'), 'utf8')

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let host: HTMLElement
let root: Root
let library: string
let paths: LibraryPaths
let store: Store
let harbor: FoundedFixture
let ep01: string
let ep02: string

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  for (const css of [CHROME, ARC]) {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  library = mkdtempSync(join(tmpdir(), 'showrunner-arc-screen-'))
  paths = initLibrary(library)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)

  const episodes = episodesOf(store, seasonsOf(store, harbor.show.id)[0]!.id)
  ep01 = episodes[0]!.id
  ep02 = episodes[1]!.id
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const style of [...document.head.querySelectorAll('style')]) style.remove()
  store.close()
  rmSync(library, { recursive: true, force: true })
})

const arc = (): Arc => arcsOf(store, harbor.show.id)[0]!
const view = (): ArcPageView => arcPageView(store, arc().id)!
const rulings = () => createProposalRulings(store, createEventLog(store))

function still(next: ArcPageView = view()): void {
  act(() => root.render(<ArcPageScreen view={next} problem={null} />))
}

function landOn(episodeId: string, ordinal: number): string {
  const waypoint = waypointsOf(store, arc().id).find((one) => one.ordinal === ordinal)!
  return landPosition(store, {
    episodeId,
    arcId: arc().id,
    waypointId: waypoint.id,
    subject: harbor.entity('Ilse Renn').id,
  }).proposal.id
}

// ── Trap 4, on the page ────────────────────────────────────────────────────────

describe('the page teaches the check with the check’s own words', () => {
  /**
   * The equality is against `waypointChecksFor`, which is the function the checker STEP calls
   * with a real artifact. So what is on the page is what a run carries — not a description of
   * it, not a summary of it, and not a paragraph that has to be kept in step by hand.
   */
  it('renders the drift check’s real instructions and reference, byte for byte', () => {
    still()

    const script = artifactsOf(store, ep01).find((one) => one.kind === 'script')!
    const convened = waypointChecksFor(store, script)[0]!

    expect(host.querySelector('#drift-instructions')!.textContent).toBe(convened.instructions)
    expect(host.querySelector('#drift-reference')!.textContent).toBe(convened.reference.join('\n'))

    // And it says whose pass it is an example of, because the reference is position-specific.
    expect(host.querySelector('.arc-check__for')!.textContent).toContain('composed for ep01')
    expect(host.querySelector('.arc-check__label')!.textContent).toContain('waypoint-drift')
  })

  it('gives the worked example its own box with a height, so it cannot push History off', () => {
    still()

    const box = getComputedStyle(host.querySelector('#drift-reference')!)
    expect(box.overflow).toBe('auto')
    expect(box.height).toBe('200px')
    expect(box.maxHeight === '' || box.maxHeight === 'none').toBe(true)
    // The reference lists every waypoint with its criteria, so it is longer than the rest of
    // this page put together — and it whitespace-preserves, because it is prompt material.
    expect(box.whiteSpace).toBe('pre-wrap')
  })

  it('shows no example, and says so, when nothing declares a position on the arc', () => {
    store.run('DELETE FROM episode_arc_position')
    still()

    expect(host.querySelector('#drift-instructions')).toBeNull()
    const empties = [...host.querySelectorAll('.empty')].map((one) => one.textContent ?? '')
    expect(empties.some((one) => one.includes('Nothing convenes it on this arc yet'))).toBe(true)
    // The prose about how the mechanism works is still on the page — it is true either way.
    expect(host.querySelector('.arc-rule')!.textContent).toContain('A finding argues and never decides')
  })
})

// ── The spine ──────────────────────────────────────────────────────────────────

describe('the spine draws four standings and hangs a ruling on exactly one', () => {
  it('marks landed, riding, pinned and ahead, and prints the lineage only on landed', () => {
    const ruling = rulings().ratify(landOn(ep02, 3), { note: 'landed.' }).disposition!
    still()

    expect(host.querySelector('.arc-wprow[data-standing="ahead"]')).not.toBeNull()
    expect(host.querySelector('.arc-wprow[data-standing="pinned"]')).not.toBeNull()
    const landed = host.querySelector('.arc-wprow[data-standing="landed"]')!
    expect(landed.querySelector('.arc-tag--ruling')!.textContent).toBe(
      `ratified at ruling ${ruling.seq} · ${ruling.at.slice(0, 10)}`,
    )

    // The pin says it is a pin, and carries no ruling tag at all.
    const pinned = host.querySelector('.arc-wprow[data-standing="pinned"]')!
    expect(pinned.querySelector('.arc-tag--ruling')).toBeNull()
    expect(pinned.textContent).toContain('a pin, not a landing')

    // Every waypoint carries what it means and what landing it looks like (D24).
    expect(host.querySelectorAll('.arc-wp__lands')).toHaveLength(3)
    expect(host.querySelector('.arc-wp__lands b')!.textContent).toBe('Landing looks like:')
  })

  it('draws a riding landing as the third thing it is, waiting on Ryan', () => {
    landOn(ep02, 3)
    still()

    const riding = host.querySelector('.arc-wprow[data-standing="riding"]')!
    expect(riding.querySelector('.arc-tag--ruling')).toBeNull()
    expect(riding.textContent).toContain('it becomes canon when you ratify it, and not before')
  })
})

// ── The whole-page stability bar ───────────────────────────────────────────────

describe('a landing ratifying does not move the page under a reading eye', () => {
  /**
   * **The statement is the reading eye.** D24 exists because Ryan had forgotten what an arc was
   * and had nowhere to look, so the prose he came here to re-read is the thing that must not
   * move — and ratifying a landing rewrites every summary above it (the standing chip, the
   * head line). Each of those declares a height, so it cannot push the paragraph down.
   */
  it('holds the statement still while a waypoint on the spine becomes canon above it', async () => {
    const proposalId = landOn(ep02, 3)
    still()

    const screen = host.querySelector('.arc')!
    const reading = host.querySelector('.arc-statement p')!

    await heldStill(screen, reading, () => {
      rulings().ratify(proposalId, { note: 'landed.' })
      still()
    })

    // The page really did change, so the assertion above is about a real update rather than
    // about a screen where nothing happened.
    expect(host.querySelector('.arc-wprow[data-standing="landed"]')).not.toBeNull()
    expect(host.querySelector('.arc-chip--standing')!.textContent).toBe('landed to waypoint 3 of 3')
    stillTheSameNode(reading, host.querySelector('.arc-statement p'))
  })
})

// ── The bare address ───────────────────────────────────────────────────────────

describe('the arc page’s bare address is a list, never a dead end', () => {
  it('offers every arc in the library as a sentence that links', () => {
    const index = arcIndexView(store)
    act(() => root.render(<ArcIndexScreen view={index} />))

    const link = host.querySelector(`#arc-${arc().id}`)!
    expect(link.getAttribute('href')).toBe(`/arc/${arc().id}`)
    expect(link.textContent).toContain('What the harbor is for')
  })
})

// ── It writes no word ──────────────────────────────────────────────────────────

describe('the arc page writes none of its own copy', () => {
  it('renders a blank view blank — every sentence on this screen came down the wire', () => {
    const blank = {
      arcId: 'arc',
      showId: 'show',
      name: '',
      kindChip: '',
      standingChip: '',
      headsub: '',
      floorHref: '/',
      floorName: '',
      seasonHref: '/season',
      seasonName: '',
      canonHref: '/canon',
      canonName: '',
      canonNotYet: null,
      headings: Object.fromEntries(
        ['statement', 'waypoints', 'glance', 'episodes', 'checked', 'history'].map((key) => [
          key,
          { name: '', explains: '—' },
        ]),
      ),
      landingLabel: '',
      statement: [''],
      noStatement: null,
      waypoints: [
        {
          waypointId: 'wp',
          ordinal: 1,
          name: '',
          description: '',
          landingCriteria: '',
          standing: 'pinned',
          tags: [],
          lineage: null,
          recheck: null,
        },
      ],
      glance: [{ key: '', value: '' }],
      entities: [],
      noEntities: null,
      episodes: [
        { episodeId: 'ep', label: '', title: '', sentence: '', standing: 'pinned', href: '/episode/ep' },
      ],
      noEpisodes: null,
      untouchedNote: '',
      checked: {
        sentence: '',
        checkKey: '',
        composedFor: '',
        label: '',
        instructions: '',
        reference: '',
        none: null,
      },
      history: [{ what: '', when: '', note: null, at: '' }],
      stream: { kinds: [], prose: [], since: 0 },
    } as unknown as ArcPageView

    still(blank)
    // The separators are the stylesheet's marks rather than words, and the pip's number is a
    // waypoint's ordinal. Everything else would be a sentence this file wrote.
    expect((host.textContent ?? '').replaceAll(/[·—←\d]/g, '').trim()).toBe('')
  })

  it('renders a blank index blank too', () => {
    const blank = {
      heading: { name: '', explains: '—' },
      arcs: [{ arcId: 'arc', sentence: '', href: '/arc/arc' }],
      empty: null,
    } as unknown as ArcIndexView

    act(() => root.render(<ArcIndexScreen view={blank} />))
    expect((host.textContent ?? '').replaceAll(/[·—←\d]/g, '').trim()).toBe('')
  })
})

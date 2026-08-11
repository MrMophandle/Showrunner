// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../../server/db/store.ts'
import { appendWaypoint, arcsOf, createArc, waypointsOf } from '../../server/domain/arc.ts'
import { landPosition } from '../../server/domain/episode-canon.ts'
import { createProposalRulings } from '../../server/domain/proposal.ts'
import { createEpisode, episodesOf, seasonsOf } from '../../server/domain/spine.ts'
import { createEventLog } from '../../server/events.ts'
import { greyHarborFounded, type FoundedFixture } from '../../server/fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../../server/library.ts'
import { seasonMapView, type SeasonMapView } from '../../server/season-map.ts'
import { heldStill, stillTheSameNode } from '../chrome/held-still.ts'
import { SeasonMapScreen } from './SeasonMap.tsx'

/**
 * **The season map, in a real DOM, with a real season under it** (E5-5, #85).
 *
 * `season-map.test.ts` proves the sentences are right. This proves the screen: that a pin and a
 * landing are drawn differently and the landing carries its ruling on the page, that the grid
 * scrolls inside its own box with the arc labels pinned, that a landing ratifying moves nothing
 * under a reading eye, and that the browser writes not one word of any of it.
 *
 * ── The stylesheets are the ones that ship ──────────────────────────────────────
 * `chrome.css` AND `season-map.css` are read off disk and put in the document, because
 * `held-still.ts` asks the CSSOM whether a box can grow and this file asks it whether the grid
 * scrolls. A test against a bundler's idea of the stylesheet would pass on a page that took the
 * breadcrumb sideways with it.
 */

const CHROME = readFileSync(join(import.meta.dirname, '..', 'chrome', 'chrome.css'), 'utf8')
const SEASON = readFileSync(join(import.meta.dirname, 'season-map.css'), 'utf8')

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
let seasonId: string
let ep01: string
let ep02: string

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  for (const css of [CHROME, SEASON]) {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  library = mkdtempSync(join(tmpdir(), 'showrunner-season-screen-'))
  paths = initLibrary(library)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)

  seasonId = seasonsOf(store, harbor.show.id)[0]!.id
  const episodes = episodesOf(store, seasonId)
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

const view = (): SeasonMapView => seasonMapView(store, seasonId)!

function still(next: SeasonMapView = view()): void {
  act(() => root.render(<SeasonMapScreen view={next} problem={null} />))
}

const rulings = () => createProposalRulings(store, createEventLog(store))

function landOn(episodeId: string, ordinal: number): string {
  // By name, not by index: `arcsOf` orders alphabetically, so a test that adds a second arc
  // would otherwise silently start landing on the wrong one.
  const arc = arcsOf(store, harbor.show.id).find((one) => one.name === 'What the harbor is for')!
  const waypoint = waypointsOf(store, arc.id).find((one) => one.ordinal === ordinal)!
  return landPosition(store, {
    episodeId,
    arcId: arc.id,
    waypointId: waypoint.id,
    subject: harbor.entity('Ilse Renn').id,
  }).proposal.id
}

// ── Trap 1, on the page ────────────────────────────────────────────────────────

describe('a pin and a landing are drawn differently, and only one carries a ruling', () => {
  it('puts three different inks on the grid and the lineage inside the landed cell', () => {
    // ep01 holds the fixture's pin. ep02 lands waypoint 3 and Ryan ratifies it.
    const ruling = rulings().ratify(landOn(ep02, 3), { note: 'landed.' }).disposition!
    still()

    const pinned = host.querySelector('.season-wp[data-ink="pinned"]')!
    const landed = host.querySelector('.season-wp[data-ink="landed"]')!

    expect(pinned).not.toBeNull()
    expect(landed).not.toBeNull()
    expect(pinned.getAttribute('data-ink')).not.toBe(landed.getAttribute('data-ink'))

    // The ruling is IN the cell, not implied by a border — a distinction kept only in CSS is
    // one that vanishes in a grayscale screenshot.
    expect(landed.querySelector('.season-wp__ruling')!.textContent).toBe(
      `ratified at ruling ${ruling.seq} · ${ruling.at.slice(0, 10)}`,
    )
    // The slot is on every chip; only the landing has anything to put in it.
    expect(pinned.querySelector('.season-wp__ruling')!.textContent).toBe('')

    // And both say what they are in words, for an eye and for a screen reader.
    expect(pinned.getAttribute('aria-label')).toContain('which is a pin: a plan, and not canon')
    expect(landed.getAttribute('aria-label')).toContain('it carries the episode that established it')
  })

  it('draws a landing still waiting on Ryan in the amber that means “your attention”', () => {
    landOn(ep02, 3)
    still()

    const riding = host.querySelector('.season-wp[data-ink="riding"]')!
    expect(riding.querySelector('.season-wp__ruling')!.textContent).toBe('')
    expect(riding.getAttribute('aria-label')).toContain('A pin is not a landing')
  })
})

// ── Trap 5: the grid holds still and scrolls in its own box ────────────────────

describe('the grid scrolls inside its own container and the arc labels stay put', () => {
  it('puts the overflow on the box, gives it a height, and never lets the page go sideways', () => {
    still()

    const scroller = host.querySelector('.season-scroller')!
    const box = getComputedStyle(scroller)
    expect(box.overflow).toBe('auto')
    // A height, never a max-height: a max-height grows the same way and only stops later
    // (`held-still.ts`'s own words). This is what seals the grid.
    expect(box.height).not.toBe('auto')
    expect(box.height).not.toBe('')
    // A `min()` of what the rows need and a cap: it fits a one-arc season and stops a
    // twelve-arc one, and it is never `auto`, which is what seals the box.
    expect(box.height.startsWith('min(420px,')).toBe(true)
    expect(box.maxHeight === '' || box.maxHeight === 'none').toBe(true)

    // The PAGE never scrolls sideways: nothing outside the scroller is allowed to overflow.
    for (const element of [...host.querySelectorAll('*')]) {
      if (element === scroller || scroller.contains(element)) continue
      const overflow = getComputedStyle(element).overflowX
      expect(overflow === '' || overflow === 'visible', element.className).toBe(true)
    }
  })

  it('pins the arc-label column, and the header and foot cells that share its edge', () => {
    still()

    for (const selector of [
      '.season-arclabel',
      '.season-row--head .season-cell:first-child',
      '.season-foot__label',
    ]) {
      const pinned = getComputedStyle(host.querySelector(selector)!)
      expect(pinned.position, selector).toBe('sticky')
      expect(pinned.left, selector).toBe('0px')
    }
  })
})

// ── The whole-page stability bar ───────────────────────────────────────────────

describe('a landing ratifying moves its cell and nothing else', () => {
  /**
   * The reading eye is on the bottom of the page — the filed issue Ryan is about to click —
   * and the thing that changes is a cell near the top of the grid. Under a page that grew
   * with its grid this is exactly the click that would miss.
   */
  it('holds the whole page still while a cell repaints inside the sealed grid', async () => {
    const proposalId = landOn(ep02, 3)
    still()

    const screen = host.querySelector('.season')!
    const reading = host.querySelector('.season-gap__issue a')!
    const label = host.querySelector('.season-arclabel__nm a')!

    await heldStill(screen, reading, () => {
      rulings().ratify(proposalId, { note: 'landed.' })
      still()
    })

    // And the cell really did change, so the assertion above is about a real update rather
    // than about a page where nothing happened.
    expect(host.querySelector('.season-wp[data-ink="landed"]')).not.toBeNull()
    expect(host.querySelector('.season-wp[data-ink="riding"]')).toBeNull()

    // The arc's own name is the same NODE, not an identical one: a remount would take focus,
    // selection and the grid's scroll position with it.
    stillTheSameNode(label, host.querySelector('.season-arclabel__nm a'))
    stillTheSameNode(reading, host.querySelector('.season-gap__issue a'))
  })

  /**
   * The same promise one level in: the eye is on a row INSIDE the grid, and the landing lands
   * on the row above it. The ruling line is out of flow (`season-map.css`), so the cell it
   * appears in does not get taller and the arc below does not move — which is what "a landing
   * ratifying moves its cell, nothing else" means at the scale the grid is read at.
   */
  it('holds a lower arc’s row still while a landing lands in the row above it', async () => {
    const second = createArc(store, {
      showId: harbor.show.id,
      seasonId,
      scope: 'season',
      kind: 'story',
      // Sorts after “What the harbor is for”, so the fixture's arc is the row ABOVE it and
      // the landing genuinely lands above the label being read.
      name: 'Winter stores',
      statement: 'a statement.',
    })
    appendWaypoint(store, second.id, { name: 'owed' })
    const proposalId = landOn(ep02, 3)
    still()

    const screen = host.querySelector('.season')!
    const rows = [...host.querySelectorAll('.season-row--arc')]
    const lower = rows.at(-1)!.querySelector('.season-arclabel__nm a')!

    await heldStill(screen, lower, () => {
      rulings().ratify(proposalId, { note: 'landed.' })
      still()
    })

    expect(host.querySelector('.season-wp__ruling')).not.toBeNull()
    expect(getComputedStyle(host.querySelector('.season-wp__ruling')!).position).toBe('absolute')
    stillTheSameNode(lower, [...host.querySelectorAll('.season-row--arc')]
      .at(-1)!
      .querySelector('.season-arclabel__nm a'))
  })
})

// ── Trap 2 and 3, on the page ──────────────────────────────────────────────────

describe('the map says what is cold, what is vanilla, and what it has no mechanism for', () => {
  it('tags the vanilla column and dashes the cold stretch it can see', () => {
    for (let number = 3; number <= 6; number += 1) {
      createEpisode(store, { seasonId, number, title: `Episode ${number}` })
    }
    still()

    expect(host.querySelector('.season-vanilla')!.textContent).toBe('vanilla')
    expect(host.querySelectorAll('.season-cell--cold').length).toBeGreaterThanOrEqual(3)
    expect(host.querySelector('.season-arclabel__warn')!.textContent).toContain('cold for')
    expect(host.querySelector('.season-thread[data-cold="true"]')).not.toBeNull()
  })

  it('renders both absences as empty states with their issues, and offers no button at all', () => {
    still()

    const gaps = [...host.querySelectorAll('.season-gap__issue a')]
    expect(gaps.map((one) => one.getAttribute('href'))).toEqual([
      'https://github.com/MrMophandle/Showrunner/issues/92',
      'https://github.com/MrMophandle/Showrunner/issues/93',
    ])
    expect(gaps[0]!.textContent).toContain('#92')
    expect(gaps[1]!.textContent).toContain('#93')

    // No button anywhere — not an enabled one, and not a disabled one either. A blocked
    // button would say the act exists and is momentarily refused; neither act exists.
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })
})

// ── It writes no word ──────────────────────────────────────────────────────────

/**
 * The strongest proof available, and the one every screen in this epic takes: hand it a view
 * of empty strings and see whether anything comes out. A word this file authored shows up here
 * as that word, and there is nowhere to hide it.
 */
describe('the season map writes none of its own copy', () => {
  it('renders a blank view blank — every sentence on this screen came down the wire', () => {
    const blank = {
      seasonId: 'season',
      showId: 'show',
      title: '',
      where: '',
      floorHref: '/',
      floorName: '',
      meta: '',
      seasons: [],
      headings: Object.fromEntries(
        ['grid', 'ahead', 'threads'].map((key) => [key, { name: '', explains: '—' }]),
      ),
      episodes: [
        {
          episodeId: 'ep',
          label: '',
          title: '',
          standing: '',
          tone: 'live',
          href: '/episode/ep',
          touches: 0,
          vanillaTag: '',
          footNote: '',
        },
      ],
      arcs: [
        {
          arcId: 'arc',
          name: '',
          kind: '',
          href: '/arc/arc',
          room: '',
          roomNotYet: null,
          warning: null,
          cells: [
            {
              episodeId: 'ep',
              first: true,
              cold: false,
              waypoint: { waypointId: 'wp', ordinal: '', name: '', ink: 'landed', sentence: '', lineage: '' },
            },
          ],
          ahead: [],
          aheadNone: '',
        },
      ],
      noArcs: null,
      vanillaNote: '',
      touchedLabel: '',
      threads: [{ arcId: null, heading: '', sentence: '', why: '', href: null, cold: false }],
      pool: { heading: { name: '', explains: '—' }, lead: '', sentence: '', filed: '', issueHref: '#' },
      pitch: { heading: { name: '', explains: '—' }, lead: '', sentence: '', filed: '', issueHref: '#' },
      stream: { kinds: [], prose: [], since: 0 },
    } as unknown as SeasonMapView

    still(blank)
    // The separators are the stylesheet's marks rather than words. Everything else that could
    // appear here would be a sentence this file wrote.
    expect((host.textContent ?? '').replaceAll(/[·—←\d]/g, '').trim()).toBe('')
  })
})

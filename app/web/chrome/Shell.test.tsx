// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cockpitView, type CockpitView } from '../../server/cockpit.ts'
import { migrate } from '../../server/db/migrate.ts'
import { openStore, type Store } from '../../server/db/store.ts'
import { createShow } from '../../server/domain/spine.ts'
import { locate, navigate } from './router.ts'
import { Shell, whereWeAre } from './Shell.tsx'

/**
 * The shell: eight addresses, and not one of them a dead end (E5-0, #80; E5-6, #86).
 *
 * The rule #80 worked under was that **every door stays open until #86** — the shell added
 * eight rooms, removed nothing, and kept the old operating page serving at a ninth address.
 * #86 is that rule's other end: the page retired once every door it held had a home on a
 * screen and an assertion there. So what is walked below is eight doors, and the ninth
 * address landing somewhere real rather than nowhere.
 *
 * The cockpit view is the real one (`server/cockpit.ts`), because a shell tested against a
 * hand-written fixture would pass the day the real one lost a room.
 */

let host: HTMLElement
let root: Root
let store: Store
let cockpit: CockpitView

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // The stylesheet that ships, read off disk — so what the assertions see is `chrome.css`
  // rather than a bundler's idea of it.
  const style = document.createElement('style')
  style.textContent = readFileSync(join(import.meta.dirname, 'chrome.css'), 'utf8')
  document.head.replaceChildren(style)
  store = openStore(':memory:')
  migrate(store)
  createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  cockpit = cockpitView(store)

  // The one read the shell does, answered without a socket. Nothing else is stubbed —
  // opening the cockpit makes exactly one request, and it is a GET (invariant 5).
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(cockpit), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  store.close()
})

async function open(path: string): Promise<void> {
  window.history.replaceState(null, '', path)
  await act(async () => {
    root.render(<Shell screens={{}} />)
  })
}

describe('before the API answers', () => {
  /**
   * **Nothing runs without a click, and a first render is not a click** (invariant 5, at the
   * browser). `App.test.tsx` made this assertion against the scaffolding's own first paint;
   * the shell is where the cockpit's first paint happens, so it is where the assertion is
   * kept now. There is nothing to press until the server has said what may be pressed.
   */
  it('says so, and draws nothing pressable until it has been told what there is', async () => {
    // A read that has not come back yet — the state every hard refresh passes through.
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    await act(async () => {
      root.render(<Shell screens={{}} />)
    })

    expect(host.textContent).toContain('The API has not answered yet.')
    expect(host.querySelector('button')).toBeNull()
    expect(host.querySelector('a')).toBeNull()
  })
})

describe('the addresses', () => {
  it('reads a bare address and one holding an id as the same room', () => {
    expect(locate('/')).toEqual({ head: '', rest: null, path: '/' })
    expect(locate('/episode')).toEqual({ head: 'episode', rest: null, path: '/episode' })
    expect(locate('/episode/ep05-abc')).toEqual({
      head: 'episode',
      rest: 'ep05-abc',
      path: '/episode/ep05-abc',
    })
  })

  it('resolves all eight rooms, bare and parameterised alike', () => {
    for (const room of cockpit.destinations) {
      expect(whereWeAre(cockpit, locate(room.path)).id).toBe(room.id)
      const held = room.path === '/' ? '/' : `${room.path}/some-id`
      expect(whereWeAre(cockpit, locate(held)).id).toBe(room.id)
    }
  })

  it('lands a typo on the floor rather than on nothing', () => {
    expect(whereWeAre(cockpit, locate('/gnome')).id).toBe('floor')
  })

  /**
   * **A retired address may stop being a door; it may not become a dead end** (E5-6, #86).
   * `/operating` was the ninth address for one epic. It is claimed by no room now, so it
   * resolves the way every unclaimed address does — onto the home screen. A bookmark Ryan
   * kept from the drill he ruled off lands somewhere real.
   */
  it('lands the retired page’s own address on the floor, like any other nobody claims', () => {
    expect(whereWeAre(cockpit, locate('/operating')).id).toBe('floor')
  })
})

describe('every door is in the bar, and the bar is all of them', () => {
  it('links all eight, and marks the one you are standing in — twice', async () => {
    await open('/canon')

    const doors = [...host.querySelectorAll('.shell-door[href]')]
    const paths = doors.map((door) => door.getAttribute('href'))
    expect(paths).toEqual(cockpit.destinations.map((room) => room.path))

    // In ink, and in a word a screen reader can read.
    const current = doors.filter((door) => door.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0]!.getAttribute('href')).toBe('/canon')
  })

  it('says which room you are in on the browser tab, so a row of them is readable', async () => {
    await open('/gate')
    expect(document.title).toBe('Showrunner — the gate room')

    await act(async () => navigate('/canon'))
    expect(document.title).toBe('Showrunner — the canon library')
  })

  it('carries each room’s explanation to the pointer, where the bar has no room to print it', async () => {
    await open('/')
    const door = host.querySelector('.shell-door[href="/season"]')!
    expect(door.getAttribute('title')).toBe(
      cockpit.destinations.find((room) => room.id === 'season-map')!.explains,
    )
  })

  it('moves between rooms without a page load, and marks the new one', async () => {
    await open('/')
    expect(host.querySelector('.shell-door[aria-current="page"]')!.getAttribute('href')).toBe('/')

    await act(async () => navigate('/arc'))
    expect(host.querySelector('.shell-door[aria-current="page"]')!.getAttribute('href')).toBe('/arc')
    expect(window.location.pathname).toBe('/arc')
  })
})

/**
 * **The retirement, walked** (E5-6, #86).
 *
 * These four assertions replace the four that drove the old page from this file. Each one
 * is the same question asked from the other side: it used to serve at its own address, it
 * used to be last in the bar, it used to be handed the browser's own surface, and every
 * unbuilt room used to offer it by name. None of that may still be true, and none of it may
 * have left a stub pointing into thin air.
 */
describe('the old operating page has retired, and nothing still reaches for it', () => {
  it('renders no page of its own at /operating — the floor answers there now', async () => {
    await open('/operating')

    expect(host.querySelector('.shell-door[aria-current="page"]')!.getAttribute('href')).toBe('/')
    expect(document.title).toBe('Showrunner — the floor')
    expect(host.querySelector('.scaffolding')).toBeNull()
  })

  it('carries no door to it in the bar of any room', async () => {
    for (const room of cockpit.destinations) {
      await open(room.path)
      expect(
        host.querySelector('.shell-door[href="/operating"]'),
        `${room.id} still links the old page`,
      ).toBeNull()
    }
  })

  it('offers it from no unbuilt room, because there is no page left to offer', async () => {
    for (const room of cockpit.destinations) {
      await open(room.path)
      const out = host.querySelector('.empty')
      if (out === null) continue
      expect(out.textContent, `${room.id} still points at the old page`).not.toContain(
        'operating page',
      )
      expect(host.querySelector('.empty a[href="/operating"]')).toBeNull()
    }
  })

  it('leaves the two rooms it used to prop up saying what they can honestly say', async () => {
    await open('/review')
    const out = host.querySelector('.empty')!
    // Still an honest empty state rather than a blank one: what it is, that it is not built,
    // whose it is, and how you would have got here.
    expect(out.textContent).toContain('Not built yet, and not E5’s')
    expect(host.textContent).toContain('Reached from a queue of stills waiting on the floor')
    // And no link out of it at all, because there is nowhere true to send him.
    expect(out.querySelector('a')).toBeNull()
  })
})

describe('the unbuilt rooms are honest', () => {
  /**
   * **This test used to name an issue, and there is no longer one to name.** It walked the
   * chain — #83 pointed it at the canon library, #84 pointed it at the season map — and E5-5
   * (#85) built the last stub out of it. A stub leaves by being BUILT, which is the one way
   * out of that table, and the table is empty of them now.
   *
   * So what it asserts is the end of the chain: no room in this cockpit still says "not built
   * yet, see issue N", because every issue that was going to be named has been closed by the
   * screen it named.
   */
  it('name no issue any more, because #85 built the last stub out of the table', async () => {
    await open('/')

    for (const room of cockpit.destinations) {
      if (room.notYetBecause === null) continue
      expect(room.standing, `${room.id} is still a stub`).toBe('later-epic')
      expect(room.notYetBecause, `${room.id} names an issue`).not.toMatch(/#\d+/)
    }
  })

  it('say the two E6 screens are not E5’s to build', async () => {
    await open('/review')
    expect(host.querySelector('.empty')!.textContent).toContain('Not built yet, and not E5’s')
    expect(host.querySelector('.empty')!.textContent).toContain('E6')
    expect(host.querySelector('.empty')!.textContent).not.toContain('E5-')
  })

  it('say how you would have got here, so the room is not a cul-de-sac', async () => {
    await open('/episode')
    expect(host.textContent).toContain('Reached from an episode on the floor')
  })

  /**
   * Demonstrated against the review desk, because it is now one of the only two rooms that
   * still renders an empty state — the rest are built, so a room that "gives way" would have
   * had nothing to give way FROM.
   */
  it('give way the moment a screen registers for that room', async () => {
    window.history.replaceState(null, '', '/review')
    await act(async () => {
      root.render(
        <Shell screens={{ 'review-desk': ({ destination }) => <p>{destination.name} IS BUILT</p> }} />,
      )
    })
    expect(host.textContent).toContain('the review desk IS BUILT')
    expect(host.querySelector('.empty')).toBeNull()
  })
})

describe('the shell writes none of the words either', () => {
  /**
   * Every visible string on the shell must be one the server sent. The skip link is the
   * single exception, and it is about the DOCUMENT rather than about the product — it
   * says how to get past the navigation, which is a fact about this page and not about
   * Showrunner.
   */
  it('renders only sentences that came down the wire', async () => {
    await open('/')

    const wire = [
      ...cockpit.destinations.flatMap((room) => [
        room.name,
        room.explains,
        room.lead,
        room.notYetBecause ?? '',
        room.reachedFrom,
      ]),
      ...cockpit.shows.map((show) => show.title),
      cockpit.switcherExplains,
      'Showrunner',
      'Skip to this screen',
      'Reached from',
    ]

    let left = host.textContent ?? ''
    for (const said of wire.sort((a, b) => b.length - a.length)) {
      if (said !== '') left = left.split(said).join('')
    }
    expect(left.replaceAll(/[\s.·—]/g, '')).toBe('')
  })
})

describe('the show switcher', () => {
  it('is a menu, and stays one until show #2', async () => {
    await open('/')
    const menu = host.querySelector('select')!
    expect(menu.tagName).toBe('SELECT')
    expect(menu.disabled).toBe(true)
    expect(menu.title).toContain('until there is a second')
  })
})

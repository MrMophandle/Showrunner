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
 * The shell: nine addresses, and not one of them a dead end (E5-0, #80).
 *
 * The rule this issue works under is that **every door stays open until #86** — the shell
 * adds eight rooms and removes nothing, the old operating page keeps serving, and the nav
 * says how to reach it in words. These assertions are that rule, walked.
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
    root.render(<Shell screens={{}} scaffolding={<p>THE OLD OPERATING PAGE</p>} />)
  })
}

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

  it('resolves all eight rooms plus the old page, bare and parameterised alike', () => {
    for (const room of cockpit.destinations) {
      expect(whereWeAre(cockpit, locate(room.path)).id).toBe(room.id)
      const held = room.path === '/' ? '/' : `${room.path}/some-id`
      expect(whereWeAre(cockpit, locate(held)).id).toBe(room.id)
    }
    expect(whereWeAre(cockpit, locate('/operating')).id).toBe('operating')
  })

  it('lands a typo on the floor rather than on nothing', () => {
    expect(whereWeAre(cockpit, locate('/gnome')).id).toBe('floor')
  })
})

describe('every door is in the bar, including the one that retires', () => {
  it('links all nine, and marks the one you are standing in — twice', async () => {
    await open('/canon')

    const doors = [...host.querySelectorAll('.shell-door[href]')]
    const paths = doors.map((door) => door.getAttribute('href'))
    for (const room of cockpit.destinations) expect(paths).toContain(room.path)
    expect(paths).toContain('/operating')

    // In ink, and in a word a screen reader can read.
    const current = doors.filter((door) => door.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0]!.getAttribute('href')).toBe('/canon')
  })

  it('says which room you are in on the browser tab, so a row of them is readable', async () => {
    await open('/gate')
    expect(document.title).toBe('Showrunner — the gate room')

    await act(async () => navigate('/operating'))
    expect(document.title).toBe('Showrunner — the old operating page')
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

describe('the old operating page still serves, at its own address', () => {
  it('renders it, whole, at /operating', async () => {
    await open('/operating')
    expect(host.textContent).toContain('THE OLD OPERATING PAGE')
  })

  it('does not render it anywhere else — a room is a room', async () => {
    await open('/')
    expect(host.textContent).not.toContain('THE OLD OPERATING PAGE')
  })

  /**
   * "Unstyled HTML is the point" is that page's own header, and it is still the page Ryan
   * operates on. The shell adds a bar above it and hands the browser's own surface back
   * below it, so the cockpit's near-black page and its `--ink` headings do not reach in
   * and repaint a working page white-on-white.
   */
  it('hands it back the browser’s own surface rather than restyling it', async () => {
    await open('/operating')

    const wrapper = host.querySelector('.scaffolding')!
    expect(wrapper.textContent).toContain('THE OLD OPERATING PAGE')
    expect(getComputedStyle(wrapper).colorScheme).toBe('light')
  })

  /**
   * The charter's hardest line: **at no commit in this epic is a mechanism reachable only
   * through a page that is gone.** Six rooms are stubs, so every one of them has to hand
   * Ryan the page where its mechanism still works.
   */
  it('is offered by name from inside every unbuilt room', async () => {
    for (const room of cockpit.destinations) {
      await open(room.path)
      const out = host.querySelector('.empty')!
      expect(out.textContent, `${room.id} does not point anywhere`).toContain(
        cockpit.scaffolding.name,
      )
      expect(host.querySelector('.empty a[href="/operating"]')).not.toBeNull()
    }
  })
})

describe('the stubs are honest', () => {
  it('say they are not built, and name the issue that builds them', async () => {
    // The season map, because E5-4 built the canon library out of this test (#84 → #85). A
    // stub leaves by being BUILT, which is the one way out of this table.
    await open('/season')
    expect(host.querySelector('.empty')!.textContent).toContain('Not built yet')
    expect(host.querySelector('.empty')!.textContent).toContain('#85')
  })

  it('say the two E6 screens are not E5’s to build', async () => {
    await open('/review')
    expect(host.querySelector('.empty')!.textContent).toContain('E6')
    expect(host.querySelector('.empty')!.textContent).not.toContain('E5-')
  })

  it('say how you would have got here, so the room is not a cul-de-sac', async () => {
    await open('/episode')
    expect(host.textContent).toContain('Reached from an episode on the floor')
  })

  it('give way the moment a screen registers for that room', async () => {
    window.history.replaceState(null, '', '/season')
    await act(async () => {
      root.render(
        <Shell
          screens={{ 'season-map': ({ destination }) => <p>{destination.name} IS BUILT</p> }}
          scaffolding={<p>the old page</p>}
        />,
      )
    })
    expect(host.textContent).toContain('the season map IS BUILT')
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
      cockpit.scaffolding.name,
      cockpit.scaffolding.explains,
      cockpit.scaffolding.lead,
      cockpit.scaffolding.notYetBecause ?? '',
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

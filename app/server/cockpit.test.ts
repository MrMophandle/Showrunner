import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cockpitView, switcherSentence, type CockpitShow } from './cockpit.ts'
import { migrate } from './db/migrate.ts'
import { openStore, type Store } from './db/store.ts'
import { createShow } from './domain/spine.ts'

/**
 * What the cockpit calls its rooms, and what it may honestly say about them (E5-0, #80).
 *
 * The point of these assertions is not that a string equals a string — it is that the
 * strings exist HERE at all. E4-7 ruled that no refusal may live in `app/web/`, and #80
 * extends that to every name and every "not built yet" the shell renders. A test on this
 * side of the wire is what that extension looks like when it is kept.
 */

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => store.close())

describe('the eight rooms', () => {
  it('are eight, and each one says what it is for in plain words', () => {
    const view = cockpitView(store)

    expect(view.destinations.map((room) => room.id)).toEqual([
      'floor',
      'episode-room',
      'gate-room',
      'canon-library',
      'review-desk',
      'screening-room',
      'season-map',
      'arc-page',
    ])

    // Ryan's second criterion at the top level: nothing is named without being explained.
    for (const room of view.destinations) {
      expect(room.explains.trim(), `${room.id} explains nothing`).not.toBe('')
      expect(room.name.trim()).not.toBe('')
    }
  })

  it('gives every room an address, and every address a room', () => {
    const view = cockpitView(store)
    const paths = view.destinations.map((room) => room.path)

    expect(paths).toEqual([
      '/',
      '/episode',
      '/gate',
      '/canon',
      '/review',
      '/screening',
      '/season',
      '/arc',
    ])
    // No two rooms answer at the same address, and none of them is the old page's.
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).not.toContain(view.scaffolding.path)
  })

  /**
   * **The floor is the first room to leave this list** (E5-1, #81). A room stops being a
   * stub by being built, and the only thing that says so is its absence from `NOT_YET` —
   * which is why `standing` and `notYetBecause` are asserted together here: a room claiming
   * `built` while still naming the issue that builds it would be the honesty this table
   * exists for, said twice and disagreeing with itself.
   */
  it('calls the floor built, because E5-1 built it', () => {
    const floor = cockpitView(store).destinations.find((room) => room.id === 'floor')!

    expect(floor.standing).toBe('built')
    expect(floor.notYetBecause).toBeNull()
    expect(floor.lead).toBe('')
    // And it is still the home screen, at the address a typo lands on.
    expect(floor.path).toBe('/')
    expect(floor.reachedFrom).toBe('')
  })

  it('says which issue builds the remaining E5 rooms, and which epic builds the other two', () => {
    const view = cockpitView(store)
    const by = new Map(view.destinations.map((room) => [room.id, room]))

    // Five stubs left, each naming the issue that fills it — "when" is one click away.
    expect(by.get('episode-room')!.notYetBecause).toContain('#82')
    expect(by.get('gate-room')!.notYetBecause).toContain('#83')
    expect(by.get('canon-library')!.notYetBecause).toContain('#84')
    expect(by.get('season-map')!.notYetBecause).toContain('#85')
    expect(by.get('arc-page')!.notYetBecause).toContain('#85')

    // And two that are not E5's at all, which say so rather than promising a date.
    for (const id of ['review-desk', 'screening-room']) {
      expect(by.get(id)!.standing).toBe('later-epic')
      expect(by.get(id)!.notYetBecause).toContain('E6')
    }
  })

  it('opens with its standing rather than by repeating the room’s own name', () => {
    const view = cockpitView(store)

    for (const room of [...view.destinations, view.scaffolding]) {
      if (room.notYetBecause === null) continue
      expect(room.lead.trim(), `${room.id} leads with nothing`).not.toBe('')
      // The screen's title already says which room this is; the bold first line is the
      // one guaranteed read, and spending it on the name spends it on nothing.
      expect(room.lead).not.toContain(room.name)
    }
  })

  it('points every unbuilt room at somewhere its mechanism still works', () => {
    const view = cockpitView(store)

    for (const room of view.destinations) {
      if (room.standing !== 'stub') continue
      expect(
        room.notYetBecause,
        `${room.id} says it is not built and does not say where to go instead`,
      ).toContain('old operating page')
    }
  })
})

describe('the old operating page', () => {
  it('keeps an address of its own, and says when it retires', () => {
    const view = cockpitView(store)

    expect(view.scaffolding.path).toBe('/operating')
    expect(view.scaffolding.standing).toBe('scaffolding')
    // A door with no expiry date is a door nobody ever closes.
    expect(view.scaffolding.notYetBecause).toContain('#86')
  })

  /**
   * The rule this issue works under: **at no commit is a mechanism reachable only through
   * a page that is gone.** Six of the eight rooms are stubs, so the old page is where
   * everything E1–E4 built still works — and it is in the cockpit's own list rather than
   * in a comment, which is what makes the shell able to render a door to it.
   */
  it('is one of the addresses the cockpit hands over, not a secret', () => {
    expect(cockpitView(store).scaffolding.explains).toContain('still')
  })
})

describe('the show switcher stays a menu until show #2', () => {
  it('says which show it is when there is one', () => {
    createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })

    const view = cockpitView(store)
    expect(view.shows.map((show) => show.key)).toEqual(['greyharbor'])
    expect(view.switcherExplains).toContain('Grey Harbor')
    expect(view.switcherExplains).toContain('until there is a second')
  })

  it('says how to get a show when there is none, rather than drawing an empty menu', () => {
    expect(cockpitView(store).switcherExplains).toContain('fixture:load')
  })

  it('becomes a chooser at two, and says everything is scoped to the one you pick', () => {
    const two: CockpitShow[] = [
      { id: 'a', key: 'greyharbor', title: 'Grey Harbor' },
      { id: 'b', key: 'deadlight', title: 'Dead Light' },
    ]
    expect(switcherSentence(two)).toContain('2 shows')
    expect(switcherSentence(two)).toContain('scoped')
  })
})

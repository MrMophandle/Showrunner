import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COCKPIT_STANDING,
  cockpitView,
  switcherSentence,
  type CockpitShow,
} from './cockpit.ts'
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
    // No two rooms answer at the same address, and the retired page's is nobody's now:
    // `/operating` is claimed by no room, which is what makes the shell land it on the
    // floor like any other address nobody claims (E5-6, #86).
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).not.toContain('/operating')
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

  /** The second room to leave the list, and it leaves it the same way (E5-2, #82). */
  it('calls the episode room built, because E5-2 built it', () => {
    const room = cockpitView(store).destinations.find((one) => one.id === 'episode-room')!

    expect(room.standing).toBe('built')
    expect(room.notYetBecause).toBeNull()
    expect(room.lead).toBe('')
    // A room about one thing still answers at its bare address, so the bar's link is real.
    expect(room.path).toBe('/episode')
    expect(room.reachedFrom).toBe('an episode on the floor')
  })

  /** The third, and it leaves the list the same way (E5-3, #83). */
  it('calls the gate room built, because E5-3 built it', () => {
    const room = cockpitView(store).destinations.find((one) => one.id === 'gate-room')!

    expect(room.standing).toBe('built')
    expect(room.notYetBecause).toBeNull()
    expect(room.lead).toBe('')
    // `/gate` is the thin index of what is open and `/gate/<id>` is one gate whole, so the
    // bar's link is real without an id to fill in first.
    expect(room.path).toBe('/gate')
    expect(room.reachedFrom).toBe('an episode waiting on you, on the floor or in its room')
  })

  /** The fourth, and it leaves the list the same way (E5-4, #84). */
  it('calls the canon library built, because E5-4 built it', () => {
    const room = cockpitView(store).destinations.find((one) => one.id === 'canon-library')!

    expect(room.standing).toBe('built')
    expect(room.notYetBecause).toBeNull()
    expect(room.lead).toBe('')
    // `/canon` is the whole bible and `/canon/<entity>` is one sheet open in it, so the
    // bar's link is real without an id to fill in first.
    expect(room.path).toBe('/canon')
    expect(room.reachedFrom).toBe('the bar, or any name on a screen')
  })

  /**
   * The fifth and sixth, and they left together (E5-5, #85) — two screens, one issue, every
   * query shared. `/season` is whichever season the bar's link lands on; `/arc/<id>` is one
   * arc, and its bare address is the list of them, because an arc page with no arc has
   * genuinely nothing on it and no door in this cockpit may be a dead end.
   */
  it('calls the season map and the arc page built, because E5-5 built them together', () => {
    const by = new Map(cockpitView(store).destinations.map((room) => [room.id, room]))

    for (const id of ['season-map', 'arc-page']) {
      expect(by.get(id)!.standing, id).toBe('built')
      expect(by.get(id)!.notYetBecause, id).toBeNull()
      expect(by.get(id)!.lead, id).toBe('')
    }
    expect(by.get('season-map')!.path).toBe('/season')
    expect(by.get('arc-page')!.path).toBe('/arc')
    expect(by.get('arc-page')!.reachedFrom).toBe(
      'the season map, or a name in the canon library',
    )
  })

  /**
   * **Every E5 room is built, so there is no stub left at all** — #85 was the last one out of
   * `NOT_YET`, and what remains in that table is two rooms that are not E5's to build. That is
   * a different kind of honesty from "not built yet": it names an EPIC rather than an issue,
   * because "when" is not one click away and pretending otherwise would be the promise this
   * table exists to avoid making.
   */
  it('has no stub left, and says the other two are E6’s rather than promising a date', () => {
    const view = cockpitView(store)
    const by = new Map(view.destinations.map((room) => [room.id, room]))

    expect(view.destinations.filter((room) => room.standing === 'stub')).toEqual([])

    for (const id of ['review-desk', 'screening-room']) {
      expect(by.get(id)!.standing).toBe('later-epic')
      expect(by.get(id)!.notYetBecause).toContain('E6')
      // And no issue number, because there is no issue: naming one would be inventing it.
      expect(by.get(id)!.notYetBecause).not.toMatch(/#\d+/)
    }
  })

  it('opens with its standing rather than by repeating the room’s own name', () => {
    const view = cockpitView(store)

    for (const room of view.destinations) {
      if (room.notYetBecause === null) continue
      expect(room.lead.trim(), `${room.id} leads with nothing`).not.toBe('')
      // The screen's title already says which room this is; the bold first line is the
      // one guaranteed read, and spending it on the name spends it on nothing.
      expect(room.lead).not.toContain(room.name)
    }
  })
})

/**
 * **The ninth address, and the day it stopped being one** (E5-6, #86).
 *
 * `/operating` was in this list for one epic — a destination that was not a room and said
 * so, kept here rather than in a comment so the shell could draw a door to it while the six
 * screens were built beside it. What retired it was not a deadline: every door it held was
 * enumerated, given a home on a screen and asserted there first.
 *
 * These are the assertions that the retirement is complete rather than merely intended. They
 * are worth keeping after the fact because the failure they catch is a quiet one — a room
 * that starts pointing at the page again, or a standing that comes back with nothing to be.
 */
describe('the old operating page has retired, and left nothing behind pointing at it', () => {
  it('is not an address this cockpit hands over any more', () => {
    const view = cockpitView(store)

    expect(view.destinations.map((room) => room.path)).not.toContain('/operating')
    expect(view.destinations.map((room) => room.id)).not.toContain('operating')
    expect(JSON.stringify(view)).not.toContain('operating page')
  })

  it('is named by no unbuilt room, because there is no page left to send anyone to', () => {
    for (const room of cockpitView(store).destinations) {
      if (room.notYetBecause === null) continue
      // The two left are E6's, and nothing in this build generates an image or assembles a
      // cut on ANY page. A door offered here would be one invented to look like an answer.
      expect(room.notYetBecause, `${room.id} still points at the old page`).not.toContain(
        'operating page',
      )
    }
  })

  it('has no standing of its own left to wear', () => {
    expect(COCKPIT_STANDING).not.toContain('scaffolding')
    for (const room of cockpitView(store).destinations) {
      expect(COCKPIT_STANDING).toContain(room.standing)
    }
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

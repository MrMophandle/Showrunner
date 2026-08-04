import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import {
  appendWaypoint,
  arcHistory,
  createArc,
  declarePosition,
  editStatement,
  episodesNeedingRecheck,
  insertWaypoint,
  isVanilla,
  positionsOf,
  renameWaypoint,
  waypointsOf,
} from './arc.ts'
import { createEpisode, createSeason, createShow } from './spine.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => {
  store.close()
})

function seedSeason() {
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  return { show, season }
}

/** "The beacon" from the arc page mockup, cut to three waypoints. */
function seedBeacon() {
  const { show, season } = seedSeason()
  const arc = createArc(store, {
    showId: show.id,
    seasonId: season.id,
    scope: 'season',
    kind: 'story',
    name: 'The beacon',
    statement:
      'A signal has been repeating out of the drift since before the settlement was built. ' +
      'The question the arc asks: what do you owe a voice that was never asking for help?',
  })
  const heard = appendWaypoint(store, arc.id, {
    name: 'heard',
    description: 'The signal is noticed and dismissed as machinery.',
    landingCriteria: 'A character registers the repetition out loud and does nothing about it.',
  })
  const traced = appendWaypoint(store, arc.id, {
    name: 'traced',
    description: 'The signal gets a source and a direction.',
    landingCriteria: 'The crew fixes the origin and argues about approaching it.',
  })
  const answered = appendWaypoint(store, arc.id, {
    name: 'answered',
    description: 'Someone transmits back. The reply is the point of no return.',
    landingCriteria: 'A reply leaves the ship and is acknowledged.',
  })
  return { show, season, arc, heard, traced, answered }
}

describe('arcs and their waypoints', () => {
  it('carries a prose statement and three described waypoints in order', () => {
    const { arc } = seedBeacon()

    expect(arc.statement).toContain('what do you owe a voice')
    expect(waypointsOf(store, arc.id)).toMatchObject([
      { ordinal: 1, name: 'heard', landingCriteria: expect.stringContaining('out loud') },
      { ordinal: 2, name: 'traced', description: expect.stringContaining('source and a direction') },
      { ordinal: 3, name: 'answered', landingCriteria: expect.stringContaining('leaves the ship') },
    ])
  })

  it('binds a season-scoped arc to its season and leaves a show-scoped arc free of one', () => {
    const { show, season } = seedSeason()

    const showArc = createArc(store, {
      showId: show.id,
      scope: 'show',
      kind: 'character',
      name: 'Vessa ↔ Ferro · trust',
      statement: 'Whether Vessa can take Ferro at his word.',
    })

    expect(showArc.seasonId).toBeNull()
    expect(() =>
      createArc(store, {
        showId: show.id,
        seasonId: season.id,
        scope: 'show',
        kind: 'story',
        name: 'Contradiction',
        statement: 'A show-scoped arc has no business naming a season.',
      }),
    ).toThrow(/CHECK/i)
  })
})

describe('episodes declaring their position on an arc', () => {
  it('records the position the episode declares', () => {
    const { season, arc, traced } = seedBeacon()
    const ep03 = createEpisode(store, { seasonId: season.id, number: 3, title: 'Hull Song' })

    declarePosition(store, { episodeId: ep03.id, arcId: arc.id, waypointId: traced.id })

    expect(positionsOf(store, ep03.id)).toMatchObject([
      { arc: { name: 'The beacon' }, waypoint: { name: 'traced', ordinal: 2 } },
    ])
  })

  it('calls an episode touching no arc vanilla — legal, tracked, never a failure', () => {
    const { season } = seedBeacon()
    const ep07 = createEpisode(store, { seasonId: season.id, number: 7, title: 'Shore Leave' })

    expect(isVanilla(store, ep07.id)).toBe(true)
    expect(positionsOf(store, ep07.id)).toEqual([])
  })
})

describe('inserting a waypoint mid-sequence', () => {
  it('renumbers the waypoints after it', () => {
    const { arc } = seedBeacon()

    insertWaypoint(store, arc.id, {
      atOrdinal: 3,
      name: 'doubted',
      description: 'The crew argues about whether the signal is even real.',
      landingCriteria: 'Someone proposes ignoring it and is taken seriously.',
      note: 'the reply needs a beat of resistance before it',
    })

    expect(waypointsOf(store, arc.id).map((w) => [w.ordinal, w.name])).toEqual([
      [1, 'heard'],
      [2, 'traced'],
      [3, 'doubted'],
      [4, 'answered'],
    ])
  })

  it('flags the episode that declared a later position for re-check', () => {
    const { season, arc, traced, answered } = seedBeacon()
    const ep03 = createEpisode(store, { seasonId: season.id, number: 3, title: 'Hull Song' })
    const ep05 = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' })
    declarePosition(store, { episodeId: ep03.id, arcId: arc.id, waypointId: traced.id })
    declarePosition(store, { episodeId: ep05.id, arcId: arc.id, waypointId: answered.id })

    insertWaypoint(store, arc.id, {
      atOrdinal: 3,
      name: 'doubted',
      description: 'The crew argues about whether the signal is even real.',
      landingCriteria: 'Someone proposes ignoring it and is taken seriously.',
    })

    const flagged = episodesNeedingRecheck(store, arc.id)
    expect(flagged).toHaveLength(1)
    expect(flagged[0]).toMatchObject({
      episode: { number: 5 },
      waypoint: { name: 'answered' },
      declaredOrdinal: 3,
      currentOrdinal: 4,
    })
    expect(flagged[0]!.reason).toContain('waypoint 3')
    expect(flagged[0]!.reason).toContain('waypoint 4')
  })

  it('clears the flag when the episode re-declares its position', () => {
    const { season, arc, answered } = seedBeacon()
    const ep05 = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' })
    declarePosition(store, { episodeId: ep05.id, arcId: arc.id, waypointId: answered.id })
    insertWaypoint(store, arc.id, {
      atOrdinal: 3,
      name: 'doubted',
      description: 'The crew argues.',
      landingCriteria: 'Someone proposes ignoring it.',
    })
    expect(episodesNeedingRecheck(store, arc.id)).toHaveLength(1)

    declarePosition(store, { episodeId: ep05.id, arcId: arc.id, waypointId: answered.id })

    expect(episodesNeedingRecheck(store, arc.id)).toEqual([])
  })
})

describe('the arc’s edit history', () => {
  it('keeps Ryan’s note on a waypoint rename', () => {
    const { arc, answered } = seedBeacon()

    renameWaypoint(store, answered.id, {
      name: 'the lie',
      note: 'the truth is what they find; the lie is what it always was',
    })

    expect(waypointsOf(store, arc.id)[2]!.name).toBe('the lie')
    expect(arcHistory(store, arc.id)[0]).toMatchObject({
      kind: 'waypoint-renamed',
      summary: '“answered” renamed to “the lie”',
      note: 'the truth is what they find; the lie is what it always was',
    })
  })

  it('records the arc’s life newest-first — created, waypoints, statement edits', () => {
    const { arc } = seedBeacon()

    editStatement(store, arc.id, {
      statement: 'It was bait, and it has been working for nine years.',
      note: 'sharpened after the ep05 gate',
    })

    expect(arcHistory(store, arc.id).map((e) => e.kind)).toEqual([
      'statement-edited',
      'waypoint-added',
      'waypoint-added',
      'waypoint-added',
      'arc-created',
    ])
  })
})

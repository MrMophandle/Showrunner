import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import {
  createEpisode,
  createSeason,
  createShow,
  delineateScenes,
  episodesOf,
  findShowByKey,
  moveLifecycleTo,
  scenesOf,
} from './spine.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => {
  store.close()
})

describe('the spine — show → season → episode → scene', () => {
  it('builds a show, a season, and an episode inside it', () => {
    const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
    const season = createSeason(store, { showId: show.id, number: 1, title: 'The Drift' })
    const episode = createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' })

    expect(findShowByKey(store, 'greyharbor')).toEqual(show)
    expect(episodesOf(store, season.id)).toEqual([episode])
    expect(episode.lifecycle).toBe('premise')
  })

  it('refuses a second episode with the same number in one season', () => {
    const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
    const season = createSeason(store, { showId: show.id, number: 1 })
    createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' })

    expect(() =>
      createEpisode(store, { seasonId: season.id, number: 5, title: 'A Different Deck' }),
    ).toThrow(/UNIQUE/i)
  })

  it('walks an episode along its lifecycle', () => {
    const episode = seedEpisode()

    expect(moveLifecycleTo(store, episode.id, 'outline').lifecycle).toBe('outline')
    expect(moveLifecycleTo(store, episode.id, 'script').lifecycle).toBe('script')
    expect(moveLifecycleTo(store, episode.id, 'assets').lifecycle).toBe('assets')
  })

  it('numbers scenes in the order the writer broke them — the count is an output', () => {
    const episode = seedEpisode()

    const scenes = delineateScenes(store, episode.id, [
      { heading: 'Mess deck', summary: 'Vessa and Ferro, still docked.' },
      { heading: 'Corridor spine' },
      { heading: 'The quiet deck (deck 9)' },
    ])

    expect(scenes.map((s) => s.ordinal)).toEqual([1, 2, 3])
    expect(scenes.map((s) => s.heading)).toEqual([
      'Mess deck',
      'Corridor spine',
      'The quiet deck (deck 9)',
    ])
    // num_scenes is read off the episode, never handed to it (D3).
    expect(scenesOf(store, episode.id)).toHaveLength(3)
  })

  it('keeps the ids of scenes that did not move when the episode is re-delineated', () => {
    const episode = seedEpisode()
    const first = delineateScenes(store, episode.id, [
      { heading: 'Mess deck' },
      { heading: 'Corridor spine' },
      { heading: 'The quiet deck (deck 9)' },
    ])

    const second = delineateScenes(store, episode.id, [
      { heading: 'Mess deck' },
      { heading: 'Corridor spine, dark' },
    ])

    expect(second.map((s) => s.id)).toEqual([first[0]!.id, first[1]!.id])
    expect(second[1]!.heading).toBe('Corridor spine, dark')
    expect(scenesOf(store, episode.id)).toHaveLength(2)
  })
})

function seedEpisode() {
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  return createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' })
}

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

  /**
   * **A scene is its heading** (E4-3, `domain/delineate.ts`). The three edges of the rule, one
   * test apiece — the third is the one that decided it, because under the ordinal identity this
   * replaced, every anchor after an insertion moved one scene up in silence.
   */
  describe('re-delineating an episode', () => {
    const first = (episodeId: string) =>
      delineateScenes(store, episodeId, [
        { heading: 'Mess deck' },
        { heading: 'Corridor spine' },
        { heading: 'The quiet deck (deck 9)' },
      ])

    it('keeps the id of every scene whose heading is still there', () => {
      const episode = seedEpisode()
      const before = first(episode.id)

      const after = delineateScenes(store, episode.id, [
        { heading: 'Mess deck', summary: 'Rewritten, and still the mess deck.' },
        { heading: 'The quiet deck (deck 9)' },
      ])

      expect(after.map((s) => s.id)).toEqual([before[0]!.id, before[2]!.id])
      expect(after.map((s) => s.ordinal)).toEqual([1, 2])
      expect(after[0]!.summary).toBe('Rewritten, and still the mess deck.')
      expect(scenesOf(store, episode.id)).toHaveLength(2)
    })

    it('raises a NEW scene for a renamed heading, and takes the old one with it', () => {
      const episode = seedEpisode()
      const before = first(episode.id)

      const after = delineateScenes(store, episode.id, [
        { heading: 'Mess deck' },
        { heading: 'Corridor spine, dark' },
        { heading: 'The quiet deck (deck 9)' },
      ])

      // The renamed one is a different scene, and it does not inherit the old id. Anything
      // anchored in the old scene degrades to the whole artifact (`ON DELETE SET NULL`, 0010)
      // rather than being re-pointed at prose nobody checked.
      expect(after[1]!.id).not.toBe(before[1]!.id)
      expect(after.map((s) => s.id)).toEqual([before[0]!.id, after[1]!.id, before[2]!.id])
      expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM scene WHERE id = ?', before[1]!.id)!.n)
        .toBe(0)
    })

    it('shifts the ordinals around a scene inserted in the middle and moves no identity', () => {
      const episode = seedEpisode()
      const before = first(episode.id)

      const after = delineateScenes(store, episode.id, [
        { heading: 'Mess deck' },
        { heading: 'The airlock, ninety seconds' },
        { heading: 'Corridor spine' },
        { heading: 'The quiet deck (deck 9)' },
      ])

      // Identity is not the ordinal: scene 2 of the last draft is scene 3 of this one and it is
      // the SAME ROW, so a finding anchored in it still lands on the prose it argued with.
      expect(after.map((s) => [s.ordinal, s.heading])).toEqual([
        [1, 'Mess deck'],
        [2, 'The airlock, ninety seconds'],
        [3, 'Corridor spine'],
        [4, 'The quiet deck (deck 9)'],
      ])
      expect(after[2]!.id).toBe(before[1]!.id)
      expect(after[3]!.id).toBe(before[2]!.id)
    })

    it('refuses two scenes with one heading — that is an ambiguity, not a duplicate', () => {
      const episode = seedEpisode()

      expect(() =>
        delineateScenes(store, episode.id, [
          { heading: 'The long pier' },
          { heading: 'Mess deck' },
          { heading: 'The long pier' },
        ]),
      ).toThrow(/both “The long pier”.*a scene is its heading/s)
      // And it refused before it wrote anything: the whole delineation is one transaction.
      expect(scenesOf(store, episode.id)).toEqual([])
    })
  })
})

function seedEpisode() {
  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  return createEpisode(store, { seasonId: season.id, number: 5, title: 'The Quiet Deck' })
}

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { abandonEpisode } from './episode-canon.ts'
import { advanceOnApproval } from './lifecycle.ts'
import {
  createEpisode,
  createSeason,
  createShow,
  findEpisode,
  moveLifecycleTo,
  type Episode,
} from './spine.ts'

/**
 * The lifecycle seam (1.1): **an episode's lifecycle names the stage it is AT, and a
 * stage's gate approving is what moves it on.**
 *
 * Everything below is one ruling read four ways, and every one of them was a way to get
 * it wrong: "at premise" is premise work not yet done; the approval and not the artifact
 * is what moves it; an abandoned episode keeps the stage it reached; and it never walks
 * backwards, however late a ruling on an early gate arrives.
 */

let root: string
let paths: LibraryPaths
let store: Store
let episode: Episode

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-lifecycle-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)

  const show = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' })
  const season = createSeason(store, { showId: show.id, number: 1 })
  episode = createEpisode(store, { seasonId: season.id, number: 2, title: 'Dry Stores' })
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const lifecycleOf = (): string => findEpisode(store, episode.id)!.lifecycle

describe('an episode sits at the stage it is doing', () => {
  it('starts at premise, which is premise work NOT yet done', () => {
    expect(lifecycleOf()).toBe('premise')
  })

  it('moves to outline when the premise gate is approved, and says so', () => {
    const move = advanceOnApproval(store, episode.id, 'premise')

    expect(move).toMatchObject({ from: 'premise', to: 'outline', moved: true })
    expect(move.sentence).toBe('ep02 moves from premise to outline — you approved its premise gate.')
    expect(lifecycleOf()).toBe('outline')
  })

  it('is idempotent: approving the same gate again moves nothing', () => {
    advanceOnApproval(store, episode.id, 'premise')
    const again = advanceOnApproval(store, episode.id, 'premise')

    expect(again).toMatchObject({ from: 'outline', to: 'outline', moved: false })
    expect(again.sentence).toContain('already past premise')
    expect(lifecycleOf()).toBe('outline')
  })

  it('never walks an episode backwards', () => {
    moveLifecycleTo(store, episode.id, 'script')

    const move = advanceOnApproval(store, episode.id, 'premise')

    expect(move.moved).toBe(false)
    expect(lifecycleOf()).toBe('script')
  })

  it('has nowhere to send the last stop', () => {
    moveLifecycleTo(store, episode.id, 'published')

    const move = advanceOnApproval(store, episode.id, 'published')

    expect(move).toMatchObject({ from: 'published', to: 'published', moved: false })
    expect(move.sentence).toContain('published is the last stop')
  })
})

describe('an abandoned episode keeps the stage it reached', () => {
  it('does not move, and says which stage it died at', () => {
    abandonEpisode(store, episode.id, { note: 'the exchanger story is ep05’s, not this one’s.' })

    const move = advanceOnApproval(store, episode.id, 'premise')

    expect(move).toMatchObject({ from: 'premise', to: 'premise', moved: false })
    expect(move.sentence).toContain('was abandoned at premise')
    expect(lifecycleOf()).toBe('premise')
    // `abandoned_at` is a column beside the enum and never a member of it (spine.ts): the
    // episode is dead AND it is at premise, and both are readable a season later.
    expect(findEpisode(store, episode.id)!.abandonedAt).not.toBeNull()
  })
})

describe('it refuses what it cannot answer about', () => {
  it('says so for an episode that is not in this library', () => {
    expect(() => advanceOnApproval(store, 'ep_nope', 'premise')).toThrow(/ep_nope/)
  })
})

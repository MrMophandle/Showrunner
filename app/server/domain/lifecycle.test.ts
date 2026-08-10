import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { abandonEpisode } from './episode-canon.ts'
import {
  advanceOnApproval,
  advanceOnPresentedApproval,
  notYetReachedBecause,
} from './lifecycle.ts'
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
 * Everything below is one ruling read five ways, and every one of them was a way to get
 * it wrong: "at premise" is premise work not yet done; the approval and not the artifact
 * is what moves it; an abandoned episode keeps the stage it reached; it never walks
 * backwards, however late a ruling on an early gate arrives; and — the fifth, E4-2's — the
 * column read BACKWARDS is the honest answer to "has the work above this been ruled on",
 * which is what lets a writing stage refuse before the click instead of after it.
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

/**
 * The reading half (E4-2): the same order asked backwards, so a stage that writes from a
 * ruled upstream can refuse in words before the click instead of discovering it in a run.
 */
describe('a stage the episode has not reached yet', () => {
  it('is refused with what to rule on first, in words', () => {
    const because = notYetReachedBecause(store, episode.id, 'outline')!

    expect(because).toContain('ep02 is at premise and has not reached outline yet')
    expect(because).toContain('you have not approved its premise')
    expect(because).toContain('Rule on the ep02 premise first')
  })

  it('names the stage before it, whichever stage is asked about', () => {
    expect(notYetReachedBecause(store, episode.id, 'script')).toContain('approved its outline')
    expect(notYetReachedBecause(store, episode.id, 'assets')).toContain('approved its script')
  })

  it('has nothing to say about premise, because premise is the first stop', () => {
    // Not an exemption — the rule is one rule and this is where it is vacuous. It is also
    // why the premise stage cannot be refused by it any more than it can be walled by D12.
    expect(notYetReachedBecause(store, episode.id, 'premise')).toBeNull()
  })

  it('stands aside once the episode is there, and once it is past', () => {
    moveLifecycleTo(store, episode.id, 'outline')
    expect(notYetReachedBecause(store, episode.id, 'outline')).toBeNull()

    // Past it, deliberately: an episode that ran ahead and left a gap is a gap worth
    // filling, and "there is already one of those" is a different question asked of the
    // artifact rather than of the column (runner/write-step.ts).
    moveLifecycleTo(store, episode.id, 'assembled')
    expect(notYetReachedBecause(store, episode.id, 'outline')).toBeNull()
  })
})

/**
 * **A ruling is a ruling, whichever door convened it** (#76) — and the door that convenes one
 * over an artifact nothing in this app wrote takes no precondition, so the "AT" test the
 * writing stage gets from `notYetReachedBecause` is made here instead.
 */
describe('an approval at a presenting gate', () => {
  it('moves the episode on when it is standing AT the stage that produces what he ruled on', () => {
    const move = advanceOnPresentedApproval(store, episode.id, 'premise')

    expect(move).toMatchObject({ from: 'premise', to: 'outline', moved: true })
    expect(move.sentence).toBe('ep02 moves from premise to outline — you approved its premise gate.')
    expect(lifecycleOf()).toBe('outline')
  })

  it('moves nothing when the episode is PAST that stage — nothing is retroactive', () => {
    moveLifecycleTo(store, episode.id, 'script')

    const move = advanceOnPresentedApproval(store, episode.id, 'premise')

    expect(move).toMatchObject({ from: 'script', to: 'script', moved: false })
    expect(move.sentence).toContain('premise is not the stage it is standing at')
    expect(lifecycleOf()).toBe('script')
  })

  it('moves nothing when the episode has not reached that stage — no skipping ahead', () => {
    // An imported episode holding a script while it stands at premise (E7's shape). Ruling on
    // that script is a ruling; it is not four stages' worth of approvals nobody gave.
    const move = advanceOnPresentedApproval(store, episode.id, 'script')

    expect(move).toMatchObject({ from: 'premise', to: 'premise', moved: false })
    expect(move.sentence).toContain('script is not the stage it is standing at')
    expect(lifecycleOf()).toBe('premise')
  })

  it('carries the four rules whole — it does not re-decide one of them', () => {
    // The abandoned rule, asked through this door: the episode is AT premise, so the "AT" test
    // stands aside and `advanceOnApproval` answers, which is the point of delegating to it.
    abandonEpisode(store, episode.id, { note: 'ep05 tells this better.' })

    const move = advanceOnPresentedApproval(store, episode.id, 'premise')

    expect(move.moved).toBe(false)
    expect(move.sentence).toContain('was abandoned at premise')
    expect(lifecycleOf()).toBe('premise')
  })
})

describe('it refuses what it cannot answer about', () => {
  it('says so for an episode that is not in this library', () => {
    expect(() => advanceOnApproval(store, 'ep_nope', 'premise')).toThrow(/ep_nope/)
    expect(() => notYetReachedBecause(store, 'ep_nope', 'outline')).toThrow(/ep_nope/)
  })
})

import type { Store } from '../db/store.ts'
import {
  EPISODE_LIFECYCLE,
  episodeLabel,
  findEpisode,
  moveLifecycleTo,
  type Episode,
  type EpisodeLifecycle,
} from './spine.ts'

/**
 * **The one seam an episode's lifecycle moves through** (1.1, E4-1) — and the ruling it
 * encodes, which is the thing later stages inherit rather than re-decide.
 *
 * ## Lifecycle names the stage the episode is AT, not the stage it has finished
 *
 * ep02 of the fixture sits at `premise` with nothing produced, and its own sheet says why:
 * "Nobody has written a premise for it." So `premise` is **premise work not yet done**. The
 * opposite reading is the one that costs a season: an episode created at `premise` would
 * mean "the premise is written", the floor would render six stops of which the first is
 * always green, and "where is this episode" would stop being answerable from the column.
 *
 * It follows that **the gate is what moves it, not the artifact**. A draft on the volume is
 * a draft; a draft Ryan approved is the stage done. Nothing here is called when a producer
 * writes, when a check reads, or when a correction round lands — only when a ruling closes
 * the stage's gate (approve, or approve-over-something, which is an approval with a record;
 * invariant 3). One consequence worth stating: a rejected gate moves nothing, which is
 * exactly right, because "reject is routed, not rewound" (D21) sends the work back INTO the
 * stage the episode is still at.
 *
 * ## Why a function and not a convention
 *
 * The writing line has three stages and E6/E7 add more, and every one of them ends the same
 * way: a gate closes and the episode is somewhere new. Said as a convention — "remember to
 * call `moveLifecycleTo` in your last step" — it is one forgotten call away from an episode
 * stuck at `premise` with a script in the library. So the four rules below live here, once,
 * and `runner/write-step.ts` builds every writing stage with the closing step already on it:
 * a stage cannot be added without the seam, because the builder is the seam.
 *
 *   1. **Forward only.** An episode at `script` whose premise gate is ruled late stays at
 *      `script`. `reached` is the word the floor's track uses (`lifecycleTrack`), and a
 *      column that could walk backwards would make it a lie about the past.
 *   2. **Idempotent.** Steps are re-run after a crash (2.2), and re-entering a closed stage
 *      must be free. Asked twice, the second answer is "already past premise" and no write.
 *   3. **The last stop stays put.** `published` has nowhere to go, and inventing a seventh
 *      stop to have somewhere would be a lifecycle nobody ruled.
 *   4. **An abandoned episode keeps the stage it reached.** `abandoned_at` is a column
 *      beside the enum and never a member of it (spine.ts, 1.1) — the two facts are
 *      orthogonal, and an episode Ryan put down at `premise` is a dead episode that got as
 *      far as `premise`. Advancing one would overwrite the only record of how far it got.
 *
 * **It moves a column and rules nothing.** Only ratification writes canon (invariant 1);
 * a lifecycle position is not canon, and this writes no fact, raises no proposal, and
 * touches no ledger. The completion sweep at approval (1.2, `sweepEpisode`) is the other
 * half of an approval and is deliberately not called from here: collecting the proposals
 * riding an episode is a ruling pass Ryan sits in, not a side effect of a column move.
 *
 * ## The reading half, and why it lives here too (E4-2)
 *
 * If an approval is the only thing that moves the column, then the column is the honest
 * answer to "has the work above this been ruled on" — and a stage that needs a ruled upstream
 * asks it here rather than going and finding a gate of its own. `notYetReachedBecause` is
 * that read, and it is the same `EPISODE_LIFECYCLE` order pointed backwards: an episode still
 * at `premise` has not had its premise-brief approved, so the outline has nothing ruled to be
 * written from and the offer says so before the click.
 *
 * A gate-shaped answer was the alternative and it is worse in the way that matters: a stage
 * would then be asking about a gate that may have been rejected, deferred, re-opened or never
 * built, and two stages asking it two ways is how the writing line ends up with two opinions
 * of "approved". One column, one order, one reading.
 */

/** What the seam did, and the words the run's closing step says about it. */
export interface LifecycleMove {
  episode: Episode
  from: EpisodeLifecycle
  /** Where it now stands. The same as `from` whenever `moved` is false. */
  to: EpisodeLifecycle
  moved: boolean
  /** Why it moved, or why it did not — read on the floor and in the run's own log. */
  sentence: string
}

/**
 * Move an episode on, because the gate that closes `completed` was approved.
 *
 * `completed` is the stage whose gate has just been ruled, never the stage to move to: a
 * caller that named its destination would be free to name any of them, and the order of
 * the line would live at six call sites instead of in `EPISODE_LIFECYCLE`.
 */
export function advanceOnApproval(
  store: Store,
  episodeId: string,
  completed: EpisodeLifecycle,
): LifecycleMove {
  const episode = findEpisode(store, episodeId)
  if (!episode) throw new Error(`No such episode: ${episodeId}`)

  const label = episodeLabel(episode.number)
  const from = episode.lifecycle
  const stayingPut = (because: string): LifecycleMove => ({
    episode,
    from,
    to: from,
    moved: false,
    sentence: because,
  })

  if (episode.abandonedAt !== null) {
    return stayingPut(
      `${label} was abandoned at ${from}, on ${episode.abandonedAt}, and keeps the stage it ` +
        'reached — an episode dies at a stage, it does not carry on past one.',
    )
  }

  const next = EPISODE_LIFECYCLE[EPISODE_LIFECYCLE.indexOf(completed) + 1]
  if (next === undefined) {
    return stayingPut(
      `${label} stays at ${from} — ${completed} is the last stop of the lifecycle, and there ` +
        'is nothing after it to move to.',
    )
  }
  if (EPISODE_LIFECYCLE.indexOf(from) >= EPISODE_LIFECYCLE.indexOf(next)) {
    return stayingPut(
      `${label} stays at ${from} — it is already past ${completed}, and a lifecycle position ` +
        'is how far an episode has got, so it never walks backwards.',
    )
  }

  return {
    episode: moveLifecycleTo(store, episodeId, next),
    from,
    to: next,
    moved: true,
    sentence: `${label} moves from ${from} to ${next} — you approved its ${completed} gate.`,
  }
}

/**
 * Why work at this stage cannot start on this episode yet, in words — or null when it can.
 *
 * The mirror of `advanceOnApproval`: that one says an approval moved the episode here, this
 * one says nothing has. It answers about the STAGE, not about an artifact, so a stage with a
 * ruled upstream and no draft of its own is offerable and one with neither is refused with a
 * sentence naming what to rule on first.
 *
 * **It can only ever refuse a stage that has something before it**, which is not a special
 * case but the same fact E4-1 recorded from the other side: the premise is the first stop, so
 * an episode can never be short of it, and the premise stage therefore cannot be refused by
 * this any more than it can be walled by D12. The rule is one rule; `premise` is where it is
 * vacuous.
 *
 * Being PAST the stage is deliberately not refused here. An episode that ran ahead and left a
 * gap is a gap worth filling, and "there is already one of those" is a different question with
 * a different sentence (`runner/write-step.ts`), asked of the artifact rather than the column.
 */
export function notYetReachedBecause(
  store: Store,
  episodeId: string,
  stage: EpisodeLifecycle,
): string | null {
  const episode = findEpisode(store, episodeId)
  if (!episode) throw new Error(`No such episode: ${episodeId}`)

  const previous = EPISODE_LIFECYCLE[EPISODE_LIFECYCLE.indexOf(stage) - 1]
  if (previous === undefined) return null
  if (EPISODE_LIFECYCLE.indexOf(episode.lifecycle) >= EPISODE_LIFECYCLE.indexOf(stage)) return null

  const label = episodeLabel(episode.number)
  return (
    `${label} is at ${episode.lifecycle} and has not reached ${stage} yet — you have not ` +
    `approved its ${previous}. Lifecycle names the stage an episode is AT rather than one it ` +
    `has finished (1.1), and an approval at the ${previous} gate is the only thing that moves ` +
    `it on. Rule on the ${label} ${previous} first, and this becomes offerable.`
  )
}

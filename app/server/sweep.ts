import { proposalOnTheBench, BENCH_REFUSALS, type ProposalOnTheBench } from './canon-bench.ts'
import { FREE } from './cost.ts'
import type { Store } from './db/store.ts'
import { sweepEpisode } from './domain/episode-canon.ts'
import type { Proposal } from './domain/proposal.ts'
import { episodeInShow, episodeLabel, findEpisode, type EpisodeLifecycle } from './domain/spine.ts'
import type { Offer } from './operating.ts'

/**
 * **The completion sweep** (E4-6, #66; 1.2, 3.3) — the ruling pass an approved episode still
 * owes canon, and the first caller `sweepEpisode` has ever had.
 *
 * Concept 1.2: *"a completion sweep at episode approval turns implicit established facts into
 * proposals for one last ruling."* E2-3 built the collection (`domain/episode-canon.ts`) and
 * deliberately built nothing that convenes it. This is what convenes it.
 *
 * ## The spec sentence and E4-4's order cannot both be literal, and this is the reconciliation
 *
 * The E2 constraints ledger says, verbatim: *"the final approval gate calls
 * `sweepEpisode(store, episodeId)`, renders each `outstanding` proposal with its own
 * `blastRadius`, and convenes E2-2's `createProposalRulings` on them one at a time."*
 *
 * **E4-4 (#64) then ruled the step order that makes the first clause impossible.** The script
 * stage's third step, `extract-the-canon-claims`, runs on the far side of the gate, because it
 * reads the draft Ryan APPROVED — extraction inside the loop would read a round 2 might
 * replace, and buy proposals about prose nobody keeps (`runner/claim-step.ts` carries the
 * argument). So at the moment the gate renders, **the riders extraction will raise do not
 * exist yet.** A sweep called from inside that gate would present an empty pass, and would
 * then have nothing to say about the stack that landed a second later.
 *
 * Three ways out, and the third is the one taken.
 *
 *   * **Move extraction back in front of the gate.** That is E4-4's ruling reopened to save a
 *     sentence, and its reasons are unchanged: a paid reading of a draft the loop may still
 *     rewrite is spend and noise.
 *   * **Open a second gate after extraction and sweep at that one.** A gate is ONE artifact
 *     and one ruling (D15, 4.6) and it renders its artifact; a sweep is N proposals, each with
 *     its own blast radius and its own row on `canon_ruling`. A gate's three verbs are
 *     approve / override / reject and none of them is `ratify` — teaching one of them to
 *     dispose of a stack is precisely the bulk approve the ledger forbids in as many words.
 *   * **The sweep is the pass that stands OWED once the script is approved and the extraction
 *     has landed.** It is surfaced from the EPISODE rather than from a gate: every rider
 *     presented one at a time, each ruled through the one API, each on its own ledger row.
 *     "Episode approval" in 1.2's sense is complete when the pass is — the approval at the
 *     gate is what makes the pass owed, and the pass is what finishes it.
 *
 * **The third is a truer reading of the design than the sentence it amends, not a retreat**,
 * and four things say so:
 *
 *   1. **A ruling needs no gate, and `proposal.ts` says it in as many words**: "nothing here
 *      requires a gate, a run, or an episode to accept a verdict… a gate CONVENES a ruling, it
 *      is never a precondition for one." The spec named a gate because a gate was where E2
 *      expected Ryan to be standing, not because a ruling needs one.
 *   2. **The riders do not all arrive at one moment.** Extraction raises after the gate (E4-4);
 *      a check remediation's canon change is raised mid-loop and rides the episode (E3-5); the
 *      bench's add-a-fact door can raise one riding an episode whenever Ryan likes (#39); and a
 *      hand edit raises nothing at all and leaves whatever rides riding (E4-5). A sweep bolted
 *      to one gate's moment collects what existed at that moment. A pass computed from the
 *      queue collects whatever rides, whenever he looks.
 *   3. **A deferral has to outlive the moment.** Deferring a rider parks it, stops it riding,
 *      and leaves it rulable later from the queue (3.3) — which is only coherent while the pass
 *      is a standing obligation rather than a modal step inside a run.
 *   4. **The run has to be free to end.** E4-4 already ruled that a failed extraction leaves
 *      the episode where it stood with the gate approved. A sweep living inside the run would
 *      make Ryan's owed ruling pass a hostage to that run's health.
 *
 * Everything else in the spec sentence is kept literally: **each rider with its own blast
 * radius, ruled ONE AT A TIME through `createProposalRulings`, and no bulk approve anywhere.**
 *
 * ## It collects. It never generates, prompts, or re-reads a word
 *
 * The E2 ledger's rule is law here and nothing in this file bends it: the sweep collects
 * EXISTING proposals only. Extracting the implicit facts out of written prose is LLM work and
 * it is E4-4's step, which raises without a line changing here — exactly as predicted. **This
 * module imports no adapter and no extractor**, and a script Ryan edited by hand may carry
 * claims nobody raised: that was chosen (E4-5), and their door is the bench's add-a-fact
 * (#39), not a sweep that helpfully re-reads his prose and bills him for it.
 *
 * ## "Swept" is a sentence derived, never a column
 *
 * There is no sweep table, no `swept_at`, and no lifecycle hook. The episode's card says the
 * pass is owed while riders stand and stops saying it when nothing rides, computed from the
 * queue both times (`sweepOnThePage`). The lifecycle moved when the run's own closing step
 * moved it (E4-1's seam, `domain/lifecycle.ts`); the sweep neither advances it, nor blocks
 * E6's assets work, nor regresses anything. **It is Ryan's owed pass — visible, never a wall.**
 *
 * ## Where it renders from, and why it is not on the event stream
 *
 * The riders are rendered by the canon bench's own `proposalOnTheBench`, which already carries
 * the five parts, the blast radius computed at read time (never stored, 1.2) and the three
 * verbs with their refusals. What is composed here is the pass itself: which proposals are on
 * it, which have been ruled, and the sentence that says the episode owes one.
 *
 * A ruling made here convenes no gate, so `event.run_id` has nothing to hang on and `announce`
 * correctly returns without appending (`proposal.ts`, and #29 ruled the same thing for the
 * bench on Aug 7 2026). The pass is re-read from `canon_ruling` after every act, and the Live
 * panel stays runs-and-gates.
 */

/**
 * The one precondition the PAGE owns, because it lives in a textarea the server has never
 * seen. Borrowed from the bench rather than re-worded: a rejection with no note is refused in
 * one string wherever Ryan is standing (`REJECTION_NEEDS_A_NOTE`).
 */
export const SWEEP_REFUSALS = {
  rejectNeedsNote: BENCH_REFUSALS.rejectNeedsNote,
} as const

export type SweepRefusals = typeof SWEEP_REFUSALS

// ── What the pass is handed ─────────────────────────────────────────────────────

export interface EpisodeOnTheSweep {
  id: string
  /** "ep02". */
  label: string
  title: string
  /** Where the episode stands. The sweep never moves it — an approval does (E4-1). */
  lifecycle: EpisodeLifecycle
  /** The day it was put down, or null. Abandoning parks whatever was riding (3.3). */
  abandonedAt: string | null
}

export interface SweepView {
  episode: EpisodeOnTheSweep
  show: { id: string; title: string }
  /** True while anything still rides this episode. Computed from the queue, never stored. */
  owed: boolean
  /** The riders, oldest first — each with its own blast radius and its own three verbs. */
  riders: ProposalOnTheBench[]
  /** Every rider already ruled, in the order they were raised. Kept forever (3.3). */
  ruled: ProposalOnTheBench[]
  /** The owed pass in one sentence, or the sentence that says there is nothing left. */
  sentence: string
  /** Why there is nothing to rule, in words. Null while the pass is owed. */
  nothingBecause: string | null
  refusals: SweepRefusals
}

/**
 * The completion sweep for one episode: what still rides it, what has been ruled, and the
 * sentence that says which of the two this is.
 *
 * `undefined` for an episode this library does not have — the caller answers 404 with it. A
 * READ, and the whole module is: nothing here rules, raises, spends, or writes a row.
 */
export function sweepView(store: Store, episodeId: string): SweepView | undefined {
  const where = episodeInShow(store, episodeId)
  if (!where) return undefined

  const sweep = sweepEpisode(store, episodeId)
  const label = episodeLabel(where.episode.number)
  const owed = sweep.outstanding.length > 0

  return {
    episode: {
      id: where.episode.id,
      label,
      title: where.episode.title,
      lifecycle: where.episode.lifecycle,
      abandonedAt: where.episode.abandonedAt,
    },
    show: { id: where.show.id, title: where.show.title },
    owed,
    riders: sweep.outstanding.map((proposal) => proposalOnTheBench(store, proposal)),
    ruled: sweep.ruled.map((proposal) => proposalOnTheBench(store, proposal)),
    sentence: owed ? owedSentence(sweep.sentence, label, sweep.outstanding.length) : sweep.sentence,
    nothingBecause: owed ? null : nothingBecause(label, sweep.ruled.length),
    refusals: SWEEP_REFUSALS,
  }
}

/**
 * The owed pass, in one sentence — **composed on top of the sweep's own**, so the count and
 * the kinds behind it are said in exactly one place (`domain/episode-canon.ts`). What is added
 * here is the only thing this surface knows that the collection does not: that approving the
 * script was not a ruling on any of them, and that each is a ruling of its own.
 */
function owedSentence(collected: string, label: string, riders: number): string {
  return riders === 1
    ? `${collected} It rides ${label} until you rule it — approving the script was not a ` +
        'ruling on it.'
    : `${collected} They ride ${label} until you rule them, one at a time — approving the ` +
        'script was not a ruling on any of them.'
}

/** The two ways a pass is not owed, which are different pieces of news (invariant 4). */
function nothingBecause(label: string, ruled: number): string {
  if (ruled > 0) {
    return (
      `Every proposal that rode ${label}’s writing has been ruled — ${ruled} of them, each on ` +
      'its own row of the ledger, and every disposition kept forever (3.3). The pass is done.'
    )
  }
  return (
    `Nothing has ever ridden ${label}’s writing, so there is no pass to make. Approving its ` +
    'script buys the reading that raises what the script claimed of canon (E4-4); a check ' +
    'remediation and the canon bench can each raise one riding it too. Until one does, this ' +
    'episode owes canon nothing.'
  )
}

// ── What the episode's card says, while anything rides (D15, 5.2) ───────────────

/**
 * The derived sentence on the episode card, and the door it names.
 *
 * **Null when nothing rides**, which is the whole of "swept" being a sentence rather than a
 * column: it appears when the queue has something on it and disappears when the queue does,
 * off the same read both times. Nothing is marked, nothing is remembered, and no episode
 * carries a flag saying its pass was made.
 */
export interface SweepOnThePage {
  episodeId: string
  /** How many proposals still ride. Never 0 — the whole object is null then. */
  riders: number
  /** "ep02 carries 3 proposals to rule — … They ride ep02 until you rule them, …" */
  sentence: string
  /** Open the owed pass. Free: it convenes rulings, and a ruling costs nothing. */
  open: Offer
}

/**
 * **The collection, not the pass** — deliberately `sweepEpisode` rather than `sweepView`.
 *
 * The floor renders every episode of every show, and a blast radius is several queries per
 * proposal computed at read (1.2). Composing the whole pass to put a COUNT on a card would
 * price every card at every rider's implications, every page load, to render a sentence that
 * never mentions one. The sentence itself is still single-sourced — `owedSentence`, the same
 * function the pass composes its own with — so the card and the pass can never say two
 * different things about what is owed.
 */
export function sweepOnThePage(store: Store, episodeId: string): SweepOnThePage | null {
  const episode = findEpisode(store, episodeId)
  if (!episode) return null

  const sweep = sweepEpisode(store, episodeId)
  const riders = sweep.outstanding.length
  if (riders === 0) return null

  const label = episodeLabel(episode.number)
  return {
    episodeId,
    riders,
    sentence: owedSentence(sweep.sentence, label, riders),
    open: {
      sentence:
        `Rule the ${riders} proposal${riders === 1 ? '' : 's'} riding ${label} — ` +
        `${riders === 1 ? 'the completion sweep' : 'the completion sweep, one at a time'}, ` +
        'each on its own row of the ledger',
      cost: FREE,
      enabled: true,
      blockedBecause: null,
    },
  }
}

// ── The one refusal this surface owns ───────────────────────────────────────────

/**
 * Why this proposal is not on any episode's sweep, in the words the API refuses with. Null
 * when it is on one.
 *
 * A proposal with no episode rides nothing (`proposal.ts`) — founding's sheets (D25), a
 * premise pitched before an episode exists (5.7), a change Ryan typed at the bench — so no
 * episode's completion pass convenes it. It is not unrulable: it is rulable in the queue, by
 * the same three verbs, which is what the sentence says rather than leaving him to guess.
 */
export function notOnAnEpisodeSweepBecause(proposal: Proposal): string | null {
  if (proposal.episodeId !== null) return null
  return (
    'That proposal rides no episode, so no episode’s completion sweep convenes it — a founding ' +
    'sheet (D25) and a change raised at the canon bench both ride nothing. Rule it in the canon ' +
    'library’s queue, through the same three verbs.'
  )
}

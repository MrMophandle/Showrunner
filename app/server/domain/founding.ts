import type { Store } from '../db/store.ts'
import { createEventLog } from '../events.ts'
import { createProposalRulings, openProposals, type Proposal, type ProposalOrigin } from './proposal.ts'
import { findShow } from './spine.ts'

/**
 * Founding: how a show's canon begins, and D25 in one function.
 *
 * A show does not start with canon in it. It starts with SHEETS — the Grey Harbor fixture
 * (E2-4), a Dead Light archive (E7), the pack a new showrunner writes against 3.5's schema
 * document (E8) — and a loader turns each of them into a `promotion` proposal that rides
 * nothing. This is the other half: Ryan ruling that stack.
 *
 * **There is no bulk write here, and there is no second ruling API.** Every line below ends
 * at `createProposalRulings().ratify`, which is the same call the gate room makes over a
 * script and the bench (E2-6) makes over the queue — a gate says where Ryan was standing,
 * never whether he may rule (proposal.ts). Founding rules a stack one at a time because
 * that is the only verb there is, not because a bulk one was resisted.
 *
 * **It rules only what founding raised**, and that filter is the whole safety of it. A
 * promotion a WRITER raised before its episode existed (5.7) rides nothing too, and
 * ratifying it here would be this function deciding something Ryan never looked at. So
 * founding is defined by origin: `loader` and `import`, the two `PROPOSAL_ORIGIN` values
 * that exist for exactly this (0008 names both). Everything else is left standing in the
 * queue, and the report says so.
 *
 * **One act, one transaction.** A sheet that cannot become canon — a character with no
 * species (D22) — aborts the whole founding rather than leaving half a show ratified and
 * half of it candidate. Fix the sheet and found again; there is nothing to unpick, because
 * nothing was written.
 *
 * What this is NOT is a re-load. Founding happens once per sheet and a proposal is ruled
 * once (3.3), so running it again finds nothing and says so. After it, canon lives in the
 * database and moves by proposals — the sheets are provenance from then on, and a sheet
 * edited afterwards diverges silently and deliberately (fixture/load.ts's header).
 */

/**
 * The origins whose promotions founding rules. Both are sheets read off a disk somewhere,
 * which is what makes ratifying them in a stack legitimate: Ryan is approving the documents
 * a show was founded from, not a change somebody proposed to it.
 */
export const FOUNDING_ORIGIN: readonly ProposalOrigin[] = ['loader', 'import']

export interface Founding {
  showId: string
  /** Ratified by this call, in the order they were ruled — oldest raised, first ruled. */
  founded: Proposal[]
  /** Unruled proposals founding deliberately did not touch. Ryan's, at his gate or bench. */
  left: Proposal[]
  /** The line the CLI and the bench print, composed here where it has a test. */
  sentence: string
}

/**
 * Ratifies every unruled founding promotion this show has standing. Returns what it ruled
 * and what it left.
 *
 * The note lands on every ruling and is read back forever (3.3), so it says where the canon
 * came from rather than that something happened.
 */
export function foundCanon(
  store: Store,
  showId: string,
  ruling: { note?: string } = {},
): Founding {
  const show = findShow(store, showId)
  if (!show) throw new Error(`No such show: ${showId}`)

  const note = ruling.note ?? `founded ${show.title} from its sheets`
  const open = openProposals(store, showId)
  const stack = open.filter(isFounding)
  const left = open.filter((proposal) => !isFounding(proposal))

  // The one ruling API, convened rather than reimplemented. The log it takes is never
  // written to and cannot be: `announce` returns on a ruling with no gate, and founding
  // convenes none — 0008 rules that only a ruling made at a gate reaches the wire, because
  // `event.run_id` is NOT NULL and this has no run.
  const rulings = createProposalRulings(store, createEventLog(store))

  const founded = store.transaction(() =>
    stack.map((proposal) => rulings.ratify(proposal.id, { note })),
  )

  return { showId, founded, left, sentence: foundingSentence(founded, left) }
}

/**
 * A promotion, unruled, riding nothing, raised by a loader or an import. All four, because
 * each drops a different thing that must not be founded: a fact delta is a change to canon
 * rather than its beginning, a ruled proposal is history, one that rides an episode belongs
 * to that episode's completion sweep, and one a writer raised is Ryan's to read.
 */
function isFounding(proposal: Proposal): boolean {
  return (
    proposal.kind === 'promotion' &&
    proposal.episodeId === null &&
    proposal.disposition === null &&
    FOUNDING_ORIGIN.includes(proposal.raisedBy)
  )
}

/** "6 sheets ratified — canon as of ruling 6. 2 proposals left for Ryan to rule." */
function foundingSentence(founded: Proposal[], left: Proposal[]): string {
  const remaining =
    left.length === 0
      ? ''
      : ` ${left.length} proposal${left.length === 1 ? '' : 's'} left for Ryan to rule.`

  if (founded.length === 0) {
    return `Nothing left to found — every sheet this show was founded from has been ruled.${remaining}`
  }

  const last = founded[founded.length - 1]!.disposition!.seq
  return (
    `${founded.length} sheet${founded.length === 1 ? '' : 's'} ratified — canon as of ` +
    `ruling ${last}.${remaining}`
  )
}

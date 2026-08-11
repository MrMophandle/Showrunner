import type { ReactNode } from 'react'

/**
 * The honest empty state (E5-0, #80).
 *
 * ── Honest about what, exactly ──────────────────────────────────────────────────
 * That there is nothing there, why, and what there IS instead. The mockups never leave a
 * region blank and never put a spinner where a fact belongs: "**Nothing else in flight.**
 * The S1 idea pool holds 3 greenlit premises and 2 parked." — a lead-in that says the
 * absence and a sentence that says what fills the gap. The dashed border is the mockups'
 * own mark for a box holding nothing yet.
 *
 * The same shape carries the stub screens this issue ships, which is the most honest
 * empty state in the cockpit right now: a screen that says it is not built, names the
 * issue that builds it, and points at the door that still works.
 *
 * Both strings come from the server. A component that wrote "Nothing here yet" would be
 * inventing the one sentence Ryan most needs to be true.
 */

export interface EmptyStateProps {
  /** The absence, said first and said bold — "Nothing else in flight." */
  lead: string
  /** What is there instead, or what to do about it. One sentence, from the wire. */
  sentence: string
  /** An affordance, when the absence has a door. Usually a `SentenceButton`. */
  children?: ReactNode
}

export function EmptyState({ lead, sentence, children }: EmptyStateProps) {
  return (
    <div className="empty">
      <p>
        <span className="empty__lead">{lead}</span> {sentence}
      </p>
      {children}
    </div>
  )
}

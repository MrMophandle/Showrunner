import type { Offer } from '../../server/operating.ts'

/**
 * The only button in the cockpit (E5-0, #80).
 *
 * ── The rule it exists to keep ──────────────────────────────────────────────────
 * Every action states **verb + object + scope + cost** in a full sentence — "Write the
 * ep07 outline · 1 Opus call, ~$0.85" — never "Launch", never "Run", never "Go"
 * (CLAUDE.md, UI rules). And **preconditions come before the button**: an action that
 * cannot be taken renders disabled with the reason in words, evaluated before it is
 * drawn, never as a failure after a click.
 *
 * ── Nothing on it is written here ───────────────────────────────────────────────
 * It takes an `Offer` — the server's own object, with a test where it is composed
 * (`operating.ts`, `canon-bench.ts`, `writing-room.ts`). E4-7's ruling was that **nothing
 * in `app/web/` may hold a refusal string**, after the gate's refusal turned out to be
 * three different sentences for one rule and the browser's copy was the one Ryan actually
 * read. #80 extends it to the whole chrome: no label, no cost line, no reason is authored
 * in a component. If a sentence is missing, the fix is on the server.
 *
 * ── Why the reason takes the cost line's place ──────────────────────────────────
 * Because that is what the mockups draw. "Write the ep08 outline / blocked — the premise
 * isn't greenlit yet", "Assemble ep05 / blocked — 6 shots missing · 3 stale · no mix": the
 * second line says the cost while pressing is possible and says why it is not while it is
 * not. A disabled button has no cost, and printing one would be a price on something that
 * cannot be bought.
 */

export interface SentenceButtonProps {
  offer: Offer
  onClick: () => void
  /** True while a click of this button is in flight. Disables it; the reason is the offer's. */
  busy?: boolean
  /** The dense scale — the gate room's and the arc page's rails run a step smaller. */
  dense?: boolean
  /** Fills its column, the way the episode room's stage rail does. */
  wide?: boolean
  /** The amber weight, for the act that ends with Ryan's word on it. */
  ruling?: boolean
  /** The second verb on a card. Present, never loud. */
  quiet?: boolean
}

export function SentenceButton({
  offer,
  onClick,
  busy = false,
  dense = false,
  wide = false,
  ruling = false,
  quiet = false,
}: SentenceButtonProps) {
  const classes = [
    'btn',
    dense ? 'btn--dense' : '',
    wide ? 'btn--wide' : '',
    ruling ? 'btn--rule' : '',
    quiet ? 'btn--quiet' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    // `disabled` rather than `aria-disabled`, which is what the mockups draw — and it costs
    // something: a disabled button leaves the tab order, so a keyboard-only reader never
    // reaches the reason inside it. The candidate fix (focusable, `aria-disabled`, a click
    // that does nothing) changes what a blocked button IS, so it is recorded in #80's owed
    // list rather than decided here.
    <button type="button" className={classes} disabled={!offer.enabled || busy} onClick={onClick}>
      {offer.sentence}
      <small className="cost">{offer.enabled ? offer.cost : offer.blockedBecause}</small>
    </button>
  )
}

/**
 * A precondition the SCREEN owns rather than reads — a field Ryan has not filled in — is
 * applied to the offer it blocks, so it arrives at the button in exactly the shape a
 * server-side refusal does. The sentence still comes from the wire: the server hands the
 * refusal down (`CHECK_REFUSALS`, `BENCH_REFUSALS`, `GateOnThePage.rejectNeedsNote`) and
 * refuses the same POST with the same words.
 *
 * Carried over from the scaffolding's `kit.tsx`, which is where the pattern was ruled.
 */
export function needing(offer: Offer, typed: string, because: string): Offer {
  if (!offer.enabled || typed.trim() !== '') return offer
  return { ...offer, enabled: false, blockedBecause: because }
}

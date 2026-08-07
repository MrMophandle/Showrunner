import type { Offer } from '../server/operating.ts'

/**
 * The two things both halves of the bare-bones page share: the button, and a handful of
 * inline styles.
 *
 * **This is not a design system** — E1-8's header says why, and E5's cockpit is what gets
 * one, built to `mockups/`. It is one module because the button rule is one rule: every
 * action states verb + object + scope + cost in a full sentence, states the cost BEFORE the
 * click, and renders disabled with the reason in words when it cannot be pressed. Two
 * copies of that component would eventually render it two ways, and the second one would be
 * the one that quietly dropped the cost line.
 */

/**
 * A button, and the only way either page renders one. Every sentence on it was composed on
 * the server (`operating.ts`, `canon-bench.ts`), where it has a test; this renders the
 * strings it was handed and invents none of its own.
 */
export function Button({
  offer,
  busy,
  onClick,
}: {
  offer: Offer
  busy: boolean
  onClick: () => void
}) {
  return (
    <div style={{ margin: '0.6rem 0' }}>
      <button type="button" disabled={!offer.enabled || busy} onClick={onClick} style={BUTTON}>
        {offer.sentence}
        <br />
        <small>{offer.cost}</small>
      </button>
      {offer.blockedBecause && (
        <div>
          <small>Blocked: {offer.blockedBecause}</small>
        </div>
      )}
    </div>
  )
}

/**
 * A precondition the page owns rather than reads, applied to the offer it blocks: the text
 * is in a field the server has never seen, so the server hands down the SENTENCE instead
 * (`refusals`) and the API refuses with the same one. Same shape as every other blocked
 * button — disabled, with the reason in words, before the click.
 */
export function needing(offer: Offer, typed: string, because: string): Offer {
  if (!offer.enabled || typed.trim() !== '') return offer
  return { ...offer, enabled: false, blockedBecause: because }
}

export const PAGE = {
  fontFamily: 'ui-monospace, monospace',
  lineHeight: 1.6,
  padding: '2rem',
  maxWidth: '64rem',
}
export const CARD = { border: '1px solid currentColor', padding: '0.8rem 1rem', margin: '1rem 0' }
export const BUTTON = { font: 'inherit', textAlign: 'left' as const, padding: '0.5rem 0.8rem' }
export const FAINT = { opacity: 0.5 }
export const ARTIFACT = {
  border: '1px solid currentColor',
  padding: '1rem',
  whiteSpace: 'pre-wrap' as const,
  maxHeight: '30rem',
  overflow: 'auto',
}
export const STREAM = { maxHeight: '24rem', overflow: 'auto', fontSize: '0.85rem' }

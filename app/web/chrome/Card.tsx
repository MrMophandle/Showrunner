import type { ReactNode } from 'react'
import { SectionHeader, type Explained } from './SectionHeader.tsx'

/**
 * The surface, and the titled section built on it (E5-0, #80).
 *
 * ── Where it comes from ─────────────────────────────────────────────────────────
 * `.panel` in the mockups: `--card` fill, a 1px `--line` border, a 12px radius. Seven of
 * the eight screens declare it and all seven agree on those three; only the padding
 * wobbles between 16px and 20px, so `chrome.css` takes the median and `drift.test.ts`
 * records the dissenters.
 *
 * ── Why there are two components ────────────────────────────────────────────────
 * `Card` is the surface with no opinion about what is on it — an episode row, a needs-you
 * card, a tile. `Section` is a card that has a NAME, and naming something is what Ryan's
 * second criterion is about, so a `Section` cannot exist without its plain-words
 * explanation: it takes `Explained` and hands it straight to `SectionHeader`, which has
 * no default for it. A screen that wants a titled panel gets the obligation with it.
 *
 * Rows go in `.card-row`, which draws the hairline between them and drops it on the last
 * — every list in every mockup does exactly this.
 */

export interface CardProps {
  children: ReactNode
  /** The raised fill, for a card sitting on another card. */
  raised?: boolean
  className?: string
  id?: string
}

export function Card({ children, raised = false, className = '', id }: CardProps) {
  const classes = ['card', raised ? 'card--raised' : '', className].filter(Boolean).join(' ')
  return (
    <section className={classes} id={id}>
      {children}
    </section>
  )
}

/**
 * A card with a heading — and therefore with an explanation, because `Explained` requires
 * one and there is no way past it. This is the shape almost every panel in the cockpit
 * takes, so the obligation lands on the common path rather than on a reviewer's memory.
 */
export function Section({
  name,
  explains,
  level,
  children,
  raised,
  className,
  id,
}: Explained & { level?: 2 | 3 } & Omit<CardProps, 'children'> & { children: ReactNode }) {
  return (
    <Card raised={raised} className={className} id={id}>
      <SectionHeader name={name} explains={explains} level={level} />
      {children}
    </Card>
  )
}

/** One row of a list inside a card. The hairline is the stylesheet's, not a screen's. */
export function CardRow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card-row ${className}`.trim()}>{children}</div>
}

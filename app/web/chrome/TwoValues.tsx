/**
 * Severity and confidence, side by side, never collapsed (E5-0, #80).
 *
 * ── The invariant this is ───────────────────────────────────────────────────────
 * **Honest confidence** (invariant 4): a finding keeps severity and confidence as two
 * values, never one. Text checks gate hard, image checks flag for Ryan's eye, audio
 * checks verify words only — and a green checkmark standing for any of that is the lie
 * the invariant forbids. The mockups never draw a score, a meter or a tick: they print
 * "severity low · confidence high · text check" in the muted ink and let him read both.
 *
 * ── Why a tuple ────────────────────────────────────────────────────────────────
 * `readings` is typed as a two-element tuple, so **collapsing the pair into one value
 * does not compile**. That is the same move `SectionHeader` makes with its explanation:
 * an invariant that lives in a required shape survives a refactor, and one that lives in
 * a review comment does not.
 *
 * Each reading carries its own label because nothing in `app/web/` writes copy — the word
 * "severity" is the server's, beside the value it labels, so a category that reads its
 * findings on some other axis says so without a change here.
 */

/** One axis of a reading: what it is called, and what it says. Both from the wire. */
export interface Reading {
  label: string
  value: string
}

/**
 * Exactly two. A third axis is a different component and a first-class decision; one
 * axis is the collapse this exists to prevent.
 */
export type Readings = readonly [Reading, Reading]

/** The mockups' separator. A mark between readings, not a word — hidden from a reader. */
function Dot() {
  return (
    <span className="readings__sep" aria-hidden="true">
      ·
    </span>
  )
}

export function TwoValues({ readings, also }: { readings: Readings; also?: string }) {
  const [first, second] = readings
  return (
    <p className="readings">
      <span data-axis={first.label}>
        {first.label} {first.value}
      </span>
      <Dot />
      <span data-axis={second.label}>
        {second.label} {second.value}
      </span>
      {also !== undefined && (
        <>
          <Dot />
          <span>{also}</span>
        </>
      )}
    </p>
  )
}

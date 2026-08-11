import type { ReactNode } from 'react'

/**
 * A section heading that cannot appear without saying what it means (E5-0, #80).
 *
 * ── Why this is a component and not a style guide ───────────────────────────────
 * Ryan ruled the E4 drill off over three frictions, and this is the second of them:
 * *"names for sections that mean nothing to me"* — the scaffolding printed `provenance`,
 * `gate`, `finding`, `sweep` as bare headings, and every one of them is a word from our
 * schema rather than a word from his day.
 *
 * A style guide would say "explain your sections". A required prop makes the compiler say
 * it: there is no way to render a heading in this cockpit without handing over the
 * one-line explanation that goes beside it, because `explains` has no default and no
 * optional marker. **A screen that leaves it out does not compile.** `Chrome.test.tsx`
 * also refuses a blank one at runtime, so a screen cannot satisfy the type with `''`.
 *
 * The mockups already draw this — "ARTIFACTS  freshness is computed, never remembered",
 * "FINDINGS  checks argue, never veto", "HANGING THREADS  computed — time since last
 * touch vs. where the next waypoint sits". The heading is a tracked uppercase micro-label
 * and the explanation sits on its baseline, in the muted ink, where the eye lands next.
 * That is where the schema noun is allowed to be: beside its translation, never alone.
 *
 * ── Both strings come down the wire ─────────────────────────────────────────────
 * Neither is authored here or in any screen (E4-7's rule, extended to the whole chrome by
 * #80). The stub screens read theirs off `/api/cockpit`; a built screen reads its own off
 * the view object the server already composes for it. The browser holds no copy.
 */

/**
 * The two halves of a heading. A section may name a schema noun in `name` only because
 * `explains` is standing next to it.
 */
export interface Explained {
  /** What the section is called — "Artifacts", "Findings", "Arcs across the season". */
  name: string
  /** The same thing in Ryan's words, one line. Never blank; the component refuses one. */
  explains: string
}

/**
 * Thrown when a section tries to name itself without saying what it means. It is a throw
 * rather than a silent fallback because a heading that quietly rendered without its
 * explanation is precisely the state this component exists to make impossible — and a
 * screen would then ship it.
 */
export function headingNeedsAnExplanation(name: string): Error {
  return new Error(
    `the section "${name}" was rendered without a plain-words explanation — a heading in ` +
      'this cockpit says what it means in the same breath, because a schema noun on its ' +
      'own is a name only the database recognises',
  )
}

/**
 * The one place in the cockpit that renders a heading ELEMENT. `Chrome.test.tsx` reads
 * every other file under `app/web/chrome/` and `app/web/screens/` and fails on a raw
 * `<h2>`/`<h3>`, which is how "beside its explanation" stays true of the DOM and not just
 * of this component: a screen cannot open a heading tag anywhere else.
 *
 * It is a real heading rather than a styled paragraph because a screen reader's
 * heading list is Ryan's find-in-page replacement done properly — the third criterion,
 * for anyone who navigates by structure rather than by eye. `h1` is the screen's own
 * title, in the shell; sections are `h2`, and a section inside a section is `h3`.
 */
export function SectionHeader({
  name,
  explains,
  level = 2,
  children,
}: Explained & { level?: 2 | 3; children?: ReactNode }) {
  if (explains.trim() === '') throw headingNeedsAnExplanation(name)
  const Heading = level === 3 ? 'h3' : 'h2'
  return (
    <div className="section-h">
      <Heading className="section-h__name">{name}</Heading>
      <p className="section-h__explains">{explains}</p>
      {/*
       * The count badge the mockups draw beside a heading — "NEEDS YOU ③" — and anything
       * else that belongs ON the heading line rather than under it. `.section-h__count` was
       * already lifted into `chrome.css` by E5-0 for exactly this; E5-1's floor is its
       * first caller. It sits AFTER the explanation deliberately: the obligation is that a
       * name arrives with its plain words, and a badge may not come between the two.
       */}
      {children}
    </div>
  )
}

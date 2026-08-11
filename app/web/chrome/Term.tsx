import { createContext, Fragment, useContext, useId, type ReactNode } from 'react'
import { markTerms, type GlossaryEntry } from '../../server/glossary.ts'

/**
 * A word this cockpit uses, with its meaning one hover or one Tab away (#99).
 *
 * ── It holds no copy, and that is the point ─────────────────────────────────────
 * Both halves come down the wire. The word is whatever the server's sentence already said,
 * and the definition is the server's too — `app/server/glossary.ts`, tested there beside the
 * other words this app puts in front of Ryan. This file contributes the marking and the
 * behaviour and not one syllable of English, which `chrome.test.tsx` asserts by handing it
 * an empty glossary and reading what comes out.
 *
 * ── Hover is not enough ─────────────────────────────────────────────────────────
 * A `title` attribute answers a mouse and nothing else: it does not open on keyboard focus
 * in any browser, and it is unreliable to a screen reader. The E5-0 accessibility baseline
 * says every screen inherits a focus ring and a keyboard path, so the definition opens on
 * `:hover` AND on `:focus-visible`, and is tied to its word with `aria-describedby` so a
 * reader is told it exists without opening anything.
 *
 * The marked word is focusable — `tabIndex={0}` — because a definition you cannot reach
 * without a pointer is a definition half the baseline does not cover. It is not a button:
 * nothing happens when you press it, there is nothing to activate, and calling it one would
 * promise an action this cockpit does not perform.
 *
 * ── Where the marks are, which is a decision rather than a default ──────────────
 * `SectionHeader` is the only caller. Every section in this cockpit is required to carry a
 * plain-words explanation beside its name, so wrapping that one line reaches every screen
 * from one place — and leaves buttons, counts, cost lines and the artifacts themselves
 * unmarked, which is deliberate. The argument is written down in `glossary.ts`.
 */

/**
 * The glossary, as the shell hands it down. Empty by default, so a component rendered
 * outside the shell — in a test, or in a screen mounted on its own — draws its sentence
 * exactly as the server wrote it rather than throwing or drawing nothing.
 */
const Glossary = createContext<readonly GlossaryEntry[]>([])

export function GlossaryProvider({
  glossary,
  children,
}: {
  glossary: readonly GlossaryEntry[]
  children: ReactNode
}) {
  return <Glossary.Provider value={glossary}>{children}</Glossary.Provider>
}

/** What the shell put in the context. Exported for the tests, which assert the default. */
export function useGlossary(): readonly GlossaryEntry[] {
  return useContext(Glossary)
}

/**
 * One sentence with its terms marked. The cutting is `markTerms`, on the server beside the
 * definitions; this walks what it returns. A sentence holding no glossary word comes back
 * as one plain run, so wrapping a line costs nothing when there is nothing in it.
 */
export function Glossed({ text }: { text: string }) {
  const entries = useGlossary()
  if (entries.length === 0) return <>{text}</>

  return (
    <>
      {markTerms(text, entries).map((piece, at) =>
        piece.term === null || piece.definition === null ? (
          <Fragment key={at}>{piece.text}</Fragment>
        ) : (
          <Term key={at} term={piece.term} definition={piece.definition}>
            {piece.text}
          </Term>
        ),
      )}
    </>
  )
}

/**
 * The mark itself: the word as the sentence spelt it, and its definition beside it in the
 * DOM whether or not it is showing. The definition is in the tree at all times rather than
 * mounted on hover, so `aria-describedby` always has something to point at and the box
 * cannot push the line around when it appears — it is taken out of flow by `chrome.css`.
 */
export function Term({
  term,
  definition,
  children,
}: {
  term: string
  definition: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <span className="term">
      <span className="term__word" tabIndex={0} aria-describedby={id} data-term={term}>
        {children}
      </span>
      <span className="term__def" role="tooltip" id={id}>
        {definition}
      </span>
    </span>
  )
}

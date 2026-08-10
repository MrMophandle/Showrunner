/**
 * The freshness sentence (E5-0, #80).
 *
 * ── What it renders, and what it must never do ──────────────────────────────────
 * Staleness is **computed, never remembered** (1.3): there is no `stale` column anywhere
 * in this database, and `artifactFreshness` answers the question off the edges every time
 * it is asked. So this component renders an answer and holds none: it is handed the
 * standing and the sentence, and it caches neither.
 *
 * The mockups say it in words rather than in a colour — "built from script v3; your
 * scene-3 edit made v4", "rebuilt from script v4", "shots 5–7 (scene 3) built from script
 * v3; your scene-3 edit made v4". The pill beside it is a second reading of the same
 * fact, not a substitute for it: `fresh` in green, `3 stale` in amber, and the sentence
 * still there for the eye that wants the reason.
 *
 * Both strings come down the wire (`WrittenOnThePage.staleBecause`, and the sentences
 * `edit.ts` composes). Nothing here writes the word "stale".
 */

export interface FreshnessProps {
  /** The pill's word, from the wire — "fresh", "3 stale", "rebuilt from script v4". */
  standing: string
  /** Why, in one sentence. Null when it is fresh and there is nothing to explain. */
  because: string | null
  /** Drives the colour only. The words are the wire's; this is which of two they wear. */
  stale: boolean
}

export function Freshness({ standing, because, stale }: FreshnessProps) {
  return (
    <p className={`freshness ${stale ? 'freshness--stale' : ''}`.trim()}>
      <span className="freshness__standing">{standing}</span>
      {because !== null && <span>{because}</span>}
    </p>
  )
}

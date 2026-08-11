/**
 * The lifecycle track, and the pip's three states (E5-1, #81).
 *
 * ── The ruling this exists to hold ──────────────────────────────────────────────
 * Ryan ruled it during E5-0's review, Aug 11 2026, and it is recorded on #81:
 *
 *   **done / current-AMBER / running-BLUE-PULSING. Amber means your hand, blue means in
 *   flight — app-wide, forever.**
 *
 * The two mockups that draw a track disagreed, and the disagreement is the whole reason
 * there is a ruling. `floor.html` draws three states: `.stage.done` grey, `.stage.now`
 * amber, `.stage.now.live` blue and pulsing. `episode-room.html` draws two, and paints
 * `.stage.now` BLUE with the pulse on it whether or not anything is running — which would
 * make a stage that is sitting waiting for Ryan look exactly like a stage that is mid-call.
 * **The episode room's spelling is overruled.** The floor's is the system's, and this
 * component is where both screens get it from, so E5-2 inherits an assertion rather than a
 * convention (`chrome.test.tsx` pins all four).
 *
 * `ahead` is the fourth standing and it is the absence of the other three: a stop nothing
 * has reached, drawn hollow. It has no colour because it is not saying anything yet.
 *
 * ── It says the state twice ─────────────────────────────────────────────────────
 * In colour, and in a sentence — because a colour is not a statement, and the whole point
 * of the amber/blue ruling is that two states must never be told apart by hue alone. Every
 * stop carries the server's own sentence ("script — where it stands, and it is yours to
 * move"), and `aria-current` marks the one the episode is at, so a reader navigating by
 * structure gets the same answer an eye does.
 *
 * ── It holds no copy ────────────────────────────────────────────────────────────
 * The stage names are the schema's, handed down the wire; the sentences are composed in
 * `server/floor.ts` where they have tests. This file writes no word of its own.
 */

/** How a stop stands. The ruling's three, plus the absence. */
export type StopStanding = 'done' | 'current' | 'running' | 'ahead'

export interface TrackStop {
  /** "premise", "outline", … — the schema's word for the stage, from the wire. */
  stage: string
  standing: StopStanding
  /** The same thing in Ryan's words. Read aloud; never inferred from the colour. */
  sentence: string
}

export interface LifecycleTrackProps {
  stops: readonly TrackStop[]
  /** What this track is OF — "ep01 lifecycle, premise through published". The server's. */
  label: string
}

export function LifecycleTrack({ stops, label }: LifecycleTrackProps) {
  return (
    <ol className="track" aria-label={label}>
      {stops.map((stop) => (
        <li
          key={stop.stage}
          className={`stage stage--${stop.standing}`}
          // The stop the episode is AT, said to a reader in the one attribute that means
          // "this one" — whether it is his hand or a call in flight.
          aria-current={stop.standing === 'current' || stop.standing === 'running' ? 'step' : undefined}
          title={stop.sentence}
        >
          <span className="pip" aria-hidden="true" />
          <span className="lbl">{stop.stage}</span>
          <span className="visually-hidden">{stop.sentence}</span>
        </li>
      ))}
    </ol>
  )
}

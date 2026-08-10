import type { SweepView } from '../server/sweep.ts'
import { ARTIFACT, Button, CARD, FAINT, needing } from './kit.tsx'

/**
 * The completion sweep, on the page (E4-6) — the ruling pass an approved episode still owes
 * canon, one rider at a time.
 *
 * Same contract as the other two benches: **every sentence here was composed on the server**
 * (`sweep.ts`, and the riders themselves by `canon-bench.ts`'s own queue renderer), and this
 * file renders the strings it was handed. It imports no value from the server, so the browser
 * bundle stays a browser bundle.
 *
 * **There is one verb per rider and there is deliberately no button that rules the pass.** A
 * "ratify the rest" control would be the bulk approve the design forbids (1.2), and its absence
 * is a decision rather than an omission: three riders take three rulings and leave three rows
 * on the ledger. E5 restyles this to the episode room (5.2, D24); it does not get to add a
 * fourth button.
 */

/** What Ryan has typed against a rider and not yet submitted. One note per proposal. */
export interface SweepDraft {
  notes: Record<string, string>
}

export const EMPTY_SWEEP: SweepDraft = { notes: {} }

export interface SweepProps {
  sweep: SweepView
  draft: SweepDraft
  busy: boolean
  onDraft(next: Partial<SweepDraft>): void
  /** One rider, one verdict. There is no signature here that takes a list. */
  onRule(proposalId: string, verdict: 'ratify' | 'reject' | 'defer'): void
  onClose(): void
}

export function Sweep(props: SweepProps) {
  const { sweep, draft, busy } = props

  return (
    <section>
      <h2>
        The {sweep.episode.label} completion sweep{' '}
        <button type="button" onClick={() => props.onClose()}>
          Close this pass
        </button>
      </h2>
      <p>
        {sweep.episode.label} · {sweep.episode.title} — at {sweep.episode.lifecycle}
        {sweep.episode.abandonedAt !== null && ` · abandoned on ${sweep.episode.abandonedAt}`}
      </p>
      <p>
        <strong>{sweep.sentence}</strong>
      </p>
      {sweep.nothingBecause && <p>{sweep.nothingBecause}</p>}

      {sweep.riders.map((rider) => (
        <article key={rider.id} style={CARD}>
          <h4>{rider.sentence}</h4>
          <p>
            <strong>The change</strong>
          </p>
          <ul>
            {rider.change.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
          <p>
            <strong>Usage context:</strong> {rider.usageContext}
          </p>
          {/* Computed at read time, never stored — so it is right about canon as it stands
              now rather than as it stood when the script was written (1.2). */}
          <p>
            <strong>Implications:</strong> {rider.implications}
          </p>
          {rider.alternatives.length > 0 && (
            <>
              <p>
                <strong>Alternatives</strong>
              </p>
              <ul>
                {rider.alternatives.map((alternative, index) => (
                  <li key={index}>{alternative}</li>
                ))}
              </ul>
            </>
          )}

          <Button
            offer={rider.ratify}
            busy={busy}
            onClick={() => props.onRule(rider.id, 'ratify')}
          />

          <p>
            <label>
              Your note — kept forever, and read back by later writer runs:
              <br />
              <textarea
                value={draft.notes[rider.id] ?? ''}
                onChange={(event) =>
                  props.onDraft({ notes: { ...draft.notes, [rider.id]: event.target.value } })
                }
                rows={2}
                cols={72}
              />
            </label>
          </p>
          <Button
            offer={needing(
              rider.reject,
              draft.notes[rider.id] ?? '',
              sweep.refusals.rejectNeedsNote,
            )}
            busy={busy}
            onClick={() => props.onRule(rider.id, 'reject')}
          />
          <Button offer={rider.defer} busy={busy} onClick={() => props.onRule(rider.id, 'defer')} />
        </article>
      ))}

      {/* The record, kept forever (3.3) — what he already ruled while the episode was in
          flight, and what he said about it. */}
      {sweep.ruled.length > 0 && (
        <>
          <h3>Already ruled</h3>
          <ul>
            {sweep.ruled.map((rider) => (
              <li key={rider.id} style={FAINT}>
                <strong>{rider.status}</strong> — {rider.sentence}
                {rider.ratify.blockedBecause && (
                  <pre style={ARTIFACT}>{rider.ratify.blockedBecause}</pre>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

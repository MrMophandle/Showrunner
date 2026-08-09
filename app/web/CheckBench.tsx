import type { ReactNode } from 'react'
import type {
  CheckBenchView,
  ClusterOnTheBench,
  SayOnTheBench,
} from '../server/check-bench.ts'
import { ARTIFACT, Button, CARD, FAINT, needing } from './kit.tsx'

/**
 * The checks section of the operating page (E3-7) — the bench Ryan runs the checks from,
 * reads them at the spans they argue with, and remediates one finding at a time.
 *
 * ── What it is not ──────────────────────────────────────────────────────────────
 * It is not the gate room. That screen is E5's, it is drawn in `mockups/gate-room.html`, and
 * none of it is built here: no colour, no severity chips, no highlight, no folded runs of
 * clean scenes, no decision dock. What this owes the mockup is its SHAPE — the script
 * readable with each finding inline at its own anchor, one card per cluster carrying every
 * reviewer's say, severity and confidence side by side, the verdict board beside it — so E5
 * finds the arrangement already true and only has to make it beautiful.
 *
 * ── Every sentence came off the wire ────────────────────────────────────────────
 * Same contract as `App.tsx` and `CanonBench.tsx`: the server composes, this renders.
 * Nothing here imports a VALUE from `app/server` — not a stage name, not a verdict word, not
 * the sentence a missing note is refused with — so the browser bundle stays a browser bundle
 * and there is one copy of every list. The three preconditions this file owns are the ones
 * living in a field the server has never seen (a note, a replacement, a new statement), and
 * each renders the server's own `refusals` string, which is the string the API refuses with.
 *
 * ── Nothing here checks anything, and nothing writes canon ──────────────────────
 * Loading this section reads: the run buttons are clicks, the remediations are clicks, and
 * every one of them raises, revises or records (`remediation.ts`). The propose button lands a
 * proposal on the queue and stops — ratifying it is Ryan's, at the canon bench, through the
 * one ruling API (invariant 1).
 */

/** What Ryan has typed on this bench but not yet submitted. Keyed by finding, because a
 *  remediation is about one finding and the bench remediates one at a time (4.3). */
export interface CheckDraft {
  /** The replacement per finding: pre-drafted, edited, and applied word for word (D20). */
  replacements: Record<string, string>
  /** The dismissal note per finding — read back by later runs (4.4). */
  notes: Record<string, string>
  /** The new statement per finding, for the canon change the concern implies. */
  statements: Record<string, string>
  /** What the last pre-draft said about itself, per finding. Nothing has moved because it exists. */
  drafted: Record<string, string>
}

export const EMPTY_CHECK_DRAFT: CheckDraft = {
  replacements: {},
  notes: {},
  statements: {},
  drafted: {},
}

export interface CheckBenchProps {
  checks: CheckBenchView
  draft: CheckDraft
  busy: boolean
  onDraft(next: Partial<CheckDraft>): void
  /** Ryan's click on one stage's button. The stage comes off the wire, never from here. */
  onRun(stage: string): void
  onPredraft(findingId: string): void
  onApply(findingId: string): void
  onPropose(findingId: string): void
  onDismiss(findingId: string): void
  onRecheck(artifactId: string, sceneId: string): void
  onShowRun(runId: string): void
}

/** Markup, and nothing else. */
export function CheckBench(props: CheckBenchProps) {
  const { checks, draft, busy } = props

  return (
    <section>
      <h2>
        Checks — {checks.label} · {checks.title}
      </h2>
      <p>
        Checks argue, they never veto (invariant 3). A finding makes this artifact loud;
        approving over one at the gate is recorded as your override. The one exception is D12:
        a <em>deterministic</em> finding blocks the next stage and never your gate.
      </p>

      {checks.emptyBecause && <p>{checks.emptyBecause}</p>}

      {/* ── The buttons, one per stage whose work is reading this material ── */}
      <h3>Read it</h3>
      {checks.runs.map((run) => (
        <Button
          key={run.stage}
          offer={run.offer}
          busy={busy}
          onClick={() => props.onRun(run.stage)}
        />
      ))}

      {/* ── D12's wall, in the words the disabled next-stage button renders ── */}
      <h3>The next stage</h3>
      {checks.wall === null ? (
        <p>
          Not blocked. No deterministic finding stands unresolved against{' '}
          {checks.artifact.kind} v{checks.version}.
        </p>
      ) : (
        <p style={CARD}>
          <strong>Blocked:</strong> {checks.wall}
        </p>
      )}
      {checks.gateRunId && (
        <p>
          The gate over this {checks.artifact.kind} is on run <code>{checks.gateRunId}</code>.{' '}
          <button type="button" onClick={() => props.onShowRun(checks.gateRunId!)}>
            Show that run below
          </button>{' '}
          — approving over a red finding there is one of the three ways this wall comes down,
          and it is recorded as your override forever.
        </p>
      )}

      {/* ── The verdict board (4.5) ── */}
      <h3>Verdict board — {checks.artifact.kind} v{checks.version}</h3>
      <p>{checks.board.sentence}</p>
      <ul>
        {checks.rows.map(({ row, fix, scope }) => (
          <li key={`${row.checkKey}-${row.passId ?? 'unread'}`} style={row.standing === 0 ? FAINT : undefined}>
            <strong>{row.label}</strong> · {row.verdict} — {row.what}
            {row.worstSeverity && (
              <>
                {' '}
                (severity {row.worstSeverity} · confidence {row.confidence})
              </>
            )}
            {fix && (
              <>
                <br />
                <small>What answers it: {fix}</small>
              </>
            )}
            {/* The denominator of a silence, by name: what it was handed, and what it left
                alone. Loaded and un-cited is a measurement; absent is not. */}
            {scope.length > 0 && (
              <ul>
                {scope.map((fact) => (
                  <li key={fact.factId}>
                    <small>
                      {fact.cited ? 'cited' : 'loaded, and not cited'}
                      {fact.via && ` · inherited via ${fact.via}`}: <q>{fact.statement}</q>
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {/* ── The third kind of nothing, kept out of every silence (0012) ── */}
      <h3>What could not be checked at all</h3>
      {checks.gaps.length === 0 ? (
        <p>Nothing. Every reviewer reached everything it was handed.</p>
      ) : (
        <>
          <p>
            A gap is about the <em>scope</em>, never about the artifact: canon has not decided
            these, so no rewrite would answer one. A pass with a gap on it is not a clean run.
          </p>
          <ul>
            {checks.gaps.map((gap, index) => (
              <li key={`${gap.checkKey}-${index}`}>
                <strong>{gap.checkKey}</strong> · {gap.reason} — {gap.detail}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── The artifact, readable, with each finding at its own anchor ── */}
      <h3>
        The {checks.artifact.kind}, with the findings at their spans
        {checks.artifact.filePath && <small> · {checks.artifact.filePath}</small>}
      </h3>
      {checks.artifact.text === null ? (
        <p>{checks.artifact.note}</p>
      ) : (
        <Anchored text={checks.artifact.text} clusters={checks.clusters}>
          {(cluster) => (
            <Card
              cluster={cluster}
              draft={draft}
              busy={busy}
              refusals={checks.refusals}
              onDraft={props.onDraft}
              onPredraft={props.onPredraft}
              onApply={props.onApply}
              onPropose={props.onPropose}
              onDismiss={props.onDismiss}
            />
          )}
        </Anchored>
      )}

      {/* ── The paid half a rewrite deliberately did not run (D14, invariant 5) ── */}
      {checks.rechecks.length > 0 && (
        <>
          <h3>Scenes still owed a reading</h3>
          <p>
            A rewrite landed and the free deterministic tier read the new draft in the same
            motion. The reviewers that <em>argued</em> with the scene have not — and a scene
            nobody re-read is unread, not clean. One call each, and only for the reviewers that
            had something to say here.
          </p>
          {checks.rechecks.map((recheck) => (
            <Button
              key={recheck.sceneId}
              offer={recheck.offer}
              busy={busy}
              onClick={() => props.onRecheck(checks.artifact.id, recheck.sceneId)}
            />
          ))}
        </>
      )}

      {/* ── D11: reviewing the reviewers. A question, and nothing acts on it. ── */}
      <h3>Cried-wolf record</h3>
      {checks.tune.length === 0 ? (
        <p>
          No check is crying wolf. Nothing here disables, demotes or re-weights anything in any
          case — the sentence is a question you read (D11).
        </p>
      ) : (
        <ul>
          {checks.tune.map((sentence) => (
            <li key={sentence}>
              <strong>{sentence}</strong>
            </li>
          ))}
        </ul>
      )}
      <ul>
        {checks.record.map((one) => (
          <li key={one.checkKey}>
            {one.checkKey} — {one.readings} reading(s), {one.silent} of them silent,{' '}
            {one.firings} firing(s) over {one.concerns.length} concern(s); {one.dismissed}{' '}
            dismissed, {one.overridden} overridden, {one.confirmed} confirmed by a rewrite,{' '}
            {one.unruled} unruled, {one.gaps} could-not-look
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The artifact's own text, with each cluster's card rendered where the span sits.
 *
 * The mockup's arrangement, unstyled: read down the script and the argument about a line is
 * under that line, not in a list somewhere else that Ryan has to match up by scene number.
 * Spans that resolved to nothing (`from === to`) still get a card — a finding about the whole
 * artifact, or one whose quote the draft has re-flowed past — placed where its scene begins.
 */
function Anchored(props: {
  text: string
  clusters: ClusterOnTheBench[]
  children: (cluster: ClusterOnTheBench) => ReactNode
}) {
  const pieces: ReactNode[] = []
  let at = 0

  for (const [index, cluster] of props.clusters.entries()) {
    const from = Math.max(at, cluster.from)
    const to = Math.max(from, cluster.to)
    if (from > at) pieces.push(<span key={`text-${index}`}>{props.text.slice(at, from)}</span>)
    if (to > from) {
      pieces.push(<mark key={`span-${index}`}>{props.text.slice(from, to)}</mark>)
    }
    pieces.push(<div key={`card-${index}`}>{props.children(cluster)}</div>)
    at = to
  }
  pieces.push(<span key="tail">{props.text.slice(at)}</span>)

  return <div style={ARTIFACT}>{pieces}</div>
}

/** One card: a span of the artifact, and every reviewer's say about it (4.5). */
function Card(props: {
  cluster: ClusterOnTheBench
  draft: CheckDraft
  busy: boolean
  refusals: CheckBenchView['refusals']
  onDraft(next: Partial<CheckDraft>): void
  onPredraft(findingId: string): void
  onApply(findingId: string): void
  onPropose(findingId: string): void
  onDismiss(findingId: string): void
}) {
  const { cluster } = props
  return (
    <article style={CARD}>
      <h4>
        {cluster.scene === null ? 'The whole artifact' : `Scene ${cluster.scene}`} ·{' '}
        {cluster.says.length} reviewer(s) on this span · {cluster.standing} still standing
        {cluster.worstSeverity && ` · worst severity ${cluster.worstSeverity}`}
      </h4>
      {cluster.quote !== '' && (
        <p>
          <q>{cluster.quote}</q>
        </p>
      )}
      {cluster.says.map((say) => (
        <Say key={say.findingId} say={say} {...props} />
      ))}
    </article>
  )
}

/** One reviewer's say, and 4.3's three buttons behind it. */
function Say(props: {
  say: SayOnTheBench
  draft: CheckDraft
  busy: boolean
  refusals: CheckBenchView['refusals']
  onDraft(next: Partial<CheckDraft>): void
  onPredraft(findingId: string): void
  onApply(findingId: string): void
  onPropose(findingId: string): void
  onDismiss(findingId: string): void
}) {
  const { say, draft, busy, refusals } = props
  const id = say.findingId
  const replacement = draft.replacements[id] ?? ''
  const note = draft.notes[id] ?? ''
  const statement = draft.statements[id] ?? ''

  return (
    <div style={CARD}>
      <p>
        <strong>{say.sentence}</strong>
        {say.blocking && (
          <>
            {' '}
            · <strong>STAGE-BLOCKING</strong>
          </>
        )}
        {say.status !== 'open' && <> · {say.status}</>}
      </p>
      <p>{say.concern}</p>
      {say.quote !== '' && (
        <p>
          <small>
            It quoted: <q>{say.quote}</q>
          </small>
        </p>
      )}
      {say.facts.length > 0 && (
        <ul>
          {say.facts.map((fact) => (
            <li key={fact}>
              <small>
                canon it argues with: <q>{fact}</q>
              </small>
            </li>
          ))}
        </ul>
      )}
      {say.blockingSentence && (
        <p>
          <small>{say.blockingSentence}</small>
        </p>
      )}
      {say.dismissal && (
        <p>
          <small>
            You put it down — <q>{say.dismissal.note}</q> at {say.dismissal.at}
          </small>
        </p>
      )}
      {/* E3-6's loop, closed on screen: an open twin, and why the wall stayed down. */}
      {say.inherited && (
        <p>
          <small>
            <strong>Your standing ruling reaches this one.</strong> {say.inherited.sentence}
          </small>
        </p>
      )}

      {/* ── Button one, first half: pre-draft. It spends a call and moves nothing. ── */}
      <Button
        offer={say.remediations.predraft}
        busy={busy}
        onClick={() => props.onPredraft(id)}
      />
      {draft.drafted[id] && (
        <p>
          <small>{draft.drafted[id]}</small>
        </p>
      )}
      <p>
        <label>
          What should stand where that span stands — edit it, or write your own; it is applied
          word for word:
          <br />
          <textarea
            value={replacement}
            onChange={(event) =>
              props.onDraft({ replacements: { ...draft.replacements, [id]: event.target.value } })
            }
            rows={3}
            cols={72}
          />
        </label>
      </p>
      <Button
        offer={needing(say.remediations.apply, replacement, refusals.rewriteNeedsReplacement)}
        busy={busy}
        onClick={() => props.onApply(id)}
      />

      {/* ── Button two: raise the canon change, and stop (invariant 1). ── */}
      <p>
        <label>
          What canon should say instead:{' '}
          <input
            value={statement}
            onChange={(event) =>
              props.onDraft({ statements: { ...draft.statements, [id]: event.target.value } })
            }
            size={64}
          />
        </label>
      </p>
      <Button
        offer={needing(say.remediations.propose, statement, refusals.changeNeedsStatement)}
        busy={busy}
        onClick={() => props.onPropose(id)}
      />

      {/* ── Button three: put it down with a note, which rides future runs (4.4). ── */}
      <p>
        <label>
          Your note — later runs read it back, and it is counted against the check that raised
          it:
          <br />
          <textarea
            value={note}
            onChange={(event) => props.onDraft({ notes: { ...draft.notes, [id]: event.target.value } })}
            rows={2}
            cols={72}
          />
        </label>
      </p>
      <Button
        offer={needing(say.remediations.dismiss, note, refusals.dismissNeedsNote)}
        busy={busy}
        onClick={() => props.onDismiss(id)}
      />

    </div>
  )
}

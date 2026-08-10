import type { NoteDepth } from '../server/runner/gate.ts'
import type {
  ClusterInTheRoom,
  DeskInTheRoom,
  GateInTheRoom,
  StepInTheRoom,
  WritingRoomView,
} from '../server/writing-room.ts'
import { ARTIFACT, Button, CARD, FAINT, needing } from './kit.tsx'

/**
 * The writing room, on the page (E4-7) — the section Ryan writes an episode from, rules its
 * gates at, edits its drafts in, pins it to an arc, and finishes its completion sweep.
 *
 * ── What it is not ──────────────────────────────────────────────────────────────
 * It is not the episode room and it is not the gate room. Those are E5's, they are drawn in
 * `mockups/episode-room.html` and `mockups/gate-room.html`, and none of it is built here: no
 * colour, no severity chips, no folded runs of clean scenes, no decision dock, no timeline.
 * What this owes those mockups is their SHAPE — the three stage buttons in line order with the
 * desk open beside each, the artifact readable at its gate with each finding at its own
 * anchor, the loop history as rounds, the doors on every draft — so E5 finds the arrangement
 * already true and only has to make it beautiful.
 *
 * ── Every sentence came off the wire ────────────────────────────────────────────
 * Same contract as `App.tsx`, `CanonBench.tsx`, `CheckBench.tsx` and `Sweep.tsx`: the server
 * composes, this renders. Nothing here imports a VALUE from `app/server` — not a stage name,
 * not a reach word, not the sentence an empty note is refused with — so the browser bundle
 * stays a browser bundle and there is one copy of every list. The one precondition this file
 * applies is the gate's note, and it renders the gate's own `rejectNeedsNote`, which is the
 * string the API refuses with.
 *
 * ── Nothing here writes anything, and opening it costs nothing ──────────────────
 * Loading this section is a GET. Every act on it is a click, and every one of them is a route
 * that existed before this issue: launch a stage, rule a gate, edit a draft, declare a pin.
 * **No verb was invented here** — in particular there is nothing that rules the sweep at once,
 * because three riders take three rulings (E4-6).
 */

export interface WritingRoomProps {
  room: WritingRoomView
  busy: boolean
  /** Which desk is open, by step. Reading a desk is free, so it is a fold and not a fetch. */
  openDesk: string | null
  onOpenDesk(step: string | null): void
  /** Ryan's click on a stage's button. The stage came off the wire, never from here. */
  onLaunch(stage: string): void
  /** The gate's note, its depth and its target — the same draft the page holds for a gate. */
  note: { note: string; depth: NoteDepth | ''; target: string }
  onNote(next: Partial<{ note: string; depth: NoteDepth | ''; target: string }>): void
  onRule(gateId: string, verdict: 'approve' | 'reject' | 'override'): void
  onEdit(artifactId: string): void
  onDeclare(arcId: string, waypointId: string): void
  onShowSweep(episodeId: string): void
  onShowRun(runId: string): void
  onClose(): void
}

export function WritingRoom(props: WritingRoomProps) {
  const { room, busy } = props

  return (
    <section>
      <h2>
        The {room.label} writing room{' '}
        <button type="button" onClick={() => props.onClose()}>
          Close this room
        </button>
      </h2>
      <p>
        {room.label} · {room.title} — at <strong>{room.lifecycle}</strong>.{' '}
        {room.track.map((stop, index) => (
          <span key={stop.stage} style={stop.reached ? undefined : FAINT}>
            {index === 0 ? '' : ' → '}
            {stop.current ? <strong>[{stop.stage}]</strong> : stop.stage}
          </span>
        ))}
      </p>
      <p>Spend on this episode: {room.spendSentence}</p>
      <p>
        The lifecycle names the stage this episode is <em>at</em> — the work it still owes, not
        work it has finished. An approval is the only thing that moves it (E4-1).
      </p>

      {/* ── D12's wall, in the words the disabled next-stage button renders ── */}
      {room.wall !== null && (
        <p style={CARD}>
          <strong>The next stage is blocked:</strong> {room.wall}
        </p>
      )}

      {/* ── The line: three stages, in the order they run, each with its desk ── */}
      <h3>The writing line</h3>
      {room.line.map((step) => (
        <Step
          key={step.step}
          step={step}
          busy={busy}
          open={props.openDesk === step.step}
          onOpenDesk={props.onOpenDesk}
          onLaunch={props.onLaunch}
        />
      ))}

      {/* ── What is written, and Ryan's two doors onto each of it (E4-5) ── */}
      <h3>What is written, and what you may do with it</h3>
      {room.written.length === 0 ? (
        <p>
          Nothing is written yet. The first button above is what writes the first draft, and it
          says what it costs before you press it.
        </p>
      ) : (
        room.written.map((written) => (
          <div key={written.id} style={ARTIFACT}>
            <strong>
              {written.kind} v{written.version} — {written.status}
            </strong>
            {written.filePath && (
              <p>
                <small>{written.filePath}</small>
              </p>
            )}
            {/* "built from a draft the outline has moved past" — computed off the edges every
                time it is asked, never a flag anybody set (1.3). */}
            {written.staleBecause && (
              <p>
                <small>{written.staleBecause}</small>
              </p>
            )}
            {written.standing.map((standing) => (
              <p key={standing.note}>
                <small>Standing against it: {standing.sentence}</small>
              </p>
            ))}
            <Button
              offer={written.present}
              busy={busy}
              onClick={() => props.onLaunch(written.presentStage)}
            />
            <Button offer={written.edit} busy={busy} onClick={() => props.onEdit(written.id)} />
          </div>
        ))
      )}

      {/* ── Every gate, readable: the artifact, the loop history, the findings ── */}
      <h3>The gates</h3>
      {room.gates.length === 0 ? (
        <p>
          No gate has ever opened on {room.label}. A writing stage opens one when its draft
          stops arguing with the checks, and the stage's button above says so before the click.
        </p>
      ) : (
        room.gates.map((gate) => (
          <Gate
            key={gate.id}
            gate={gate}
            busy={busy}
            note={props.note}
            onNote={props.onNote}
            onRule={props.onRule}
            onShowRun={props.onShowRun}
          />
        ))
      )}

      {/* ── The pin, and the door E4-4 built (D8) ── */}
      <h3>Where {room.label} stands on its arcs</h3>
      {room.positions === null ? (
        <p>This show declares no arcs, so there is nothing to stand on.</p>
      ) : (
        <>
          <p>{room.positions.standing}</p>
          {room.positions.waypoints.map((waypoint) => (
            <div key={waypoint.waypointId}>
              <p>
                <strong>
                  {waypoint.arcName} — waypoint {waypoint.ordinal}, {waypoint.name}
                </strong>
                {waypoint.declared && ' · the pin is here'}
                <br />
                <small>Landing it looks like: {waypoint.landingCriteria}</small>
              </p>
              <Button
                offer={waypoint.declare}
                busy={busy}
                onClick={() => props.onDeclare(waypoint.arcId, waypoint.waypointId)}
              />
            </div>
          ))}
        </>
      )}

      {/* ── What approving the script left owed (E4-6). Never a wall. ── */}
      <h3>What {room.label} owes canon</h3>
      {room.sweep === null ? (
        <p>
          Nothing rides {room.label} right now, so no completion sweep is owed. Approving its
          script buys the reading that raises what the script claimed of canon (E4-4).
        </p>
      ) : (
        <div style={CARD}>
          <p>{room.sweep.sentence}</p>
          <Button
            offer={room.sweep.open}
            busy={busy}
            onClick={() => props.onShowSweep(room.episodeId)}
          />
        </div>
      )}
    </section>
  )
}

/** One step of the line: its button, and the desk that says what the button would hand over. */
function Step(props: {
  step: StepInTheRoom
  busy: boolean
  open: boolean
  onOpenDesk(step: string | null): void
  onLaunch(stage: string): void
}) {
  const { step, busy } = props
  return (
    <article style={CARD}>
      <h4>
        {step.step} → {step.kind}
        {step.current && ' · this is the stage this episode is at'}
      </h4>
      <Button offer={step.offer} busy={busy} onClick={() => props.onLaunch(step.stage)} />

      {/* Not an action and so not a costed sentence: it folds open a read the server has
          already composed. Nothing is fetched, nothing is started (invariant 5). */}
      <p>
        <button
          type="button"
          onClick={() => props.onOpenDesk(props.open ? null : step.step)}
        >
          {props.open
            ? `Fold the ${step.step} desk away`
            : `What the ${step.step} writer would be handed`}
        </button>
      </p>
      {props.open && <Desk desk={step.desk} />}
    </article>
  )
}

/**
 * **The desk inspector** — what the writer was handed, in the desk's own vocabulary.
 *
 * Four questions, and every one of them answerable here without leaving the screen: why did it
 * write that (the facts, each with its reach), why did it not know about X (`leftOut`, with the
 * rule that kept it out), did it read my note (the notes, with their origins apart), and what
 * is this about to buy (the prompt, and what it is a floor of).
 */
function Desk({ desk }: { desk: DeskInTheRoom }) {
  return (
    <div style={CARD}>
      <p>
        <strong>{desk.sentence}</strong>
      </p>

      <h5>What it writes from</h5>
      {desk.upstream.text === null ? (
        <p>{desk.upstream.note}</p>
      ) : (
        <>
          <p>
            <small>
              the {desk.upstream.expected} v{desk.upstream.version}, whole — rendered, never a
              path (D15)
            </small>
          </p>
          <pre style={ARTIFACT}>{desk.upstream.text}</pre>
        </>
      )}

      {/* ── The slice, with the door each entity came through in words ── */}
      {/* Not "the whole bible": what this episode's audience already knows and no more, which
          is a lineage question rather than a clock question (`write-context.ts`). */}
      <h5>Canon, as this episode's audience knows it</h5>
      {desk.entities.length === 0 ? (
        <p>
          No canon entity is on this desk. Everything the show has is in “What it was not
          handed” below, each with the rule that kept it out.
        </p>
      ) : (
        desk.entities.map((entity) => (
          <div key={entity.id} style={ARTIFACT}>
            <strong>
              {entity.name} — {entity.categoryKey}, standing {entity.standing ?? 'undeclared'} ·{' '}
              {entity.status}
            </strong>
            <p>
              <small>
                On the desk because: {entity.reasons.map((one) => one.because).join('; ')}.
              </small>
            </p>
            {entity.facts.length > 0 && (
              <ul>
                {entity.facts.map((fact) => (
                  <li key={fact.id}>
                    <q>{fact.statement}</q>
                    <br />
                    {/* The door in TIME it came through — the audience rule, rendered in the
                        same four words the prompt hands the model (`REACH`). */}
                    <small>
                      {fact.reach} — {fact.reachSentence}
                      {fact.inherited &&
                        ` · inherited from “${fact.inherited.source}”, along \`${fact.inherited.via}\``}
                    </small>
                  </li>
                ))}
              </ul>
            )}
            {/* Never folded into the facts: a writer told "her species is undecided" writes
                differently from one told nothing at all (invariant 4). */}
            {entity.gaps.length > 0 && (
              <>
                <p>
                  <small>What canon has not decided about them:</small>
                </p>
                <ul>
                  {entity.gaps.map((gap) => (
                    <li key={gap.via}>
                      <small>
                        {gap.reason} — {gap.because}
                      </small>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))
      )}

      {/* ── The half that cannot be inferred from what WAS included ── */}
      <h5>What it was not handed, and the rule that kept each one out</h5>
      {desk.leftOut.length === 0 ? (
        <p>Nothing. Every canon entity this show has is on the desk above.</p>
      ) : (
        <ul>
          {desk.leftOut.map((entity) => (
            <li key={entity.id}>
              <strong>{entity.name}</strong> ({entity.categoryKey} · {entity.status}) —{' '}
              {entity.because}
            </li>
          ))}
        </ul>
      )}

      <h5>The arcs it is written under</h5>
      {desk.arcs.length === 0 ? (
        <p>This show declares no arcs.</p>
      ) : (
        desk.arcs.map((arc) => (
          <div key={arc.arcId}>
            <p>
              <strong>
                {arc.name} — a {arc.kind} arc, scoped to the {arc.scope}
              </strong>
              <br />
              {arc.statement}
              <br />
              <small>{arc.sentence}</small>
            </p>
            <ul>
              {arc.waypoints.map((waypoint) => (
                <li key={waypoint.id} style={waypoint.ordinal === arc.declaredOrdinal ? undefined : FAINT}>
                  <small>
                    waypoint {waypoint.ordinal}, {waypoint.name}: {waypoint.landingCriteria}
                  </small>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {desk.vanilla && (
        <p>
          <small>
            This episode declares no position on any arc. That is <strong>vanilla</strong> —
            legal, tracked, and never a failure state (1.1).
          </small>
        </p>
      )}

      {/* ── Ryan's own words, with the three authorities kept apart ── */}
      <h5>What you have already said, and where you said it</h5>
      {desk.notes.length === 0 ? (
        <p>
          Nothing. You have not rejected a draft of this, routed a note back to it, or
          dismissed a finding this writer would read.
        </p>
      ) : (
        <ul>
          {desk.notes.map((note) => (
            <li key={`${note.origin}-${note.at}-${note.note}`}>
              <strong>{note.origin}</strong> · {note.sentence}: <q>{note.note}</q>
              <br />
              <small>{note.originSentence}</small>
            </li>
          ))}
        </ul>
      )}

      {/* ── The words a call would be handed, and what they are a floor of ── */}
      <h5>The prompt this would send, round {desk.round}</h5>
      <p>
        <small>{desk.promptCaveat}</small>
      </p>
      <pre style={ARTIFACT}>{desk.prompt}</pre>
    </div>
  )
}

/**
 * One gate, readable: the artifact, the loop history, what the checks said at their spans, and
 * the three verdicts with the notes composer and its depth picker.
 *
 * **None of the three verdicts is ever disabled on the artifact's account.** Checks argue and
 * never veto (invariant 3); D12 lets a deterministic finding block the next STAGE and never
 * this ruling. The only thing that closes them is a round already ruled.
 */
function Gate(props: {
  gate: GateInTheRoom
  busy: boolean
  note: { note: string; depth: NoteDepth | ''; target: string }
  onNote(next: Partial<{ note: string; depth: NoteDepth | ''; target: string }>): void
  onRule(gateId: string, verdict: 'approve' | 'reject' | 'override'): void
  onShowRun(runId: string): void
}) {
  const { gate, busy, note } = props

  return (
    <article style={CARD}>
      <h4>
        {gate.subject} — round {gate.round}
        {gate.isOpen ? ' · open, waiting on you' : ' · ruled'} · opened by {gate.stage}
      </h4>
      <p>
        <button type="button" onClick={() => props.onShowRun(gate.runId)}>
          Show the run that opened it below
        </button>
      </p>

      {/* The gate renders its artifact, readable, never a filename (D15, 4.6). */}
      <pre style={ARTIFACT}>{gate.artifact.text ?? gate.artifact.note}</pre>

      {/* ── The loop history: one round per draft, every one of them kept ── */}
      <h5>Loop history</h5>
      <ul>
        {gate.rounds.map((round) => (
          <li key={round.round} style={round.stale ? FAINT : undefined}>
            Round {round.round} · v{round.artifactVersion}
            {round.stale && ' · stale — from before your last rejection'}
            {round.ruling
              ? ` · ${round.ruling.verdict}${round.ruling.notes
                  .map((each) => ` — “${each.note}”`)
                  .join('')}`
              : ' · open'}
          </li>
        ))}
      </ul>

      {/* ── What the checks said, clustered at the spans they argue with (4.5) ── */}
      <h5>What the checks said about it</h5>
      {gate.clusters.length === 0 ? (
        <p>
          Nothing is anchored in this draft. A reviewer that read it and found nothing recorded
          a pass — the verdict board on the check bench is where a measured silence is read, and
          an absence of cards is not the same news as a clean run.
        </p>
      ) : (
        gate.clusters.map((cluster, index) => <Cluster key={index} cluster={cluster} />)
      )}

      {/* ── The three verdicts, and the notes composer with its depth picker ── */}
      <Button offer={gate.approve} busy={busy} onClick={() => props.onRule(gate.id, 'approve')} />
      <Button
        offer={gate.override}
        busy={busy}
        onClick={() => props.onRule(gate.id, 'override')}
      />

      <p>
        <label>
          Your note — the step reopens with it, and later runs read it back off the desk:
          <br />
          <textarea
            value={note.note}
            onChange={(event) => props.onNote({ note: event.target.value })}
            rows={3}
            cols={72}
          />
        </label>
        <br />
        {/* D21: the note picks its own depth, and a note routed away is not this producer's
            to answer — nothing regenerates, and the stage that writes the target becomes
            offerable with the note on it. */}
        <label>
          How deep it goes back:{' '}
          <select
            value={note.depth}
            onChange={(event) => props.onNote({ depth: event.target.value as NoteDepth | '' })}
          >
            <option value="">unrouted — the legal default</option>
            {gate.noteDepths.map((each) => (
              <option key={each} value={each}>
                {each}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Which one:{' '}
          <input
            value={note.target}
            onChange={(event) => props.onNote({ target: event.target.value })}
            placeholder="scene-4"
          />
        </label>
      </p>
      <Button
        offer={needing(gate.reject, note.note, gate.rejectNeedsNote)}
        busy={busy}
        onClick={() => props.onRule(gate.id, 'reject')}
      />
    </article>
  )
}

/** One card: a span of the artifact under review, and every reviewer's say about it. */
function Cluster({ cluster }: { cluster: ClusterInTheRoom }) {
  return (
    <div style={CARD}>
      <p>
        <strong>
          {cluster.scene === null ? 'The whole artifact' : `Scene ${cluster.scene}`} ·{' '}
          {cluster.says.length} reviewer(s) on this span · {cluster.standing} still standing
          {cluster.worstSeverity && ` · worst severity ${cluster.worstSeverity}`}
        </strong>
      </p>
      {cluster.quote !== '' && (
        <p>
          <q>{cluster.quote}</q>
        </p>
      )}
      {cluster.says.map((say) => (
        <div key={say.findingId}>
          <p>
            {/* Severity and confidence side by side, never folded into one word (invariant 4). */}
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
          {say.facts.map((fact) => (
            <p key={fact}>
              <small>
                canon it argues with: <q>{fact}</q>
              </small>
            </p>
          ))}
          {say.blockingSentence && (
            <p>
              <small>{say.blockingSentence}</small>
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

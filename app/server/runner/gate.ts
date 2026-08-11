import type { Store } from '../db/store.ts'
import type { EventLog } from '../events.ts'
import { newId } from '../domain/id.ts'
import { addressOf } from '../domain/routing.ts'
import { findRun } from './run.ts'
import type { Runner } from './runner.ts'

/**
 * The gate: the third primitive (2.2), a run paused on a decision object, resuming only on
 * Ryan's ruling.
 *
 * ── The shape of it ─────────────────────────────────────────────────────────────
 * A gate belongs to the step that PRODUCED the artifact, one gate per step. A step writes
 * its artifact, calls `context.openGate(...)`, and never returns from that call — it parks
 * the run through the same `RunPaused` seam the runner already catches. When Ryan rules,
 * the run resumes, the runner re-enters the same step, and the step finds its gate with
 * the ruling on it: approve, and it returns its own result; reject, and it does the work
 * again with the notes as input and presents round 2.
 *
 * That is the whole of "reject is routed, not rewound" at this layer, and it needed no new
 * runner machinery — only that the step row be the same row across re-runs.
 * **`reconcileSteps` (run.ts) finds a step by NAME and inserts only when one is missing**,
 * so a rejected step re-runs against the same `step.id`, finds the same gate, and opens
 * the next round. If that ever "optimizes" into inserting a row per attempt, every
 * rejection opens a second gate and the round history silently splits in two.
 *
 * ── Rounds, and what may move ───────────────────────────────────────────────────
 * `gate_round` is refreshable; `gate_ruling` is insert-only. They look inconsistent side
 * by side and are not: an UNRULED round is a presentation — if a crash re-enters the step
 * and it produces a newer version, the round is presenting that newer version and saying
 * so is honesty, not revision. A RULED round is history. Round 2 never overwrites round 1;
 * the primary key on `gate_ruling` refuses it, and the gate room renders round 1 exactly
 * as it was ruled under "stale — from before your last rejection".
 *
 * Nothing here stores whether a round is open or stale. A round is open when no ruling
 * references it and stale when a later round exists — both are computed, for the same
 * reason artifact freshness is (1.3).
 *
 * ── Nothing may block a ruling ──────────────────────────────────────────────────
 * The verbs below take no preconditions. There is no state in which they refuse a
 * verdict, no validation of the artifact, and no findings check — D12 lets deterministic
 * findings block the NEXT STAGE, never Ryan's gate, and checks argue but never veto
 * (invariant 3). The only two errors are "no such gate" and "that round is already ruled",
 * and neither declines a verdict: the first has nothing to rule on and the second has
 * nothing left open. Rounds are NOT capped. `MAX_ATTEMPTS_PER_STEP` bounds a step that is
 * FAILING; a rejection is not a failure, and Ryan may reject as many rounds as he likes.
 *
 * ── The fourth verb, and why it does not un-say the sentence above (E5-3, #83) ───
 * This module said "three verbs" for four epics, and the count was never the ruling — the
 * ruling is the paragraph above it, that **nothing about the artifact may stand between Ryan
 * and a verdict.** `close` keeps that letter for letter: no findings check, no validation, no
 * state of the run, and no question about which stage opened the gate. Its one refusal is its
 * own NOTE, which is the verb's object rather than a condition on the world — the same shape
 * `reject`'s refusal has, and for the same reason (`rejectionNeedsANote` below).
 *
 * What it exists for is the gap the E4 ledger names: *"A presenting gate has one exit, and it
 * is approve."* A presenting stage produces nothing, so a rejection whose note is about the
 * draft in front of him re-presents the same bytes as round 2 — and D7 holds the episode while
 * that gate is open, so the rewrite the note asked for cannot happen until he approves the
 * draft he just rejected. `close` is the exit: the run ends, the note stands against the
 * artifact, and the episode is free.
 *
 * **It is a fourth verdict rather than a fourth meaning for `reject`**, and 0015 carries that
 * argument in full: one word may not mean *do it again* at one gate and *I am putting this
 * down* at another, told apart only by a catalogue that can lose an entry. 0004 ruled this
 * once already, over `override`.
 *
 * **And it is offered at every gate, not only a presenting one.** Nothing below reads a stage,
 * a work kind or a step name — a gate says where Ryan stood, never whether he may rule. What
 * each STEP does when a close sends the run back into it is the step's own business
 * (`correction-loop.ts`, `present-step.ts`), and both do the same thing: end, and change
 * nothing.
 */

/** The four verbs, and the only ways a round closes. */
export const RULING_VERDICT = ['approve', 'reject', 'override', 'close'] as const
export type RulingVerdict = (typeof RULING_VERDICT)[number]

/**
 * **The two verdicts that end a step without approving it**, and the one predicate that says
 * so — read by both steps that own a gate, so "what ends a run" is one answer in one place.
 *
 * They arrive at that shared end by two different roads and stay two words in the ledger
 * forever: a `reject` ends the run only when every note was routed to ANOTHER artifact (D21,
 * E4-5), and a `close` ends it whatever the notes say, because putting a draft down is what it
 * IS. Nothing may collapse them — `verdict` is carried through every outcome type unchanged.
 */
export const putsTheWorkDown = (verdict: RulingVerdict): boolean =>
  verdict === 'reject' || verdict === 'close'

/** Approved, or approved over something. The only two verdicts that carry a run onward. */
export const carriesTheRunOn = (verdict: RulingVerdict): boolean =>
  verdict === 'approve' || verdict === 'override'

/**
 * How deep a rejection note sends the work back (4.7, D21).
 *
 * E1 carried it and acted on none of it. **E4-5 acts on it for the written kinds**: a note at
 * `outline` or `premise` depth is addressed to that artifact of the episode when the ruling
 * lands (`domain/routing.ts`), and what it changes is that artifact's OFFER — nothing
 * regenerates until Ryan clicks. `artifact` and `scene` are the draft in front of him, which
 * is the correction loop's own path; `shot` and `take` are E6's and reach nothing yet.
 *
 * `outline` joined the set in 0014, and the migration carries the argument: 4.7 named the
 * depths from the screening room, before E4-2 made the outline a real artifact between the
 * premise and the script. The set is closed again, and the next one is a ruling, not an ALTER.
 *
 * A const array and a union type, never a TS `enum`: the server runs its TypeScript under
 * Node's type stripping, which only erases.
 */
export const NOTE_DEPTH = ['artifact', 'scene', 'outline', 'premise', 'shot', 'take'] as const
export type NoteDepth = (typeof NOTE_DEPTH)[number]

export interface Gate {
  id: string
  runId: string
  /** The producing step. It opened this gate, and a ruling sends the run back into it. */
  stepId: string
  episodeId: string
  /** What is under review. A gate always renders its artifact, never a filename (1.3). */
  artifactId: string
  openedAt: string
}

/** One note of a rejection. `depth` null is an unrouted note — the legal default. */
export interface GateNote {
  note: string
  depth: NoteDepth | null
  /**
   * Which scene/shot/take — or, when the depth names a written kind, which ARTIFACT (0014).
   * Null when the depth names nothing to address.
   */
  target: string | null
  /**
   * The version the target stood at when the note landed, when the target is an artifact.
   * It is what makes "has this been answered" a comparison rather than a flag
   * (`domain/routing.ts`); null on every other kind of note.
   */
  targetVersion: number | null
}

export interface Ruling {
  verdict: RulingVerdict
  /** Ryan's optional words on an approval or an override. */
  comment: string | null
  /** Non-empty on a rejection and on a close, empty otherwise. */
  notes: GateNote[]
  ruledAt: string
}

export interface GateRound {
  round: number
  /** The version of the artifact that was under review this round — "script v2". */
  artifactVersion: number
  payload: unknown
  openedAt: string
  /** A later round exists: "stale — from before your last rejection". Computed. */
  stale: boolean
  /** Absent while the round is open. */
  ruling?: Ruling
}

/** Everything the gate room renders, and everything a step needs to decide what to do. */
export interface GateStanding {
  gate: Gate
  /** Every round in order, round 1 first. Prior rounds persist; they are marked, not replaced. */
  rounds: GateRound[]
  /** The current round number. */
  round: number
  /** The latest round's ruling, or undefined while that round is open. */
  ruling?: Ruling
  /** True while the latest round awaits a verdict — this is what "needs you" means. */
  isOpen: boolean
  /** "the ep06 script" — the artifact in Ryan's words, for the sentences below. */
  subject: string
}

/** What a step presents. `reason` overrides the sentence the floor shows while it waits. */
export interface GateDraft {
  artifactId: string
  /** JSON the gate room renders beside the artifact. */
  payload?: unknown
  reason?: string
}

/** One note as Ryan writes it. `note` alone is legal: an unrouted note. */
export interface NoteDraft {
  note: string
  depth?: NoteDepth
  target?: string
}

/** An open gate as the floor lists it — everything needed to say what waits, on whom. */
export interface OpenGate {
  gate: Gate
  stage: string
  stepName: string
  episodeNumber: number
  round: number
  subject: string
  since: string
}

// ── Presenting ──────────────────────────────────────────────────────────────────

export interface GateWhere {
  runId: string
  stepId: string
  episodeId: string
}

/**
 * Find or create this step's gate, and open a round on it.
 *
 * Opens a NEW round only when the latest one has been ruled — a re-presentation after a
 * rejection. A step that re-enters with its round still open (a crash between presenting
 * and parking, say) refreshes that round rather than opening a second one, so the rounds
 * count Ryan's opinions and nothing else.
 *
 * It does not park the run and it appends no event: `context.openGate` in runner.ts does
 * both, so that every event this app writes is written by the runner. This module is the
 * ledger — like run.ts, it decides nothing and publishes nothing.
 */
export function presentForRuling(store: Store, where: GateWhere, draft: GateDraft): GateStanding {
  const gateId = store.transaction(() => {
    const existing = gateOfStep(store, where.stepId)
    const id = existing?.id ?? newId('gate')
    if (!existing) {
      store.run(
        'INSERT INTO gate (id, run_id, step_id, episode_id, artifact_id) VALUES (?, ?, ?, ?, ?)',
        id,
        where.runId,
        where.stepId,
        where.episodeId,
        draft.artifactId,
      )
    }

    const version = store.get<{ version: number }>(
      'SELECT version FROM artifact WHERE id = ?',
      draft.artifactId,
    )?.version
    if (version === undefined) throw new Error(`no such artifact: ${draft.artifactId}`)
    const payload = draft.payload === undefined ? null : JSON.stringify(draft.payload)

    const open = openRoundNumber(store, id)
    if (open === undefined) {
      store.run(
        'INSERT INTO gate_round (gate_id, round, artifact_version, payload) VALUES (?, ?, ?, ?)',
        id,
        latestRoundNumber(store, id) + 1,
        version,
        payload,
      )
    } else {
      // The open round is a presentation, not history. See the module header.
      store.run(
        'UPDATE gate_round SET artifact_version = ?, payload = ? WHERE gate_id = ? AND round = ?',
        version,
        payload,
        id,
        open,
      )
    }
    return id
  })

  return gateStanding(store, gateId)!
}

// ── Ruling ──────────────────────────────────────────────────────────────────────

/**
 * The ruling API: four verbs, and the only thing that resumes a paused run.
 *
 * It is a factory for the same reason `createRunner` is — a ruling writes the ledger,
 * appends to the log, and sends the run back into its step, and those three are one act.
 * Rulings never resume a run that is not parked on their gate; the ruling is still
 * recorded, because a verdict Ryan gave is a fact whatever the run is doing.
 */
export interface Rulings {
  /** Approve, with optional words. The run re-enters its step and carries on. */
  approve(gateId: string, ruling?: { comment?: string }): GateStanding
  /** Reject. At least one note; a single unrouted note is the legal default. */
  reject(gateId: string, ruling: { notes: readonly NoteDraft[] }): GateStanding
  /** Approve OVER something — recorded distinctly, forever (invariant 3). */
  override(gateId: string, ruling?: { comment?: string }): GateStanding
  /**
   * **Put the draft down** (E5-3, #83): the run ends, the note stands against the artifact,
   * the episode is free, and nothing regenerates until Ryan asks for it.
   *
   * At least one note, and it is required for the reason a rejection's is — a parking says
   * why, because 4.4 reads it back. Depths are legal on it and mean what they always mean: a
   * closing note routed to the outline is a note against the outline, put down at this gate.
   */
  close(gateId: string, ruling: { notes: readonly NoteDraft[] }): GateStanding
}

/**
 * **Why a rejection with no note is refused** — one string, three readers (E4-7).
 *
 * The verb is "reject WITH NOTES", so a rejection carrying none is the verb without its
 * object: nothing would be recorded against the round, the step would reopen with nothing to
 * write against, and a later writer run would read the desk back and find Ryan had said
 * nothing at all (`write-context.ts` is the reader that makes this load-bearing).
 *
 * It is composed rather than constant because it names what is being rejected, and it is
 * exported because three places have to say it identically: `rule` below throws it, the API
 * refuses with it, and the disabled button on every gate surface shows it BEFORE the click.
 * Until E4-7 those were three different sentences — the button's, the route's and the
 * ruling's — which is "preconditions before the button" decorated rather than kept (D15).
 */
export const rejectionNeedsANote = (subject: string): string =>
  `Rejecting ${subject} needs at least one note — “reject with notes” is the verb, and the ` +
  'notes are what the step reopens with. A rejection that said nothing would reopen the ' +
  'round with nothing to write against, and later runs read your notes back off the desk (4.4).'

/**
 * **Why putting a draft down with no note is refused** — the same rule as above, said about
 * the verb that does not reopen anything (E5-3).
 *
 * It has its own sentence rather than sharing the rejection's because the reason is not the
 * same reason. A rejection needs a note because the step REOPENS with it. A close reopens
 * nothing at all: the run ends. Its note is what the artifact carries afterwards — the thing
 * `notesOwedBy` reads to make the writing stage offerable again, and the thing the next
 * writer run is handed off the desk. A close with no note would end the run, free the
 * episode, and leave no trace anywhere of why he stopped, which is the one outcome 4.7's
 * *"a rejection says why"* exists to prevent.
 *
 * Three readers, identically, exactly as the rejection's has: the ruling throws it, the API
 * refuses with it, and the disabled button in the gate room shows it BEFORE the click.
 */
export const closingNeedsANote = (subject: string): string =>
  `Putting ${subject} down needs at least one note — a parking says why, the same as a ` +
  'rejection does (4.7). Nothing reopens on this verb, so the note is the whole record: it ' +
  'stands against the artifact, it is what makes the stage that writes it offerable again, ' +
  'and the next run reads it back off the desk (4.4).'

export function createRulings(store: Store, events: EventLog, runner: Runner): Rulings {
  function rule(
    gateId: string,
    verdict: RulingVerdict,
    given: { comment?: string; notes?: readonly NoteDraft[] },
  ): GateStanding {
    const before = gateStanding(store, gateId)
    if (!before) throw new Error(`no such gate: ${gateId}`)
    if (!before.isOpen) {
      const settled = before.ruling!
      throw new Error(
        `${before.subject} gate has no open round — round ${before.round} was ruled ` +
          `"${settled.verdict}" at ${settled.ruledAt}. A later opinion is a later round.`,
      )
    }
    const round = before.round
    const notes = given.notes ?? []
    // The only precondition either verb has, and it is on the verb's own OBJECT rather than
    // on the artifact, the findings or the run. Two sentences because they are two reasons.
    if (verdict === 'reject' && notes.length === 0) {
      throw new Error(rejectionNeedsANote(before.subject))
    }
    if (verdict === 'close' && notes.length === 0) {
      throw new Error(closingNeedsANote(before.subject))
    }

    store.transaction(() => {
      store.run(
        'INSERT INTO gate_ruling (gate_id, round, verdict, comment) VALUES (?, ?, ?, ?)',
        gateId,
        round,
        verdict,
        given.comment ?? null,
      )
      for (const note of notes) {
        // The address is resolved HERE, inside the ruling's transaction, because it is about
        // the version standing at the moment Ryan wrote the note — and there is nowhere later
        // to recover that from (`domain/routing.ts`, 0014). It resolves and never refuses: a
        // route to a kind this episode has not written yet lands as a note with no address,
        // because nothing may block a ruling.
        const address = addressOf(store, before.gate, note)
        store.run(
          'INSERT INTO gate_note (gate_id, round, note, depth, target, target_version) VALUES (?, ?, ?, ?, ?, ?)',
          gateId,
          round,
          note.note,
          note.depth ?? null,
          address.target,
          address.targetVersion,
        )
      }
    })

    const after = gateStanding(store, gateId)!
    const gate = after.gate
    // Appended after the transaction commits, never inside it: `append` notifies its
    // subscribers as it writes, and a rollback cannot un-tell a browser.
    events.append({
      kind: GATE_EVENT[verdict],
      runId: gate.runId,
      stepId: gate.stepId,
      episodeId: gate.episodeId,
      summary: sentenceFor(store, after, verdict, notes.length),
      detail: {
        gateId,
        round,
        verdict,
        artifactId: gate.artifactId,
        comment: given.comment ?? null,
        // The notes ride the log as well as the ledger: routing depth is what E4 and E6
        // will act on, and the wire is where E1-8 and E5 read a rejection as it lands.
        notes: after.ruling!.notes,
      },
    })

    // Only a parked run is the ruling's to move. In one process a gate is open exactly
    // when its run is paused; if that is ever not true, the verdict still stands and the
    // runner is left alone rather than shoved.
    if (findRun(store, gate.runId)?.status === 'paused') runner.resumeRun(gate.runId)

    return after
  }

  return {
    approve: (gateId, ruling) => rule(gateId, 'approve', { comment: ruling?.comment }),
    reject: (gateId, ruling) => rule(gateId, 'reject', { notes: ruling.notes }),
    override: (gateId, ruling) => rule(gateId, 'override', { comment: ruling?.comment }),
    close: (gateId, ruling) => rule(gateId, 'close', { notes: ruling.notes }),
  }
}

/**
 * One event kind per verdict — a map rather than a chain of ternaries, so a fifth verb is a
 * type error here rather than a verdict that quietly logs itself as an override (0004's four
 * kinds, and 0015's fifth).
 */
const GATE_EVENT: Record<RulingVerdict, 'gate-approved' | 'gate-rejected' | 'gate-overridden' | 'gate-closed'> = {
  approve: 'gate-approved',
  reject: 'gate-rejected',
  override: 'gate-overridden',
  close: 'gate-closed',
}

/** The machine-written sentence for a ruling — the floor and the episode room render these. */
function sentenceFor(
  store: Store,
  standing: GateStanding,
  verdict: RulingVerdict,
  noteCount: number,
): string {
  if (verdict === 'approve') return `approved ${standing.subject}`
  if (verdict === 'override') {
    return `approved ${standing.subject} as an explicit override — recorded`
  }
  const stepName = store.get<{ name: string }>(
    'SELECT name FROM step WHERE id = ?',
    standing.gate.stepId,
  )!.name
  const notes = `${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`
  // The two sentences are as different as the two acts: one says what reopens, and the other
  // says that nothing does. Neither is ever the other's wording with a word swapped.
  if (verdict === 'close') {
    return (
      `put ${standing.subject} down with ${notes} — ${stepName} ends, nothing is rewritten, ` +
      'and your note stands against it'
    )
  }
  return `rejected ${standing.subject} with ${notes} — ${stepName} reopens as round ${standing.round + 1}`
}

/** "the ep06 script gate is open — round 2". Composed where it is true, like the lock waits. */
export function openedSentence(standing: GateStanding): string {
  return standing.round === 1
    ? `${standing.subject} gate is open`
    : `${standing.subject} gate is open — round ${standing.round}`
}

// ── Reading ─────────────────────────────────────────────────────────────────────

export function findGate(store: Store, id: string): Gate | undefined {
  const row = store.get<GateRow>('SELECT * FROM gate WHERE id = ?', id)
  return row && hydrateGate(row)
}

export function gateOfStep(store: Store, stepId: string): Gate | undefined {
  const row = store.get<GateRow>('SELECT * FROM gate WHERE step_id = ?', stepId)
  return row && hydrateGate(row)
}

/**
 * The newest gate this run opened, ruled or not — what a screen showing one run renders
 * under it. Newest rather than only-open, because a run that has been ruled on and
 * finished still has a decision worth reading back.
 */
export function gateOfRun(store: Store, runId: string): Gate | undefined {
  const row = store.get<GateRow>(
    'SELECT * FROM gate WHERE run_id = ? ORDER BY seq DESC LIMIT 1',
    runId,
  )
  return row && hydrateGate(row)
}

/**
 * **Every gate ever opened on this episode, newest first** — its whole ruling history, across
 * runs and across stages.
 *
 * Scoped to the EPISODE rather than to a run because that is the question E4-7's writing room
 * asks: an episode's premise was ruled by one run, its outline by another, and its script by a
 * third, and a room that could only reach the newest run's gate would hide two of Ryan's own
 * rulings behind archaeology. It is deliberately not filtered to open ones — a ruled gate is
 * the record of a decision, and reading back what he said at the premise while looking at the
 * script is most of what the room is for.
 *
 * Ordered by `seq` descending, never by a timestamp: `at` is for humans (events.ts's rule,
 * which every ordered read in this app keeps).
 */
export function gatesOfEpisode(store: Store, episodeId: string): Gate[] {
  return store
    .all<GateRow>('SELECT * FROM gate WHERE episode_id = ? ORDER BY seq DESC', episodeId)
    .map(hydrateGate)
}

/**
 * This step's gate if it is waiting on a ruling right now. The runner asks after every
 * step that returns normally, because a step that swallowed its own pause leaves exactly
 * this behind — an open decision on a run that sailed past it.
 */
export function openGateOfStep(store: Store, stepId: string): Gate | undefined {
  const gate = gateOfStep(store, stepId)
  if (!gate) return undefined
  return openRoundNumber(store, gate.id) === undefined ? undefined : gate
}

/** The gate, its rounds, their rulings and notes — one read, everything the gate room needs. */
export function gateStanding(store: Store, gateId: string): GateStanding | undefined {
  const gate = findGate(store, gateId)
  if (!gate) return undefined

  const rulings = new Map(
    store
      .all<RulingRow>('SELECT * FROM gate_ruling WHERE gate_id = ? ORDER BY round', gateId)
      .map((row) => [row.round, row]),
  )
  const notes = new Map<number, GateNote[]>()
  for (const row of store.all<NoteRow>(
    'SELECT * FROM gate_note WHERE gate_id = ? ORDER BY seq',
    gateId,
  )) {
    notes.set(row.round, [
      ...(notes.get(row.round) ?? []),
      { note: row.note, depth: row.depth, target: row.target, targetVersion: row.target_version },
    ])
  }

  const rows = store.all<RoundRow>(
    'SELECT * FROM gate_round WHERE gate_id = ? ORDER BY round',
    gateId,
  )
  const latest = rows.at(-1)?.round ?? 0
  const rounds = rows.map((row): GateRound => {
    const ruling = rulings.get(row.round)
    return {
      round: row.round,
      artifactVersion: row.artifact_version,
      payload: row.payload === null ? undefined : JSON.parse(row.payload),
      openedAt: row.opened_at,
      // A later round exists — this is the gate room's "stale — from before your last
      // rejection". Marked, never replaced: the round below is still exactly as it was.
      stale: row.round < latest,
      ...(ruling && {
        ruling: {
          verdict: ruling.verdict,
          comment: ruling.comment,
          notes: notes.get(row.round) ?? [],
          ruledAt: ruling.ruled_at,
        },
      }),
    }
  })

  const current = rounds.at(-1)
  return {
    gate,
    rounds,
    round: latest,
    ...(current?.ruling && { ruling: current.ruling }),
    isOpen: current !== undefined && current.ruling === undefined,
    subject: subjectOf(store, gate),
  }
}

/**
 * Every gate waiting on Ryan, oldest first — the floor's "needs you", and the reason it can
 * be loud without anyone remembering to set a flag anywhere.
 */
export function openGates(store: Store): OpenGate[] {
  return store
    .all<GateRow & { stage: string; step_name: string; episode_number: number }>(
      `SELECT g.*, r.stage, s.name AS step_name, e.number AS episode_number
         FROM gate g
         JOIN run r ON r.id = g.run_id
         JOIN step s ON s.id = g.step_id
         JOIN episode e ON e.id = g.episode_id
        WHERE NOT EXISTS (
              SELECT 1 FROM gate_ruling ru
               WHERE ru.gate_id = g.id
                 AND ru.round = (SELECT MAX(round) FROM gate_round WHERE gate_id = g.id))
        ORDER BY g.seq`,
    )
    .map((row) => {
      const gate = hydrateGate(row)
      const round = latestRoundNumber(store, gate.id)
      return {
        gate,
        stage: row.stage,
        stepName: row.step_name,
        episodeNumber: row.episode_number,
        round,
        subject: subjectOf(store, gate),
        since:
          store.get<{ opened_at: string }>(
            'SELECT opened_at FROM gate_round WHERE gate_id = ? AND round = ?',
            gate.id,
            round,
          )?.opened_at ?? gate.openedAt,
      }
    })
}

export function roundsOf(store: Store, gateId: string): GateRound[] {
  return gateStanding(store, gateId)?.rounds ?? []
}

/**
 * **Every version of this artifact Ryan approved as an explicit override**, ascending.
 *
 * A version and not a boolean: an override is his opinion of the draft that was in front of
 * him, and it must not license the next one. `approve` deliberately does not count, and
 * neither does `close`: **putting a draft down is not a ruling over anything standing on it**,
 * so D12's wall (`stage-wall.ts`) and D11's ratio (`cried-wolf.ts`) are the two readers this
 * verb is invisible to, and they are invisible to it by this filter and nothing else. The
 * verbs are kept apart in the ledger precisely so that "he approved", "he approved over
 * something" and "he stopped" stay different sentences forever (invariant 3), and folding any
 * of them here would undo that at the two places it is load-bearing.
 *
 * The two readers ask different questions of this one list, and the difference matters:
 *
 *   * D12's wall (`stage-wall.ts`) asks about the draft that is on the volume NOW, and takes
 *     the newest — `overriddenThrough` below.
 *   * D11's cried-wolf ratio (`cried-wolf.ts`) asks whether a finding raised against some
 *     PAST draft was standing when he ruled, which is an exact match on that draft's version.
 *     A max would credit an override at v3 against a finding from v1 he never saw at that
 *     gate, and a number Ryan cannot reconstruct from the record is the one thing D11's
 *     sentence may not contain.
 */
export function overriddenVersions(store: Store, artifactId: string): number[] {
  return store
    .all<{ version: number }>(
      `SELECT DISTINCT r.artifact_version AS version
         FROM gate g
         JOIN gate_round r ON r.gate_id = g.id
         JOIN gate_ruling ru ON ru.gate_id = g.id AND ru.round = r.round
        WHERE g.artifact_id = ? AND ru.verdict = 'override'
        ORDER BY r.artifact_version`,
      artifactId,
    )
    .map((row) => row.version)
}

/**
 * The newest version of this artifact Ryan approved as an explicit override, or null if he
 * never has — what D12's wall reads to know whether he has already ruled over the red
 * (`stage-wall.ts`).
 */
export function overriddenThrough(store: Store, artifactId: string): number | null {
  const versions = overriddenVersions(store, artifactId)
  return versions.length === 0 ? null : versions[versions.length - 1]!
}

// ── Rows ────────────────────────────────────────────────────────────────────────

/** The round awaiting a verdict, or undefined when the latest one has been ruled. */
function openRoundNumber(store: Store, gateId: string): number | undefined {
  return store.get<{ round: number }>(
    `SELECT round FROM gate_round
      WHERE gate_id = ?
        AND NOT EXISTS (SELECT 1 FROM gate_ruling WHERE gate_id = ? AND round = gate_round.round)
      ORDER BY round DESC LIMIT 1`,
    gateId,
    gateId,
  )?.round
}

function latestRoundNumber(store: Store, gateId: string): number {
  return (
    store.get<{ highest: number | null }>(
      'SELECT MAX(round) AS highest FROM gate_round WHERE gate_id = ?',
      gateId,
    )!.highest ?? 0
  )
}

/** "the ep06 script", "the ep06 shot-image shot-05" — what is under review, in words. */
function subjectOf(store: Store, gate: Gate): string {
  const row = store.get<{ kind: string; slot: string; number: number }>(
    `SELECT a.kind, a.slot, e.number
       FROM artifact a
       JOIN episode e ON e.id = ?
      WHERE a.id = ?`,
    gate.episodeId,
    gate.artifactId,
  )
  if (!row) return 'the artifact'
  const episode = `ep${String(row.number).padStart(2, '0')}`
  return `the ${episode} ${row.kind}${row.slot ? ` ${row.slot}` : ''}`
}

interface GateRow {
  seq: number
  id: string
  run_id: string
  step_id: string
  episode_id: string
  artifact_id: string
  opened_at: string
}

interface RoundRow {
  gate_id: string
  round: number
  artifact_version: number
  payload: string | null
  opened_at: string
}

interface RulingRow {
  gate_id: string
  round: number
  verdict: RulingVerdict
  comment: string | null
  ruled_at: string
}

interface NoteRow {
  seq: number
  gate_id: string
  round: number
  note: string
  depth: NoteDepth | null
  target: string | null
  target_version: number | null
}

const hydrateGate = (row: GateRow): Gate => ({
  id: row.id,
  runId: row.run_id,
  stepId: row.step_id,
  episodeId: row.episode_id,
  artifactId: row.artifact_id,
  openedAt: row.opened_at,
})

import type { Store } from '../db/store.ts'
import { createEventLog } from '../events.ts'
import { declarePosition, findWaypoint, type ArcPosition } from './arc.ts'
import { canonAsOf, type Fact } from './fact.ts'
import {
  createProposalRulings,
  findProposal,
  raiseProposal,
  type Proposal,
  type ProposalOrigin,
} from './proposal.ts'
import { episodeLabel, findEpisode, markAbandoned, type Episode } from './spine.ts'

/**
 * What episodes do to canon (E2-3): the completion sweep, abandonment's reverts, and the
 * waypoint landing (1.2, 3.3, D8).
 *
 * **All three RAISE. None of them writes canon**, and that is not a stylistic preference —
 * it is invariant 1 with three more callers. Every line in this module ends at a row in
 * `proposal`, and Ryan ruling one at its gate through E2-2's `createProposalRulings` is
 * what moves canon. There is no ruling verb in here, no `revertAll`, no bulk anything.
 *
 * ## The three, and what each is
 *
 * **The sweep** collects; it does not rule. At episode approval every proposal still riding
 * the episode — the writer's fact deltas, a check remediation's, and the waypoint landings
 * below — comes to one final ruling pass, and Ryan rules them one at a time. This is a READ
 * (it writes nothing at all) because the collection is the whole job: its caller asks it what
 * approving the episode still owes canon, and renders each proposal with its own blast radius
 * beside it.
 *
 * **E4-6 (#66) is that caller, and it is not the gate this header used to name** — `sweep.ts`,
 * reached from the episode rather than from inside a ruling. E2-3 wrote "E4's approval gate
 * calls it", and E4-4 then ruled the step order that makes the literal reading impossible: the
 * extraction runs on the FAR SIDE of the script gate, because it reads the draft Ryan approved,
 * so at the moment that gate renders the riders it will raise do not exist. The sweep is
 * therefore the pass that stands OWED once the script is approved and the extraction has landed
 * — presented from the episode, one rider at a time, each on its own row of the ledger. The
 * full argument, and the two roads not taken, are in `sweep.ts`'s header; nothing about THIS
 * function changed to accommodate it, which is the point.
 *
 * It sweeps EXISTING proposals only. Extracting the implicit facts out of a written scene —
 * "she called him by his first name, so they are on those terms now" — is LLM work and
 * belongs to E3/E4; those extractors raise proposals riding the episode, and this sweep
 * collects them without a line changing here. E4-4's `claim.ts` is the first of them, and it
 * cost this file nothing, exactly as predicted.
 *
 * **Abandonment** puts an episode down at whatever stage it died at (`abandoned_at` is a
 * column, not a stage — 0009 says why) and then does two different things to two different
 * kinds of claim, which is the distinction worth being careful about:
 *
 *   - Canon the episode ESTABLISHED — ratified facts whose lineage names it — is not
 *     touched. One **revert proposal per fact** is raised, and each is ruled on its own
 *     (3.3: reverting is surgical). Some of what a dead episode established is still true;
 *     that is Ryan's call, fact by fact, and a `revertAll` would take the call away from
 *     him. Nothing here rules them.
 *   - Claims that were only RIDING it are **auto-deferred**, with the abandonment as the
 *     note. This is the edge the issue did not cover, decided deliberately: left alone,
 *     their provisional facts stay visible to `factsInScope` forever, riding a corpse, and
 *     a check on some other episode would keep arguing with a claim from an episode that no
 *     longer exists. Deferral is 3.3's own word for parking something, it writes NO CANON —
 *     which is what makes this loop legal where a loop of reverts would not be — and a
 *     deferred proposal comes back the way any does, as a new proposal citing the note.
 *     **This is flagged for Ryan's ruling; if he wants them left riding, this is the one
 *     call to change and the reverts above are untouched by it.**
 *
 * **The landing** is the wrapper D8 asked for, and `declarePosition` in arc.ts stays the
 * dumb write beneath it — the same shape `establishFact` has under ratification. A writer
 * run declaring a position calls this, and gets the landing proposal riding the episode so
 * the sweep collects it.
 *
 * **The fixture loader still calls `declarePosition` and raises no landing**, and E2-4 left
 * it that way on purpose after founding the sheets around it. A landing is a fact, so it
 * needs a SUBJECT entity, and the arc sheet does not carry one — "which character or place
 * is ep01 @ waypoint 2 a claim about" is a writing judgement (see the README's E2-3
 * constraint). E4's writer step is where that answer comes from; inventing one in a loader
 * would have put a fact in the fixture nobody decided.
 *
 * A landing is a fact, and a fact is about an ENTITY — so the caller says which one the
 * landing reads on. There is no entity on `arc`: an arc is a shape a season makes, and
 * which character or place it is a claim about is the writer's answer, not the schema's.
 */

// ── The completion sweep (1.2) ──────────────────────────────────────────────────

export interface Sweep {
  episode: Episode
  /** Unruled, oldest first — the final ruling pass, and Ryan takes them one at a time. */
  outstanding: Proposal[]
  /** Ruled while the episode was in flight. The record, kept forever (3.3). */
  ruled: Proposal[]
  /** The episode room's own line, composed on the server where it has a test. */
  sentence: string
}

/**
 * Every proposal riding this episode, split by whether it has been ruled — the pass Ryan owes
 * once its script is approved (`sweep.ts`, E4-6).
 *
 * Founding proposals are not here and cannot be: they ride nothing (D25), so no episode's
 * approval convenes them. `openProposals` is the queue that does.
 */
export function sweepEpisode(store: Store, episodeId: string): Sweep {
  const episode = findEpisode(store, episodeId)
  if (!episode) throw new Error(`No such episode: ${episodeId}`)

  const riding = store
    .all<{ id: string }>(
      'SELECT id FROM proposal WHERE episode_id = ? ORDER BY rowid',
      episodeId,
    )
    .map((row) => findProposal(store, row.id)!)

  const outstanding = riding.filter((proposal) => proposal.disposition === null)
  const ruled = riding.filter((proposal) => proposal.disposition !== null)
  return { episode, outstanding, ruled, sentence: sweepSentence(episode, outstanding) }
}

/** "ep06 carries 2 proposals to rule — 1 fact delta, 1 waypoint landing." */
function sweepSentence(episode: Episode, outstanding: Proposal[]): string {
  const label = episodeLabel(episode.number)
  if (outstanding.length === 0) return `${label} carries nothing left to rule.`

  const counted = new Map<string, number>()
  for (const proposal of outstanding) {
    const noun = KIND_NOUN[proposal.kind]
    counted.set(noun, (counted.get(noun) ?? 0) + 1)
  }
  const parts = [...counted].map(([noun, count]) => `${count} ${noun}${count === 1 ? '' : 's'}`)

  return (
    `${label} carries ${outstanding.length} proposal${outstanding.length === 1 ? '' : 's'} ` +
    `to rule — ${parts.join(', ')}.`
  )
}

/** What each kind is called in a sentence Ryan reads. Singular; the count pluralises it. */
const KIND_NOUN: Record<Proposal['kind'], string> = {
  'fact-delta': 'fact delta',
  'relation-delta': 'relation delta',
  promotion: 'promotion',
  revert: 'revert',
  landing: 'waypoint landing',
}

// ── Abandonment (3.3) ───────────────────────────────────────────────────────────

export interface Abandonment {
  episode: Episode
  /** One per ratified fact the episode established. Raised, never ruled — 3.3 is surgical. */
  reverts: Proposal[]
  /** Claims that were riding it, parked with the abandonment as the note. */
  parked: Proposal[]
  sentence: string
}

/**
 * Puts an episode down, and hands Ryan what it left behind.
 *
 * The note is required and it is not ceremony: it becomes the deferral note on every parked
 * proposal and the usage context of every revert, so the queue a week later still says why
 * these are in it. Same rule `reject` holds — the reason is the substance.
 *
 * Order matters, and it is the one written here: park first, then raise. Deferring closes
 * the provisional facts that were riding, so by the time the reverts are counted, the only
 * facts left with this episode's lineage are the ones Ryan actually ratified — which is
 * exactly the set 3.3 says to revert one by one.
 */
export function abandonEpisode(
  store: Store,
  episodeId: string,
  reason: { note: string },
): Abandonment {
  const note = reason.note.trim()
  if (note === '') {
    throw new Error(
      'Abandoning an episode needs the reason — it is the note on every claim this parks ' +
        'and the usage context of every revert it raises, and it is read months later.',
    )
  }

  const found = findEpisode(store, episodeId)
  if (!found) throw new Error(`No such episode: ${episodeId}`)
  const label = `${episodeLabel(found.number)} “${found.title}”`
  const why = `${label} was abandoned — ${note}`

  // The one ruling API, convened here rather than reimplemented (CLAUDE.md). The log it
  // takes is never written to and cannot be: `announce` returns on a ruling with no gate,
  // and an abandonment convenes no gate — 0008's header rules that only a ruling made at
  // one reaches the wire, because `event.run_id` is NOT NULL and this has no run.
  const rulings = createProposalRulings(store, createEventLog(store))

  return store.transaction(() => {
    const parked = sweepEpisode(store, episodeId).outstanding
    const episode = markAbandoned(store, episodeId)

    // A LOOP THAT PARKS, NEVER A LOOP THAT RULES CANON. A deferral writes nothing to canon
    // (proposal.ts: "`reject` and `defer` write nothing at all"); it closes the provisional
    // claims the proposal was riding with, so the checks stop seeing an episode that is
    // gone. The reverts below are the opposite kind of act and get the opposite treatment.
    for (const proposal of parked) {
      rulings.defer(proposal.id, { note: why })
    }

    // Read AFTER the deferrals, so what is counted is what Ryan actually ratified: the
    // claims that were merely riding have just been put down and are out of canon already.
    const reverts = ratifiedFactsEstablishedIn(store, episodeId).map((fact) =>
      raiseProposal(store, {
        entityId: fact.entityId,
        kind: 'revert',
        // Rides NOTHING. The episode it overturns is a corpse, and a proposal riding one
        // would put a fresh provisional claim in front of the checks on behalf of the dead.
        raisedBy: 'ryan',
        usageContext: why,
        alternatives: [
          'keep it — the fact is true whether or not the episode ships',
          'supersede it from a living episode instead of reverting it',
        ],
        facts: [
          {
            statement: fact.statement,
            supersedes: fact.id,
            ...(fact.field !== null && { field: fact.field }),
          },
        ],
      }),
    )

    return { episode, reverts, parked, sentence: abandonSentence(label, reverts, parked) }
  })
}

/**
 * The ratified facts this episode established that are still standing. Closed ones are
 * already out of canon — superseded by a later episode, or reverted by an earlier
 * abandonment — and a fact closes once, one way (D9), so there is nothing to revert.
 *
 * `canonAsOf(…, 'now')` is the definition of "still standing", filtered by lineage rather
 * than re-derived: one answer to "what is true", asked the way every other screen asks it.
 */
function ratifiedFactsEstablishedIn(store: Store, episodeId: string): Fact[] {
  const show = store.get<{ show_id: string }>(
    `SELECT s.show_id FROM episode e JOIN season s ON s.id = e.season_id WHERE e.id = ?`,
    episodeId,
  )
  if (!show) return []
  return canonAsOf(store, { showId: show.show_id }, 'now').filter(
    (fact) => fact.establishedIn === episodeId,
  )
}

function abandonSentence(label: string, reverts: Proposal[], parked: Proposal[]): string {
  if (reverts.length === 0 && parked.length === 0) {
    return `${label} abandoned — it established no canon.`
  }

  const clauses: string[] = []
  if (reverts.length > 0) {
    clauses.push(
      `${reverts.length} ratified fact${reverts.length === 1 ? '' : 's'} to revert, ` +
        'one ruling at a time',
    )
  }
  if (parked.length > 0) {
    clauses.push(`${parked.length} claim${parked.length === 1 ? '' : 's'} parked`)
  }
  return `${label} abandoned — ${clauses.join(', ')}.`
}

// ── The waypoint landing (D8) ───────────────────────────────────────────────────

export interface Landing {
  position: ArcPosition
  /** The landing proposal riding the episode — ratified, it becomes a fact with lineage. */
  proposal: Proposal
  /** False when the position was already declared here and its landing already stands. */
  raised: boolean
}

export interface LandingDraft {
  episodeId: string
  arcId: string
  waypointId: string
  /** The canon entity the landing is a fact about. A fact is about an entity; arcs are not. */
  subject: string
  raisedBy?: ProposalOrigin
  /** The passage that landed it — the scene Ryan reads under "Usage context" at the gate. */
  usageContext?: string
}

/**
 * Declares the episode's position on an arc AND raises the landing proposal for it (D8).
 *
 * The two halves are deliberately separable. `declarePosition` is the write — it moves the
 * episode's pin on the arc, and the fixture loader calls it directly and raises no landing
 * (the header says why: a landing needs a subject the arc sheet does not carry). THIS
 * is the flow above it, and it is what a writer run calls: the pin moves and, beside it, a
 * proposal saying "arc X reached waypoint Y in epZ" rides the episode to its sweep. Until
 * Ryan rules it the landing is a claim — visible to checks, invisible to `canonAsOf`.
 *
 * Declaring the SAME waypoint again stands on the landing already raised rather than
 * raising a second: re-declaring is how an episode confirms it has been re-checked after a
 * waypoint went in ahead of it (arc.ts), and confirming is not a new claim. Declaring a
 * DIFFERENT waypoint is a new claim and raises one — both then go to the sweep, where Ryan
 * sees what was claimed and what is claimed now and rules them. Neither path rules anything
 * here; a flow that quietly deferred the superseded landing would be ruling on his behalf.
 */
export function landPosition(store: Store, draft: LandingDraft): Landing {
  return store.transaction(() => {
    const waypoint = findWaypoint(store, draft.waypointId)
    if (!waypoint || waypoint.arcId !== draft.arcId) {
      throw new Error(`Waypoint ${draft.waypointId} does not belong to arc ${draft.arcId}`)
    }

    const position = declarePosition(store, {
      episodeId: draft.episodeId,
      arcId: draft.arcId,
      waypointId: draft.waypointId,
    })

    const standing = openLandingsOn(store, draft.episodeId, draft.arcId).find(
      (open) => open.waypointId === draft.waypointId,
    )
    if (standing) {
      return { position, proposal: findProposal(store, standing.proposalId)!, raised: false }
    }

    const episode = findEpisode(store, draft.episodeId)!
    const proposal = raiseProposal(store, {
      entityId: draft.subject,
      kind: 'landing',
      raisedBy: draft.raisedBy ?? 'writer',
      episodeId: draft.episodeId,
      ...(draft.usageContext !== undefined && { usageContext: draft.usageContext }),
      facts: [{ statement: landingStatement(position, episode) }],
    })
    store.run(
      'INSERT INTO proposal_landing (proposal_id, arc_id, waypoint_id) VALUES (?, ?, ?)',
      proposal.id,
      draft.arcId,
      draft.waypointId,
    )

    return { position, proposal: findProposal(store, proposal.id)!, raised: true }
  })
}

/**
 * The sentence that becomes canon. The waypoint's ORDINAL AT THIS MOMENT is written into
 * it, on purpose: a fact is a statement Ryan ruled on, and it has to keep saying what he
 * ruled on after a later insert renumbers the arc. The live ordinal is
 * `episode_arc_position` and the drift between them is `episodesNeedingRecheck` — computed,
 * never remembered (D8).
 */
function landingStatement(position: ArcPosition, episode: Episode): string {
  return (
    `“${position.arc.name}” reached waypoint ${position.waypoint.ordinal} ` +
    `“${position.waypoint.name}” in ${episodeLabel(episode.number)}.`
  )
}

/** Which arc and waypoint a landing proposal landed. `undefined` on any other kind. */
export function landingOf(
  store: Store,
  proposalId: string,
): { arcId: string; waypointId: string } | undefined {
  const row = store.get<{ arc_id: string; waypoint_id: string }>(
    'SELECT arc_id, waypoint_id FROM proposal_landing WHERE proposal_id = ?',
    proposalId,
  )
  return row && { arcId: row.arc_id, waypointId: row.waypoint_id }
}

/** The landings nobody has ruled yet on one arc — the arc page's pending column (D24). */
export function openLandingsOfArc(store: Store, arcId: string): Proposal[] {
  return store
    .all<{ proposal_id: string }>(
      `SELECT l.proposal_id
         FROM proposal_landing l
         JOIN proposal p ON p.id = l.proposal_id
        WHERE l.arc_id = ?
          AND NOT EXISTS (SELECT 1 FROM canon_ruling WHERE proposal_id = p.id)
        ORDER BY p.rowid`,
      arcId,
    )
    .map((row) => findProposal(store, row.proposal_id)!)
}

function openLandingsOn(
  store: Store,
  episodeId: string,
  arcId: string,
): { proposalId: string; waypointId: string }[] {
  return store
    .all<{ proposal_id: string; waypoint_id: string }>(
      `SELECT l.proposal_id, l.waypoint_id
         FROM proposal_landing l
         JOIN proposal p ON p.id = l.proposal_id
        WHERE p.episode_id = ? AND l.arc_id = ?
          AND NOT EXISTS (SELECT 1 FROM canon_ruling WHERE proposal_id = p.id)
        ORDER BY p.rowid`,
      episodeId,
      arcId,
    )
    .map((row) => ({ proposalId: row.proposal_id, waypointId: row.waypoint_id }))
}

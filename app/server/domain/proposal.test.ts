import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { createEventLog, eventsOfRun, type EventLog } from '../events.ts'
import { presentForRuling } from '../runner/gate.ts'
import { findStepByName, reconcileSteps, recordRun } from '../runner/run.ts'
import type { Stage } from '../runner/step.ts'
import { appendWaypoint, createArc, declarePosition } from './arc.ts'
import { recordArtifact } from './artifact.ts'
import {
  amendEntity,
  findEntityById,
  referencesOf,
  registerEntity,
  type CanonEntity,
} from './canon.ts'
import { declareCategory, declareRelationType } from './category.ts'
import { canonAsOf, establishFact, factsInScope, findFact, recordRuling } from './fact.ts'
import {
  blastRadius,
  createProposalRulings,
  findProposal,
  openProposals,
  proposalsOfEntity,
  proposalsRiding,
  raiseProposal,
  type Proposal,
  type RelationPartDraft,
} from './proposal.ts'
import { relate, relationsFrom, UNKNOWN_TARGET } from './relation.ts'
import { createEpisode, createSeason, createShow, type Episode } from './spine.ts'
import { scaffoldStage } from '../runner/stage-fixture.ts'

let store: Store
let events: EventLog

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  events = createEventLog(store)
})

afterEach(() => {
  store.close()
})

/**
 * Grey Harbor cut to what a proposal needs, shaped like the gate room's own example: Mara,
 * who refuses to carry arms as of ep02, appearing again in ep06 — where the script wants
 * her armed. The arc she brushes and the candidate nobody has promoted yet come with it.
 */
interface Harbor {
  showId: string
  episodes: Episode[]
  mara: CanonEntity
  ferro: CanonEntity
  passenger: CanonEntity
  halvani: CanonEntity
  /** Mara's ratified ep02 fact: the "before" of the coil-pistol delta. */
  refusesArms: string
}

function seedHarbor(): Harbor {
  const showId = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
  const seasonId = createSeason(store, { showId, number: 1 }).id
  const episodes = ['The Long Pier', 'Dry Stores', 'Hull Frost', 'The Empty Lane', 'Spares', 'Ledger Coat'].map(
    (title, index) => createEpisode(store, { seasonId, number: index + 1, title }),
  )

  const character = declareCategory(store, { showId, key: 'character', name: 'Character' })
  declareCategory(store, { showId, key: 'species', name: 'Species' })
  declareCategory(store, { showId, key: 'technology', name: 'Technology' })

  declareRelationType(store, character.id, {
    name: 'species',
    targetCategory: 'species',
    cardinality: 'exactly-one',
    required: true,
    inverse: 'members',
    inheritsFacts: true,
  })
  declareRelationType(store, character.id, {
    name: 'carries',
    targetCategory: 'technology',
    cardinality: 'any',
    required: false,
    inverse: 'carried-by',
  })

  const entity = (categoryKey: string, name: string): CanonEntity =>
    registerEntity(store, { showId, categoryKey, name })

  const halvani = entity('species', 'Halvani')
  const mara = entity('character', 'Mara')
  const ferro = entity('character', 'Ferro')
  // Registered and nothing more: a candidate, which is what a row nobody has ruled on is.
  const passenger = entity('character', 'The Passenger')

  for (const who of [mara, ferro]) {
    relate(store, { fromEntityId: who.id, type: 'species', to: halvani.id })
    amendEntity(store, who.id, { status: 'active', standing: 'core' })
  }

  // The canon the coil-pistol argues with, ratified at its ep02 gate.
  const refusesArms = establishFact(store, {
    entityId: mara.id,
    field: 'conduct',
    statement: 'Mara refuses to carry arms.',
    establishedIn: episodes[1]!.id,
    ratifiedBy: recordRuling(store, 'ratification').seq,
  }).id

  // What blast radius is computed FROM: provenance (which episodes read on Mara) and the
  // arc ep06 declares a position on. Nothing about the proposal is stored anywhere.
  recordArtifact(store, { episodeId: episodes[1]!.id, kind: 'script', touches: [mara.id] })
  recordArtifact(store, { episodeId: episodes[5]!.id, kind: 'outline', touches: [mara.id] })

  const trust = createArc(store, {
    showId,
    scope: 'show',
    kind: 'character',
    name: 'Vessa ↔ Ferro · trust',
    statement: 'What it costs these two to believe each other.',
  })
  appendWaypoint(store, trust.id, { name: 'the first lie' })
  const second = appendWaypoint(store, trust.id, { name: 'the ledger opened' })
  declarePosition(store, {
    episodeId: episodes[5]!.id,
    arcId: trust.id,
    waypointId: second.id,
  })

  return { showId, episodes, mara, ferro, passenger, halvani, refusesArms }
}

/** The coil-pistol proposal of `mockups/gate-room.html`, raised against ep06. */
function coilPistol(harbor: Harbor, riding?: string): Proposal {
  return raiseProposal(store, {
    entityId: harbor.mara.id,
    kind: 'fact-delta',
    raisedBy: 'writer',
    episodeId: riding === undefined ? harbor.episodes[5]!.id : riding,
    usageContext:
      '“…carrying the cold of outside like a second coat. The weight under Mara’s own ' +
      'coat answers it.” — scene 4',
    alternatives: [
      'the weight is the ledger itself (no canon change)',
      'the pistol is Ferro’s, left behind (smaller change)',
    ],
    facts: [
      {
        field: 'armament',
        statement: 'Mara carries a coil-pistol, never drawn, under the ledger coat.',
        supersedes: harbor.refusesArms,
      },
    ],
  })
}

const statements = (facts: { statement: string }[]): string[] => facts.map((f) => f.statement)

// ── Raised, and riding ──────────────────────────────────────────────────────────

describe('a proposal riding its episode (3.3)', () => {
  it('puts its claim in front of the checks, and leaves canon alone', () => {
    const harbor = seedHarbor()
    const proposal = coilPistol(harbor)

    // The scope helper is what a check reads (invariant 2), and a riding claim is visible
    // to it — that is the whole difference between provisional and ratified.
    const scope = factsInScope(store, harbor.mara.id)
    expect(statements(scope.inScope)).toContain(
      'Mara carries a coil-pistol, never drawn, under the ledger coat.',
    )
    expect(statements(scope.inScope)).toContain('Mara refuses to carry arms.')

    // Canon has not moved. `canonAsOf` is ratified facts only, and nobody has ruled.
    expect(statements(canonAsOf(store, { entityId: harbor.mara.id }, 'now'))).toEqual([
      'Mara refuses to carry arms.',
    ])
    expect(proposal.status).toBe('raised')
    expect(proposal.disposition).toBeNull()

    const claim = findFact(store, proposal.change.facts[0]!.factId!)!
    expect(claim.status).toBe('provisional')
    expect(claim.establishedIn).toBe(harbor.episodes[5]!.id)
  })

  it('rides nothing when it has no episode — the founding case (D25)', () => {
    const harbor = seedHarbor()

    // A promotion of the Grey Harbor sheets, raised by the loader before any episode
    // exists. There is no episode to ride, so there is nothing for a check to see: the
    // sheet arrives with the ratification.
    const proposal = raiseProposal(store, {
      entityId: harbor.passenger.id,
      kind: 'promotion',
      raisedBy: 'loader',
      standing: 'recurring',
      body: 'Came aboard on the Meridian packet and did not get off.',
      facts: [{ field: 'manner', statement: 'The Passenger never gives a name.' }],
      relations: [{ op: 'add', type: 'species', to: UNKNOWN_TARGET }],
    })

    expect(proposal.episodeId).toBeNull()
    expect(proposal.change.facts[0]!.factId).toBeNull()
    expect(factsInScope(store, harbor.passenger.id).inScope).toEqual([])
    // And nothing of the sheet has been written: the candidate is still a candidate.
    expect(relationsFrom(store, harbor.passenger.id)).toEqual([])
  })

  it('reads back all five parts, and computes the fifth', () => {
    const harbor = seedHarbor()
    const proposal = findProposal(store, coilPistol(harbor).id)!

    expect(proposal.change.facts[0]).toMatchObject({
      field: 'armament',
      statement: 'Mara carries a coil-pistol, never drawn, under the ledger coat.',
      supersedes: harbor.refusesArms,
    })
    expect(proposal.usageContext).toContain('The weight under Mara’s own coat answers it.')
    expect(proposal.alternatives).toEqual([
      'the weight is the ledger itself (no canon change)',
      'the pistol is Ferro’s, left behind (smaller change)',
    ])
    expect(proposal.raisedBy).toBe('writer')
    expect(proposal.entityId).toBe(harbor.mara.id)
  })
})

// ── The ruling ──────────────────────────────────────────────────────────────────

describe('the ruling API — three verbs, every kind kept forever (3.3)', () => {
  it('ratifies: writes the fact with lineage, and closes both the claim and its predecessor', () => {
    const harbor = seedHarbor()
    const proposal = coilPistol(harbor)
    const claimId = proposal.change.facts[0]!.factId!

    const ruled = createProposalRulings(store, events).ratify(proposal.id, {
      note: 'she carries it and never draws it. That is the character.',
    })

    expect(ruled.status).toBe('ratified')
    expect(statements(canonAsOf(store, { entityId: harbor.mara.id }, 'now'))).toEqual([
      'Mara carries a coil-pistol, never drawn, under the ledger coat.',
    ])

    // The canon fact carries its lineage: the episode that established it and the ruling
    // that made it true.
    const written = canonAsOf(store, { entityId: harbor.mara.id }, 'now')[0]!
    expect(written.establishedIn).toBe(harbor.episodes[5]!.id)
    expect(written.ratifiedBy).toBe(ruled.disposition!.seq)

    // Two facts gave way to it at one ruling, and they are different things: the claim that
    // rode ep06, and the canon it argued with. Both name the same heir.
    expect(findFact(store, claimId)).toMatchObject({
      status: 'superseded',
      closure: expect.objectContaining({ closedBy: ruled.disposition!.seq, supersededBy: written.id }),
    })
    expect(findFact(store, harbor.refusesArms)).toMatchObject({
      status: 'superseded',
      closure: expect.objectContaining({ closedBy: ruled.disposition!.seq, supersededBy: written.id }),
    })

    // And the point-in-time read still answers as it did: canon before this ruling.
    expect(
      statements(
        canonAsOf(store, { entityId: harbor.mara.id }, { ruling: ruled.disposition!.seq - 1 }),
      ),
    ).toEqual(['Mara refuses to carry arms.'])
  })

  it('rejects: keeps the note forever, writes no canon, and stops the claim riding', () => {
    const harbor = seedHarbor()
    const proposal = coilPistol(harbor)

    createProposalRulings(store, events).reject(proposal.id, {
      note: 'no. Mara unarmed is the whole point of her — it is why the ledger works.',
    })

    // The note is what E4's writer context reads back, so it is read back here.
    const after = findProposal(store, proposal.id)!
    expect(after.status).toBe('rejected')
    expect(after.disposition!.kind).toBe('rejection')
    expect(after.disposition!.note).toBe(
      'no. Mara unarmed is the whole point of her — it is why the ledger works.',
    )

    // Nothing was written, and the claim has stopped riding: a check reading ep06 tomorrow
    // must not still see a pistol Ryan said no to.
    expect(statements(canonAsOf(store, { entityId: harbor.mara.id }, 'now'))).toEqual([
      'Mara refuses to carry arms.',
    ])
    expect(statements(factsInScope(store, harbor.mara.id).inScope)).toEqual([
      'Mara refuses to carry arms.',
    ])
  })

  it('defers: parks it — out of the scope helper, and nothing written', () => {
    const harbor = seedHarbor()
    const proposal = coilPistol(harbor)

    createProposalRulings(store, events).defer(proposal.id, { note: 'not this episode.' })

    const after = findProposal(store, proposal.id)!
    expect(after.status).toBe('deferred')
    expect(after.disposition!.note).toBe('not this episode.')
    expect(statements(factsInScope(store, harbor.mara.id).inScope)).toEqual([
      'Mara refuses to carry arms.',
    ])
    expect(statements(canonAsOf(store, { entityId: harbor.mara.id }, 'now'))).toEqual([
      'Mara refuses to carry arms.',
    ])
  })

  it('refuses a second ruling — a later opinion is a new proposal', () => {
    const harbor = seedHarbor()
    const proposal = coilPistol(harbor)
    const rulings = createProposalRulings(store, events)
    rulings.defer(proposal.id, { note: 'park it.' })

    expect(() => rulings.ratify(proposal.id)).toThrow(/deferred/)
    expect(findProposal(store, proposal.id)!.status).toBe('deferred')
  })

  it('rules a proposal with no episode, no run and no gate — the bench, and founding', () => {
    const harbor = seedHarbor()
    const pitch = raiseProposal(store, {
      entityId: harbor.mara.id,
      kind: 'fact-delta',
      raisedBy: 'ryan',
      facts: [{ field: 'history', statement: 'Mara kept the harbour ledger before the strike.' }],
    })

    const ruled = createProposalRulings(store, events).ratify(pitch.id)

    expect(ruled.status).toBe('ratified')
    expect(ruled.disposition!.gateId).toBeNull()
    // No episode established it — a pre-episode pitch (5.7), the same NULL a founding
    // ratification writes (D25).
    const written = canonAsOf(store, { entityId: harbor.mara.id }, 'now').find(
      (fact) => fact.field === 'history',
    )!
    expect(written.establishedIn).toBeNull()
    expect(written.ratifiedBy).toBe(ruled.disposition!.seq)
  })
})

// ── Promotion ───────────────────────────────────────────────────────────────────

describe('promotion: a candidate becomes canon (D25)', () => {
  /** The Passenger's full initial sheet, as a loader or an import would raise it. */
  function promote(harbor: Harbor, relations: RelationPartDraft[]): Proposal {
    return raiseProposal(store, {
      entityId: harbor.passenger.id,
      kind: 'promotion',
      raisedBy: 'loader',
      standing: 'recurring',
      aliases: ['the packet passenger'],
      body: 'Came aboard on the Meridian packet and did not get off.',
      facts: [
        { field: 'manner', statement: 'The Passenger never gives a name.' },
        { field: 'history', statement: 'The Passenger paid the berth fee nine months ahead.' },
      ],
      relations,
      references: [
        { kind: 'image', filePath: 'canon/passenger/face.png', stance: 'locked', label: 'face' },
      ],
    })
  }

  it('refuses a character whose sheet declares no species (D22)', () => {
    const harbor = seedHarbor()
    const proposal = promote(harbor, [])

    expect(() => createProposalRulings(store, events).ratify(proposal.id)).toThrow(
      /cannot become canon without a `species`/,
    )

    // And the refusal left nothing half-written: no ruling, no sheet, still a candidate.
    expect(findEntityById(store, harbor.passenger.id)!.status).toBe('candidate')
    expect(findProposal(store, proposal.id)!.status).toBe('raised')
    expect(canonAsOf(store, { entityId: harbor.passenger.id }, 'now')).toEqual([])
  })

  it('promotes one whose species is declared `unknown` — that is a real answer', () => {
    const harbor = seedHarbor()
    const proposal = promote(harbor, [{ op: 'add', type: 'species', to: UNKNOWN_TARGET }])

    const ruled = createProposalRulings(store, events).ratify(proposal.id)

    expect(ruled.status).toBe('ratified')
    expect(findEntityById(store, harbor.passenger.id)!.status).toBe('active')
    // The edge is a row with a NULL target, never a sentinel entity (D22).
    expect(relationsFrom(store, harbor.passenger.id)).toMatchObject([{ toEntityId: null }])
  })

  it('turns the candidate active and writes the whole sheet under one ruling', () => {
    const harbor = seedHarbor()
    const proposal = promote(harbor, [{ op: 'add', type: 'species', to: harbor.halvani.id }])

    const ruled = createProposalRulings(store, events).ratify(proposal.id, {
      note: 'she is canon. Keep the name off the sheet.',
    })

    const passenger = findEntityById(store, harbor.passenger.id)!
    expect(passenger).toMatchObject({
      status: 'active',
      standing: 'recurring',
      aliases: ['the packet passenger'],
      body: 'Came aboard on the Meridian packet and did not get off.',
    })
    expect(statements(canonAsOf(store, { entityId: passenger.id }, 'now'))).toEqual([
      'The Passenger never gives a name.',
      'The Passenger paid the berth fee nine months ahead.',
    ])
    // Every fact of the sheet carries the one ruling that founded it.
    for (const fact of canonAsOf(store, { entityId: passenger.id }, 'now')) {
      expect(fact.ratifiedBy).toBe(ruled.disposition!.seq)
      expect(fact.establishedIn).toBeNull()
    }
    expect(referencesOf(store, passenger.id)).toMatchObject([
      { kind: 'image', filePath: 'canon/passenger/face.png', stance: 'locked' },
    ])
    expect(relationsFrom(store, passenger.id)).toMatchObject([{ toEntityId: harbor.halvani.id }])
  })

  it('writes the edges before the facts, so an exception on the sheet lands (D22)', () => {
    const harbor = seedHarbor()
    // What every Halvani carries, and what this one does not.
    const holdsBreath = establishFact(store, {
      entityId: harbor.halvani.id,
      field: 'physiology',
      statement: 'A Halvani holds against vacuum for about a minute.',
      ratifiedBy: recordRuling(store, 'ratification').seq,
    })

    const proposal = raiseProposal(store, {
      entityId: harbor.passenger.id,
      kind: 'promotion',
      raisedBy: 'loader',
      episodeId: harbor.episodes[5]!.id,
      facts: [
        {
          field: 'physiology',
          statement: 'The Passenger cannot hold against vacuum at all.',
          overrides: holdsBreath.id,
        },
      ],
      relations: [{ op: 'add', type: 'species', to: harbor.halvani.id }],
    })

    // The exception rides nothing even though the proposal rides ep06 — the edge it makes
    // an exception to does not exist until this is ratified.
    expect(proposal.change.facts[0]!.factId).toBeNull()

    createProposalRulings(store, events).ratify(proposal.id)

    // Ratified in the right order: the species edge first, then the fact that excepts it.
    const scope = factsInScope(store, harbor.passenger.id)
    expect(statements(scope.inScope)).toEqual(['The Passenger cannot hold against vacuum at all.'])
    expect(scope.overrides).toMatchObject([{ displaces: { id: holdsBreath.id }, stale: false }])
  })

  it('refuses to promote what is already canon', () => {
    const harbor = seedHarbor()

    expect(() =>
      raiseProposal(store, { entityId: harbor.mara.id, kind: 'promotion', raisedBy: 'ryan' }),
    ).toThrow(/already active canon/)
  })
})

// ── The ruling on the wire ──────────────────────────────────────────────────────

describe('a ruling convened at a gate (E1-5)', () => {
  /** A run parked on the ep06 script gate, which is where the writer raised the proposal. */
  function gateOnEp06(harbor: Harbor): { gateId: string; runId: string } {
    const episodeId = harbor.episodes[5]!.id
    const stage: Stage = scaffoldStage('write', [
      { name: 'write-script', execute: async () => ({}) },
    ])
    const run = recordRun(store, stage, episodeId)
    reconcileSteps(store, run.id, stage)
    const step = findStepByName(store, run.id, 'write-script')!
    const artifact = recordArtifact(store, { episodeId, kind: 'script' })
    const standing = presentForRuling(
      store,
      { runId: run.id, stepId: step.id, episodeId },
      { artifactId: artifact.id },
    )
    return { gateId: standing.gate.id, runId: run.id }
  }

  it('appends the ruling to the run the gate belongs to', () => {
    const harbor = seedHarbor()
    const { gateId, runId } = gateOnEp06(harbor)
    const proposal = coilPistol(harbor)

    const ruled = createProposalRulings(store, events).ratify(proposal.id, {
      gateId,
      note: 'she carries it.',
    })

    expect(ruled.disposition!.gateId).toBe(gateId)
    const appended = eventsOfRun(store, runId).filter((event) => event.kind.startsWith('proposal-'))
    expect(appended).toHaveLength(1)
    expect(appended[0]!.kind).toBe('proposal-ratified')
    expect(appended[0]!.summary).toBe(
      `ratified the Mara proposal — canon as of ruling ${ruled.disposition!.seq}`,
    )
    expect(appended[0]!.detail).toMatchObject({ proposalId: proposal.id, note: 'she carries it.' })
  })

  it('records the ledger and writes no event when nothing convened it', () => {
    const harbor = seedHarbor()
    const { runId } = gateOnEp06(harbor)
    const proposal = coilPistol(harbor)

    // The bench (E2-6) and the founding flow (E2-4) rule with no run to append to. The
    // ruling still stands — the ledger is where canon reads it from.
    const ruled = createProposalRulings(store, events).defer(proposal.id, { note: 'not yet.' })

    expect(ruled.status).toBe('deferred')
    expect(eventsOfRun(store, runId).filter((event) => event.kind.startsWith('proposal-'))).toEqual([])
  })
})

// ── Implications ────────────────────────────────────────────────────────────────

describe('blast radius — the implications, computed and never stored (1.2)', () => {
  it('computes the gate room’s own example', () => {
    const harbor = seedHarbor()
    const radius = blastRadius(store, coilPistol(harbor).id)

    // The mockup's sentence: "touches 1 ratified fact (ep02: “Mara refuses arms”); brushes
    // arc “Vessa ↔ Ferro · trust” waypoint 2". Composed here, where it has a test.
    expect(radius.sentence).toBe(
      'touches 1 ratified fact (ep02: “Mara refuses to carry arms.”), brushes 1 arc ' +
        '(“Vessa ↔ Ferro · trust” waypoint 2), 1 prior episode reads on it',
    )
    expect(radius.facts).toMatchObject([
      { why: 'superseded', fact: { id: harbor.refusesArms }, episode: { number: 2 } },
    ])
    expect(radius.arcs).toMatchObject([
      { arc: { name: 'Vessa ↔ Ferro · trust' }, waypoint: { ordinal: 2 } },
    ])
    expect(radius.episodes.map((episode) => episode.number)).toEqual([2])
  })

  it('is recomputed, not remembered — ratifying the fact takes it out of the next radius', () => {
    const harbor = seedHarbor()
    const first = coilPistol(harbor)
    const before = blastRadius(store, first.id)
    createProposalRulings(store, events).ratify(first.id)

    // A second proposal against the same field now touches the fact the first one wrote,
    // and the one it closed is gone from the radius. Nothing was updated to make that true.
    const second = raiseProposal(store, {
      entityId: harbor.mara.id,
      kind: 'fact-delta',
      raisedBy: 'writer',
      episodeId: harbor.episodes[5]!.id,
      facts: [{ field: 'armament', statement: 'Mara carries the coil-pistol openly.' }],
    })

    expect(before.facts.map((touched) => touched.fact.id)).toEqual([harbor.refusesArms])
    expect(blastRadius(store, second.id).facts).toMatchObject([
      { why: 'same-field', fact: { statement: 'Mara carries a coil-pistol, never drawn, under the ledger coat.' } },
    ])
  })

  it('counts the facts that would arrive across a fact-carrying edge (D22)', () => {
    const harbor = seedHarbor()
    establishFact(store, {
      entityId: harbor.halvani.id,
      field: 'physiology',
      statement: 'A Halvani holds against vacuum for about a minute.',
      ratifiedBy: recordRuling(store, 'ratification').seq,
    })

    // Declaring a species is not a small edit: every fact of that species arrives in the
    // check scope of the character declaring it. The radius says so before Ryan rules.
    const proposal = raiseProposal(store, {
      entityId: harbor.passenger.id,
      kind: 'relation-delta',
      raisedBy: 'check',
      relations: [{ op: 'add', type: 'species', to: harbor.halvani.id }],
    })

    expect(blastRadius(store, proposal.id).facts).toMatchObject([
      { why: 'inherited', fact: { statement: 'A Halvani holds against vacuum for about a minute.' } },
    ])
  })

  it('says so plainly when a founding promotion touches nothing', () => {
    const harbor = seedHarbor()
    const proposal = raiseProposal(store, {
      entityId: harbor.passenger.id,
      kind: 'promotion',
      raisedBy: 'loader',
      facts: [{ field: 'manner', statement: 'The Passenger never gives a name.' }],
      relations: [{ op: 'add', type: 'species', to: UNKNOWN_TARGET }],
    })

    const radius = blastRadius(store, proposal.id)
    expect(radius.sentence).toBe('touches nothing ratified yet')
    expect(radius).toMatchObject({ facts: [], arcs: [], episodes: [] })
  })
})

// ── Relation deltas ─────────────────────────────────────────────────────────────

describe('a relation delta (D22, D23)', () => {
  it('resolves a declared `unknown` into a species, and the facts arrive with it', () => {
    const harbor = seedHarbor()
    const holdsBreath = establishFact(store, {
      entityId: harbor.halvani.id,
      field: 'physiology',
      statement: 'A Halvani holds against vacuum for about a minute.',
      ratifiedBy: recordRuling(store, 'ratification').seq,
    })
    const rulings = createProposalRulings(store, events)
    rulings.ratify(
      raiseProposal(store, {
        entityId: harbor.passenger.id,
        kind: 'promotion',
        raisedBy: 'loader',
        relations: [{ op: 'add', type: 'species', to: UNKNOWN_TARGET }],
      }).id,
    )
    const unknownEdge = relationsFrom(store, harbor.passenger.id)[0]!

    // Resolving an unknown is a replacement with a before: withdraw the edge, write the
    // one that answers it, in that ordinal order, under one ruling.
    rulings.ratify(
      raiseProposal(store, {
        entityId: harbor.passenger.id,
        kind: 'relation-delta',
        raisedBy: 'ryan',
        relations: [
          { op: 'remove', relationId: unknownEdge.id },
          { op: 'add', type: 'species', to: harbor.halvani.id },
        ],
      }).id,
    )

    expect(relationsFrom(store, harbor.passenger.id)).toMatchObject([
      { toEntityId: harbor.halvani.id },
    ])
    expect(statements(factsInScope(store, harbor.passenger.id).inScope)).toEqual([
      holdsBreath.statement,
    ])
  })

  it('refuses to withdraw a required edge from canon — the same door, from inside', () => {
    const harbor = seedHarbor()
    const edge = relationsFrom(store, harbor.mara.id)[0]!
    const proposal = raiseProposal(store, {
      entityId: harbor.mara.id,
      kind: 'relation-delta',
      raisedBy: 'writer',
      relations: [{ op: 'remove', relationId: edge.id }],
    })

    expect(() => createProposalRulings(store, events).ratify(proposal.id)).toThrow(
      /cannot become canon without a `species`/,
    )
    // Rolled back whole: the edge is still there and nothing was ruled.
    expect(relationsFrom(store, harbor.mara.id)).toHaveLength(1)
    expect(findProposal(store, proposal.id)!.status).toBe('raised')
  })
})

// ── The queues ──────────────────────────────────────────────────────────────────

describe('the queues a screen reads (5.3, 5.4)', () => {
  it('lists what rides an episode, what the show owes a ruling, and what touches an entity', () => {
    const harbor = seedHarbor()
    const riding = coilPistol(harbor)
    const founding = raiseProposal(store, {
      entityId: harbor.passenger.id,
      kind: 'promotion',
      raisedBy: 'loader',
      relations: [{ op: 'add', type: 'species', to: UNKNOWN_TARGET }],
    })

    expect(proposalsRiding(store, harbor.episodes[5]!.id).map((p) => p.id)).toEqual([riding.id])
    expect(proposalsRiding(store, harbor.episodes[0]!.id)).toEqual([])
    // A founding proposal rides nothing, so the show's queue is the only place it appears.
    expect(openProposals(store, harbor.showId).map((p) => p.id)).toEqual([riding.id, founding.id])
    expect(proposalsOfEntity(store, harbor.mara.id).map((p) => p.id)).toEqual([riding.id])
  })

  it('drops a proposal off the queue once it is ruled, and keeps it on its entity', () => {
    const harbor = seedHarbor()
    const proposal = coilPistol(harbor)
    createProposalRulings(store, events).reject(proposal.id, { note: 'no.' })

    expect(openProposals(store, harbor.showId)).toEqual([])
    // The history stays: "why Trent stays mortal" is read off the entity, not the queue.
    expect(proposalsOfEntity(store, harbor.mara.id).map((p) => p.disposition!.note)).toEqual(['no.'])
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { createEventLog, type EventLog } from '../events.ts'
import { appendWaypoint, createArc, positionsOf, type Arc, type ArcWaypoint } from './arc.ts'
import { amendEntity, registerEntity, type CanonEntity } from './canon.ts'
import { declareCategory, declareRelationType } from './category.ts'
import { canonAsOf, establishFact, factsInScope, findFact, recordRuling } from './fact.ts'
import {
  abandonEpisode,
  landPosition,
  landingOf,
  openLandingsOfArc,
  sweepEpisode,
} from './episode-canon.ts'
import { createProposalRulings, findProposal, openProposals, raiseProposal } from './proposal.ts'
import { relate } from './relation.ts'
import { createEpisode, createSeason, createShow, findEpisode, type Episode } from './spine.ts'

/**
 * The three flows that connect episode life to canon (E2-3), all of them RAISING and none
 * of them writing: the completion sweep, abandonment's reverts, and the waypoint landing.
 */

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

interface Harbor {
  showId: string
  episodes: Episode[]
  ilse: CanonEntity
  tobin: CanonEntity
  halvani: CanonEntity
  arc: Arc
  waypoints: ArcWaypoint[]
}

/** Grey Harbor cut to what these three flows need: two characters, one arc, six episodes. */
function seedHarbor(): Harbor {
  const showId = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
  const seasonId = createSeason(store, { showId, number: 1 }).id
  const episodes = [
    'The Long Pier',
    'Dry Stores',
    'Hull Frost',
    'The Empty Lane',
    'Spares',
    'Ledger Coat',
  ].map((title, index) => createEpisode(store, { seasonId, number: index + 1, title }))

  const character = declareCategory(store, { showId, key: 'character', name: 'Character' })
  declareCategory(store, { showId, key: 'species', name: 'Species' })
  declareRelationType(store, character.id, {
    name: 'species',
    targetCategory: 'species',
    cardinality: 'exactly-one',
    required: true,
    inverse: 'members',
    inheritsFacts: true,
  })

  const halvani = registerEntity(store, { showId, categoryKey: 'species', name: 'Halvani' })
  const ilse = registerEntity(store, { showId, categoryKey: 'character', name: 'Ilse Renn' })
  const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })
  for (const who of [ilse, tobin]) {
    relate(store, { fromEntityId: who.id, type: 'species', to: halvani.id })
    amendEntity(store, who.id, { status: 'active', standing: 'core' })
  }

  const arc = createArc(store, {
    showId,
    seasonId,
    scope: 'season',
    kind: 'story',
    name: 'What the harbor is for',
    statement: 'Whether the harbour is a job, an investment, or hers.',
  })
  const waypoints = [
    'The harbor is a job',
    'The harbor is worth spending on',
    'The harbor is hers',
  ].map((name) => appendWaypoint(store, arc.id, { name }))

  return { showId, episodes, ilse, tobin, halvani, arc, waypoints }
}

/** Three ratified facts whose lineage names one episode — what abandonment has to revert. */
function threeRatifiedFacts(harbor: Harbor, episode: Episode): string[] {
  return [
    'Ilse Renn keeps the pier ledger in her own hand.',
    'Ilse Renn was born on the station, not shipped to it.',
    'Ilse Renn will not take the relay housing apart while it is live.',
  ].map(
    (statement) =>
      establishFact(store, {
        entityId: harbor.ilse.id,
        statement,
        establishedIn: episode.id,
        ratifiedBy: recordRuling(store, 'ratification').seq,
      }).id,
  )
}

const statements = (facts: { statement: string }[]): string[] => facts.map((f) => f.statement)

// ── The completion sweep (1.2) ──────────────────────────────────────────────────

describe('the completion sweep', () => {
  it('collects every proposal still riding the episode, and rules none of them', () => {
    const harbor = seedHarbor()
    const ep06 = harbor.episodes[5]!

    const collar = raiseProposal(store, {
      entityId: harbor.ilse.id,
      kind: 'fact-delta',
      raisedBy: 'writer',
      episodeId: ep06.id,
      facts: [{ field: 'conduct', statement: 'Ilse Renn signs for the collars herself.' }],
    })
    const elsewhere = raiseProposal(store, {
      entityId: harbor.tobin.id,
      kind: 'fact-delta',
      raisedBy: 'writer',
      episodeId: harbor.episodes[0]!.id,
      facts: [{ statement: 'Tobin Wick has never been off the station.' }],
    })
    const { proposal: landing } = landPosition(store, {
      episodeId: ep06.id,
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[1]!.id,
      subject: harbor.ilse.id,
    })

    const sweep = sweepEpisode(store, ep06.id)

    expect(sweep.outstanding.map((p) => p.id)).toEqual([collar.id, landing.id])
    expect(sweep.ruled).toEqual([])
    expect(sweep.outstanding.map((p) => p.status)).toEqual(['raised', 'raised'])
    expect(sweep.sentence).toBe('ep06 carries 2 proposals to rule — 1 fact delta, 1 waypoint landing.')

    // Another episode's proposal is another episode's business.
    expect(sweep.outstanding.map((p) => p.id)).not.toContain(elsewhere.id)
  })

  it('leaves the dispositions behind once Ryan has ruled them, one at a time', () => {
    const harbor = seedHarbor()
    const ep06 = harbor.episodes[5]!
    const rulings = createProposalRulings(store, events)

    const kept = raiseProposal(store, {
      entityId: harbor.ilse.id,
      kind: 'fact-delta',
      raisedBy: 'writer',
      episodeId: ep06.id,
      facts: [{ statement: 'Ilse Renn signs for the collars herself.' }],
    })
    const cut = raiseProposal(store, {
      entityId: harbor.tobin.id,
      kind: 'fact-delta',
      raisedBy: 'writer',
      episodeId: ep06.id,
      facts: [{ statement: 'Tobin Wick holds against vacuum for a minute.' }],
    })

    rulings.ratify(kept.id, { note: 'yes — she has done it since ep01' })
    rulings.reject(cut.id, { note: 'no. That is the species fact, not his.' })

    const sweep = sweepEpisode(store, ep06.id)

    expect(sweep.outstanding).toEqual([])
    expect(sweep.ruled.map((p) => [p.id, p.status])).toEqual([
      [kept.id, 'ratified'],
      [cut.id, 'rejected'],
    ])
    expect(sweep.ruled[1]!.disposition!.note).toBe('no. That is the species fact, not his.')
    expect(sweep.sentence).toBe('ep06 carries nothing left to rule.')

    // Ratification is what wrote canon; the sweep only ever collected.
    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, 'now'))).toEqual([
      'Ilse Renn signs for the collars herself.',
    ])
  })

  it('does not sweep up a founding proposal, which rides nothing (D25)', () => {
    const harbor = seedHarbor()
    const passenger = registerEntity(store, {
      showId: harbor.showId,
      categoryKey: 'character',
      name: 'The Passenger',
    })
    const founding = raiseProposal(store, {
      entityId: passenger.id,
      kind: 'promotion',
      raisedBy: 'loader',
      standing: 'recurring',
      facts: [{ statement: 'The Passenger never gives a name.' }],
    })

    for (const episode of harbor.episodes) {
      expect(sweepEpisode(store, episode.id).outstanding).toEqual([])
    }
    expect(openProposals(store, harbor.showId).map((p) => p.id)).toEqual([founding.id])
  })
})

// ── Abandonment (3.3) ───────────────────────────────────────────────────────────

describe('abandoning an episode', () => {
  it('raises exactly one revert proposal per ratified fact it established, and rules none', () => {
    const harbor = seedHarbor()
    const ep03 = harbor.episodes[2]!
    const facts = threeRatifiedFacts(harbor, ep03)

    const abandonment = abandonEpisode(store, ep03.id, { note: 'the B-story never landed' })

    expect(abandonment.reverts).toHaveLength(3)
    expect(abandonment.reverts.map((p) => p.kind)).toEqual(['revert', 'revert', 'revert'])
    // A revert rides nothing: the episode it overturns is a corpse, and a proposal riding
    // one would put its claim back in front of the checks.
    expect(abandonment.reverts.map((p) => p.episodeId)).toEqual([null, null, null])
    expect(abandonment.reverts.map((p) => p.status)).toEqual(['raised', 'raised', 'raised'])
    expect(abandonment.reverts.map((p) => p.change.facts[0]!.supersedes)).toEqual(facts)
    expect(abandonment.sentence).toBe(
      'ep03 “Hull Frost” abandoned — 3 ratified facts to revert, one ruling at a time.',
    )

    // Nothing has been ruled. Canon is exactly where it was.
    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, 'now'))).toHaveLength(3)
  })

  it('is a column on the episode, never a lifecycle stage (the enum is untouched)', () => {
    const harbor = seedHarbor()
    const ep03 = harbor.episodes[2]!

    const before = findEpisode(store, ep03.id)!
    expect(before.abandonedAt).toBeNull()

    abandonEpisode(store, ep03.id, { note: 'the B-story never landed' })

    const after = findEpisode(store, ep03.id)!
    expect(after.abandonedAt).not.toBeNull()
    expect(after.lifecycle).toBe(before.lifecycle)
  })

  it('reverts one fact per ruling — present as of the ruling before, absent after', () => {
    const harbor = seedHarbor()
    const ep03 = harbor.episodes[2]!
    const facts = threeRatifiedFacts(harbor, ep03)
    const rulings = createProposalRulings(store, events)

    const abandonment = abandonEpisode(store, ep03.id, { note: 'the B-story never landed' })
    const ruled = rulings.ratify(abandonment.reverts[1]!.id, { note: 'yes — take it out' })
    const at = ruled.disposition!.seq

    // As of the ruling before, all three still stand. As of the revert, one is gone.
    expect(canonAsOf(store, { entityId: harbor.ilse.id }, { ruling: at - 1 })).toHaveLength(3)
    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, 'now'))).toEqual([
      'Ilse Renn keeps the pier ledger in her own hand.',
      'Ilse Renn will not take the relay housing apart while it is live.',
    ])

    // Closed with NO successor — that is what makes it a revert rather than a supersession.
    const reverted = findFact(store, facts[1]!)!
    expect(reverted.status).toBe('reverted')
    expect(reverted.closure!.supersededBy).toBeNull()
    expect(reverted.closure!.closedBy).toBe(at)

    // Surgical: the other two are still raised, waiting on their own rulings.
    expect(
      [abandonment.reverts[0]!, abandonment.reverts[2]!].map(
        (p) => findProposal(store, p.id)!.status,
      ),
    ).toEqual(['raised', 'raised'])
  })

  it('parks the proposals that were still riding, with the abandonment as the note', () => {
    const harbor = seedHarbor()
    const ep03 = harbor.episodes[2]!

    const riding = raiseProposal(store, {
      entityId: harbor.tobin.id,
      kind: 'fact-delta',
      raisedBy: 'writer',
      episodeId: ep03.id,
      facts: [{ statement: 'Tobin Wick sleeps in the pump house.' }],
    })
    expect(statements(factsInScope(store, harbor.tobin.id).inScope)).toContain(
      'Tobin Wick sleeps in the pump house.',
    )

    const abandonment = abandonEpisode(store, ep03.id, { note: 'the B-story never landed' })

    expect(abandonment.parked.map((p) => p.id)).toEqual([riding.id])
    expect(findProposal(store, riding.id)!.status).toBe('deferred')
    expect(findProposal(store, riding.id)!.disposition!.note).toMatch(
      /ep03 “Hull Frost” was abandoned/,
    )
    // The claim stops riding the corpse: no check sees it again.
    expect(statements(factsInScope(store, harbor.tobin.id).inScope)).not.toContain(
      'Tobin Wick sleeps in the pump house.',
    )
  })

  it('refuses a second abandonment, and refuses one with no reason', () => {
    const harbor = seedHarbor()
    const ep03 = harbor.episodes[2]!

    expect(() => abandonEpisode(store, ep03.id, { note: '  ' })).toThrow(/needs the reason/)

    abandonEpisode(store, ep03.id, { note: 'the B-story never landed' })
    expect(() => abandonEpisode(store, ep03.id, { note: 'again' })).toThrow(
      /was already abandoned/,
    )
  })

  it('reverts nothing when the episode never established canon — vanilla is not a failure', () => {
    const harbor = seedHarbor()
    const abandonment = abandonEpisode(store, harbor.episodes[3]!.id, { note: 'cut for time' })

    expect(abandonment.reverts).toEqual([])
    expect(abandonment.parked).toEqual([])
    expect(abandonment.sentence).toBe('ep04 “The Empty Lane” abandoned — it established no canon.')
  })
})

// ── The waypoint landing (D8) ───────────────────────────────────────────────────

describe('landing a waypoint', () => {
  it('declares the position and raises the landing proposal beside it', () => {
    const harbor = seedHarbor()
    const ep01 = harbor.episodes[0]!

    const landing = landPosition(store, {
      episodeId: ep01.id,
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[1]!.id,
      subject: harbor.ilse.id,
    })

    expect(landing.raised).toBe(true)
    expect(positionsOf(store, ep01.id).map((p) => p.waypoint.ordinal)).toEqual([2])
    expect(landing.proposal.kind).toBe('landing')
    expect(landing.proposal.episodeId).toBe(ep01.id)
    expect(landing.proposal.change.facts[0]!.statement).toBe(
      '“What the harbor is for” reached waypoint 2 “The harbor is worth spending on” in ep01.',
    )
    expect(landingOf(store, landing.proposal.id)).toEqual({
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[1]!.id,
    })
  })

  it('becomes a queryable fact only after ratification', () => {
    const harbor = seedHarbor()
    const ep01 = harbor.episodes[0]!
    const rulings = createProposalRulings(store, events)

    const landing = landPosition(store, {
      episodeId: ep01.id,
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[1]!.id,
      subject: harbor.ilse.id,
    })
    const statement = landing.proposal.change.facts[0]!.statement

    // Riding: visible to the checks, invisible to canon.
    expect(statements(factsInScope(store, harbor.ilse.id).inScope)).toContain(statement)
    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, 'now'))).not.toContain(
      statement,
    )

    const ruled = rulings.ratify(landing.proposal.id, { note: 'landed — the money scene does it' })
    const at = ruled.disposition!.seq

    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, 'now'))).toEqual([statement])
    expect(canonAsOf(store, { entityId: harbor.ilse.id }, { ruling: at - 1 })).toEqual([])

    // Lineage: the episode that landed it, which is what makes it answerable as-of.
    const fact = canonAsOf(store, { entityId: harbor.ilse.id }, 'now')[0]!
    expect(fact.establishedIn).toBe(ep01.id)
    expect(fact.ratifiedBy).toBe(at)
  })

  it('rides the episode, so the completion sweep collects it', () => {
    const harbor = seedHarbor()
    const ep01 = harbor.episodes[0]!

    const landing = landPosition(store, {
      episodeId: ep01.id,
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[0]!.id,
      subject: harbor.ilse.id,
    })

    expect(sweepEpisode(store, ep01.id).outstanding.map((p) => p.id)).toEqual([
      landing.proposal.id,
    ])
  })

  it('declaring the same waypoint again stands on the proposal it already raised', () => {
    const harbor = seedHarbor()
    const ep01 = harbor.episodes[0]!
    const where = {
      episodeId: ep01.id,
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[1]!.id,
      subject: harbor.ilse.id,
    }

    const first = landPosition(store, where)
    const again = landPosition(store, where)

    expect(again.raised).toBe(false)
    expect(again.proposal.id).toBe(first.proposal.id)
    expect(sweepEpisode(store, ep01.id).outstanding).toHaveLength(1)
  })

  it('declaring a different waypoint raises the landing for where it actually sits', () => {
    const harbor = seedHarbor()
    const ep01 = harbor.episodes[0]!

    const first = landPosition(store, {
      episodeId: ep01.id,
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[0]!.id,
      subject: harbor.ilse.id,
    })
    const moved = landPosition(store, {
      episodeId: ep01.id,
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[2]!.id,
      subject: harbor.ilse.id,
    })

    expect(moved.raised).toBe(true)
    expect(moved.proposal.id).not.toBe(first.proposal.id)
    expect(positionsOf(store, ep01.id).map((p) => p.waypoint.ordinal)).toEqual([3])
    // Both are Ryan's to rule: he sees what was claimed and what is claimed now.
    expect(sweepEpisode(store, ep01.id).outstanding).toHaveLength(2)
  })

  it('lists what is still unruled on the arc, and drops it once Ryan has ruled (D24)', () => {
    const harbor = seedHarbor()
    const rulings = createProposalRulings(store, events)

    const first = landPosition(store, {
      episodeId: harbor.episodes[0]!.id,
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[0]!.id,
      subject: harbor.ilse.id,
    })
    const second = landPosition(store, {
      episodeId: harbor.episodes[1]!.id,
      arcId: harbor.arc.id,
      waypointId: harbor.waypoints[1]!.id,
      subject: harbor.tobin.id,
    })

    expect(openLandingsOfArc(store, harbor.arc.id).map((p) => p.id)).toEqual([
      first.proposal.id,
      second.proposal.id,
    ])

    rulings.ratify(first.proposal.id, { note: 'landed' })

    expect(openLandingsOfArc(store, harbor.arc.id).map((p) => p.id)).toEqual([second.proposal.id])
  })

  it('refuses a waypoint that belongs to another arc', () => {
    const harbor = seedHarbor()
    const other = createArc(store, {
      showId: harbor.showId,
      scope: 'show',
      kind: 'character',
      name: 'Ilse ↔ Tobin · trust',
      statement: 'What it costs these two to believe each other.',
    })

    expect(() =>
      landPosition(store, {
        episodeId: harbor.episodes[0]!.id,
        arcId: other.id,
        waypointId: harbor.waypoints[0]!.id,
        subject: harbor.ilse.id,
      }),
    ).toThrow(/does not belong to arc/)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { entitiesOfShow, findEntity, registerEntity } from './canon.ts'
import { declareCategory, declareRelationType } from './category.ts'
import { canonAsOf, findRuling } from './fact.ts'
import { foundCanon } from './founding.ts'
import {
  openProposals,
  raiseProposal,
  type ProposalDraft,
  type ProposalOrigin,
  type RelationPartDraft,
} from './proposal.ts'
import { relationsFrom } from './relation.ts'
import { createEpisode, createSeason, createShow } from './spine.ts'

/**
 * Founding (D25): the stack of promotion proposals a loader or an import raised, ruled
 * through the one ruling API. Its whole job is to be an ordinary caller of
 * `createProposalRulings` — so what these tests hold it to is the two edges of that: it
 * rules everything founding raised, and it rules NOTHING else.
 */

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => {
  store.close()
})

interface Harbor {
  showId: string
  ilse: string
  halvani: string
  episodeId: string
}

/** A show at the moment a loader has walked it: categories declared, promotions raised. */
function loaded(): Harbor {
  const showId = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
  const season = createSeason(store, { showId, number: 1, title: 'Slack Water' })
  const episodeId = createEpisode(store, {
    seasonId: season.id,
    number: 1,
    title: 'The Long Pier',
  }).id

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

  const ilse = registerEntity(store, { showId, categoryKey: 'character', name: 'Ilse Renn' }).id
  const halvani = registerEntity(store, { showId, categoryKey: 'species', name: 'Halvani' }).id

  raiseProposal(store, sheet(halvani, { facts: ['A Halvani dies in vacuum inside two minutes.'] }))
  raiseProposal(
    store,
    sheet(ilse, {
      facts: ['Ilse has kept Grey Harbor for eleven years.'],
      relations: [{ op: 'add', type: 'species', to: halvani }],
    }),
  )

  return { showId, ilse, halvani, episodeId }
}

/** The promotion a sheet raises — what `promotionFromSheet` builds, cut to what is asserted. */
function sheet(
  entityId: string,
  parts: { facts: string[]; relations?: RelationPartDraft[]; raisedBy?: ProposalOrigin },
): ProposalDraft {
  return {
    entityId,
    kind: 'promotion',
    raisedBy: parts.raisedBy ?? 'loader',
    standing: 'core',
    body: 'The prose sheet that makes drafts good.',
    facts: parts.facts.map((statement) => ({ statement })),
    ...(parts.relations !== undefined && { relations: parts.relations }),
  }
}

describe('founding a show from the promotions its loader raised (D25)', () => {
  it('ratifies every one of them through the ruling API, and writes the sheets', () => {
    const harbor = loaded()

    const founding = foundCanon(store, harbor.showId)

    expect(founding.founded.map((p) => p.status)).toEqual(['ratified', 'ratified'])
    expect(entitiesOfShow(store, harbor.showId).map((e) => [e.name, e.status, e.standing])).toEqual([
      ['Ilse Renn', 'active', 'core'],
      ['Halvani', 'active', 'core'],
    ])
    expect(canonAsOf(store, { showId: harbor.showId }, 'now').map((f) => f.statement)).toEqual([
      'A Halvani dies in vacuum inside two minutes.',
      'Ilse has kept Grey Harbor for eleven years.',
    ])
    expect(relationsFrom(store, harbor.ilse).map((r) => [r.type.name, r.toEntityId])).toEqual([
      ['species', harbor.halvani],
    ])
    expect(founding.sentence).toMatch(/2 sheets ratified/)
  })

  /**
   * Founding lineage: a ratification with the proposal on it, no gate, and the note. A
   * founding fact was established in NO episode — it came off a sheet, before the show had
   * anything written against it — which is exactly why `fact.established_in` is nullable.
   */
  it('leaves founding lineage on every fact it writes', () => {
    const harbor = loaded()

    foundCanon(store, harbor.showId, { note: 'founded Grey Harbor from its sheets' })

    for (const fact of canonAsOf(store, { showId: harbor.showId }, 'now')) {
      expect(fact.establishedIn).toBeNull()
      const ruling = findRuling(store, fact.ratifiedBy!)!
      expect(ruling.kind).toBe('ratification')
      expect(ruling.gateId).toBeNull()
      expect(ruling.proposalId).not.toBeNull()
      expect(ruling.note).toBe('founded Grey Harbor from its sheets')
    }
  })

  /**
   * The refusal that keeps founding from becoming a bulk approve. A proposal a WRITER
   * raised is Ryan's to rule at a gate, and one riding an episode goes to that episode's
   * completion sweep — neither is a founding document, and founding must not touch either.
   */
  it('rules only what founding raised — never a writer’s proposal, never one that rides', () => {
    const harbor = loaded()
    const pitched = raiseProposal(
      store,
      sheet(harbor.ilse, { raisedBy: 'writer', facts: ['Ilse is afraid of the lane.'] }),
    )
    const riding = raiseProposal(store, {
      entityId: harbor.halvani,
      kind: 'fact-delta',
      raisedBy: 'writer',
      episodeId: harbor.episodeId,
      facts: [{ statement: 'Halvani run cold.' }],
    })

    const founding = foundCanon(store, harbor.showId)

    expect(founding.founded).toHaveLength(2)
    expect(founding.left.map((p) => p.id).sort()).toEqual([pitched.id, riding.id].sort())
    expect(openProposals(store, harbor.showId).map((p) => p.id).sort()).toEqual(
      [pitched.id, riding.id].sort(),
    )
  })

  it('is re-runnable: a second founding finds nothing left to rule', () => {
    const harbor = loaded()
    foundCanon(store, harbor.showId)

    const again = foundCanon(store, harbor.showId)

    expect(again.founded).toEqual([])
    expect(again.sentence).toMatch(/Nothing left to found/)
    expect(canonAsOf(store, { showId: harbor.showId }, 'now')).toHaveLength(2)
  })

  /**
   * One incomplete sheet stops the whole founding rather than leaving half a show ratified
   * (D22, enforced in `writeCanon`). Founding is one act — a stack of sheets read off one
   * disk — and the honest answer to a sheet nobody finished is to fix the sheet and found
   * again, not to guess which half of a show is canon.
   */
  it('founds nothing at all when one sheet cannot become canon', () => {
    const harbor = loaded()
    const unfinished = registerEntity(store, {
      showId: harbor.showId,
      categoryKey: 'character',
      name: 'Tobin Wick',
    })
    raiseProposal(store, sheet(unfinished.id, { facts: ['Tobin rigs the piers.'] }))

    expect(() => foundCanon(store, harbor.showId)).toThrow(
      /“Tobin Wick” cannot become canon without a `species`/,
    )
    expect(canonAsOf(store, { showId: harbor.showId }, 'now')).toEqual([])
    expect(findEntity(store, { showId: harbor.showId, categoryKey: 'character', name: 'Ilse Renn' }))
      .toMatchObject({ status: 'candidate' })
    expect(openProposals(store, harbor.showId)).toHaveLength(3)
  })
})

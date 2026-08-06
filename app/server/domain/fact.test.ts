import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { registerEntity, type CanonEntity } from './canon.ts'
import { declareCategory, declareRelationType } from './category.ts'
import {
  canonAsOf,
  closeFact,
  establishFact,
  factsInScope,
  factsOfEntity,
  findFact,
  recordRuling,
  rulingAsOfDate,
  supersedeFact,
  type CanonRuling,
} from './fact.ts'
import { relate, UNKNOWN_TARGET } from './relation.ts'
import { createEpisode, createSeason, createShow, type Episode } from './spine.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => {
  store.close()
})

/**
 * Grey Harbor, cut to what a fact needs: two categories, the one declaration that carries
 * facts, two Halvani and a character whose species is genuinely undecided (D22), and five
 * episodes to establish things in.
 */
interface Harbor {
  showId: string
  ilse: CanonEntity
  tobin: CanonEntity
  passenger: CanonEntity
  halvani: CanonEntity
  episodes: Episode[]
}

function seedHarbor(): Harbor {
  const showId = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
  const seasonId = createSeason(store, { showId, number: 1 }).id
  const episodes = ['The Long Pier', 'Duty Time', 'Hull Frost', 'The Empty Lane', 'Spares'].map(
    (title, index) => createEpisode(store, { seasonId, number: index + 1, title }),
  )

  const character = declareCategory(store, { showId, key: 'character', name: 'Character' })
  declareCategory(store, { showId, key: 'species', name: 'Species' })
  declareCategory(store, { showId, key: 'location', name: 'Location' })

  declareRelationType(store, character.id, {
    name: 'species',
    targetCategory: 'species',
    cardinality: 'exactly-one',
    required: true,
    inverse: 'members',
    inheritsFacts: true,
  })
  // Declared, and facts deliberately do NOT travel it: a dockworker does not inherit the
  // harbour's facts by standing in it. The default, written out here so a test proves it.
  declareRelationType(store, character.id, {
    name: 'stationed-at',
    targetCategory: 'location',
    cardinality: 'at-most-one',
    required: false,
    inverse: 'crew',
  })

  const entity = (categoryKey: string, name: string): CanonEntity =>
    registerEntity(store, { showId, categoryKey, name })

  const halvani = entity('species', 'Halvani')
  const ilse = entity('character', 'Ilse Renn')
  const tobin = entity('character', 'Tobin Wick')
  const passenger = entity('character', 'The Passenger')

  relate(store, { fromEntityId: ilse.id, type: 'species', to: halvani.id })
  relate(store, { fromEntityId: tobin.id, type: 'species', to: halvani.id })
  relate(store, { fromEntityId: passenger.id, type: 'species', to: UNKNOWN_TARGET })

  return { showId, ilse, tobin, passenger, halvani, episodes }
}

/** A gate reached, a proposal ruled. E2-2 convenes this; here a test does. */
function ratify(): CanonRuling {
  return recordRuling(store, 'ratification')
}

const statements = (facts: { statement: string }[]): string[] => facts.map((f) => f.statement)

// ── The done conditions ─────────────────────────────────────────────────────────

describe('a fact ratified in ep02 and superseded in ep05 (D9)', () => {
  function beaconThroughTwoEpisodes(): {
    harbor: Harbor
    ep02: CanonRuling
    ep03: CanonRuling
    ep05: CanonRuling
  } {
    const harbor = seedHarbor()

    const ep02 = ratify()
    const lit = establishFact(store, {
      entityId: harbor.ilse.id,
      field: 'conduct',
      statement: 'Ilse lights the Long Pier beacon every night.',
      establishedIn: harbor.episodes[1]!.id,
      ratifiedBy: ep02.seq,
    })

    // A ruling in between that touches nothing, so "as of ep03" is a real point on the
    // clock rather than a synonym for "before the change".
    const ep03 = ratify()

    const ep05 = ratify()
    supersedeFact(store, {
      factId: lit.id,
      ruling: ep05.seq,
      note: 'ep05 has her hand the watch over',
      successor: {
        entityId: harbor.ilse.id,
        field: 'conduct',
        statement: 'Ilse has handed the beacon watch to the harbour crew.',
        establishedIn: harbor.episodes[4]!.id,
      },
    })

    return { harbor, ep02, ep03, ep05 }
  }

  it('reads its old value as of ep03 and its new value as of now', () => {
    const { harbor, ep03 } = beaconThroughTwoEpisodes()

    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, { ruling: ep03.seq }))).toEqual([
      'Ilse lights the Long Pier beacon every night.',
    ])
    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, 'now'))).toEqual([
      'Ilse has handed the beacon watch to the harbour crew.',
    ])
  })

  it('hands over at the ruling itself — the range is half-open', () => {
    const { harbor, ep02, ep05 } = beaconThroughTwoEpisodes()

    // As of the ruling that made it: in. As of the ruling that replaced it: out, and the
    // successor is already in. "As of R" means after R was ruled.
    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, { ruling: ep02.seq }))).toEqual([
      'Ilse lights the Long Pier beacon every night.',
    ])
    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, { ruling: ep05.seq }))).toEqual([
      'Ilse has handed the beacon watch to the harbour crew.',
    ])
  })

  it('keeps both, with the lineage of the end as well as the start', () => {
    const { harbor, ep05 } = beaconThroughTwoEpisodes()

    const history = factsOfEntity(store, harbor.ilse.id)
    expect(history.map((fact) => fact.status)).toEqual(['superseded', 'ratified'])
    expect(history[0]!.closure).toMatchObject({
      closedBy: ep05.seq,
      supersededBy: history[1]!.id,
      note: 'ep05 has her hand the watch over',
    })
    expect(history[0]!.establishedIn).toEqual(harbor.episodes[1]!.id)
    expect(history[1]!.establishedIn).toEqual(harbor.episodes[4]!.id)
  })
})

describe('a reverted fact (3.3)', () => {
  it('is absent as of after the revert and present as of before it', () => {
    const harbor = seedHarbor()

    const ratified = ratify()
    const fact = establishFact(store, {
      entityId: harbor.tobin.id,
      statement: 'Tobin filed a diversion against the spares ledger.',
      establishedIn: harbor.episodes[3]!.id,
      ratifiedBy: ratified.seq,
    })

    const revert = recordRuling(store, 'revert')
    closeFact(store, { factId: fact.id, ruling: revert.seq, note: 'ep04 was abandoned' })

    expect(statements(canonAsOf(store, { entityId: harbor.tobin.id }, { ruling: ratified.seq }))).toEqual([
      'Tobin filed a diversion against the spares ledger.',
    ])
    expect(canonAsOf(store, { entityId: harbor.tobin.id }, { ruling: revert.seq })).toEqual([])
    expect(canonAsOf(store, { entityId: harbor.tobin.id }, 'now')).toEqual([])

    // Gone from canon, not gone. The revert is a ruling with a record, and the row it
    // closed still says what it said and who ended it.
    const reverted = findFact(store, fact.id)!
    expect(reverted.status).toEqual('reverted')
    expect(reverted.closure).toMatchObject({ closedBy: revert.seq, supersededBy: null })
  })
})

describe('editing a species fact (D22)', () => {
  it('reaches every member except the character whose exception overrides it', () => {
    const harbor = seedHarbor()
    const founding = ratify()

    const vacuum = establishFact(store, {
      entityId: harbor.halvani.id,
      field: 'physiology',
      statement: 'A Halvani in unprotected vacuum loses consciousness in about nine seconds.',
      ratifiedBy: founding.seq,
    })
    establishFact(store, {
      entityId: harbor.halvani.id,
      field: 'physiology',
      statement: 'Halvani hear a pressure change before a gauge shows it.',
      ratifiedBy: founding.seq,
    })

    // Tobin is the exception: a fact on HIM that names what it displaces.
    const exception = ratify()
    establishFact(store, {
      entityId: harbor.tobin.id,
      field: 'physiology',
      statement: 'Tobin holds against vacuum for a full minute — the graft in his chest.',
      establishedIn: harbor.episodes[2]!.id,
      ratifiedBy: exception.seq,
      overrides: vacuum.id,
    })

    const ilse = factsInScope(store, harbor.ilse.id)
    expect(statements(ilse.inScope)).toEqual([
      'A Halvani in unprotected vacuum loses consciousness in about nine seconds.',
      'Halvani hear a pressure change before a gauge shows it.',
    ])

    const tobin = factsInScope(store, harbor.tobin.id)
    expect(statements(tobin.inScope)).toEqual([
      'Tobin holds against vacuum for a full minute — the graft in his chest.',
      'Halvani hear a pressure change before a gauge shows it.',
    ])
    expect(tobin.overrides).toHaveLength(1)
    expect(tobin.overrides[0]!.overridden.id).toEqual(vacuum.id)
    expect(tobin.overrides[0]!.displaces!.id).toEqual(vacuum.id)
    expect(tobin.overrides[0]!.stale).toBe(false)

    // And the edit itself: change the species fact and Ilse moves with it. Tobin does not,
    // because an exception displaces the LINEAGE, not the row — otherwise his scope would
    // now hold both "Tobin holds for a minute" and a Halvani fact saying he does not.
    const edit = ratify()
    const { successor } = supersedeFact(store, {
      factId: vacuum.id,
      ruling: edit.seq,
      successor: {
        entityId: harbor.halvani.id,
        field: 'physiology',
        statement: 'A Halvani in unprotected vacuum loses consciousness in about six seconds.',
      },
    })

    expect(statements(factsInScope(store, harbor.ilse.id).inScope)).toContain(
      'A Halvani in unprotected vacuum loses consciousness in about six seconds.',
    )
    const after = factsInScope(store, harbor.tobin.id)
    expect(statements(after.inScope)).not.toContain(
      'A Halvani in unprotected vacuum loses consciousness in about six seconds.',
    )
    // Carried forward, and visibly so: the exception still names the row it was written
    // against, displaces the one that replaced it, and says the ground moved.
    expect(after.overrides[0]!.overridden.id).toEqual(vacuum.id)
    expect(after.overrides[0]!.displaces!.id).toEqual(successor.id)
    expect(after.overrides[0]!.stale).toBe(true)
  })

  it('leaves an exception whose fact was reverted displacing nothing, visibly', () => {
    const harbor = seedHarbor()
    const founding = ratify()
    const vacuum = establishFact(store, {
      entityId: harbor.halvani.id,
      statement: 'A Halvani in unprotected vacuum loses consciousness in about nine seconds.',
      ratifiedBy: founding.seq,
    })
    const exception = ratify()
    establishFact(store, {
      entityId: harbor.tobin.id,
      statement: 'Tobin holds against vacuum for a full minute.',
      ratifiedBy: exception.seq,
      overrides: vacuum.id,
    })

    const revert = recordRuling(store, 'revert')
    closeFact(store, { factId: vacuum.id, ruling: revert.seq })

    // A revert ends the line — there is no successor to carry the exception onto, so it
    // displaces nothing and says so. Nothing here invents a replacement; that is a ruling.
    const tobin = factsInScope(store, harbor.tobin.id)
    expect(tobin.overrides[0]!.displaces).toBeNull()
    expect(tobin.overrides[0]!.stale).toBe(true)
    expect(statements(tobin.inScope)).toEqual(['Tobin holds against vacuum for a full minute.'])
  })
})

describe('the database, not the discipline', () => {
  it('refuses a direct UPDATE of a fact’s statement', () => {
    const harbor = seedHarbor()
    const fact = establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse has held the harbourmaster’s post for eleven years.',
      ratifiedBy: ratify().seq,
    })

    expect(() =>
      store.run('UPDATE fact SET statement = ? WHERE id = ?', 'Twelve years.', fact.id),
    ).toThrow(/a fact is immutable/)
    expect(() => store.run('UPDATE fact SET ratified_by = NULL WHERE id = ?', fact.id)).toThrow(
      /a fact is immutable/,
    )
    expect(() => store.run('DELETE FROM fact WHERE id = ?', fact.id)).toThrow(
      /a fact is never deleted/,
    )
    expect(findFact(store, fact.id)!.statement).toEqual(
      'Ilse has held the harbourmaster’s post for eleven years.',
    )
  })

  it('refuses to edit or erase a closure, or to close a fact twice', () => {
    const harbor = seedHarbor()
    const fact = establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse posts the duty roster on Sunday.',
      ratifiedBy: ratify().seq,
    })
    const revert = recordRuling(store, 'revert')
    closeFact(store, { factId: fact.id, ruling: revert.seq })

    expect(() => store.run('UPDATE fact_closure SET note = ? WHERE fact_id = ?', 'x', fact.id)).toThrow(
      /a closure is a ruling's record/,
    )
    expect(() => store.run('DELETE FROM fact_closure WHERE fact_id = ?', fact.id)).toThrow(
      /a closure is a ruling's record/,
    )
    expect(() =>
      closeFact(store, { factId: fact.id, ruling: recordRuling(store, 'revert').seq }),
    ).toThrow(/closes once, one way/)
  })

  it('refuses to edit or erase a ruling', () => {
    const ruling = ratify()

    expect(() => store.run('UPDATE canon_ruling SET kind = ? WHERE seq = ?', 'revert', ruling.seq)).toThrow(
      /a ruling is history/,
    )
    expect(() => store.run('DELETE FROM canon_ruling WHERE seq = ?', ruling.seq)).toThrow(
      /a ruling is history/,
    )
  })
})

// ── Time, and the two ways of naming a moment ───────────────────────────────────

describe('as of a date (D9)', () => {
  it('maps the date onto the ruling clock and reads by ruling', () => {
    const harbor = seedHarbor()

    // Rulings written by hand, because a test cannot make the wall clock move and a fact
    // must never be ordered by one anyway (E1-5). The seq is the truth; `at` is the label.
    store.run("INSERT INTO canon_ruling (kind, at) VALUES ('ratification', '2026-07-02T09:00:00.000Z')")
    const july2 = store.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM canon_ruling')!.seq
    store.run("INSERT INTO canon_ruling (kind, at) VALUES ('ratification', '2026-07-18T09:00:00.000Z')")
    const july18 = store.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM canon_ruling')!.seq

    const first = establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse quotes the harbour power budget instead of giving reasons.',
      ratifiedBy: july2,
    })
    supersedeFact(store, {
      factId: first.id,
      ruling: july18,
      successor: {
        entityId: harbor.ilse.id,
        statement: 'Ilse quotes the harbour power budget, and now explains it once.',
      },
    })

    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, { date: '2026-07-10' }))).toEqual([
      'Ilse quotes the harbour power budget instead of giving reasons.',
    ])
    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, { date: '2026-08-01' }))).toEqual([
      'Ilse quotes the harbour power budget, and now explains it once.',
    ])
    expect(rulingAsOfDate(store, '2026-07-10')!.seq).toEqual(july2)
  })

  it('reads empty before the first ruling — canon had not started', () => {
    const harbor = seedHarbor()
    establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse knows the harbour to the watt.',
      ratifiedBy: ratify().seq,
    })

    expect(rulingAsOfDate(store, '2020-01-01')).toBeUndefined()
    expect(canonAsOf(store, { showId: harbor.showId }, { date: '2020-01-01' })).toEqual([])
  })
})

describe('canon for a whole show', () => {
  it('reads every entity’s valid facts, ordered by the entity they belong to', () => {
    const harbor = seedHarbor()
    const founding = ratify()
    for (const [entity, statement] of [
      [harbor.ilse, 'Ilse posts the duty roster on Sunday.'],
      [harbor.halvani, 'A Halvani body needs pressure and does not negotiate.'],
      [harbor.tobin, 'Tobin knows hull-frost by sound.'],
    ] as const) {
      establishFact(store, { entityId: entity.id, statement, ratifiedBy: founding.seq })
    }

    expect(statements(canonAsOf(store, { showId: harbor.showId }, 'now'))).toEqual([
      'A Halvani body needs pressure and does not negotiate.',
      'Ilse posts the duty roster on Sunday.',
      'Tobin knows hull-frost by sound.',
    ])

    // Another show's canon is another show's. Scoping is not a convenience here.
    const other = createShow(store, { key: 'deadlight', title: 'Dead Light' }).id
    expect(canonAsOf(store, { showId: other }, 'now')).toEqual([])
  })
})

describe('a provisional fact (3.3)', () => {
  it('rides its episode and is visible to checks, and is not canon', () => {
    const harbor = seedHarbor()
    const provisional = establishFact(store, {
      entityId: harbor.ilse.id,
      field: 'manner',
      statement: 'Ilse keeps the roster board unlocked after the lane went quiet.',
      establishedIn: harbor.episodes[4]!.id,
    })

    expect(provisional.status).toEqual('provisional')
    expect(canonAsOf(store, { entityId: harbor.ilse.id }, 'now')).toEqual([])
    expect(statements(factsInScope(store, harbor.ilse.id).inScope)).toEqual([
      'Ilse keeps the roster board unlocked after the lane went quiet.',
    ])
  })

  it('becomes canon by supersession — the claim closes, the ruled fact opens', () => {
    const harbor = seedHarbor()
    const provisional = establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse keeps the roster board unlocked.',
      establishedIn: harbor.episodes[4]!.id,
    })

    const gate = ratify()
    const { closed, successor } = supersedeFact(store, {
      factId: provisional.id,
      ruling: gate.seq,
      note: 'ratified at the ep05 script gate',
      successor: {
        entityId: harbor.ilse.id,
        statement: 'Ilse keeps the roster board unlocked.',
        establishedIn: harbor.episodes[4]!.id,
      },
    })

    expect(closed.status).toEqual('superseded')
    expect(closed.closure!.supersededBy).toEqual(successor.id)
    expect(successor.ratifiedBy).toEqual(gate.seq)
    expect(statements(canonAsOf(store, { entityId: harbor.ilse.id }, 'now'))).toEqual([
      'Ilse keeps the roster board unlocked.',
    ])
    // One statement standing, two rows kept: somebody proposed it, and then Ryan ruled.
    expect(factsOfEntity(store, harbor.ilse.id)).toHaveLength(2)
  })
})

// ── Three kinds of nothing (invariant 4) ────────────────────────────────────────

describe('the scope helper never collapses three kinds of nothing', () => {
  it('tells a declared-unknown species apart from an unfinished sheet', () => {
    const harbor = seedHarbor()
    const orphan = registerEntity(store, {
      showId: harbor.showId,
      categoryKey: 'character',
      name: 'Old Sette',
    })

    // Declared unknown: somebody looked, and the world has not decided (D22).
    const passenger = factsInScope(store, harbor.passenger.id)
    expect(passenger.inheritance).toHaveLength(1)
    expect(passenger.inheritance[0]!.case).toEqual('declared-unknown')
    expect(passenger.inheritance[0]!.source).toBeNull()

    // No edge at all: a sheet somebody did not finish.
    const sette = factsInScope(store, orphan.id)
    expect(sette.inheritance[0]!.case).toEqual('undeclared')
    expect(sette.inheritance[0]!.type.name).toEqual('species')
  })

  it('tells a species with no facts yet apart from both', () => {
    const harbor = seedHarbor()

    const ilse = factsInScope(store, harbor.ilse.id)
    expect(ilse.inheritance[0]!.case).toEqual('source-has-no-facts')
    expect(ilse.inheritance[0]!.source!.id).toEqual(harbor.halvani.id)

    establishFact(store, {
      entityId: harbor.halvani.id,
      statement: 'A Halvani body needs pressure.',
      ratifiedBy: ratify().seq,
    })
    expect(factsInScope(store, harbor.ilse.id).inheritance[0]!.case).toEqual('inherited')
  })

  it('reports no inheritance at all for a category that declares no fact-carrying edge', () => {
    const harbor = seedHarbor()
    const pier = registerEntity(store, {
      showId: harbor.showId,
      categoryKey: 'location',
      name: 'The Long Pier',
    })

    // Not a gap: the location category declares nothing that carries facts, so there is no
    // case to report. `stationed-at` is declared and carries none either — hence one edge
    // in the character's list, not two.
    expect(factsInScope(store, pier.id).inheritance).toEqual([])
    expect(factsInScope(store, harbor.ilse.id).inheritance.map((edge) => edge.type.name)).toEqual([
      'species',
    ])
  })

  it('inherits one way only — a species takes nothing back from its members', () => {
    const harbor = seedHarbor()
    const founding = ratify()
    establishFact(store, {
      entityId: harbor.halvani.id,
      statement: 'A Halvani body needs pressure.',
      ratifiedBy: founding.seq,
    })
    establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse posts the duty roster on Sunday.',
      ratifiedBy: founding.seq,
    })

    const halvani = factsInScope(store, harbor.halvani.id)
    expect(halvani.inheritance).toEqual([])
    expect(statements(halvani.inScope)).toEqual(['A Halvani body needs pressure.'])

    // And nothing crosses between two members of one species.
    expect(statements(factsInScope(store, harbor.tobin.id).inScope)).toEqual([
      'A Halvani body needs pressure.',
    ])
  })
})

// ── The refusals ────────────────────────────────────────────────────────────────

describe('what a single write can answer for itself', () => {
  it('refuses an override of a fact the entity does not inherit', () => {
    const harbor = seedHarbor()
    const founding = ratify()
    const own = establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse posts the duty roster on Sunday.',
      ratifiedBy: founding.seq,
    })
    const strangers = establishFact(store, {
      entityId: harbor.passenger.id,
      statement: 'The Passenger travels without papers.',
      ratifiedBy: founding.seq,
    })

    expect(() =>
      establishFact(store, {
        entityId: harbor.ilse.id,
        statement: 'Ilse posts it on Saturday now.',
        ratifiedBy: founding.seq,
        overrides: own.id,
      }),
    ).toThrow(/cannot override its own fact/)

    expect(() =>
      establishFact(store, {
        entityId: harbor.ilse.id,
        statement: 'Ilse travels with papers.',
        ratifiedBy: founding.seq,
        overrides: strangers.id,
      }),
    ).toThrow(/inherits nothing from “The Passenger”/)
  })

  it('refuses to open a fact under a ruling that is not a ratification', () => {
    const harbor = seedHarbor()
    const revert = recordRuling(store, 'revert')

    expect(() =>
      establishFact(store, {
        entityId: harbor.ilse.id,
        statement: 'Ilse never lit the beacon.',
        ratifiedBy: revert.seq,
      }),
    ).toThrow(/only a ratification opens a fact/)
  })

  it('refuses a supersession that tries to open its successor under a second ruling', () => {
    const harbor = seedHarbor()
    const first = ratify()
    const fact = establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse lights the beacon.',
      ratifiedBy: first.seq,
    })
    const second = ratify()

    expect(() =>
      supersedeFact(store, {
        factId: fact.id,
        ruling: second.seq,
        successor: {
          entityId: harbor.ilse.id,
          statement: 'Ilse lights the beacon at dusk.',
          ratifiedBy: first.seq,
        },
      }),
    ).toThrow(/Two rulings are two proposals/)
  })

  it('refuses a fact on nothing, a blank statement, and a ruling that does not exist', () => {
    const harbor = seedHarbor()

    expect(() =>
      establishFact(store, { entityId: 'ent_nope', statement: 'Something.' }),
    ).toThrow(/No such canon entity/)
    expect(() =>
      establishFact(store, { entityId: harbor.ilse.id, statement: '', ratifiedBy: ratify().seq }),
    ).toThrow(/CHECK/i)
    expect(() =>
      establishFact(store, { entityId: harbor.ilse.id, statement: 'Something.', ratifiedBy: 999 }),
    ).toThrow(/No such ruling/)
  })

  it('rolls a failed supersession back whole — the predecessor stays open', () => {
    const harbor = seedHarbor()
    const first = ratify()
    const fact = establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse lights the beacon.',
      ratifiedBy: first.seq,
    })

    expect(() =>
      supersedeFact(store, {
        factId: fact.id,
        ruling: ratify().seq,
        successor: { entityId: harbor.ilse.id, statement: '' },
      }),
    ).toThrow(/CHECK/i)

    expect(findFact(store, fact.id)!.closure).toBeNull()
    expect(factsOfEntity(store, harbor.ilse.id)).toHaveLength(1)
  })
})

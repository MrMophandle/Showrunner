import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { registerEntity, type CanonEntity } from './canon.ts'
import { declareCategory, declareRelationType, findCategory } from './category.ts'
import {
  declaredUnknowns,
  relate,
  relatedBy,
  relationsFrom,
  relationsTo,
  unrelate,
  UNKNOWN_TARGET,
} from './relation.ts'
import { createShow } from './spine.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => {
  store.close()
})

/**
 * Grey Harbor's shape, cut to what an edge needs: the three categories the character sheet
 * points at, the three declarations it makes, and the entities from the fixture.
 */
function seedHarbor(): {
  showId: string
  tobin: CanonEntity
  ilse: CanonEntity
  halvani: CanonEntity
  station: CanonEntity
  collar: CanonEntity
} {
  const showId = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
  const character = declareCategory(store, { showId, key: 'character', name: 'Character' })
  declareCategory(store, { showId, key: 'species', name: 'Species' })
  declareCategory(store, { showId, key: 'location', name: 'Location' })
  declareCategory(store, { showId, key: 'technology', name: 'Technology' })

  declareRelationType(store, character.id, {
    name: 'species',
    targetCategory: 'species',
    cardinality: 'exactly-one',
    required: true,
    inverse: 'members',
  })
  declareRelationType(store, character.id, {
    name: 'stationed-at',
    targetCategory: 'location',
    cardinality: 'at-most-one',
    required: false,
    inverse: 'crew',
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

  return {
    showId,
    tobin: entity('character', 'Tobin Wick'),
    ilse: entity('character', 'Ilse Renn'),
    halvani: entity('species', 'Halvani'),
    station: entity('location', 'Grey Harbor Station'),
    collar: entity('technology', 'Kestrel-pattern containment collar'),
  }
}

describe('writing an edge', () => {
  it('writes it under the declaration it matches', () => {
    const { tobin, halvani } = seedHarbor()

    const relation = relate(store, { fromEntityId: tobin.id, type: 'species', to: halvani.id })

    expect(relation).toMatchObject({
      fromEntityId: tobin.id,
      toEntityId: halvani.id,
      type: expect.objectContaining({ name: 'species', inverse: 'members' }),
    })
    expect(relationsFrom(store, tobin.id)).toEqual([relation])
  })

  it('refuses a relation type the category never declared — at the domain, not only at read.ts', () => {
    const { tobin, collar } = seedHarbor()

    // `keeps` is the free verb from the mockup that produced D23. read.ts refuses it on a
    // sheet; this is the store refusing it for anything that never came from a sheet at
    // all — an agent's proposal, an import, a hand-typed call.
    expect(() => relate(store, { fromEntityId: tobin.id, type: 'keeps', to: collar.id })).toThrow(
      /`keeps` is not a relation type the character category declares/,
    )
    expect(relationsFrom(store, tobin.id)).toEqual([])
  })

  it('refuses a target of the wrong category', () => {
    const { tobin, station } = seedHarbor()

    expect(() => relate(store, { fromEntityId: tobin.id, type: 'species', to: station.id })).toThrow(
      /`species` must point at a species, and “Grey Harbor Station” is a location/,
    )
  })

  it('refuses a second species where the category declares exactly-one', () => {
    const { tobin, halvani, showId } = seedHarbor()
    const other = registerEntity(store, { showId, categoryKey: 'species', name: 'Vessene' })
    relate(store, { fromEntityId: tobin.id, type: 'species', to: halvani.id })

    expect(() => relate(store, { fromEntityId: tobin.id, type: 'species', to: other.id })).toThrow(
      /already declares a `species`.*exactly-one/s,
    )
    expect(relationsFrom(store, tobin.id)).toHaveLength(1)
  })

  it('lets `any` be declared as often as the sheet likes', () => {
    const { tobin, collar, showId } = seedHarbor()
    const suit = registerEntity(store, { showId, categoryKey: 'technology', name: 'Pier suit' })

    relate(store, { fromEntityId: tobin.id, type: 'carries', to: collar.id })
    relate(store, { fromEntityId: tobin.id, type: 'carries', to: suit.id })

    expect(relationsFrom(store, tobin.id)).toHaveLength(2)
  })

  it('refuses the same edge twice', () => {
    const { tobin, collar } = seedHarbor()
    relate(store, { fromEntityId: tobin.id, type: 'carries', to: collar.id })

    expect(() => relate(store, { fromEntityId: tobin.id, type: 'carries', to: collar.id })).toThrow(
      /already declares `carries` → “Kestrel-pattern containment collar”/,
    )
  })

  it('refuses an entity pointing at itself', () => {
    const { showId } = seedHarbor()
    const location = findCategory(store, showId, 'location')!
    declareRelationType(store, location.id, {
      name: 'part-of',
      targetCategory: 'location',
      cardinality: 'at-most-one',
      required: false,
      inverse: 'contains',
    })
    const pier = registerEntity(store, { showId, categoryKey: 'location', name: 'The Long Pier' })

    expect(() => relate(store, { fromEntityId: pier.id, type: 'part-of', to: pier.id })).toThrow(
      /CHECK constraint failed/,
    )
  })

  it('refuses an edge across two shows', () => {
    const { tobin } = seedHarbor()
    const other = createShow(store, { key: 'deadlight', title: 'Dead Light' }).id
    const stranger = registerEntity(store, { showId: other, categoryKey: 'species', name: 'Halvani' })

    expect(() => relate(store, { fromEntityId: tobin.id, type: 'species', to: stranger.id })).toThrow(
      /belongs to another show/,
    )
  })
})

describe('traversing (D23)', () => {
  it('reaches the members of a species from the species end, by the inverse name', () => {
    const { tobin, ilse, halvani } = seedHarbor()
    relate(store, { fromEntityId: tobin.id, type: 'species', to: halvani.id })
    relate(store, { fromEntityId: ilse.id, type: 'species', to: halvani.id })

    const members = relatedBy(store, halvani.id, 'members')

    expect(members.map((m) => m.entity?.name)).toEqual(['Ilse Renn', 'Tobin Wick'])
    expect(members[0]).toMatchObject({ name: 'members', direction: 'inverse' })
    // Nothing declares `members`; it is navigable only because the character category
    // named it as the inverse of `species`.
    expect(members[0]!.type.name).toBe('species')
  })

  it('reaches the species from the character end, by the declared name', () => {
    const { tobin, halvani } = seedHarbor()
    relate(store, { fromEntityId: tobin.id, type: 'species', to: halvani.id })

    expect(relatedBy(store, tobin.id, 'species')).toEqual([
      expect.objectContaining({ name: 'species', direction: 'declared' }),
    ])
    expect(relatedBy(store, tobin.id, 'species')[0]!.entity?.name).toBe('Halvani')
  })

  it('refuses a name neither end declares, rather than answering with nothing', () => {
    const { halvani } = seedHarbor()

    expect(() => relatedBy(store, halvani.id, 'keeps')).toThrow(
      /`keeps` is neither a relation type the species category declares nor an inverse/,
    )
  })

  it('lists what points at an entity, under the name it is navigable by', () => {
    const { tobin, station } = seedHarbor()
    relate(store, { fromEntityId: tobin.id, type: 'stationed-at', to: station.id })

    expect(relationsTo(store, station.id)).toEqual([
      expect.objectContaining({
        fromEntityId: tobin.id,
        toEntityId: station.id,
        type: expect.objectContaining({ name: 'stationed-at', inverse: 'crew' }),
      }),
    ])
  })
})

/**
 * D22's `unknown`, which is the reason `relation.to_entity_id` is nullable. The rule being
 * tested is that "nobody has said" and "somebody said it is not decided" are different
 * states, distinguishable by anything that looks.
 */
describe('a species declared unknown (D22)', () => {
  it('writes an edge with no target, and counts against exactly-one like any other', () => {
    const { tobin, halvani } = seedHarbor()

    const declared = relate(store, { fromEntityId: tobin.id, type: 'species', to: UNKNOWN_TARGET })

    expect(declared.toEntityId).toBeNull()
    expect(relatedBy(store, tobin.id, 'species')).toEqual([
      expect.objectContaining({ name: 'species', direction: 'declared', entity: null }),
    ])
    // It occupies the slot: resolving it later is a replacement, not a second declaration,
    // which is what makes ratifying "the Passenger is Halvani" a change with a before.
    expect(() => relate(store, { fromEntityId: tobin.id, type: 'species', to: halvani.id })).toThrow(
      /already declares a `species`/,
    )
  })

  it('is not the same as a sheet nobody finished', () => {
    const { tobin, ilse, showId } = seedHarbor()
    relate(store, { fromEntityId: tobin.id, type: 'species', to: UNKNOWN_TARGET })

    // Tobin declared it unknown. Ilse's sheet just has nothing on it. The canon library's
    // gaps list is the first of those and never the second.
    expect(declaredUnknowns(store, showId)).toEqual([
      expect.objectContaining({
        entity: expect.objectContaining({ name: 'Tobin Wick' }),
        type: expect.objectContaining({ name: 'species' }),
      }),
    ])
    expect(relationsFrom(store, ilse.id)).toEqual([])
  })

  it('cannot be declared unknown twice', () => {
    const { tobin } = seedHarbor()
    relate(store, { fromEntityId: tobin.id, type: 'species', to: UNKNOWN_TARGET })

    expect(() => relate(store, { fromEntityId: tobin.id, type: 'species', to: UNKNOWN_TARGET })).toThrow(
      /already declares a `species`/,
    )
  })

  it('is replaced by the real answer once one exists', () => {
    const { tobin, halvani } = seedHarbor()
    const unknown = relate(store, { fromEntityId: tobin.id, type: 'species', to: UNKNOWN_TARGET })

    unrelate(store, unknown.id)
    const resolved = relate(store, { fromEntityId: tobin.id, type: 'species', to: halvani.id })

    expect(relationsFrom(store, tobin.id)).toEqual([resolved])
    expect(declaredUnknowns(store, tobin.showId)).toEqual([])
  })
})

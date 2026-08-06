import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { readFixture } from '../fixture/read.ts'
import {
  categoriesForArtifactKind,
  categoriesOf,
  declareCategory,
  declareRelationType,
  findCategory,
  relationTypeByInverse,
  type CanonCategory,
} from './category.ts'
import { createShow } from './spine.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => {
  store.close()
})

function seedShow(): string {
  return createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
}

/**
 * The fixture's five `_category.md` sheets, declared the way E2-4's loader declares them
 * (`seedCategories`): every category first, then the relation types, because a declaration
 * points at a category that may be declared after it (and, for `part-of → location`, at its
 * own). This pins the API against real sheets; that the LOADER passes them through whole —
 * `inheritsFacts` included — is pinned in fixture/load.test.ts, against the loader itself.
 */
function declareFixtureCategories(showId: string): CanonCategory[] {
  const fixture = readFixture()
  for (const category of fixture.categories) {
    declareCategory(store, {
      showId,
      key: category.key,
      name: category.name,
      blurb: category.blurb,
      fields: category.fields,
      appliesTo: category.appliesTo,
      checkInstructions: category.checkInstructions,
    })
  }
  for (const category of fixture.categories) {
    const declared = findCategory(store, showId, category.key)!
    for (const type of category.relationTypes) declareRelationType(store, declared.id, type)
  }
  return categoriesOf(store, showId)
}

describe('a category is data (3.2)', () => {
  it('carries its fields, its applicable artifact kinds, and its check instructions', () => {
    const showId = seedShow()

    declareCategory(store, {
      showId,
      key: 'house-style',
      name: 'House style',
      blurb: 'How the show sounds when nobody is looking.',
      fields: [{ name: 'narrator voice', description: 'Close third, past tense.' }],
      appliesTo: ['outline', 'script'],
      checkInstructions: 'Read the artifact for voice, pacing, and content constraints.',
    })

    expect(findCategory(store, showId, 'house-style')).toMatchObject({
      key: 'house-style',
      name: 'House style',
      blurb: 'How the show sounds when nobody is looking.',
      fields: [{ name: 'narrator voice', description: 'Close third, past tense.' }],
      appliesTo: ['outline', 'script'],
      checkInstructions: 'Read the artifact for voice, pacing, and content constraints.',
      relationTypes: [],
    })
  })

  it('answers which categories a script has to be checked against', () => {
    const showId = seedShow()
    declareCategory(store, { showId, key: 'character', name: 'Character', appliesTo: ['script', 'shot-image'] })
    declareCategory(store, { showId, key: 'house-style', name: 'House style', appliesTo: ['outline'] })

    expect(categoriesForArtifactKind(store, showId, 'script').map((c) => c.key)).toEqual(['character'])
    expect(categoriesForArtifactKind(store, showId, 'outline').map((c) => c.key)).toEqual(['house-style'])
  })

  it('refuses a second declaration of the same key, rather than quietly making two', () => {
    const showId = seedShow()
    declareCategory(store, { showId, key: 'character', name: 'Character' })

    expect(() => declareCategory(store, { showId, key: 'character', name: 'Characters' })).toThrow(
      /already declares a `character` category/,
    )
  })
})

describe('the relation types a category declares (D23)', () => {
  it('round-trips the character sheet’s species declaration, inverse intact', () => {
    const showId = seedShow()
    const categories = declareFixtureCategories(showId)

    const character = categories.find((c) => c.key === 'character')!
    expect(character.relationTypes).toEqual([
      expect.objectContaining({
        name: 'species',
        targetCategory: 'species',
        cardinality: 'exactly-one',
        required: true,
        inverse: 'members',
        // D22's other half, and it is DATA: the Halvani sheet's facts load into check scope
        // with every character that declares Halvani because this line says so, not because
        // domain/fact.ts knows the word `species` (E2-1). This assertion is what pins it —
        // delete the words from the sheet and this test is what notices.
        inheritsFacts: true,
      }),
      expect.objectContaining({
        name: 'stationed-at',
        targetCategory: 'location',
        cardinality: 'at-most-one',
        required: false,
        inverse: 'crew',
        // A dockworker does not inherit the harbour's facts by standing in it. Absence on
        // the sheet is an answer, and it is this one.
        inheritsFacts: false,
      }),
      expect.objectContaining({
        name: 'carries',
        targetCategory: 'technology',
        cardinality: 'any',
        required: false,
        inverse: 'carried-by',
        inheritsFacts: false,
      }),
    ])
  })

  it('every fixture category’s declarations survive the round trip', () => {
    const showId = seedShow()
    const declared = declareFixtureCategories(showId)

    for (const category of readFixture().categories) {
      const found = declared.find((c) => c.key === category.key)!
      expect(found.name).toBe(category.name)
      expect(found.appliesTo).toEqual(category.appliesTo)
      expect(found.checkInstructions).toBe(category.checkInstructions)
      expect(found.fields).toEqual(category.fields)
      expect(
        found.relationTypes.map((t) => ({
          name: t.name,
          targetCategory: t.targetCategory,
          cardinality: t.cardinality,
          required: t.required,
          inverse: t.inverse,
          inheritsFacts: t.inheritsFacts,
        })),
      ).toEqual(category.relationTypes)
    }
  })

  it('makes the far end of an edge findable by its inverse name — nothing declares `members`', () => {
    const showId = seedShow()
    declareFixtureCategories(showId)
    const species = findCategory(store, showId, 'species')!

    // `members` is navigable from Species because Character named it, not because Species
    // declared it. That is the whole point of the inverse (D23).
    expect(species.relationTypes.map((t) => t.name)).toEqual(['homeworld'])
    expect(relationTypeByInverse(store, species.id, 'members')).toMatchObject({
      name: 'species',
      inverse: 'members',
    })
  })

  it('refuses a declaration pointing at a category this show has not declared', () => {
    const showId = seedShow()
    const character = declareCategory(store, { showId, key: 'character', name: 'Character' })

    expect(() =>
      declareRelationType(store, character.id, {
        name: 'species',
        targetCategory: 'species',
        cardinality: 'exactly-one',
        required: true,
        inverse: 'members',
      }),
    ).toThrow(/no `species` category/)
  })

  it('refuses two declarations that would make one inverse name mean two things', () => {
    const showId = seedShow()
    const character = declareCategory(store, { showId, key: 'character', name: 'Character' })
    const technology = declareCategory(store, { showId, key: 'technology', name: 'Technology' })
    declareCategory(store, { showId, key: 'species', name: 'Species' })

    declareRelationType(store, character.id, {
      name: 'species',
      targetCategory: 'species',
      cardinality: 'exactly-one',
      required: true,
      inverse: 'members',
    })

    expect(() =>
      declareRelationType(store, technology.id, {
        name: 'issued-to',
        targetCategory: 'species',
        cardinality: 'any',
        required: false,
        inverse: 'members',
      }),
    ).toThrow(/`members` is already navigable from the species category/)
  })

  it('refuses an inverse that collides with a relation type the target category declares', () => {
    const showId = seedShow()
    const character = declareCategory(store, { showId, key: 'character', name: 'Character' })
    const location = declareCategory(store, { showId, key: 'location', name: 'Location' })

    declareRelationType(store, location.id, {
      name: 'crew',
      targetCategory: 'character',
      cardinality: 'any',
      required: false,
      inverse: 'crews',
    })

    expect(() =>
      declareRelationType(store, character.id, {
        name: 'stationed-at',
        targetCategory: 'location',
        cardinality: 'at-most-one',
        required: false,
        inverse: 'crew',
      }),
    ).toThrow(/`crew` is already a relation type the location category declares/)
  })
})

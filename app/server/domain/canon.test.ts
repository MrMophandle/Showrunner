import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import {
  addReference,
  amendEntity,
  entitiesOfShow,
  findEntity,
  findEntityById,
  referencesOf,
  registerEntity,
  removeReference,
} from './canon.ts'
import { declareCategory } from './category.ts'
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

describe('registering an identity (invariant 1)', () => {
  it('writes a candidate nobody has ratified — no standing, no prose, no relations', () => {
    const showId = seedShow()

    const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })

    expect(tobin).toMatchObject({
      showId,
      categoryKey: 'character',
      name: 'Tobin Wick',
      standing: null,
      status: 'candidate',
      aliases: [],
      body: '',
    })
  })

  it('registers against a category the show has not declared yet, and links one it has', () => {
    const showId = seedShow()

    // E1's loader and every E1 test register identities with no categories in the store at
    // all; refusing that here would break them, and would make a candidate impossible.
    const unlinked = registerEntity(store, { showId, categoryKey: 'character', name: 'Ilse Renn' })
    expect(unlinked.categoryId).toBeNull()

    const character = declareCategory(store, { showId, key: 'character', name: 'Character' })
    const linked = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })
    expect(linked.categoryId).toBe(character.id)
  })

  it('refuses a category_id that names a different category than the key does', () => {
    const showId = seedShow()
    declareCategory(store, { showId, key: 'character', name: 'Character' })
    const location = declareCategory(store, { showId, key: 'location', name: 'Location' })
    const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })

    expect(() =>
      store.run('UPDATE canon_entity SET category_id = ? WHERE id = ?', location.id, tobin.id),
    ).toThrow(/category_id must be this show's category with that category_key/)
  })
})

describe('the anatomy of an entity (3.1)', () => {
  it('carries standing, status, aliases and a prose body', () => {
    const showId = seedShow()
    const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })

    const amended = amendEntity(store, tobin.id, {
      standing: 'core',
      status: 'active',
      aliases: ['Wick', 'the rigger'],
      body: 'Tobin came to Grey Harbor at nineteen to work a lane that had stopped carrying anything.',
    })

    expect(amended).toMatchObject({
      standing: 'core',
      status: 'active',
      aliases: ['Wick', 'the rigger'],
      body: 'Tobin came to Grey Harbor at nineteen to work a lane that had stopped carrying anything.',
    })
    expect(findEntityById(store, tobin.id)).toEqual(amended)
    expect(findEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })).toEqual(amended)
    expect(entitiesOfShow(store, showId)).toEqual([amended])
  })

  it('leaves what it was not asked to change alone', () => {
    const showId = seedShow()
    const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })
    amendEntity(store, tobin.id, { standing: 'core', aliases: ['Wick'] })

    expect(amendEntity(store, tobin.id, { status: 'active' })).toMatchObject({
      standing: 'core',
      status: 'active',
      aliases: ['Wick'],
    })
  })

  it('refuses a standing or status outside the vocabulary, at the database', () => {
    const showId = seedShow()
    const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })

    expect(() => store.run("UPDATE canon_entity SET standing = 'main' WHERE id = ?", tobin.id)).toThrow(
      /standing is core\/recurring\/one-shot\/retired/,
    )
    expect(() => store.run("UPDATE canon_entity SET status = 'draft' WHERE id = ?", tobin.id)).toThrow(
      /status is active\/historical\/candidate/,
    )
  })
})

describe('references (3.1)', () => {
  it('marks each one locked or aspirational, and points at a file E6 will make', () => {
    const showId = seedShow()
    const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })

    const locked = addReference(store, {
      entityId: tobin.id,
      kind: 'image',
      filePath: 'greyharbor/reference/tobin-wick.png',
      stance: 'locked',
      label: 'The face every shot has to match',
    })
    addReference(store, {
      entityId: tobin.id,
      kind: 'voice',
      filePath: 'greyharbor/reference/tobin-wick.wav',
      stance: 'aspirational',
    })

    expect(referencesOf(store, tobin.id)).toEqual([
      expect.objectContaining({
        kind: 'image',
        filePath: 'greyharbor/reference/tobin-wick.png',
        stance: 'locked',
        label: 'The face every shot has to match',
      }),
      expect.objectContaining({ kind: 'voice', stance: 'aspirational', label: '' }),
    ])

    removeReference(store, locked.id)
    expect(referencesOf(store, tobin.id).map((r) => r.kind)).toEqual(['voice'])
  })

  it('refuses a reference kind nothing knows how to render', () => {
    const showId = seedShow()
    const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })

    expect(() =>
      store.run(
        "INSERT INTO entity_reference (id, entity_id, kind, file_path, stance) VALUES ('ref1', ?, 'smell', 'x.bin', 'locked')",
        tobin.id,
      ),
    ).toThrow(/CHECK constraint failed/)
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { entitiesOfShow, findEntity, findEntityById } from '../domain/canon.ts'
import { canonAsOf, factsInScope, findRuling } from '../domain/fact.ts'
import { createProposalRulings, openProposals, raiseProposal } from '../domain/proposal.ts'
import { declaredUnknowns, relationsFrom } from '../domain/relation.ts'
import { createEventLog } from '../events.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { greyHarborFounded } from './founded.ts'
import { loadFixture, promotionFromSheet } from './load.ts'
import { readFixture, type FixtureEntity } from './read.ts'

/**
 * Grey Harbor, founded — the sheets carried to a gate and ruled (D25), which is the
 * sentence E1-7's loader ended on coming due.
 *
 * These are E2-4's done-conditions, and they are end-to-end on purpose: every one of them
 * goes through `npm run fixture:load`'s real code path and then through E2-2's real ruling
 * API. Nothing here writes a canon row by hand, which is the point — if a bulk-write path
 * ever appears, these tests keep passing and that is exactly why the READ of them matters
 * as much as the run: they must stay written in terms of `foundCanon`, never `establishFact`.
 */

let root: string
let paths: LibraryPaths
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-founded-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** Every row of every table, so "identical state" means identical, not "close enough". */
function dump(store: Store): Record<string, unknown[]> {
  const tables = store.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  return Object.fromEntries(
    tables.map(({ name }) => [name, store.all<unknown>(`SELECT * FROM ${name}`)]),
  )
}

describe('Grey Harbor, founded', () => {
  it('makes every fact, relation and standing on the sheets ratified canon', () => {
    const harbor = greyHarborFounded(store, paths)

    for (const sheet of readFixture().entities.filter((e) => e.status !== 'candidate')) {
      const entity = harbor.entity(sheet.name)

      expect([entity.status, entity.standing, entity.aliases, entity.body]).toEqual([
        'active',
        sheet.standing,
        sheet.aliases,
        sheet.body,
      ])
      expect(canonAsOf(store, { entityId: entity.id }, 'now').map((f) => f.statement)).toEqual(
        sheet.facts,
      )
      expect(
        relationsFrom(store, entity.id).map((r) => [
          r.type.name,
          r.toEntityId === null ? 'unknown' : findEntityById(store, r.toEntityId)!.name,
        ]),
      ).toEqual(sheet.relations.map((r) => [r.type, r.target]))
    }

    expect(harbor.founding.founded).toHaveLength(6)
    expect(openProposals(store, harbor.show.id)).toEqual([])
  })

  /**
   * Founding lineage: ratified at a ruling that names the promotion, convened at no gate,
   * and established in NO episode — the sheets predate every episode written against them.
   */
  it('leaves founding lineage on every fact, and no gate on any ruling', () => {
    const harbor = greyHarborFounded(store, paths)

    const facts = canonAsOf(store, { showId: harbor.show.id }, 'now')
    expect(facts.length).toBeGreaterThan(20)
    for (const fact of facts) {
      expect(fact.establishedIn).toBeNull()
      const ruling = findRuling(store, fact.ratifiedBy!)!
      expect([ruling.kind, ruling.gateId]).toEqual(['ratification', null])
      expect(ruling.proposalId).not.toBeNull()
      expect(ruling.note).toMatch(/founded/i)
    }
  })

  /**
   * The amendment E2-4 gained after E2-1, and the reason it was written down: dropping
   * `inheritsFacts` on the way from the sheet to the declaration fails nothing loudly. It
   * just means Halvani physiology stops loading with a Halvani, and the world-rules check
   * reports clean on scene 4 — a scene it never really read (invariant 2).
   */
  it('loads Halvani physiology into Tobin Wick’s check scope (D22, the amendment)', () => {
    const harbor = greyHarborFounded(store, paths)

    const scope = factsInScope(store, harbor.entity('Tobin Wick').id)

    expect(scope.inheritance.map((edge) => [edge.type.name, edge.case, edge.source?.name])).toEqual([
      ['species', 'inherited', 'Halvani'],
    ])
    expect(scope.inScope.map((f) => f.statement)).toContain(
      'A Halvani in unprotected vacuum — no hardsuit, no active containment field — loses ' +
        'consciousness in about nine seconds and dies inside two minutes.',
    )
    // The four entities scene 4's violation needs in scope (the fixture README) — the
    // species half of it arrives only across the declared, fact-carrying edge.
    expect(scope.own.length + scope.inheritance[0]!.facts.length).toBe(scope.inScope.length)
  })
})

describe('the candidate sheet, after founding', () => {
  it('stays visibly unofficial — no standing, no facts, no edges, and nothing pending', () => {
    const harbor = greyHarborFounded(store, paths)
    const sefa = harbor.entity('Sefa Doule')

    expect(sefa).toMatchObject({ status: 'candidate', standing: null, aliases: [], body: '' })
    expect(canonAsOf(store, { entityId: sefa.id }, 'now')).toEqual([])
    expect(relationsFrom(store, sefa.id)).toEqual([])
    expect(harbor.load.candidates).toEqual(['Sefa Doule'])
  })

  it('is promotable through the normal API, sheet and all — `unknown` satisfies D22', () => {
    const harbor = greyHarborFounded(store, paths)
    const sefa = harbor.entity('Sefa Doule')
    const sheet = readFixture().entities.find((e) => e.name === 'Sefa Doule')!

    // The same builder the loader uses. Somebody raises this deliberately — here, a test;
    // in the app, Ryan at the bench (E2-6) — and it is ruled like every other change.
    const proposal = raiseProposal(store, promotionFromSheet(sheet, sefa.id, harbor.entities))
    createProposalRulings(store, createEventLog(store)).ratify(proposal.id, {
      note: 'Sefa is in ep02; promote the sheet',
    })

    expect(findEntityById(store, sefa.id)).toMatchObject({ status: 'active', standing: 'recurring' })
    expect(canonAsOf(store, { entityId: sefa.id }, 'now').map((f) => f.statement)).toEqual(
      sheet.facts,
    )
    // A declared unknown is a relation row with a NULL target — legal canon, and now on
    // the gaps list, which is what makes "somebody looked" different from "nobody said".
    expect(relationsFrom(store, sefa.id).map((r) => [r.type.name, r.toEntityId])).toEqual([
      ['species', null],
    ])
    expect(declaredUnknowns(store, harbor.show.id).map((u) => u.entity.name)).toEqual(['Sefa Doule'])
  })
})

describe('a character sheet stripped of its species (D22)', () => {
  /**
   * `read.ts` refuses the doctored sheet at READ — read.test.ts pins that, and it means a
   * stripped file never reaches the loader at all. So the refusal AT RATIFICATION is
   * reached the only honest way left: build the promotion that sheet WOULD have raised,
   * with the real builder and the real sheet, and put it to the real ruling API.
   */
  it('is refused at ratification, not only at read — and the whole sheet is not', () => {
    const report = loadFixture(store, paths)
    const rulings = createProposalRulings(store, createEventLog(store))
    const entities = new Map(entitiesOfShow(store, report.show.id).map((e) => [e.name, e]))
    const tobin = entities.get('Tobin Wick')!

    const sheet = readFixture().entities.find((e) => e.name === 'Tobin Wick')!
    const stripped: FixtureEntity = {
      ...sheet,
      relations: sheet.relations.filter((relation) => relation.type !== 'species'),
    }
    const doctored = raiseProposal(store, promotionFromSheet(stripped, tobin.id, entities))

    expect(() => rulings.ratify(doctored.id)).toThrow(
      /“Tobin Wick” cannot become canon without a `species`/,
    )
    // Nothing was half-written: the refusal rolls the whole ratification back.
    expect(findEntityById(store, tobin.id)!.status).toBe('candidate')
    expect(canonAsOf(store, { entityId: tobin.id }, 'now')).toEqual([])

    // The control. Same builder, same sheet, species line intact — and it is canon.
    const whole = openProposals(store, report.show.id).find(
      (proposal) => proposal.entityId === tobin.id && proposal.id !== doctored.id,
    )!
    rulings.ratify(whole.id, { note: 'founded from the sheet' })
    expect(findEntityById(store, tobin.id)!.status).toBe('active')
    expect(relationsFrom(store, tobin.id).map((r) => r.type.name)).toContain('species')
  })
})

describe('loading again after founding', () => {
  /**
   * The sheets are founding documents, not a sync source. A load after founding walks every
   * sheet, finds the identity, finds the promotion Ryan already ruled, and writes nothing —
   * it does not raise a second stack of promotions for canon that already exists.
   */
  it('raises nothing, duplicates nothing, and leaves every row exactly as it was', () => {
    const harbor = greyHarborFounded(store, paths)
    const before = dump(store)

    const again = loadFixture(store, paths)

    expect(dump(store)).toEqual(before)
    expect(again.promotions).toEqual({ created: 0, found: 6 })
    expect(again.entities).toEqual({ created: 0, found: 7 })
    expect(again.categories).toEqual({ created: 0, found: 5 })
    expect(again.candidates).toEqual(['Sefa Doule'])
    expect(openProposals(store, harbor.show.id)).toEqual([])
  })

  it('founds nothing the second time either — a proposal is ruled once (3.3)', () => {
    greyHarborFounded(store, paths)

    const again = greyHarborFounded(store, paths)

    expect(again.founding.founded).toEqual([])
    expect(
      canonAsOf(store, { entityId: again.entity('Tobin Wick').id }, 'now').map((f) => f.statement),
    ).toEqual(readFixture().entities.find((e) => e.name === 'Tobin Wick')!.facts)
  })
})

describe('founding a library whose identities predate its categories', () => {
  /**
   * Ryan's own volume, and every library E1-7's loader seeded: six identities carrying a
   * `category_key` and, once 0006 applied, a NULL `category_id`. Nothing about such a row
   * can be traversed or inherited until the link exists, so the loader repairs it — and
   * this is the test that says the founding still lands on those rows rather than beside
   * them.
   */
  it('links what E1’s loader registered, and founds the sheets onto those same rows', () => {
    const first = loadFixture(store, paths)
    const tobin = findEntity(store, {
      showId: first.show.id,
      categoryKey: 'character',
      name: 'Tobin Wick',
    })!
    // Wind the row back to what an E1-era library holds: the key, and no category link.
    store.run('UPDATE canon_entity SET category_id = NULL WHERE id = ?', tobin.id)

    const harbor = greyHarborFounded(store, paths)

    expect(harbor.entity('Tobin Wick').id).toBe(tobin.id)
    expect(harbor.entity('Tobin Wick').categoryId).not.toBeNull()
    expect(factsInScope(store, tobin.id).inheritance.map((e) => e.case)).toEqual(['inherited'])
  })
})

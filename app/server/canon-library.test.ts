import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonBenchView,
  proposeFactChange,
  proposeNewFact,
  registerAndPropose,
} from './canon-bench.ts'
import { canonLibraryView, type CanonLibraryView } from './canon-library.ts'
import { destinationsOf } from './cockpit.ts'
import type { Store } from './db/store.ts'
import { entitiesOfShow, findEntityById } from './domain/canon.ts'
import { categoriesOf, declareCategory, declareRelationType } from './domain/category.ts'
import { canonAsOf, factsOfEntity, rulingsOfShow } from './domain/fact.ts'
import { createProposalRulings, openProposals } from './domain/proposal.ts'
import { episodesOf, seasonsOf } from './domain/spine.ts'
import { createEventLog, type EventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { loadFixture } from './fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'

/**
 * **The canon library's read** (E5-4, #84; 5.4, D9, D22, D23).
 *
 * The claim this file exists to hold is the one E5-2 and E5-3 held before it: **the screen's
 * whole content comes down `canon-bench.ts`'s wires, and this module stitches rather than
 * re-words.** Every assertion below either checks that a sentence arrived from the module
 * that owns it — a fact's lineage, a proposal's five parts, a refusal, an as-of setting — or
 * checks the four things the bench genuinely does not carry and a browsable bible needs:
 * the sidebar as a query over categories, inheritance made visible with the edge it
 * travelled, edges navigable from both ends, and appearances computed from provenance.
 *
 * A real library volume in a temp directory with Grey Harbor **founded** in it, and nothing
 * that reaches the network or spends a cent.
 */

let root: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let harbor: FoundedFixture
let ep01: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-library-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
  ep01 = episodesOf(store, seasonsOf(store, harbor.show.id)[0]!.id)[0]!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const library = (standing: Parameters<typeof canonLibraryView>[2] = {}): CanonLibraryView =>
  canonLibraryView(store, harbor.show.id, standing)!

const open = (name: string, standing: Record<string, unknown> = {}): CanonLibraryView =>
  library({ entityId: harbor.entity(name).id, ...standing })

const factOf = (name: string, needle: string): string =>
  factsOfEntity(store, harbor.entity(name).id).find((fact) => fact.statement.includes(needle))!.id

/** Ryan ruling one proposal, through the one ruling API the bench convenes. */
const ratify = (proposalId: string): number =>
  createProposalRulings(store, events).ratify(proposalId, { note: 'ruled at the library' })
    .disposition!.seq

// ── Trap 1 · the sidebar is a query ─────────────────────────────────────────────

describe('the sidebar is a query over categories, never a list this file holds', () => {
  it('names every category the show declares, in the store’s own order', () => {
    expect(library().sidebar.map((entry) => entry.key)).toEqual(
      categoriesOf(store, harbor.show.id).map((category) => category.key),
    )
    expect(library().sidebar.map((entry) => entry.name)).toEqual(
      categoriesOf(store, harbor.show.id).map((category) => category.name),
    )
  })

  /**
   * The E4-0 core-door lesson, applied to this screen: nothing in the writer's desk knows the
   * word `character`, and nothing here may either. The proof is mechanical — the show's own
   * category keys and names are read out of the store and looked for in the two files that
   * build this screen.
   */
  it('holds no category’s name or key anywhere in the read or the screen', () => {
    const declared = categoriesOf(store, harbor.show.id).flatMap((category) => [
      category.key,
      category.name,
    ])
    const sources = [
      join(import.meta.dirname, 'canon-library.ts'),
      join(import.meta.dirname, '..', 'web', 'screens', 'CanonLibrary.tsx'),
    ].map((path) => readFileSync(path, 'utf8'))

    for (const source of sources) {
      for (const word of declared) {
        expect(source.toLowerCase().includes(word.toLowerCase()), `${word} is written down`).toBe(
          false,
        )
      }
    }
  })

  it('grows an entry, a page shape and a check column when a category is declared', () => {
    const before = library().sidebar.length
    const kind = declareCategory(store, {
      showId: harbor.show.id,
      key: 'faction',
      name: 'Factions',
      blurb: 'who wants what, and who is in the way of it',
      fields: [{ name: 'reach', description: 'how far it can act' }],
      appliesTo: ['outline', 'script'],
      checkInstructions: 'read the draft against what this faction can and cannot reach',
    })
    declareRelationType(store, kind.id, {
      name: 'seat',
      targetCategory: 'location',
      cardinality: 'exactly-one',
      required: true,
      inverse: 'seats',
    })
    registerAndPropose(store, harbor.show.id, { categoryKey: 'faction', name: 'The line office' })

    const entry = library().sidebar.find((one) => one.key === 'faction')!
    expect(library().sidebar).toHaveLength(before + 1)
    expect(entry.name).toBe('Factions')
    expect(entry.entities.map((one) => one.name)).toEqual(['The line office'])
    // The check column: which artifacts its reviewer fires on (3.2, 4.1), short enough to sit
    // in a rail — with what that reviewer is actually told to do beside it, in full.
    expect(entry.checks).toContain('outline')
    expect(entry.checks).toContain('script')
    expect(entry.instructions).toContain(
      'read the draft against what this faction can and cannot reach',
    )

    // …and the entity page of the new category has the shape its declaration gives it: a chip
    // for the edge it requires, and the requirement said in words before anything is ruled.
    const page = library({ entityId: entitiesOfShow(store, harbor.show.id).find((one) => one.name === 'The line office')!.id })
    expect(page.entity!.chips.map((chip) => chip.label)).toContain('seat')
    expect(page.entity!.chips.find((chip) => chip.label === 'seat')!.kind).toBe('undeclared')
  })

  it('counts what each category holds, and says a candidate is one', () => {
    const entry = library().sidebar.find((one) =>
      one.entities.some((entity) => entity.name === 'Sefa Doule'),
    )!
    const sefa = entry.entities.find((one) => one.name === 'Sefa Doule')!

    expect(entry.count).toBe(entry.entities.length)
    expect(entry.sentence).toContain(String(entry.count))
    expect(sefa.tag).toBe('candidate')
    // The whole sentence is the bench's, quoted — "…is a candidate — an identity registered…"
    expect(sefa.sentence).toBe(
      canonBenchView(store, harbor.show.id)!.entities.find((one) => one.name === 'Sefa Doule')!
        .sentence,
    )
    expect(sefa.href).toBe(`/canon/${harbor.entity('Sefa Doule').id}`)
  })

  /**
   * A sheet is markdown on disk and every surface in this app renders a sentence as TEXT —
   * the lesson E5-2 learnt when `**vanilla**` reached the screen as asterisks (#82). These
   * are the three places a sheet's own prose is quoted onto this screen.
   */
  it('lands a sheet’s own prose as prose, not as the markdown it is written in', () => {
    declareCategory(store, {
      showId: harbor.show.id,
      key: 'faction',
      name: 'Factions',
      blurb: 'a **faction** wants something',
      checkInstructions: 'read it against what it can __reach__',
    })
    const raised = registerAndPropose(
      store,
      harbor.show.id,
      { categoryKey: 'faction', name: 'The line office' },
      { body: 'It counts **berths** and it does not say why.' },
    )
    ratify(raised.id)

    const entry = library().sidebar.find((one) => one.key === 'faction')!
    expect(entry.blurb).toBe('a faction wants something')
    expect(entry.instructions).toBe('read it against what it can reach')
    expect(library({ entityId: raised.entityId }).entity!.prose[0]!.paragraphs[0]).toBe(
      'It counts berths and it does not say why.',
    )
  })

  it('says an empty category is empty rather than drawing a blank', () => {
    declareCategory(store, { showId: harbor.show.id, key: 'timeline', name: 'Timeline' })
    const entry = library().sidebar.find((one) => one.key === 'timeline')!

    expect(entry.count).toBe(0)
    expect(entry.entities).toEqual([])
    expect(entry.emptyBecause).toContain('Timeline')
  })
})

// ── Trap 2 · the point-in-time control provably moves ───────────────────────────

describe('the point-in-time control is D9 made visible', () => {
  it('quotes the bench’s as-of sentence and its choices rather than wording a second one', () => {
    for (const standing of [{}, { ruling: 3 }, { date: '2026-08-11' }]) {
      expect(library(standing).bench.asOf).toEqual(canonBenchView(store, harbor.show.id, standing)!.asOf)
    }
  })

  it('shows a fact ratified at a ruling as absent before it and present at it', () => {
    const before = factOf('Tobin Wick', 'rigged Grey Harbor')
    const change = proposeFactChange(store, before, {
      statement: "Tobin Wick has rigged Grey Harbor's piers for nine years.",
    })
    const at = ratify(change.id)
    expect(at).toBe(rulingsOfShow(store, harbor.show.id)[0]!.seq)

    const earlier = open('Tobin Wick', { ruling: at - 1 })
    const here = open('Tobin Wick', { ruling: at })

    const said = (view: CanonLibraryView): string[] =>
      view.entity!.facts.map((fact) => fact.statement)
    expect(said(earlier)).toContain("Tobin Wick has rigged Grey Harbor's piers for six years.")
    expect(said(earlier)).not.toContain("Tobin Wick has rigged Grey Harbor's piers for nine years.")
    expect(said(here)).toContain("Tobin Wick has rigged Grey Harbor's piers for nine years.")
    expect(said(here)).not.toContain("Tobin Wick has rigged Grey Harbor's piers for six years.")
    // The table really is `canonAsOf`, read at the setting — never a filter of its own.
    expect(said(here).sort()).toEqual(
      canonAsOf(store, { entityId: harbor.entity('Tobin Wick').id }, { ruling: at })
        .map((fact) => fact.statement)
        .sort(),
    )
  })

  it('says where a superseded predecessor went, and that a later fact is ahead rather than gone', () => {
    const before = factOf('Tobin Wick', 'rigged Grey Harbor')
    const at = ratify(
      proposeFactChange(store, before, { statement: 'Tobin Wick has rigged the piers for nine years.' })
        .id,
    )

    const closed = open('Tobin Wick', { ruling: at }).entity!.otherRows.find(
      (row) => row.id === before,
    )!
    expect(closed.where).toBe('closed')
    expect(closed.lineage).toContain(`superseded at ruling ${at}`)

    const ahead = open('Tobin Wick', { ruling: at - 1 }).entity!.otherRows.find(
      (row) => row.statement === 'Tobin Wick has rigged the piers for nine years.',
    )!
    expect(ahead.where).toBe('ahead')
    expect(ahead.because).toContain(String(at))
  })

  it('never renders a claim riding an episode as ratified, at any setting', () => {
    proposeNewFact(store, harbor.entity('Tobin Wick').id, {
      statement: 'Tobin keeps the No. 4 lock’s rack stocked himself.',
      episodeId: ep01,
    })

    for (const standing of [{}, { ruling: 3 }, { ruling: 6 }]) {
      const page = open('Tobin Wick', standing).entity!
      expect(page.facts.map((fact) => fact.statement)).not.toContain(
        'Tobin keeps the No. 4 lock’s rack stocked himself.',
      )
      const riding = page.otherRows.find(
        (row) => row.statement === 'Tobin keeps the No. 4 lock’s rack stocked himself.',
      )!
      expect(riding.where).toBe('riding')
      expect(riding.status).toBe('provisional')
      expect(riding.lineage).toContain('provisional')
    }
  })

  it('renders a candidate as visibly unofficial at every setting, and raises nothing for it', () => {
    for (const standing of [{}, { ruling: 6 }, { date: '2026-08-11' }]) {
      const page = open('Sefa Doule', standing).entity!
      expect(page.sheet.status).toBe('candidate')
      expect(page.facts).toEqual([])
      expect(page.factsNone!.sentence).toContain('candidate')
      // The one door a candidate has is its promotion, and the add-a-fact door says why not.
      expect(page.sheet.promote.enabled).toBe(true)
      expect(page.sheet.addFact.enabled).toBe(false)
      expect(page.sheet.addFact.blockedBecause).toContain('candidate')
    }
    expect(openProposals(store, harbor.show.id)).toEqual([])
  })
})

// ── Trap 3 · lineage, inheritance, and the three kinds of nothing ───────────────

describe('a fact carries its lineage, and an inherited one carries the edge it travelled', () => {
  it('quotes the bench’s lineage sentence for every standing fact', () => {
    const page = open('Tobin Wick').entity!
    const bench = canonBenchView(store, harbor.show.id, {
      entityId: harbor.entity('Tobin Wick').id,
    })!.entity!

    expect(page.facts.map((fact) => ({ id: fact.id, lineage: fact.lineage }))).toEqual(
      bench.facts.map((fact) => ({ id: fact.id, lineage: fact.lineage })),
    )
    expect(page.facts[0]!.lineage).toContain('ratified at ruling')
  })

  it('puts inherited facts in their own block, naming the source and the edge (D22)', () => {
    const page = open('Tobin Wick').entity!
    const block = page.inherited[0]!

    expect(page.inherited).toHaveLength(1)
    expect(block.case).toBe('inherited')
    expect(block.sourceName).toBe('Halvani')
    expect(block.via).toContain('Halvani')
    expect(block.via).toContain(block.type)
    expect(block.href).toBe(`/canon/${harbor.entity('Halvani').id}`)
    expect(block.facts.map((fact) => fact.statement).sort()).toEqual(
      canonAsOf(store, { entityId: harbor.entity('Halvani').id }, 'now')
        .map((fact) => fact.statement)
        .sort(),
    )
    // Not his facts: editing one edits the species, and the block says so.
    expect(block.note).toContain('Halvani')
    // …and none of them is on his own table.
    expect(page.facts.map((fact) => fact.statement)).not.toContain(block.facts[0]!.statement)
  })

  it('reads inherited facts at the setting too, so the block moves with the control', () => {
    const halvani = factOf('Halvani', 'cannot hold their breath')
    const at = ratify(
      proposeFactChange(store, halvani, {
        statement: 'A Halvani cannot hold their breath against vacuum at all.',
      }).id,
    )

    const here = open('Tobin Wick', { ruling: at }).entity!.inherited[0]!
    const earlier = open('Tobin Wick', { ruling: at - 1 }).entity!.inherited[0]!
    expect(here.facts.map((fact) => fact.statement)).toContain(
      'A Halvani cannot hold their breath against vacuum at all.',
    )
    expect(earlier.facts.map((fact) => fact.statement)).not.toContain(
      'A Halvani cannot hold their breath against vacuum at all.',
    )
  })

  it('tells the three kinds of nothing apart, and never collapses them', () => {
    // 1 · undeclared — Sefa's sheet says `unknown` and nobody ruled it, so there is no row.
    const sefa = open('Sefa Doule').entity!
    expect(sefa.inherited.map((block) => block.case)).toEqual(['undeclared'])
    expect(sefa.inherited[0]!.sourceName).toBeNull()

    // 2 · declared-unknown — a promotion ruled with the literal word, which is a real answer.
    const required = canonBenchView(store, harbor.show.id)!.create.categories.find(
      (category) => category.required.length > 0,
    )!
    const unknown = required.required[0]!
    const raised = registerAndPropose(
      store,
      harbor.show.id,
      { categoryKey: required.key, name: 'The assessor’s clerk' },
      { relations: [{ type: unknown.type, to: unknown.unknown }] },
    )
    ratify(raised.id)
    const clerk = library({ entityId: raised.entityId }).entity!
    expect(clerk.inherited.map((block) => block.case)).toEqual(['declared-unknown'])
    expect(clerk.chips.find((chip) => chip.label === unknown.type)!.value).toBe(unknown.unknown)
    expect(clerk.chips.find((chip) => chip.label === unknown.type)!.kind).toBe('unknown')

    // 3 · source-has-no-facts — the edge is there and there is nothing at the far end yet.
    const empty = registerAndPropose(store, harbor.show.id, {
      categoryKey: unknown.targetCategory,
      name: 'The unrecorded',
    })
    ratify(empty.id)
    const pointed = registerAndPropose(
      store,
      harbor.show.id,
      { categoryKey: required.key, name: 'The tender pilot' },
      { relations: [{ type: unknown.type, to: empty.entityId }] },
    )
    ratify(pointed.id)
    const pilot = library({ entityId: pointed.entityId }).entity!
    expect(pilot.inherited.map((block) => block.case)).toEqual(['source-has-no-facts'])
    expect(pilot.inherited[0]!.sourceName).toBe('The unrecorded')

    // Three different sentences for three different pieces of news.
    const said = [sefa, clerk, pilot].map((page) => page.inherited[0]!.sentence)
    expect(new Set(said).size).toBe(3)
  })

  it('renders a declared unknown as the answer it is and an absent declaration as the hole', () => {
    const sefa = open('Sefa Doule').entity!
    const chip = sefa.chips.find((one) => one.kind === 'undeclared')!

    expect(chip.because).toContain('required')
    // The hole is not the same news as the answer, and the chip says which one this is.
    expect(chip.value).not.toBe('')
    expect(sefa.chips.some((one) => one.kind === 'unknown')).toBe(false)
    // And the show's gaps list is D22's own query — a declared unknown, never a missing row.
    expect(library().gaps).toEqual([])
  })

  it('lists every declared unknown in the show as the gaps list (D22)', () => {
    const required = canonBenchView(store, harbor.show.id)!.create.categories.find(
      (category) => category.required.length > 0,
    )!
    const edge = required.required[0]!
    ratify(
      registerAndPropose(
        store,
        harbor.show.id,
        { categoryKey: required.key, name: 'The assessor’s clerk' },
        { relations: [{ type: edge.type, to: edge.unknown }] },
      ).id,
    )

    const gaps = library().gaps
    expect(gaps.map((gap) => gap.name)).toEqual(['The assessor’s clerk'])
    expect(gaps[0]!.sentence).toContain(edge.type)
    expect(gaps[0]!.href).toContain('/canon/')
    // The absence and the list are not both true at once.
    expect(library().gapsNone).toBeNull()
  })
})

// ── Trap 3 · relations are typed, and navigable from both ends (D23) ────────────

describe('every edge is typed, and navigable from both ends', () => {
  it('quotes the bench’s sentence for a declared edge and adds where it points', () => {
    const page = open('Tobin Wick').entity!
    const bench = canonBenchView(store, harbor.show.id, {
      entityId: harbor.entity('Tobin Wick').id,
    })!.entity!

    expect(page.relations.map((edge) => edge.sentence)).toEqual(
      bench.relations.map((relation) => relation.sentence),
    )
    const species = page.relations.find((edge) => edge.toName === 'Halvani')!
    expect(species.href).toBe(`/canon/${harbor.entity('Halvani').id}`)
    expect(species.direction).toBe('declared')
    expect(species.inverse).toContain('members')
  })

  it('reaches the far end by its inverse name, which no category declares (D23)', () => {
    const halvani = open('Halvani').entity!
    const incoming = halvani.incoming.find((edge) => edge.toName === 'Tobin Wick')!

    expect(incoming.direction).toBe('inverse')
    expect(incoming.name).toBe('members')
    expect(incoming.href).toBe(`/canon/${harbor.entity('Tobin Wick').id}`)
    expect(incoming.sentence).toContain('members')
    // The species category declares nothing of the sort, and the sentence says whose it is.
    expect(incoming.sentence).toContain('Tobin Wick')
  })
})

// ── Trap 4 · every bench door has its home ─────────────────────────────────────

describe('every door the bench opens has a home here, in the bench’s own words', () => {
  it('hands the founding offer, the create form and the refusals over unchanged', () => {
    const view = library()
    const bench = canonBenchView(store, harbor.show.id)!

    expect(view.bench.found).toEqual(bench.found)
    expect(view.bench.create).toEqual(bench.create)
    expect(view.bench.refusals).toEqual(bench.refusals)
  })

  it('offers a promotion, an addition and a change from the entity’s own page', () => {
    const page = open('Tobin Wick').entity!

    expect(page.sheet.addFact.enabled).toBe(true)
    expect(page.sheet.addFact.sentence).toContain('Tobin Wick')
    expect(page.facts.every((fact) => fact.propose.enabled)).toBe(true)
    expect(page.facts[0]!.propose.sentence).toContain(page.facts[0]!.statement)
    // Promotion is refused on canon, in the bench's words — a change to canon is a delta.
    expect(page.sheet.promote.enabled).toBe(false)
    expect(page.sheet.promote.blockedBecause).toContain('already active canon')
  })

  it('rules the queue one proposal at a time, with all five parts', () => {
    const raised = proposeNewFact(store, harbor.entity('Ilse Renn').id, {
      statement: 'Ilse Renn signs the harbour’s power figures herself.',
    })
    const view = library()
    const waiting = view.bench.queue.find((one) => one.id === raised.id)!

    expect(view.bench.queue).toEqual(canonBenchView(store, harbor.show.id)!.queue)
    expect(waiting.change.length).toBeGreaterThan(0)
    expect(waiting.usageContext).not.toBe('')
    expect(waiting.implications).not.toBe('')
    expect(waiting.alternatives.length).toBeGreaterThan(0)
    expect([waiting.ratify.enabled, waiting.reject.enabled, waiting.defer.enabled]).toEqual([
      true,
      true,
      true,
    ])
    // And the entity's own page says what is standing over it, from the same queue.
    expect(open('Ilse Renn').entity!.open.map((one) => one.id)).toEqual([raised.id])
  })

  it('marks the fact a pending proposal would change, beside the fact itself', () => {
    const fact = factOf('Tobin Wick', 'rigged Grey Harbor')
    proposeFactChange(store, fact, { statement: 'Tobin Wick has rigged the piers for nine years.' })

    const page = open('Tobin Wick').entity!
    expect(page.facts.find((one) => one.id === fact)!.touchedBy).toContain('1')
    expect(page.facts.find((one) => one.id !== fact)!.touchedBy).toBeNull()
  })

  it('reads the ledger newest first, with every disposition kept', () => {
    const raised = proposeNewFact(store, harbor.entity('Ilse Renn').id, {
      statement: 'Ilse Renn has never left the station in four years.',
    })
    createProposalRulings(store, events).reject(raised.id, { note: 'Not yet — ep02 decides it.' })

    const ledger = library().bench.ledger
    expect(ledger).toEqual(canonBenchView(store, harbor.show.id)!.ledger)
    expect(ledger[0]!.kind).toBe('rejection')
    expect(ledger[0]!.sentence).toContain('Not yet — ep02 decides it.')
    expect(ledger[0]!.sentence).toContain('convened away from a gate')
    expect(ledger.map((ruling) => ruling.seq)).toEqual(
      rulingsOfShow(store, harbor.show.id).map((ruling) => ruling.seq),
    )
  })
})

// ── Provenance, arcs, references ───────────────────────────────────────────────

describe('what an entity page says about the rest of the show', () => {
  it('computes appearances from provenance, never from the standing it declares', () => {
    const page = open('Tobin Wick').entity!

    expect(page.appearances.episodes.map((one) => one.label)).toEqual(['ep01'])
    expect(page.appearances.sentence).toContain('core')
    expect(page.appearances.sentence).toContain('1 of 2')
    // An entity nothing has been written against says so rather than showing an empty row.
    const sefa = open('Sefa Doule').entity!
    expect(sefa.appearances.episodes).toEqual([])
    expect(sefa.appearances.none!.sentence).toContain('provenance')
  })

  it('draws the arcs its episodes pin, and never claims a waypoint has landed', () => {
    const page = open('Tobin Wick').entity!
    const arc = page.arcs[0]!

    expect(arc.name).toBe('What the harbor is for')
    expect(arc.waypoints.map((one) => one.ordinal)).toEqual([1, 2, 3])
    expect(arc.waypoints.filter((one) => one.here).map((one) => one.ordinal)).toEqual([2])
    expect(arc.sentence).toContain('ep01')
    expect(arc.href).toBe(`/arc/${arc.arcId}`)
    // D8 read forwards: a pin is a production decision, and a landing is a ratified fact.
    expect(arc.note).toContain('landing')
  })

  it('says an entity with no references has none, and what a reference is for', () => {
    const page = open('Tobin Wick').entity!
    expect(page.references).toEqual([])
    expect(page.referencesNone!.sentence).not.toBe('')
  })
})

// ── The honest empties ─────────────────────────────────────────────────────────

describe('the three honest empties', () => {
  it('points a show with nothing open at what to do instead of a blank column', () => {
    const view = library()
    expect(view.entity).toBeNull()
    expect(view.nothingOpen.sentence).not.toBe('')
  })

  it('says a sheet with nothing behind it has nothing behind it', () => {
    const page = open('Tobin Wick').entity!

    // Every row he carries is standing, so the other table is empty — and says so rather
    // than drawing a header over nothing, which is the shape a bench could get away with.
    expect(page.otherRows).toEqual([])
    expect(page.otherRowsNone!.lead).not.toBe('')
    expect(page.otherRowsNone!.sentence).toContain('superseded')

    ratify(
      proposeFactChange(store, factOf('Tobin Wick', 'rigged Grey Harbor'), {
        statement: 'Tobin Wick has rigged the piers for nine years.',
      }).id,
    )
    expect(open('Tobin Wick').entity!.otherRowsNone).toBeNull()
    expect(open('Tobin Wick').entity!.otherRows).toHaveLength(1)
  })

  it('says a factless entity carries none, and why', () => {
    // A kind that requires no edge, so the promotion is ratifiable with an empty sheet —
    // D22's completeness is enforced at ratification, and that is a different test.
    const kind = canonBenchView(store, harbor.show.id)!.create.categories.find(
      (one) => one.required.length === 0,
    )!
    const raised = registerAndPropose(store, harbor.show.id, {
      categoryKey: kind.key,
      name: 'The night clerk',
    })
    ratify(raised.id)

    const page = library({ entityId: raised.entityId }).entity!
    expect(page.facts).toEqual([])
    expect(page.factsNone!.lead).not.toBe('')
    expect(page.factsNone!.sentence).toContain('add')
  })

  it('gives a show before its founding the pointer, in the bench’s own words', () => {
    const second = mkdtempSync(join(tmpdir(), 'showrunner-unfounded-'))
    const other = openLibraryStore(initLibrary(second))
    try {
      const loaded = loadFixture(other, initLibrary(second))
      const view = canonLibraryView(other, loaded.show.id)!

      expect(view.bench.found.enabled).toBe(true)
      expect(view.bench.found.sentence).toContain('Found')
      expect(view.bench.ledger).toEqual([])
      expect(view.ledgerNone!.sentence).not.toBe('')
      // Nothing is canon yet: every sheet is standing in the queue, unruled.
      expect(view.bench.queue.length).toBeGreaterThan(0)
      expect(view.sidebar.flatMap((entry) => entry.entities).every((one) => one.tag !== null)).toBe(
        true,
      )
    } finally {
      other.close()
      rmSync(second, { recursive: true, force: true })
    }
  })

  it('answers nothing at all for a show this library does not have', () => {
    expect(canonLibraryView(store, 'show_nope')).toBeUndefined()
  })
})

// ── The screen's own obligations ───────────────────────────────────────────────

describe('what the screen is handed to render itself with', () => {
  it('names every section and explains it, because SectionHeader refuses one without', () => {
    for (const [key, heading] of Object.entries(library().headings)) {
      expect(heading.name, `${key} has no name`).not.toBe('')
      expect(heading.explains, `${key} has no explanation`).not.toBe('')
    }
  })

  it('carries every form label, because nothing in the browser writes copy', () => {
    for (const [key, label] of Object.entries(library().forms)) {
      expect(label, `${key} is empty`).not.toBe('')
    }
  })

  it('opens the stream where this read was taken from, on floor.ts’s protocol', () => {
    const view = library()
    expect(view.stream.kinds.length).toBeGreaterThan(0)
    expect(view.stream.prose.length).toBeGreaterThan(0)
    expect(view.stream.since).toBeGreaterThanOrEqual(0)
  })

  it('links back to the floor at the address the shell’s own bar uses', () => {
    expect(library().floorHref).toBe('/')
    expect(library().floorName).not.toBe('')
    expect(library().where).toContain(harbor.show.title)
  })

  /** The room's own name, off `cockpit.ts` — the same word the bar and the crumb use. */
  it('is titled what the cockpit calls this room, and not what a section of it is called', () => {
    const view = library()
    expect(view.title).toBe(destinationsOf().find((room) => room.id === 'canon-library')!.name)
    expect(view.title).not.toBe(view.headings.sidebar.name)
  })

  it('finds no entity when the id belongs to another show, rather than showing it', () => {
    const other = findEntityById(store, harbor.entity('Halvani').id)!
    expect(canonLibraryView(store, harbor.show.id, { entityId: other.id })!.entity).not.toBeNull()
    expect(canonLibraryView(store, harbor.show.id, { entityId: 'ent_nope' })!.entity).toBeNull()
  })
})

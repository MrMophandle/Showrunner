import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BENCH_REFUSALS,
  canonBenchView,
  promoteCandidate,
  proposeFactChange,
  proposeNewFact,
  registerAndPropose,
} from './canon-bench.ts'
import { FREE } from './cost.ts'
import type { Store } from './db/store.ts'
import { findEntity } from './domain/canon.ts'
import { canonAsOf, factsOfEntity } from './domain/fact.ts'
import { foundCanon } from './domain/founding.ts'
import { createProposalRulings, type ProposalRulings } from './domain/proposal.ts'
import { findShowByKey } from './domain/spine.ts'
import { createEventLog, eventsSince } from './events.ts'
import { greyHarborFounded } from './fixture/founded.ts'
import { loadFixture } from './fixture/load.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'

/**
 * The canon bench's read model, and the acts it convenes (E2-6).
 *
 * Every sentence asserted here is a rule with a test on it: verb + object + scope + cost on
 * every button, a blocked action carrying its reason in words before the click, and the cost
 * stated as `No model call · $0.00` because nothing on this bench can spend a cent.
 *
 * The two states it must render are the whole epic in miniature. **Unfounded** is what
 * `npm run fixture:load` leaves — seven identities, every one of them a candidate, six
 * promotion proposals standing in the queue and nothing on the ledger, because loading
 * raises and only founding rules (D25). **Founded** is the other side of one deliberate act.
 */

let root: string
let paths: LibraryPaths
let store: Store
let rulings: ProposalRulings

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-bench-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  rulings = createProposalRulings(store, createEventLog(store))
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const showId = (): string => findShowByKey(store, 'greyharbor')!.id
const bench = (standing = {}) => canonBenchView(store, showId(), standing)!

describe('the canon bench — a show that has been loaded and not founded', () => {
  beforeEach(() => {
    loadFixture(store, paths)
  })

  it('renders every sheet as a candidate, with the queue full and the ledger empty', () => {
    const view = bench()

    expect(view.show.key).toBe('greyharbor')
    expect(view.emptyBecause).toBeNull()
    // Visibly unofficial: the status is on the row and the sentence says what it means.
    expect(view.entities.every((entity) => entity.status === 'candidate')).toBe(true)
    expect(view.entities.find((entity) => entity.name === 'Ilse Renn')!.sentence).toContain(
      'is a candidate — an identity registered, and a sheet nobody has ruled on',
    )
    expect(view.entities.every((entity) => entity.factCount === 0)).toBe(true)

    // Loading raises and stops. Six sheets on the queue; nothing ruled.
    expect(view.queue).toHaveLength(6)
    expect(view.ledger).toEqual([])
    expect(view.queue.map((proposal) => proposal.kind)).toEqual(Array(6).fill('promotion'))
  })

  it('offers to found the show, states how many sheets that is, and states the cost', () => {
    const view = bench()

    expect(view.found.enabled).toBe(true)
    expect(view.found.blockedBecause).toBeNull()
    expect(view.found.sentence).toBe(
      'Found Grey Harbor — ratify its 6 founding sheets, one ruling each on the ledger',
    )
    expect(view.found.sentence).not.toMatch(/\b(Launch|Run|Go|Do|Start)\b/)
    expect(view.found.cost).toBe('No model call · $0.00')
  })

  it('gives every proposal in the queue three verbs, each free, each stating its own scope', () => {
    const ilse = bench().queue.find((proposal) => proposal.entityName === 'Ilse Renn')!

    expect(ilse.sentence).toBe(
      'promotion · “Ilse Renn” — raised by the loader, off a sheet on disk, riding nothing',
    )
    expect(ilse.ratify.sentence).toBe(
      'Ratify the “Ilse Renn” promotion — this, and only this, writes it into canon',
    )
    expect(ilse.reject.sentence).toContain('with your note')
    expect(ilse.defer.sentence).toContain('parks it')
    expect([ilse.ratify.cost, ilse.reject.cost, ilse.defer.cost]).toEqual([FREE, FREE, FREE])
    expect([ilse.ratify.enabled, ilse.reject.enabled, ilse.defer.enabled]).toEqual([
      true,
      true,
      true,
    ])

    // The five parts, on the page: the change, the context, the implications, the
    // alternatives. Implications are computed at read time and never stored (1.2).
    expect(ilse.change.some((line) => line.startsWith('sheet · standing'))).toBe(true)
    expect(ilse.change.some((line) => line.startsWith('edge · species → Halvani'))).toBe(true)
    expect(ilse.change.some((line) => line.startsWith('fact · “'))).toBe(true)
    expect(ilse.usageContext).toContain('canon/character/ilse-renn.md')
    // Reach, not a verdict: ep01 is already written against her, and its declared arc
    // position is in the blast. Nothing is ratified yet, so no fact is touched.
    expect(ilse.implications).toBe(
      'brushes 1 arc (“What the harbor is for” waypoint 2), 1 prior episode reads on it',
    )
    expect(ilse.alternatives.length).toBeGreaterThan(0)
  })

  it('says an empty library has nothing to found rather than offering to found nothing', () => {
    const empty = openLibraryStore(initLibrary(mkdtempSync(join(tmpdir(), 'showrunner-none-'))))
    try {
      expect(canonBenchView(empty, 'show_nope')).toBeUndefined()
    } finally {
      empty.close()
    }
  })
})

describe('the canon bench — the show, founded', () => {
  it('turns the sheets into canon and leaves the button saying there is nothing left', () => {
    const harbor = greyHarborFounded(store, paths)
    const view = bench()

    const ilse = view.entities.find((entity) => entity.name === 'Ilse Renn')!
    expect(ilse.status).toBe('active')
    expect(ilse.sentence).toBe('“Ilse Renn” is canon — active, standing core.')
    expect(ilse.factCount).toBeGreaterThan(0)

    expect(view.queue).toEqual([])
    expect(view.found.enabled).toBe(false)
    expect(view.found.blockedBecause).toContain('no founding sheets left to rule')
    expect(view.found.cost).toBe(FREE)

    // One ruling per sheet, individually recorded — founding is not a bulk write (D25).
    expect(view.ledger).toHaveLength(harbor.founding.founded.length)
    expect(view.ledger).toHaveLength(6)
  })

  it('leaves the candidate a candidate, visibly, and offers to promote it', () => {
    greyHarborFounded(store, paths)
    const sefa = bench().entities.find((entity) => entity.name === 'Sefa Doule')!

    expect(sefa.status).toBe('candidate')
    expect(sefa.factCount).toBe(0)
    expect(sefa.promote.enabled).toBe(true)
    expect(sefa.promote.sentence).toBe(
      'Promote Sefa Doule — raise the sheet below as a promotion proposal, for your own ruling in the queue',
    )
    expect(sefa.promote.cost).toBe(FREE)
  })

  it('renders one entity’s facts with their status and their lineage', () => {
    const harbor = greyHarborFounded(store, paths)
    const view = bench({ entityId: harbor.entity('Ilse Renn').id })
    const entity = view.entity!

    expect(entity.name).toBe('Ilse Renn')
    expect(entity.body).not.toBe('')
    expect(entity.facts.length).toBeGreaterThan(0)
    expect(entity.facts.every((fact) => fact.status === 'ratified')).toBe(true)
    expect(entity.facts[0]!.lineage).toMatch(
      /^established with no episode — a founding sheet.*· ratified at ruling \d+ · \d{4}-\d{2}-\d{2}T/,
    )
    // Its edges, and what the category declares about them (D22, D23).
    expect(entity.relations.map((relation) => relation.sentence)).toContain(
      'species → Halvani · exactly-one, required · facts travel it (D22)',
    )
    // And the change form's precondition, before anything is typed into it.
    expect(entity.facts[0]!.propose.enabled).toBe(true)
    expect(entity.facts[0]!.propose.sentence).toContain('carrying this fact as its before')
    expect(entity.facts[0]!.propose.cost).toBe(FREE)
  })

  it('refuses a promotion of something already canon, in the words the button shows', () => {
    const harbor = greyHarborFounded(store, paths)
    const ilse = harbor.entity('Ilse Renn')
    const onScreen = bench().entities.find((entity) => entity.name === 'Ilse Renn')!.promote

    expect(onScreen.enabled).toBe(false)
    expect(onScreen.blockedBecause).toContain('is already active canon')
    expect(() => promoteCandidate(store, ilse.id)).toThrowError(onScreen.blockedBecause!)
  })
})

describe('the canon bench — creating is proposing', () => {
  it('registers a candidate and raises its promotion, and writes no canon at all', () => {
    greyHarborFounded(store, paths)

    const proposal = registerAndPropose(
      store,
      showId(),
      { categoryKey: 'character', name: 'Ottilie Bray' },
      {
        standing: 'recurring',
        facts: ['Ottilie Bray keeps the harbour’s only working lathe.'],
        relations: [{ type: 'species', to: 'unknown' }],
      },
    )

    const entity = findEntity(store, {
      showId: showId(),
      categoryKey: 'character',
      name: 'Ottilie Bray',
    })!
    // The identity is there and is visibly unofficial; the sheet is a proposal.
    expect(entity.status).toBe('candidate')
    expect(entity.standing).toBeNull()
    expect(proposal.status).toBe('raised')

    const view = bench({ entityId: entity.id })
    expect(view.entity!.facts).toEqual([])
    expect(view.queue.map((each) => each.id)).toEqual([proposal.id])
    expect(view.queue[0]!.sentence).toContain('raised by you, at the bench')

    // And ruling it is what makes it canon.
    rulings.ratify(proposal.id, { note: 'she has been in the background for six episodes.' })
    const after = bench({ entityId: entity.id })
    expect(after.entity!.status).toBe('active')
    expect(after.entity!.standing).toBe('recurring')
    expect(after.entity!.facts.map((fact) => fact.statement)).toEqual([
      'Ottilie Bray keeps the harbour’s only working lathe.',
    ])
  })

  it('refuses a name that is already a character in this show, and a name that is blank', () => {
    greyHarborFounded(store, paths)

    expect(() =>
      registerAndPropose(store, showId(), { categoryKey: 'character', name: 'Ilse Renn' }),
    ).toThrowError(/already a character in Grey Harbor/)
    expect(() =>
      registerAndPropose(store, showId(), { categoryKey: 'character', name: '  ' }),
    ).toThrowError(BENCH_REFUSALS.entityNeedsName)
    expect(() =>
      registerAndPropose(store, showId(), { categoryKey: 'starship', name: 'The Kestrel' }),
    ).toThrowError(/declares no `starship` category/)
  })

  it('promotes the candidate, and `unknown` is what satisfies the required species (D22)', () => {
    greyHarborFounded(store, paths)
    const sefa = findEntity(store, {
      showId: showId(),
      categoryKey: 'character',
      name: 'Sefa Doule',
    })!

    // Raised with no edge at all: legal to raise, and refused at ratification, because a
    // candidate may be ragged and canon may not.
    const ragged = promoteCandidate(store, sefa.id, { standing: 'recurring' })
    expect(() => rulings.ratify(ragged.id)).toThrowError(/cannot become canon without a `species`/)
    rulings.defer(ragged.id, { note: 'no species on it.' })

    const promotion = promoteCandidate(store, sefa.id, {
      standing: 'recurring',
      aliases: ['the assessor'],
      facts: ['Sefa Doule files against the line office’s ledger, not the harbour’s.'],
      relations: [{ type: 'species', to: 'unknown' }],
    })
    rulings.ratify(promotion.id, { note: 'he is in ep03; put him on the books.' })

    const view = bench({ entityId: sefa.id })
    expect(view.entity!.status).toBe('active')
    expect(view.entity!.aliases).toEqual(['the assessor'])
    expect(view.entity!.relations[0]!.sentence).toContain('species → unknown')
    expect(view.entity!.facts).toHaveLength(1)
  })

  it('refuses a second promotion while one is standing unruled, in the words the button showed', () => {
    greyHarborFounded(store, paths)
    const sefa = findEntity(store, {
      showId: showId(),
      categoryKey: 'character',
      name: 'Sefa Doule',
    })!
    promoteCandidate(store, sefa.id, { relations: [{ type: 'species', to: 'unknown' }] })

    const onScreen = bench().entities.find((entity) => entity.name === 'Sefa Doule')!.promote
    expect(onScreen.enabled).toBe(false)
    expect(onScreen.blockedBecause).toContain('already has a promotion standing in the queue')
    expect(() => promoteCandidate(store, sefa.id)).toThrowError(onScreen.blockedBecause!)
  })
})

describe('the canon bench — changing a ratified fact, and reading canon on either side of it', () => {
  it('flips the fact’s value across the ruling that changed it (D9)', () => {
    const harbor = greyHarborFounded(store, paths)
    const ilse = harbor.entity('Ilse Renn')

    const before = bench({ entityId: ilse.id }).entity!.facts[0]!
    const proposal = proposeFactChange(store, before.id, {
      statement: 'Ilse Renn has not left the station in eleven years.',
      usageContext: 'ep03 needs the number, and nine was written before the gap year.',
    })

    // Raised, and nothing has changed yet: a proposal is not a ruling.
    expect(bench({ entityId: ilse.id }).entity!.facts.map((fact) => fact.statement)).toContain(
      before.statement,
    )
    expect(bench().queue[0]!.implications).toContain('touches 1 ratified fact')

    rulings.ratify(proposal.id, { note: 'eleven. the gap year counts.' })
    const at = bench().ledger[0]!.seq

    // As of now: the new statement stands, and the old one is superseded rather than gone.
    const now = bench({ entityId: ilse.id }).entity!
    expect(now.facts.map((fact) => fact.statement)).toContain(
      'Ilse Renn has not left the station in eleven years.',
    )
    expect(now.facts.map((fact) => fact.statement)).not.toContain(before.statement)
    expect(now.history.find((fact) => fact.id === before.id)!.status).toBe('superseded')

    // As of the ruling before it: the old statement, standing. The whole point of D9.
    const then = bench({ entityId: ilse.id, ruling: at - 1 }).entity!
    expect(then.facts.map((fact) => fact.statement)).toContain(before.statement)
    expect(then.facts.map((fact) => fact.statement)).not.toContain(
      'Ilse Renn has not left the station in eleven years.',
    )
    // And as of the ruling itself, the successor is already in — the range is half-open.
    const at_ = bench({ entityId: ilse.id, ruling: at }).entity!
    expect(at_.facts.map((fact) => fact.statement)).toContain(
      'Ilse Renn has not left the station in eleven years.',
    )
  })

  it('states where the point-in-time control stands, by ruling and by date', () => {
    const harbor = greyHarborFounded(store, paths)
    const at = bench().ledger[0]!.seq

    expect(bench().asOf.sentence).toContain('Canon as of now')
    expect(bench({ ruling: at }).asOf.sentence).toContain(`Canon as of ruling ${at}`)
    expect(bench({ ruling: at }).asOf.sentence).toContain('half-open')

    // A date maps onto a ruling, never the reverse — and a bare date means the END of that
    // day, or every ruling made on the day it names would sit after it.
    const today = bench().ledger[0]!.at.slice(0, 10)
    expect(bench({ date: today }).asOf.sentence).toContain(`which is ruling ${at}`)
    expect(bench({ date: '2020-01-01' }).asOf.sentence).toContain('canon was empty')
    // And it means it: before the first ruling, an entity that is canon today carried none.
    const ilse = harbor.entity('Ilse Renn').id
    expect(bench({ date: '2020-01-01', entityId: ilse }).entity!.facts).toEqual([])
    expect(bench({ entityId: ilse }).entity!.facts.length).toBeGreaterThan(0)

    // The control's own options are short enough to be options, and carry the moment.
    expect(bench().asOf.choices[0]!.label).toMatch(
      /^ruling \d+ · ratification · \d{4}-\d{2}-\d{2} — the “.+” promotion$/,
    )
  })

  it('says why a claim that is not ratified canon cannot be changed', () => {
    greyHarborFounded(store, paths)
    const sefa = findEntity(store, {
      showId: showId(),
      categoryKey: 'character',
      name: 'Sefa Doule',
    })!
    const promotion = promoteCandidate(store, sefa.id, {
      facts: ['Sefa has not said what the assessment is for.'],
      relations: [{ type: 'species', to: 'unknown' }],
    })
    rulings.ratify(promotion.id)

    const fact = bench({ entityId: sefa.id }).entity!.facts[0]!
    const second = proposeFactChange(store, fact.id, { statement: 'Sefa said, in ep04.' })
    rulings.ratify(second.id, { note: 'he says it.' })

    const closed = bench({ entityId: sefa.id }).entity!.history.find(
      (each) => each.id === fact.id,
    )!
    expect(closed.propose.enabled).toBe(false)
    expect(closed.propose.blockedBecause).toContain('is no longer what canon says')
    expect(() => proposeFactChange(store, fact.id, { statement: 'a third' })).toThrowError(
      closed.propose.blockedBecause!,
    )
    expect(() =>
      proposeFactChange(store, bench({ entityId: sefa.id }).entity!.facts[0]!.id, {
        statement: '   ',
      }),
    ).toThrowError(BENCH_REFUSALS.changeNeedsStatement)
  })
})

describe('the canon bench — adding a fact the entity does not have (#39)', () => {
  const LATHE = 'Ottilie Bray keeps the harbour’s only working lathe.'

  /**
   * Ottilie Bray as the drill left her: created with the facts box empty, her promotion
   * ruled, and canon with nothing on it. A change form anchors to a fact that exists, so
   * before #39 she was unreachable by every affordance this bench had.
   */
  const ottilie = () => {
    const promotion = registerAndPropose(
      store,
      showId(),
      { categoryKey: 'character', name: 'Ottilie Bray' },
      { standing: 'recurring', relations: [{ type: 'species', to: 'unknown' }] },
    )
    rulings.ratify(promotion.id, { note: 'she has been in the background for six episodes.' })
    return findEntity(store, { showId: showId(), categoryKey: 'character', name: 'Ottilie Bray' })!
  }

  beforeEach(() => {
    greyHarborFounded(store, paths)
  })

  it('offers the form on an entity carrying no facts at all', () => {
    const entity = ottilie()
    const view = bench({ entityId: entity.id }).entity!

    expect(view.facts).toEqual([])
    expect(view.addFact.enabled).toBe(true)
    expect(view.addFact.blockedBecause).toBeNull()
    expect(view.addFact.sentence).toBe(
      'Propose a new fact for Ottilie Bray — a fact delta with no before, for your ruling in ' +
        'the queue',
    )
    expect(view.addFact.sentence).not.toMatch(/\b(Launch|Run|Go|Do|Start)\b/)
    expect(view.addFact.cost).toBe(FREE)
  })

  it('writes no fact anywhere while the proposal is standing on the queue', () => {
    const entity = ottilie()
    const proposal = proposeNewFact(store, entity.id, {
      field: 'trade',
      statement: LATHE,
      usageContext: 'ep05 has her turning a part, and canon has never said she could.',
    })

    // An addition comes off the canon surface, not out of an episode's production, so it
    // rides nothing — and a proposal riding nothing writes no provisional claim either.
    // Nothing exists until the ruling (invariant 1).
    expect(proposal.episodeId).toBeNull()
    expect(factsOfEntity(store, entity.id)).toEqual([])
    expect(canonAsOf(store, { entityId: entity.id }, 'now')).toEqual([])

    const view = bench({ entityId: entity.id })
    expect(view.entity!.facts).toEqual([])
    expect(view.entity!.history).toEqual([])

    // And it rides the queue like every other proposal, with the same three verbs on it.
    const queued = view.queue.find((each) => each.id === proposal.id)!
    expect(queued.kind).toBe('fact-delta')
    expect(queued.status).toBe('raised')
    expect(queued.sentence).toBe(
      'fact delta · “Ottilie Bray” — raised by you, at the bench, riding nothing',
    )
    expect(queued.change).toEqual([`fact · trade: “${LATHE}”`])
    expect(queued.implications).toBe('touches nothing ratified yet')
    expect([queued.ratify.enabled, queued.reject.enabled, queued.defer.enabled]).toEqual([
      true,
      true,
      true,
    ])
  })

  it('writes the fact with lineage, and with no establishing episode, when it is ratified', () => {
    const entity = ottilie()
    const proposal = proposeNewFact(store, entity.id, { statement: LATHE })
    rulings.ratify(proposal.id, { note: 'yes — she turns the part in ep05.' })

    const view = bench({ entityId: entity.id }).entity!
    expect(view.facts.map((fact) => fact.statement)).toEqual([LATHE])
    expect(view.facts[0]!.status).toBe('ratified')
    expect(view.facts[0]!.lineage).toMatch(
      /^established with no episode — a founding sheet, or a change ruled at the bench · ratified at ruling \d+ · \d{4}-\d{2}-\d{2}T/,
    )
    // No before, so nothing was closed: the sheet gained a row rather than replacing one.
    expect(view.history).toEqual([])

    const written = factsOfEntity(store, entity.id)[0]!
    expect(written.establishedIn).toBeNull()
    expect(written.ratifiedBy).toBe(bench().ledger[0]!.seq)
  })

  it('shows the fact absent before that ruling and present as of it (D9)', () => {
    const entity = ottilie()
    const proposal = proposeNewFact(store, entity.id, { statement: LATHE })
    rulings.ratify(proposal.id, { note: 'yes.' })
    const at = bench().ledger[0]!.seq

    expect(canonAsOf(store, { entityId: entity.id }, { ruling: at - 1 })).toEqual([])
    expect(
      canonAsOf(store, { entityId: entity.id }, { ruling: at }).map((fact) => fact.statement),
    ).toEqual([LATHE])

    // And through the bench's own point-in-time control, which is what Ryan reads it by.
    expect(bench({ entityId: entity.id, ruling: at - 1 }).entity!.facts).toEqual([])
    expect(
      bench({ entityId: entity.id, ruling: at }).entity!.facts.map((fact) => fact.statement),
    ).toEqual([LATHE])
  })

  it('refuses an addition to a candidate, in the words the disabled button shows', () => {
    const sefa = findEntity(store, {
      showId: showId(),
      categoryKey: 'character',
      name: 'Sefa Doule',
    })!
    const onScreen = bench({ entityId: sefa.id }).entity!.addFact

    expect(onScreen.enabled).toBe(false)
    expect(onScreen.blockedBecause).toContain('is a candidate')
    expect(() =>
      proposeNewFact(store, sefa.id, { statement: 'Sefa Doule files against the line office.' }),
    ).toThrowError(onScreen.blockedBecause!)
  })

  it('refuses an addition with nothing typed in it', () => {
    const entity = ottilie()

    expect(() => proposeNewFact(store, entity.id, { statement: '   ' })).toThrowError(
      BENCH_REFUSALS.additionNeedsStatement,
    )
    expect(factsOfEntity(store, entity.id)).toEqual([])
  })
})

describe('the canon bench — where a ruling is read back from', () => {
  it('puts all three dispositions on the ledger and writes no event for any of them', () => {
    loadFixture(store, paths)
    const before = eventsSince(store, 0).length

    const queue = bench().queue
    rulings.ratify(queue[0]!.id, { note: 'yes.' })
    rulings.reject(queue[1]!.id, { note: 'not this one — the harbour has no faction yet.' })
    rulings.defer(queue[2]!.id, { note: 'later.' })

    const ledger = bench().ledger
    expect(ledger.map((ruling) => ruling.kind)).toEqual(['deferral', 'rejection', 'ratification'])
    expect(ledger[2]!.sentence).toMatch(/^ruling \d+ · ratification — the “.+” promotion · “yes\.”/)
    expect(ledger.every((ruling) => ruling.sentence.endsWith('convened at the bench, no gate'))).toBe(
      true,
    )

    // The Live panel stays runs-and-gates: a bench ruling convenes no gate, so `announce`
    // writes nothing, and the ledger is where it is read back from (#29, ruled Aug 7 2026).
    expect(eventsSince(store, 0)).toHaveLength(before)
  })

  it('shows the founding as one ruling per sheet, newest first', () => {
    loadFixture(store, paths)
    foundCanon(store, showId())

    const ledger = bench().ledger
    expect(ledger).toHaveLength(6)
    expect(ledger.map((ruling) => ruling.seq)).toEqual(
      [...ledger.map((ruling) => ruling.seq)].sort((a, b) => b - a),
    )
    expect(ledger.every((ruling) => ruling.kind === 'ratification')).toBe(true)
    expect(ledger[0]!.note).toBe('founded Grey Harbor from its sheets')
  })

  it('closes all three verbs once a proposal is ruled, and says why', () => {
    loadFixture(store, paths)
    const first = bench().queue[0]!
    rulings.ratify(first.id, { note: 'yes.' })

    // The queue holds unruled proposals only, so this is read back through the entity's own
    // view: a proposal is ruled once, and a later opinion is a new proposal (3.3).
    expect(bench().queue.map((proposal) => proposal.id)).not.toContain(first.id)
    expect(() => rulings.ratify(first.id)).toThrowError(/a proposal is ruled once/)
  })
})

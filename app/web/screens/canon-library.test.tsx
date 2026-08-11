// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonBenchView,
  proposeFactChange,
  proposeNewFact,
  registerAndPropose,
} from '../../server/canon-bench.ts'
import { canonLibraryView, type CanonLibraryView } from '../../server/canon-library.ts'
import type { Store } from '../../server/db/store.ts'
import { factsOfEntity } from '../../server/domain/fact.ts'
import { createProposalRulings } from '../../server/domain/proposal.ts'
import { createEventLog, type EventLog } from '../../server/events.ts'
import { greyHarborFounded, type FoundedFixture } from '../../server/fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../../server/library.ts'
import { heldStill, stillTheSameNode } from '../chrome/held-still.ts'
import {
  CanonLibraryScreen,
  EMPTY_LIBRARY_DRAFT,
  type LibraryDraft,
} from './CanonLibrary.tsx'

/**
 * **The canon library, in a real DOM, with a founded show under it** (E5-4, #84).
 *
 * `canon-library.test.ts` proves the sentences are right. This proves the SCREEN: that the
 * sidebar is drawn from the show's own kinds of canon, that the point-in-time control changes
 * what the facts table says across a real ruling boundary, that inheritance and the three
 * kinds of nothing render as the different things they are, that a ruling landing moves the
 * page in place under a reading eye — and that the browser writes not one word of it.
 *
 * `chrome.css` AND `canon-library.css` are read off disk and put in the document, because
 * `held-still.ts` asks the CSSOM whether a box can grow.
 */

const CHROME = readFileSync(join(import.meta.dirname, '..', 'chrome', 'chrome.css'), 'utf8')
const LIBRARY = readFileSync(join(import.meta.dirname, 'canon-library.css'), 'utf8')

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

let host: HTMLElement
let root: Root
let volume: string
let paths: LibraryPaths
let store: Store
let events: EventLog
let harbor: FoundedFixture

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  for (const css of [CHROME, LIBRARY]) {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)

  volume = mkdtempSync(join(tmpdir(), 'showrunner-library-screen-'))
  paths = initLibrary(volume)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  events = createEventLog(store)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.head.replaceChildren()
  store.close()
  rmSync(volume, { recursive: true, force: true })
})

const read = (standing: Parameters<typeof canonLibraryView>[2] = {}): CanonLibraryView =>
  canonLibraryView(store, harbor.show.id, standing)!

const sheetOf = (name: string, standing: Record<string, unknown> = {}): CanonLibraryView =>
  read({ entityId: harbor.entity(name).id, ...standing })

const factOf = (name: string, needle: string): string =>
  factsOfEntity(store, harbor.entity(name).id).find((fact) => fact.statement.includes(needle))!.id

const ratify = (proposalId: string): number =>
  createProposalRulings(store, events).ratify(proposalId, { note: 'ruled at the library' })
    .disposition!.seq

function render(node: React.ReactNode): void {
  act(() => root.render(node))
}

/** The screen over one read, with nothing arriving and nothing typed. */
function still(view: CanonLibraryView, draft: LibraryDraft = EMPTY_LIBRARY_DRAFT): void {
  render(
    <div className="wrap" data-room="canon-library">
      <CanonLibraryScreen
        view={view}
        draft={draft}
        asOf={{ ruling: '', date: '' }}
        busy={null}
        problem={null}
        onDraft={() => {}}
        onAsOf={() => {}}
        onFound={() => {}}
        onCreate={() => {}}
        onPromote={() => {}}
        onPropose={() => {}}
        onAddFact={() => {}}
        onRuleProposal={() => {}}
      />
    </div>,
  )
}

/**
 * The screen as the app wires it: it re-reads the whole view after an act, exactly as
 * `CanonLibrary`'s own `act` does with `fetch` taken out. A canon ruling convenes no gate and
 * no run, so it is read back off the ledger rather than off the event stream (#29).
 */
function Harness({ entityId, onReady }: { entityId: string; onReady(reload: () => void): void }) {
  const [view, setView] = useState<CanonLibraryView>(() => read({ entityId }))
  onReady(() => setView(read({ entityId })))

  return (
    <div className="wrap" data-room="canon-library">
      <CanonLibraryScreen
        view={view}
        draft={EMPTY_LIBRARY_DRAFT}
        asOf={{ ruling: '', date: '' }}
        busy={null}
        problem={null}
        onDraft={() => {}}
        onAsOf={() => {}}
        onFound={() => {}}
        onCreate={() => {}}
        onPromote={() => {}}
        onPropose={() => {}}
        onAddFact={() => {}}
        onRuleProposal={() => {}}
      />
    </div>
  )
}

const library = () => host.querySelector('.lib')!

// ── Trap 1 · the sidebar is a query ─────────────────────────────────────────────

describe('the sidebar is drawn from the show’s own kinds of canon', () => {
  it('renders one entry per kind, with what it holds and what reads it', () => {
    const view = read()
    still(view)

    const kinds = [...host.querySelectorAll('.lib-kind')]
    expect(kinds).toHaveLength(view.sidebar.length)
    expect(kinds.map((kind) => kind.querySelector('.lib-kind__label')!.textContent)).toEqual(
      view.sidebar.map((entry) => entry.name),
    )
    // The check column, on the entry itself — a kind of canon that fires on nothing says so.
    expect(kinds[0]!.querySelector('.lib-kind__checks')!.textContent).toBe(view.sidebar[0]!.checks)
  })

  it('links every identity at its own address, and marks the one nobody has ruled', () => {
    const view = read()
    still(view)

    const sefa = harbor.entity('Sefa Doule')
    const link = host.querySelector(`a[href="/canon/${sefa.id}"]`)!
    expect(link.textContent).toContain('Sefa Doule')
    expect(link.getAttribute('title')).toContain('candidate')
    // Visibly unofficial, and said in a word rather than only in a colour.
    expect(link.querySelector('.lib-entity__tag')!.textContent).toBe('candidate')
    // …and an entity that is plain active canon wears no tag at all.
    const tobin = host.querySelector(`a[href="/canon/${harbor.entity('Tobin Wick').id}"]`)!
    expect(tobin.querySelector('.lib-entity__tag')).toBeNull()
  })

  it('grows an entry when a kind of canon is declared, with no change to this file', () => {
    const before = host.querySelectorAll('.lib-kind').length
    still(read())
    const started = host.querySelectorAll('.lib-kind').length

    store.run(
      "INSERT INTO canon_category (id, show_id, key, name, blurb) VALUES ('cat_x', ?, 'faction', 'Factions', 'who wants what')",
      harbor.show.id,
    )
    registerAndPropose(store, harbor.show.id, { categoryKey: 'faction', name: 'The line office' })
    still(read())

    expect(before).toBe(0)
    expect(host.querySelectorAll('.lib-kind')).toHaveLength(started + 1)
    expect(library().textContent).toContain('Factions')
    expect(library().textContent).toContain('The line office')
  })
})

// ── Trap 2 · the point-in-time control provably moves ───────────────────────────

describe('the point-in-time control changes what the facts table says', () => {
  it('drops a fact that was ratified after the setting, and brings it back at it', () => {
    const before = factOf('Tobin Wick', 'rigged Grey Harbor')
    const at = ratify(
      proposeFactChange(store, before, {
        statement: "Tobin Wick has rigged Grey Harbor's piers for nine years.",
      }).id,
    )

    still(sheetOf('Tobin Wick', { ruling: at - 1 }))
    const earlier = host.querySelector('.lib-facts')!.textContent!
    expect(earlier).toContain('six years')
    expect(earlier).not.toContain('nine years')

    still(sheetOf('Tobin Wick', { ruling: at }))
    const here = host.querySelector('.lib-facts')!.textContent!
    expect(here).toContain('nine years')
    expect(here).not.toContain('six years')
    // The superseded row is not gone — it is in the other table, saying where it went.
    expect(host.querySelector('.lib-other')!.textContent).toContain(`superseded at ruling ${at}`)
  })

  it('offers every ruling on the ledger as a setting, and says what the setting means', () => {
    const view = read()
    still(view)

    const control = host.querySelector('.lib-pit')!
    const options = [...control.querySelectorAll('option')]
    // One per ruling, plus `now`.
    expect(options).toHaveLength(view.bench.ledger.length + 1)
    expect(options[0]!.textContent).toBe(view.forms.asOfNow)
    expect(options[1]!.textContent).toBe(view.bench.ledger[0]!.label)
    expect(control.querySelector('.lib-pit__says')!.textContent).toBe(view.bench.asOf.sentence)
  })

  it('renders a claim riding an episode as riding, never as canon', () => {
    proposeNewFact(store, harbor.entity('Tobin Wick').id, {
      statement: 'Tobin keeps the lock rack stocked himself.',
      episodeId: store.get<{ id: string }>('SELECT id FROM episode ORDER BY number')!.id,
    })
    still(sheetOf('Tobin Wick'))

    expect(host.querySelector('.lib-facts')!.textContent).not.toContain('lock rack stocked')
    const riding = host.querySelector('.lib-fact[data-where="riding"]')!
    expect(riding.textContent).toContain('lock rack stocked')
    expect(riding.querySelector('.tag')!.textContent).toBe('provisional')
  })
})

// ── Trap 3 · lineage, inheritance, and the three nothings ──────────────────────

describe('lineage, inheritance and the three kinds of nothing render as different things', () => {
  it('prints the lineage sentence on every fact, in the wire’s own words', () => {
    const view = sheetOf('Tobin Wick')
    still(view)

    const rows = [...host.querySelectorAll('.lib-body--facts .lib-fact')]
    expect(rows).toHaveLength(view.entity!.facts.length)
    expect(rows.map((row) => row.querySelector('.lib-fact__lineage')!.textContent)).toEqual(
      view.entity!.facts.map((fact) => fact.lineage),
    )
    expect(rows[0]!.textContent).toContain('ratified at ruling')
  })

  it('puts inherited facts in their own table, with the edge they travelled on it', () => {
    still(sheetOf('Tobin Wick'))

    const block = host.querySelector('.lib-inherited[data-case="inherited"]')!
    expect(block).not.toBeNull()
    // D22 made visible: from whom, and across which declared edge.
    expect(block.querySelector('.lib-inherited__via')!.textContent).toContain('Halvani')
    expect(block.querySelector(`a[href="/canon/${harbor.entity('Halvani').id}"]`)).not.toBeNull()
    expect(block.querySelectorAll('.lib-fact').length).toBeGreaterThan(0)
    // …and not one of them is in his own facts table.
    const own = host.querySelector('.lib-facts')!.textContent!
    expect(own).not.toContain('Halvani are comfortable')
  })

  it('draws a declared unknown, an absent declaration and an empty source as three things', () => {
    // The hole: Sefa's sheet says unknown and nobody has ruled it, so there is no edge at all.
    still(sheetOf('Sefa Doule'))
    const hole = host.querySelector('.lib-chip[data-kind="undeclared"]')!
    expect(hole).not.toBeNull()
    expect(host.querySelector('.lib-inherited[data-case="undeclared"]')).not.toBeNull()
    const holeSaid = host.querySelector('.lib-inherited[data-case="undeclared"]')!.textContent!

    // The answer: a promotion ruled with the literal word, which satisfies the requirement.
    const kind = canonBenchView(store, harbor.show.id)!.create.categories.find(
      (one) => one.required.length > 0,
    )!
    const edge = kind.required[0]!
    const raised = registerAndPropose(
      store,
      harbor.show.id,
      { categoryKey: kind.key, name: 'The assessor’s clerk' },
      { relations: [{ type: edge.type, to: edge.unknown }] },
    )
    ratify(raised.id)
    still(read({ entityId: raised.entityId }))

    const answer = host.querySelector('.lib-chip[data-kind="unknown"]')!
    expect(answer.textContent).toContain(edge.unknown)
    const answerSaid = host.querySelector('.lib-inherited[data-case="declared-unknown"]')!.textContent!

    // Three different sentences on screen, for three different pieces of news.
    expect(answerSaid).not.toBe(holeSaid)
    expect(host.querySelector('.lib-chip[data-kind="undeclared"]')).toBeNull()
  })

  it('shows every edge with its inverse, and lands the click on the other entity', () => {
    still(sheetOf('Tobin Wick'))
    const out = host.querySelector('.lib-edge[data-direction="declared"]')!
    expect(out.querySelector(`a[href="/canon/${harbor.entity('Halvani').id}"]`)).not.toBeNull()
    expect(out.textContent).toContain('members')

    // …and from the far end, by the inverse name, which no kind of canon declares (D23).
    still(sheetOf('Halvani'))
    const back = [...host.querySelectorAll('.lib-edge[data-direction="inverse"]')].find((edge) =>
      edge.querySelector(`a[href="/canon/${harbor.entity('Tobin Wick').id}"]`),
    )!
    expect(back, 'nothing points back at Tobin Wick by the inverse name').not.toBeUndefined()
    expect(back.querySelector('.lib-edge__kind')!.textContent).toBe('members')
  })
})

// ── Trap 4 · every door has a home, and every one of them is a sentence ────────

describe('every door the bench opens is on this screen, priced and in words', () => {
  it('states verb, object, scope and cost on every button, and never a bare verb', () => {
    still(sheetOf('Tobin Wick'))

    const buttons = [...host.querySelectorAll('button.btn')]
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button.querySelector('.cost')!.textContent).not.toBe('')
      expect(button.textContent).not.toMatch(/^(Launch|Run|Go|Do)\b/)
    }
  })

  it('offers the addition and a change beside the fact it would replace (#39, 3.3)', () => {
    const view = sheetOf('Tobin Wick')
    still(view)

    expect(host.querySelector('#add-fact')!.textContent).toContain('Tobin Wick')
    const first = view.entity!.facts[0]!
    expect(host.querySelector(`#propose-${first.id}`)!.textContent).toContain(first.statement)
  })

  it('disables what cannot be pressed, in the sentence the API refuses with', () => {
    const view = sheetOf('Tobin Wick')
    still(view)

    // The addition needs its statement, and the refusal is the server's own string.
    const add = host.querySelector('#add-fact button') as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(add.querySelector('.cost')!.textContent).toBe(view.bench.refusals.additionNeedsStatement)

    still(view, {
      ...EMPTY_LIBRARY_DRAFT,
      addition: { field: '', statement: 'Tobin has a second collar on the rack.' },
    })
    expect((host.querySelector('#add-fact button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('promotes a candidate from its own page, and says why canon cannot be promoted', () => {
    still(sheetOf('Sefa Doule'))
    expect((host.querySelector('#promote button') as HTMLButtonElement).disabled).toBe(false)
    expect(host.querySelector('#promote')!.textContent).toContain('Sefa Doule')

    const view = sheetOf('Tobin Wick')
    still(view)
    const blocked = host.querySelector('#promote button') as HTMLButtonElement
    expect(blocked.disabled).toBe(true)
    expect(blocked.querySelector('.cost')!.textContent).toBe(view.entity!.sheet.promote.blockedBecause)
  })

  it('rules the queue one proposal at a time, with all five parts on the card', () => {
    const raised = proposeNewFact(store, harbor.entity('Ilse Renn').id, {
      statement: 'Ilse Renn signs the harbour’s power figures herself.',
    })
    const view = read()
    still(view)

    const card = host.querySelector(`#proposal-${raised.id}`)!
    const waiting = view.bench.queue.find((one) => one.id === raised.id)!
    expect(card.textContent).toContain(waiting.sentence)
    expect(card.textContent).toContain(waiting.usageContext)
    expect(card.textContent).toContain(waiting.implications)
    expect(card.textContent).toContain(waiting.alternatives[0]!)
    expect(card.textContent).toContain(waiting.change[0]!)
    // Three verbs, and there is no fourth that rules the queue in one press.
    const verbs = [...card.querySelectorAll('button.btn')] as HTMLButtonElement[]
    expect(verbs).toHaveLength(3)
    expect(verbs.map((one) => one.disabled)).toEqual([false, true, false])
    expect(verbs[1]!.querySelector('.cost')!.textContent).toBe(view.bench.refusals.rejectNeedsNote)
    expect(library().textContent).not.toContain('Ratify all')
  })

  it('reads the ledger newest first, with every disposition kept', () => {
    const raised = proposeNewFact(store, harbor.entity('Ilse Renn').id, {
      statement: 'Ilse Renn has never left the station in four years.',
    })
    createProposalRulings(store, events).reject(raised.id, { note: 'Not yet — ep02 decides it.' })
    const view = read()
    still(view)

    const rows = [...host.querySelectorAll('.lib-ledger__row')]
    expect(rows).toHaveLength(view.bench.ledger.length)
    expect(rows[0]!.textContent).toContain('Not yet — ep02 decides it.')
    expect(rows[0]!.textContent).toContain('convened away from a gate')
  })

  it('sends the pin and the arc where each is moved, and claims no landing', () => {
    const view = sheetOf('Tobin Wick')
    still(view)

    const arc = host.querySelector('.lib-arc')!
    expect(arc.querySelector(`a[href="/arc/${view.entity!.arcs[0]!.arcId}"]`)).not.toBeNull()
    expect(arc.querySelector('.lib-wp[data-here="true"]')!.textContent).toContain(
      view.entity!.arcs[0]!.waypoints.find((one) => one.here)!.name,
    )
    expect(arc.textContent).toContain('never a landing')
    // Appearances link into the room where an episode's own decisions are made.
    expect(host.querySelector('.lib-appearance')!.getAttribute('href')).toContain('/episode/')
  })
})

// ── Trap 5 · live and honest at library scale ──────────────────────────────────

describe('a ruling landing moves the page in place', () => {
  /**
   * The ruling lands where it always lands — on `canon_ruling` — and the page re-reads. What
   * this asserts is that the five things it moves at once (an identity chip, the facts table,
   * the queue, the ledger, the sidebar's counts) are each inside a box that was already the
   * size it is, so the button Ryan's hand is on does not move by a pixel.
   *
   * His hand is on the add-a-fact door, which sits under the facts table and over the queue:
   * the busiest place on the page, with something changing on both sides of it.
   */
  it('never moves the button Ryan is reaching for when a ruling lands', async () => {
    const tobin = harbor.entity('Tobin Wick')
    const change = proposeFactChange(store, factOf('Tobin Wick', 'rigged Grey Harbor'), {
      statement: "Tobin Wick has rigged Grey Harbor's piers for nine years.",
    })
    proposeNewFact(store, tobin.id, {
      statement: 'Tobin carries the spare collar on the outside of the rack.',
    })

    let reload = (): void => {}
    render(<Harness entityId={tobin.id} onReady={(again) => (reload = again)} />)

    const reading = host.querySelector('#add-fact button.btn')!
    const facts = host.querySelector('.lib-body--facts')!
    const ledger = host.querySelector('.lib-body--ledger')!

    act(() => {
      ratify(change.id)
    })
    await heldStill(library(), reading, () => act(() => reload()))

    // The ruling really landed, and every part of it landed IN the box that was already there.
    expect(host.querySelector('.lib-body--facts')!.textContent).toContain('nine years')
    expect(host.querySelector('.lib-body--other')!.textContent).toContain('superseded at ruling')
    expect(host.querySelector(`#proposal-${change.id}`)).toBeNull()
    expect(host.querySelector('.lib-ledger__row')!.textContent).toContain('ruled at the library')
    stillTheSameNode(facts, host.querySelector('.lib-body--facts'))
    stillTheSameNode(ledger, host.querySelector('.lib-body--ledger'))
  })

  /**
   * The one movement this page allows, and it is the movement Ryan's own hand made: the card
   * he just ruled leaves the queue and the next one comes up to meet him. Reserved space
   * cannot hold a list still through a deletion, and the ratchet does not ask it to — nothing
   * the system does ALONE may change a row's height, and this is not the system alone.
   */
  it('takes the card he ruled out of the queue, and leaves every other card where it was', async () => {
    const tobin = harbor.entity('Tobin Wick')
    const first = proposeNewFact(store, tobin.id, { statement: 'Tobin owns a second collar.' })
    const second = proposeNewFact(store, tobin.id, { statement: 'Tobin sleeps in the lock shed.' })

    let reload = (): void => {}
    render(<Harness entityId={tobin.id} onReady={(again) => (reload = again)} />)
    expect(host.querySelectorAll('.lib-proposal')).toHaveLength(2)

    const reading = host.querySelector(`#proposal-${second.id} button.btn`)!
    act(() => {
      ratify(first.id)
      reload()
    })

    expect(host.querySelector(`#proposal-${first.id}`)).toBeNull()
    // The card he was not looking at is still the same node — his note in it, his scroll
    // position on it, and the focus ring if his hand was there all survive.
    stillTheSameNode(reading, host.querySelector(`#proposal-${second.id} button.btn`))
  })

  it('reserves the space before anything arrives — every region that can change is a fixed box', () => {
    still(sheetOf('Tobin Wick'))

    for (const selector of [
      '.lib-head',
      '.lib-side',
      '.lib-body--facts',
      '.lib-body--other',
      '.lib-body--queue',
      '.lib-body--ledger',
    ]) {
      const box = host.querySelector(selector)
      expect(box, `${selector} is not on the page`).not.toBeNull()
      const height = getComputedStyle(box!).height
      expect(height, `${selector} has no fixed height, so the page can grow above a button`).not.toBe(
        'auto',
      )
      expect(height).not.toBe('')
    }
    // A `max-height` grows the same way and only stops later, which is the same defect.
    expect(LIBRARY).not.toMatch(/max-height\s*:/)
  })

  it('says the three honest empties rather than drawing a blank', () => {
    still(read())
    expect(host.querySelector('.lib-main .empty')!.textContent).toContain(read().nothingOpen.lead)

    still(sheetOf('Sefa Doule'))
    expect(host.querySelector('.lib-body--facts .empty')!.textContent).toContain('candidate')
  })
})

// ── It writes no word ──────────────────────────────────────────────────────────

/**
 * The strongest proof available, and the one every screen in this epic takes: hand it a view
 * of empty strings and see whether anything comes out.
 */
describe('the canon library writes none of its own copy', () => {
  it('renders a blank view blank — every sentence on this screen came down the wire', () => {
    const blank = {
      show: { id: 'show', key: '', title: '' },
      floorHref: '/',
      floorName: '',
      where: '',
      bench: {
        show: { id: 'show', key: '', title: '' },
        asOf: { ruling: null, date: null, sentence: '', choices: [] },
        entities: [],
        entity: null,
        queue: [],
        ledger: [],
        found: { sentence: '', cost: '', enabled: true, blockedBecause: null },
        create: { categories: [], standings: [], blockedBecause: null },
        positions: null,
        refusals: {
          rejectNeedsNote: '',
          entityNeedsName: '',
          changeNeedsStatement: '',
          additionNeedsStatement: '',
        },
        emptyBecause: null,
      },
      sidebar: [],
      entity: null,
      nothingOpen: { lead: '', sentence: '' },
      gaps: [],
      gapsNone: { lead: '', sentence: '' },
      queueNone: { lead: '', sentence: '' },
      ledgerNone: { lead: '', sentence: '' },
      // `explains` may not be blank — the component refuses one, which is E5-0's rule.
      headings: Object.fromEntries(
        [
          'asOf',
          'sidebar',
          'founding',
          'create',
          'queue',
          'ledger',
          'gaps',
          'identity',
          'facts',
          'otherRows',
          'inherited',
          'exceptions',
          'references',
          'relations',
          'appearances',
          'arcs',
          'promote',
          'addFact',
          'open',
        ].map((key) => [key, { name: '', explains: '—' }]),
      ),
      forms: Object.fromEntries(
        [
          'asOfRuling',
          'asOfNow',
          'asOfDate',
          'category',
          'name',
          'standing',
          'standingNotDeclared',
          'aliases',
          'sheetFacts',
          'body',
          'usageContext',
          'changeContext',
          'statement',
          'field',
          'addition',
          'note',
          'columnStatement',
          'columnField',
          'columnStatus',
        ].map((key) => [key, '']),
      ),
      stream: { kinds: [], prose: [], since: 0 },
    } as unknown as CanonLibraryView

    still(blank)
    // The separators are the stylesheet's marks rather than words. Anything else that showed
    // up here would be a sentence this file wrote.
    expect((host.textContent ?? '').replaceAll(/[·—\d]/g, '').trim()).toBe('')
  })
})

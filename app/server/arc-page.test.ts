import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { arcIndexView, arcPageView, type ArcPageView } from './arc-page.ts'
import type { Store } from './db/store.ts'
import {
  arcsOf,
  insertWaypoint,
  positionsOnArc,
  renameWaypoint,
  waypointsOf,
  type Arc,
} from './domain/arc.ts'
import { artifactsOf } from './domain/artifact.ts'
import { landPosition } from './domain/episode-canon.ts'
import { createProposalRulings } from './domain/proposal.ts'
import { createEpisode, episodesOf, seasonsOf } from './domain/spine.ts'
import { waypointCheckFor, waypointChecksFor, WAYPOINT_CHECK_KEY } from './domain/text-check.ts'
import { createEventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'

/**
 * **The arc page's read model** (E5-5, #85; 5.8, D24, D8).
 *
 * The load-bearing test in this file is the one about the drift check: D24 asks the page to
 * teach how the arc is checked, and the only honest way to teach it is with the check's own
 * words. So the assertion is an EQUALITY against what a real run composes — not "contains
 * something about waypoints", which a paraphrase would also satisfy.
 */

let root: string
let paths: LibraryPaths
let store: Store
let harbor: FoundedFixture
let seasonId: string
let ep01: string
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-arc-page-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)

  seasonId = seasonsOf(store, harbor.show.id)[0]!.id
  const episodes = episodesOf(store, seasonId)
  ep01 = episodes[0]!.id
  ep02 = episodes[1]!.id
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const arc = (): Arc => arcsOf(store, harbor.show.id)[0]!
const page = (): ArcPageView => arcPageView(store, arc().id)!
const rulings = () => createProposalRulings(store, createEventLog(store))

function landOn(episodeId: string, ordinal: number): string {
  const waypoint = waypointsOf(store, arc().id).find((one) => one.ordinal === ordinal)!
  return landPosition(store, {
    episodeId,
    arcId: arc().id,
    waypointId: waypoint.id,
    subject: harbor.entity('Ilse Renn').id,
  }).proposal.id
}

// ── Trap 4: the check's own words, never a paraphrase ──────────────────────────

describe('the how-it-is-checked panel renders the drift check’s real composed instructions', () => {
  /**
   * **The equality is the point.** `waypointCheckFor` is what `waypointChecksFor` maps over
   * when a run convenes the check, so if the page rendered a hand-written paragraph — however
   * good — these two strings would differ and this fails. A paraphrase cannot pass.
   */
  it('is byte-identical to what the check composes for the same declared position', () => {
    const position = positionsOnArc(store, arc().id)[0]!
    const subject = waypointCheckFor(store, {
      arc: position.arc,
      waypoint: position.waypoint,
      declaredOrdinal: position.declaredOrdinal,
      declaredAt: position.declaredAt,
    })

    const checked = page().checked
    expect(checked.instructions).toBe(subject.instructions)
    expect(checked.reference).toBe(subject.reference.join('\n'))
    expect(checked.label).toBe(subject.label)
    expect(checked.checkKey).toBe(WAYPOINT_CHECK_KEY)
    expect(checked.none).toBeNull()
  })

  /**
   * And the stronger form: identical to what a REAL RUN would carry. `waypointChecksFor` takes
   * an artifact and is the function the checker step calls; this is the same text, off the same
   * composition, for ep01's actual script.
   */
  it('is the same text a run carries when it checks the ep01 script against this arc', () => {
    const script = artifactsOf(store, ep01).find((one) => one.kind === 'script')!
    const convened = waypointChecksFor(store, script)

    expect(convened).toHaveLength(1)
    const checked = page().checked
    expect(checked.instructions).toBe(convened[0]!.instructions)
    expect(checked.reference).toBe(convened[0]!.reference.join('\n'))
    expect(checked.label).toBe(convened[0]!.label)
  })

  it('carries the arc’s own statement and every waypoint, marked where the episode declared', () => {
    const checked = page().checked

    // The reference is position-specific — this is the marker that makes it a worked example
    // of somebody's pass rather than a generic description.
    expect(checked.reference).toContain('← declared by this episode')
    expect(checked.reference).toContain('This episode declares **waypoint 2**')
    expect(checked.reference).toContain('Ilse Renn keeps Grey Harbor lit')
    for (const waypoint of waypointsOf(store, arc().id)) {
      expect(checked.reference).toContain(`#### Waypoint ${waypoint.ordinal} — ${waypoint.name}`)
      expect(checked.reference).toContain(`- landing criteria: ${waypoint.landingCriteria.trim()}`)
    }

    // And the instructions are D8's, including the line that stops a finding citing a fact.
    expect(checked.instructions).toContain('Behaviour AHEAD of the declared position is a finding')
    expect(checked.instructions).toContain('A waypoint is landed by a proposal Ryan ratifies (D8)')

    expect(checked.composedFor).toContain('composed for ep01 “The Long Pier”')
    expect(checked.composedFor).toContain('declares waypoint 2')
  })

  it('says the check convenes nothing when no episode declares a position, and shows no example', () => {
    store.run('DELETE FROM episode_arc_position')

    const checked = page().checked
    expect(checked.instructions).toBe('')
    expect(checked.reference).toBe('')
    expect(checked.none!.lead).toBe('Nothing convenes it on this arc yet.')
    expect(checked.none!.sentence).toContain('an empty list rather than a check that says so')
    // The prose about HOW it works is still there — the mechanism is true either way.
    expect(checked.sentence).toContain('A finding argues and never decides')
  })
})

// ── The spine, and the four standings ──────────────────────────────────────────

describe('the waypoint spine tells landed from riding from pinned from ahead', () => {
  it('gives only the ratified one a ruling behind it', () => {
    const proposalId = landOn(ep02, 3)
    const ruling = rulings().ratify(proposalId, { note: 'landed.' }).disposition!

    const spine = page().waypoints
    const [one, two, three] = spine

    // wp1: nothing holds it at all.
    expect(one!.standing).toBe('ahead')
    expect(one!.lineage).toBeNull()
    expect(one!.tags.join(' ')).toContain('waypoint 1 of 3 — no episode holds it yet')

    // wp2: ep01's fixture pin, which never landed and never will on its own (E2-4).
    expect(two!.standing).toBe('pinned')
    expect(two!.lineage).toBeNull()
    expect(two!.tags.join(' ')).toContain('declared by ep01 “The Long Pier” — a pin, not a landing')

    // wp3: ratified, so it is canon and carries the ruling canon is read as-of (D9).
    expect(three!.standing).toBe('landed')
    expect(three!.lineage).toBe(`ratified at ruling ${ruling.seq} · ${ruling.at.slice(0, 10)}`)
    expect(three!.tags.join(' ')).toContain('landed in ep02 “Dry Stores”')

    expect(page().standingChip).toBe('landed to waypoint 3 of 3')
  })

  it('calls a landing that rides “riding”, and says ratifying is what makes it canon', () => {
    landOn(ep02, 3)

    const three = page().waypoints[2]!
    expect(three.standing).toBe('riding')
    expect(three.lineage).toBeNull()
    expect(three.tags.join(' ')).toContain('it becomes canon when you ratify it, and not before')
    expect(page().standingChip).toBe('declared to waypoint 3 of 3, and nothing has landed yet')
  })

  it('carries what each waypoint means and what landing it looks like, off the sheet', () => {
    const two = page().waypoints[1]!
    expect(two.name).toBe('The harbor is worth spending on')
    expect(two.description).toContain('Ilse spends something real')
    expect(two.landingCriteria).toContain('she diverts a resource that was committed')
    expect(page().landingLabel).toBe('Landing looks like:')
  })

  /**
   * Inserting a waypoint renumbers the arc, and the episodes that declared a later position
   * are now checked against the wrong place in the order. That is COMPUTED from ordinal drift
   * (`episodesNeedingRecheck`), never a flag, and the arc page is where it is read.
   */
  it('surfaces the re-check drift when a waypoint goes in ahead of a declared position', () => {
    insertWaypoint(store, arc().id, {
      atOrdinal: 1,
      name: 'The harbor is a rumour',
      description: 'before it is even a job',
      landingCriteria: 'nobody mentions the lane at all',
      note: 'there is a step before the roster.',
    })

    const drifted = page().waypoints.find((one) => one.recheck !== null)!
    expect(drifted.name).toBe('The harbor is worth spending on')
    expect(drifted.recheck).toContain('declared waypoint 2')
    expect(drifted.recheck).toContain('a waypoint was inserted ahead of it')
    expect(drifted.recheck).toContain('it is now waypoint 3')
  })
})

// ── The rail ───────────────────────────────────────────────────────────────────

describe('the rail says what the arc is, who touches it, and whether it has gone quiet', () => {
  it('reads the statement as the paragraphs it was written in', () => {
    const view = page()
    expect(view.noStatement).toBeNull()
    expect(view.statement.length).toBeGreaterThan(1)
    expect(view.statement[0]).toContain('Ilse Renn keeps Grey Harbor lit')
    expect(view.statement.at(-1)).toContain('this arc is carried by what she spends')
    expect(view.headings.statement.explains).toContain('the question it asks')
  })

  it('names no entity until a landing has been ratified, and says exactly why', () => {
    const before = page()
    expect(before.entities).toHaveLength(0)
    expect(before.noEntities!.lead).toBe('No entity is named on this arc yet.')
    expect(before.noEntities!.sentence).toContain('an arc is a shape a season makes')
    expect(before.glance.find((row) => row.key === 'Entities')!.value).toContain('none yet')

    rulings().ratify(landOn(ep02, 3), { note: 'landed.' })

    const after = page()
    expect(after.entities.map((one) => one.name)).toEqual(['Ilse Renn'])
    expect(after.noEntities).toBeNull()
    expect(after.glance.find((row) => row.key === 'Entities')!.value).toBe('Ilse Renn')
  })

  it('lists the episodes touching it and says plainly which do not, without calling it a gap', () => {
    const view = page()

    expect(view.episodes).toHaveLength(1)
    expect(view.episodes[0]!.label).toBe('ep01')
    expect(view.episodes[0]!.standing).toBe('pinned')
    expect(view.episodes[0]!.sentence).toContain('which is a pin: a plan, and not canon')
    expect(view.episodes[0]!.href).toBe(`/episode/${ep01}`)

    expect(view.untouchedNote).toContain('ep02 “Dry Stores” does not touch it')
    expect(view.untouchedNote).toContain('That is not a gap in this arc')
    expect(view.headsub).toBe('3 waypoints · touched by 1 episode · nothing landed')
  })

  it('calls an arc nobody has touched untouched rather than cold', () => {
    store.run('DELETE FROM episode_arc_position')

    const view = page()
    expect(view.noEpisodes!.lead).toBe('No episode declares a position on this arc.')
    expect(view.noEpisodes!.sentence).toContain('vanilla, and not every episode advances an arc')
    expect(view.standingChip).toBe('untouched — waypoint 1 of 3 is still ahead')
    expect(view.glance.find((row) => row.key === 'Health')!.value).toContain(
      'no episode declares a position on it, so there is no silence to measure yet',
    )
  })

  it('reads health off the same computation the season map does, and goes cold with it', () => {
    for (let number = 3; number <= 6; number += 1) {
      createEpisode(store, { seasonId, number, title: `Episode ${number}` })
    }

    expect(page().glance.find((row) => row.key === 'Health')!.value).toContain('cold — 5 episodes')
    expect(page().glance.find((row) => row.key === 'Scope')!.value).toBe('season 1')
    expect(page().kindChip).toBe('character · season 1')
  })
})

// ── The record ─────────────────────────────────────────────────────────────────

describe('the history is the arc’s whole record, and a rename keeps Ryan’s note', () => {
  it('carries the edits with their notes, the declarations, and the rulings, newest first', () => {
    renameWaypoint(store, waypointsOf(store, arc().id)[2]!.id, {
      name: 'The harbor is hers, and she says so',
      note: 'the old name was the answer; the new one is the act.',
    })
    rulings().ratify(landOn(ep02, 3), { note: 'she says it to one person. landed.' })

    const history = page().history

    // The rename, with the words — the one place a "why" about an arc survives (D24).
    const renamed = history.find((line) => line.what.includes('renamed'))!
    expect(renamed.what).toContain('“The harbor is hers” renamed to')
    expect(renamed.note).toBe('the old name was the answer; the new one is the act.')

    // The declaration, said as a pin rather than as a landing.
    const declared = history.find((line) => line.what.includes('declared'))!
    expect(declared.when).toContain('a pin, and a landing is a separate ruling')

    // And the ruling, with its seq and Ryan's note.
    const ruled = history.find((line) => line.what.includes('ratified'))!
    expect(ruled.when).toMatch(/^ruling \d+ · \d{4}-\d{2}-\d{2}$/)
    expect(ruled.note).toBe('she says it to one person. landed.')

    // The arc's own creation is at the bottom of it, because the sort is newest first.
    expect(history.at(-1)!.what).toContain('created')
  })
})

// ── The frame ──────────────────────────────────────────────────────────────────

describe('the arc page is reachable, and its bare address is not a dead end', () => {
  it('links back to the floor, to this arc’s own season, and into the canon library', () => {
    const view = page()
    expect(view.floorHref).toBe('/')
    expect(view.seasonHref).toBe(`/season/${seasonId}`)
    expect(view.seasonName).toBe('the season map')
    expect(view.canonHref).toBe('/canon')
  })

  it('is undefined for an arc that is not there', () => {
    expect(arcPageView(store, 'arc_nope')).toBeUndefined()
  })

  it('answers the bare address with every arc in the library, each a sentence that links', () => {
    const index = arcIndexView(store)
    expect(index.empty).toBeNull()
    expect(index.arcs).toHaveLength(1)
    expect(index.arcs[0]!.href).toBe(`/arc/${arc().id}`)
    expect(index.arcs[0]!.sentence).toBe(
      'Grey Harbor · What the harbor is for — character, season 1, 3 waypoints',
    )
  })

  it('says a library with no arc in it is legal, rather than rendering nothing', () => {
    store.run('DELETE FROM episode_arc_position')
    store.run('DELETE FROM arc_waypoint')
    store.run('DELETE FROM arc')

    const index = arcIndexView(store)
    expect(index.arcs).toHaveLength(0)
    expect(index.empty!.lead).toBe('No arc in this library.')
    expect(index.empty!.sentence).toContain('every episode in it is then vanilla')
  })
})

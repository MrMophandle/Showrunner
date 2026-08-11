import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from './db/store.ts'
import { appendWaypoint, createArc, declarePosition, waypointsOf, type Arc } from './domain/arc.ts'
import { landPosition } from './domain/episode-canon.ts'
import { createProposalRulings } from './domain/proposal.ts'
import { arcsOf } from './domain/arc.ts'
import { createEpisode, episodesOf, seasonsOf, type Episode } from './domain/spine.ts'
import { createEventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { COLD_AFTER, seasonMapView, type ArcRow, type SeasonMapView } from './season-map.ts'

/**
 * **The season map's read model** (E5-5, #85; 5.7, D8).
 *
 * `season-map.test.tsx` proves the screen. This proves what it is handed, and the four things
 * it has to get right or the map is a liar at a glance:
 *
 *   1. **A pin and a landing are different inks**, and only the landing carries its ruling.
 *   2. **Cold is computed** off the pins and the episode order — no thread table, no flag —
 *      so a synthetic cold arc goes loud and a freshly touched one stays quiet.
 *   3. **Vanilla is a designed render.** An empty column is tagged, and never a failure state.
 *   4. **Two mechanisms this build does not have say so**, and name the issue that holds each.
 */

let root: string
let paths: LibraryPaths
let store: Store
let harbor: FoundedFixture
let seasonId: string
let ep01: string
let ep02: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-season-map-'))
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

const map = (id: string | null = seasonId): SeasonMapView => seasonMapView(store, id)!

const fixtureArc = (): Arc => arcsOf(store, harbor.show.id)[0]!

const rowFor = (arcId: string, view: SeasonMapView = map()): ArcRow =>
  view.arcs.find((row) => row.arcId === arcId)!

const cell = (row: ArcRow, episodeId: string) =>
  row.cells.find((one) => one.episodeId === episodeId)!

/** The one ruling API, convened here rather than reimplemented — the same one a gate uses. */
const rulings = () => createProposalRulings(store, createEventLog(store))

/**
 * A landing, raised the only way this app raises one: `landPosition` moves the pin AND raises
 * the proposal beside it (D8). The subject is the entity the landing reads on, which a caller
 * always supplies because an arc carries none (E2-3).
 */
function landOn(episodeId: string, ordinal: number, subject = 'Ilse Renn'): string {
  const arc = fixtureArc()
  const waypoint = waypointsOf(store, arc.id).find((one) => one.ordinal === ordinal)!
  return landPosition(store, {
    episodeId,
    arcId: arc.id,
    waypointId: waypoint.id,
    subject: harbor.entity(subject).id,
  }).proposal.id
}

// ── Trap 1: a pin and a landing are different inks ─────────────────────────────

describe('a pin and a landing are different inks, and only one of them is canon', () => {
  /**
   * The fixture's ep01 is the standing example of a pin that never landed, and it is that on
   * purpose: `load.ts` calls `declarePosition` and raises no landing, because a landing needs
   * a subject entity the arc sheet does not carry (E2-4, ruled and unchanged). So the map is
   * founded with one of each and asked to tell them apart.
   */
  it('renders ep01’s fixture pin as a plan and a ratified landing as canon with its ruling', () => {
    const proposalId = landOn(ep02, 3)
    const ruling = rulings().ratify(proposalId, {
      note: 'she says it to one person. landed.',
    }).disposition!

    const row = rowFor(fixtureArc().id)
    const pin = cell(row, ep01).waypoint!
    const landed = cell(row, ep02).waypoint!

    // Two inks, and they are not the same word.
    expect(pin.ink).toBe('pinned')
    expect(landed.ink).toBe('landed')
    expect(pin.ink).not.toBe(landed.ink)

    // The landing carries its lineage — the ruling canon is read as-of, forever (D9).
    expect(landed.lineage).toBe(
      `ratified at ruling ${ruling.seq} · ${ruling.at.slice(0, 10)}`,
    )
    expect(landed.sentence).toContain('You ratified it')
    expect(landed.sentence).toContain('it carries the episode that established it')

    // The pin carries none, and says in words that it is a plan rather than canon.
    expect(pin.lineage).toBeNull()
    expect(pin.sentence).toContain('which is a pin: a plan, and not canon')
    expect(pin.sentence).toContain('No landing proposal stands behind it')
  })

  it('draws a landing that rides and has not been ruled as a third thing, waiting on Ryan', () => {
    landOn(ep02, 3)

    const riding = cell(rowFor(fixtureArc().id), ep02).waypoint!
    expect(riding.ink).toBe('riding')
    expect(riding.lineage).toBeNull()
    expect(riding.sentence).toContain('The checks can see the claim and canon cannot')
    expect(riding.sentence).toContain('A pin is not a landing')
  })

  it('falls back to a pin when a landing is rejected, and says the ruling happened', () => {
    const proposalId = landOn(ep02, 3)
    rulings().reject(proposalId, { note: 'too early — the crew has not paid for it yet.' })

    const after = cell(rowFor(fixtureArc().id), ep02).waypoint!
    expect(after.ink).toBe('pinned')
    expect(after.lineage).toBeNull()
    // A cell that quietly became a plain pin again would hide a ruling Ryan made.
    expect(after.sentence).toContain('Its landing proposal was rejected')
    expect(after.sentence).toContain('too early — the crew has not paid for it yet.')
  })
})

// ── Trap 2: cold is computed, and it is loud ───────────────────────────────────

/**
 * The synthetic cold arc. It is built here rather than leaned on in the fixture for the reason
 * the vanilla test below gives: the fixture is Ryan's to operate, and a test that asserted his
 * library had gone cold would fail the day he wrote an episode.
 */
function aSeasonWithSixEpisodes(): Episode[] {
  const made: Episode[] = []
  for (let number = 3; number <= 6; number += 1) {
    made.push(createEpisode(store, { seasonId, number, title: `Episode ${number}` }))
  }
  return made
}

function anArcCalled(name: string, waypoints: string[]): Arc {
  const arc = createArc(store, {
    showId: harbor.show.id,
    seasonId,
    scope: 'season',
    kind: 'story',
    name,
    statement: `${name} — a statement.`,
  })
  for (const waypoint of waypoints) {
    appendWaypoint(store, arc.id, { name: waypoint, description: 'what it means', landingCriteria: 'what landing looks like' })
  }
  return arc
}

describe('hanging threads are computed off the pins, and a long silence goes loud', () => {
  it('marks the cold arc’s dashed stretch, warns on its label, and names it in the panel', () => {
    aSeasonWithSixEpisodes()
    const cold = anArcCalled('The tow line', ['owed', 'called', 'paid'])
    const first = waypointsOf(store, cold.id)[0]!
    declarePosition(store, { episodeId: ep01, arcId: cold.id, waypointId: first.id })

    const view = map()
    const row = rowFor(cold.id, view)
    const episodes = episodesOf(store, seasonId)

    // Five episodes of silence after ep01, which is well past the threshold.
    const dashed = row.cells.filter((one) => one.cold).map((one) => one.episodeId)
    expect(dashed).toEqual(episodes.slice(1).map((episode) => episode.id))
    expect(dashed.length).toBeGreaterThanOrEqual(COLD_AFTER)

    // Loud on the label, in the season's own units — episodes, never days.
    expect(row.warning).toContain('cold for 5 episodes after ep01')
    // The next waypoint is the first with no RATIFIED landing, and ep01 only ever pinned
    // waypoint 1 — a pin is not a landing, so waypoint 1 is still where this arc goes next.
    expect(row.warning).toContain('waypoint 1 “owed” has not landed')

    // And named in the panel, with both halves of 5.7's sentence.
    const thread = view.threads.find((one) => one.arcId === cold.id)!
    expect(thread.cold).toBe(true)
    expect(thread.heading).toContain('The tow line')
    expect(thread.sentence).toContain('Waypoint 1 “owed” is where “The tow line” goes next')
    expect(thread.sentence).toContain('ep01 “The Long Pier” declares it and stands at script')
    expect(thread.why).toContain('The longest run of episodes declaring no position on it')
    // Two, because adding four episodes left the FIXTURE's arc silent for five as well —
    // which is the computation working rather than a leak: cold is read off the pins and the
    // episode order, so lengthening the season is exactly what makes an untouched arc cold.
    expect(view.meta).toContain('2 hanging threads')
    expect(view.threads.map((one) => one.arcId)).toContain(fixtureArc().id)
  })

  it('leaves a freshly touched arc quiet — no warning, no dashes, and no thread row', () => {
    const later = aSeasonWithSixEpisodes()
    const cold = anArcCalled('The tow line', ['owed', 'called', 'paid'])
    const fresh = anArcCalled('The quarterly', ['filed', 'queried'])

    declarePosition(store, {
      episodeId: ep01,
      arcId: cold.id,
      waypointId: waypointsOf(store, cold.id)[0]!.id,
    })
    // Touched in the season's last episode, so there is no silence behind it at all.
    declarePosition(store, {
      episodeId: later.at(-1)!.id,
      arcId: fresh.id,
      waypointId: waypointsOf(store, fresh.id)[0]!.id,
    })

    const view = map()
    const quiet = rowFor(fresh.id, view)
    expect(quiet.warning).toBeNull()
    expect(quiet.cells.filter((one) => one.cold)).toHaveLength(0)
    expect(view.threads.map((one) => one.arcId)).not.toContain(fresh.id)
    expect(view.threads.map((one) => one.arcId)).toContain(cold.id)
  })

  it('says everything is holding rather than vanishing when no arc has gone cold', () => {
    // The fixture as it stands: one arc, ep01 pinned to it, two episodes in the season.
    const view = map()
    expect(view.arcs.every((row) => row.warning === null)).toBe(true)

    expect(view.threads).toHaveLength(1)
    const only = view.threads[0]!
    expect(only.cold).toBe(false)
    expect(only.heading).toBe('Everything is holding')
    expect(only.sentence).toContain('No arc has gone 3 episodes without an episode declaring')
    expect(only.why).toContain('Nothing in this app remembers that an arc has gone quiet')
    expect(view.meta).toContain('no hanging threads')
  })

  it('does not call a season’s opening episodes silence about an arc that has not started', () => {
    const later = aSeasonWithSixEpisodes()
    const late = anArcCalled('The relief crew', ['promised', 'late'])
    declarePosition(store, {
      episodeId: later.at(-1)!.id,
      arcId: late.id,
      waypointId: waypointsOf(store, late.id)[0]!.id,
    })

    // ep01..ep05 declare nothing on it, and none of them is cold: the arc had not begun.
    expect(rowFor(late.id).cells.filter((one) => one.cold)).toHaveLength(0)
    expect(rowFor(late.id).warning).toBeNull()
  })
})

// ── Trap 2 again: the waypoints nothing holds ──────────────────────────────────

describe('a waypoint no episode holds sits ahead of every column, earmarked to nothing', () => {
  it('lists the unheld waypoints and says why they are not drawn into a column', () => {
    const row = rowFor(fixtureArc().id)

    // The fixture pins waypoint 2 and nothing else, so 1 and 3 are ahead.
    expect(row.ahead.map((one) => one.ordinal)).toEqual(['wp 1', 'wp 3'])
    expect(row.aheadNone).toBeNull()
    expect(row.ahead[0]!.sentence).toContain(
      'assigns a waypoint to an episode in advance',
    )
  })
})

// ── Trap 2's third half: vanilla is a designed render ──────────────────────────

describe('a vanilla episode’s column is a designed render, never a failure state', () => {
  /**
   * **The test brings its own vanilla episode.** The fixture built ep02 for exactly this, and
   * its column now shows whatever Ryan's flow has landed on it — so leaning on ep02 would be a
   * test that failed the day he declared a position from the writing room.
   */
  it('tags the column, counts zero, and says in words that it is legal', () => {
    const mine = createEpisode(store, { seasonId, number: 7, title: 'Slack Tide' })

    const view = map()
    const column = view.episodes.find((one) => one.episodeId === mine.id)!
    expect(column.touches).toBe(0)
    expect(column.vanillaTag).toBe('vanilla')
    expect(column.footNote).toBe('vanilla')

    expect(view.vanillaNote).toContain('ep07 “Slack Tide”')
    expect(view.vanillaNote).toContain('touch no arc')
    expect(view.vanillaNote).toContain('Not every episode advances an arc')
    expect(view.meta).toContain('vanilla')

    // And the episode that DOES touch the arc is not tagged.
    expect(view.episodes.find((one) => one.episodeId === ep01)!.vanillaTag).toBeNull()
    expect(view.episodes.find((one) => one.episodeId === ep01)!.footNote).toBe('1')
  })
})

// ── Trap 3: two honest empty states, and the issues that hold their mechanisms ──

describe('the idea pool and the pitch are honest empty states, and each names its issue', () => {
  /**
   * The mockup gives the idea pool a third of the screen and draws a costed button for the
   * pitch. Neither mechanism exists. A screen that invented `CREATE TABLE idea` to have
   * something to draw is the failure this epic must not normalize, so both say so — and both
   * name the issue, which is the #39 pattern and the reason "when" is one click away.
   */
  it('says there is no idea pool, what would fill it, and links #92', () => {
    const pool = map().pool

    expect(pool.lead).toBe('There is no idea pool in this build.')
    expect(pool.sentence).toContain('premises greenlit, parked or spiked')
    expect(pool.sentence).toContain('no table, no route, no count')
    expect(pool.sentence).toContain('What would fill it is a premise you have had and not written')
    expect(pool.filed).toContain('#92')
    expect(pool.issueHref).toBe('https://github.com/MrMophandle/Showrunner/issues/92')
  })

  it('says there is no pre-episode check, names the NOT NULL that blocks it, and links #93', () => {
    const pitch = map().pitch

    expect(pitch.lead).toBe('There is no pre-episode check in this build.')
    expect(pitch.sentence).toContain('`run.episode_id` is ')
    expect(pitch.sentence).toContain('NOT NULL')
    // No disabled button either: a blocked button says the act exists, and this one does not.
    expect(pitch.sentence).toContain('There is no button here rather than a disabled one')
    expect(pitch.filed).toContain('#93')
    expect(pitch.issueHref).toBe('https://github.com/MrMophandle/Showrunner/issues/93')
  })

  it('offers no verb anywhere on the map — nothing here spends, and nothing here rules', () => {
    // The strongest form: there is no `Offer` on this view at all, so there is no button for a
    // screen to render. A ruling is made where the proposal's five parts are (one artifact,
    // one ruling), and that is the gate room or the completion sweep.
    const said = JSON.stringify(map())
    expect(said).not.toContain('"enabled"')
    expect(said).not.toContain('"blockedBecause"')
  })
})

// ── The frame ──────────────────────────────────────────────────────────────────

describe('the map says which season it is standing in, and never picks one silently', () => {
  it('answers at the bare address with every season listed and one marked current', () => {
    const bare = map(null)

    expect(bare.seasonId).toBe(seasonId)
    expect(bare.seasons).toHaveLength(1)
    expect(bare.seasons[0]!.current).toBe(true)
    expect(bare.seasons[0]!.label).toBe('Grey Harbor · Season 1 “Slack Water”')
    expect(bare.title).toBe('Season 1 “Slack Water” · the map')
    expect(bare.where).toBe('Grey Harbor · the season map')
  })

  it('is undefined for a season that is not there, rather than falling back to another', () => {
    expect(seasonMapView(store, 'season_nope')).toBeNull()
  })

  it('draws the episode columns in season order, with where each one stands', () => {
    const view = map()
    expect(view.episodes.map((one) => one.label)).toEqual(['ep01', 'ep02'])
    expect(view.episodes[0]!.standing).toBe('script')
    expect(view.episodes[0]!.tone).toBe('live')
    expect(view.episodes[1]!.standing).toBe('premise')
    expect(view.episodes[1]!.tone).toBe('planned')
    expect(view.episodes[0]!.href).toBe(`/episode/${ep01}`)
  })

  it('links every arc row at the arc page, which E5-5 built beside it', () => {
    const row = rowFor(fixtureArc().id)
    expect(row.href).toBe(`/arc/${fixtureArc().id}`)
    expect(row.room).toBe('the arc page')
    expect(row.roomNotYet).toBeNull()
    expect(row.kind).toBe('character · season · 3 waypoints')
  })

  it('says a season with no arc in it is a season of vanilla episodes, not a broken one', () => {
    const other = createEpisode(store, { seasonId, number: 8, title: 'Nothing Doing' })
    store.run('DELETE FROM episode_arc_position')
    store.run('DELETE FROM arc_waypoint')
    store.run('DELETE FROM arc')

    const view = map()
    expect(view.arcs).toHaveLength(0)
    expect(view.noArcs!.lead).toBe('No arc runs through this season.')
    expect(view.noArcs!.sentence).toContain('Every episode in it is vanilla')
    expect(view.threads[0]!.heading).toBe('Nothing to hang')
    expect(view.episodes.find((one) => one.episodeId === other.id)!.vanillaTag).toBe('vanilla')
  })
})

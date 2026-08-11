import { destinationsOf, type Destination } from './cockpit.ts'
import type { Store } from './db/store.ts'
import {
  arcsOf,
  positionsOnArc,
  waypointsOf,
  type Arc,
  type ArcTouch,
  type ArcWaypoint,
} from './domain/arc.ts'
import { landingsOfArc, type ArcLanding } from './domain/episode-canon.ts'
import {
  episodeLabel,
  episodesOf,
  seasonsOf,
  shows,
  type Episode,
  type Season,
} from './domain/spine.ts'
import { EVENT_KIND, latestSeq, PROSE_KIND, type EventKind } from './events.ts'
import { count, type FloorHeading } from './floor.ts'
import { openGates } from './runner/gate.ts'

/**
 * **The season map** (E5-5, #85; 5.7, D8; `mockups/season-map.html`) — the season seen whole:
 * episodes as columns, arcs as rows, and every waypoint plotted where an episode put it.
 *
 * ## A pin and a landing are two different inks
 *
 * This is the thing the screen exists to make visible, and getting it wrong would make the map
 * a liar at a glance. An episode **declares a position** on an arc — "ep01 @ waypoint 2" — and
 * that is a production decision: free, moved at the bench, riding nothing (E4-4). A **landing**
 * is a claim about the world, so it is a fact, so it enters through the proposal flow and
 * becomes canon only when Ryan ratifies it — at which point it carries a `canon_ruling.seq`
 * and is answerable as-of forever (D8, D9).
 *
 * So a cell is one of three things and never one word for all three:
 *
 *   * **landed** — the landing proposal was ratified. It carries its ruling, in the cell.
 *   * **riding** — a landing proposal stands and is waiting on Ryan. Amber, which is what
 *     amber means everywhere else in this cockpit: your attention.
 *   * **pinned** — a position declared with no landing standing behind it. A plan.
 *
 * The fixture's ep01 is the standing example of the third: `load.ts` calls `declarePosition`
 * and raises no landing, because a landing needs a subject entity an arc sheet does not carry
 * (E2-4, ruled and unchanged). The map says so in the cell's own sentence rather than drawing
 * it as though the harbor had reached waypoint 2.
 *
 * ## Hanging threads are computed, and cold is loud
 *
 * There is **no thread table and no cold flag**, and there never will be — the same shape as
 * artifact freshness and D12's wall (1.2). A cold stretch is a run of consecutive episodes,
 * after the arc's first touch, that declare no position on it; three of them in a row is loud
 * (`COLD_AFTER`). The measure is in EPISODES rather than in days on purpose: a season's own
 * clock is its episode order, the map's columns already are that axis, and a wall-clock measure
 * would read "just now" on a freshly loaded library and "cold" on a show nobody touched over
 * Christmas. Both would be wrong about the story.
 *
 * The other half of 5.7's sentence — "vs. where the next waypoint sits" — is the next waypoint
 * with no ratified landing, and what the thread says about it is where that waypoint is held
 * and how far along its episode is. That is the mockup's own reading: *"waypoint 2 only lands
 * at ep06, which is still at its script gate."*
 *
 * ## Vanilla is a designed render, never a failure state
 *
 * An episode touching no arc is **vanilla** — legal, tracked, never a failure (1.1). Its column
 * is empty by design and it is TAGGED, so an empty column reads as a decision rather than as
 * missing data. The fixture built ep02 for exactly this.
 *
 * ## Two honest empty states, and neither invents a table
 *
 * The mockup draws an idea pool and a "pitch a premise against canon" button. **Neither
 * mechanism exists**: there is no idea table anywhere in fifteen migrations, and no
 * pre-episode check route — `run.episode_id` is still `NOT NULL`, which is the concrete
 * blocker. So both regions say what they are, what would fill them, and which issue holds the
 * mechanism. A screen that invented `CREATE TABLE idea` to have something to draw would be the
 * failure this epic must not normalize, and the floor already set the precedent one screen
 * down (`floorView`'s footer).
 *
 * ## It starts nothing
 *
 * Every function here reads. The map has no button that spends and no button that rules —
 * ruling a landing happens at the gate or in the sweep, where the proposal's five parts are
 * rendered beside it (one artifact, one ruling).
 */

// ── What the map is handed ──────────────────────────────────────────────────────

/** One season the library holds, so the map never picks one silently. */
export interface SeasonChoice {
  seasonId: string
  /** "Grey Harbor · Season 1 “Slack Water”". */
  label: string
  href: string
  current: boolean
}

/** The three inks. A plan, a claim waiting on Ryan, and canon. */
export const WAYPOINT_INK = ['pinned', 'riding', 'landed'] as const
export type WaypointInk = (typeof WAYPOINT_INK)[number]

/** One waypoint, plotted in the column of the episode that put it there. */
export interface PlottedWaypoint {
  waypointId: string
  /** "wp 2". */
  ordinal: string
  name: string
  ink: WaypointInk
  /**
   * What this cell IS, in one sentence — the difference between a plan and canon, said in
   * words rather than left to a border style. Read by an eye and by a screen reader.
   */
  sentence: string
  /**
   * The ruling that made it canon: "ratified at ruling 7 · 2026-08-11". **Only a landing has
   * one**, which is the whole distinction, and it is null on the other two inks.
   */
  lineage: string | null
}

/** One cell of one arc's row: what the episode put there, and whether the track is cold. */
export interface ArcCell {
  episodeId: string
  /** Null when this episode declares no position on this arc. The row draws its track dot. */
  waypoint: PlottedWaypoint | null
  /** The dashed amber stretch — this episode is inside a run of silence on this arc. */
  cold: boolean
  /** The first column draws no incoming track line. */
  first: boolean
}

/** A waypoint no episode in this season holds. Ahead of everything, earmarked to nothing. */
export interface WaypointAhead {
  waypointId: string
  ordinal: string
  name: string
  sentence: string
}

export interface ArcRow {
  arcId: string
  name: string
  /** "character · season · 3 waypoints" — the mockup's own label line. */
  kind: string
  href: string
  /** The arc page's name, and why it cannot be opened yet if it cannot. */
  room: string
  roomNotYet: string | null
  /** The amber line under the arc's name when it has gone cold. Null while it is holding. */
  warning: string | null
  cells: ArcCell[]
  /**
   * The waypoints nothing holds, at the right-hand end of the row. The mockup draws these in
   * the column of the episode they are earmarked for; **nothing in this build earmarks a
   * waypoint to an episode** — that is the idea pool's job and the idea pool does not exist —
   * so they sit ahead of every column and say so, rather than being drawn into a guess.
   */
  ahead: WaypointAhead[]
  /** What the strip says when every waypoint is held. Null while any is ahead. */
  aheadNone: string | null
}

export interface EpisodeColumn {
  episodeId: string
  /** "ep01". */
  label: string
  title: string
  /** "published", "script · at its gate", "premise" — where it stands, in words. */
  standing: string
  /** How the column is drawn: history, waiting on Ryan, working, or not started. */
  tone: 'past' | 'gate' | 'live' | 'planned'
  href: string
  /** How many arcs this episode touches. 0 is vanilla, which is a decision, not a gap. */
  touches: number
  /** "vanilla" when it touches none — the tag the mockup draws. Null otherwise. */
  vanillaTag: string | null
  /** What the foot row says under this column: "2", or the vanilla tag. */
  footNote: string
}

export interface ThreadRow {
  arcId: string | null
  /** "What the harbor is for — cold since ep01". */
  heading: string
  /** The paragraph: how long the silence is, and what the next waypoint is waiting on. */
  sentence: string
  /** The muted line under it: how the number was arrived at. Computed, never remembered. */
  why: string
  href: string | null
  cold: boolean
}

/** A region the mockup draws that this build has no mechanism for, said honestly. */
export interface MechanismGap {
  heading: FloorHeading
  /** The absence, said first. */
  lead: string
  /** What it is, what would fill it, and the issue that holds the mechanism. */
  sentence: string
  /** "The mechanism is filed as #92 — read it there." The whole link's text, from here. */
  filed: string
  issueHref: string
}

export interface SeasonMapView {
  seasonId: string
  showId: string
  /** "Season 1 · the map". */
  title: string
  /** "Grey Harbor · the season map" — the breadcrumb's middle. */
  where: string
  floorHref: string
  floorName: string
  /** "2 episodes · 1 arc · no hanging threads" — the line beside the title. */
  meta: string
  /** Every season in the library. One is `current`; nothing is picked without saying so. */
  seasons: SeasonChoice[]
  headings: { grid: FloorHeading; ahead: FloorHeading; threads: FloorHeading }
  episodes: EpisodeColumn[]
  arcs: ArcRow[]
  /** What the grid says when the season has no arc at all. Null while it has one. */
  noArcs: { lead: string; sentence: string } | null
  /** The sentence under the grid about the vanilla episodes in it. Null when there are none. */
  vanillaNote: string | null
  /** The foot row's own label — "Arcs touched". A word on screen is never a screen's. */
  touchedLabel: string
  threads: ThreadRow[]
  pool: MechanismGap
  pitch: MechanismGap
  stream: { kinds: readonly EventKind[]; prose: readonly EventKind[]; since: number }
}

/**
 * Three consecutive episodes of silence is loud.
 *
 * The number is the mockup's own reading of its own grid — *"cold for 3 episodes"* is called
 * out and *"no other arc has gone more than 2 episodes untouched"* is called holding — so two
 * is a rhythm and three is a thread the audience has stopped hearing. It is a constant rather
 * than a setting because a configurable one is a workflow knob (the Archon rule), and changing
 * it is a code change with a test.
 */
export const COLD_AFTER = 3

// ── The map ─────────────────────────────────────────────────────────────────────

/**
 * The whole map for one season, or null when the library has no season to draw.
 *
 * `seasonId` null means "the bare address" — the first season of the first show, which is what
 * the bar's own link points at. Nothing is picked SILENTLY even then: every season in the
 * library comes back in `seasons` with the current one marked, so the screen says which one it
 * is standing in and offers the others beside it.
 */
export function seasonMapView(store: Store, seasonId: string | null): SeasonMapView | null {
  const all = everySeason(store)
  if (all.length === 0) return null

  const standing = seasonId === null ? all[0]! : all.find((one) => one.season.id === seasonId)
  if (standing === undefined) return null

  const { show, season } = standing
  const rooms = destinationsOf()
  const floor = roomFor(rooms, 'floor')
  const arcRoom = roomFor(rooms, 'arc-page')
  const episodeRoom = roomFor(rooms, 'episode-room')

  const episodes = episodesOf(store, season.id)
  const gated = new Set(openGates(store).map((open) => open.gate.episodeId))

  // Every arc that runs through this season: the ones scoped to it, and the show-wide ones,
  // which cross every season by definition (`arc.season_id` is null for those).
  const arcs = arcsOf(store, show.id).filter(
    (arc) => arc.seasonId === season.id || arc.seasonId === null,
  )

  const rows = arcs.map((arc) => arcRow(store, arc, episodes, arcRoom))
  const touchCount = new Map<string, number>(episodes.map((episode) => [episode.id, 0]))
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.waypoint !== null) touchCount.set(cell.episodeId, touchCount.get(cell.episodeId)! + 1)
    }
  }

  const columns = episodes.map((episode) =>
    episodeColumn(episode, touchCount.get(episode.id)!, gated.has(episode.id), episodeRoom),
  )
  const vanilla = columns.filter((column) => column.vanillaTag !== null)

  return {
    seasonId: season.id,
    showId: show.id,
    title: `${seasonName(season)} · the map`,
    where: `${show.title} · the season map`,
    floorHref: floor.path,
    floorName: floor.name,
    meta: metaLine(columns, rows),
    seasons: all.map((one) => ({
      seasonId: one.season.id,
      label: `${one.show.title} · ${seasonName(one.season)}`,
      href: `/season/${one.season.id}`,
      current: one.season.id === season.id,
    })),
    headings: HEADINGS,
    episodes: columns,
    arcs: rows,
    noArcs:
      rows.length > 0
        ? null
        : {
            lead: 'No arc runs through this season.',
            sentence:
              'Every episode in it is vanilla, which is legal, tracked and never a failure ' +
              'state (1.1) — a season can tell a season of self-contained stories. An arc is ' +
              'authored from its sheet and loaded with the show; nothing here creates one.',
          },
    vanillaNote: vanillaNote(vanilla),
    touchedLabel: 'Arcs touched',
    threads: threadRows(store, rows, episodes, arcRoom),
    pool: IDEA_POOL,
    pitch: PITCH,
    stream: { kinds: EVENT_KIND, prose: PROSE_KIND, since: latestSeq(store) },
  }
}

// ── The rows ────────────────────────────────────────────────────────────────────

/**
 * One arc across the season: a cell per episode, the cold stretches marked, and whatever is
 * ahead of every column.
 *
 * The three reads it stands on are the three different questions a cell answers — where the
 * pins are (`positionsOnArc`), what the arc's waypoints are in order (`waypointsOf`), and what
 * anyone has claimed and Ryan has ruled (`landingsOfArc`). Nothing is remembered between them.
 */
function arcRow(store: Store, arc: Arc, episodes: readonly Episode[], room: Destination): ArcRow {
  const waypoints = waypointsOf(store, arc.id)
  const landings = landingsOfArc(store, arc.id)
  const here = new Set(episodes.map((episode) => episode.id))
  const touches = positionsOnArc(store, arc.id).filter((touch) => here.has(touch.episode.id))
  const byEpisode = new Map(touches.map((touch): [string, ArcTouch] => [touch.episode.id, touch]))

  const cold = coldStretches(episodes, byEpisode)
  const cells = episodes.map(
    (episode, at): ArcCell => ({
      episodeId: episode.id,
      waypoint: plot(byEpisode.get(episode.id), landings),
      cold: cold.has(episode.id),
      first: at === 0,
    }),
  )

  const held = new Set(touches.map((touch) => touch.waypoint.id))
  return {
    arcId: arc.id,
    name: arc.name,
    kind: `${arc.kind} · ${arc.scope} · ${count(waypoints.length, 'waypoint')}`,
    href: `${room.path}/${arc.id}`,
    room: room.name,
    roomNotYet: room.notYetBecause,
    warning: coldWarning(episodes, byEpisode, waypoints, landings, cold),
    cells,
    ahead: waypoints
      .filter((waypoint) => !held.has(waypoint.id))
      .map((waypoint) => ({
        waypointId: waypoint.id,
        ordinal: `wp ${waypoint.ordinal}`,
        name: waypoint.name,
        sentence:
          `Waypoint ${waypoint.ordinal} “${waypoint.name}” — no episode in this season ` +
          'declares it. Nothing earmarks a waypoint to an episode in this build, so it sits ' +
          'ahead of every column rather than being drawn into one.',
      })),
    aheadNone:
      waypoints.length > 0 && waypoints.every((waypoint) => held.has(waypoint.id))
        ? 'every waypoint held'
        : null,
  }
}

/**
 * **The two inks, decided in one place.** A pin is a plan; a landing is canon with lineage.
 *
 * The state is not stored and is not guessed: it is the landing proposal's own derived status,
 * off `canon_ruling` (`findProposal`). A rejected or deferred landing falls back to a pin AND
 * SAYS SO — a cell that quietly became a plain pin again would hide a ruling Ryan made.
 */
function plot(touch: ArcTouch | undefined, landings: readonly ArcLanding[]): PlottedWaypoint | null {
  if (touch === undefined) return null

  const label = episodeLabel(touch.episode.number)
  const mine = landings.filter(
    (landing) =>
      landing.waypointId === touch.waypoint.id && landing.proposal.episodeId === touch.episode.id,
  )
  const ratified = mine.find((landing) => landing.proposal.status === 'ratified')
  const riding = mine.find((landing) => landing.proposal.status === 'raised')
  const ruled = mine.find((landing) => landing.proposal.status !== 'raised')

  const base = {
    waypointId: touch.waypoint.id,
    ordinal: `wp ${touch.waypoint.ordinal}`,
    name: touch.waypoint.name,
  }

  if (ratified !== undefined) {
    const ruling = ratified.proposal.disposition!
    return {
      ...base,
      ink: 'landed',
      sentence:
        `${label} landed waypoint ${touch.waypoint.ordinal} “${touch.waypoint.name}”. ` +
        'You ratified it, so it is canon with lineage and answerable as of that ruling (D8, D9).',
      lineage: `ratified at ruling ${ruling.seq} · ${ruling.at.slice(0, 10)}`,
    }
  }

  if (riding !== undefined) {
    return {
      ...base,
      ink: 'riding',
      sentence:
        `${label} declares waypoint ${touch.waypoint.ordinal} “${touch.waypoint.name}”, and ` +
        'its landing proposal rides the episode — a claim, visible to checks, invisible to ' +
        'canon until you rule it (D8). A pin is not a landing.',
      lineage: null,
    }
  }

  return {
    ...base,
    ink: 'pinned',
    sentence:
      `${label} declares waypoint ${touch.waypoint.ordinal} “${touch.waypoint.name}” — a pin, ` +
      'which is a plan and not canon. ' +
      (ruled === undefined
        ? 'No landing proposal stands behind it: the landing is raised when the script is ' +
          'read, with the subject entity only the writer can answer for (D8, E4-4).'
        : `Its landing proposal was ${ruled.proposal.status}${
            ruled.proposal.disposition!.note === ''
              ? ''
              : ` — “${ruled.proposal.disposition!.note}”`
          }, and the pin was left where it was.`),
    lineage: null,
  }
}

// ── Cold, computed ──────────────────────────────────────────────────────────────

/**
 * Which episodes sit inside a cold stretch of this arc — the dashed amber run.
 *
 * A stretch is a maximal run of consecutive episodes declaring no position, **after the arc's
 * first touch in this season** and of at least `COLD_AFTER` episodes. Before the first touch
 * the arc has not started, so a season's opening episodes are not silence about it; the mockup
 * draws exactly that, with a solid track up to an arc's first waypoint and dashes only after.
 *
 * A trailing run counts. So does an internal one — an arc picked up again five episodes later
 * still went quiet for five, and that is the gap the audience felt.
 *
 * **Exported, and the arc page calls it** (`arc-page.ts`). Two screens disagreeing about
 * whether an arc has gone cold would be two answers to one question, and this is the one.
 */
export function coldStretches(
  episodes: readonly Episode[],
  byEpisode: ReadonlyMap<string, ArcTouch>,
): Set<string> {
  const cold = new Set<string>()
  const first = episodes.findIndex((episode) => byEpisode.has(episode.id))
  if (first < 0) return cold

  let run: Episode[] = []
  const settle = () => {
    if (run.length >= COLD_AFTER) for (const episode of run) cold.add(episode.id)
    run = []
  }
  for (const episode of episodes.slice(first + 1)) {
    if (byEpisode.has(episode.id)) settle()
    else run.push(episode)
  }
  settle()
  return cold
}

/**
 * The amber line under a cold arc's name, or null while it is holding.
 *
 * It says both halves of 5.7's sentence: how long the silence has run, and what the next
 * waypoint — the first with no ratified landing — is waiting on.
 */
function coldWarning(
  episodes: readonly Episode[],
  byEpisode: ReadonlyMap<string, ArcTouch>,
  waypoints: readonly ArcWaypoint[],
  landings: readonly ArcLanding[],
  cold: ReadonlySet<string>,
): string | null {
  if (cold.size === 0) return null
  const longest = longestRun(episodes, cold)
  const next = nextWaypoint(waypoints, landings)
  return (
    `cold for ${count(longest.length, 'episode')} after ${episodeLabel(longest.after)} — ` +
    (next === undefined
      ? 'every waypoint on it has landed'
      : `waypoint ${next.ordinal} “${next.name}” has not landed`)
  )
}

/** The longest cold run, and the episode it opened after. Both are read off the columns. */
function longestRun(
  episodes: readonly Episode[],
  cold: ReadonlySet<string>,
): { length: number; after: number } {
  let best = { length: 0, after: 0 }
  let run = 0
  for (const [at, episode] of episodes.entries()) {
    if (!cold.has(episode.id)) {
      run = 0
      continue
    }
    run += 1
    if (run > best.length) best = { length: run, after: episodes[at - run]!.number }
  }
  return best
}

/**
 * The first waypoint with no ratified landing — where the arc is trying to get to next. The
 * second half of 5.7's sentence, and the arc page's rail asks it too.
 */
export function nextWaypoint(
  waypoints: readonly ArcWaypoint[],
  landings: readonly ArcLanding[],
): ArcWaypoint | undefined {
  const landed = new Set(
    landings
      .filter((landing) => landing.proposal.status === 'ratified')
      .map((landing) => landing.waypointId),
  )
  return waypoints.find((waypoint) => !landed.has(waypoint.id))
}

/**
 * The hanging-threads panel: one row per cold arc, and — when nothing is cold — one row saying
 * so, because a panel that vanished would leave Ryan wondering whether it had been asked.
 */
function threadRows(
  store: Store,
  rows: readonly ArcRow[],
  episodes: readonly Episode[],
  room: Destination,
): ThreadRow[] {
  const cold = rows.filter((row) => row.warning !== null)

  if (cold.length === 0) {
    return [
      {
        arcId: null,
        heading: rows.length === 0 ? 'Nothing to hang' : 'Everything is holding',
        sentence:
          rows.length === 0
            ? 'No arc runs through this season, so there is no thread to leave hanging. An ' +
              'episode that touches no arc is vanilla, which is legal and tracked (1.1).'
            : `No arc has gone ${count(COLD_AFTER, 'episode')} without an episode declaring a ` +
              `position on it. ${count(rows.length, 'arc')} across ` +
              `${count(episodes.length, 'episode')}, and every one of them was touched more ` +
              'recently than that.',
        why:
          'computed off the pins and the episode order — there is no thread table and no cold ' +
          'flag anywhere in this schema',
        href: null,
        cold: false,
      },
    ]
  }

  return cold.map((row): ThreadRow => {
    const arcWaypoints = waypointsOf(store, row.arcId)
    const landings = landingsOfArc(store, row.arcId)
    const next = nextWaypoint(arcWaypoints, landings)
    const holder = next === undefined ? undefined : holderOf(store, row, next.id, episodes)

    return {
      arcId: row.arcId,
      heading: `${row.name} — ${row.warning!}`,
      sentence:
        next === undefined
          ? `Every waypoint on “${row.name}” has landed, and no later episode declares a ` +
            'position on it. The arc is finished rather than forgotten.'
          : `Waypoint ${next.ordinal} “${next.name}” is where “${row.name}” goes next, and ` +
            (holder === undefined
              ? 'no episode in this season declares it. Nothing is written that would land it.'
              : `${episodeLabel(holder.number)} “${holder.title}” declares it and stands at ` +
                `${holder.lifecycle}. Until that lands, the silence keeps running.`),
      why:
        `the longest run of episodes declaring no position on it, measured in the season's own ` +
        `order — ${count(COLD_AFTER, 'episode')} of silence is where this goes loud`,
      href: row.href,
      cold: true,
    }
  })
}

/** Which episode declares the arc's next waypoint, if any does. Read off the row's own cells. */
function holderOf(
  store: Store,
  row: ArcRow,
  waypointId: string,
  episodes: readonly Episode[],
): Episode | undefined {
  const cell = row.cells.find((one) => one.waypoint?.waypointId === waypointId)
  return cell === undefined ? undefined : episodes.find((episode) => episode.id === cell.episodeId)
}

// ── The columns ─────────────────────────────────────────────────────────────────

function episodeColumn(
  episode: Episode,
  touches: number,
  atAGate: boolean,
  room: Destination,
): EpisodeColumn {
  const vanilla = touches === 0
  return {
    episodeId: episode.id,
    label: episodeLabel(episode.number),
    title: episode.title,
    standing: standingOf(episode, atAGate),
    tone: toneOf(episode, atAGate),
    href: `${room.path}/${episode.id}`,
    touches,
    vanillaTag: vanilla ? 'vanilla' : null,
    footNote: vanilla ? 'vanilla' : String(touches),
  }
}

/**
 * Where the episode stands, in words. `abandoned_at` is a column beside the lifecycle and never
 * a member of it (0009), so a dead episode says both: the stage it reached, and that it was put
 * down.
 */
function standingOf(episode: Episode, atAGate: boolean): string {
  if (episode.abandonedAt !== null) return `put down at ${episode.lifecycle}`
  if (atAGate) return `${episode.lifecycle} · at its gate`
  return episode.lifecycle
}

function toneOf(episode: Episode, atAGate: boolean): EpisodeColumn['tone'] {
  if (episode.abandonedAt !== null || episode.lifecycle === 'published') return 'past'
  if (atAGate) return 'gate'
  if (episode.lifecycle === 'premise') return 'planned'
  return 'live'
}

/** The mockup's line under the grid: which columns are empty on purpose, and why that is fine. */
function vanillaNote(vanilla: readonly EpisodeColumn[]): string | null {
  if (vanilla.length === 0) return null
  const named = vanilla.map((column) => `${column.label} “${column.title}”`).join(', ')
  return (
    `${named} ${vanilla.length === 1 ? 'is' : 'are'} vanilla — ` +
    `${vanilla.length === 1 ? 'it touches' : 'they touch'} no arc. Legal, tracked, never a ` +
    `failure state; ${vanilla.length === 1 ? 'it tells its' : 'they tell their'} own story ` +
    'between the episodes that carry one.'
  )
}

/** "2 episodes · 1 vanilla · 1 arc · no hanging threads" — the line beside the title. */
function metaLine(columns: readonly EpisodeColumn[], rows: readonly ArcRow[]): string {
  const vanilla = columns.filter((column) => column.vanillaTag !== null).length
  const cold = rows.filter((row) => row.warning !== null).length
  return [
    count(columns.length, 'episode'),
    `${vanilla} vanilla`,
    count(rows.length, 'arc'),
    cold === 0 ? 'no hanging threads' : count(cold, 'hanging thread'),
  ].join(' · ')
}

// ── The two absences ────────────────────────────────────────────────────────────

/**
 * **The idea pool, said honestly** (5.7; filed as #92).
 *
 * The mockup draws three columns of premises — greenlit, parked, spiked. There is no idea
 * table in this build: fifteen migrations and not one of them creates one. So this region says
 * what the pool is, what would fill it, and where the mechanism is being tracked. It renders a
 * count of nothing nowhere, and it creates no table to have something to count.
 *
 * The floor already made this call one screen down and this is the same sentence's sibling —
 * which is the point: the two screens that draw the pool agree about it not existing.
 */
const IDEA_POOL: MechanismGap = {
  heading: {
    name: 'The idea pool',
    explains: 'premises before they are episodes — greenlit, parked, spiked',
  },
  lead: 'There is no idea pool in this build.',
  sentence:
    'A season carries one in the ruled design (1.1) — premises greenlit, parked or spiked, ' +
    'each with the reason beside it — and nothing records one yet: no table, no route, no ' +
    'count. What would fill it is a premise you have had and not written, held where the ' +
    'season can see it. The mechanism is filed rather than invented here, because a screen ' +
    'that created a domain table to have something to draw is the failure this cockpit ' +
    'must not normalize.',
  filed: 'The mechanism is filed as #92 — what the table would hold, and the line it must not cross.',
  issueHref: 'https://github.com/MrMophandle/Showrunner/issues/92',
}

/**
 * **Pitch a premise against canon, said honestly** (5.7; filed as #93).
 *
 * The mockup draws a costed button — *"runs the check panel on the idea, pre-episode · 1 Opus
 * call · ~$0.30"*. There is no pre-episode check route, and the blocker is concrete and already
 * written down: `run.episode_id` is `NOT NULL` and `event.episode_id` follows it, so a run
 * against an idea with no episode cannot be recorded at all.
 *
 * So there is no button here. **A disabled button would be the wrong honesty** — it would say
 * the act exists and is momentarily blocked, and it does not exist. The region says what the
 * act would be and names the issue instead.
 */
const PITCH: MechanismGap = {
  heading: {
    name: 'Pitch a premise against canon',
    explains: 'running the check panel over an idea before it is an episode',
  },
  lead: 'There is no pre-episode check in this build.',
  sentence:
    'The design has one: an idea read against canon before anybody writes it, so a premise ' +
    'that contradicts four ratified facts is spiked while it is still cheap. The checker ' +
    'and the panel exist and the proposal flow already allows a change riding no episode — ' +
    'what is missing is a run with no episode to hang it on, because `run.episode_id` is ' +
    'NOT NULL. There is no button here rather than a disabled one: a blocked button says the ' +
    'act exists, and this one does not yet.',
  filed: 'The mechanism is filed as #93 — the migration it needs, and the decision it forces.',
  issueHref: 'https://github.com/MrMophandle/Showrunner/issues/93',
}

// ── Odds and ends ───────────────────────────────────────────────────────────────

const HEADINGS: SeasonMapView['headings'] = {
  grid: {
    name: 'Arcs across the season',
    explains:
      'waypoints plotted where episodes put them · a solid chip is canon you ratified, ' +
      'amber is a landing waiting on you, dashed is a pin — a plan, not a landing',
  },
  ahead: {
    name: 'Ahead',
    explains: 'waypoints no episode holds yet — nothing in this build earmarks one to an episode',
  },
  threads: {
    name: 'Hanging threads',
    explains:
      'computed — the longest run of episodes that declared no position, against where the ' +
      'next waypoint sits',
  },
}

/** Every season in the library, in the floor's own order: show, then season number. */
function everySeason(store: Store): { show: { id: string; title: string }; season: Season }[] {
  return shows(store).flatMap((show) =>
    seasonsOf(store, show.id).map((season) => ({
      show: { id: show.id, title: show.title },
      season,
    })),
  )
}

/** "Season 1 “Slack Water”", or "Season 1" when the season was never titled. */
function seasonName(season: Season): string {
  return `Season ${season.number}${season.title === null ? '' : ` “${season.title}”`}`
}

function roomFor(rooms: readonly Destination[], id: string): Destination {
  return rooms.find((room) => room.id === id)!
}

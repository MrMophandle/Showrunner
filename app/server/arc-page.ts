import { destinationsOf, type Destination } from './cockpit.ts'
import type { Store } from './db/store.ts'
import {
  arcHistory,
  arcsOf,
  episodesNeedingRecheck,
  findArc,
  positionsOnArc,
  waypointsOf,
  type Arc,
  type ArcTouch,
  type ArcWaypoint,
} from './domain/arc.ts'
import { findEntityById } from './domain/canon.ts'
import { landingsOfArc, type ArcLanding } from './domain/episode-canon.ts'
import { episodeLabel, episodesOf, seasonsOf, shows, type Season } from './domain/spine.ts'
import { waypointCheckFor, WAYPOINT_CHECK_KEY } from './domain/text-check.ts'
import { EVENT_KIND, latestSeq, PROSE_KIND, type EventKind } from './events.ts'
import { count, type FloorHeading } from './floor.ts'
import { coldStretches, nextWaypoint, COLD_AFTER } from './season-map.ts'

/**
 * **The arc page** (E5-5, #85; 5.8, D24, D8; `mockups/arc.html`) — one arc: what it is, its
 * waypoints in order, and the episodes that landed them.
 *
 * ## Why this screen exists at all
 *
 * D24 was ruled the day Ryan said he had forgotten what "The beacon" was and had nowhere to
 * look. An arc was a row on the season map and a chip on an entity page, and **nothing
 * anywhere said what an arc IS**. So the first panel on this page is the prose statement he
 * wrote, and the rest of the page is the machinery around it, in the order he would ask.
 *
 * ## How the arc is checked — with the check's own words, never a paraphrase
 *
 * D24 asks for "how the arc is checked (D8 semantics, with an example finding)". The
 * temptation is to write a nice paragraph explaining drift. **That paragraph would drift** —
 * it is a second copy of what `text-check.ts` actually sends, and the copy on the screen is
 * the one Ryan reads. So the panel renders the REAL composed subject: `waypointCheckFor` is
 * the same function `waypointChecksFor` maps over when a run convenes the check, and its
 * `instructions` and `reference` go onto the page verbatim. Change the check and this page
 * changes with it, because it is not a description of the check — it is the check's own
 * prompt material, shown.
 *
 * Composing it sends nothing and costs nothing: no model call, no `check_pass` row (invariant
 * 5). It is composed for a real declared position, and the panel says which — because the
 * reference is arc-and-position specific ("← declared by this episode"), and a worked example
 * that did not say whose work it was would be a fourth kind of vagueness.
 *
 * ## The panels that have to say "nothing yet", and mean it
 *
 * An arc carries **no entity link**, deliberately (E2-3): an arc is a shape a season makes,
 * and which character or place an individual landing is a claim about is a writing judgement
 * answered per landing. So the entities panel is derived from the ratified landings' subjects,
 * and on a show whose landings have not been ruled it is empty and says exactly why. The same
 * goes for a waypoint nothing holds and for an arc no episode has touched.
 *
 * ## It rules nothing and declares nothing
 *
 * Moving a pin is the episode's decision and it is made in the writing room, where the
 * episode's own draft is (E4-4, E4-7). Ratifying a landing happens at the gate or in the
 * completion sweep, where the proposal's five parts are rendered beside it (one artifact, one
 * ruling). This page reads.
 */

// ── What the page is handed ─────────────────────────────────────────────────────

/** Where one waypoint stands, and the four are genuinely different things. */
export const WAYPOINT_STANDING = ['landed', 'riding', 'pinned', 'ahead'] as const
export type WaypointStanding = (typeof WAYPOINT_STANDING)[number]

export interface WaypointOnTheSpine {
  waypointId: string
  ordinal: number
  name: string
  /** What this waypoint means — the arc sheet's own words. */
  description: string
  /** What landing it looks like on screen (D24). */
  landingCriteria: string
  standing: WaypointStanding
  /** The tags under it: which episode holds it, whether it landed, what rides it. */
  tags: string[]
  /** "ratified at ruling 7 · 2026-08-11". Only a landed waypoint has one. */
  lineage: string | null
  /** The re-check drift, when a waypoint went in ahead of an episode that declared this. */
  recheck: string | null
}

export interface EpisodeOnTheArc {
  episodeId: string
  /** "ep01". */
  label: string
  title: string
  /** "declares waypoint 2 — a pin, not a landing". */
  sentence: string
  standing: WaypointStanding
  href: string
}

/** One line of the arc's own record: an edit, a declaration, or a ruling. */
export interface HistoryLine {
  /** "wp2 “The harbor is worth spending on” declared". */
  what: string
  /** "ep01 · 2026-08-11 — riding nothing; no landing was raised". */
  when: string
  /** Ryan's words, when the record kept any. A rename keeps its note (D24). */
  note: string | null
  at: string
}

/** The drift check, as it actually runs — never a description of it. */
export interface HowItIsChecked {
  /** How the check is convened, in words: what fires it and what it may not do. */
  sentence: string
  /** `waypoint-drift` — the one check key that is not a category key. */
  checkKey: string
  /** Which position the worked example was composed for. */
  composedFor: string
  /** The reviewer's own heading for this pass. */
  label: string
  /** `WAYPOINT_INSTRUCTIONS`, verbatim off `text-check.ts`. */
  instructions: string
  /** The arc's statement and every waypoint, exactly as the check sends them. */
  reference: string
  /** Null once a position exists to compose against. */
  none: { lead: string; sentence: string } | null
}

export interface ArcPageView {
  arcId: string
  showId: string
  name: string
  /** "character · season 1". */
  kindChip: string
  /** "declared to waypoint 2 of 3 — nothing landed yet". */
  standingChip: string
  /** "3 waypoints · touched by 1 episode · nothing landed". */
  headsub: string
  floorHref: string
  floorName: string
  seasonHref: string
  seasonName: string
  canonHref: string
  canonName: string
  canonNotYet: string | null
  headings: {
    statement: FloorHeading
    waypoints: FloorHeading
    glance: FloorHeading
    episodes: FloorHeading
    checked: FloorHeading
    history: FloorHeading
  }
  /** "Landing looks like:" — the label on every waypoint. A word on screen is never a screen's. */
  landingLabel: string
  /** The statement, in its own paragraphs. Empty when the sheet left it blank. */
  statement: string[]
  /** What an arc with no statement says instead. Null while it has one. */
  noStatement: { lead: string; sentence: string } | null
  waypoints: WaypointOnTheSpine[]
  /** Scope, kind, entities, health — the right rail's key/value rows. */
  glance: { key: string; value: string }[]
  /** The entities the landings on this arc read on, each linking into the library. */
  entities: { entityId: string; name: string; href: string }[]
  /** Null while any landing has been ratified; the honest sentence when none has. */
  noEntities: { lead: string; sentence: string } | null
  episodes: EpisodeOnTheArc[]
  /** What "episodes touching it" says when nothing does. */
  noEpisodes: { lead: string; sentence: string } | null
  /** Which episodes in the season do NOT touch it, said plainly — vanilla is not a gap. */
  untouchedNote: string | null
  checked: HowItIsChecked
  history: HistoryLine[]
  stream: { kinds: readonly EventKind[]; prose: readonly EventKind[]; since: number }
}

/**
 * The bare address, `/arc`. Every arc in the library, each a sentence that links.
 *
 * It exists because the shell's bar carries `/arc` and **no door in this cockpit may be a dead
 * end**. An arc page with no arc is not "a room about one thing at its bare address" the way
 * `/episode` and `/gate` are — there is genuinely nothing to render — so rather than a blank
 * page it is the list, which is also the answer to "I typed /arc, what have I got".
 */
export interface ArcIndexView {
  heading: FloorHeading
  arcs: { arcId: string; sentence: string; href: string }[]
  /** Null while the library holds an arc. */
  empty: { lead: string; sentence: string } | null
}

export function arcIndexView(store: Store): ArcIndexView {
  const rooms = destinationsOf()
  const room = roomFor(rooms, 'arc-page')
  const map = roomFor(rooms, 'season-map')

  const arcs = shows(store).flatMap((show) =>
    arcsOf(store, show.id).map((arc) => ({
      arcId: arc.id,
      sentence:
        `${show.title} · ${arc.name} — ${arc.kind}, ${scopeWords(store, arc)}, ` +
        `${count(waypointsOf(store, arc.id).length, 'waypoint')}`,
      href: `${room.path}/${arc.id}`,
    })),
  )

  return {
    heading: {
      name: 'Arcs',
      explains: `every arc in this library — reached from ${room.reachedFrom}`,
    },
    arcs,
    empty:
      arcs.length > 0
        ? null
        : {
            lead: 'No arc in this library.',
            sentence:
              'An arc is authored on its own sheet and loaded with the show; nothing here ' +
              'creates one. A season with no arc is legal — every episode in it is vanilla, ' +
              `which is never a failure state (1.1). ${map.name} shows the season either way.`,
          },
  }
}

// ── The page ────────────────────────────────────────────────────────────────────

export function arcPageView(store: Store, arcId: string): ArcPageView | undefined {
  const arc = findArc(store, arcId)
  if (!arc) return undefined

  const rooms = destinationsOf()
  const floor = roomFor(rooms, 'floor')
  const seasonRoom = roomFor(rooms, 'season-map')
  const canon = roomFor(rooms, 'canon-library')
  const episodeRoom = roomFor(rooms, 'episode-room')

  const waypoints = waypointsOf(store, arc.id)
  const landings = landingsOfArc(store, arc.id)
  const touches = positionsOnArc(store, arc.id)
  const drift = new Map(
    episodesNeedingRecheck(store, arc.id).map((flag): [string, string] => [
      flag.episode.id,
      flag.reason,
    ]),
  )

  const spine = waypoints.map((waypoint) =>
    onTheSpine(waypoint, touches, landings, drift, waypoints.length),
  )
  const landed = spine.filter((one) => one.standing === 'landed')
  const subjects = entitiesOf(store, landings, canon)

  return {
    arcId: arc.id,
    showId: arc.showId,
    name: arc.name,
    kindChip: `${arc.kind} · ${scopeWords(store, arc)}`,
    standingChip: standingChip(spine),
    headsub: headsub(spine, touches, landed.length),
    floorHref: floor.path,
    floorName: floor.name,
    seasonHref: seasonHref(store, arc, seasonRoom),
    seasonName: seasonRoom.name,
    canonHref: canon.path,
    canonName: canon.name,
    canonNotYet: canon.notYetBecause,
    headings: HEADINGS,
    landingLabel: 'Landing looks like:',
    statement: paragraphs(arc.statement),
    noStatement:
      arc.statement.trim() === ''
        ? {
            lead: 'This arc has no statement.',
            sentence:
              'The statement is what you re-read when you have forgotten what the arc was ' +
              '(D24) — what it is about, and the question it asks. It is authored on the ' +
              'arc’s sheet and loaded with the show; this one’s is empty.',
          }
        : null,
    waypoints: spine,
    glance: glanceOf(store, arc, spine, touches, landings, subjects),
    entities: subjects,
    noEntities:
      subjects.length > 0
        ? null
        : {
            lead: 'No entity is named on this arc yet.',
            sentence:
              'An arc carries no entity link, on purpose: an arc is a shape a season makes, ' +
              'and which character or place a landing is a claim about is a writing judgement ' +
              'answered per landing (E2-3). The names here are the subjects of the landings ' +
              'you have ratified, so they arrive as you rule them.',
          },
    episodes: touches.map((touch) => onTheArc(touch, landings, episodeRoom)),
    noEpisodes:
      touches.length > 0
        ? null
        : {
            lead: 'No episode declares a position on this arc.',
            sentence:
              'Nothing is owed here — an episode that touches no arc is vanilla, which is ' +
              'legal, tracked and never a failure state (1.1). A position is declared from ' +
              'the episode’s own writing room, where the draft it is about is.',
          },
    untouchedNote: untouchedNote(store, arc, touches),
    checked: howItIsChecked(store, arc, touches),
    history: historyOf(store, arc, touches, landings),
    stream: { kinds: EVENT_KIND, prose: PROSE_KIND, since: latestSeq(store) },
  }
}

// ── The spine ───────────────────────────────────────────────────────────────────

/**
 * One waypoint, with what holds it and what has been ruled about it.
 *
 * The four standings are four different facts and are never collapsed: **landed** is canon
 * with lineage, **riding** is a claim waiting on Ryan, **pinned** is a plan an episode has
 * declared, and **ahead** is a waypoint nothing holds. The episode room draws only `here` and
 * `ahead`, deliberately — from an episode's side, whether the waypoint landed is a canon
 * question rather than a position one. From the ARC's side it is exactly the question, so this
 * page reads the ledger and answers it.
 */
function onTheSpine(
  waypoint: ArcWaypoint,
  touches: readonly ArcTouch[],
  landings: readonly ArcLanding[],
  drift: ReadonlyMap<string, string>,
  total: number,
): WaypointOnTheSpine {
  const holders = touches.filter((touch) => touch.waypoint.id === waypoint.id)
  const mine = landings.filter((landing) => landing.waypointId === waypoint.id)
  const ratified = mine.find((landing) => landing.proposal.status === 'ratified')
  const riding = mine.filter((landing) => landing.proposal.status === 'raised')
  const ruled = mine.filter(
    (landing) => landing.proposal.status === 'rejected' || landing.proposal.status === 'deferred',
  )

  const standing: WaypointStanding =
    ratified !== undefined
      ? 'landed'
      : riding.length > 0
        ? 'riding'
        : holders.length > 0
          ? 'pinned'
          : 'ahead'

  const tags: string[] = []
  for (const holder of holders) {
    const label = `${episodeLabel(holder.episode.number)} “${holder.episode.title}”`
    tags.push(
      ratified !== undefined && ratified.proposal.episodeId === holder.episode.id
        ? `landed in ${label}`
        : `declared by ${label} — a pin, not a landing`,
    )
  }
  for (const landing of riding) {
    tags.push(
      'a landing proposal rides it — it becomes canon when you ratify it, and not before (D8)',
    )
  }
  for (const landing of ruled) {
    tags.push(
      `a landing on it was ${landing.proposal.status}` +
        (landing.proposal.disposition!.note === ''
          ? ''
          : ` — “${landing.proposal.disposition!.note}”`),
    )
  }
  if (holders.length === 0) {
    // Short, because a tag renders uppercase and a sentence in caps is a shout. The longer
    // half of this — that nothing in this build earmarks a waypoint to an episode — is the
    // season map's "ahead" strip, where there is room for it.
    tags.push(`waypoint ${waypoint.ordinal} of ${total} — no episode holds it yet`)
  }

  const drifted = holders.map((holder) => drift.get(holder.episode.id)).find((one) => one !== undefined)

  return {
    waypointId: waypoint.id,
    ordinal: waypoint.ordinal,
    name: waypoint.name,
    description: waypoint.description,
    landingCriteria: waypoint.landingCriteria,
    standing,
    tags,
    lineage:
      ratified === undefined
        ? null
        : `ratified at ruling ${ratified.proposal.disposition!.seq} · ` +
          ratified.proposal.disposition!.at.slice(0, 10),
    recheck: drifted ?? null,
  }
}

/** "declared to waypoint 2 of 3 — nothing landed yet". Where the arc actually stands. */
function standingChip(spine: readonly WaypointOnTheSpine[]): string {
  if (spine.length === 0) return 'no waypoints yet'
  const landed = [...spine].reverse().find((one) => one.standing === 'landed')
  if (landed) return `landed to waypoint ${landed.ordinal} of ${spine.length}`
  const held = [...spine].reverse().find((one) => one.standing !== 'ahead')
  if (held) return `declared to waypoint ${held.ordinal} of ${spine.length} — nothing landed yet`
  return `untouched — waypoint 1 of ${spine.length} is still ahead`
}

function headsub(
  spine: readonly WaypointOnTheSpine[],
  touches: readonly ArcTouch[],
  landed: number,
): string {
  const episodes = new Set(touches.map((touch) => touch.episode.id)).size
  return [
    count(spine.length, 'waypoint'),
    `touched by ${count(episodes, 'episode')}`,
    landed === 0 ? 'nothing landed' : `${landed} landed`,
  ].join(' · ')
}

// ── The rail ────────────────────────────────────────────────────────────────────

function onTheArc(
  touch: ArcTouch,
  landings: readonly ArcLanding[],
  room: Destination,
): EpisodeOnTheArc {
  const mine = landings.filter(
    (landing) =>
      landing.waypointId === touch.waypoint.id && landing.proposal.episodeId === touch.episode.id,
  )
  const ratified = mine.find((landing) => landing.proposal.status === 'ratified')
  const riding = mine.some((landing) => landing.proposal.status === 'raised')

  return {
    episodeId: touch.episode.id,
    label: episodeLabel(touch.episode.number),
    title: touch.episode.title,
    sentence:
      ratified !== undefined
        ? `landed waypoint ${touch.waypoint.ordinal} “${touch.waypoint.name}” · ratified at ` +
          `ruling ${ratified.proposal.disposition!.seq}`
        : riding
          ? `declares waypoint ${touch.waypoint.ordinal} “${touch.waypoint.name}” · its ` +
            'landing proposal is riding and waits on you'
          : `declares waypoint ${touch.waypoint.ordinal} “${touch.waypoint.name}” — a pin, ` +
            'which is a plan and not canon',
    standing: ratified !== undefined ? 'landed' : riding ? 'riding' : 'pinned',
    href: `${room.path}/${touch.episode.id}`,
  }
}

/** "ep02 “Dry Stores” does not touch it, and is vanilla." Never a gap; a decision. */
function untouchedNote(store: Store, arc: Arc, touches: readonly ArcTouch[]): string | null {
  const season = seasonOf(store, arc)
  if (season === null) return null

  const touched = new Set(touches.map((touch) => touch.episode.id))
  const untouched = episodesOf(store, season.id).filter((episode) => !touched.has(episode.id))
  if (untouched.length === 0) return null

  return (
    `${untouched.map((episode) => `${episodeLabel(episode.number)} “${episode.title}”`).join(', ')} ` +
    `${untouched.length === 1 ? 'does' : 'do'} not touch it. That is not a gap in this arc — ` +
    'an episode may carry another arc or none at all, and one that carries none is vanilla.'
  )
}

/** The entities the ratified landings read on. An arc has no entity of its own (E2-3). */
function entitiesOf(
  store: Store,
  landings: readonly ArcLanding[],
  room: Destination,
): { entityId: string; name: string; href: string }[] {
  const seen = new Map<string, { entityId: string; name: string; href: string }>()
  for (const landing of landings) {
    if (landing.proposal.status !== 'ratified') continue
    const entity = findEntityById(store, landing.proposal.entityId)
    if (!entity || seen.has(entity.id)) continue
    seen.set(entity.id, {
      entityId: entity.id,
      name: entity.name,
      href: `${room.path}/${entity.id}`,
    })
  }
  return [...seen.values()]
}

/**
 * The right rail's four rows. **Health is the season map's own computation**, called rather
 * than re-derived: the map and this page disagreeing about whether an arc has gone cold would
 * be two answers to one question, and the answer is computed off the pins either way.
 */
function glanceOf(
  store: Store,
  arc: Arc,
  spine: readonly WaypointOnTheSpine[],
  touches: readonly ArcTouch[],
  landings: readonly ArcLanding[],
  subjects: readonly { name: string }[],
): { key: string; value: string }[] {
  return [
    { key: 'Scope', value: scopeWords(store, arc) },
    { key: 'Kind', value: arc.kind },
    {
      key: 'Entities',
      value:
        subjects.length === 0
          ? 'none yet — an arc carries no entity link; a landing names the one it reads on'
          : subjects.map((one) => one.name).join(' · '),
    },
    { key: 'Health', value: healthOf(store, arc, spine, touches, landings) },
  ]
}

function healthOf(
  store: Store,
  arc: Arc,
  spine: readonly WaypointOnTheSpine[],
  touches: readonly ArcTouch[],
  landings: readonly ArcLanding[],
): string {
  const season = seasonOf(store, arc)
  if (season === null) {
    return 'this arc runs across the whole show, so a season’s episode order does not measure it'
  }
  if (touches.length === 0) {
    return 'no episode declares a position on it, so there is no silence to measure yet'
  }

  const episodes = episodesOf(store, season.id)
  const byEpisode = new Map(touches.map((touch): [string, ArcTouch] => [touch.episode.id, touch]))
  const cold = coldStretches(episodes, byEpisode)
  if (cold.size === 0) {
    return (
      `holding — never ${count(COLD_AFTER, 'episode')} without an episode declaring a ` +
      'position on it'
    )
  }

  const waypoints = spine.map(
    (one): ArcWaypoint => ({
      id: one.waypointId,
      arcId: arc.id,
      ordinal: one.ordinal,
      name: one.name,
      description: one.description,
      landingCriteria: one.landingCriteria,
      createdAt: '',
    }),
  )
  const next = nextWaypoint(waypoints, landings)
  return (
    `cold — ${count(cold.size, 'episode')} in this season declare no position on it` +
    (next === undefined ? '' : `, and waypoint ${next.ordinal} “${next.name}” has not landed`)
  )
}

// ── How it is checked (D8, with the check's own words) ──────────────────────────

/**
 * The worked example, composed by the check itself.
 *
 * `waypointCheckFor` is what `waypointChecksFor` maps over when a run convenes the drift
 * check, so `instructions` and `reference` below are literally what a reviewer is sent — not a
 * summary of it, and not a paragraph that has to be kept in step by hand.
 *
 * It composes against the LAST episode to declare a position, and says so. The reference is
 * position-specific — it marks the declared waypoint with "← declared by this episode" — so a
 * worked example with no episode named would be an example of nobody's pass.
 */
function howItIsChecked(store: Store, arc: Arc, touches: readonly ArcTouch[]): HowItIsChecked {
  const sentence =
    'An episode declares its position on this arc, and the waypoint-drift check reads the ' +
    'draft against that waypoint and the ones on either side of it. Behaviour ahead of the ' +
    'declared position is a finding, and so is behaviour behind it — argued, never vetoed ' +
    '(invariant 3). Landing a waypoint is a proposal you ratify; nothing here writes canon ' +
    'on its own (D8). Below is what the check actually carries — the same text it sends, not ' +
    'a description of it.'

  const latest = [...touches].sort((a, b) => a.episode.number - b.episode.number).at(-1)
  if (latest === undefined) {
    return {
      sentence,
      checkKey: WAYPOINT_CHECK_KEY,
      composedFor: '',
      label: '',
      instructions: '',
      reference: '',
      none: {
        lead: 'Nothing convenes it on this arc yet.',
        sentence:
          'The waypoint-drift check fires once per declared position, so an arc no episode ' +
          'has declared a position on convenes nothing at all — an empty list rather than a ' +
          'check that says so. Declare a position from an episode’s writing room and the ' +
          'worked example composes itself here.',
      },
    }
  }

  const subject = waypointCheckFor(store, {
    arc: latest.arc,
    waypoint: latest.waypoint,
    declaredOrdinal: latest.declaredOrdinal,
    declaredAt: latest.declaredAt,
  })

  return {
    sentence,
    checkKey: WAYPOINT_CHECK_KEY,
    composedFor:
      `composed for ${episodeLabel(latest.episode.number)} “${latest.episode.title}”, which ` +
      `declares waypoint ${latest.waypoint.ordinal} — this is the text the check carries when ` +
      'it reads that draft',
    label: subject.label,
    instructions: subject.instructions,
    reference: subject.reference.join('\n'),
    none: null,
  }
}

// ── The record ──────────────────────────────────────────────────────────────────

/**
 * One arc's whole record, newest first: its own edits, the positions episodes declared on it,
 * and the landings Ryan ruled.
 *
 * `arc_edit` is the append-only history of the arc itself and it is where a **rename keeps its
 * note** (D24) — the one place "was 'the truth', now 'the lie', because…" survives. The other
 * two sources are not on it and must not be: a declaration is `episode_arc_position`'s own
 * timestamp and a landing is a row on `canon_ruling`, and copying either onto `arc_edit` would
 * be a second clock for something the ledger already orders.
 */
function historyOf(
  store: Store,
  arc: Arc,
  touches: readonly ArcTouch[],
  landings: readonly ArcLanding[],
): HistoryLine[] {
  const lines: HistoryLine[] = []

  for (const edit of arcHistory(store, arc.id)) {
    lines.push({
      what: edit.summary,
      when: `${edit.kind} · ${edit.at.slice(0, 10)}`,
      note: edit.note === '' ? null : edit.note,
      at: edit.at,
    })
  }

  for (const touch of touches) {
    lines.push({
      what: `waypoint ${touch.waypoint.ordinal} “${touch.waypoint.name}” declared`,
      when:
        `${episodeLabel(touch.episode.number)} · ${touch.declaredAt.slice(0, 10)} — a pin; ` +
        'a landing is a separate ruling',
      note: null,
      at: touch.declaredAt,
    })
  }

  for (const landing of landings) {
    const ruling = landing.proposal.disposition
    if (ruling === null) continue
    const waypoint = touches.find((touch) => touch.waypoint.id === landing.waypointId)?.waypoint
    lines.push({
      what:
        `landing on waypoint ${waypoint?.ordinal ?? '?'} ${
          waypoint === undefined ? '' : `“${waypoint.name}” `
        }${landing.proposal.status}`,
      when: `ruling ${ruling.seq} · ${ruling.at.slice(0, 10)}`,
      note: ruling.note === '' ? null : ruling.note,
      at: ruling.at,
    })
  }

  return lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

// ── Odds and ends ───────────────────────────────────────────────────────────────

const HEADINGS: ArcPageView['headings'] = {
  statement: {
    name: 'What this arc is',
    explains:
      'your own words — what the arc is about and the question it asks, and the thing you ' +
      're-read when you have forgotten what it was (D24)',
  },
  waypoints: {
    name: 'Waypoints',
    explains:
      'ordered · an episode declares its position, and behaviour off that position is a ' +
      'finding (D8) · landing one is a proposal you rule',
  },
  glance: { name: 'This arc at a glance', explains: 'its scope, its kind, and whether it has gone quiet' },
  episodes: {
    name: 'Episodes touching it',
    explains: 'every episode that declares a position on this arc, and what it claimed',
  },
  checked: {
    name: 'How this arc is checked',
    explains: 'D8, with the drift check’s own composed instructions as the worked example',
  },
  history: {
    name: 'History',
    explains: 'the arc’s edits with your notes, the positions declared on it, and the rulings',
  },
}

/**
 * The season an arc resolves inside, or null when it runs across the show. Read through the
 * arc's own show rather than by id, because `arc.season_id` is null exactly when the scope is
 * `show` — 0001 makes that a biconditional CHECK, so there is nothing to look up in that case.
 */
function seasonOf(store: Store, arc: Arc): Season | null {
  if (arc.seasonId === null) return null
  return seasonsOf(store, arc.showId).find((season) => season.id === arc.seasonId) ?? null
}

/** "season 1", or "the whole show" for an arc whose `season_id` is null (the 0001 CHECK). */
function scopeWords(store: Store, arc: Arc): string {
  const season = seasonOf(store, arc)
  return season === null ? 'the whole show' : `season ${season.number}`
}

function seasonHref(store: Store, arc: Arc, room: Destination): string {
  const season = seasonOf(store, arc)
  return season === null ? room.path : `${room.path}/${season.id}`
}

/** The statement, as it was written — blank lines are paragraph breaks and nothing else. */
function paragraphs(statement: string): string[] {
  return statement
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function roomFor(rooms: readonly Destination[], id: string): Destination {
  return rooms.find((room) => room.id === id)!
}

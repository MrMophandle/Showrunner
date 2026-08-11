import type { Store } from '../db/store.ts'
import { newId } from './id.ts'
import type { Episode } from './spine.ts'

/**
 * Arcs, their waypoints, and the positions episodes declare on them (D8, expanded by D24).
 *
 * An arc carries a prose **statement** — what it is about and the question it asks — and
 * each waypoint carries what it means and what landing it looks like. Waypoints are
 * insertable mid-sequence; when one goes in, the episodes that declared a later position
 * need re-checking, and that is **computed** from ordinal drift rather than remembered in
 * a flag (the same shape as artifact freshness).
 */

export const ARC_SCOPE = ['show', 'season'] as const
export type ArcScope = (typeof ARC_SCOPE)[number]

export const ARC_KIND = ['character', 'story'] as const
export type ArcKind = (typeof ARC_KIND)[number]

export interface Arc {
  id: string
  showId: string
  /** The season an arc resolves inside, or null when the arc runs across the show. */
  seasonId: string | null
  scope: ArcScope
  kind: ArcKind
  name: string
  /** Prose: what the arc is about and the question it asks. What Ryan re-reads (D24). */
  statement: string
  createdAt: string
}

export interface ArcWaypoint {
  id: string
  arcId: string
  ordinal: number
  name: string
  /** What this waypoint means. */
  description: string
  /** What landing it looks like on screen (D24). */
  landingCriteria: string
  createdAt: string
}

export interface WaypointDraft {
  name: string
  description?: string
  landingCriteria?: string
  note?: string
}

export interface ArcPosition {
  arc: Arc
  waypoint: ArcWaypoint
  /** The waypoint's place in the order when the episode declared it. */
  declaredOrdinal: number
  declaredAt: string
}

export interface RecheckFlag {
  episode: Episode
  arc: Arc
  waypoint: ArcWaypoint
  declaredOrdinal: number
  currentOrdinal: number
  reason: string
}

/** One episode's pin on one arc, from the arc's side. What `positionsOnArc` returns. */
export interface ArcTouch {
  episode: Episode
  arc: Arc
  waypoint: ArcWaypoint
  declaredOrdinal: number
  declaredAt: string
}

export type ArcEditKind =
  | 'arc-created'
  | 'statement-edited'
  | 'waypoint-added'
  | 'waypoint-inserted'
  | 'waypoint-renamed'
  | 'waypoint-edited'

export interface ArcEdit {
  seq: number
  arcId: string
  waypointId: string | null
  kind: ArcEditKind
  summary: string
  /** Ryan's words about why. A rename keeps its note (D24). */
  note: string
  at: string
}

// ── The arc ─────────────────────────────────────────────────────────────────────

export function createArc(
  store: Store,
  arc: {
    showId: string
    seasonId?: string | null
    scope: ArcScope
    kind: ArcKind
    name: string
    statement: string
  },
): Arc {
  return store.transaction(() => {
    const id = newId('arc')
    store.run(
      'INSERT INTO arc (id, show_id, season_id, scope, kind, name, statement) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      arc.showId,
      arc.seasonId ?? null,
      arc.scope,
      arc.kind,
      arc.name,
      arc.statement,
    )
    recordEdit(store, id, null, 'arc-created', `arc “${arc.name}” created · scope ${arc.scope}`, '')
    return findArc(store, id)!
  })
}

export function findArc(store: Store, id: string): Arc | undefined {
  const row = store.get<ArcRow>('SELECT * FROM arc WHERE id = ?', id)
  return row && hydrateArc(row)
}

export function arcsOf(store: Store, showId: string): Arc[] {
  return store
    .all<ArcRow>('SELECT * FROM arc WHERE show_id = ? ORDER BY name', showId)
    .map(hydrateArc)
}

export function editStatement(
  store: Store,
  arcId: string,
  edit: { statement: string; note?: string },
): Arc {
  return store.transaction(() => {
    store.run('UPDATE arc SET statement = ? WHERE id = ?', edit.statement, arcId)
    const arc = findArc(store, arcId)
    if (!arc) throw new Error(`No such arc: ${arcId}`)
    recordEdit(store, arcId, null, 'statement-edited', 'statement rewritten', edit.note ?? '')
    return arc
  })
}

// ── Waypoints ───────────────────────────────────────────────────────────────────

export function waypointsOf(store: Store, arcId: string): ArcWaypoint[] {
  return store
    .all<WaypointRow>('SELECT * FROM arc_waypoint WHERE arc_id = ? ORDER BY ordinal', arcId)
    .map(hydrateWaypoint)
}

export function findWaypoint(store: Store, id: string): ArcWaypoint | undefined {
  const row = store.get<WaypointRow>('SELECT * FROM arc_waypoint WHERE id = ?', id)
  return row && hydrateWaypoint(row)
}

/** Adds a waypoint to the end of the arc. Nothing renumbers, so nothing needs re-checking. */
export function appendWaypoint(store: Store, arcId: string, draft: WaypointDraft): ArcWaypoint {
  return store.transaction(() => {
    const next =
      (store.get<{ last: number | null }>(
        'SELECT MAX(ordinal) AS last FROM arc_waypoint WHERE arc_id = ?',
        arcId,
      )?.last ?? 0) + 1
    return writeWaypoint(store, arcId, next, draft, 'waypoint-added', `waypoint “${draft.name}” added at ${next}`)
  })
}

/**
 * Inserts a waypoint at `atOrdinal`, pushing everything from there on one place later.
 * Episodes that declared a position at or after the insert keep their `declared_ordinal`,
 * so the drift is visible to `episodesNeedingRecheck` — that is the re-check flag, and it
 * is derived, not stored.
 */
export function insertWaypoint(
  store: Store,
  arcId: string,
  draft: WaypointDraft & { atOrdinal: number },
): ArcWaypoint {
  return store.transaction(() => {
    // Two hops through negative ordinals, because UNIQUE(arc_id, ordinal) is checked per row.
    store.run(
      'UPDATE arc_waypoint SET ordinal = -(ordinal + 1) WHERE arc_id = ? AND ordinal >= ?',
      arcId,
      draft.atOrdinal,
    )
    store.run('UPDATE arc_waypoint SET ordinal = -ordinal WHERE arc_id = ? AND ordinal < 0', arcId)

    return writeWaypoint(
      store,
      arcId,
      draft.atOrdinal,
      draft,
      'waypoint-inserted',
      `waypoint “${draft.name}” inserted at ${draft.atOrdinal}`,
    )
  })
}

export function renameWaypoint(
  store: Store,
  waypointId: string,
  rename: { name: string; note?: string },
): ArcWaypoint {
  return store.transaction(() => {
    const before = findWaypoint(store, waypointId)
    if (!before) throw new Error(`No such waypoint: ${waypointId}`)
    store.run('UPDATE arc_waypoint SET name = ? WHERE id = ?', rename.name, waypointId)
    recordEdit(
      store,
      before.arcId,
      waypointId,
      'waypoint-renamed',
      `“${before.name}” renamed to “${rename.name}”`,
      rename.note ?? '',
    )
    return findWaypoint(store, waypointId)!
  })
}

export function editWaypoint(
  store: Store,
  waypointId: string,
  edit: { description?: string; landingCriteria?: string; note?: string },
): ArcWaypoint {
  return store.transaction(() => {
    const before = findWaypoint(store, waypointId)
    if (!before) throw new Error(`No such waypoint: ${waypointId}`)
    store.run(
      'UPDATE arc_waypoint SET description = ?, landing_criteria = ? WHERE id = ?',
      edit.description ?? before.description,
      edit.landingCriteria ?? before.landingCriteria,
      waypointId,
    )
    recordEdit(
      store,
      before.arcId,
      waypointId,
      'waypoint-edited',
      `waypoint “${before.name}” rewritten`,
      edit.note ?? '',
    )
    return findWaypoint(store, waypointId)!
  })
}

// ── Positions ───────────────────────────────────────────────────────────────────

/**
 * "arc1 @ waypoint2". Declaring again — after a waypoint went in ahead of it, say — is how
 * an episode confirms it has been re-checked at its new place in the order.
 */
export function declarePosition(
  store: Store,
  position: { episodeId: string; arcId: string; waypointId: string },
): ArcPosition {
  return store.transaction(() => {
    const waypoint = findWaypoint(store, position.waypointId)
    if (!waypoint || waypoint.arcId !== position.arcId) {
      throw new Error(`Waypoint ${position.waypointId} does not belong to arc ${position.arcId}`)
    }
    store.run(
      `INSERT INTO episode_arc_position (episode_id, arc_id, waypoint_id, declared_ordinal)
            VALUES (?, ?, ?, ?)
       ON CONFLICT (episode_id, arc_id) DO UPDATE SET
            waypoint_id = excluded.waypoint_id,
            declared_ordinal = excluded.declared_ordinal,
            declared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      position.episodeId,
      position.arcId,
      position.waypointId,
      waypoint.ordinal,
    )
    return positionsOf(store, position.episodeId).find((p) => p.arc.id === position.arcId)!
  })
}

export function positionsOf(store: Store, episodeId: string): ArcPosition[] {
  return store
    .all<PositionRow>(
      `SELECT p.declared_ordinal, p.declared_at,
              a.id AS arc_id, a.show_id, a.season_id, a.scope, a.kind, a.name AS arc_name,
              a.statement, a.created_at AS arc_created_at,
              w.id AS waypoint_id, w.ordinal, w.name AS waypoint_name, w.description,
              w.landing_criteria, w.created_at AS waypoint_created_at
         FROM episode_arc_position p
         JOIN arc a ON a.id = p.arc_id
         JOIN arc_waypoint w ON w.id = p.waypoint_id
        WHERE p.episode_id = ?
        ORDER BY a.name`,
      episodeId,
    )
    .map((row) => ({
      arc: arcFromJoin(row),
      waypoint: waypointFromJoin(row),
      declaredOrdinal: row.declared_ordinal,
      declaredAt: row.declared_at,
    }))
}

/** An episode touching no arc is vanilla — legal, tracked, never a failure state (1.1). */
export function isVanilla(store: Store, episodeId: string): boolean {
  return positionsOf(store, episodeId).length === 0
}

/**
 * The other way round: every episode that declares a position on ONE arc, in episode order
 * (E5-5, #85). `positionsOf` answers "where does this episode stand"; this answers "who has
 * touched this arc", which is the question both the season map's row and the arc page's
 * episode list ask, and the one the hanging-thread computation counts in.
 *
 * It reads the same three tables `episodesNeedingRecheck` does and applies no drift filter —
 * a position that has NOT drifted is still a touch. Ordered by episode number because that
 * is the axis a season is read along; the season map's columns are exactly this order.
 */
export function positionsOnArc(store: Store, arcId: string): ArcTouch[] {
  return store
    .all<TouchRow>(
      `SELECT p.declared_ordinal, p.declared_at,
              e.id AS episode_id, e.season_id AS episode_season_id, e.number, e.title, e.lifecycle,
              e.abandoned_at AS episode_abandoned_at,
              e.created_at AS episode_created_at, e.updated_at AS episode_updated_at,
              a.id AS arc_id, a.show_id, a.season_id, a.scope, a.kind,
              a.name AS arc_name, a.statement, a.created_at AS arc_created_at,
              w.id AS waypoint_id, w.ordinal, w.name AS waypoint_name, w.description,
              w.landing_criteria, w.created_at AS waypoint_created_at
         FROM episode_arc_position p
         JOIN episode e ON e.id = p.episode_id
         JOIN arc a ON a.id = p.arc_id
         JOIN arc_waypoint w ON w.id = p.waypoint_id
        WHERE p.arc_id = ?
        ORDER BY e.number`,
      arcId,
    )
    .map((row) => ({
      episode: {
        id: row.episode_id,
        seasonId: row.episode_season_id,
        number: row.number,
        title: row.title,
        lifecycle: row.lifecycle,
        abandonedAt: row.episode_abandoned_at,
        createdAt: row.episode_created_at,
        updatedAt: row.episode_updated_at,
      },
      arc: arcFromJoin(row),
      waypoint: waypointFromJoin(row),
      declaredOrdinal: row.declared_ordinal,
      declaredAt: row.declared_at,
    }))
}

/**
 * The episodes whose declared position has drifted — a waypoint went in ahead of them, so
 * what they were checked against is no longer where they sit. Computed from the ordinal
 * they declared against versus the waypoint's ordinal now; no flag is ever written.
 */
export function episodesNeedingRecheck(store: Store, arcId: string): RecheckFlag[] {
  return store
    .all<RecheckRow>(
      `SELECT p.declared_ordinal, p.declared_at,
              e.id AS episode_id, e.season_id AS episode_season_id, e.number, e.title, e.lifecycle,
              e.abandoned_at AS episode_abandoned_at,
              e.created_at AS episode_created_at, e.updated_at AS episode_updated_at,
              a.id AS arc_id, a.show_id, a.season_id, a.scope, a.kind,
              a.name AS arc_name, a.statement, a.created_at AS arc_created_at,
              w.id AS waypoint_id, w.ordinal, w.name AS waypoint_name, w.description,
              w.landing_criteria, w.created_at AS waypoint_created_at
         FROM episode_arc_position p
         JOIN episode e ON e.id = p.episode_id
         JOIN arc a ON a.id = p.arc_id
         JOIN arc_waypoint w ON w.id = p.waypoint_id
        WHERE p.arc_id = ? AND w.ordinal <> p.declared_ordinal
        ORDER BY e.number`,
      arcId,
    )
    .map((row) => {
      const waypoint = waypointFromJoin(row)
      const moved =
        row.ordinal > row.declared_ordinal
          ? 'a waypoint was inserted ahead of it'
          : 'the order ahead of it changed'
      return {
        episode: {
          id: row.episode_id,
          seasonId: row.episode_season_id,
          number: row.number,
          title: row.title,
          lifecycle: row.lifecycle,
          abandonedAt: row.episode_abandoned_at,
          createdAt: row.episode_created_at,
          updatedAt: row.episode_updated_at,
        },
        arc: arcFromJoin(row),
        waypoint,
        declaredOrdinal: row.declared_ordinal,
        currentOrdinal: row.ordinal,
        reason:
          `declared waypoint ${row.declared_ordinal} “${waypoint.name}”; ` +
          `${moved}, so it is now waypoint ${row.ordinal}`,
      }
    })
}

// ── History ─────────────────────────────────────────────────────────────────────

/** The arc page's History panel, newest first. */
export function arcHistory(store: Store, arcId: string): ArcEdit[] {
  return store
    .all<EditRow>('SELECT * FROM arc_edit WHERE arc_id = ? ORDER BY seq DESC', arcId)
    .map((row) => ({
      seq: row.seq,
      arcId: row.arc_id,
      waypointId: row.waypoint_id,
      kind: row.kind,
      summary: row.summary,
      note: row.note,
      at: row.at,
    }))
}

function recordEdit(
  store: Store,
  arcId: string,
  waypointId: string | null,
  kind: ArcEditKind,
  summary: string,
  note: string,
): void {
  store.run(
    'INSERT INTO arc_edit (arc_id, waypoint_id, kind, summary, note) VALUES (?, ?, ?, ?, ?)',
    arcId,
    waypointId,
    kind,
    summary,
    note,
  )
}

function writeWaypoint(
  store: Store,
  arcId: string,
  ordinal: number,
  draft: WaypointDraft,
  kind: ArcEditKind,
  summary: string,
): ArcWaypoint {
  const id = newId('wp')
  store.run(
    'INSERT INTO arc_waypoint (id, arc_id, ordinal, name, description, landing_criteria) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    arcId,
    ordinal,
    draft.name,
    draft.description ?? '',
    draft.landingCriteria ?? '',
  )
  recordEdit(store, arcId, id, kind, summary, draft.note ?? '')
  return findWaypoint(store, id)!
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface ArcRow {
  id: string
  show_id: string
  season_id: string | null
  scope: ArcScope
  kind: ArcKind
  name: string
  statement: string
  created_at: string
}

interface WaypointRow {
  id: string
  arc_id: string
  ordinal: number
  name: string
  description: string
  landing_criteria: string
  created_at: string
}

interface ArcJoin {
  arc_id: string
  show_id: string
  season_id: string | null
  scope: ArcScope
  kind: ArcKind
  arc_name: string
  statement: string
  arc_created_at: string
  waypoint_id: string
  ordinal: number
  waypoint_name: string
  description: string
  landing_criteria: string
  waypoint_created_at: string
}

interface PositionRow extends ArcJoin {
  declared_ordinal: number
  declared_at: string
}

interface RecheckRow extends ArcJoin {
  declared_ordinal: number
  declared_at: string
  episode_id: string
  episode_season_id: string
  number: number
  title: string
  lifecycle: Episode['lifecycle']
  episode_abandoned_at: string | null
  episode_created_at: string
  episode_updated_at: string
}

/** The same join, without the drift filter — `positionsOnArc` reads every touch. */
type TouchRow = RecheckRow

interface EditRow {
  seq: number
  arc_id: string
  waypoint_id: string | null
  kind: ArcEditKind
  summary: string
  note: string
  at: string
}

const hydrateArc = (row: ArcRow): Arc => ({
  id: row.id,
  showId: row.show_id,
  seasonId: row.season_id,
  scope: row.scope,
  kind: row.kind,
  name: row.name,
  statement: row.statement,
  createdAt: row.created_at,
})

const hydrateWaypoint = (row: WaypointRow): ArcWaypoint => ({
  id: row.id,
  arcId: row.arc_id,
  ordinal: row.ordinal,
  name: row.name,
  description: row.description,
  landingCriteria: row.landing_criteria,
  createdAt: row.created_at,
})

const arcFromJoin = (row: ArcJoin): Arc => ({
  id: row.arc_id,
  showId: row.show_id,
  seasonId: row.season_id,
  scope: row.scope,
  kind: row.kind,
  name: row.arc_name,
  statement: row.statement,
  createdAt: row.arc_created_at,
})

const waypointFromJoin = (row: ArcJoin): ArcWaypoint => ({
  id: row.waypoint_id,
  arcId: row.arc_id,
  ordinal: row.ordinal,
  name: row.waypoint_name,
  description: row.description,
  landingCriteria: row.landing_criteria,
  createdAt: row.waypoint_created_at,
})

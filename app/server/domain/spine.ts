import type { Store } from '../db/store.ts'
import { newId } from './id.ts'

/**
 * Show → Season → Episode → Scene. Everything is scoped to a show; nothing here
 * hardcodes one.
 */

/**
 * The episode lifecycle (1.1), as a const array and a union type — never a TS `enum`.
 * The server runs its TypeScript under Node's type stripping, which only erases; an
 * enum would typecheck and then fail to boot.
 */
export const EPISODE_LIFECYCLE = [
  'premise',
  'outline',
  'script',
  'assets',
  'assembled',
  'published',
] as const
export type EpisodeLifecycle = (typeof EPISODE_LIFECYCLE)[number]

export interface Show {
  id: string
  key: string
  title: string
  createdAt: string
}

export interface Season {
  id: string
  showId: string
  number: number
  title: string | null
  createdAt: string
}

export interface Episode {
  id: string
  seasonId: string
  number: number
  title: string
  lifecycle: EpisodeLifecycle
  createdAt: string
  updatedAt: string
}

export interface Scene {
  id: string
  episodeId: string
  ordinal: number
  heading: string
  summary: string
  createdAt: string
}

/** One scene as the writer broke it. There is no ordinal here — order is the array's. */
export interface SceneDraft {
  heading: string
  summary?: string
}

// ── Show ────────────────────────────────────────────────────────────────────────

export function createShow(store: Store, show: { key: string; title: string }): Show {
  const id = newId('show')
  store.run('INSERT INTO show (id, key, title) VALUES (?, ?, ?)', id, show.key, show.title)
  return findShow(store, id)!
}

export function findShow(store: Store, id: string): Show | undefined {
  const row = store.get<ShowRow>('SELECT * FROM show WHERE id = ?', id)
  return row && hydrateShow(row)
}

export function findShowByKey(store: Store, key: string): Show | undefined {
  const row = store.get<ShowRow>('SELECT * FROM show WHERE key = ?', key)
  return row && hydrateShow(row)
}

/**
 * Every show in this library, oldest first. Multi-show is the point (1.1) — a screen that
 * asked for "the show" would be the first hardcoded one, and there is none anywhere.
 */
export function shows(store: Store): Show[] {
  return store.all<ShowRow>('SELECT * FROM show ORDER BY created_at, key').map(hydrateShow)
}

// ── Season ──────────────────────────────────────────────────────────────────────

export function createSeason(
  store: Store,
  season: { showId: string; number: number; title?: string },
): Season {
  const id = newId('season')
  store.run(
    'INSERT INTO season (id, show_id, number, title) VALUES (?, ?, ?, ?)',
    id,
    season.showId,
    season.number,
    season.title ?? null,
  )
  return hydrateSeason(store.get<SeasonRow>('SELECT * FROM season WHERE id = ?', id)!)
}

export function seasonsOf(store: Store, showId: string): Season[] {
  return store
    .all<SeasonRow>('SELECT * FROM season WHERE show_id = ? ORDER BY number', showId)
    .map(hydrateSeason)
}

// ── Episode ─────────────────────────────────────────────────────────────────────

export function createEpisode(
  store: Store,
  episode: { seasonId: string; number: number; title: string },
): Episode {
  const id = newId('ep')
  store.run(
    'INSERT INTO episode (id, season_id, number, title) VALUES (?, ?, ?, ?)',
    id,
    episode.seasonId,
    episode.number,
    episode.title,
  )
  return findEpisode(store, id)!
}

export function findEpisode(store: Store, id: string): Episode | undefined {
  const row = store.get<EpisodeRow>('SELECT * FROM episode WHERE id = ?', id)
  return row && hydrateEpisode(row)
}

export function episodesOf(store: Store, seasonId: string): Episode[] {
  return store
    .all<EpisodeRow>('SELECT * FROM episode WHERE season_id = ? ORDER BY number', seasonId)
    .map(hydrateEpisode)
}

/**
 * An episode with the season and show it belongs to. Every sentence about an episode
 * needs all three — "the Grey Harbor ep01 premise-brief" names a show, a number, and a
 * thing — and a step composing a file path needs the show key and both numbers.
 */
export interface EpisodeInShow {
  show: Show
  season: Season
  episode: Episode
}

export function episodeInShow(store: Store, episodeId: string): EpisodeInShow | undefined {
  const episode = findEpisode(store, episodeId)
  if (!episode) return undefined
  const season = hydrateSeason(
    store.get<SeasonRow>('SELECT * FROM season WHERE id = ?', episode.seasonId)!,
  )
  return { show: findShow(store, season.showId)!, season, episode }
}

/** "ep01" — the episode as every screen, every path, and every log line names it. */
export const episodeLabel = (number: number): string => `ep${String(number).padStart(2, '0')}`

export function moveLifecycleTo(
  store: Store,
  episodeId: string,
  lifecycle: EpisodeLifecycle,
): Episode {
  store.run(
    "UPDATE episode SET lifecycle = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    lifecycle,
    episodeId,
  )
  return findEpisode(store, episodeId)!
}

// ── Scene ───────────────────────────────────────────────────────────────────────

/**
 * Records the scenes the episode broke into, in order (D3). Scenes are an OUTPUT of the
 * written episode: there is no scene-count parameter here, on `createEpisode`, or in the
 * schema, and there must never be one.
 *
 * Re-delineating an episode keeps the id of every scene that stayed at its ordinal, so
 * artifacts anchored to a scene stay anchored across a rewrite.
 */
export function delineateScenes(store: Store, episodeId: string, drafts: SceneDraft[]): Scene[] {
  return store.transaction(() => {
    const existing = scenesOf(store, episodeId)

    store.run('DELETE FROM scene WHERE episode_id = ? AND ordinal > ?', episodeId, drafts.length)

    drafts.forEach((draft, index) => {
      const ordinal = index + 1
      const summary = draft.summary ?? ''
      const held = existing[index]
      if (held) {
        store.run(
          'UPDATE scene SET heading = ?, summary = ? WHERE id = ?',
          draft.heading,
          summary,
          held.id,
        )
      } else {
        store.run(
          'INSERT INTO scene (id, episode_id, ordinal, heading, summary) VALUES (?, ?, ?, ?, ?)',
          newId('scene'),
          episodeId,
          ordinal,
          draft.heading,
          summary,
        )
      }
    })

    return scenesOf(store, episodeId)
  })
}

export function scenesOf(store: Store, episodeId: string): Scene[] {
  return store
    .all<SceneRow>('SELECT * FROM scene WHERE episode_id = ? ORDER BY ordinal', episodeId)
    .map(hydrateScene)
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface ShowRow {
  id: string
  key: string
  title: string
  created_at: string
}
interface SeasonRow {
  id: string
  show_id: string
  number: number
  title: string | null
  created_at: string
}
interface EpisodeRow {
  id: string
  season_id: string
  number: number
  title: string
  lifecycle: EpisodeLifecycle
  created_at: string
  updated_at: string
}
interface SceneRow {
  id: string
  episode_id: string
  ordinal: number
  heading: string
  summary: string
  created_at: string
}

const hydrateShow = (row: ShowRow): Show => ({
  id: row.id,
  key: row.key,
  title: row.title,
  createdAt: row.created_at,
})

const hydrateSeason = (row: SeasonRow): Season => ({
  id: row.id,
  showId: row.show_id,
  number: row.number,
  title: row.title,
  createdAt: row.created_at,
})

const hydrateEpisode = (row: EpisodeRow): Episode => ({
  id: row.id,
  seasonId: row.season_id,
  number: row.number,
  title: row.title,
  lifecycle: row.lifecycle,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const hydrateScene = (row: SceneRow): Scene => ({
  id: row.id,
  episodeId: row.episode_id,
  ordinal: row.ordinal,
  heading: row.heading,
  summary: row.summary,
  createdAt: row.created_at,
})

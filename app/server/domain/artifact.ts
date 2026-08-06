import type { Store } from '../db/store.ts'
import { entitiesByIds, type CanonEntity } from './canon.ts'
import { newId } from './id.ts'

/**
 * Artifacts, their provenance, and their freshness.
 *
 * **Staleness is computed, never remembered** (1.3). There is no is_stale column and no
 * cache: an artifact records what it consumed and at which version, and "is this stale,
 * and why" is a query over those edges. The stored-boolean version of this is the
 * expensive-to-unwind mistake.
 */

export const ARTIFACT_KIND = [
  'premise-brief',
  'outline',
  'script',
  'scene-text',
  'continuity-board',
  'shot-manifest',
  'shot-image',
  'tts-take',
  'mix',
  'timeline',
  'render',
  'publish-kit',
] as const
export type ArtifactKind = (typeof ARTIFACT_KIND)[number]

export interface Artifact {
  id: string
  episodeId: string
  /** The scene this artifact belongs to, for the ones that belong to one. */
  sceneId: string | null
  kind: ArtifactKind
  /** Distinguishes the many artifacts of one kind in an episode ('shot-05'); '' if singular. */
  slot: string
  version: number
  /** Relative to the library's artifact dir. NULL until the artifact has actually been produced. */
  filePath: string | null
  createdAt: string
  updatedAt: string
}

/** What changed at one version of an artifact. `sceneId` null means the whole thing changed. */
export interface ArtifactRevision {
  version: number
  sceneId: string | null
  summary: string
  at: string
}

/**
 * One freshness edge. `sceneId` narrows what was consumed to a single scene of the input —
 * that is what lets a scene-3 edit stale the three scene-3 shots and leave the other eight
 * alone, instead of staling every shot in the episode.
 */
export interface ArtifactInput {
  artifactId: string
  /** Defaults to the input's current version — a step consumes what is there now. */
  version?: number
  sceneId?: string | null
}

export interface ArtifactDraft {
  episodeId: string
  kind: ArtifactKind
  slot?: string
  sceneId?: string | null
  filePath?: string | null
  /** The canon entities this artifact touches (invariant 2). */
  touches?: string[]
  builtFrom?: ArtifactInput[]
}

export type StaleReason =
  | {
      kind: 'input-moved-on'
      input: Artifact
      consumedVersion: number
      currentVersion: number
      /** The scene of the input this artifact consumed, if it consumed only one. */
      sceneId: string | null
      /** The revisions since, in order — the words for "your scene-3 edit made v4". */
      revisions: ArtifactRevision[]
    }
  | { kind: 'input-is-stale'; input: Artifact }

export interface StaleArtifact {
  artifact: Artifact
  reasons: StaleReason[]
}

export type FreshnessStatus = 'fresh' | 'stale' | 'not-started'

export interface ArtifactFreshness {
  artifact: Artifact
  status: FreshnessStatus
  reasons: StaleReason[]
}

// ── Recording ───────────────────────────────────────────────────────────────────

export function recordArtifact(store: Store, draft: ArtifactDraft): Artifact {
  return store.transaction(() => {
    const id = newId('art')
    store.run(
      'INSERT INTO artifact (id, episode_id, scene_id, kind, slot, file_path) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      draft.episodeId,
      draft.sceneId ?? null,
      draft.kind,
      draft.slot ?? '',
      draft.filePath ?? null,
    )
    store.run(
      'INSERT INTO artifact_revision (artifact_id, version, summary) VALUES (?, 1, ?)',
      id,
      'first version',
    )
    if (draft.touches?.length) declareProvenance(store, id, draft.touches)
    if (draft.builtFrom?.length) recordInputs(store, id, draft.builtFrom)
    return findArtifact(store, id)!
  })
}

/**
 * A new version of an artifact. `touchedScenes` says which scenes the revision actually
 * changed; leaving it off means the whole artifact changed, which stales every consumer.
 */
export function reviseArtifact(
  store: Store,
  artifactId: string,
  revision: { summary: string; touchedScenes?: string[]; filePath?: string | null },
): Artifact {
  return store.transaction(() => {
    store.run(
      "UPDATE artifact SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      artifactId,
    )
    const artifact = findArtifact(store, artifactId)
    if (!artifact) throw new Error(`No such artifact: ${artifactId}`)

    if (revision.filePath !== undefined) {
      store.run('UPDATE artifact SET file_path = ? WHERE id = ?', revision.filePath, artifactId)
    }

    const scenes = revision.touchedScenes?.length ? revision.touchedScenes : [null]
    for (const sceneId of scenes) {
      store.run(
        'INSERT INTO artifact_revision (artifact_id, version, scene_id, summary) VALUES (?, ?, ?, ?)',
        artifactId,
        artifact.version,
        sceneId,
        revision.summary,
      )
    }
    return findArtifact(store, artifactId)!
  })
}

export function declareProvenance(store: Store, artifactId: string, entityIds: string[]): void {
  store.transaction(() => {
    for (const entityId of entityIds) {
      store.run(
        'INSERT OR IGNORE INTO artifact_provenance (artifact_id, entity_id) VALUES (?, ?)',
        artifactId,
        entityId,
      )
    }
  })
}

/**
 * The entities this artifact declares it touches (invariant 2), hydrated by canon.ts —
 * which owns what a `CanonEntity` is. E2-0 grew that shape with standing, status, aliases
 * and a prose body, and a second hand-rolled hydration here would have quietly kept
 * handing checks an entity with none of it.
 */
export function provenanceOf(store: Store, artifactId: string): CanonEntity[] {
  return entitiesByIds(
    store,
    store
      .all<{ entity_id: string }>(
        'SELECT entity_id FROM artifact_provenance WHERE artifact_id = ?',
        artifactId,
      )
      .map((row) => row.entity_id),
  )
}

/**
 * Records (or re-records) what this artifact was built from. Re-recording after a rebuild
 * is what makes a stale artifact fresh again — the edge moves to the current version.
 */
export function recordInputs(store: Store, artifactId: string, inputs: ArtifactInput[]): void {
  store.transaction(() => {
    for (const input of inputs) {
      const source = findArtifact(store, input.artifactId)
      if (!source) throw new Error(`No such input artifact: ${input.artifactId}`)
      const sceneId = input.sceneId ?? null
      store.run(
        `DELETE FROM artifact_input
          WHERE artifact_id = ? AND input_artifact_id = ?
            AND COALESCE(scene_id, '') = COALESCE(?, '')`,
        artifactId,
        input.artifactId,
        sceneId,
      )
      store.run(
        'INSERT INTO artifact_input (artifact_id, input_artifact_id, consumed_version, scene_id) VALUES (?, ?, ?, ?)',
        artifactId,
        input.artifactId,
        input.version ?? source.version,
        sceneId,
      )
    }
  })
}

// ── Reading ─────────────────────────────────────────────────────────────────────

export function findArtifact(store: Store, id: string): Artifact | undefined {
  const row = store.get<ArtifactRow>('SELECT * FROM artifact WHERE id = ?', id)
  return row && hydrate(row)
}

export function artifactsOf(store: Store, episodeId: string): Artifact[] {
  return store
    .all<ArtifactRow>('SELECT * FROM artifact WHERE episode_id = ? ORDER BY kind, slot', episodeId)
    .map(hydrate)
}

export function revisionsOf(store: Store, artifactId: string): ArtifactRevision[] {
  return store
    .all<RevisionRow>(
      'SELECT version, scene_id, summary, at FROM artifact_revision WHERE artifact_id = ? ORDER BY version',
      artifactId,
    )
    .map(hydrateRevision)
}

/**
 * The freshness rule, in one place.
 *
 * `moved_on` is every edge whose input has published a version the consumer has not taken —
 * counting only revisions that touched the scene the consumer actually consumed. `stale`
 * is the transitive closure over those: anything built on something stale is stale too.
 * `UNION` (not `UNION ALL`) is what makes the recursion terminate on a cycle.
 */
const FRESHNESS = `
  WITH RECURSIVE
    moved_on AS (
      SELECT i.artifact_id AS consumer_id, i.input_artifact_id AS input_id,
             i.consumed_version, i.scene_id AS edge_scene_id
        FROM artifact_input i
        JOIN artifact src ON src.id = i.input_artifact_id
       WHERE src.version > i.consumed_version
         AND EXISTS (
           SELECT 1 FROM artifact_revision r
            WHERE r.artifact_id = src.id
              AND r.version > i.consumed_version
              AND (r.scene_id IS NULL OR i.scene_id IS NULL OR r.scene_id = i.scene_id)
         )
    ),
    stale(id) AS (
      SELECT consumer_id FROM moved_on
      UNION
      SELECT i.artifact_id
        FROM artifact_input i
        JOIN stale s ON s.id = i.input_artifact_id
    )
`

/** Which artifacts of this episode are stale, and why. */
export function staleArtifacts(store: Store, episodeId: string): StaleArtifact[] {
  const stale = store
    .all<ArtifactRow>(
      `${FRESHNESS}
       SELECT a.* FROM artifact a
        WHERE a.episode_id = ? AND a.id IN (SELECT id FROM stale)
        ORDER BY a.kind, a.slot`,
      episodeId,
    )
    .map(hydrate)

  return stale.map((artifact) => ({ artifact, reasons: reasonsFor(store, artifact.id) }))
}

/** Every artifact of the episode with its freshness — the episode room's Artifacts panel. */
export function artifactFreshness(store: Store, episodeId: string): ArtifactFreshness[] {
  const stale = new Map(staleArtifacts(store, episodeId).map((s) => [s.artifact.id, s.reasons]))

  return artifactsOf(store, episodeId).map((artifact) => {
    if (artifact.filePath === null) {
      return { artifact, status: 'not-started' as const, reasons: [] }
    }
    const reasons = stale.get(artifact.id)
    return reasons
      ? { artifact, status: 'stale' as const, reasons }
      : { artifact, status: 'fresh' as const, reasons: [] }
  })
}

function reasonsFor(store: Store, artifactId: string): StaleReason[] {
  const rows = store.all<ReasonRow>(
    `${FRESHNESS}
     SELECT i.consumed_version AS consumed_version,
            i.scene_id AS edge_scene_id,
            src.*,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM moved_on m
                 WHERE m.consumer_id = i.artifact_id
                   AND m.input_id = i.input_artifact_id
                   AND COALESCE(m.edge_scene_id, '') = COALESCE(i.scene_id, '')
              ) THEN 'input-moved-on'
              WHEN src.id IN (SELECT id FROM stale) THEN 'input-is-stale'
              ELSE 'fresh'
            END AS reason_kind
       FROM artifact_input i
       JOIN artifact src ON src.id = i.input_artifact_id
      WHERE i.artifact_id = ?
      ORDER BY src.kind, src.slot`,
    artifactId,
  )

  const reasons: StaleReason[] = []
  for (const row of rows) {
    const input = hydrate(row)
    if (row.reason_kind === 'input-moved-on') {
      reasons.push({
        kind: 'input-moved-on',
        input,
        consumedVersion: row.consumed_version,
        currentVersion: input.version,
        sceneId: row.edge_scene_id,
        revisions: revisionsSince(store, input.id, row.consumed_version, row.edge_scene_id),
      })
    } else if (row.reason_kind === 'input-is-stale') {
      reasons.push({ kind: 'input-is-stale', input })
    }
  }
  return reasons
}

function revisionsSince(
  store: Store,
  artifactId: string,
  version: number,
  sceneId: string | null,
): ArtifactRevision[] {
  return store
    .all<RevisionRow>(
      `SELECT version, scene_id, summary, at
         FROM artifact_revision
        WHERE artifact_id = ? AND version > ?
          AND (scene_id IS NULL OR ? IS NULL OR scene_id = ?)
        ORDER BY version`,
      artifactId,
      version,
      sceneId,
      sceneId,
    )
    .map(hydrateRevision)
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface ArtifactRow {
  id: string
  episode_id: string
  scene_id: string | null
  kind: ArtifactKind
  slot: string
  version: number
  file_path: string | null
  created_at: string
  updated_at: string
}

interface ReasonRow extends ArtifactRow {
  consumed_version: number
  edge_scene_id: string | null
  reason_kind: 'input-moved-on' | 'input-is-stale' | 'fresh'
}

interface RevisionRow {
  version: number
  scene_id: string | null
  summary: string
  at: string
}

const hydrate = (row: ArtifactRow): Artifact => ({
  id: row.id,
  episodeId: row.episode_id,
  sceneId: row.scene_id,
  kind: row.kind,
  slot: row.slot,
  version: row.version,
  filePath: row.file_path,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const hydrateRevision = (row: RevisionRow): ArtifactRevision => ({
  version: row.version,
  sceneId: row.scene_id,
  summary: row.summary,
  at: row.at,
})

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Store } from '../db/store.ts'
import {
  appendWaypoint,
  arcsOf,
  createArc,
  declarePosition,
  editStatement,
  editWaypoint,
  positionsOf,
  renameWaypoint,
  waypointsOf,
  type Arc,
} from '../domain/arc.ts'
import {
  artifactsOf,
  declareProvenance,
  recordArtifact,
  recordInputs,
  type Artifact,
} from '../domain/artifact.ts'
import { findEntity, registerEntity, type CanonEntity } from '../domain/canon.ts'
import {
  createEpisode,
  createSeason,
  createShow,
  delineateScenes,
  episodesOf,
  findShowByKey,
  moveLifecycleTo,
  seasonsOf,
  type Episode,
  type Season,
  type Show,
} from '../domain/spine.ts'
import { writeIfAbsent, type LibraryPaths } from '../library.ts'
import {
  FIXTURE_DIR,
  readFixture,
  type FixtureArc,
  type FixtureEpisode,
  type FixtureShow,
} from './read.ts'

/**
 * Puts the Grey Harbor fixture into a library volume. `npm run fixture:load`.
 *
 * Two rules shape this module.
 *
 * **One path into the database.** Every row here goes through the same typed domain
 * functions the app uses — `createEpisode`, `delineateScenes`, `recordArtifact`,
 * `appendWaypoint`. There are no INSERTs in this file. A loader with its own SQL is a
 * second way in, and the day the schema changes it is the one nobody updates; worse, it
 * lets the fixture hold shapes the app cannot actually produce, which makes every test
 * written against it a test of a state that can never occur.
 *
 * **Idempotent means re-runnable, not guarded.** There is no `if (alreadyLoaded)
 * return` here, and there must not be: an early-out passes a load-twice test while
 * hiding whether the loader can reconcile anything at all. Instead every step looks for
 * what it would create, and creates only what is missing — so a second run walks the
 * whole fixture, writes nothing, and reports what it found. Run it against a library
 * that lost an episode and it puts the episode back.
 *
 * Nothing here generates. No LLM call, no image, no TTS: the script it seeds was typed
 * by hand and lives in the repository (fixtures before features).
 */

export interface Tally {
  created: number
  found: number
}

export interface FileReport {
  /** Relative to the library's artifact dir — the same string as `artifact.file_path`. */
  path: string
  /** `differs` is a file Ryan (or anyone) changed: it is reported, never overwritten (D20). */
  state: 'written' | 'kept' | 'differs'
}

export interface LoadReport {
  show: Show
  seasons: Tally
  episodes: Tally
  entities: Tally
  arcs: Tally
  waypoints: Tally
  positions: Tally
  artifacts: Tally
  /** Scenes are an output, so a plain count: `delineateScenes` rewrites them in place (D3). */
  scenes: number
  files: FileReport[]
}

export function loadFixture(
  store: Store,
  paths: LibraryPaths,
  dir: string = FIXTURE_DIR,
): LoadReport {
  const fixture = readFixture(dir)

  return store.transaction(() => {
    const show = seedShow(store, fixture)
    const report: LoadReport = {
      show,
      seasons: tally(),
      episodes: tally(),
      entities: tally(),
      arcs: tally(),
      waypoints: tally(),
      positions: tally(),
      artifacts: tally(),
      scenes: 0,
      files: [],
    }

    const seasons = new Map<number, Season>()
    for (const season of fixture.seasons) {
      seasons.set(
        season.number,
        reconcile(report.seasons, seasonsOf(store, show.id).find((s) => s.number === season.number), () =>
          createSeason(store, { showId: show.id, number: season.number, title: season.title }),
        ),
      )
    }

    const entities = new Map<string, CanonEntity>()
    for (const entity of fixture.entities) {
      entities.set(
        entity.name,
        reconcile(
          report.entities,
          findEntity(store, {
            showId: show.id,
            categoryKey: entity.categoryKey,
            name: entity.name,
          }),
          () =>
            // Identity only. Standing, prose, facts and relations are on the sheet and stay
            // there until a proposal carries them to a gate (invariant 1).
            registerEntity(store, {
              showId: show.id,
              categoryKey: entity.categoryKey,
              name: entity.name,
            }),
        ),
      )
    }

    const arcs = new Map<string, Arc>()
    for (const arc of fixture.arcs) {
      const seasonId = arc.seasonNumber === null ? null : seasons.get(arc.seasonNumber)!.id
      const seeded = reconcile(report.arcs, arcsOf(store, show.id).find((a) => a.name === arc.name), () =>
        createArc(store, {
          showId: show.id,
          seasonId,
          scope: arc.scope,
          kind: arc.kind,
          name: arc.name,
          statement: arc.statement,
        }),
      )
      arcs.set(arc.name, seedWaypoints(store, report, seeded, arc))
    }

    for (const episode of fixture.episodes) {
      seedEpisode(store, paths, report, show, seasons.get(episode.seasonNumber)!, episode, entities, arcs)
    }

    return report
  })
}

// ── The spine ───────────────────────────────────────────────────────────────────

function seedShow(store: Store, fixture: FixtureShow): Show {
  const found = findShowByKey(store, fixture.key)
  return found ?? createShow(store, { key: fixture.key, title: fixture.title })
}

function seedEpisode(
  store: Store,
  paths: LibraryPaths,
  report: LoadReport,
  show: Show,
  season: Season,
  fixture: FixtureEpisode,
  entities: Map<string, CanonEntity>,
  arcs: Map<string, Arc>,
): void {
  let episode = reconcile(
    report.episodes,
    episodesOf(store, season.id).find((e) => e.number === fixture.number),
    () =>
      createEpisode(store, { seasonId: season.id, number: fixture.number, title: fixture.title }),
  )
  // Only when it actually differs: an unconditional update would move `updated_at` on
  // every load, and then "loading twice changes nothing" would stop being true.
  if (episode.lifecycle !== fixture.lifecycle) {
    episode = moveLifecycleTo(store, episode.id, fixture.lifecycle)
  }

  // Scenes come out of the script and are rewritten in place, which keeps the id of every
  // scene that stayed at its ordinal — so anything anchored to a scene stays anchored.
  if (fixture.scenes.length > 0) {
    report.scenes += delineateScenes(store, episode.id, fixture.scenes).length
  }

  seedArtifacts(store, paths, report, show, season, episode, fixture, entities)

  for (const position of fixture.positions) {
    const arc = arcs.get(position.arcName)!
    const waypoint = waypointsOf(store, arc.id).find((w) => w.ordinal === position.waypointOrdinal)!
    const standing = positionsOf(store, episode.id).find((p) => p.arc.id === arc.id)
    if (standing?.waypoint.id === waypoint.id) {
      report.positions.found += 1
      continue
    }
    declarePosition(store, { episodeId: episode.id, arcId: arc.id, waypointId: waypoint.id })
    report.positions.created += 1
  }
}

// ── Artifacts, their files, and their edges ─────────────────────────────────────

function seedArtifacts(
  store: Store,
  paths: LibraryPaths,
  report: LoadReport,
  show: Show,
  season: Season,
  episode: Episode,
  fixture: FixtureEpisode,
  entities: Map<string, CanonEntity>,
): void {
  const placed = new Map<string, Artifact>()

  for (const artifact of fixture.artifacts) {
    const path = join(
      show.key,
      `s${pad(season.number)}e${pad(fixture.number)}`,
      artifact.file,
    )
    report.files.push(place(paths, path, readFileSync(join(fixture.dir, artifact.file), 'utf8')))

    const touches = artifact.touches.map((name) => entities.get(name)!.id)
    const builtFrom = artifact.builtFrom.map((kind) => ({ artifactId: placed.get(kind)!.id }))

    const seeded = reconcile(
      report.artifacts,
      artifactsOf(store, episode.id).find((a) => a.kind === artifact.kind && a.slot === ''),
      () =>
        recordArtifact(store, {
          episodeId: episode.id,
          kind: artifact.kind,
          filePath: path,
          touches,
          builtFrom,
        }),
    )
    // Re-declared every load, not only on creation: both are writes that land on what is
    // already there, and doing them unconditionally is what makes a re-run repair a
    // provenance row somebody deleted instead of trusting that it is still there.
    declareProvenance(store, seeded.id, touches)
    if (builtFrom.length > 0) recordInputs(store, seeded.id, builtFrom)

    placed.set(artifact.kind, seeded)
  }
}

/**
 * Writes an artifact file, and never over one that is already there (D20) — a hand-made
 * asset always wins, and "the fixture reset it" is not a thing this command does. A file
 * that no longer matches the repository is reported as `differs` and left alone.
 */
function place(paths: LibraryPaths, path: string, contents: string): FileReport {
  const target = join(paths.artifactDir, path)
  mkdirSync(dirname(target), { recursive: true })

  if (writeIfAbsent(target, contents) === 'written') return { path, state: 'written' }
  return { path, state: readFileSync(target, 'utf8') === contents ? 'kept' : 'differs' }
}

// ── Arcs (D24) ──────────────────────────────────────────────────────────────────

function seedWaypoints(store: Store, report: LoadReport, arc: Arc, fixture: FixtureArc): Arc {
  if (arc.statement !== fixture.statement) {
    arc = editStatement(store, arc.id, {
      statement: fixture.statement,
      note: 'restated from the fixture sheet',
    })
  }

  for (const waypoint of fixture.waypoints) {
    const standing = waypointsOf(store, arc.id)
    const held = standing.find((w) => w.ordinal === waypoint.ordinal)

    if (!held) {
      if (standing.length !== waypoint.ordinal - 1) {
        throw new Error(
          `${fixture.path}: waypoint ${waypoint.ordinal} is missing from the library and the ` +
            `arc already has ${standing.length} — appending would put it in the wrong place. ` +
            'Insert it by hand, or drop the arc and load again.',
        )
      }
      appendWaypoint(store, arc.id, {
        name: waypoint.name,
        description: waypoint.description,
        landingCriteria: waypoint.landingCriteria,
        note: 'seeded from the fixture sheet',
      })
      report.waypoints.created += 1
      continue
    }

    report.waypoints.found += 1
    // An edit appends to the arc's history (D24), so it happens only when the prose has
    // genuinely moved — otherwise every load would grow the history panel by three rows.
    if (held.name !== waypoint.name) {
      renameWaypoint(store, held.id, { name: waypoint.name, note: 'renamed in the fixture sheet' })
    }
    if (
      held.description !== waypoint.description ||
      held.landingCriteria !== waypoint.landingCriteria
    ) {
      editWaypoint(store, held.id, {
        description: waypoint.description,
        landingCriteria: waypoint.landingCriteria,
        note: 'rewritten in the fixture sheet',
      })
    }
  }

  return arc
}

// ── Counting ────────────────────────────────────────────────────────────────────

const tally = (): Tally => ({ created: 0, found: 0 })

/** Found or made — the shape of every step in here, and the reason none of them guard. */
function reconcile<T>(tally: Tally, found: T | undefined, create: () => T): T {
  if (found !== undefined) {
    tally.found += 1
    return found
  }
  tally.created += 1
  return create()
}

const pad = (n: number): string => String(n).padStart(2, '0')

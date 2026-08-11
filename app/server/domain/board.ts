import type { Store } from '../db/store.ts'
import {
  declareProvenance,
  findArtifact,
  recordArtifact,
  replaceInputs,
  reviseArtifact,
  type Artifact,
} from './artifact.ts'
import { entitiesOfShow, type CanonEntity } from './canon.ts'
import { findFact } from './fact.ts'
import { episodeInShow, scenesOf, type Scene } from './spine.ts'

/**
 * The continuity board (3.2b): every script derives one, per scene — location, characters
 * present, environment state, ship position, elapsed time.
 *
 * ## The seam this module exists to hold open
 *
 * "LLM extracts; the worst bugs are then caught deterministically." **Extraction is a paid
 * step. The rules are free.** This module owns the rows in between: `recordExtractedBoard`
 * is what a paid step's answer lands in, and `board-rules.ts` is what runs over the result
 * as many times as anyone likes for nothing. Re-checking after a rewrite must never re-read
 * the script, because re-reading the script is money.
 *
 * ## The board is an artifact, and freshness was built in E1-2
 *
 * There is no staleness code here. The board is `kind: 'continuity-board'`, and it declares
 * what it was built from **one edge per scene** — so a scene-3 edit publishes script v2,
 * the scene-3 edge sees it, and "the board is stale, because your scene-3 edit made v2" is
 * computed by `staleArtifacts` (1.3). Rebuilding re-records the edges and the same
 * computation says fresh again. If anything in this file ever starts to look like it is
 * remembering freshness, delete it and read `artifact.ts`.
 *
 * A rebuild REPLACES the rows rather than versioning them: the board is the current reading
 * of the current script, and the artifact's own version and revisions are where "rebuilt
 * from script v4" is recorded. Two histories of one thing eventually disagree.
 *
 * ## What the model is allowed to be wrong about
 *
 * An extraction is model output, so nothing here trusts it. Environment, protection and
 * hazard are checked against their closed sets; a scene the extraction skipped is refused
 * outright (a grid with a hole in it would have rules reasoning across a gap they cannot
 * see); a named entity that is not in the show is refused rather than dropped, because the
 * prompt hands the model the exact list and inventing one is a broken read, not a nuance.
 *
 * What is NOT enforced is that the model read the script well. That is what the rules, the
 * gate, and Ryan are for.
 */

/**
 * Is the air on this side of the hull? The SCENE's state, not a person's.
 *
 * 3.2b names three — suited / inside / exposed — and the third of them is what a BODY wears,
 * so it lives on `BOARD_PROTECTION` below. Scene 6 of The Long Pier is one exposed place
 * with one suited woman in it, and a single column could not say both. The grid's
 * Environment cell renders the pair, "suited · exposed", exactly as the mockup does.
 *
 * A const array and a union type, never a TS `enum` — Node's type stripping only erases.
 */
export const BOARD_ENVIRONMENT = ['inside', 'exposed'] as const
export type BoardEnvironment = (typeof BOARD_ENVIRONMENT)[number]

/**
 * What is between this body and the void — the two exceptions *The hull and the void* names,
 * the absence of both, and the answer that is not a state at all.
 *
 * **`unknown` is not `none`.** A scene that does not say what someone is wearing has not
 * said they are wearing nothing, and the difference is a person's life. `none` in an exposed
 * scene is a deterministic finding; `unknown` is silence here and E3-2's honest "could not
 * check" there. `fact.ts` spent a four-case enum on the same distinction (D22).
 */
export const BOARD_PROTECTION = ['none', 'hardsuit', 'containment-field', 'unknown'] as const
export type BoardProtection = (typeof BOARD_PROTECTION)[number]

/**
 * What the world says a body cannot survive. One member today, and no SQL CHECK behind it
 * (0007's reasoning): widening it is a code change with a test, never a table rebuild.
 */
export const BOARD_HAZARD = ['lethal-in-vacuum'] as const
export type BoardHazard = (typeof BOARD_HAZARD)[number]

// ── What the board is, read back ────────────────────────────────────────────────

/** One body in one scene — a row of the grid's Present column. */
export interface BoardPresence {
  /** As the script names them. */
  characterName: string
  /** The canon identity, when the extraction could tie one. NULL is a body with no sheet. */
  entityId: string | null
  protection: BoardProtection
  /** Did the SCRIPT show them coming in? Not "were they somewhere else last scene". */
  arrives: boolean
}

/** One row of the scene grid. */
export interface BoardScene {
  sceneId: string
  /** The scene's own ordinal, so the grid's first column and the script agree. */
  ordinal: number
  heading: string
  location: string
  locationEntityId: string | null
  environment: BoardEnvironment
  shipPosition: string
  /** The clock, for the rules. NULL when the scene does not place itself in time. */
  elapsedSeconds: number | null
  /** The clock, for Ryan — "07:20", "CONTINUOUS", "T+2h". */
  elapsedLabel: string
  present: BoardPresence[]
}

/** What one crossing costs, in the direction stated. */
export interface BoardTransit {
  from: string
  to: string
  seconds: number
  /** The canon fact the number came from — the lineage a finding quotes. */
  factId: string | null
}

/** A species the void kills, and the fact that says so. The row states nothing itself. */
export interface BoardHazardRow {
  entityId: string
  hazard: BoardHazard
  factId: string
}

export interface Board {
  artifact: Artifact
  /**
   * The artifact the grid was read out of — the script. A board rule runs against the BOARD
   * and lands its findings in the SCRIPT's scene (0010), and this is how it gets there.
   * Undefined only for a board recorded with no source at all, which nothing here does.
   */
  source: Artifact | undefined
  /** In scene order. This IS the episode room's scene grid. */
  scenes: BoardScene[]
  transits: BoardTransit[]
  hazards: BoardHazardRow[]
}

// ── What an extraction says ─────────────────────────────────────────────────────

/**
 * The shape the model answers in. Everything is by NAME or by ORDINAL, because that is what
 * a model can honestly produce: it read a script, not a database. The one exception is
 * `fact`, which is an id — the prompt hands the in-scope facts over with their ids beside
 * them (invariant 2), so citing one is a copy rather than a guess.
 */
export interface ExtractedPresence {
  character: string
  /** The canon entity's name or alias. Left out for a body canon does not have a sheet for. */
  entity?: string
  protection: BoardProtection
  arrives?: boolean
}

export interface ExtractedScene {
  /** The scene's ordinal, 1-based — the model counts headings, and D3 says so. */
  scene: number
  location: string
  locationEntity?: string
  environment: BoardEnvironment
  shipPosition?: string
  /** What the grid prints. */
  elapsed?: string
  /** What the rules compare. Null or absent when the scene does not say. */
  elapsedSeconds?: number | null
  present: ExtractedPresence[]
}

export interface ExtractedTransit {
  from: string
  to: string
  seconds: number
  /** The id of the canon fact the number came from. */
  fact?: string
  /** The fact says the crossing costs the same coming back. Writes the mirrored row too. */
  eitherWay?: boolean
}

export interface ExtractedHazard {
  /** The canon entity the hazard is about — the species, for `lethal-in-vacuum`. */
  entity: string
  hazard: BoardHazard
  /** The id of the fact that says it. Required: a hazard nobody can quote is an opinion. */
  fact: string
}

export interface BoardExtraction {
  scenes: ExtractedScene[]
  transits?: ExtractedTransit[]
  hazards?: ExtractedHazard[]
}

export interface BoardExtractionRequest {
  episodeId: string
  /** The artifact the board was read out of, and the one its findings will land in. */
  scriptId: string
  extraction: BoardExtraction
  /**
   * Where the human-readable grid was written on the volume (D2). The STEP names the file,
   * because only a step knows the library it is writing into; the board records the name.
   */
  filePath?: string | null
}

/**
 * One model answer, turned into an extraction — or refused.
 *
 * A fenced code block is tolerated because models write them however firmly a prompt says
 * not to, and stripping one is not the same as guessing at prose. Anything else fails
 * loudly: the runner's three attempts (invariant 5) are exactly the budget for an answer
 * that came back wrong, and an extraction quietly parsed out of half a sentence would put a
 * board on screen that nobody read.
 */
export function parseExtraction(text: string): BoardExtraction {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim())
  const body = (fenced ? fenced[1]! : text).trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(
      `The answer did not come back as an extraction — it is not JSON. It began: ` +
        `“${body.slice(0, 80)}…”`,
    )
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as BoardExtraction).scenes)
  ) {
    throw new Error(
      'The answer did not come back as an extraction — it has no `scenes` array. A board is ' +
        'one object per scene of the script, and there is nothing to salvage without them.',
    )
  }
  return parsed as BoardExtraction
}

// ── Recording ───────────────────────────────────────────────────────────────────

/**
 * Turns one extraction into the board: resolves the names a model can produce into the ids
 * a rule can join on, then writes the rows and the freshness edges in one transaction.
 *
 * Called a second time it REBUILDS — same artifact, next version, rows replaced, edges
 * re-recorded at the source's current version, which is what makes a stale board fresh
 * again without a line of freshness code here.
 */
export function recordExtractedBoard(store: Store, request: BoardExtractionRequest): Board {
  return store.transaction(() => {
    const source = findArtifact(store, request.scriptId)
    if (!source) throw new Error(`No such artifact: ${request.scriptId}`)

    const where = episodeInShow(store, request.episodeId)
    if (!where) throw new Error(`No such episode: ${request.episodeId}`)

    const scenes = scenesOf(store, request.episodeId)
    const byOrdinal = resolveScenes(scenes, request.extraction)
    const byName = entityIndex(entitiesOfShow(store, where.show.id))

    const grid = request.extraction.scenes.map((scene) => ({
      scene: byOrdinal.get(scene.scene)!,
      extracted: scene,
      locationEntityId: scene.locationEntity
        ? requireEntity(byName, scene.locationEntity).id
        : null,
      present: scene.present.map((who) => ({
        ...who,
        entityId: who.entity ? requireEntity(byName, who.entity).id : null,
      })),
    }))

    const transits = (request.extraction.transits ?? []).flatMap(mirrored)
    const hazards = (request.extraction.hazards ?? []).map((hazard) => ({
      entityId: requireEntity(byName, hazard.entity).id,
      hazard: requireOneOf(BOARD_HAZARD, hazard.hazard, 'hazard'),
      factId: requireFact(store, hazard.fact),
    }))

    // Invariant 2, declared rather than implied: the board touches the places it names, the
    // bodies in them, and the species whose facts make a rule land on one of those bodies.
    const touches = [
      ...new Set(
        [
          ...grid.map((row) => row.locationEntityId),
          ...grid.flatMap((row) => row.present.map((who) => who.entityId)),
          ...hazards.map((hazard) => hazard.entityId),
        ].filter((id) => id !== null),
      ),
    ]

    const existing = boardArtifactOf(store, request.episodeId)
    const artifact = existing
      ? reviseArtifact(store, existing.id, {
          summary: `rebuilt from ${source.kind} v${source.version}`,
          filePath: request.filePath,
        })
      : recordArtifact(store, {
          episodeId: request.episodeId,
          kind: 'continuity-board',
          filePath: request.filePath ?? null,
          touches,
        })
    if (existing) declareProvenance(store, artifact.id, touches)

    clearRows(store, artifact.id)
    for (const row of grid) writeScene(store, artifact.id, row)
    for (const transit of transits) {
      store.run(
        `INSERT INTO board_transit (board_id, from_location, to_location, seconds, fact_id)
              VALUES (?, ?, ?, ?, ?)`,
        artifact.id,
        transit.from,
        transit.to,
        transit.seconds,
        transit.fact === undefined ? null : requireFact(store, transit.fact),
      )
    }
    for (const hazard of hazards) {
      store.run(
        'INSERT INTO board_hazard (board_id, entity_id, hazard, fact_id) VALUES (?, ?, ?, ?)',
        artifact.id,
        hazard.entityId,
        hazard.hazard,
        hazard.factId,
      )
    }

    // One edge per scene, at the version this reading consumed. REPLACED rather than added
    // to: a rebuild after a shorter re-delineation must not leave an edge behind claiming
    // the board consumed a scene that no longer exists.
    replaceInputs(
      store,
      artifact.id,
      grid.map((row) => ({
        artifactId: source.id,
        version: source.version,
        sceneId: row.scene.id,
      })),
    )

    return findBoard(store, artifact.id)!
  })
}

function writeScene(
  store: Store,
  boardId: string,
  row: {
    scene: Scene
    extracted: ExtractedScene
    locationEntityId: string | null
    present: (ExtractedPresence & { entityId: string | null })[]
  },
): void {
  const location = row.extracted.location.trim()
  if (location === '') {
    throw new Error(
      `Scene ${row.scene.ordinal} came back with no location. Every row of the grid names ` +
        'a place, because dual presence is a comparison of places.',
    )
  }

  store.run(
    `INSERT INTO board_scene
       (board_id, scene_id, location, location_entity_id, environment, ship_position,
        elapsed_seconds, elapsed_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    boardId,
    row.scene.id,
    location,
    row.locationEntityId,
    requireOneOf(BOARD_ENVIRONMENT, row.extracted.environment, 'environment'),
    row.extracted.shipPosition ?? '',
    row.extracted.elapsedSeconds ?? null,
    row.extracted.elapsed ?? '',
  )

  for (const who of row.present) {
    store.run(
      `INSERT INTO board_presence
         (board_id, scene_id, character_name, entity_id, protection, arrives)
       VALUES (?, ?, ?, ?, ?, ?)`,
      boardId,
      row.scene.id,
      who.character,
      who.entityId,
      requireOneOf(BOARD_PROTECTION, who.protection, 'protection'),
      who.arrives ? 1 : 0,
    )
  }
}

/** The rows of one board, gone. `board_presence` follows its scene by CASCADE (0011). */
function clearRows(store: Store, boardId: string): void {
  store.run('DELETE FROM board_scene WHERE board_id = ?', boardId)
  store.run('DELETE FROM board_transit WHERE board_id = ?', boardId)
  store.run('DELETE FROM board_hazard WHERE board_id = ?', boardId)
}

/** "Ninety seconds in either direction" is two rows, because a one-way crossing is real. */
function mirrored(transit: ExtractedTransit): ExtractedTransit[] {
  return transit.eitherWay
    ? [transit, { ...transit, from: transit.to, to: transit.from, eitherWay: false }]
    : [transit]
}

// ── Reading ─────────────────────────────────────────────────────────────────────

export function findBoard(store: Store, id: string): Board | undefined {
  const artifact = findArtifact(store, id)
  if (!artifact || artifact.kind !== 'continuity-board') return undefined

  return {
    artifact,
    source: sourceOf(store, artifact.id),
    scenes: gridOf(store, artifact.id),
    transits: store
      .all<TransitRow>(
        `SELECT from_location, to_location, seconds, fact_id FROM board_transit
          WHERE board_id = ? ORDER BY from_location, to_location`,
        artifact.id,
      )
      .map((row) => ({
        from: row.from_location,
        to: row.to_location,
        seconds: row.seconds,
        factId: row.fact_id,
      })),
    hazards: store
      .all<HazardRow>(
        `SELECT entity_id, hazard, fact_id FROM board_hazard
          WHERE board_id = ? ORDER BY entity_id, hazard`,
        artifact.id,
      )
      .map((row) => ({ entityId: row.entity_id, hazard: row.hazard, factId: row.fact_id })),
  }
}

/** The episode's board — the episode room asks for it this way, and there is only one. */
export function boardOf(store: Store, episodeId: string): Board | undefined {
  const artifact = boardArtifactOf(store, episodeId)
  return artifact && findBoard(store, artifact.id)
}

function boardArtifactOf(store: Store, episodeId: string): Artifact | undefined {
  const row = store.get<{ id: string }>(
    "SELECT id FROM artifact WHERE episode_id = ? AND kind = 'continuity-board' AND slot = ''",
    episodeId,
  )
  return row && findArtifact(store, row.id)
}

/**
 * What the board was read out of, resolved through its freshness edges rather than stored a
 * second time. Every edge points at the same artifact — one board, one script — so the
 * DISTINCT is a statement of that rather than a query that expects several.
 */
function sourceOf(store: Store, boardId: string): Artifact | undefined {
  const row = store.get<{ input_artifact_id: string }>(
    'SELECT DISTINCT input_artifact_id FROM artifact_input WHERE artifact_id = ?',
    boardId,
  )
  return row && findArtifact(store, row.input_artifact_id)
}

/** The grid, in scene order — ordered by the SCENE, which is where order lives (D3). */
function gridOf(store: Store, boardId: string): BoardScene[] {
  const scenes = store.all<SceneRow>(
    `SELECT b.scene_id, s.ordinal, s.heading, b.location, b.location_entity_id, b.environment,
            b.ship_position, b.elapsed_seconds, b.elapsed_label
       FROM board_scene b
       JOIN scene s ON s.id = b.scene_id
      WHERE b.board_id = ?
      ORDER BY s.ordinal`,
    boardId,
  )

  return scenes.map((row) => ({
    sceneId: row.scene_id,
    ordinal: row.ordinal,
    heading: row.heading,
    location: row.location,
    locationEntityId: row.location_entity_id,
    environment: row.environment,
    shipPosition: row.ship_position,
    elapsedSeconds: row.elapsed_seconds,
    elapsedLabel: row.elapsed_label,
    present: store
      .all<PresenceRow>(
        `SELECT character_name, entity_id, protection, arrives FROM board_presence
          WHERE board_id = ? AND scene_id = ? ORDER BY rowid`,
        boardId,
        row.scene_id,
      )
      .map((who) => ({
        characterName: who.character_name,
        entityId: who.entity_id,
        protection: who.protection,
        arrives: who.arrives === 1,
      })),
  }))
}

// ── The refusals ────────────────────────────────────────────────────────────────

/**
 * Every scene of the episode, matched to the extraction that claims to have read it.
 *
 * A hole is refused. The rules walk a character's appearances in order and compare
 * consecutive ones; a missing scene would silently join two crossings into one and make an
 * impossible gap look generous. A rule cannot see a row that is not there, so this is the
 * only place the gap can be caught.
 */
function resolveScenes(scenes: Scene[], extraction: BoardExtraction): Map<number, Scene> {
  const byOrdinal = new Map(scenes.map((scene) => [scene.ordinal, scene]))
  const read = new Set(extraction.scenes.map((scene) => scene.scene))

  for (const scene of extraction.scenes) {
    if (!byOrdinal.has(scene.scene)) {
      throw new Error(
        `The extraction read a scene ${scene.scene}, and this episode has ` +
          `${scenes.length}. Scenes are read out of the script, so the board reads the ` +
          'ones that are there.',
      )
    }
  }
  const missing = scenes.filter((scene) => !read.has(scene.ordinal)).map((scene) => scene.ordinal)
  if (missing.length > 0) {
    throw new Error(
      `The extraction skipped scene ${missing.join(', ')}. A grid with a hole in it has ` +
        'rules reasoning across a gap they cannot see — every scene, or no board.',
    )
  }
  return byOrdinal
}

/** Names and aliases, because a script calls Tobin Wick "Wick" and the sheet says so. */
function entityIndex(entities: CanonEntity[]): Map<string, CanonEntity> {
  const index = new Map<string, CanonEntity>()
  for (const entity of entities) {
    for (const name of [entity.name, ...entity.aliases]) {
      index.set(name.toLowerCase(), entity)
    }
  }
  return index
}

function requireEntity(index: Map<string, CanonEntity>, name: string): CanonEntity {
  const entity = index.get(name.trim().toLowerCase())
  if (!entity) {
    throw new Error(
      `The extraction named “${name}”, and this show has no entity by that name or alias. ` +
        'The prompt hands over the entities in scope, so an invented one is a ' +
        'broken read, not a nuance.',
    )
  }
  return entity
}

function requireFact(store: Store, factId: string): string {
  if (!findFact(store, factId)) {
    throw new Error(
      `The extraction cited fact ${factId}, which does not exist. Facts are cited by the id ` +
        'the prompt supplied; a made-up one is what a board must never quote.',
    )
  }
  return factId
}

/** Model output against a closed set. The TypeScript union is the set; this is the door. */
function requireOneOf<T extends string>(
  allowed: readonly T[],
  value: string,
  what: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `“${value}” is not a ${what} — the board knows ${allowed.join(', ')}. Widening the set ` +
        'is a code change with a test (the Archon rule), never a value that slips through.',
    )
  }
  return value as T
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface SceneRow {
  scene_id: string
  ordinal: number
  heading: string
  location: string
  location_entity_id: string | null
  environment: BoardEnvironment
  ship_position: string
  elapsed_seconds: number | null
  elapsed_label: string
}

interface PresenceRow {
  character_name: string
  entity_id: string | null
  protection: BoardProtection
  arrives: number
}

interface TransitRow {
  from_location: string
  to_location: string
  seconds: number
  fact_id: string | null
}

interface HazardRow {
  entity_id: string
  hazard: BoardHazard
  fact_id: string
}

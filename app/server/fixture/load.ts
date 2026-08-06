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
import { findEntity, linkCategory, registerEntity, type CanonEntity } from '../domain/canon.ts'
import {
  declareCategory,
  declareRelationType,
  findCategory,
  findRelationType,
} from '../domain/category.ts'
import { proposalsOfEntity, raiseProposal, type ProposalDraft } from '../domain/proposal.ts'
import { UNKNOWN_TARGET } from '../domain/relation.ts'
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
  type FixtureEntity,
  type FixtureEpisode,
  type FixtureShow,
} from './read.ts'

/**
 * Puts the Grey Harbor fixture into a library volume. `npm run fixture:load`.
 *
 * Four rules shape this module. The first two are E1-7's and unchanged; the last two are
 * D25 arriving, and they are the reason this file exists in the shape it does.
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
 * ## Two legalities, and the line between them (D25)
 *
 * **A category is schema, and the loader writes it straight.** `canon_category`,
 * `category_field`, `category_artifact_kind` and `relation_type` are declared here with no
 * proposal in sight, because a category is data (3.2) — adding one is an edit, not
 * engineering — and because routing it through a proposal is not merely ceremony but
 * impossible: a proposal's subject is an ENTITY, and a category is not one.
 *
 * **An entity's sheet is canon, and canon enters only by ratified proposal.** Facts,
 * relations, standing, aliases and prose are what invariant 1 is about, so each active
 * sheet becomes a `promotion` proposal raised by the `loader` and riding nothing, and
 * Ryan ratifying it at the bench is what writes a row. There is no bulk path here and no
 * `force`; `domain/founding.ts` is the helper that rules a stack of them, and it rules
 * them one at a time through E2-2's ruling API like every other surface.
 *
 * **This command RAISES; it never RULES.** `npm run fixture:load` on Ryan's real volume
 * leaves six proposals standing in the queue and stops. Founding is a separate, deliberate
 * call — his, at the bench, or a test's, through the API. A loader that founded what it
 * raised would be auto-ratification, which is invariant 5 and D25 broken in one move.
 *
 * **A sheet whose status is `candidate` raises nothing at all.** It registers its
 * identity, which is already a candidate, and the sheet stays a draft on disk. That is
 * the ruling E2-4 made and its reasoning is short: founding ratifies every promotion the
 * loader raised, so raising one for a sheet that declares itself unruled would make
 * founding contradict the only line that distinguishes it. Promoting it later is the
 * normal API — `promotionFromSheet` builds the very same draft, and somebody raises it on
 * purpose.
 *
 * ## The sheets are founding documents, not a sync source
 *
 * Load → found → and from then on canon lives in the database and moves by proposals.
 * A sheet edited after founding diverges silently, and that is correct: the sheets are
 * provenance, the database is truth, and a loader that reconciled canon back out of files
 * would be a second write path into it. **If a re-load should raise delta proposals for
 * what changed, that is E7's import shape** — a real design with a real cost — and it is
 * deliberately not built here.
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
  /** Categories and their relation types: schema, written straight (3.2, D23). */
  categories: Tally
  relationTypes: Tally
  /** Identities. The sheet behind each one arrives as a promotion, below. */
  entities: Tally
  /** Promotion proposals raised from the active sheets — raised, never ruled (D25). */
  promotions: Tally
  /** The sheets that say `candidate`: identity registered, nothing proposed. By name. */
  candidates: string[]
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
      categories: tally(),
      relationTypes: tally(),
      entities: tally(),
      promotions: tally(),
      candidates: [],
      arcs: tally(),
      waypoints: tally(),
      positions: tally(),
      artifacts: tally(),
      scenes: 0,
      files: [],
    }

    // First, and before any identity is registered: `registerEntity` links a row to its
    // category when the show has declared one (0006), so declaring these first is what
    // makes a fresh load produce entities that are already wired into the graph.
    seedCategories(store, report, show.id, fixture)

    const seasons = new Map<number, Season>()
    for (const season of fixture.seasons) {
      seasons.set(
        season.number,
        reconcile(report.seasons, seasonsOf(store, show.id).find((s) => s.number === season.number), () =>
          createSeason(store, { showId: show.id, number: season.number, title: season.title }),
        ),
      )
    }

    // Identities first, all of them, and the sheets after — a promotion's `species` edge
    // names the Halvani identity, and Halvani's own sheet is read later in the same walk.
    const entities = new Map<string, CanonEntity>()
    for (const entity of fixture.entities) {
      const seeded = reconcile(
        report.entities,
        findEntity(store, {
          showId: show.id,
          categoryKey: entity.categoryKey,
          name: entity.name,
        }),
        () =>
          // Identity only. Standing, prose, facts and relations are on the sheet and reach
          // the database only through the promotion raised below (invariant 1, D25).
          registerEntity(store, {
            showId: show.id,
            categoryKey: entity.categoryKey,
            name: entity.name,
          }),
      )
      // A row registered before this show had categories — every E1-era library, and
      // Ryan's (0006 says why the column is nullable). The categories exist now, so the
      // link does too. It writes no canon: `category_key` already said which one it is.
      entities.set(entity.name, seeded.categoryId === null ? linkCategory(store, seeded.id) : seeded)
    }

    for (const entity of fixture.entities) {
      seedPromotion(store, report, entity, entities)
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

// ── Categories: schema, written straight (3.2, D23) ─────────────────────────────

/**
 * Two passes, because a declaration points at a category that may be declared after it —
 * `part-of → location` points at its own, and `species` on a character is only declarable
 * once Species exists. Sorting the sheets into dependency order would work for shows whose
 * categories happen to sort that way, which is not a property a fixture can promise.
 *
 * A category that is already there is left exactly as it is, fields and all. The sheets are
 * founding documents rather than a sync source (see the header), and `declareCategory` has
 * no edit path anyway — changing a declared category is E2-5's schema screen, not a re-load.
 */
function seedCategories(
  store: Store,
  report: LoadReport,
  showId: string,
  fixture: FixtureShow,
): void {
  for (const category of fixture.categories) {
    reconcile(report.categories, findCategory(store, showId, category.key), () =>
      declareCategory(store, {
        showId,
        key: category.key,
        name: category.name,
        blurb: category.blurb,
        fields: category.fields,
        appliesTo: category.appliesTo,
        checkInstructions: category.checkInstructions,
      }),
    )
  }

  for (const category of fixture.categories) {
    const declared = findCategory(store, showId, category.key)!
    for (const type of category.relationTypes) {
      // The declaration goes across WHOLE, and `inheritsFacts` is why that matters (D22,
      // amended into this issue after E2-1). Naming the fields one by one here is how the
      // flag gets dropped: nothing would fail, Grey Harbor's characters would quietly stop
      // inheriting Halvani physiology, and the world-rules check would report clean on a
      // scene it never really read (invariant 2).
      reconcile(report.relationTypes, findRelationType(store, declared.id, type.name), () =>
        declareRelationType(store, declared.id, type),
      )
    }
  }
}

// ── The sheets: promotion proposals, raised and never ruled (D25) ───────────────

/**
 * Raises the promotion one sheet asks for — or, for a `candidate` sheet, nothing at all.
 *
 * Found rather than created in three cases, and all three mean "the sheet has already been
 * put to Ryan": a promotion standing unruled in the queue, one he ruled (ratified, rejected
 * or deferred — a proposal is ruled once, 3.3), and an entity already active. The last is
 * the belt to the braces: `raiseProposal` refuses a promotion of active canon, and finding
 * it here says so in the report instead of throwing halfway through a load.
 */
function seedPromotion(
  store: Store,
  report: LoadReport,
  sheet: FixtureEntity,
  entities: Map<string, CanonEntity>,
): void {
  const entity = entities.get(sheet.name)!
  if (sheet.status === 'candidate') {
    report.candidates.push(sheet.name)
    return
  }

  const put =
    entity.status === 'active' ||
    proposalsOfEntity(store, entity.id).some((proposal) => proposal.kind === 'promotion')
  if (put) {
    report.promotions.found += 1
    return
  }

  raiseProposal(store, promotionFromSheet(sheet, entity.id, entities))
  report.promotions.created += 1
}

/**
 * The proposal a sheet is: identity, standing, prose, facts and edges, raised together
 * (1.2 — "a promotion carrying the full sheet"). Exported because it is also what promotes
 * a candidate later, from the bench or from a test: the sheet is the draft either way, and
 * two places building this payload would eventually build two different ones.
 *
 * It rides NOTHING. `episodeId` is left out because founding has no episode, no run and no
 * gate — which is exactly why `proposal.episode_id` is nullable (0008).
 */
export function promotionFromSheet(
  sheet: FixtureEntity,
  entityId: string,
  entities: Map<string, CanonEntity>,
): ProposalDraft {
  return {
    entityId,
    kind: 'promotion',
    raisedBy: 'loader',
    standing: sheet.standing,
    aliases: sheet.aliases,
    body: sheet.body,
    // No field on any of them: a sheet's `## Facts` is a list of statements, and which of
    // the category's fields each is about is not something the format asks for (3.2).
    facts: sheet.facts.map((statement) => ({ statement })),
    relations: sheet.relations.map((relation) => ({
      op: 'add' as const,
      type: relation.type,
      // `unknown` travels as the literal word the sheet used — `relate`'s own argument and
      // the one legal non-entity target (D22). No sentinel entity is looked up for it.
      to:
        relation.target === UNKNOWN_TARGET
          ? UNKNOWN_TARGET
          : entities.get(relation.target)!.id,
    })),
    usageContext:
      `${sheet.path} — the sheet this show is founded from. Read off disk; no episode has ` +
      'been written against it yet, so there is nothing to quote but the sheet itself.',
    alternatives: [
      'reject it — the sheet is a draft, and a show does not have to keep everything on it',
      'defer it — leave the identity a candidate until an episode actually reads on it',
    ],
  }
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

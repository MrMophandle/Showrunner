import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ARC_KIND, ARC_SCOPE, type ArcKind, type ArcScope } from '../domain/arc.ts'
import { ARTIFACT_KIND, type ArtifactKind } from '../domain/artifact.ts'
import { EPISODE_LIFECYCLE, type EpisodeLifecycle } from '../domain/spine.ts'
import { field, fields, parseSheet, section, type Section, type Sheet } from './sheet.ts'

/**
 * Reads `fixtures/greyharbor/` into typed shapes, and refuses anything incomplete.
 *
 * The refusing is the point. The fixture is the worked example a new showrunner copies
 * (3.5) and the show every later epic's tests are written against, so a shape that goes
 * missing here gets copied rather than corrected — a character whose species quietly
 * vanished (D22), a category that stopped declaring its relation types (D23), a
 * waypoint that says what it is called and not what landing it looks like (D24). Each
 * of those is a load-time error naming the file, not a silently thinner fixture.
 *
 * What this module does NOT do is write canon. It reads relations, facts, standings and
 * check instructions off disk, validates them, and hands them to `load.ts`, which
 * registers entity IDENTITIES and nothing else. Facts, relations and standing are E2's
 * tables and arrive only through ratified proposals (invariant 1); the sheets here are
 * the drafts that flow will carry to a gate. Nothing in this file may become an insert
 * into a canon table, however convenient that would be for E7's Dead Light import.
 */

export const FIXTURE_DIR = join(import.meta.dirname, '../../../fixtures/greyharbor')

/** Standing and status from 3.1. E2 owns the real vocabulary; this is the copy the fixture is held to. */
const ENTITY_STANDING = ['core', 'recurring', 'one-shot', 'retired'] as const
const ENTITY_STATUS = ['active', 'historical', 'candidate'] as const

/** A relation type's cardinality (D23). `required` is declared separately, as the ruling says. */
const RELATION_CARDINALITY = ['exactly-one', 'at-most-one', 'any'] as const
export type RelationCardinality = (typeof RELATION_CARDINALITY)[number]

/**
 * The one legal non-entity target: a character whose species is genuinely undecided
 * declares it as `unknown` (D22) — legal, tracked, never blank, because a blank is
 * indistinguishable from a sheet nobody finished.
 */
export const UNKNOWN_TARGET = 'unknown'

export interface RelationTypeDeclaration {
  name: string
  targetCategory: string
  cardinality: RelationCardinality
  required: boolean
  /** The name the edge is navigable by from the far end — blast radius from both sides. */
  inverse: string
}

export interface FixtureCategory {
  key: string
  name: string
  blurb: string
  appliesTo: ArtifactKind[]
  relationTypes: RelationTypeDeclaration[]
  checkInstructions: string
  path: string
}

export interface FixtureRelation {
  type: string
  target: string
}

export interface FixtureEntity {
  categoryKey: string
  name: string
  blurb: string
  standing: (typeof ENTITY_STANDING)[number]
  status: (typeof ENTITY_STATUS)[number]
  aliases: string[]
  relations: FixtureRelation[]
  body: string
  facts: string[]
  path: string
}

export interface FixtureWaypoint {
  ordinal: number
  name: string
  description: string
  landingCriteria: string
}

export interface FixtureArc {
  name: string
  scope: ArcScope
  kind: ArcKind
  /** The season an arc resolves inside, or null when it runs across the show. */
  seasonNumber: number | null
  statement: string
  waypoints: FixtureWaypoint[]
  path: string
}

export interface FixtureArtifact {
  kind: ArtifactKind
  /** Relative to the episode's directory. */
  file: string
  /** The artifacts of this episode it was built from — the freshness edges. */
  builtFrom: ArtifactKind[]
  /** Entity names this artifact touches (invariant 2). */
  touches: string[]
}

/** One scene as the script broke it. Read out of the script; never declared (D3). */
export interface FixtureScene {
  heading: string
  summary: string
}

export interface FixtureEpisode {
  seasonNumber: number
  number: number
  title: string
  lifecycle: EpisodeLifecycle
  positions: { arcName: string; waypointOrdinal: number }[]
  artifacts: FixtureArtifact[]
  scenes: FixtureScene[]
  /** Absolute, so the loader can read the artifact files. */
  dir: string
  /** Relative, so an error can name the sheet that is wrong. */
  path: string
}

export interface FixtureShow {
  key: string
  title: string
  seasons: { number: number; title: string }[]
  categories: FixtureCategory[]
  entities: FixtureEntity[]
  arcs: FixtureArc[]
  episodes: FixtureEpisode[]
  dir: string
}

export function readFixture(dir: string = FIXTURE_DIR): FixtureShow {
  const show = readShow(dir)
  const categories = readCategories(dir)
  const entities = categories.flatMap((category) => readEntities(dir, category))
  const arcs = sorted(entries(join(dir, 'arc'), '.md')).map((file) =>
    readArc(dir, join('arc', file), show.seasons),
  )
  const episodes = sorted(entries(join(dir, 'episode'))).map((slug) =>
    readEpisode(dir, slug, show.seasons, arcs),
  )

  checkRelations(categories, entities)
  checkProvenance(entities, episodes)

  return { ...show, categories, entities, arcs, episodes, dir }
}

// ── The show ────────────────────────────────────────────────────────────────────

function readShow(dir: string): { key: string; title: string; seasons: { number: number; title: string }[] } {
  const sheet = open(dir, 'show.md')
  const show = require_(sheet, 'Show')

  return {
    key: requireField(sheet, show, 'key'),
    title: requireField(sheet, show, 'title'),
    seasons: fields(require_(sheet, 'Seasons')).map(({ key, value }) => {
      const number = Number(key)
      if (!Number.isInteger(number)) fail(sheet, `season “${key}” is not a number`)
      return { number, title: value }
    }),
  }
}

// ── Categories, and the relation types they declare (D23) ───────────────────────

function readCategories(dir: string): FixtureCategory[] {
  const canon = join(dir, 'canon')
  return sorted(entries(canon)).map((key) => {
    const path = join('canon', key, '_category.md')
    const sheet = open(dir, path)
    const declared = require_(sheet, 'Category')
    const declaredKey = requireField(sheet, declared, 'key')
    if (declaredKey !== key) {
      fail(sheet, `declares key “${declaredKey}” but lives in canon/${key}/`)
    }

    return {
      key,
      name: sheet.title,
      blurb: sheet.quote,
      appliesTo: requireField(sheet, declared, 'applies to')
        .split(',')
        .map((kind) => kind.trim())
        .map((kind) => oneOf(sheet, ARTIFACT_KIND, kind, 'artifact kind')),
      relationTypes: require_(sheet, 'Relation types').bullets.map((bullet) =>
        readRelationType(sheet, bullet),
      ),
      checkInstructions: require_(sheet, 'Check instructions').text,
      path,
    }
  })
}

/** `species → species · cardinality: exactly-one · required: yes · inverse: members` */
function readRelationType(sheet: Sheet, bullet: string): RelationTypeDeclaration {
  const [head, ...rest] = bullet.split(' · ')
  const [name, targetCategory] = head!.split(' → ')
  if (!name || !targetCategory) {
    fail(sheet, `relation type “${bullet}” is missing its \`name → target category\``)
  }

  const declared = new Map(
    rest.map((part) => {
      const at = part.indexOf(': ')
      return [part.slice(0, at).trim(), part.slice(at + 2).trim()] as const
    }),
  )
  const need = (key: string): string => {
    const value = declared.get(key)
    if (value === undefined || value === '') {
      fail(sheet, `relation type \`${name}\` declares no ${key} (D23 requires one)`)
    }
    return value
  }

  return {
    name: name!.trim(),
    targetCategory: targetCategory!.trim(),
    cardinality: oneOf(sheet, RELATION_CARDINALITY, need('cardinality'), 'cardinality'),
    required: need('required') === 'yes',
    inverse: need('inverse'),
  }
}

// ── Entities ────────────────────────────────────────────────────────────────────

function readEntities(dir: string, category: FixtureCategory): FixtureEntity[] {
  const files = sorted(entries(join(dir, 'canon', category.key), '.md')).filter(
    (file) => !file.startsWith('_'),
  )

  return files.map((file) => {
    const path = join('canon', category.key, file)
    const sheet = open(dir, path)
    const identity = require_(sheet, 'Identity')
    const relations = section(sheet, 'Relations')
    const facts = require_(sheet, 'Facts').bullets

    if (facts.length === 0) {
      fail(sheet, 'has no facts. A sheet with nothing checkable on it checks nothing.')
    }

    return {
      categoryKey: category.key,
      name: sheet.title,
      blurb: sheet.quote,
      standing: oneOf(sheet, ENTITY_STANDING, requireField(sheet, identity, 'standing'), 'standing'),
      status: oneOf(sheet, ENTITY_STATUS, requireField(sheet, identity, 'status'), 'status'),
      aliases: (field(identity, 'aliases') ?? '')
        .split(',')
        .map((alias) => alias.trim())
        .filter((alias) => alias !== ''),
      relations: relations
        ? fields(relations).map(({ key, value }) => ({ type: key, target: value }))
        : [],
      body: require_(sheet, 'Body').text,
      facts,
      path,
    }
  })
}

/**
 * Every relation is a declared type, pointing at something that exists, as often as its
 * cardinality allows (D23) — and every character has its species (D22).
 *
 * This runs across the whole show rather than per sheet because that is the only place
 * the answer lives: whether `species: Halvani` is valid depends on a file in another
 * directory, and whether it is *required* depends on a third.
 */
function checkRelations(categories: FixtureCategory[], entities: FixtureEntity[]): void {
  const byKey = new Map(categories.map((category) => [category.key, category]))
  for (const category of categories) {
    for (const type of category.relationTypes) {
      if (!byKey.has(type.targetCategory)) {
        throw new Error(
          `${category.path}: relation type \`${type.name}\` points at category ` +
            `“${type.targetCategory}”, which this show has no category for.`,
        )
      }
    }
  }

  const seen = new Map<string, string>()
  for (const entity of entities) {
    const clash = seen.get(entity.name)
    if (clash) {
      throw new Error(
        `${entity.path}: “${entity.name}” is also the name of the entity in ${clash}. ` +
          'Entity names are how the fixture points at things, so they are unique per show.',
      )
    }
    seen.set(entity.name, entity.path)
  }

  const target = (name: string): FixtureEntity | undefined =>
    entities.find((entity) => entity.name === name)

  for (const entity of entities) {
    const declared = byKey.get(entity.categoryKey)!.relationTypes

    for (const relation of entity.relations) {
      const type = declared.find((t) => t.name === relation.type)
      if (!type) {
        throw new Error(
          `${entity.path}: \`${relation.type}\` is not declared by the ${entity.categoryKey} ` +
            'category. A relation type is data (D23) — declare it in that category’s ' +
            '_category.md, with a target, a cardinality and an inverse, or it is invalid.',
        )
      }
      if (relation.target === UNKNOWN_TARGET) continue

      const found = target(relation.target)
      if (!found) {
        throw new Error(
          `${entity.path}: \`${relation.type}\` points at “${relation.target}”, which is ` +
            'not an entity in this show.',
        )
      }
      if (found.categoryKey !== type.targetCategory) {
        throw new Error(
          `${entity.path}: \`${relation.type}\` must point at a ${type.targetCategory}, but ` +
            `“${relation.target}” is a ${found.categoryKey}.`,
        )
      }
    }

    for (const type of declared) {
      const count = entity.relations.filter((r) => r.type === type.name).length
      if (type.required && count === 0) {
        throw new Error(
          `${entity.path}: declares no \`${type.name}\`, and the ${entity.categoryKey} ` +
            `category requires exactly one. Point it at a ${type.targetCategory}, or at ` +
            `\`${UNKNOWN_TARGET}\` if it genuinely isn’t decided — never leave it out.`,
        )
      }
      if (count > 1 && type.cardinality !== 'any') {
        throw new Error(
          `${entity.path}: declares ${count} \`${type.name}\` relations; the category ` +
            `allows ${type.cardinality}.`,
        )
      }
    }
  }
}

// ── Arcs (D8, D24) ──────────────────────────────────────────────────────────────

function readArc(dir: string, path: string, seasons: { number: number }[]): FixtureArc {
  const sheet = open(dir, path)
  const declared = require_(sheet, 'Arc')
  const scope = oneOf(sheet, ARC_SCOPE, requireField(sheet, declared, 'scope'), 'arc scope')
  const seasonNumber = scope === 'season' ? Number(requireField(sheet, declared, 'season')) : null

  if (seasonNumber !== null && !seasons.some((season) => season.number === seasonNumber)) {
    fail(sheet, `resolves in season ${seasonNumber}, which the show does not have`)
  }

  const statement = require_(sheet, 'Statement').text
  if (statement === '') {
    fail(
      sheet,
      'has an empty statement. D24: the statement is what the arc is about and what ' +
        'question it asks — the thing Ryan re-reads when he has forgotten.',
    )
  }

  const waypoints = sheet.sections
    .filter((s) => s.name.startsWith('Waypoint '))
    .map((s) => readWaypoint(sheet, s))
  waypoints.forEach((waypoint, index) => {
    if (waypoint.ordinal !== index + 1) {
      fail(sheet, `waypoint ${waypoint.ordinal} is ${index + 1}th in the file`)
    }
  })
  if (waypoints.length === 0) fail(sheet, 'has no waypoints')

  return {
    name: sheet.title,
    scope,
    kind: oneOf(sheet, ARC_KIND, requireField(sheet, declared, 'kind'), 'arc kind'),
    seasonNumber,
    statement,
    waypoints,
    path,
  }
}

/** `## Waypoint 2 — The harbor is worth spending on` */
function readWaypoint(sheet: Sheet, waypoint: Section): FixtureWaypoint {
  const [head, name] = waypoint.name.split(' — ')
  const ordinal = Number(head!.slice('Waypoint '.length))
  if (!Number.isInteger(ordinal) || !name) {
    fail(sheet, `“${waypoint.name}” is not \`## Waypoint <n> — <name>\``)
  }

  const need = (key: string, why: string): string => {
    const value = field(waypoint, key)
    if (value === undefined || value === '') {
      fail(sheet, `waypoint ${ordinal} declares no ${key}. D24: ${why}`)
    }
    return value
  }

  return {
    ordinal,
    name: name!.trim(),
    description: need('description', 'a waypoint says what it means'),
    landingCriteria: need('landing criteria', 'and what landing it looks like on screen'),
  }
}

// ── Episodes ────────────────────────────────────────────────────────────────────

function readEpisode(
  dir: string,
  slug: string,
  seasons: { number: number }[],
  arcs: FixtureArc[],
): FixtureEpisode {
  const path = join('episode', slug, 'episode.md')
  const sheet = open(dir, path)
  const declared = require_(sheet, 'Episode')
  const seasonNumber = Number(requireField(sheet, declared, 'season'))

  if (!seasons.some((season) => season.number === seasonNumber)) {
    fail(sheet, `is in season ${seasonNumber}, which the show does not have`)
  }

  const artifacts = readArtifacts(dir, sheet, slug)
  const script = artifacts.find((artifact) => artifact.kind === 'script')

  return {
    seasonNumber,
    number: Number(requireField(sheet, declared, 'number')),
    title: requireField(sheet, declared, 'title'),
    lifecycle: oneOf(
      sheet,
      EPISODE_LIFECYCLE,
      requireField(sheet, declared, 'lifecycle'),
      'lifecycle',
    ),
    positions: fields(require_(sheet, 'Arc positions')).map(({ key, value }) => {
      const arc = arcs.find((candidate) => candidate.name === key)
      if (!arc) fail(sheet, `declares a position on “${key}”, which is not an arc of this show`)
      const waypointOrdinal = Number(value)
      if (!arc!.waypoints.some((waypoint) => waypoint.ordinal === waypointOrdinal)) {
        fail(sheet, `declares “${key}” @ waypoint ${value}, and that arc has no such waypoint`)
      }
      return { arcName: key, waypointOrdinal }
    }),
    artifacts,
    scenes: script ? readScenes(dir, join('episode', slug, script.file)) : [],
    dir: join(dir, 'episode', slug),
    path,
  }
}

/** `- script: script.md · built from: outline · touches: Ilse Renn, Tobin Wick` */
function readArtifacts(dir: string, sheet: Sheet, slug: string): FixtureArtifact[] {
  const artifacts: FixtureArtifact[] = []

  for (const bullet of require_(sheet, 'Artifacts').bullets) {
    const [head, ...rest] = bullet.split(' · ')
    const at = head!.indexOf(': ')
    const kind = oneOf(sheet, ARTIFACT_KIND, head!.slice(0, at).trim(), 'artifact kind')
    const file = head!.slice(at + 2).trim()

    if (!existsSync(join(dir, 'episode', slug, file))) {
      fail(sheet, `says its ${kind} is ${file}, and there is no such file`)
    }

    const parts = new Map(
      rest.map((part) => {
        const colon = part.indexOf(': ')
        return [part.slice(0, colon).trim(), part.slice(colon + 2).trim()] as const
      }),
    )
    const list = (key: string): string[] =>
      (parts.get(key) ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')

    const builtFrom = list('built from').map((from) =>
      oneOf(sheet, ARTIFACT_KIND, from, 'artifact kind'),
    )
    for (const from of builtFrom) {
      if (!artifacts.some((earlier) => earlier.kind === from)) {
        fail(sheet, `says its ${kind} was built from a ${from} it does not list above it`)
      }
    }

    artifacts.push({ kind, file, builtFrom, touches: list('touches') })
  }

  return artifacts
}

/**
 * The scenes, read out of the script itself: `## 4 · EXT. THE LONG PIER — CONTINUOUS`,
 * with the blockquote under it as the summary.
 *
 * This is where D3 is enforced rather than described. There is no scene list in
 * `episode.md` and no scene count anywhere in the fixture — delete a scene from the
 * script and the count changes, because the count is `scenes.length` and never a field.
 */
function readScenes(dir: string, path: string): FixtureScene[] {
  const sheet = open(dir, path)

  return sheet.sections.map((scene, index) => {
    const at = scene.name.indexOf(' · ')
    const ordinal = Number(scene.name.slice(0, at))
    if (at === -1 || !Number.isInteger(ordinal)) {
      fail(sheet, `“## ${scene.name}” is not a scene. Every heading in a script is one: \`## 4 · EXT. THE LONG PIER — CONTINUOUS\`.`)
    }
    if (ordinal !== index + 1) {
      fail(sheet, `scene ${ordinal} is the ${index + 1}th in the file; scenes are numbered in order`)
    }
    return { heading: scene.name.slice(at + 3).trim(), summary: scene.quote }
  })
}

/** Provenance names entities that exist (invariant 2 is worth nothing pointing at nothing). */
function checkProvenance(entities: FixtureEntity[], episodes: FixtureEpisode[]): void {
  for (const episode of episodes) {
    for (const artifact of episode.artifacts) {
      for (const name of artifact.touches) {
        if (!entities.some((entity) => entity.name === name)) {
          throw new Error(
            `${episode.path}: the ${artifact.kind} declares it touches “${name}”, which is ` +
              'not an entity in this show.',
          )
        }
      }
    }
  }
}

// ── Reading, refusing ───────────────────────────────────────────────────────────

function open(dir: string, path: string): Sheet {
  const full = join(dir, path)
  if (!existsSync(full)) throw new Error(`${path}: the fixture expects this file, and it is not there.`)
  return parseSheet(path, readFileSync(full, 'utf8'))
}

function entries(dir: string, suffix = ''): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((entry) => entry.endsWith(suffix) && !entry.startsWith('.'))
}

const sorted = (names: string[]): string[] => [...names].sort()

function require_(sheet: Sheet, name: string): Section {
  const found = section(sheet, name)
  if (!found) fail(sheet, `has no \`## ${name}\` section`)
  return found!
}

function requireField(sheet: Sheet, section: Section, key: string): string {
  const value = field(section, key)
  if (value === undefined || value === '') {
    fail(sheet, `has no \`${key}\` under \`## ${section.name}\``)
  }
  return value!
}

function oneOf<T extends string>(
  sheet: Sheet,
  allowed: readonly T[],
  value: string,
  what: string,
): T {
  if (!allowed.includes(value as T)) {
    fail(sheet, `“${value}” is not a ${what}. It is one of: ${allowed.join(', ')}.`)
  }
  return value as T
}

function fail(sheet: Sheet, message: string): never {
  throw new Error(`${sheet.path}: ${message}`)
}

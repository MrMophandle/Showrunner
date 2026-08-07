import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { declareProvenance, recordArtifact, type Artifact } from './artifact.ts'
import { amendEntity, registerEntity, type CanonEntity } from './canon.ts'
import { declareCategory, declareRelationType } from './category.ts'
import {
  closeFact,
  establishFact,
  factsInScope,
  recordRuling,
  supersedeFact,
  type Fact,
} from './fact.ts'
import { checkPassesOf, findingsIn, type Finding } from './finding.ts'
import { relate } from './relation.ts'
import { createEpisode, createSeason, createShow, delineateScenes, type Scene } from './spine.ts'
import { runStructuralChecks } from './structural.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => {
  store.close()
})

/**
 * Grey Harbor cut to what the structural tier needs: a species whose facts travel the
 * declared edge (D22, D23), two characters standing on it, and a script that declares which
 * of them it touches. The fixture has no retired entity and no exception, which is why this
 * is synthetic rather than a fixture edit — planting either in `fixtures/greyharbor` would
 * change data E3-1 and E3-2 are holding fixed.
 */
interface Harbor {
  showId: string
  episodeId: string
  scenes: Scene[]
  halvani: CanonEntity
  tobin: CanonEntity
  ilse: CanonEntity
  vacuum: Fact
  script: Artifact
}

function seedHarbor(): Harbor {
  const showId = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
  const seasonId = createSeason(store, { showId, number: 1, title: 'Slack Water' }).id
  const episodeId = createEpisode(store, { seasonId, number: 1, title: 'The Long Pier' }).id
  const scenes = delineateScenes(store, episodeId, [
    { heading: 'The long pier' },
    { heading: 'No. 4 lock' },
  ])

  const character = declareCategory(store, { showId, key: 'character', name: 'Character' })
  declareCategory(store, { showId, key: 'species', name: 'Species' })
  declareRelationType(store, character.id, {
    name: 'species',
    targetCategory: 'species',
    cardinality: 'exactly-one',
    required: true,
    inverse: 'members',
    inheritsFacts: true,
  })

  const halvani = registerEntity(store, { showId, categoryKey: 'species', name: 'Halvani' })
  const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })
  const ilse = registerEntity(store, { showId, categoryKey: 'character', name: 'Ilse Renn' })
  relate(store, { fromEntityId: tobin.id, type: 'species', to: halvani.id })
  relate(store, { fromEntityId: ilse.id, type: 'species', to: halvani.id })

  const vacuum = establishFact(store, {
    entityId: halvani.id,
    field: 'physiology',
    statement:
      'A Halvani in unprotected vacuum loses consciousness in about nine seconds and dies inside two minutes.',
    ratifiedBy: recordRuling(store, 'ratification').seq,
  })

  const script = recordArtifact(store, {
    episodeId,
    kind: 'script',
    filePath: 'ep01/script.md',
    touches: [tobin.id],
  })

  return { showId, episodeId, scenes, halvani, tobin, ilse, vacuum, script }
}

/** Tobin's exception to the Halvani vacuum fact — canon, ruled, and not yet stale. */
function tobinsException(harbor: Harbor): Fact {
  return establishFact(store, {
    entityId: harbor.tobin.id,
    field: 'physiology',
    statement: 'Tobin holds against vacuum for a full minute — the graft in his chest.',
    establishedIn: harbor.episodeId,
    ratifiedBy: recordRuling(store, 'ratification').seq,
    overrides: harbor.vacuum.id,
  })
}

const passNamed = (artifactId: string, checkKey: string) =>
  checkPassesOf(store, artifactId).find((pass) => pass.checkKey === checkKey)!

const only = (findings: Finding[]): Finding => {
  expect(findings).toHaveLength(1)
  return findings[0]!
}

// ── The done conditions ─────────────────────────────────────────────────────────

describe('the stale exception check', () => {
  it('turns a superseded exception into an anchored finding quoting both facts', () => {
    const harbor = seedHarbor()
    const exception = tobinsException(harbor)

    // The ground moves: the species fact Tobin's exception was written against is edited,
    // which is a supersession under one ruling (D9). His exception carries forward onto the
    // successor — and `factsInScope` says so, which is what this check exists to surface.
    const { successor } = supersedeFact(store, {
      factId: harbor.vacuum.id,
      ruling: recordRuling(store, 'ratification').seq,
      successor: {
        entityId: harbor.halvani.id,
        field: 'physiology',
        statement: 'A Halvani in unprotected vacuum loses consciousness in about six seconds.',
      },
    })
    expect(factsInScope(store, harbor.tobin.id).overrides[0]!.stale).toBe(true)

    runStructuralChecks(store, harbor.script.id)

    const finding = only(findingsIn(store, harbor.script.id))
    expect(finding.checkKey).toEqual('stale-exception')
    expect(finding.tier).toEqual('deterministic')
    expect(finding.concern).toContain('The ground moved beneath Tobin Wick’s exception')
    expect(finding.concern).toContain('revisiting it is a ruling')
    expect(finding.entityId).toEqual(harbor.tobin.id)
    expect(finding.status).toEqual('open')

    // Both facts, quoted by id so the card renders their lineage — the exception, and the
    // inherited fact it was written against — plus what stands in that fact's place today.
    expect(finding.facts.map((fact) => fact.id)).toEqual([
      exception.id,
      harbor.vacuum.id,
      successor.id,
    ])
    expect(finding.facts[1]!.status).toEqual('superseded')
    expect(finding.facts[1]!.closure!.supersededBy).toEqual(successor.id)

    // Deterministic means certain; severity is the separate question of how much it matters.
    expect(finding.severity).toEqual('medium')
    expect(finding.confidence).toEqual('certain')

    // Anchored on the material: this script, at the version that was checked.
    expect(finding.anchor).toEqual({
      artifactId: harbor.script.id,
      version: 1,
      sceneId: null,
      quote: '',
    })
  })

  it('quotes the two that are left when the fact it named was reverted', () => {
    const harbor = seedHarbor()
    const exception = tobinsException(harbor)

    closeFact(store, {
      factId: harbor.vacuum.id,
      ruling: recordRuling(store, 'revert').seq,
      note: 'ep01 was abandoned',
    })

    runStructuralChecks(store, harbor.script.id)

    const finding = only(findingsIn(store, harbor.script.id))
    expect(finding.concern).toContain('displaces nothing at all')
    // Nothing stands in its place, so there is no third fact to invent. That is a ruling.
    expect(finding.facts.map((fact) => fact.id)).toEqual([exception.id, harbor.vacuum.id])
  })

  it('says nothing while the exception still stands against what it was written on', () => {
    const harbor = seedHarbor()
    tobinsException(harbor)

    runStructuralChecks(store, harbor.script.id)

    // The control, and the record of it: an exception that is still true of the world is
    // silence, and the silence is measured rather than merely absent.
    expect(findingsIn(store, harbor.script.id)).toEqual([])
    expect(passNamed(harbor.script.id, 'stale-exception').findingCount).toEqual(0)
  })

  it('reads only the entities the artifact touches (invariant 2)', () => {
    const harbor = seedHarbor()

    // Ilse gets the stale exception; the script declares it touches Tobin and not her. A
    // check that read the whole bible would find it, and would be reporting on an artifact
    // it never really checked.
    establishFact(store, {
      entityId: harbor.ilse.id,
      statement: 'Ilse has never worn a hardsuit in her life.',
      ratifiedBy: recordRuling(store, 'ratification').seq,
      overrides: harbor.vacuum.id,
    })
    supersedeFact(store, {
      factId: harbor.vacuum.id,
      ruling: recordRuling(store, 'ratification').seq,
      successor: {
        entityId: harbor.halvani.id,
        statement: 'A Halvani in unprotected vacuum loses consciousness in about six seconds.',
      },
    })

    runStructuralChecks(store, harbor.script.id)
    expect(findingsIn(store, harbor.script.id)).toEqual([])

    // Declare her in scope and the same check, unchanged, has something to say.
    declareProvenance(store, harbor.script.id, [harbor.ilse.id])
    runStructuralChecks(store, harbor.script.id)
    expect(only(findingsIn(store, harbor.script.id)).entityId).toEqual(harbor.ilse.id)
  })
})

describe('the retired-reappearance check', () => {
  it('fires when a retired entity is in an artifact’s provenance', () => {
    const harbor = seedHarbor()
    // Standing arrives by ratified promotion in production (E2-2); here a test declares it.
    amendEntity(store, harbor.tobin.id, { standing: 'retired', status: 'historical' })

    runStructuralChecks(store, harbor.script.id)

    const finding = only(findingsIn(store, harbor.script.id))
    expect(finding.checkKey).toEqual('retired-reappearance')
    expect(finding.tier).toEqual('deterministic')
    expect(finding.concern).toEqual(
      'Tobin Wick is declared retired, and this script is built on them. Standing is a ' +
        'declaration about the show and provenance is what the episode actually touches — ' +
        'the two disagree, and one of them is wrong.',
    )
    expect(finding.entityId).toEqual(harbor.tobin.id)

    // Severity and confidence, separately: a declaration and the production disagree, which
    // is bad, and there is nothing to be unsure about, which is what `certain` means (4.2).
    expect(finding.severity).toEqual('high')
    expect(finding.confidence).toEqual('certain')
    // No fact to quote — standing is a column E2 grew, not a statement anybody ratified.
    expect(finding.facts).toEqual([])
  })

  it('is silent for every other standing, and records the silence', () => {
    const harbor = seedHarbor()
    amendEntity(store, harbor.tobin.id, { standing: 'core' })

    runStructuralChecks(store, harbor.script.id)

    expect(findingsIn(store, harbor.script.id)).toEqual([])
    expect(passNamed(harbor.script.id, 'retired-reappearance').findingCount).toEqual(0)
  })

  it('anchors on the scene when the artifact belongs to one', () => {
    const harbor = seedHarbor()
    amendEntity(store, harbor.tobin.id, { standing: 'retired' })
    const sceneText = recordArtifact(store, {
      episodeId: harbor.episodeId,
      kind: 'scene-text',
      slot: 'scene-02',
      sceneId: harbor.scenes[1]!.id,
      filePath: 'ep01/scene-02.md',
      touches: [harbor.tobin.id],
    })

    runStructuralChecks(store, sceneText.id)

    // A canon-graph finding has no span to highlight, so the quote is empty on purpose —
    // but the scene it belongs to is load-bearing (D14 clears findings BY SCENE).
    expect(only(findingsIn(store, sceneText.id)).anchor).toEqual({
      artifactId: sceneText.id,
      version: 1,
      sceneId: harbor.scenes[1]!.id,
      quote: '',
    })
    expect(findingsIn(store, sceneText.id, { sceneId: harbor.scenes[1]!.id })).toHaveLength(1)
  })
})

describe('running the tier', () => {
  it('records one pass per check whether or not either found anything', () => {
    const harbor = seedHarbor()

    const passes = runStructuralChecks(store, harbor.script.id)

    expect(passes.map((pass) => pass.checkKey)).toEqual([
      'stale-exception',
      'retired-reappearance',
    ])
    expect(passes.map((pass) => pass.tier)).toEqual(['deterministic', 'deterministic'])
    expect(passes.map((pass) => pass.findingCount)).toEqual([0, 0])
    expect(checkPassesOf(store, harbor.script.id)).toHaveLength(2)

    // Run it again and there are four passes, not two overwritten ones: a check pass is a
    // record of a run, and running again is a new pass.
    runStructuralChecks(store, harbor.script.id)
    expect(checkPassesOf(store, harbor.script.id)).toHaveLength(4)
  })

  it('refuses an artifact that does not exist', () => {
    expect(() => runStructuralChecks(store, 'art_nope')).toThrow(/No such artifact/)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { recordArtifact, reviseArtifact, type Artifact } from './artifact.ts'
import { concernGroups, concernKey, inheritedDismissal, sameConcern } from './concern.ts'
import { registerEntity, type CanonEntity } from './canon.ts'
import { establishFact, recordRuling, type Fact } from './fact.ts'
import {
  dismissFinding,
  findingsIn,
  findingsOfPass,
  recordCheckPass,
  type Finding,
  type FindingDraft,
} from './finding.ts'
import { createEpisode, createSeason, createShow, delineateScenes, type Scene } from './spine.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
})

afterEach(() => {
  store.close()
})

interface Bench {
  scenes: Scene[]
  script: Artifact
  outline: Artifact
  tobin: CanonEntity
  ilse: CanonEntity
  vacuum: Fact
  hull: Fact
}

function bench(): Bench {
  const showId = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
  const seasonId = createSeason(store, { showId, number: 1 }).id
  const episodeId = createEpisode(store, { seasonId, number: 1, title: 'The Long Pier' }).id
  const scenes = delineateScenes(store, episodeId, [
    { heading: 'The long pier' },
    { heading: 'No. 4 lock' },
  ])

  const tobin = registerEntity(store, { showId, categoryKey: 'character', name: 'Tobin Wick' })
  const ilse = registerEntity(store, { showId, categoryKey: 'character', name: 'Ilse Renn' })
  const vacuum = establishFact(store, {
    entityId: tobin.id,
    field: 'physiology',
    statement: 'A Halvani loses consciousness in nine seconds of vacuum.',
    ratifiedBy: recordRuling(store, 'ratification').seq,
  })
  const hull = establishFact(store, {
    entityId: ilse.id,
    field: 'physiology',
    statement: 'She has never worn a hardsuit.',
    ratifiedBy: recordRuling(store, 'ratification').seq,
  })

  const script = recordArtifact(store, {
    episodeId,
    kind: 'script',
    filePath: 'ep01/script.md',
    touches: [tobin.id, ilse.id],
  })
  const outline = recordArtifact(store, {
    episodeId,
    kind: 'outline',
    filePath: 'ep01/outline.md',
    touches: [tobin.id, ilse.id],
  })

  return { scenes, script, outline, tobin, ilse, vacuum, hull }
}

/**
 * One deterministic firing, exactly as a board rule writes one — read back off its own pass,
 * because `findingsIn` is document order and the newest firing is rarely its last row.
 */
function fire(script: Artifact, draft: FindingDraft, checkKey = 'vacuum-without-protection'): Finding {
  const pass = recordCheckPass(store, {
    checkKey,
    tier: 'deterministic',
    artifactId: script.id,
    findings: [draft],
  })
  return findingsOfPass(store, pass.id)[0]!
}

/** The firing a rule re-raises off unchanged rows: same words, same span, new version. */
function theSameConcern(at: Bench): FindingDraft {
  return {
    concern: 'Tobin Wick is outside the pressure hull in scene 1 with nothing between them and the void.',
    severity: 'high',
    confidence: 'certain',
    anchor: { sceneId: at.scenes[0]!.id, quote: 'The long pier' },
    entityId: at.tobin.id,
    factIds: [at.vacuum.id],
  }
}

describe('two findings are the same concern', () => {
  it('when the same check re-raises the same words at the same span, one version later', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))

    reviseArtifact(store, at.script.id, { summary: 'scene 2 rewritten' })
    const twin = fire(at.script, theSameConcern(at))

    // Two rows, two versions, one concern. The version is deliberately not in the key: a twin
    // is BY DEFINITION at a later version, so keying on it would make identity impossible.
    expect(first.anchor.version).toBe(1)
    expect(twin.anchor.version).toBe(2)
    expect(sameConcern(first, twin)).toBe(true)
    expect(concernKey(first)).toBe(concernKey(twin))
  })

  it('and never across two checks that happen to say the same thing', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at), 'vacuum-without-protection')
    const other = fire(at.script, theSameConcern(at), 'world-rules')

    expect(sameConcern(first, other)).toBe(false)
  })
})

describe('a genuinely new contradiction is never an old twin', () => {
  it('when the words changed — a rule reading different rows says different words', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))
    const other = fire(at.script, {
      ...theSameConcern(at),
      concern: 'Ilse Renn is outside the pressure hull in scene 1 with nothing between them.',
    })

    expect(sameConcern(first, other)).toBe(false)
  })

  it('when it lands in another scene', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))
    const other = fire(at.script, { ...theSameConcern(at), anchor: { sceneId: at.scenes[1]!.id, quote: 'The long pier' } })

    expect(sameConcern(first, other)).toBe(false)
  })

  it('when it lands on another span', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))
    const other = fire(at.script, { ...theSameConcern(at), anchor: { sceneId: at.scenes[0]!.id, quote: 'No. 4 lock' } })

    expect(sameConcern(first, other)).toBe(false)
  })

  it('when it is about somebody else', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))
    const other = fire(at.script, { ...theSameConcern(at), entityId: at.ilse.id })

    expect(sameConcern(first, other)).toBe(false)
  })

  it('when it argues with different canon', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))
    const other = fire(at.script, { ...theSameConcern(at), factIds: [at.hull.id] })

    expect(sameConcern(first, other)).toBe(false)
  })

  /**
   * The real one, and the reason the anchored artifact is in the key: `checkStaleExceptions`
   * (`structural.ts`) composes its concern from the ENTITY, quotes no span at all, and takes
   * its scene off the artifact — so the finding it raises against ep01's outline and the one
   * it raises against ep01's script are identical in every other axis. They are two concerns:
   * a note Ryan wrote about the outline has not ruled on the script.
   */
  it('when the same check says the identical thing about two artifacts', () => {
    const at = bench()
    const structural: FindingDraft = {
      concern: 'The ground moved beneath Tobin Wick’s exception — revisiting it is a ruling.',
      severity: 'medium',
      confidence: 'certain',
      anchor: { sceneId: null, quote: '' },
      entityId: at.tobin.id,
      factIds: [at.vacuum.id],
    }
    const onTheScript = fire(at.script, structural, 'stale-exception')
    const onTheOutline = fire(at.outline, structural, 'stale-exception')

    expect(sameConcern(onTheScript, onTheOutline)).toBe(false)
  })

  it('and no two of those six differences ever collide into one key', () => {
    const at = bench()
    const findings = [
      fire(at.script, theSameConcern(at)),
      fire(at.script, { ...theSameConcern(at), concern: 'Something else entirely.' }),
      fire(at.script, { ...theSameConcern(at), anchor: { sceneId: at.scenes[1]!.id, quote: 'The long pier' } }),
      fire(at.script, { ...theSameConcern(at), anchor: { sceneId: at.scenes[0]!.id, quote: 'No. 4 lock' } }),
      fire(at.script, { ...theSameConcern(at), entityId: at.ilse.id }),
      fire(at.script, { ...theSameConcern(at), factIds: [at.hull.id] }),
      // Identical in every other axis — same words, same scene, same span, same canon — and
      // about the outline instead of the script.
      fire(at.outline, theSameConcern(at)),
    ]

    expect(new Set(findings.map(concernKey)).size).toBe(7)
  })
})

describe('the check’s own assessment is not the concern', () => {
  it('a rule that raises its severity has not found a new contradiction', () => {
    const at = bench()
    const first = fire(at.script, { ...theSameConcern(at), severity: 'medium' })
    const louder = fire(at.script, { ...theSameConcern(at), severity: 'high' })

    expect(sameConcern(first, louder)).toBe(true)
  })
})

describe('grouping', () => {
  it('folds every firing of one concern into one group, in the order they were raised', () => {
    const at = bench()
    fire(at.script, theSameConcern(at))
    fire(at.script, { ...theSameConcern(at), concern: 'Something else entirely.' })
    reviseArtifact(store, at.script.id, { summary: 'v2' })
    fire(at.script, theSameConcern(at))

    const groups = concernGroups(findingsIn(store, at.script.id))

    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(2)
    expect(groups[0]!.map((finding) => finding.anchor.version)).toEqual([1, 2])
    expect(groups[1]).toHaveLength(1)
  })
})

describe('a standing dismissal, read through identity and copied onto nothing', () => {
  it('reaches the twin, attributed to the note Ryan actually wrote', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))
    dismissFinding(store, first.id, 'Coveralls are sealed in ep01 — established in the pilot.')

    reviseArtifact(store, at.script.id, { summary: 'scene 2 rewritten' })
    const twin = fire(at.script, theSameConcern(at))

    const inherited = inheritedDismissal(findingsIn(store, at.script.id), twin)

    expect(inherited).not.toBeNull()
    // The ORIGINAL finding, so a bench click lands on the note rather than on a copy of it.
    expect(inherited!.findingId).toBe(first.id)
    expect(inherited!.version).toBe(1)
    expect(inherited!.note).toBe('Coveralls are sealed in ep01 — established in the pilot.')
    // And nothing was written to the twin. It is open, and it is a recorded firing.
    expect(findingsIn(store, at.script.id).find((f) => f.id === twin.id)!.status).toBe('open')
  })

  it('does not reach a genuinely new contradiction', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))
    dismissFinding(store, first.id, 'Coveralls are sealed in ep01.')

    reviseArtifact(store, at.script.id, { summary: 'scene 2 rewritten' })
    const other = fire(at.script, { ...theSameConcern(at), entityId: at.ilse.id })

    expect(inheritedDismissal(findingsIn(store, at.script.id), other)).toBeNull()
  })

  it('is nobody’s own dismissal — the finding Ryan put down inherits nothing', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))
    dismissFinding(store, first.id, 'Coveralls are sealed in ep01.')

    expect(inheritedDismissal(findingsIn(store, at.script.id), first)).toBeNull()
  })

  it('names the FIRST note when he has put the same concern down twice', () => {
    const at = bench()
    const first = fire(at.script, theSameConcern(at))
    dismissFinding(store, first.id, 'The first word on it.')
    reviseArtifact(store, at.script.id, { summary: 'v2' })
    const second = fire(at.script, theSameConcern(at))
    dismissFinding(store, second.id, 'Said again, for the second time.')
    reviseArtifact(store, at.script.id, { summary: 'v3' })
    const third = fire(at.script, theSameConcern(at))

    expect(inheritedDismissal(findingsIn(store, at.script.id), third)!.note).toBe('The first word on it.')
  })
})

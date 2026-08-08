import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrate.ts'
import { openStore, type Store } from '../db/store.ts'
import { recordArtifact, reviseArtifact, type Artifact } from './artifact.ts'
import { registerEntity, type CanonEntity } from './canon.ts'
import { establishFact, recordRuling, type Fact } from './fact.ts'
import {
  CHECK_TIER,
  checkPassesOf,
  dismissFinding,
  findCheckPass,
  FINDING_CONFIDENCE,
  FINDING_DISPOSITION,
  FINDING_SEVERITY,
  findFinding,
  findingsIn,
  findingsOfPass,
  gapsAbout,
  gapsOfPass,
  recordCheckPass,
  scopeOfPass,
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

/** An episode with a script to check, a board derived from it, and one fact to quote. */
interface Bench {
  scenes: Scene[]
  script: Artifact
  board: Artifact
  narrator: CanonEntity
  voice: Fact
}

function bench(): Bench {
  const showId = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
  const seasonId = createSeason(store, { showId, number: 1 }).id
  const episodeId = createEpisode(store, { seasonId, number: 1, title: 'The Long Pier' }).id
  const scenes = delineateScenes(store, episodeId, [
    { heading: 'The long pier' },
    { heading: 'No. 4 lock' },
    { heading: 'Harbour office' },
  ])

  const narrator = registerEntity(store, {
    showId,
    categoryKey: 'house-style',
    name: 'Narrator voice',
  })
  const voice = establishFact(store, {
    entityId: narrator.id,
    field: 'narrator-voice',
    statement: 'The narrator never says “you” — observation, not address.',
    ratifiedBy: recordRuling(store, 'ratification').seq,
  })

  const script = recordArtifact(store, {
    episodeId,
    kind: 'script',
    filePath: 'ep01/script.md',
    touches: [narrator.id],
  })
  const board = recordArtifact(store, {
    episodeId,
    kind: 'continuity-board',
    filePath: 'ep01/continuity.json',
    builtFrom: [{ artifactId: script.id }],
  })

  return { scenes, script, board, narrator, voice }
}

// ── The done conditions ─────────────────────────────────────────────────────────

describe('a clean check pass leaves a record of having run', () => {
  it('writes the pass at zero findings — the silence is the measurement', () => {
    const { script } = bench()

    const pass = recordCheckPass(store, {
      checkKey: 'world-rules',
      tier: 'text',
      artifactId: script.id,
    })

    expect(pass.findingCount).toEqual(0)
    expect(findingsOfPass(store, pass.id)).toEqual([])

    // The row exists and says everything D11's ratio needs a denominator to say: which
    // check ran, against which artifact at which version, when. "It ran and said nothing"
    // is not the same sentence as "it never ran", and this is what tells them apart.
    expect(checkPassesOf(store, script.id)).toEqual([
      {
        id: pass.id,
        checkKey: 'world-rules',
        tier: 'text',
        artifactId: script.id,
        artifactVersion: 1,
        sceneId: null,
        ranAt: pass.ranAt,
        findingCount: 0,
        // And nothing it could not reach either (E3-2, 0012). Zero and zero is the clean
        // run; zero findings beside a gap is a different sentence again.
        gapCount: 0,
        // What it was handed (E3-4). This pass was composed by hand with no scope, and the
        // verdict board renders the number beside the silence — "clean · 4 facts in scope".
        scopeCount: 0,
      },
    ])
  })

  it('counts findings off the rows rather than off a stored number', () => {
    const { script } = bench()

    const pass = recordCheckPass(store, {
      checkKey: 'house-style',
      tier: 'text',
      artifactId: script.id,
      findings: [
        { concern: 'The narrator addresses the audience.', severity: 'low', confidence: 'high' },
        { concern: 'A second address, later.', severity: 'low', confidence: 'medium' },
      ],
    })

    expect(pass.findingCount).toEqual(2)
    expect(findCheckPass(store, pass.id)!.findingCount).toEqual(2)
  })
})

describe('severity and confidence (invariant 4)', () => {
  it('round-trips them as two separate values, never collapsed', () => {
    const { script } = bench()

    // The pair that proves it: the two axes disagree in both directions on purpose. A
    // combined "priority" could not represent either of these, and could not tell them
    // apart if it did.
    const pass = recordCheckPass(store, {
      checkKey: 'story-craft',
      tier: 'text',
      artifactId: script.id,
      findings: [
        { concern: 'The coolant leak is set up and never paid.', severity: 'low', confidence: 'certain' },
        { concern: 'Ferro may be folding a waypoint early.', severity: 'high', confidence: 'low' },
      ],
    })

    expect(
      findingsOfPass(store, pass.id).map((f) => ({ s: f.severity, c: f.confidence })),
    ).toEqual([
      { s: 'low', c: 'certain' },
      { s: 'high', c: 'low' },
    ])
  })

  it('is refused by the database, not merely by the types, outside its set', () => {
    const { script } = bench()
    const pass = recordCheckPass(store, {
      checkKey: 'house-style',
      tier: 'text',
      artifactId: script.id,
    })

    // A typo would not fail loudly on its own — it would render as an unknown badge, which
    // is invariant 4's failure in the one place it is fatal. 0010's CHECK is why it fails.
    const insert = (severity: string, confidence: string) =>
      store.run(
        `INSERT INTO finding (id, pass_id, artifact_id, artifact_version, concern, severity, confidence)
              VALUES ('find_x', ?, ?, 1, 'a concern', ?, ?)`,
        pass.id,
        script.id,
        severity,
        confidence,
      )

    expect(() => insert('critical', 'certain')).toThrow(/CHECK constraint/i)
    expect(() => insert('high', 'pretty sure')).toThrow(/CHECK constraint/i)
    expect(insert('high', 'certain')).toEqual({ changes: 1 })
  })
})

describe('the anchor (4.3)', () => {
  it('lands on artifact, version, scene and the quoted span', () => {
    const { script, scenes, narrator, voice } = bench()

    const pass = recordCheckPass(store, {
      checkKey: 'house-style',
      tier: 'text',
      artifactId: script.id,
      findings: [
        {
          concern: 'The narrator addresses the audience.',
          severity: 'low',
          confidence: 'high',
          anchor: {
            sceneId: scenes[1]!.id,
            quote: 'you can hear it settle if you stand still enough',
          },
          entityId: narrator.id,
          factIds: [voice.id],
        },
      ],
    })

    const [finding] = findingsOfPass(store, pass.id)
    expect(finding!.anchor).toEqual({
      artifactId: script.id,
      version: 1,
      sceneId: scenes[1]!.id,
      quote: 'you can hear it settle if you stand still enough',
    })
    // The concern quotes the fact by id, so the card renders today's lineage rather than a
    // transcription: entity, field, the episode it was established in, the ruling.
    expect(finding!.entityId).toEqual(narrator.id)
    expect(finding!.facts.map((f) => f.statement)).toEqual([voice.statement])
    expect(finding!.facts[0]!.field).toEqual('narrator-voice')
    expect(finding!.facts[0]!.ratifiedBy).toEqual(voice.ratifiedBy)
  })

  it('keeps naming the version it was found at after the artifact moves on', () => {
    const { script } = bench()
    recordCheckPass(store, {
      checkKey: 'house-style',
      tier: 'text',
      artifactId: script.id,
      findings: [{ concern: 'Said at v1.', severity: 'low', confidence: 'high' }],
    })

    reviseArtifact(store, script.id, { summary: 'round 2' })

    expect(findingsIn(store, script.id)[0]!.anchor.version).toEqual(1)
    expect(checkPassesOf(store, script.id)[0]!.artifactVersion).toEqual(1)
  })

  it('lets a check that read one artifact land its finding in another', () => {
    const { script, board, scenes } = bench()

    // E3-1's shape: the deterministic rules run over the BOARD and the dual presence they
    // find is a fact about the SCRIPT's scene, which is what the gate renders.
    const pass = recordCheckPass(store, {
      checkKey: 'continuity-board',
      tier: 'deterministic',
      artifactId: board.id,
      findings: [
        {
          concern: 'Mara is in two places in this scene.',
          severity: 'high',
          confidence: 'certain',
          anchor: { artifactId: script.id, sceneId: scenes[0]!.id, quote: 'she watches the dock arm' },
        },
      ],
    })

    expect(pass.artifactId).toEqual(board.id)
    // The gate asks for everything anchored in the script and gets it, without knowing that
    // board findings land there.
    expect(findingsIn(store, script.id).map((f) => f.checkKey)).toEqual(['continuity-board'])
    expect(findingsIn(store, board.id)).toEqual([])
  })

  it('orders findings by scene, with the whole-artifact ones above the spans', () => {
    const { script, scenes } = bench()
    recordCheckPass(store, {
      checkKey: 'house-style',
      tier: 'text',
      artifactId: script.id,
      findings: [
        { concern: 'In scene 3.', severity: 'low', confidence: 'high', anchor: { sceneId: scenes[2]!.id } },
        { concern: 'In scene 1.', severity: 'low', confidence: 'high', anchor: { sceneId: scenes[0]!.id } },
        { concern: 'About the whole thing.', severity: 'low', confidence: 'high' },
      ],
    })

    expect(findingsIn(store, script.id).map((f) => f.concern)).toEqual([
      'About the whole thing.',
      'In scene 1.',
      'In scene 3.',
    ])
    // And the scene-scoped read D14 clears by (E3-5) sees only its own.
    expect(findingsIn(store, script.id, { sceneId: scenes[2]!.id }).map((f) => f.concern)).toEqual([
      'In scene 3.',
    ])
  })
})

describe('dismissing a finding with a note (4.3, 4.4)', () => {
  function oneFinding(): string {
    const { script } = bench()
    const pass = recordCheckPass(store, {
      checkKey: 'story-craft',
      tier: 'text',
      artifactId: script.id,
      findings: [
        { concern: 'The coolant leak is set up and never paid.', severity: 'medium', confidence: 'medium' },
      ],
    })
    return findingsOfPass(store, pass.id)[0]!.id
  }

  it('records the note and the disposition, and the status follows from the row', () => {
    const id = oneFinding()
    expect(findFinding(store, id)!.status).toEqual('open')

    const dismissed = dismissFinding(store, id, 'pays off in ep07')

    expect(dismissed.status).toEqual('dismissed')
    expect(dismissed.disposition).toMatchObject({ kind: 'dismissed', note: 'pays off in ep07' })
    // Derived, never stored: there is no status column to disagree with the row.
    expect(
      store.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM pragma_table_info('finding') WHERE name = 'status'",
      ),
    ).toEqual({ n: 0 })
  })

  it('refuses an empty note — it is what rides future runs (4.4)', () => {
    const id = oneFinding()

    expect(() => dismissFinding(store, id, '   ')).toThrow(/takes a note/)
    expect(findFinding(store, id)!.status).toEqual('open')
  })

  it('refuses a second disposition — a later opinion is a later pass', () => {
    const id = oneFinding()
    dismissFinding(store, id, 'pays off in ep07')

    expect(() => dismissFinding(store, id, 'actually, no')).toThrow(/kept forever/)
    expect(findFinding(store, id)!.disposition!.note).toEqual('pays off in ep07')
  })
})

describe('findings are records, and records do not move', () => {
  it('has no is_blocking or blocked column anywhere — D12 is a computation (E3-3)', () => {
    // E3-1's board tables are in this list on purpose. The continuity board is the tier
    // whose findings D12 actually walls the next stage with, so it is the one most likely
    // to be handed a flag "for convenience" — and a stored wall is the freshness mistake
    // (1.3) one level out, whichever migration writes it.
    const columns = store
      .all<{ name: string }>(
        `SELECT name FROM pragma_table_info('finding')
          UNION ALL SELECT name FROM pragma_table_info('check_pass')
          UNION ALL SELECT name FROM pragma_table_info('finding_disposition')
          UNION ALL SELECT name FROM pragma_table_info('board_scene')
          UNION ALL SELECT name FROM pragma_table_info('board_presence')
          UNION ALL SELECT name FROM pragma_table_info('board_transit')
          UNION ALL SELECT name FROM pragma_table_info('board_hazard')`,
      )
      .map((row) => row.name)

    expect(columns).not.toContain('blocked')
    expect(columns).not.toContain('is_blocking')
    expect(columns).not.toContain('blocking')
    expect(columns).not.toContain('status')
  })

  it('refuses a direct UPDATE of a pass, a finding, or a disposition', () => {
    const { script } = bench()
    const pass = recordCheckPass(store, {
      checkKey: 'house-style',
      tier: 'text',
      artifactId: script.id,
      findings: [{ concern: 'The narrator addresses the audience.', severity: 'low', confidence: 'high' }],
    })
    const finding = findingsOfPass(store, pass.id)[0]!
    dismissFinding(store, finding.id, 'the house style is what changed')

    expect(() => store.run("UPDATE check_pass SET check_key = 'something-else'")).toThrow(
      /never an edit/,
    )
    expect(() => store.run("UPDATE finding SET severity = 'low'")).toThrow(/a later pass/)
    expect(() => store.run("UPDATE finding_disposition SET note = 'never said that'")).toThrow(
      /kept forever/,
    )
    expect(findFinding(store, finding.id)!.disposition!.note).toEqual(
      'the house style is what changed',
    )
  })

  it('refuses to record a pass against an artifact that does not exist', () => {
    expect(() =>
      recordCheckPass(store, { checkKey: 'house-style', tier: 'text', artifactId: 'art_nope' }),
    ).toThrow(/No such artifact/)
  })
})

describe('the vocabularies, and where each one is enforced', () => {
  it('holds severity and confidence to the database, member for member', () => {
    const { script } = bench()

    // The two lists and the two CHECKs have to agree, the way `events.test.ts` holds
    // EVENT_KIND against `event_kind`. Diverge and a value the code can produce is a value
    // the write rejects — or worse, a value the write accepts and no screen can render.
    for (const severity of FINDING_SEVERITY) {
      for (const confidence of FINDING_CONFIDENCE) {
        const pass = recordCheckPass(store, {
          checkKey: 'house-style',
          tier: 'text',
          artifactId: script.id,
          findings: [{ concern: `${severity}/${confidence}`, severity, confidence }],
        })
        expect(findingsOfPass(store, pass.id)[0]).toMatchObject({ severity, confidence })
      }
    }
    expect(FINDING_SEVERITY).toEqual(['low', 'medium', 'high'])
    expect(FINDING_CONFIDENCE).toEqual(['certain', 'high', 'medium', 'low'])
  })

  it('leaves tier and disposition open, which is what E6 and E3-5 will spend', () => {
    const { script } = bench()
    expect(CHECK_TIER).toEqual(['deterministic', 'text'])
    expect(FINDING_DISPOSITION).toEqual(['dismissed'])

    // 4.2 names a third tier and E6 brings it (media vs. reference); E3-5 adds `cleared`
    // beside `dismissed`. Both are a widened union in this module with a test — and the
    // proof that they cost no SQL is that the database takes the value today, unchanged.
    // Had either column carried a CHECK, that would be a rebuild of a table with real
    // findings hanging off it, which is exactly what 0007 refused for `canon_ruling.kind`.
    store.run(
      `INSERT INTO check_pass (id, check_key, tier, artifact_id, artifact_version)
            VALUES ('pass_e6', 'shot-likeness', 'media', ?, 1)`,
      script.id,
    )
    store.run(
      `INSERT INTO finding (id, pass_id, artifact_id, artifact_version, concern, severity, confidence)
            VALUES ('find_e6', 'pass_e6', ?, 1, 'the face is not hers', 'medium', 'low')`,
      script.id,
    )
    store.run(
      "INSERT INTO finding_disposition (finding_id, disposition, note) VALUES ('find_e6', 'cleared', '')",
    )

    expect(findCheckPass(store, 'pass_e6')!.tier).toEqual('media')
    expect(findFinding(store, 'find_e6')!.status).toEqual('cleared')
  })

  it('refuses a pass that cannot say which check it was', () => {
    const { script } = bench()

    expect(() =>
      store.run(
        `INSERT INTO check_pass (id, check_key, tier, artifact_id, artifact_version)
              VALUES ('pass_x', '', 'text', ?, 1)`,
        script.id,
      ),
    ).toThrow(/CHECK constraint/i)
  })
})

/**
 * E3-2's two records, added beside E3-0's (0012). Both are about the SCOPE a pass ran with
 * rather than about the artifact, and both exist because a semantic check has a third answer
 * the deterministic tier does not: it could not look.
 */
describe('what a pass was handed, and what it could not reach', () => {
  it('keeps the facts a pass loaded, so a rule that said nothing is still on the record', () => {
    const { script, narrator, voice } = bench()

    const pass = recordCheckPass(store, {
      checkKey: 'house-style',
      tier: 'text',
      artifactId: script.id,
      scope: [{ factId: voice.id, entityId: narrator.id }],
    })

    expect(pass.findingCount).toEqual(0)
    expect(scopeOfPass(store, pass.id)).toEqual([
      { fact: expect.objectContaining({ id: voice.id }), entityId: narrator.id, via: '' },
    ])
  })

  it('says which declaration an inherited fact travelled to get here (D22)', () => {
    const { script, narrator, voice } = bench()

    const pass = recordCheckPass(store, {
      checkKey: 'house-style',
      tier: 'text',
      artifactId: script.id,
      scope: [{ factId: voice.id, entityId: narrator.id, via: 'species' }],
    })

    expect(scopeOfPass(store, pass.id)[0]!.via).toEqual('species')
  })

  it('records a gap — neither a finding nor a silence', () => {
    const { script, narrator } = bench()

    const pass = recordCheckPass(store, {
      checkKey: 'world-rules',
      tier: 'text',
      artifactId: script.id,
      gaps: [
        {
          entityId: narrator.id,
          reason: 'declared-unknown',
          via: 'species',
          detail: 'Could not check the vacuum rules — species undecided.',
        },
      ],
    })

    // Zero findings AND one gap. `findingCount` alone would call this a clean run, which is
    // the collapse invariant 4 forbids one level up.
    expect(pass.findingCount).toEqual(0)
    expect(pass.gapCount).toEqual(1)
    expect(gapsOfPass(store, pass.id)).toEqual([
      {
        id: expect.stringMatching(/^gap_/),
        passId: pass.id,
        checkKey: 'world-rules',
        entityId: narrator.id,
        reason: 'declared-unknown',
        via: 'species',
        detail: 'Could not check the vacuum rules — species undecided.',
      },
    ])
  })

  it('answers what could not be checked about one entity, across every pass', () => {
    const { script, narrator } = bench()
    const gap = {
      entityId: narrator.id,
      reason: 'declared-unknown' as const,
      via: 'species',
      detail: 'Could not check — species undecided.',
    }

    recordCheckPass(store, { checkKey: 'world-rules', tier: 'text', artifactId: script.id, gaps: [gap] })
    recordCheckPass(store, { checkKey: 'character', tier: 'text', artifactId: script.id, gaps: [gap] })

    // Every check that loaded this entity was handed the same hole, and each one says so —
    // "which of my checks could not see all of Sefa" is the question, and it is queryable.
    expect(gapsAbout(store, narrator.id).map((one) => one.checkKey)).toEqual([
      'world-rules',
      'character',
    ])
  })

  it('leaves a pass with neither, and that is still the clean run 0010 built', () => {
    const { script } = bench()

    const pass = recordCheckPass(store, {
      checkKey: 'house-style',
      tier: 'text',
      artifactId: script.id,
    })

    expect([pass.findingCount, pass.gapCount]).toEqual([0, 0])
    expect(scopeOfPass(store, pass.id)).toEqual([])
    expect(gapsOfPass(store, pass.id)).toEqual([])
  })
})

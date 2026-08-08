import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { greyHarborFounded, type FoundedFixture } from '../fixture/founded.ts'
import { theLongPierExtraction } from '../fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { artifactsOf, reviseArtifact, type Artifact } from './artifact.ts'
import { recordExtractedBoard } from './board.ts'
import { runBoardRules } from './board-rules.ts'
import { MANDATORY_CRAFT } from './craft.ts'
import { factsOfEntity } from './fact.ts'
import { dismissFinding, findingsIn, recordCheckPass, type FindingDraft } from './finding.ts'
import { clusterFindings, panelFor, verdictBoard } from './panel.ts'
import { scenesOf } from './spine.ts'

/**
 * The panel (4.5): **several reviewers against one artifact as one verdict board.**
 *
 * Two properties are load-bearing here and each has its own describe block.
 *
 * **Convening is decided by declarations.** A category is convened because its sheet says it
 * applies to this artifact kind (3.2); the test edits the declaration and watches the panel
 * change with no code change anywhere. Story-craft is the exception that proves it — equipment
 * (D13), convened unbidden, and there is no row to delete to be rid of it.
 *
 * **The board is a READ.** Nothing is written when a panel finishes. Every row is computed out
 * of `check_pass`, `finding`, `finding_disposition` and `check_gap` at the moment it is asked
 * for, which is why the dismissal test below works: a finding put down after a board was
 * rendered changes the row, because there is no row to be stale. A summary table would have
 * been falsified by that one line of the test (1.3).
 */

let root: string
let paths: LibraryPaths
let store: Store
let harbor: FoundedFixture
let episodeId: string
let script: Artifact
let text: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-panel-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  episodeId = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'The Long Pier'")!.id
  script = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'script')!
  text = readFileSync(join(paths.artifactDir, script.filePath!), 'utf8')
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** The five categories The Long Pier's script reaches, its one arc position, then the craft. */
const PANEL = [
  'character',
  'location',
  'species',
  'technology',
  'world-rules',
  'waypoint-drift',
  'story-craft',
  'pacing',
  'dialogue',
  'hook',
]

const keys = (): string[] => panelFor(store, script).map((subject) => subject.key)

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

/** One text-tier pass, as the panel step records it. */
function pass(checkKey: string, findings: FindingDraft[] = [], gaps = 0): string {
  return recordCheckPass(store, {
    checkKey,
    tier: 'text',
    artifactId: script.id,
    findings,
    gaps: Array.from({ length: gaps }, () => ({
      reason: 'declared-unknown' as const,
      detail: `${checkKey} could not check something — species undecided`,
    })),
  }).id
}

const sceneId = (ordinal: number): string => scenesOf(store, episodeId)[ordinal - 1]!.id

const row = (checkKey: string) =>
  verdictBoard(store, script).rows.find((one) => one.checkKey === checkKey)!

// ── Convening ───────────────────────────────────────────────────────────────────

describe('what a panel convenes, and who decided', () => {
  it('convenes the categories, the arc positions and the craft reviewers, in that order', () => {
    expect(keys()).toEqual(PANEL)
  })

  it('drops a category whose declaration stops naming this artifact kind — data decided', () => {
    const category = store.get<{ id: string }>(
      'SELECT id FROM canon_category WHERE show_id = ? AND key = ?',
      harbor.show.id,
      'world-rules',
    )!.id

    // The edit a show makes on its `_category.md` sheet: `applies to` stops naming scripts.
    store.run(
      "DELETE FROM category_artifact_kind WHERE category_id = ? AND kind = 'script'",
      category,
    )
    expect(keys()).not.toContain('world-rules')

    // And back again. Not one line of code changed in either direction (3.2).
    store.run("INSERT INTO category_artifact_kind (category_id, kind) VALUES (?, 'script')", category)
    expect(keys()).toEqual(PANEL)
  })

  it('convenes story-craft unbidden, and no declaration can configure it away (D13)', () => {
    // Every category's `applies to` emptied, and the episode's arc position withdrawn: the
    // data now says "convene nothing at all".
    store.run('DELETE FROM category_artifact_kind')
    store.run('DELETE FROM episode_arc_position')

    // The craft reviewers are convened anyway, story-craft first, because they are equipment
    // rather than a declaration — there is no row left to delete to be rid of it.
    expect(keys()).toEqual(['story-craft', 'pacing', 'dialogue', 'hook'])
    expect(keys()[0]).toEqual(MANDATORY_CRAFT)
  })
})

// ── The board ───────────────────────────────────────────────────────────────────

describe('the verdict board: one row per convened check, computed from rows', () => {
  it('says a convened check has not read this draft rather than saying nothing', () => {
    const board = verdictBoard(store, script)

    expect(board.rows.map((one) => one.checkKey)).toEqual(PANEL)
    expect(board.rows.every((one) => one.verdict === 'unread')).toBe(true)
    expect(board).toMatchObject({ convened: 10, read: 0, standing: 0 })
  })

  it('renders a clean pass and a pass that found something as the different things they are', () => {
    for (const key of PANEL) {
      pass(
        key,
        key === 'world-rules'
          ? [
              {
                concern: 'Three minutes outside the hull in coveralls.',
                severity: 'high',
                confidence: 'high',
                anchor: { sceneId: sceneId(4), quote: 'Tobin comes out onto the pier' },
              },
            ]
          : [],
      )
    }

    expect(row('character')).toMatchObject({ verdict: 'clean', raised: 0, standing: 0 })
    expect(row('world-rules')).toMatchObject({
      verdict: 'found',
      tier: 'text',
      raised: 1,
      standing: 1,
      worstSeverity: 'high',
      confidence: 'high',
      scenes: [4],
    })
    expect(row('world-rules').what).toContain('scene 4')
  })

  it('never calls a pass with a gap on it clean — that is the third answer (0012)', () => {
    pass('species', [], 1)

    expect(row('species')).toMatchObject({ verdict: 'gapped', standing: 0, gaps: 1 })
    expect(row('species').what).toMatch(/could not check/)
  })

  it('flips a row to clean when Ryan puts the finding down, with nothing written to a board', () => {
    pass('character', [
      {
        concern: 'Ilse would not walk away from the paperwork.',
        severity: 'medium',
        confidence: 'high',
        anchor: { sceneId: sceneId(1), quote: 'Pier relay went dark at two.' },
      },
    ])
    expect(row('character').verdict).toEqual('found')

    dismissFinding(store, findingsIn(store, script.id)[0]!.id, 'she is allowed one bad morning')

    // THE POINT. The row it was ruled on was never written, so nothing had to be rewritten
    // when the ruling landed — what a check SAID is immutable, what STANDS is computed.
    expect(row('character')).toMatchObject({ verdict: 'clean', raised: 1, standing: 0 })
    expect(row('character').what).toContain('1')
  })

  it('forgets a reading the moment the draft moves on', () => {
    for (const key of PANEL) pass(key)
    expect(verdictBoard(store, script).read).toEqual(10)

    reviseArtifact(store, script.id, { summary: 'rewritten against the world-rules finding' })

    const board = verdictBoard(store, artifactsOf(store, episodeId).find((a) => a.kind === 'script')!)
    expect(board.version).toEqual(2)
    expect(board.rows.every((one) => one.verdict === 'unread')).toBe(true)
  })
})

describe('the deterministic verdicts join the board they land on (E3-1, D12)', () => {
  function theBoard(): void {
    const built = recordExtractedBoard(store, {
      episodeId,
      scriptId: script.id,
      extraction: theLongPierExtraction({
        lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
        halvaniVacuum: factOf('Halvani', 'loses consciousness'),
      }),
    })
    runBoardRules(store, built.artifact.id)
  }

  it('adds one row per rule, certain, beside the readings', () => {
    theBoard()

    const board = verdictBoard(store, script)
    const rules = board.rows.filter((one) => one.tier === 'deterministic')
    expect(rules.map((one) => one.checkKey)).toEqual([
      'dual-presence',
      'impossible-adjacency',
      'duplicate-arrival',
      'vacuum-without-protection',
    ])
    expect(rules.find((one) => one.checkKey === 'vacuum-without-protection')).toMatchObject({
      verdict: 'found',
      confidence: 'certain',
      worstSeverity: 'high',
      scenes: [4],
    })
    // Two of the four fire on this fixture; the other two ran and said nothing, and their
    // rows say `clean` rather than not being there — the denominator, on screen (0010).
    expect(rules.find((one) => one.checkKey === 'dual-presence')).toMatchObject({
      verdict: 'found',
      scenes: [6],
    })
    expect(rules.filter((one) => one.verdict === 'clean').map((one) => one.checkKey)).toEqual([
      'impossible-adjacency',
      'duplicate-arrival',
    ])
  })

  it('marks them stale rather than green once the script has moved past the board', () => {
    theBoard()
    reviseArtifact(store, script.id, { summary: 'the pier scene, again' })

    const moved = artifactsOf(store, episodeId).find((a) => a.kind === 'script')!
    const rules = verdictBoard(store, moved).rows.filter((one) => one.tier === 'deterministic')

    // Their findings were about v1 and no longer stand against v2, which would render four
    // green rows over a board nobody has rebuilt — invariant 4's failure mode exactly.
    expect(rules.every((one) => one.verdict === 'stale')).toBe(true)
    expect(rules[0]!.what).toMatch(/built from/)
  })
})

// ── Clustering ──────────────────────────────────────────────────────────────────

describe('findings cluster by overlap, because two reviewers never quote a moment alike', () => {
  /** Two reviewers on the same moment in scene 4. Neither quote contains the other. */
  const OVERLAPPING = [
    'Tobin comes out onto the pier in his coveralls',
    'onto the pier in his coveralls and goes down the spar',
  ]

  it('clusters two overlapping quotes that do not match byte for byte', () => {
    pass('world-rules', [
      {
        concern: 'Three minutes outside the hull in coveralls.',
        severity: 'high',
        confidence: 'high',
        anchor: { sceneId: sceneId(4), quote: OVERLAPPING[0] },
      },
    ])
    pass('pacing', [
      {
        concern: 'The walk out is narrated twice before anything happens.',
        severity: 'low',
        confidence: 'medium',
        anchor: { sceneId: sceneId(4), quote: OVERLAPPING[1] },
      },
    ])

    const clusters = clusterFindings(store, script, text)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.says.map((say) => say.checkKey).sort()).toEqual(['pacing', 'world-rules'])
    // One card, at the span both of them are inside — the union of what was quoted.
    expect(clusters[0]!.quote).toContain('Tobin comes out onto the pier in his coveralls')
    expect(clusters[0]!.quote).toContain('goes down the spar')
    expect(clusters[0]).toMatchObject({ scene: 4, worstSeverity: 'high', standing: 2 })
  })

  it('keeps a different moment in the same scene as its own card', () => {
    pass('world-rules', [
      {
        concern: 'Three minutes outside the hull in coveralls.',
        severity: 'high',
        confidence: 'high',
        anchor: { sceneId: sceneId(4), quote: OVERLAPPING[0] },
      },
    ])
    pass('hook', [
      {
        concern: 'The out is a stop rather than a question.',
        severity: 'medium',
        confidence: 'low',
        anchor: { sceneId: sceneId(4), quote: 'Three minutes of it, start to finish.' },
      },
    ])

    const clusters = clusterFindings(store, script, text)

    expect(clusters).toHaveLength(2)
    // Document order: the earlier span first, whichever reviewer raised it.
    expect(clusters.map((cluster) => cluster.says[0]!.checkKey)).toEqual(['world-rules', 'hook'])
  })

  it('gives a finding with no span its own card, rather than swallowing the scene', () => {
    pass('story-craft', [
      {
        concern: 'The coolant leak is set up in scene 2 and never paid.',
        severity: 'medium',
        confidence: 'medium',
        anchor: { sceneId: sceneId(4), quote: '' },
      },
    ])
    pass('world-rules', [
      {
        concern: 'Three minutes outside the hull in coveralls.',
        severity: 'high',
        confidence: 'high',
        anchor: { sceneId: sceneId(4), quote: OVERLAPPING[0] },
      },
    ])

    const clusters = clusterFindings(store, script, text)

    expect(clusters).toHaveLength(2)
    expect(clusters[0]!.quote).toEqual('')
    expect(clusters[0]!.says.map((say) => say.checkKey)).toEqual(['story-craft'])
  })

  it('carries every reviewer’s say on one card, disposition and all', () => {
    pass('world-rules', [
      {
        concern: 'Three minutes outside the hull in coveralls.',
        severity: 'high',
        confidence: 'high',
        entityId: harbor.entity('Tobin Wick').id,
        factIds: [factOf('Halvani', 'loses consciousness')],
        anchor: { sceneId: sceneId(4), quote: OVERLAPPING[0] },
      },
    ])
    pass('pacing', [
      {
        concern: 'The walk out is narrated twice before anything happens.',
        severity: 'low',
        confidence: 'medium',
        anchor: { sceneId: sceneId(4), quote: OVERLAPPING[1] },
      },
    ])
    dismissFinding(
      store,
      findingsIn(store, script.id).find((finding) => finding.checkKey === 'pacing')!.id,
      'the repetition is the point — he does this every day',
    )

    const [cluster] = clusterFindings(store, script, text)

    expect(cluster!.standing).toEqual(1)
    const canon = cluster!.says.find((say) => say.checkKey === 'world-rules')!
    expect(canon.facts[0]).toContain('loses consciousness in about nine seconds')
    expect(cluster!.says.find((say) => say.checkKey === 'pacing')!.status).toEqual('dismissed')
  })
})

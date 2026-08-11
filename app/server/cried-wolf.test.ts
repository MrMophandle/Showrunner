import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { criedWolf, tunePrompts, MIN_RULED_CONCERNS } from './cried-wolf.ts'
import { migrate } from './db/migrate.ts'
import { openStore, type Store } from './db/store.ts'
import { recordArtifact, reviseArtifact, type Artifact } from './domain/artifact.ts'
import {
  dismissFinding,
  findingsOfPass,
  recordCheckPass,
  type CheckPassDraft,
  type FindingDraft,
} from './domain/finding.ts'
import { newId } from './domain/id.ts'
import { createEpisode, createSeason, createShow, delineateScenes, type Scene } from './domain/spine.ts'
import { createEventLog } from './events.ts'
import { createRulings, presentForRuling } from './runner/gate.ts'
import { findStepByName, reconcileSteps, recordRun } from './runner/run.ts'
import type { Runner } from './runner/runner.ts'
import type { Stage } from './runner/step.ts'
import { scaffoldStage } from './runner/stage-fixture.ts'

/**
 * **D11's cried-wolf tracking: a query and a sentence, over rows that already exist.**
 *
 * Nothing in this file sets anything up that the check system does not already record. Every
 * number asserted below is computed from `check_pass`, `finding`, `finding_disposition`,
 * `check_gap` and `gate_ruling` — E3-0 through E3-5's own rows, read a different way.
 *
 * The three stories D11 has to tell apart are each a describe block: the check that cries
 * wolf, the check whose findings keep being confirmed, and the two kinds of check that must
 * never yield a maintenance prompt at all — the control that reads and reads and never fires,
 * and the abstainer that can only say it could not look.
 */

let store: Store
let showId: string
let episodeId: string
let scenes: Scene[]
let script: Artifact
let outline: Artifact

beforeEach(() => {
  store = openStore(':memory:')
  migrate(store)
  showId = createShow(store, { key: 'greyharbor', title: 'Grey Harbor' }).id
  const seasonId = createSeason(store, { showId, number: 1 }).id
  episodeId = createEpisode(store, { seasonId, number: 1, title: 'The Long Pier' }).id
  scenes = delineateScenes(store, episodeId, [
    { heading: 'Mess deck' },
    { heading: 'No. 4 lock' },
    { heading: 'The long pier' },
    { heading: 'Harbour office' },
  ])
  script = recordArtifact(store, { episodeId, kind: 'script', filePath: 'ep01/script.md' })
  outline = recordArtifact(store, { episodeId, kind: 'outline', filePath: 'ep01/outline.md' })
})

afterEach(() => {
  store.close()
})

// ── The rows, written the way the check system writes them ──────────────────────

/** One finding a text check would raise, keyed by the span it lands on. */
function says(span: string, concern = `The ${span} paragraph contradicts canon.`): FindingDraft {
  return {
    concern,
    severity: 'high',
    confidence: 'high',
    anchor: { sceneId: scenes[0]!.id, quote: span },
  }
}

/** One reading, and what it said — including nothing, which is the point. */
function read(checkKey: string, draft: Partial<CheckPassDraft> = {}): string[] {
  const pass = recordCheckPass(store, {
    checkKey,
    tier: 'text',
    artifactId: script.id,
    ...draft,
  })
  return findingsOfPass(store, pass.id).map((finding) => finding.id)
}

/** A gate on one artifact, ruled as an explicit override of the draft under review. */
function overrideAt(artifact: Artifact): void {
  const stage: Stage = scaffoldStage('write', [
    { name: `write-${artifact.kind}`, execute: async () => ({}) },
  ])
  const run = recordRun(store, stage, episodeId)
  reconcileSteps(store, run.id, stage)
  const step = findStepByName(store, run.id, `write-${artifact.kind}`)!
  const standing = presentForRuling(
    store,
    { runId: run.id, stepId: step.id, episodeId },
    { artifactId: artifact.id },
  )
  // The run was never started, so it is not paused and the ruling has nothing to resume. A
  // runner that WERE called here would be a fact about the ledger this read cannot see.
  const unusable: Runner = {
    enqueueRun: () => { throw new Error('the runner is not in this loop') },
    resumeRun: () => { throw new Error('the runner is not in this loop') },
    resumeInterrupted: () => { throw new Error('the runner is not in this loop') },
    settled: () => { throw new Error('the runner is not in this loop') },
  }
  createRulings(store, createEventLog(store), unusable).override(standing.gate.id, {
    comment: 'the world-rules finding is wrong about the lock.',
  })
}

function recordOf(checkKey: string) {
  return criedWolf(store, { showId }).find((record) => record.checkKey === checkKey)
}

// ── The wolf-crier ──────────────────────────────────────────────────────────────

describe('a check whose findings Ryan keeps putting down', () => {
  /**
   * Four concerns from one check: two dismissed with a note, one approved over at a gate, one
   * answered by a rewrite that the check then read and did not complain about again.
   */
  function theWolfCrier(): void {
    const [a, b, d] = read('world-rules', {
      findings: [says('airlock'), says('hardsuit'), says('ledger')],
    })
    dismissFinding(store, a!, 'Coveralls are sealed in ep01 — established in the pilot.')
    dismissFinding(store, b!, 'She is wearing one; the check misread the stage direction.')

    // The override lands on a different artifact, which is what a gate is: one artifact, one
    // ruling. It stood over the outline's finding and over nothing on the script.
    recordCheckPass(store, {
      checkKey: 'world-rules',
      tier: 'text',
      artifactId: outline.id,
      findings: [{ ...says('beat 3'), anchor: { sceneId: null, quote: 'beat 3' } }],
    })
    overrideAt(outline)

    // And the fourth: the span is rewritten, and the check reads the new draft and is quiet.
    expect(d).toBeDefined()
    reviseArtifact(store, script.id, { summary: 'the ledger paragraph rewritten' })
    read('world-rules')
  }

  it('yields the tune sentence, with every number in it true', () => {
    theWolfCrier()

    const record = recordOf('world-rules')!

    expect(record.dismissed).toBe(2)
    expect(record.overridden).toBe(1)
    expect(record.confirmed).toBe(1)
    expect(record.ruled).toBe(4)
    expect(record.firings).toBe(4)
    expect(record.concerns).toHaveLength(4)
    expect(record.readings).toBe(3)
    expect(record.silent).toBe(1)

    expect(record.tune).toBe(
      'world-rules — you have dismissed 3 of its last 4 ruled concerns: 2 dismissed with a ' +
        'note, 1 approved over at a gate, against 1 confirmed by a rewrite. It fired 4 times ' +
        'over 4 concerns in 3 readings, and found nothing in 1 of them. Tune this check?',
    )
    expect(tunePrompts(store, { showId })).toEqual([record.tune])
  })

  it('carries the finding behind every number, so a bench click can show its provenance', () => {
    theWolfCrier()

    const record = recordOf('world-rules')!
    const dismissed = record.concerns.filter((concern) => concern.verdict === 'dismissed')

    expect(dismissed.map((concern) => concern.note)).toEqual([
      'Coveralls are sealed in ep01 — established in the pilot.',
      'She is wearing one; the check misread the stage direction.',
    ])
    // Every concern names the rows it was computed from, and every id is a real finding.
    const ids = record.concerns.flatMap((concern) => concern.findingIds)
    expect(ids).toHaveLength(4)
    expect(record.concerns.every((concern) => concern.findingIds.length > 0)).toBe(true)
  })

  it('asks, and does not act — the read writes nothing at all', () => {
    theWolfCrier()
    const before = rowCensus()

    const sentences = tunePrompts(store, { showId })

    expect(sentences[0]!.endsWith('Tune this check?')).toBe(true)
    expect(rowCensus()).toEqual(before)
  })

  function rowCensus(): Record<string, number> {
    const tables = ['check_pass', 'finding', 'finding_disposition', 'check_gap', 'gate_ruling']
    return Object.fromEntries(
      tables.map((table) => [
        table,
        store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n,
      ]),
    )
  }
})

// ── An override counts the way a dismissal does ─────────────────────────────────

describe('an override at a gate', () => {
  it('counts against the check the way a dismissal does', () => {
    read('world-rules', { findings: [says('airlock'), says('hardsuit'), says('ledger')] })
    overrideAt(script)

    const record = recordOf('world-rules')!

    // One blanket ruling, three findings standing under it. Counting it against every check
    // whose finding was standing is the honest reading of what the ledger says happened.
    expect(record.overridden).toBe(3)
    expect(record.dismissed).toBe(0)
    expect(record.ruled).toBe(3)
    expect(record.tune).toContain('you have dismissed 3 of its last 3 ruled concerns')
    expect(record.tune).toContain('3 approved over at a gate')
  })

  it('does not reach a finding raised against a later draft than the one he ruled on', () => {
    read('world-rules', { findings: [says('airlock')] })
    overrideAt(script)

    reviseArtifact(store, script.id, { summary: 'rewritten after the override' })
    read('world-rules', { findings: [says('a wholly new complaint', 'Something new entirely.')] })

    const record = recordOf('world-rules')!

    expect(record.overridden).toBe(1)
    expect(record.concerns.find((concern) => concern.verdict === 'standing')).toBeDefined()
  })

  it('does not reach back over a draft he was never shown it against', () => {
    read('world-rules', { findings: [says('airlock')] })
    reviseArtifact(store, script.id, { summary: 'the airlock paragraph rewritten' })
    overrideAt(script)

    const record = recordOf('world-rules')!

    // The gate presented v2 and he ruled over what was standing THERE. The v1 finding was not:
    // its draft was already gone. Crediting the override with it would put a number in the
    // sentence whose provenance no click on the ledger could show.
    expect(record.overridden).toBe(0)
    expect(record.concerns[0]!.verdict).toBe('unread')
    expect(record.ruled).toBe(0)
  })

  it('defers to the note when Ryan had already put that concern down himself', () => {
    const [a] = read('world-rules', { findings: [says('airlock'), says('hardsuit')] })
    dismissFinding(store, a!, 'Coveralls are sealed in ep01.')
    overrideAt(script)

    const record = recordOf('world-rules')!

    expect(record.dismissed).toBe(1)
    expect(record.overridden).toBe(1)
  })
})

// ── Confirmed: the check that was right ─────────────────────────────────────────

describe('a check whose findings keep being confirmed', () => {
  it('yields no sentence — being right is not crying wolf', () => {
    read('continuity', { findings: [says('airlock'), says('hardsuit'), says('ledger')] })
    reviseArtifact(store, script.id, { summary: 'all three spans rewritten' })
    read('continuity')

    const record = recordOf('continuity')!

    expect(record.confirmed).toBe(3)
    expect(record.dismissed).toBe(0)
    expect(record.overridden).toBe(0)
    expect(record.ruled).toBe(3)
    expect(record.tune).toBeNull()
    expect(tunePrompts(store, { showId })).toEqual([])
  })

  it('is not confirmed by a rewrite nobody re-read — that is an unruled concern', () => {
    read('continuity', { findings: [says('airlock'), says('hardsuit'), says('ledger')] })
    reviseArtifact(store, script.id, { summary: 'rewritten, and nothing has read it' })

    const record = recordOf('continuity')!

    expect(record.confirmed).toBe(0)
    expect(record.ruled).toBe(0)
    expect(record.unruled).toBe(3)
    expect(record.concerns.every((concern) => concern.verdict === 'unread')).toBe(true)
    expect(record.tune).toBeNull()
  })

  it('is not confirmed while the draft it argued with is still the draft', () => {
    read('continuity', { findings: [says('airlock'), says('hardsuit'), says('ledger')] })
    read('continuity')

    const record = recordOf('continuity')!

    expect(record.confirmed).toBe(0)
    expect(record.concerns.every((concern) => concern.verdict === 'standing')).toBe(true)
    expect(record.tune).toBeNull()
  })
})

// ── The controls, and the abstainer ─────────────────────────────────────────────

describe('the checks that must never yield a maintenance prompt', () => {
  it('a check that reads and reads and never fires appears in no sentence', () => {
    for (let reading = 0; reading < 12; reading += 1) read('house-style')

    const record = recordOf('house-style')!

    // The measurement, not an absence: twelve readings on the record, and nothing found.
    expect(record.readings).toBe(12)
    expect(record.silent).toBe(12)
    expect(record.firings).toBe(0)
    expect(record.concerns).toEqual([])
    expect(record.ruled).toBe(0)
    expect(record.tune).toBeNull()
    expect(tunePrompts(store, { showId })).toEqual([])
  })

  it('an abstention is neither side of the ratio — a gap is not a finding put down', () => {
    for (let reading = 0; reading < 4; reading += 1) {
      read('world-rules', {
        gaps: [
          {
            reason: 'declared-unknown',
            detail: 'could not check the vacuum rules against Sefa Doule — species undecided.',
          },
        ],
      })
    }

    const record = recordOf('world-rules')!

    expect(record.gaps).toBe(4)
    expect(record.dismissed).toBe(0)
    expect(record.confirmed).toBe(0)
    expect(record.ruled).toBe(0)
    expect(record.tune).toBeNull()
    expect(tunePrompts(store, { showId })).toEqual([])
  })

  it('and a gap never dilutes a ratio it had nothing to do with', () => {
    const [a, b, c] = read('world-rules', {
      findings: [says('airlock'), says('hardsuit'), says('ledger')],
      gaps: [{ reason: 'undeclared', detail: 'no species declared, so no physiology in scope.' }],
    })
    dismissFinding(store, a!, 'sealed.')
    dismissFinding(store, b!, 'she is wearing one.')
    dismissFinding(store, c!, 'the ledger is a prop.')

    const record = recordOf('world-rules')!

    // Three of three, and the gap is reported beside it rather than folded into either side.
    expect(record.ruled).toBe(3)
    expect(record.dismissed).toBe(3)
    expect(record.gaps).toBe(1)
    expect(record.tune).toContain('you have dismissed 3 of its last 3 ruled concerns')
    expect(record.tune).toContain('could not look 1 time')
  })
})

// ── Twins ───────────────────────────────────────────────────────────────────────

describe('twins are one concern, and every firing is still counted', () => {
  it('folds re-firings into one concern while keeping them in the denominator', () => {
    const [first] = read('vacuum-without-protection', { findings: [says('the pier')] })
    dismissFinding(store, first!, 'Coveralls are sealed in ep01.')

    // Two rewrites elsewhere in the episode, and the free tier re-reads the same rows twice.
    reviseArtifact(store, script.id, { summary: 'scene 1 rewritten' })
    read('vacuum-without-protection', { findings: [says('the pier')] })
    reviseArtifact(store, script.id, { summary: 'scene 2 rewritten' })
    read('vacuum-without-protection', { findings: [says('the pier')] })

    const record = recordOf('vacuum-without-protection')!

    // Three rows, three firings — D11's denominator counts every reading that said something.
    expect(record.firings).toBe(3)
    expect(record.readings).toBe(3)
    // One concern, and Ryan ruled on it once.
    expect(record.concerns).toHaveLength(1)
    expect(record.concerns[0]!.findingIds).toHaveLength(3)
    expect(record.concerns[0]!.verdict).toBe('dismissed')
    expect(record.dismissed).toBe(1)
    expect(record.ruled).toBe(1)
  })

  it('is not confirmed when the check came back and said the same thing again', () => {
    read('vacuum-without-protection', { findings: [says('the pier')] })
    reviseArtifact(store, script.id, { summary: 'scene 1 rewritten' })
    read('vacuum-without-protection', { findings: [says('the pier')] })

    const record = recordOf('vacuum-without-protection')!

    // A rewrite landed and the check read the new draft — but it said it again, so nothing
    // was answered. The concern is standing against the current draft, not confirmed.
    expect(record.confirmed).toBe(0)
    expect(record.concerns[0]!.verdict).toBe('standing')
    expect(record.ruled).toBe(0)
  })

  it('counts a genuinely new contradiction as its own concern, never as an old twin', () => {
    const [first] = read('vacuum-without-protection', { findings: [says('the pier')] })
    dismissFinding(store, first!, 'Coveralls are sealed in ep01.')

    reviseArtifact(store, script.id, { summary: 'scene 6 rewritten' })
    read('vacuum-without-protection', {
      findings: [
        says('the pier'),
        // The same rule, the same scene, a different body: never the concern he ruled on.
        says('the pier head', 'Ilse Renn is outside the pressure hull with nothing on.'),
      ],
    })

    const record = recordOf('vacuum-without-protection')!

    expect(record.concerns).toHaveLength(2)
    expect(record.concerns.map((concern) => concern.verdict).sort()).toEqual([
      'dismissed',
      'standing',
    ])
    // His note reached the twin and nothing else. The new one is unruled, and it is loud.
    expect(record.dismissed).toBe(1)
    expect(record.unruled).toBe(1)
  })

  it('never lets a rewrite-heavy episode alone make a check look like a wolf-crier', () => {
    const [first] = read('vacuum-without-protection', { findings: [says('the pier')] })
    dismissFinding(store, first!, 'Coveralls are sealed in ep01.')
    for (let rewrite = 0; rewrite < 8; rewrite += 1) {
      reviseArtifact(store, script.id, { summary: `rewrite ${rewrite}` })
      read('vacuum-without-protection', { findings: [says('the pier')] })
    }

    const record = recordOf('vacuum-without-protection')!

    // Nine firings of one concern, ruled once. One is under the minimum, so no sentence —
    // and counting rows instead of concerns would have made this 9 of 9 dismissed.
    expect(record.firings).toBe(9)
    expect(record.ruled).toBe(1)
    expect(record.tune).toBeNull()
  })
})

// ── Not enough to ask about ─────────────────────────────────────────────────────

describe('the minimum', () => {
  it('says nothing about one dismissal — a check is not tuned on a single ruling', () => {
    const [a] = read('world-rules', { findings: [says('airlock')] })
    dismissFinding(store, a!, 'Coveralls are sealed in ep01.')

    expect(MIN_RULED_CONCERNS).toBe(3)
    expect(recordOf('world-rules')!.ruled).toBe(1)
    expect(recordOf('world-rules')!.tune).toBeNull()
  })

  it('says nothing when he has put down fewer than half of them', () => {
    const [a, b, c] = read('world-rules', {
      findings: [says('airlock'), says('hardsuit'), says('ledger'), says('the pier')],
    })
    dismissFinding(store, a!, 'sealed.')
    dismissFinding(store, b!, 'she is wearing one.')
    expect(c).toBeDefined()
    reviseArtifact(store, script.id, { summary: 'the other two rewritten' })
    read('world-rules')

    const record = recordOf('world-rules')!

    expect(record.dismissed).toBe(2)
    expect(record.confirmed).toBe(2)
    expect(record.tune).toBeNull()
  })
})

// ── The window ──────────────────────────────────────────────────────────────────

describe('the window — a check tuned six months ago is not judged on what it did before', () => {
  it('leaves a reading older than the window out of every number', () => {
    // Written as history rather than recorded, because `check_pass` refuses an UPDATE (0010)
    // and `recordCheckPass` stamps `ran_at` with now. This is the one thing a test cannot
    // build through the domain API: a reading that happened a long time ago.
    const ancient = newId('pass')
    store.run(
      `INSERT INTO check_pass (id, check_key, tier, artifact_id, artifact_version, ran_at)
            VALUES (?, 'world-rules', 'text', ?, 1, '2020-01-01T00:00:00.000Z')`,
      ancient,
      script.id,
    )
    store.run(
      `INSERT INTO finding (id, pass_id, artifact_id, artifact_version, quote, concern,
                            severity, confidence)
            VALUES (?, ?, ?, 1, 'long ago', 'A complaint from another era.', 'high', 'high')`,
      newId('find'),
      ancient,
      script.id,
    )

    expect(recordOf('world-rules')).toBeUndefined()
    // And it is still on the record — the window is what the ratio looks at, not what exists.
    expect(criedWolf(store, { showId, since: '2019-01-01T00:00:00.000Z' })).toHaveLength(1)
  })

  it('answers for the show it was asked about and no other', () => {
    read('world-rules', { findings: [says('airlock')] })
    const other = createShow(store, { key: 'deadlight', title: 'Dead Light' }).id

    expect(recordOf('world-rules')).toBeDefined()
    expect(criedWolf(store, { showId: other })).toEqual([])
  })
})

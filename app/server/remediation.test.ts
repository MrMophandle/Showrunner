import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import type { Store } from './db/store.ts'
import {
  artifactsOf,
  findArtifact,
  reviseArtifact,
  revisionsOf,
  staleArtifacts,
  type Artifact,
} from './domain/artifact.ts'
import { runBoardRules } from './domain/board-rules.ts'
import { boardOf, recordExtractedBoard } from './domain/board.ts'
import { factsOfEntity, findFact } from './domain/fact.ts'
import {
  checkPassesOf,
  dismissalNotes,
  dismissFinding,
  findFinding,
  findingsIn,
  findingsOfPass,
  recordCheckPass,
  type Finding,
} from './domain/finding.ts'
import { verdictBoard } from './domain/panel.ts'
import { openProposals } from './domain/proposal.ts'
import { scenesOf, type Scene } from './domain/spine.ts'
import { sceneSpans } from './domain/text-check.ts'
import { createEventLog } from './events.ts'
import { greyHarborFounded, type FoundedFixture } from './fixture/founded.ts'
import { theLongPierExtraction } from './fixture/long-pier-board.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from './library.ts'
import { createFakeLLM, type FakeLLM } from './llm/fake.ts'
import {
  applyRewrite,
  canonChangePrefill,
  MAX_PREDRAFT_ATTEMPTS,
  predraftRewrite,
  proposeCanonChange,
  recheckScene,
  remediationsFor,
} from './remediation.ts'
import { createRulings } from './runner/gate.ts'
import { createRunner, type Runner } from './runner/runner.ts'
import { stageBlockedBecause } from './runner/stage-wall.ts'
import { TEXT_CHECK_STAGE, textCheckStages } from './runner/text-check-step.ts'

/**
 * The three buttons behind a finding (4.3): **rewrite the span, propose the canon change,
 * dismiss with note** — and the two things that hold them honest.
 *
 * The first is E3-3's amendment, and it has the most tests under it: applying a rewrite is ONE
 * motion, because a rewrite that landed a version and stopped would take D12's wall down over
 * a draft nothing had read. There is a control for it below — a bare `reviseArtifact`, which
 * is what the naive half-motion would be — and the point of the control is that it FAILS the
 * way the amendment says it would.
 *
 * The second is D14's scope, proved the way E3-2 proved invariant 2: against the string that
 * went over the wire. A scene-scoped re-check that quietly sent the whole script would pass
 * every assertion about clearing and cost twice as much as the panel it replaces.
 *
 * Every call is `createFakeLLM`, the only backend `npm test` may reach. The real-call path is
 * documented in `remediation.ts` and run by hand.
 */

let root: string
let paths: LibraryPaths
let store: Store
let llm: FakeLLM
let harbor: FoundedFixture
let episodeId: string
let script: Artifact
let scenes: Scene[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-remediation-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  harbor = greyHarborFounded(store, paths)
  episodeId = store.get<{ id: string }>("SELECT id FROM episode WHERE title = 'The Long Pier'")!.id
  script = artifactsOf(store, episodeId).find((artifact) => artifact.kind === 'script')!
  scenes = scenesOf(store, episodeId)
  llm = createFakeLLM()
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** The planted span: Tobin on the pier in his coveralls, which the world rules forbid. */
const SPAN = 'Tobin comes out onto the pier in his coveralls'

/** What a rewrite puts in its place — suited, and still the same beat. */
const SUITED = 'Tobin comes out onto the pier in a sealed hardsuit'

function factOf(entity: string, needle: string): string {
  const row = store.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(store, row.id).find((fact) => fact.statement.includes(needle))!.id
}

/** The world-rules finding on scene 4, as E3-2's checker would have raised it. */
function plantTheCanonFinding(): Finding {
  const pass = recordCheckPass(store, {
    checkKey: 'world-rules',
    tier: 'text',
    artifactId: script.id,
    findings: [
      {
        concern:
          'Three minutes outside the pressure hull in coveralls. The rule names a sealed ' +
          'hardsuit or an active containment field and the scene shows neither.',
        severity: 'high',
        confidence: 'high',
        anchor: { sceneId: scenes[3]!.id, quote: SPAN },
        entityId: harbor.entity('Tobin Wick').id,
        factIds: [factOf('Halvani', 'loses consciousness')],
      },
    ],
  })
  return findingsOfPass(store, pass.id)[0]!
}

/** A craft finding two scenes away, which no rewrite of scene 4 answers and no re-check reads. */
function plantACraftFinding(): Finding {
  const pass = recordCheckPass(store, {
    checkKey: 'pacing',
    tier: 'text',
    artifactId: script.id,
    findings: [
      {
        concern: 'The office turn is bought in one line and needed three.',
        severity: 'medium',
        confidence: 'medium',
        anchor: { sceneId: scenes[1]!.id, quote: 'Two decks up, and colder.' },
      },
    ],
  })
  return findingsOfPass(store, pass.id)[0]!
}

/** The board as the fixture extracted it by hand, and the four free rules over it. */
function checkTheBoard(): void {
  const board = recordExtractedBoard(store, {
    episodeId,
    scriptId: script.id,
    extraction: theLongPierExtraction({
      lockCycle: factOf('Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factOf('Halvani', 'loses consciousness'),
    }),
    filePath: 'greyharbor/s01e01/continuity-board-v1.md',
  })
  runBoardRules(store, board.artifact.id)
}

const onDisk = (artifact: Artifact): string =>
  readFileSync(join(paths.artifactDir, artifact.filePath!), 'utf8')

const deterministicPassesAt = (version: number) =>
  checkPassesOf(store, script.id).filter(
    (pass) => pass.tier === 'deterministic' && pass.artifactVersion === version,
  )

const rulingCount = (): number =>
  store.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_ruling')!.n

describe('applying a rewrite is one motion, and there is no way to do half of it', () => {
  it('revises the artifact one version, names the touched scene, and writes a new file beside the old', () => {
    const finding = plantTheCanonFinding()

    const applied = applyRewrite(store, paths, { findingId: finding.id, replacement: SUITED })

    expect(applied).toMatchObject({
      version: 2,
      filePath: 'greyharbor/s01e01/script-v2.md',
      scene: 4,
    })
    const after = findArtifact(store, script.id)!
    expect(after.version).toEqual(2)
    expect(onDisk(after)).toContain(SUITED)
    expect(onDisk(after)).not.toContain(SPAN)

    // The draft it replaced is still on the volume, untouched — a hand-made asset always wins
    // and every version stays readable (D2, D20).
    expect(existsSync(join(paths.artifactDir, 'greyharbor/s01e01/script.md'))).toBe(true)
    expect(readFileSync(join(paths.artifactDir, 'greyharbor/s01e01/script.md'), 'utf8')).toContain(SPAN)

    // The revision names the scene, which is what makes staleness land where the edit did.
    expect(revisionsOf(store, script.id).filter((revision) => revision.version === 2)).toEqual([
      expect.objectContaining({ version: 2, sceneId: scenes[3]!.id }),
    ])
  })

  it('re-runs the free deterministic tier over the new version before it returns — the receipt', () => {
    checkTheBoard()
    const finding = plantTheCanonFinding()
    expect(deterministicPassesAt(2)).toEqual([])

    const applied = applyRewrite(store, paths, { findingId: finding.id, replacement: SUITED })

    // The motion has returned, and the new draft has already been read: two canon-graph checks
    // against the script itself AT v2, plus the four board rules, whose findings anchor here.
    expect(applied.read.map((one) => one.checkKey)).toEqual([
      'stale-exception',
      'retired-reappearance',
      'dual-presence',
      'impossible-adjacency',
      'duplicate-arrival',
      'vacuum-without-protection',
    ])
    expect(deterministicPassesAt(2).map((pass) => pass.checkKey)).toEqual([
      'stale-exception',
      'retired-reappearance',
    ])
  })

  it('never lets the wall read a never-checked current version as clear', () => {
    checkTheBoard()
    const finding = plantTheCanonFinding()
    // Tobin on the pier with nothing on, standing against v1 — the board rule that agrees with
    // the check whose span is about to be rewritten. The wall is up.
    expect(stageBlockedBecause(store, episodeId)).toContain('vacuum-without-protection')

    // ── The control: the half-motion this issue exists to forbid ──────────────
    // A rewrite that lands a version and stops. Every finding was anchored in the draft it
    // replaced, so every one of them drops out of the wall — and nothing has read what took
    // its place. This is what "never-checked rendering as checked-clean" looks like, and it
    // is asserted rather than described so that the motion below has something to beat.
    const control = anotherGreyHarbor()
    try {
      reviseArtifact(control.store, control.script.id, {
        summary: 'a rewrite that landed a version and stopped',
        touchedScenes: [scenesOf(control.store, control.episodeId)[3]!.id],
      })
      expect(stageBlockedBecause(control.store, control.episodeId)).toBeNull()
      expect(
        checkPassesOf(control.store, control.script.id).filter((pass) => pass.artifactVersion === 2),
      ).toEqual([])
    } finally {
      control.close()
    }

    // ── The motion ────────────────────────────────────────────────────────────
    const applied = applyRewrite(store, paths, { findingId: finding.id, replacement: SUITED })

    // The wall is up on the far side too — but for the opposite reason. It is standing on a
    // reading of THIS draft (the board rules re-ran, at v2), never on the absence of one. The
    // board is a reading of the draft that was just replaced, so it goes on saying what it saw
    // until somebody pays to re-extract it; that is the conservative direction, and a `stale`
    // row on the verdict board is where Ryan is told which it is.
    expect(applied.wall).toContain('vacuum-without-protection')
    expect(stageBlockedBecause(store, episodeId)).toEqual(applied.wall)
    expect(
      findingsIn(store, script.id).filter(
        (one) => one.tier === 'deterministic' && one.anchor.version === 2,
      ).length,
    ).toBeGreaterThan(0)
    expect(deterministicPassesAt(2)).not.toEqual([])
  })

  it('marks the board stale by moving an edge, and sets no flag anywhere', () => {
    checkTheBoard()
    const board = boardOf(store, episodeId)!
    expect(staleArtifacts(store, episodeId)).toEqual([])

    const applied = applyRewrite(store, paths, {
      findingId: plantTheCanonFinding().id,
      replacement: SUITED,
    })

    expect(applied.stale.map((one) => one.kind)).toEqual(['continuity-board'])
    // Computed, not remembered: the report is what `staleArtifacts` says at that moment, and
    // asking again gives the same answer off the same edges (1.3). The rewrite wrote a
    // revision and a file, and nothing else — there is no flag for it to have set.
    expect(staleArtifacts(store, episodeId).map((one) => one.artifact.id)).toEqual([
      board.artifact.id,
    ])
    expect(staleArtifacts(store, episodeId)[0]!.reasons[0]).toMatchObject({
      kind: 'input-moved-on',
      consumedVersion: 1,
      currentVersion: 2,
      sceneId: scenes[3]!.id,
    })
    // And the verdict board says the four deterministic rows are `stale` rather than green —
    // they were re-run over a board that is a reading of the draft this one replaced.
    const rows = verdictBoard(store, findArtifact(store, script.id)!).rows
    expect(rows.filter((row) => row.tier === 'deterministic').map((row) => row.verdict)).toEqual([
      'stale',
      'stale',
      'stale',
      'stale',
    ])
  })

  it('applies an edited draft verbatim — his edit is a hand-made asset (D20)', () => {
    const finding = plantTheCanonFinding()
    // Ryan's own words, with his own spacing and his own em dash. Nothing tidies them.
    const his = 'Tobin comes out onto the pier   sealed into a hardsuit — helmet down, gloves on'

    applyRewrite(store, paths, { findingId: finding.id, replacement: his })

    expect(onDisk(findArtifact(store, script.id)!)).toContain(his)
  })

  it('refuses a replacement that is the span it would replace', () => {
    const finding = plantTheCanonFinding()

    expect(() => applyRewrite(store, paths, { findingId: finding.id, replacement: SPAN })).toThrow(
      /changes nothing still spends a version/,
    )
    expect(findArtifact(store, script.id)!.version).toEqual(1)
  })

  it('refuses a finding raised against a draft the artifact has already moved past', () => {
    const finding = plantTheCanonFinding()
    applyRewrite(store, paths, { findingId: finding.id, replacement: SUITED })

    // The same finding, a second time. Its span is gone and so is the draft it argued with.
    expect(() => applyRewrite(store, paths, { findingId: finding.id, replacement: 'again' })).toThrow(
      /draft it argued with is gone/,
    )
    expect(findArtifact(store, script.id)!.version).toEqual(2)
  })

  it('says in words, before the click, that a finding with no span has nothing to rewrite', () => {
    const pass = recordCheckPass(store, {
      checkKey: 'retired-reappearance',
      tier: 'deterministic',
      artifactId: script.id,
      findings: [
        {
          concern: 'Somebody declared retired is in this script’s provenance.',
          severity: 'high',
          confidence: 'certain',
          entityId: harbor.entity('Tobin Wick').id,
        },
      ],
    })
    const finding = findingsOfPass(store, pass.id)[0]!

    const offers = remediationsFor(store, paths, finding.id)
    expect(offers.predraft.enabled).toBe(false)
    expect(offers.predraft.blockedBecause).toContain('lands on no span')
    expect(offers.dismiss.enabled).toBe(true)
    expect(() => applyRewrite(store, paths, { findingId: finding.id, replacement: 'x' })).toThrow(
      /lands on no span/,
    )
  })
})

describe('the pre-draft is a draft — nothing applies itself', () => {
  const drafted = (replacement: string, why = 'seals Tobin into a hardsuit for the walk') => ({
    text: JSON.stringify({ replacement, why }),
    usage: { uncachedInput: 3200, output: 90 },
  })

  it('drafts a replacement and moves the artifact not at all (invariant 5)', async () => {
    const finding = plantTheCanonFinding()
    llm.reply(drafted(SUITED))

    const predraft = await predraftRewrite(store, llm, paths, finding.id)

    expect(predraft).toMatchObject({ replacement: SUITED, version: 1, scene: 4, quote: SPAN })
    expect(predraft.attempts).toEqual([{ attempt: 1, failure: null, dollars: expect.any(Number) }])
    // THE POINT: a draft that had already landed would not be a draft.
    expect(findArtifact(store, script.id)!.version).toEqual(1)
    expect(onDisk(script)).toContain(SPAN)
    expect(existsSync(join(paths.artifactDir, 'greyharbor/s01e01/script-v2.md'))).toBe(false)
    expect(revisionsOf(store, script.id)).toHaveLength(1)
  })

  it('bills the call against the episode and the show, with no run and no step to hang it on', async () => {
    const finding = plantTheCanonFinding()
    llm.reply(drafted(SUITED))

    await predraftRewrite(store, llm, paths, finding.id)

    expect(
      store.get(
        'SELECT COUNT(*) AS n FROM cost_entry WHERE episode_id = ? AND show_id IS NOT NULL AND run_id IS NULL AND step_id IS NULL',
        episodeId,
      ),
    ).toEqual({ n: 1 })
  })

  it('keeps a failed attempt and carries on, bounded at three (invariant 5)', async () => {
    const finding = plantTheCanonFinding()
    llm.reply('Certainly! I would suggest putting Tobin in a hardsuit.')
    llm.reply(drafted(SUITED))

    const predraft = await predraftRewrite(store, llm, paths, finding.id)

    expect(predraft.attempts.map((one) => one.attempt)).toEqual([1, 2])
    expect(predraft.attempts[0]!.failure).toMatch(/did not come back as a rewrite/)
    expect(predraft.attempts[1]!.failure).toBeNull()
    // Both calls are on the ledger. A reply nobody could read was still a call.
    expect(store.get('SELECT COUNT(*) AS n FROM cost_entry')).toEqual({ n: 2 })
  })

  it('spends the bound and hands it back rather than applying something broken', async () => {
    const finding = plantTheCanonFinding()
    for (let attempt = 0; attempt < MAX_PREDRAFT_ATTEMPTS; attempt += 1) {
      llm.reply('Happy to help — here are some thoughts on the pier.')
    }

    await expect(predraftRewrite(store, llm, paths, finding.id)).rejects.toThrow(
      /did not come back as a rewrite in 3 attempts/,
    )
    expect(llm.calls).toHaveLength(3)
    expect(store.get('SELECT COUNT(*) AS n FROM cost_entry')).toEqual({ n: 3 })
    expect(findArtifact(store, script.id)!.version).toEqual(1)
  })

  it('refuses a draft that hands the span back unchanged', async () => {
    const finding = plantTheCanonFinding()
    for (let attempt = 0; attempt < MAX_PREDRAFT_ATTEMPTS; attempt += 1) {
      llm.reply(drafted(SPAN, 'left it as it was'))
    }

    await expect(predraftRewrite(store, llm, paths, finding.id)).rejects.toThrow(
      /handed the span back unchanged/,
    )
  })

  it('sends the concern, the canon it argues with, and the scene — and no other scene', async () => {
    const finding = plantTheCanonFinding()
    llm.reply(drafted(SUITED))

    await predraftRewrite(store, llm, paths, finding.id)

    const asked = llm.calls[0]!.prompt
    expect(asked).toContain('Three minutes outside the pressure hull')
    expect(asked).toContain('loses consciousness in about nine seconds')
    expect(asked).toContain(SPAN)
    // The scene, and only the scene — at BOTH ends. A span bounded at the front and running
    // to the end of the file is the silent version of this bug: the prompt looks scene-shaped
    // in every assertion that checks an earlier scene, and carries the rest of the episode.
    expect(asked).not.toContain('Two decks up, and colder')
    expect(asked).not.toContain('Tobin comes in with the scorched relay')
    expect(asked).not.toContain('helmet sealed')
    expect(asked).not.toContain('FADE OUT.')
  })
})

describe('the scene-scoped re-check is paid, and its scope is its reason to exist (D14)', () => {
  const CLEAN = { text: '{"findings": []}', usage: { uncachedInput: 3800, output: 40 } }

  /** Scene 4 rewritten, scene 2 left alone — one question outstanding in each. */
  function rewriteSceneFour(): Finding {
    const canon = plantTheCanonFinding()
    plantACraftFinding()
    applyRewrite(store, paths, { findingId: canon.id, replacement: SUITED })
    return canon
  }

  it('reads the touched scene and not the rest of the script — proved from what the adapter was handed', async () => {
    rewriteSceneFour()
    llm.reply(CLEAN)

    const rechecked = await recheckScene(store, llm, paths, {
      artifactId: script.id,
      sceneId: scenes[3]!.id,
    })

    // One reviewer, one call: the check that argued with scene 4 re-reads scene 4. The other
    // nine the panel convenes are not re-convened, which is the difference D14 was ruled for.
    expect(llm.calls).toHaveLength(1)
    expect(rechecked.read.map((one) => one.checkKey)).toEqual(['world-rules'])

    const asked = llm.calls[0]!.prompt
    expect(asked).toContain(SUITED)
    expect(asked).toContain('The pier runs out from the ring in a long spar')
    // Every other scene, absent from the wire.
    expect(asked).not.toContain('The mess deck is warm')
    expect(asked).not.toContain('Two decks up, and colder')
    expect(asked).not.toContain('The lock is a grey box')
    expect(asked).not.toContain('helmet sealed')
    expect(asked).toContain('scene 4 only')
  })

  it('clears exactly the finding whose scene it read, and writes nothing to it', async () => {
    const canon = rewriteSceneFour()
    llm.reply(CLEAN)

    const rechecked = await recheckScene(store, llm, paths, {
      artifactId: script.id,
      sceneId: scenes[3]!.id,
    })

    expect(rechecked).toMatchObject({ findings: 0, scene: 4, answered: [canon.id] })

    // Clearing IS the passing. The finding is untouched: still open, no disposition, exactly
    // what the check said at v1 — a record, not state (0010, and E3-5's ruling against
    // a `cleared` disposition).
    const still = findFinding(store, canon.id)!
    expect(still).toMatchObject({ status: 'open', disposition: null })
    expect(still.anchor.version).toEqual(1)

    // What changed is the READING. The pass is at v2 and says which scene it read.
    const fresh = checkPassesOf(store, script.id).filter((pass) => pass.artifactVersion === 2)
    expect(fresh.filter((pass) => pass.tier === 'text')).toEqual([
      expect.objectContaining({ checkKey: 'world-rules', sceneId: scenes[3]!.id, findingCount: 0 }),
    ])
  })

  it('reports the scene it read as `partial`, and the scene nobody read as `unread`', async () => {
    rewriteSceneFour()
    llm.reply(CLEAN)

    await recheckScene(store, llm, paths, { artifactId: script.id, sceneId: scenes[3]!.id })

    const board = verdictBoard(store, findArtifact(store, script.id)!)
    // Green here would be a check that read a paragraph rendered as a check that read the
    // episode — invariant 4's failure mode, one narrowing down.
    expect(board.rows.find((row) => row.checkKey === 'world-rules')).toMatchObject({
      verdict: 'partial',
      standing: 0,
    })
    expect(board.rows.find((row) => row.checkKey === 'world-rules')!.what).toContain(
      'the rest of this draft it has not read',
    )
    // Nobody re-read scene 2, and the board says so rather than saying nothing.
    expect(board.rows.find((row) => row.checkKey === 'pacing')).toMatchObject({
      verdict: 'unread',
      passId: null,
    })
    expect(board.sentence).toContain('only the scene that was rewritten')
  })

  it('raises against the new words rather than clearing, when the rewrite did not answer it', async () => {
    rewriteSceneFour()
    llm.reply({
      text: JSON.stringify({
        findings: [
          {
            scene: 4,
            quote: SUITED,
            concern: 'A sealed hardsuit is named, and the scene never shows him sealing it.',
            severity: 'medium',
            confidence: 'medium',
            entity: 'Tobin Wick',
            facts: [factOf('Halvani', 'loses consciousness')],
          },
        ],
      }),
      usage: { uncachedInput: 3800, output: 120 },
    })

    const rechecked = await recheckScene(store, llm, paths, {
      artifactId: script.id,
      sceneId: scenes[3]!.id,
    })

    expect(rechecked.findings).toEqual(1)
    const raised = findingsIn(store, script.id).filter((one) => one.anchor.version === 2)
    expect(raised).toHaveLength(1)
    expect(raised[0]!.anchor.quote).toEqual(SUITED)
    expect(verdictBoard(store, findArtifact(store, script.id)!).rows.find(
      (row) => row.checkKey === 'world-rules',
    )).toMatchObject({ verdict: 'found', standing: 1 })
  })

  it('refuses a finding about a scene the pass was never given', async () => {
    rewriteSceneFour()
    llm.reply({
      text: JSON.stringify({
        findings: [
          {
            scene: 2,
            quote: 'Two decks up, and colder.',
            concern: 'raised about a scene this pass never saw',
            severity: 'low',
            confidence: 'low',
          },
        ],
      }),
      usage: { uncachedInput: 3800, output: 60 },
    })

    await expect(
      recheckScene(store, llm, paths, { artifactId: script.id, sceneId: scenes[3]!.id }),
    ).rejects.toThrow(/was given scene 4 and nothing else to read/)
    // Nothing recorded: a re-check is tier-atomic for E3-4's reasons. The only text passes are
    // the two that planted the findings in the first place, both at v1.
    expect(
      checkPassesOf(store, script.id)
        .filter((pass) => pass.tier === 'text')
        .map((pass) => pass.artifactVersion),
    ).toEqual([1, 1])
  })

  it('refuses, in words, to re-read a scene nothing was raised about', async () => {
    rewriteSceneFour()

    await expect(
      recheckScene(store, llm, paths, { artifactId: script.id, sceneId: scenes[0]!.id }),
    ).rejects.toThrow(/nothing here to re-read/)
    expect(llm.calls).toEqual([])
  })

  it('states what it will cost before the click, and what it will not re-convene', () => {
    const applied = applyRewrite(store, paths, {
      findingId: plantTheCanonFinding().id,
      replacement: SUITED,
    })

    expect(applied.recheck.enabled).toBe(true)
    expect(applied.recheck.sentence).toContain('Re-read scene 4 of the script with the 1 check')
    expect(applied.recheck.cost).toMatch(/1 Opus call, ~\$\d/)
  })
})

describe('propose the canon change — it raises, and it never rules', () => {
  it('prefills the change from the concern and the context from the span with its surrounding lines', () => {
    const finding = plantTheCanonFinding()

    const prefill = canonChangePrefill(store, paths, finding.id)

    // The subject is the Halvani and not Tobin Wick, which is D22 showing through: the check
    // argued about him, and the fact it quoted is his species', inherited across the edge his
    // sheet declares. A delta's before and after are two statements about one subject.
    expect(prefill).toMatchObject({
      factId: factOf('Halvani', 'loses consciousness'),
      entityId: harbor.entity('Halvani').id,
      entityName: 'Halvani',
      blockedBecause: null,
    })
    expect(prefill.before).toContain('loses consciousness in about nine seconds')
    // The span, quoted, with the lines around it — a ruling on a sentence with nothing under
    // it is a ruling on a sentence.
    expect(prefill.usageContext).toContain(`> ${SPAN}`)
    expect(prefill.usageContext).toContain('← the span')
    expect(prefill.usageContext).toContain('> metres out.')
    expect(prefill.usageContext).toContain('> hand, torque bar hooked at his belt.')
    expect(prefill.usageContext).toContain('> At the head, he gets the housing open.')
    expect(prefill.usageContext).toContain('Three minutes outside the pressure hull')
    expect(prefill.alternatives).toHaveLength(2)
  })

  it('lands on the queue riding the episode, unruled, and writes no canon', () => {
    const before = rulingCount()
    const finding = plantTheCanonFinding()

    const proposal = proposeCanonChange(store, paths, finding.id, {
      statement:
        'A Halvani in vacuum has about ninety seconds before they lose consciousness, not nine.',
    })

    expect(proposal).toMatchObject({
      kind: 'fact-delta',
      raisedBy: 'check',
      episodeId,
      status: 'raised',
      disposition: null,
    })
    expect(proposal.change.facts[0]!.supersedes).toEqual(factOf('Halvani', 'loses consciousness'))
    expect(proposal.usageContext).toContain(SPAN)
    expect(openProposals(store, harbor.show.id).map((one) => one.id)).toContain(proposal.id)

    // Invariant 1, asserted rather than promised: not one ruling landed on the ledger, and the
    // claim it wrote is provisional — riding the episode, invisible to `canonAsOf`.
    expect(rulingCount()).toEqual(before)
    expect(findFact(store, proposal.change.facts[0]!.factId!)!.ratifiedBy).toBeNull()
    expect(findFact(store, factOf('Halvani', 'loses consciousness'))!.closure).toBeNull()
  })

  it('quotes the span as the check recorded it once the draft has moved past it', () => {
    const finding = plantTheCanonFinding()
    applyRewrite(store, paths, { findingId: finding.id, replacement: SUITED })

    // Proposing stays available after a rewrite, and should: the world may still be what was
    // wrong. What must not happen is the two nothings collapsing — "this finding never had a
    // span" and "its span is gone from the draft" are different sentences, and the second of
    // the five parts is kept forever on a record Ryan rules against.
    const prefill = canonChangePrefill(store, paths, finding.id)
    expect(prefill.blockedBecause).toBeNull()
    expect(prefill.usageContext).toContain(`> ${SPAN}`)
    expect(prefill.usageContext).toContain('no longer in it')
    expect(prefill.usageContext).not.toContain('It lands on no particular span')

    // And it is what lands on the proposal, not a summary of it.
    const raised = proposeCanonChange(store, paths, finding.id, { statement: 'ninety seconds' })
    expect(raised.usageContext).toContain(SPAN)
  })

  it('says a finding that never had a span had none, and quotes nothing', () => {
    const pass = recordCheckPass(store, {
      checkKey: 'retired-reappearance',
      tier: 'deterministic',
      artifactId: script.id,
      findings: [
        {
          concern: 'Somebody declared retired is in this script’s provenance.',
          severity: 'high',
          confidence: 'certain',
          entityId: harbor.entity('Tobin Wick').id,
          factIds: [factOf('Halvani', 'loses consciousness')],
        },
      ],
    })

    const prefill = canonChangePrefill(store, paths, findingsOfPass(store, pass.id)[0]!.id)
    expect(prefill.usageContext).toContain('It lands on no particular span')
    expect(prefill.usageContext).not.toContain('>')
  })

  it('refuses, in words, when the finding quotes no canon fact', () => {
    const craft = plantACraftFinding()

    expect(remediationsFor(store, paths, craft.id).propose.blockedBecause).toContain(
      'quotes no canon fact',
    )
    expect(() =>
      proposeCanonChange(store, paths, craft.id, { statement: 'anything' }),
    ).toThrow(/quotes no canon fact/)
  })
})

describe('one record, many readers (4.4)', () => {
  it('stores the note on the finding and hands it back, scoped by the check that raised it', () => {
    const finding = plantTheCanonFinding()
    plantACraftFinding()

    dismissFinding(store, finding.id, 'Coveralls are rated for three minutes on the spar. Fine.')

    expect(dismissalNotes(store, { showId: harbor.show.id })).toEqual([
      expect.objectContaining({
        findingId: finding.id,
        checkKey: 'world-rules',
        quote: SPAN,
        note: 'Coveralls are rated for three minutes on the spar. Fine.',
        episodeId,
      }),
    ])
    expect(dismissalNotes(store, { showId: harbor.show.id, checkKey: 'world-rules' })).toHaveLength(1)
    // A category's notes are that category's. The pacing reviewer is told nothing about this.
    expect(dismissalNotes(store, { showId: harbor.show.id, checkKey: 'pacing' })).toEqual([])
  })

  it('hands them back newest first, even when they were ruled in the same millisecond', () => {
    // Three findings raised in one order and put down in the reverse of it. `at` is
    // milliseconds and a sitting at a keyboard is faster than that, so the tie-break is what
    // decides the order in practice — and it has to be the order HE ruled in, not the order
    // the check raised them in. They are also what `PRIOR_NOTE_LIMIT` keeps and drops.
    const raised = [plantTheCanonFinding(), plantTheCanonFinding(), plantTheCanonFinding()]
    for (const [index, finding] of [...raised].reverse().entries()) {
      dismissFinding(store, finding.id, `note ${index + 1}`)
    }

    expect(
      dismissalNotes(store, { showId: harbor.show.id, checkKey: 'world-rules' }).map((one) => one.note),
    ).toEqual(['note 3', 'note 2', 'note 1'])
    expect(
      dismissalNotes(store, { showId: harbor.show.id, checkKey: 'world-rules', limit: 1 }).map(
        (one) => one.note,
      ),
    ).toEqual(['note 3'])
  })

  it('carries a dismissed finding’s note into the next run’s prompt — proved from the wire', async () => {
    const finding = plantTheCanonFinding()
    dismissFinding(store, finding.id, 'Coveralls are rated for three minutes on the spar. Fine.')

    const runner: Runner = createRunner(
      store,
      textCheckStages(paths),
      createEventLog(store),
      llm,
    )
    for (let reviewer = 0; reviewer < 10; reviewer += 1) llm.reply('{"findings": []}')
    const run = runner.enqueueRun({ episodeId, stage: TEXT_CHECK_STAGE })
    const settled = await runner.settled(run.id)
    expect(settled.status).toEqual('done')

    // The world-rules reviewer is fifth in the roster, and it is the one that is told.
    const worldRules = llm.calls[4]!.prompt
    expect(worldRules).toContain('What the showrunner has already put down')
    expect(worldRules).toContain('Coveralls are rated for three minutes on the spar')
    expect(worldRules).toContain(`world-rules, at “${SPAN}”`)
    // And nobody else is. A note about the world rules is not context for the pacing reviewer.
    expect(llm.calls[0]!.prompt).not.toContain('Coveralls are rated')
    expect(llm.calls[7]!.prompt).not.toContain('Coveralls are rated')
  })

  it('refuses a dismissal with nothing in it, and refuses a second opinion on one already put down', () => {
    const finding = plantTheCanonFinding()

    expect(() => dismissFinding(store, finding.id, '   ')).toThrow(/takes a note/)
    dismissFinding(store, finding.id, 'Rated for three minutes. Fine.')

    const offers = remediationsFor(store, paths, finding.id)
    expect(offers.dismiss.enabled).toBe(false)
    expect(offers.predraft.blockedBecause).toContain('already dismissed')
    expect(offers.propose.blockedBecause).toContain('already dismissed')
  })
})

/**
 * Five ways the narrowing could have been narrowing in name only. Every one of them is silent
 * — nothing throws, a version lands, a pass is filed — which is why they are here by name.
 */
describe('a scene is a scene at both ends, or it is not a scene', () => {
  it('refuses a span that has moved to another scene rather than rewriting it there', () => {
    // The line as the fixture has it, in scene 5. A check raised it against SCENE 2, where a
    // draft used to carry the same words; Ryan has since cut it from scene 2 by hand.
    const moved = "That's not a plan, that's a queue."
    expect(onDisk(script).slice(0, sceneSpans(onDisk(script), scenes)[2]!.from)).not.toContain(moved)

    const pass = recordCheckPass(store, {
      checkKey: 'pacing',
      tier: 'text',
      artifactId: script.id,
      findings: [
        {
          concern: 'flat',
          severity: 'low',
          confidence: 'low',
          anchor: { sceneId: scenes[1]!.id, quote: moved },
        },
      ],
    })
    const finding = findingsOfPass(store, pass.id)[0]!

    // A scene ends where the next scene begins. Searching from scene 2 to the END OF THE FILE
    // would find these words in scene 5 and rewrite them there — editing a scene nobody asked
    // about, and naming scene 2 in the revision, so freshness would stale the wrong consumers
    // and leave the real ones fresh. Both halves of that are silent.
    expect(remediationsFor(store, paths, finding.id).predraft.blockedBecause).toContain(
      'is not in scene 2 of the ep01 script on the volume any more',
    )
    expect(() =>
      applyRewrite(store, paths, { findingId: finding.id, replacement: 'x' }),
    ).toThrow(/not in scene 2/)
    expect(findArtifact(store, script.id)!.version).toEqual(1)
  })

  it('refuses to narrow to a scene whose heading the draft no longer carries', async () => {
    // The span IS the heading, so the rewrite takes the heading with it.
    const heading = recordCheckPass(store, {
      checkKey: 'world-rules',
      tier: 'text',
      artifactId: script.id,
      findings: [
        {
          concern: 'the clock in the heading is wrong',
          severity: 'low',
          confidence: 'low',
          anchor: { sceneId: scenes[3]!.id, quote: scenes[3]!.heading },
        },
      ],
    })
    applyRewrite(store, paths, {
      findingId: findingsOfPass(store, heading.id)[0]!.id,
      replacement: 'EXT. THE LONG PIER — 07:09',
    })
    expect(onDisk(findArtifact(store, script.id)!)).not.toContain(scenes[3]!.heading)

    // **A scene is its heading** (E4-3), and E4-5 put the re-delineation inside the one motion
    // — so a rewrite that renames a heading now takes the scene with it, exactly as a writer's
    // own rewrite does, and the finding that was anchored there has degraded to the whole
    // artifact (0013). The row this re-check would have narrowed to is gone.
    expect(scenesOf(store, episodeId).map((one) => one.id)).not.toContain(scenes[3]!.id)
    expect(scenesOf(store, episodeId).map((one) => one.heading)).toContain(
      'EXT. THE LONG PIER — 07:09',
    )
    await expect(
      recheckScene(store, llm, paths, { artifactId: script.id, sceneId: scenes[3]!.id }),
    ).rejects.toThrow(/does not belong to this episode/)
    expect(llm.calls).toEqual([])
  })

  it('lands a narrowed finding in the scene the pass read, even when the reply names none', async () => {
    const canon = plantTheCanonFinding()
    applyRewrite(store, paths, { findingId: canon.id, replacement: SUITED })
    llm.reply({
      // No `scene` at all — which everywhere else in this app means "about the whole artifact".
      text: JSON.stringify({
        findings: [
          { quote: SUITED, concern: 'still never sealed on screen', severity: 'medium', confidence: 'medium' },
        ],
      }),
      usage: { uncachedInput: 3800, output: 90 },
    })

    await recheckScene(store, llm, paths, { artifactId: script.id, sceneId: scenes[3]!.id })

    // A pass that read one scene has no standing to raise a finding about the artifact, and a
    // null scene is exactly that claim — it renders above the anchored findings on the verdict
    // board and it is what a whole-artifact finding means everywhere else.
    const raised = findingsIn(store, script.id).filter((one) => one.anchor.version === 2)
    expect(raised).toHaveLength(1)
    expect(raised[0]!.anchor.sceneId).toEqual(scenes[3]!.id)
    // And the shape it was asked for said so, rather than inviting the omission.
    expect(llm.calls[0]!.prompt).toContain('That is the only scene it may name.')
  })

  it('stops calling a row `partial` once the whole draft has been read', async () => {
    const canon = plantTheCanonFinding()
    applyRewrite(store, paths, { findingId: canon.id, replacement: SUITED })
    llm.reply({ text: '{"findings": []}', usage: { uncachedInput: 3800, output: 40 } })
    await recheckScene(store, llm, paths, { artifactId: script.id, sceneId: scenes[3]!.id })

    const board = () =>
      verdictBoard(store, findArtifact(store, script.id)!).rows.find(
        (row) => row.checkKey === 'world-rules',
      )!
    expect(board().verdict).toEqual('partial')

    // The panel then reads the whole draft. "The rest of this draft it has not read" is now
    // false, and going on saying it would be a second lie told in the safe direction.
    recordCheckPass(store, {
      checkKey: 'world-rules',
      tier: 'text',
      artifactId: script.id,
      findings: [],
    })
    expect(board().verdict).toEqual('clean')
  })

  it('disables the apply button when a rolled-back attempt left its file behind', () => {
    const finding = plantTheCanonFinding()
    // What a kill -9 between the write and the commit leaves: a draft with no row pointing at
    // it. Nothing is ever written over (D20), so the button has to say so BEFORE the click
    // rather than fail after it, every time, forever.
    const orphan = join(paths.artifactDir, 'greyharbor/s01e01/script-v2.md')
    writeFileSync(orphan, 'half-applied draft', 'utf8')

    const offers = remediationsFor(store, paths, finding.id)
    expect(offers.apply.enabled).toBe(false)
    expect(offers.apply.blockedBecause).toContain('script-v2.md is already on the volume')
    expect(() => applyRewrite(store, paths, { findingId: finding.id, replacement: SUITED })).toThrow(
      /already on the volume/,
    )
    expect(readFileSync(orphan, 'utf8')).toEqual('half-applied draft')
  })
})

describe('the buttons are reachable, which is the other half of the wall being livable', () => {
  /**
   * The whole loop over the wire, in the order E3-7's check bench walks it: read the three
   * buttons off a finding, pre-draft, apply, re-check, and be told what it all cost. The
   * amendment on this issue calls reachability part of done — until these routes existed, the
   * only door through D12's wall was an override at an open gate.
   */
  it('walks pre-draft → apply → re-check over the wire, and refuses in the words the button showed', async () => {
    checkTheBoard()
    const finding = plantTheCanonFinding()
    const { app, post } = theApi()

    const offers = (await (await app.request(`/api/finding/${finding.id}`)).json()) as {
      predraft: { enabled: boolean; cost: string }
      dismiss: { enabled: boolean }
    }
    expect(offers.predraft).toMatchObject({ enabled: true })
    expect(offers.predraft.cost).toContain('your money, spent when you click')

    llm.reply({ text: JSON.stringify({ replacement: SUITED, why: 'seals him in' }) })
    const drafted = await post(`/api/finding/${finding.id}/predraft`, {})
    expect(drafted.status).toBe(200)
    expect(drafted.body['replacement']).toEqual(SUITED)
    expect(findArtifact(store, script.id)!.version).toEqual(1)

    // A request with no replacement in it is refused before anything moves — absent and empty
    // are different, and only one of them is a deletion he typed.
    expect((await post(`/api/finding/${finding.id}/rewrite`, {})).status).toBe(400)

    const applied = await post(`/api/finding/${finding.id}/rewrite`, { replacement: SUITED })
    expect(applied.status).toBe(200)
    expect(applied.body['version']).toEqual(2)
    expect((applied.body['read'] as unknown[]).length).toBeGreaterThan(0)

    llm.reply({ text: '{"findings": []}' })
    const rechecked = await post(`/api/artifact/${script.id}/recheck`, { sceneId: scenes[3]!.id })
    expect(rechecked.status).toBe(200)
    expect(rechecked.body).toMatchObject({ findings: 0, scene: 4 })

    // The second rewrite is refused with the sentence the disabled button carries, not with a
    // stack trace — the draft it argued with is gone.
    const again = await post(`/api/finding/${finding.id}/rewrite`, { replacement: 'again' })
    expect(again.status).toBe(409)
    expect(again.body['error']).toContain('draft it argued with is gone')
  })

  it('raises the canon change and puts a finding down, both free, neither ruling anything', async () => {
    const before = rulingCount()
    const finding = plantTheCanonFinding()
    const { app, post } = theApi()

    const prefilled = (await (
      await app.request(`/api/finding/${finding.id}/canon-change`)
    ).json()) as { usageContext: string }
    expect(prefilled.usageContext).toContain(SPAN)

    const raised = await post(`/api/finding/${finding.id}/canon-change`, {
      statement: 'A Halvani in vacuum has about ninety seconds, not nine.',
    })
    expect(raised.status).toBe(200)
    expect(raised.body).toMatchObject({ status: 'raised', kind: 'fact-delta', raisedBy: 'check' })

    // An empty note is refused in the sentence `dismissFinding` throws and the button shows.
    expect((await post(`/api/finding/${finding.id}/dismiss`, { note: '  ' })).status).toBe(409)
    const put = await post(`/api/finding/${finding.id}/dismiss`, { note: 'Rated for three minutes.' })
    expect(put.status).toBe(200)
    expect((put.body['dismiss'] as { enabled: boolean }).enabled).toBe(false)

    expect(rulingCount()).toEqual(before)
  })
})

describe('nothing in this file rules anything (invariant 1)', () => {
  it('runs all three buttons and leaves the ledger exactly where founding left it', async () => {
    const before = rulingCount()
    checkTheBoard()
    const canon = plantTheCanonFinding()
    const craft = plantACraftFinding()

    llm.reply({ text: JSON.stringify({ replacement: SUITED, why: 'seals him in' }) })
    await predraftRewrite(store, llm, paths, canon.id)
    proposeCanonChange(store, paths, canon.id, {
      statement: 'A Halvani in vacuum has about ninety seconds, not nine.',
    })
    applyRewrite(store, paths, { findingId: canon.id, replacement: SUITED })
    llm.reply({ text: '{"findings": []}' })
    await recheckScene(store, llm, paths, { artifactId: script.id, sceneId: scenes[3]!.id })
    dismissFinding(store, craft.id, 'The office turn is meant to be quick.')

    expect(rulingCount()).toEqual(before)
    expect(openProposals(store, harbor.show.id).every((one) => one.status === 'raised')).toBe(true)
  })
})

/** The app process, wired to this library and this fake — and the one POST helper it needs. */
function theApi(): {
  app: ReturnType<typeof createApp>
  post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>
} {
  const events = createEventLog(store)
  const runner = createRunner(store, textCheckStages(paths), events, llm)
  const app = createApp(paths, store, events, {
    runner,
    rulings: createRulings(store, events, runner),
    llm,
    readiness: () => ({
      backend: 'anthropic-api',
      ready: true,
      chosenBy: 'ANTHROPIC_API_KEY is set',
      label: 'the Anthropic API',
      sentence: 'ready',
    }),
  })

  return {
    app,
    async post(path, body) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    },
  }
}

/**
 * A second Grey Harbor, founded, on its own volume — the control for the one-motion test.
 *
 * It is a whole library rather than a second artifact in this one because the question is
 * about an EPISODE's wall, and two episodes with the same planted contradiction in one store
 * would be two answers to a question that is asked per episode.
 */
function anotherGreyHarbor(): {
  store: Store
  episodeId: string
  script: Artifact
  close(): void
} {
  const otherRoot = mkdtempSync(join(tmpdir(), 'showrunner-remediation-control-'))
  const otherPaths = initLibrary(otherRoot)
  const otherStore = openLibraryStore(otherPaths)
  greyHarborFounded(otherStore, otherPaths)

  const other = otherStore.get<{ id: string }>(
    "SELECT id FROM episode WHERE title = 'The Long Pier'",
  )!.id
  const otherScript = artifactsOf(otherStore, other).find((one) => one.kind === 'script')!
  const board = recordExtractedBoard(otherStore, {
    episodeId: other,
    scriptId: otherScript.id,
    extraction: theLongPierExtraction({
      lockCycle: factIn(otherStore, 'Grey Harbor Station', 'Cycling the No. 4 lock'),
      halvaniVacuum: factIn(otherStore, 'Halvani', 'loses consciousness'),
    }),
    filePath: 'greyharbor/s01e01/continuity-board-v1.md',
  })
  runBoardRules(otherStore, board.artifact.id)

  return {
    store: otherStore,
    episodeId: other,
    script: otherScript,
    close() {
      otherStore.close()
      rmSync(otherRoot, { recursive: true, force: true })
    },
  }
}

function factIn(where: Store, entity: string, needle: string): string {
  const row = where.get<{ id: string }>('SELECT id FROM canon_entity WHERE name = ?', entity)!
  return factsOfEntity(where, row.id).find((fact) => fact.statement.includes(needle))!.id
}

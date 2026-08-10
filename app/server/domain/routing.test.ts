import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../db/store.ts'
import { greyHarborFounded } from '../fixture/founded.ts'
import { initLibrary, openLibraryStore, type LibraryPaths } from '../library.ts'
import { artifactsOf, reviseArtifact, type Artifact } from './artifact.ts'
import { episodesOf, seasonsOf } from './spine.ts'
import {
  addressOf,
  landsOn,
  routedNotesTo,
  routedNoteSentence,
  unaddressedNotesTo,
} from './routing.ts'

/**
 * **Where a rejection note is addressed, and when it has been answered** (E4-5, D21, 4.7).
 *
 * The module under test is small on purpose: it resolves a depth into an artifact at the
 * moment Ryan writes the note, and it answers "has anybody written a newer version of that
 * artifact since" — the whole of D21's "nothing regenerates until the note lands", expressed
 * as a read over rows rather than as a flag anybody has to remember to clear.
 */

let root: string
let paths: LibraryPaths
let store: Store
let ep01: string
let ep02: string
let script: Artifact
let outline: Artifact
let brief: Artifact

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'showrunner-routing-'))
  paths = initLibrary(root)
  store = openLibraryStore(paths)
  const harbor = greyHarborFounded(store, paths)
  const season = seasonsOf(store, harbor.show.id)[0]!
  const episodes = episodesOf(store, season.id)
  ep01 = episodes[0]!.id
  ep02 = episodes[1]!.id
  const artifacts = artifactsOf(store, ep01)
  script = artifacts.find((one) => one.kind === 'script')!
  outline = artifacts.find((one) => one.kind === 'outline')!
  brief = artifacts.find((one) => one.kind === 'premise-brief')!
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** A gate over one artifact, rejected, carrying one note with the address it resolved to. */
function reject(over: Artifact, note: { note: string; depth?: string; target?: string }): string {
  const gateId = `gate-${over.id}-${store.get<{ n: number }>('SELECT COUNT(*) AS n FROM gate')!.n}`
  const runId = `run-${gateId}`
  const stepId = `step-${gateId}`
  store.run('INSERT INTO run (id, episode_id, stage) VALUES (?, ?, ?)', runId, ep01, 'write-the-script')
  store.run('INSERT INTO step (id, run_id, ordinal, name) VALUES (?, ?, 1, ?)', stepId, runId, 'w')
  store.run(
    'INSERT INTO gate (id, run_id, step_id, episode_id, artifact_id) VALUES (?, ?, ?, ?, ?)',
    gateId,
    runId,
    stepId,
    ep01,
    over.id,
  )
  store.run(
    'INSERT INTO gate_round (gate_id, round, artifact_version) VALUES (?, 1, ?)',
    gateId,
    over.version,
  )
  store.run("INSERT INTO gate_ruling (gate_id, round, verdict) VALUES (?, 1, 'reject')", gateId)

  const address = addressOf(store, { episodeId: ep01, artifactId: over.id }, note as never)
  store.run(
    'INSERT INTO gate_note (gate_id, round, note, depth, target, target_version) VALUES (?, 1, ?, ?, ?, ?)',
    gateId,
    note.note,
    note.depth ?? null,
    address.target,
    address.targetVersion,
  )
  return gateId
}

// ── Resolving the address ───────────────────────────────────────────────────────

describe('a depth that names a written kind resolves to that episode’s artifact', () => {
  it('addresses an outline-depth note to the outline, at the version standing now', () => {
    expect(addressOf(store, { episodeId: ep01, artifactId: script.id }, { note: 'n', depth: 'outline' }))
      .toEqual({ target: outline.id, targetVersion: outline.version })
  })

  it('addresses a premise-depth note to the premise-brief', () => {
    expect(addressOf(store, { episodeId: ep01, artifactId: script.id }, { note: 'n', depth: 'premise' }))
      .toEqual({ target: brief.id, targetVersion: brief.version })
  })

  it('leaves an unrouted note, a scene note and an artifact-depth note unaddressed to anything', () => {
    // No depth at all — the legal default (D21), and the note is about the draft in front of him.
    expect(addressOf(store, { episodeId: ep01, artifactId: script.id }, { note: 'n' })).toEqual({
      target: null,
      targetVersion: null,
    })
    // `artifact` depth IS the draft under review; the gate already records which artifact that
    // is, so there is nothing here to address elsewhere.
    expect(
      addressOf(store, { episodeId: ep01, artifactId: script.id }, { note: 'n', depth: 'artifact' }),
    ).toEqual({ target: null, targetVersion: null })
    // A scene target is kept as Ryan sent it and carries no version: it names a scene of this
    // artifact, not another artifact, so there is no version for it to have moved past.
    expect(
      addressOf(
        store,
        { episodeId: ep01, artifactId: script.id },
        { note: 'n', depth: 'scene', target: 'sc4' },
      ),
    ).toEqual({ target: 'sc4', targetVersion: null })
  })

  it('records a route to a kind this episode does not have as no address at all', () => {
    // ep02 has nothing written. Nothing may block a ruling (`runner/gate.ts`), so a route that
    // lands nowhere is recorded as a note with no address rather than refused at the verdict.
    expect(addressOf(store, { episodeId: ep02, artifactId: script.id }, { note: 'n', depth: 'outline' }))
      .toEqual({ target: null, targetVersion: null })
  })
})

// ── What lands here, and what was routed away ───────────────────────────────────

describe('a note lands on the draft under review unless it names another artifact', () => {
  it('keeps unrouted, artifact-depth and scene notes on the draft in front of him', () => {
    for (const note of [
      { note: 'a', depth: null, target: null, targetVersion: null },
      { note: 'b', depth: 'artifact' as const, target: null, targetVersion: null },
      { note: 'c', depth: 'scene' as const, target: 'sc4', targetVersion: null },
    ]) {
      expect(landsOn(note, script.id)).toBe(true)
    }
  })

  it('takes a note addressed to another artifact off the draft in front of him', () => {
    expect(
      landsOn(
        { note: 'd', depth: 'outline', target: outline.id, targetVersion: 1 },
        script.id,
      ),
    ).toBe(false)
    // …and puts it back when the artifact under review IS the one it names.
    expect(
      landsOn({ note: 'd', depth: 'outline', target: outline.id, targetVersion: 1 }, outline.id),
    ).toBe(true)
  })
})

// ── Standing against the target, until something answers it ─────────────────────

describe('a routed note stands against its target until a newer version of it exists', () => {
  it('reads back against the outline with where it was written and what it said', () => {
    reject(script, { note: 'the middle movement does not turn', depth: 'outline' })

    const [standing] = routedNotesTo(store, outline.id)
    expect(standing).toMatchObject({
      note: 'the middle movement does not turn',
      targetId: outline.id,
      routedAtVersion: 1,
      fromArtifactId: script.id,
      fromKind: 'script',
      depth: 'outline',
      round: 1,
      addressed: false,
    })
    // It stands against the OUTLINE and nowhere else — the script gate it was written at is
    // where he was standing, never what the note is about.
    expect(routedNotesTo(store, script.id)).toEqual([])
  })

  it('is addressed by a newer version of its target, and by nothing else', () => {
    reject(script, { note: 'the middle movement does not turn', depth: 'outline' })
    expect(unaddressedNotesTo(store, outline.id)).toHaveLength(1)

    // A new version of some OTHER artifact answers nothing.
    reviseArtifact(store, script.id, { summary: 'a fourth draft of the script' })
    expect(unaddressedNotesTo(store, outline.id)).toHaveLength(1)

    // A new version of the target is the whole of it. Nothing was written to the note.
    reviseArtifact(store, outline.id, { summary: 'rewritten against your note' })
    expect(routedNotesTo(store, outline.id)[0]).toMatchObject({ addressed: true })
    expect(unaddressedNotesTo(store, outline.id)).toEqual([])
    expect(
      store.get<{ n: number }>('SELECT COUNT(*) AS n FROM gate_note WHERE target IS NOT NULL')!.n,
    ).toBe(1)
  })

  it('says what stands, in the sentence the offer renders', () => {
    reject(script, { note: 'the middle movement does not turn', depth: 'outline' })

    expect(routedNoteSentence(unaddressedNotesTo(store, outline.id), 'the ep01 outline')).toBe(
      'the ep01 outline has your note from the script gate standing against it — rewriting ' +
        'reads it: “the middle movement does not turn”',
    )
  })

  it('counts a second note and names the first', () => {
    reject(script, { note: 'the middle movement does not turn', depth: 'outline' })
    reject(script, { note: 'and the tag lands too early', depth: 'outline' })

    expect(routedNoteSentence(unaddressedNotesTo(store, outline.id), 'the ep01 outline')).toContain(
      '2 notes from the script gate standing against it',
    )
  })
})
